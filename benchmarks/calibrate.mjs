#!/usr/bin/env node
/**
 * v2.0 Stage A — calibration harness (zero dependencies, no LLM/network).
 *
 * Reads `benchmarks/results/*.json` plus each fixture's labels/review-package
 * expectations, computes per-fixture score/gate/recall/precision, and writes an
 * aggregate report (JSON by default, Markdown with `--md`):
 *
 *   node redteam-console/benchmarks/calibrate.mjs
 *   node redteam-console/benchmarks/calibrate.mjs --md
 *   node redteam-console/benchmarks/calibrate.mjs --results <dir> --out <file> --no-write
 *
 * No results → prints a clear message and exits 0 without writing anything.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { LIMITS, SCORING_RUBRIC_VERSION } from '../lib/constants.js'
import { mean, median, round1, spearman, stddev, summarizeRounded } from '../lib/stats.js'
import { computeStats, loadFixtureMeta, loadResults } from './runner.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.dirname(HERE)
const DEFAULT_RESULTS_DIR = path.join(HERE, 'results')
const DEFAULT_OUT_FILE = path.join(HERE, 'calibration-report.json')

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Path relative to the plugin root (keeps reports free of absolute host paths). */
function relativeToPlugin(target) {
  try {
    return path.relative(PLUGIN_ROOT, target).split(path.sep).join('/')
  } catch {
    return path.basename(target)
  }
}

function meanOrNull(values) {
  const list = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
  return list.length === 0 ? null : mean(list)
}

function round3(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null
}

/**
 * Compute the calibration report from disk (or injected results for tests).
 *
 * @param {{resultsDir?: string, benchDir?: string, results?: object[], now?: () => number|number}} [options]
 */
export function buildCalibrationReport(options = {}) {
  const benchDir = typeof options.benchDir === 'string' && options.benchDir !== '' ? options.benchDir : HERE
  const resultsDir = typeof options.resultsDir === 'string' && options.resultsDir !== ''
    ? options.resultsDir
    : path.join(benchDir, 'results')
  const now = typeof options.now === 'function'
    ? options.now()
    : (typeof options.now === 'number' ? options.now : Date.now())
  const loaded = Array.isArray(options.results) ? options.results : loadResults(resultsDir)
  const seen = new Set()
  const fixtures = []
  for (const entry of loaded) {
    if (fixtures.length >= LIMITS.maxCalibrationFixtures) break
    if (seen.has(entry.fixture)) continue
    seen.add(entry.fixture)
    const meta = loadFixtureMeta(benchDir, entry.fixture)
    const stats = computeStats({
      fixture: entry.fixture,
      result: entry.round,
      labels: meta.labels,
      expectations: meta.expectations,
    })
    const round = isPlainObject(entry.round) ? entry.round : {}
    const labeled = stats.labels > 0
    fixtures.push({
      fixture: entry.fixture,
      score: finiteOrNull(round.score?.score),
      gatePassed: round.gate?.passed === true,
      expectedGatePassed: typeof stats.expectedGatePassed === 'boolean' ? stats.expectedGatePassed : null,
      gateOk: typeof stats.gateOk === 'boolean' ? stats.gateOk : null,
      labeled,
      labels: stats.labels,
      reported: stats.reported,
      matched: stats.matched,
      missedIds: Array.isArray(stats.missedIds) ? [...stats.missedIds] : [],
      extra: stats.extra,
      recall: finiteOrNull(stats.recall),
      precision: finiteOrNull(stats.precision),
      judges: Array.isArray(round.judges) ? round.judges.length : 0,
      round: Number.isInteger(round.n) && round.n > 0 ? round.n : null,
      rubricVersion: typeof round.rubricVersion === 'string' ? round.rubricVersion : null,
      profile: typeof round.profile === 'string' ? round.profile : null,
    })
  }

  const scores = fixtures.map((fixture) => fixture.score).filter((score) => score !== null)
  const labeledFixtures = fixtures.filter((fixture) => fixture.labeled === true)
  const labeledRecalls = labeledFixtures.map((fixture) => fixture.recall).filter((value) => value !== null)
  const labeledPrecisions = labeledFixtures.map((fixture) => fixture.precision).filter((value) => value !== null)
  const gateComparable = fixtures.filter((fixture) => typeof fixture.expectedGatePassed === 'boolean')
  const gateAgree = gateComparable.filter((fixture) => fixture.gateOk === true).length
  const pairedScoreRecall = labeledFixtures
    .filter((fixture) => fixture.score !== null && fixture.recall !== null)
  const maxRounds = fixtures.reduce((max, fixture) => (fixture.round !== null && fixture.round > max ? fixture.round : max), 0)
  const profiles = [...new Set(fixtures.map((fixture) => fixture.profile).filter((profile) => profile !== null))].sort()
  const rubricVersions = [...new Set(fixtures.map((fixture) => fixture.rubricVersion).filter((version) => version !== null))].sort()

  const scoreCi = summarizeRounded(scores).ci95
  const meanRecall = round3(meanOrNull(labeledRecalls))
  const meanPrecision = round3(meanOrNull(labeledPrecisions))

  return {
    ok: true,
    version: 1,
    generatedAt: now,
    scoringRubricVersion: SCORING_RUBRIC_VERSION,
    rubricVersions,
    profiles,
    results: relativeToPlugin(resultsDir),
    fixtures,
    aggregate: {
      fixtures: fixtures.length,
      labeled: labeledFixtures.length,
      scores: scores.length,
      meanScore: round1(meanOrNull(scores)),
      medianScore: round1(median(scores)),
      stdevScore: round1(stddev(scores)),
      ci95: { low: scoreCi.low, high: scoreCi.high },
      meanRecall,
      meanPrecision,
      gateAgreement: gateComparable.length === 0 ? null : round3(gateAgree / gateComparable.length),
      gateMismatches: gateComparable.filter((fixture) => fixture.gateOk !== true).map((fixture) => fixture.fixture),
      spearmanScoreRecall: pairedScoreRecall.length < 2
        ? null
        : round3(spearman(
          pairedScoreRecall.map((fixture) => fixture.score),
          pairedScoreRecall.map((fixture) => fixture.recall),
        )),
      maxRounds,
    },
  }
}

