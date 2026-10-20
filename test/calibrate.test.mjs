/**
 * v2.0 Stage A — calibration harness tests (pure functions, no spawn/LLM).
 */

import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { SCORING_RUBRIC_VERSION } from '../lib/constants.js'
import {
  buildCalibrationReport,
  formatCalibrationLines,
  formatCalibrationMarkdown,
  main,
  parseArgs,
  writeCalibrationReport,
} from '../benchmarks/calibrate.mjs'

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rtc-calibrate-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

async function makeBench(t) {
  const dir = await tempDir(t)
  const benchDir = path.join(dir, 'benchmarks')
  await mkdir(path.join(benchDir, 'alpha-app'), { recursive: true })
  await mkdir(path.join(benchDir, 'beta-model'), { recursive: true })
  await writeFile(path.join(benchDir, 'alpha-app', 'labels.json'), JSON.stringify({
    fixture: 'alpha-app',
    labels: [
      { id: 'A1', path: 'app.js', line: 2 },
      { id: 'A2', path: 'app.js', line: 5 },
    ],
    expectations: { gatePassed: false, minimumRecall: 0.8 },
  }), 'utf8')
  await writeFile(path.join(benchDir, 'beta-model', 'labels.json'), JSON.stringify({
    fixture: 'beta-model',
    labels: [
      { id: 'B1', path: 'b.js', line: 1 },
      { id: 'B2', path: 'b.js', line: 9 },
    ],
    expectations: { gatePassed: false },
  }), 'utf8')
  const results = [
    {
      fixture: 'alpha-app',
      round: {
        n: 2,
        rubricVersion: 'v2-100',
        profile: 'game',
        score: { score: 60 },
        gate: { passed: false },
        judges: [{ index: 0 }, { index: 1 }],
        attack: {
          findings: [
            { title: 'A1', evidence: 'app.js:2 boom' },
            { title: 'A2', evidence: 'app.js:5 broken' },
          ],
        },
      },
    },
    {
      fixture: 'beta-model',
      round: {
        n: 1,
        rubricVersion: 'v2-100',
        profile: 'modeling',
        score: { score: 40 },
        gate: { passed: false },
        judges: [{ index: 0 }],
        attack: {
          findings: [
            { title: 'B1', evidence: 'b.js:1 leakage' },
          ],
        },
      },
    },
  ]
  return { dir, benchDir, results }
}

test('buildCalibrationReport computes per-fixture and aggregate metrics', async (t) => {
  const { benchDir, results } = await makeBench(t)
  const report = buildCalibrationReport({ benchDir, results, now: 1700000000000 })
  assert.equal(report.ok, true)
  assert.equal(report.generatedAt, 1700000000000)
  assert.equal(report.scoringRubricVersion, SCORING_RUBRIC_VERSION)
  assert.deepEqual(report.rubricVersions, ['v2-100'])
  assert.deepEqual(report.profiles, ['game', 'modeling'])
  assert.equal(path.isAbsolute(report.results), false)
  assert.equal(report.fixtures.length, 2)

  const alpha = report.fixtures.find((fixture) => fixture.fixture === 'alpha-app')
  assert.equal(alpha.score, 60)
  assert.equal(alpha.gatePassed, false)
  assert.equal(alpha.expectedGatePassed, false)
  assert.equal(alpha.gateOk, true)
  assert.equal(alpha.labeled, true)
  assert.equal(alpha.labels, 2)
  assert.equal(alpha.reported, 2)
  assert.equal(alpha.matched, 2)
  assert.equal(alpha.recall, 1)
  assert.equal(alpha.precision, 1)
  assert.equal(alpha.judges, 2)
  assert.equal(alpha.round, 2)
  assert.equal(alpha.profile, 'game')
  assert.equal(alpha.rubricVersion, 'v2-100')

  const beta = report.fixtures.find((fixture) => fixture.fixture === 'beta-model')
  assert.equal(beta.recall, 0.5)
  assert.equal(beta.precision, 1)
  assert.deepEqual(beta.missedIds, ['B2'])

  const aggregate = report.aggregate
  assert.equal(aggregate.fixtures, 2)
  assert.equal(aggregate.labeled, 2)
  assert.equal(aggregate.meanScore, 50)
  assert.equal(aggregate.medianScore, 50)
  assert.equal(aggregate.stdevScore, 14.1)
  assert.equal(aggregate.ci95.low <= 50 && aggregate.ci95.high >= 50, true)
  assert.equal(aggregate.meanRecall, 0.75)
  assert.equal(aggregate.meanPrecision, 1)
  assert.equal(aggregate.gateAgreement, 1)
  assert.deepEqual(aggregate.gateMismatches, [])
  assert.equal(aggregate.spearmanScoreRecall, 1)
  assert.equal(aggregate.maxRounds, 2)
})

