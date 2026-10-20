/**
 * v2.0 Stage A — drift detection + CLI tests (no LLM/network).
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DEFAULT_CONFIG } from '../lib/constants.js'
import { buildBaselineDocument, computeDrift } from '../lib/drift.js'
import { currentFixturesFromResults, formatDriftReport, loadBaselineFile, main, parseArgs } from '../benchmarks/drift.mjs'

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rtc-drift-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

function fixture(name, score, options = {}) {
  return { fixture: name, score, gatePassed: options.gatePassed ?? false, recall: options.recall ?? 1, precision: options.precision ?? 1 }
}

test('computeDrift reports no drift for identical fixtures', () => {
  const current = [fixture('a', 60), fixture('b', 40)]
  const baseline = [fixture('a', 60), fixture('b', 40)]
  const result = computeDrift(current, baseline)
  assert.equal(result.ok, true)
  assert.equal(result.drift, false)
  assert.deepEqual(result.alerts, [])
  assert.equal(result.summary.fixturesCompared, 2)
  assert.equal(result.summary.meanScoreDelta, 0)
  assert.equal(result.summary.passRateDelta, 0)
  assert.equal(result.fixtures[0].status, 'compared')
  assert.deepEqual(result.thresholds, {
    driftScoreDelta: DEFAULT_CONFIG.driftScoreDelta,
    driftRecallDelta: DEFAULT_CONFIG.driftRecallDelta,
    driftPassRateDelta: DEFAULT_CONFIG.driftPassRateDelta,
  })
})

test('computeDrift alerts on score/recall drops beyond thresholds (inclusive)', () => {
  const dropped = computeDrift(
    [fixture('a', 55, { recall: 0.9 })],
    [fixture('a', 60, { recall: 1 })],
  )
  assert.equal(dropped.drift, true)
  assert.deepEqual(dropped.alerts.map((alert) => alert.kind).sort(), ['recall-regression', 'score-regression'])
  const scoreAlert = dropped.alerts.find((alert) => alert.kind === 'score-regression')
  assert.equal(scoreAlert.delta, -5)
  assert.equal(scoreAlert.threshold, 5)
  const recallAlert = dropped.alerts.find((alert) => alert.kind === 'recall-regression')
  assert.equal(recallAlert.delta, -0.1)
  assert.equal(recallAlert.threshold, 0.1)

  // Just inside the threshold: no alert.
  const inside = computeDrift(
    [fixture('a', 55.5, { recall: 0.95 })],
    [fixture('a', 60, { recall: 1 })],
  )
  assert.equal(inside.drift, false)
  // Improvements never alert.
  const improved = computeDrift([fixture('a', 80, { recall: 1 })], [fixture('a', 60, { recall: 0.5 })])
  assert.equal(improved.drift, false)
  assert.equal(improved.summary.meanScoreDelta, 20)
  assert.equal(improved.summary.meanRecallDelta, 0.5)
})

test('computeDrift alerts on a pass-rate regression and on missing fixtures', () => {
  const current = [fixture('a', 90, { gatePassed: false }), fixture('b', 90, { gatePassed: true })]
  const baseline = [fixture('a', 90, { gatePassed: true }), fixture('b', 90, { gatePassed: true })]
  const result = computeDrift(current, baseline)
  assert.equal(result.drift, true)
  const kinds = result.alerts.map((alert) => alert.kind)
  assert.equal(kinds.includes('gate-regression'), true)
  assert.equal(kinds.includes('pass-rate-regression'), true)
  const passAlert = result.alerts.find((alert) => alert.kind === 'pass-rate-regression')
  assert.equal(passAlert.delta, -0.5)
  assert.equal(result.summary.baselinePassRate, 1)
  assert.equal(result.summary.currentPassRate, 0.5)

  const missing = computeDrift([fixture('a', 60)], [fixture('a', 60), fixture('b', 40)])
  assert.equal(missing.drift, true)
  assert.equal(missing.alerts[0].kind, 'missing-fixture')
  assert.equal(missing.alerts[0].fixture, 'b')
  assert.equal(missing.fixtures.find((entry) => entry.fixture === 'b').status, 'missing')
  // New fixtures are recorded but are not a regression.
  const added = computeDrift([fixture('a', 60), fixture('c', 30)], [fixture('a', 60)])
  assert.equal(added.drift, false)
  assert.equal(added.fixtures.find((entry) => entry.fixture === 'c').status, 'new')
})

test('computeDrift accepts maps/wrappers, dedupes by fixture and supports threshold overrides', () => {
  const mapCurrent = { fixtures: { a: { score: 50 }, b: { score: 80 } } }
  const mapBaseline = { fixtures: { a: { score: 60 }, b: { score: 80 }, old: { score: 10 } } }
  const result = computeDrift(mapCurrent, mapBaseline, { driftScoreDelta: 20 })
  // 10-point drop is below the relaxed threshold, but the missing fixture still alerts.
  assert.equal(result.alerts.some((alert) => alert.kind === 'score-regression'), false)
  assert.equal(result.alerts.some((alert) => alert.kind === 'missing-fixture'), true)
  assert.equal(result.summary.fixturesCompared, 2)

  const directMapCurrent = [{ fixture: 'x', score: 30 }, { fixture: 'x', score: 40 }]
  const direct = computeDrift(directMapCurrent, { x: { score: 40 } })
  assert.equal(direct.fixtures.length, 1)
  assert.equal(direct.fixtures[0].current.score, 40)
  assert.equal(direct.drift, false)

  const thresholds = computeDrift([fixture('a', 50)], [fixture('a', 60)], { thresholds: { driftScoreDelta: 15 } })
  assert.equal(thresholds.alerts.length, 0)
  assert.equal(thresholds.thresholds.driftScoreDelta, 15)
  // Invalid thresholds fall back to defaults.
  const invalid = computeDrift([fixture('a', 50)], [fixture('a', 60)], { driftScoreDelta: Number.NaN })
  assert.equal(invalid.thresholds.driftScoreDelta, DEFAULT_CONFIG.driftScoreDelta)
})

test('buildBaselineDocument normalizes entries and is deterministic', () => {
  const doc = buildBaselineDocument([fixture('a', 60, { recall: 0.5 })], { generatedAt: 123 })
  assert.deepEqual(doc, {
    version: 1,
    generatedAt: 123,
    fixtures: { a: { score: 60, gatePassed: false, recall: 0.5, precision: 1 } },
  })
  assert.equal(buildBaselineDocument([], { generations: 1 }).fixtures.a, undefined)
})

test('formatDriftReport prints fixtures, alerts and the conclusion', () => {
  const result = computeDrift([fixture('a', 50)], [fixture('a', 60)])
  const lines = formatDriftReport(result)
  assert.ok(lines.some((line) => line.includes('meanScoreDelta=-10')))
  assert.ok(lines.some((line) => line.includes('[a] status=compared')))
  assert.ok(lines.some((line) => line.includes('[结论] DRIFT')))
  assert.ok(lines.some((line) => line.includes('score-regression')))
  const clean = formatDriftReport(computeDrift([fixture('a', 60)], [fixture('a', 60)]))
  assert.ok(clean.some((line) => line.includes('[结论] 无漂移')))
})

test('drift CLI parses args, exits 1 on drift and 0 without drift/baseline/results', async (t) => {
  const dir = await tempDir(t)
  const resultsDir = path.join(dir, 'results')
  const benchDir = path.join(dir, 'bench')
  await mkdir(resultsDir, { recursive: true })
  await mkdir(path.join(benchDir, 'web-a'), { recursive: true })
  await writeFile(path.join(benchDir, 'web-a', 'labels.json'), JSON.stringify({
    fixture: 'web-a',
    labels: [{ id: 'L1', path: 'app.js', line: 2 }],
    expectations: { gatePassed: false },
  }), 'utf8')
  await writeFile(path.join(resultsDir, 'web-a.json'), JSON.stringify({
    fixture: 'web-a',
    round: {
      n: 1,
      rubricVersion: 'v2-100',
      score: { score: 50 },
      gate: { passed: false },
      attack: { findings: [] },
    },
  }), 'utf8')
  const current = currentFixturesFromResults({ resultsDir, benchDir })
  assert.deepEqual(current, [{ fixture: 'web-a', score: 50, gatePassed: false, recall: 0, precision: null }])

  const args = parseArgs(['--results', resultsDir, '--baseline', path.join(dir, 'baseline.json'), '--json'])
  assert.equal(args.resultsDir, path.resolve(resultsDir))
  assert.equal(args.baselineFile, path.resolve(dir, 'baseline.json'))
  assert.equal(args.json, true)
  assert.equal(parseArgs(['--results=custom']).resultsDir, path.resolve('custom'))

  const baselineFile = path.join(dir, 'baseline.json')
  await writeFile(baselineFile, JSON.stringify({
    version: 1,
    generatedAt: 1,
    fixtures: { 'web-a': { score: 70, gatePassed: false, recall: 1, precision: 0 } },
  }), 'utf8')
  const logs = []
  const driftCode = main(['--results', resultsDir, '--baseline', baselineFile, '--json'], { log: (line) => logs.push(line) })
  assert.equal(driftCode, 1)
  const payload = JSON.parse(logs[0])
  assert.equal(payload.drift, true)
  assert.equal(payload.summary.fixturesCompared, 1)
  assert.ok(payload.alerts.some((alert) => alert.kind === 'score-regression'))

  const quietLogs = []
  const cleanCode = main(['--results', resultsDir, '--baseline', baselineFile, '--json'], { log: (line) => quietLogs.push(line) })
  assert.equal(cleanCode, 1)
  const cleanPayload = JSON.parse(quietLogs[0])
  assert.equal(cleanPayload.resultsDir, path.resolve(resultsDir))
  assert.equal(loadBaselineFile(baselineFile).version, 1)

  const missingBaselineLogs = []
  const missingCode = main(['--results', resultsDir, '--baseline', path.join(dir, 'nope.json')], { log: (line) => missingBaselineLogs.push(line) })
  assert.equal(missingCode, 0)
  assert.ok(missingBaselineLogs[0].includes('未找到可解析的基线文件'))

  const noResultsLogs = []
  assert.equal(main(['--results', path.join(dir, 'missing-results')], { log: (line) => noResultsLogs.push(line) }), 0)
  assert.ok(noResultsLogs[0].includes('benchmark 漂移检查'))
  assert.equal(main(['--help'], { log: () => {} }), 0)
})