/** Human-readable calibration lines for the CLI. */
export function formatCalibrationLines(report) {
  const lines = []
  const aggregate = report?.aggregate ?? {}
  lines.push(
    `[校准] fixtures=${aggregate.fixtures ?? 0} labeled=${aggregate.labeled ?? 0} `
    + `meanScore=${aggregate.meanScore ?? '—'} median=${aggregate.medianScore ?? '—'} stdev=${aggregate.stdevScore ?? '—'} `
    + `ci95=[${aggregate.ci95?.low ?? '—'}, ${aggregate.ci95?.high ?? '—'}]`,
  )
  lines.push(
    `[校准] meanRecall=${aggregate.meanRecall === null ? '—' : `${(aggregate.meanRecall * 100).toFixed(1)}%`} `
    + `meanPrecision=${aggregate.meanPrecision === null ? '—' : `${(aggregate.meanPrecision * 100).toFixed(1)}%`} `
    + `gateAgreement=${aggregate.gateAgreement ?? '—'} spearman(score,recall)=${aggregate.spearmanScoreRecall ?? '—'} `
    + `maxRounds=${aggregate.maxRounds ?? 0}`,
  )
  for (const fixture of Array.isArray(report?.fixtures) ? report.fixtures : []) {
    const gate = fixture.expectedGatePassed === null
      ? `gatePassed=${fixture.gatePassed}`
      : `gatePassed=${fixture.gatePassed}（预期 ${fixture.expectedGatePassed}${fixture.gateOk === true ? ' ✓' : ' ✗'}）`
    const labeled = fixture.labeled
      ? ` recall=${fixture.recall === null ? '—' : `${(fixture.recall * 100).toFixed(1)}%`}`
        + ` precision=${fixture.precision === null ? '—' : `${(fixture.precision * 100).toFixed(1)}%`}`
        + ` matched=${fixture.matched}/${fixture.labels}`
      : ' 无 labels'
    lines.push(`[${fixture.fixture}] score=${fixture.score ?? '—'} reported=${fixture.reported}${labeled} ${gate}`)
  }
  lines.push(`[报告] scoringRubric=${report?.scoringRubricVersion ?? '—'} rubricVersions=${(report?.rubricVersions ?? []).join(',') || '—'} profiles=${(report?.profiles ?? []).join(',') || '—'}`)
  return lines
}

function formatPercent(value) {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`
}

/** Markdown version of the calibration report. */
export function formatCalibrationMarkdown(report) {
  const aggregate = report?.aggregate ?? {}
  const lines = []
  lines.push('# 评分校准报告（v2.0 Stage A）', '')
  lines.push(`- generatedAt: \`${new Date(report?.generatedAt ?? Date.now()).toISOString()}\``)
  lines.push(`- scoringRubricVersion: \`${report?.scoringRubricVersion ?? '—'}\``)
  lines.push(`- rubricVersions: ${(report?.rubricVersions ?? []).map((version) => `\`${version}\``).join(', ') || '—'}`)
  lines.push(`- profiles: ${(report?.profiles ?? []).join(', ') || '—'}`)
  lines.push(`- results: \`${report?.results ?? '—'}\``, '')
  lines.push('## Fixtures', '')
  lines.push('| fixture | score | gate | expected | reported | labels | matched | recall | precision | judges | round |')
  lines.push('|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const fixture of Array.isArray(report?.fixtures) ? report.fixtures : []) {
    lines.push(
      `| ${fixture.fixture} | ${fixture.score ?? '—'} | ${fixture.gatePassed} | `
      + `${fixture.expectedGatePassed === null ? '—' : fixture.expectedGatePassed}${fixture.gateOk === null ? '' : (fixture.gateOk ? ' ✓' : ' ✗')} | `
      + `${fixture.reported} | ${fixture.labels} | ${fixture.matched} | ${formatPercent(fixture.recall)} | `
      + `${formatPercent(fixture.precision)} | ${fixture.judges} | ${fixture.round ?? '—'} |`,
    )
  }
  lines.push('', '## Aggregate', '')
  lines.push('| metric | value |')
  lines.push('|---|---:|')
  lines.push(`| fixtures | ${aggregate.fixtures ?? 0} |`)
  lines.push(`| labeled fixtures | ${aggregate.labeled ?? 0} |`)
  lines.push(`| mean score | ${aggregate.meanScore ?? '—'} |`)
  lines.push(`| median score | ${aggregate.medianScore ?? '—'} |`)
  lines.push(`| sample stdev | ${aggregate.stdevScore ?? '—'} |`)
  lines.push(`| score CI95 | [${aggregate.ci95?.low ?? '—'}, ${aggregate.ci95?.high ?? '—'}] |`)
  lines.push(`| mean recall | ${formatPercent(aggregate.meanRecall)} |`)
  lines.push(`| mean precision | ${formatPercent(aggregate.meanPrecision)} |`)
  lines.push(`| gate agreement | ${aggregate.gateAgreement ?? '—'} |`)
  lines.push(`| spearman(score, recall) | ${aggregate.spearmanScoreRecall ?? '—'} |`)
  lines.push(`| max rounds | ${aggregate.maxRounds ?? 0} |`)
  lines.push('')
  lines.push('> 校准只做统计与报告，不改变 95 分门控；score 仍是多判官保守聚合（lower median），CI 仅用于审计。')
  return lines.join('\n')
}