test('buildCalibrationReport handles empty and unlabeled fixture sets', async (t) => {
  const { benchDir } = await makeBench(t)
  const empty = buildCalibrationReport({ benchDir, results: [], now: 1 })
  assert.equal(empty.fixtures.length, 0)
  assert.equal(empty.aggregate.meanScore, null)
  assert.equal(empty.aggregate.gateAgreement, null)
  assert.equal(empty.aggregate.spearmanScoreRecall, null)
  assert.equal(empty.aggregate.maxRounds, 0)

  const unlabeled = buildCalibrationReport({
    benchDir,
    results: [{
      fixture: 'unknown-app',
      round: { n: 1, rubricVersion: 'v2-100', score: { score: 70 }, gate: { passed: false }, attack: { findings: [{ evidence: 'x:1' }] } },
    }],
    now: 2,
  })
  assert.equal(unlabeled.fixtures[0].labeled, false)
  assert.equal(unlabeled.fixtures[0].recall, null)
  assert.equal(unlabeled.aggregate.labeled, 0)
  assert.equal(unlabeled.aggregate.meanRecall, null)
  assert.equal(unlabeled.aggregate.meanPrecision, null)
})

test('formatCalibrationLines / Markdown expose scores, gate agreement and meta', async (t) => {
  const { benchDir, results } = await makeBench(t)
  const report = buildCalibrationReport({ benchDir, results, now: 1700000000000 })
  const lines = formatCalibrationLines(report)
  assert.ok(lines[0].includes('fixtures=2'))
  assert.ok(lines[0].includes('meanScore=50'))
  assert.ok(lines.some((line) => line.includes('gateAgreement=1')))
  assert.ok(lines.some((line) => line.includes('spearman(score,recall)=1')))
  assert.ok(lines.some((line) => line.includes('[alpha-app] score=60')))
  assert.ok(lines.some((line) => line.includes(SCORING_RUBRIC_VERSION)))

  const markdown = formatCalibrationMarkdown(report)
  assert.ok(markdown.startsWith('# 评分校准报告'))
  assert.ok(markdown.includes('| fixture | score | gate |'))
  assert.ok(markdown.includes('| mean score | 50 |'))
  assert.ok(markdown.includes('| gate agreement | 1 |'))
  assert.ok(markdown.includes(SCORING_RUBRIC_VERSION))
  assert.ok(markdown.includes('v2-100'))
})

test('writeCalibrationReport writes JSON and optional Markdown atomically', async (t) => {
  const { dir, benchDir, results } = await makeBench(t)
  const report = buildCalibrationReport({ benchDir, results, now: 3 })
  const outFile = path.join(dir, 'out', 'calibration-report.json')
  const written = writeCalibrationReport(report, { outFile, md: true })
  assert.deepEqual(written.failed, [])
  assert.equal(written.written.length, 2)
  const json = JSON.parse(await readFile(outFile, 'utf8'))
  assert.equal(json.aggregate.meanScore, 50)
  const md = await readFile(outFile.replace(/\.json$/, '.md'), 'utf8')
  assert.ok(md.includes('# 评分校准报告'))
  // Default/--no-write paths are handled by main; no file should appear for it.
  const noWriteDir = path.join(dir, 'no-write')
  const logs = []
  const code = main(['--results', path.join(dir, 'no-results'), '--out', path.join(noWriteDir, 'x.json'), '--no-write'], { log: (line) => logs.push(line) })
  assert.equal(code, 0)
  assert.ok(logs.some((line) => line.includes('没有 results')))
  await assert.rejects(access(path.join(noWriteDir, 'x.json')))
})

test('committed calibration report MD and JSON describe the same fixtures/aggregate', async () => {
  const jsonPath = new URL('../benchmarks/calibration-report.json', import.meta.url)
  const mdPath = new URL('../benchmarks/calibration-report.md', import.meta.url)
  const report = JSON.parse(await readFile(jsonPath, 'utf8'))
  const md = await readFile(mdPath, 'utf8')
  assert.ok(Array.isArray(report.fixtures) && report.fixtures.length >= 3)
  for (const fixture of report.fixtures) {
    assert.ok(md.includes(fixture.fixture), `MD missing fixture ${fixture.fixture}`)
  }
  const precisionPercent = `${(Number(report.aggregate.meanPrecision) * 100).toFixed(1)}%`
  assert.ok(md.includes(precisionPercent), `MD missing aggregate precision ${precisionPercent}`)
  assert.ok(md.includes(String(report.aggregate.meanScore)))
})

test('parseArgs accepts results/out/md/no-write', () => {
  const options = parseArgs(['--results', 'r', '--out', 'o.json', '--md', '--no-write'])
  assert.equal(options.resultsDir, path.resolve('r'))
  assert.equal(options.outFile, path.resolve('o.json'))
  assert.equal(options.md, true)
  assert.equal(options.noWrite, true)
  assert.equal(parseArgs(['--results=x', '--out=y']).resultsDir, path.resolve('x'))
  assert.equal(parseArgs([]).md, false)
  assert.equal(parseArgs(['--help']).help, true)
})

test('calibration CLI runs on the real benchmark results and writes no files with --no-write', () => {
  const logs = []
  const outFile = path.join(os.tmpdir(), `rtc-calibration-${process.pid}.json`)
  const code = main(['--out', outFile, '--md', '--no-write'], { log: (line) => logs.push(line) })
  assert.equal(code, 0)
  // The live results directory grows during calibration; assert the shape, not
  // a fixed fixture count.
  assert.ok(logs.some((line) => /fixtures=\d+/.test(line)))
  assert.ok(logs.some((line) => line.includes('--no-write')))
})