/**
 * Parse CLI arguments.
 * @param {string[]} argv
 */
export function parseArgs(argv = []) {
  const options = {
    resultsDir: DEFAULT_RESULTS_DIR,
    outFile: DEFAULT_OUT_FILE,
    md: false,
    noWrite: false,
    help: false,
  }
  const list = Array.isArray(argv) ? argv : []
  const takeValue = (index) => (typeof list[index + 1] === 'string' && list[index + 1] !== '' && !list[index + 1].startsWith('--')
    ? list[index + 1]
    : null)
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index]
    if (arg === '--md') {
      options.md = true
    } else if (arg === '--no-write') {
      options.noWrite = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--results' || arg === '--out') {
      const value = takeValue(index)
      if (value !== null) {
        if (arg === '--results') options.resultsDir = path.resolve(value)
        else options.outFile = path.resolve(value)
        index += 1
      }
    } else if (arg.startsWith('--results=')) {
      options.resultsDir = path.resolve(arg.slice('--results='.length))
    } else if (arg.startsWith('--out=')) {
      options.outFile = path.resolve(arg.slice('--out='.length))
    }
  }
  return options
}

const USAGE_TEXT = [
  '校准报告（v2.0 Stage A）：读取 benchmarks/results/*.json + fixture labels，输出 JSON（默认）与可选的 Markdown。',
  '用法：node redteam-console/benchmarks/calibrate.mjs [--results <dir>] [--out <file>] [--md] [--no-write]',
  `默认 results=${DEFAULT_RESULTS_DIR}`,
  `默认 out=${DEFAULT_OUT_FILE}（--md 同时写同名 .md）`,
  '没有 results 时打印说明并以 0 退出，不写文件；不调用 LLM、不联网。',
].join('\n')

function writeFileAtomic(file, text) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    return true
  } catch {
    return false
  }
}

/**
 * Write report files (JSON + optional Markdown).
 * @returns {{written: string[], failed: string[]}}
 */
export function writeCalibrationReport(report, options = {}) {
  const outFile = typeof options.outFile === 'string' && options.outFile !== '' ? options.outFile : DEFAULT_OUT_FILE
  const written = []
  const failed = []
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (writeFileAtomic(outFile, json)) written.push(outFile)
  else failed.push(outFile)
  if (options.md === true) {
    const mdFile = outFile.replace(/\.json$/i, '') + '.md'
    if (writeFileAtomic(mdFile, `${formatCalibrationMarkdown(report)}\n`)) written.push(mdFile)
    else failed.push(mdFile)
  }
  return { written, failed }
}

/**
 * CLI main. Returns the process exit code (0 even when no results exist).
 * @param {string[]} argv args after the script name
 * @param {{log?: Function, errorLog?: Function}} [io] injectable for tests
 */
export function main(argv = [], io = {}) {
  const log = typeof io.log === 'function' ? io.log : (line) => console.log(line)
  const options = parseArgs(argv)
  if (options.help) {
    log(USAGE_TEXT)
    return 0
  }
  const report = buildCalibrationReport({ resultsDir: options.resultsDir })
  if (report.fixtures.length === 0) {
    log(`${USAGE_TEXT}\n没有 results（目录：${options.resultsDir}）；未写入文件。`)
    return 0
  }
  for (const line of formatCalibrationLines(report)) log(line)
  if (options.noWrite === true) {
    log('[报告] --no-write：未写入文件')
    return 0
  }
  const result = writeCalibrationReport(report, { outFile: options.outFile, md: options.md })
  if (result.written.length > 0) log(`[报告] 已写入：${result.written.join(', ')}`)
  else log(`[报告] 写入失败：${result.failed.join(', ')}`)
  return 0
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`[calibrate] 执行失败：${error?.message || error}`)
    process.exitCode = 1
  }
}
