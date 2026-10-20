#!/usr/bin/env node
/**
 * v2.0 Stage A — benchmark drift CLI (zero dependencies, no LLM/network).
 *
 * Compares the latest `benchmarks/results/*.json` calibration run against an
 * accepted baseline (`benchmarks/baseline.json` by default) and exits non-zero
 * when a score/recall/pass-rate regression crosses the configured threshold.
 *
 * Usage (from the plugin directory):
 *   node redteam-console/benchmarks/drift.mjs
 *   node redteam-console/benchmarks/drift.mjs --results <dir> --baseline <file> --json
 *
 * Baseline document shape:
 *   { "version": 1, "generatedAt": <ms>, "fixtures": { "<fixture>": {
 *       "score": 60, "gatePassed": false, "recall": 1, "precision": 1 } } }
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildBaselineDocument, computeDrift } from '../lib/drift.js'
import { computeStats, loadFixtureMeta, loadResults } from './runner.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_RESULTS_DIR = path.join(HERE, 'results')
const DEFAULT_BASELINE_FILE = path.join(HERE, 'baseline.json')

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

/**
 * Build current fixture entries from a results directory or injected results.
 * Scores come from the round, recall/precision from the labeled fixtures.
 *
 * @param {{resultsDir?: string, benchDir?: string, results?: object[]}} [options]
 * @returns {object[]} `[{fixture, score, gatePassed, recall, precision}]`
 */
export function currentFixturesFromResults(options = {}) {
  const benchDir = typeof options.benchDir === 'string' && options.benchDir !== '' ? options.benchDir : HERE
  const resultsDir = typeof options.resultsDir === 'string' && options.resultsDir !== ''
    ? options.resultsDir
    : path.join(benchDir, 'results')
  const loaded = Array.isArray(options.results) ? options.results : loadResults(resultsDir)
  const seen = new Set()
  const current = []
  for (const entry of loaded) {
    if (seen.has(entry.fixture)) continue
    seen.add(entry.fixture)
    const meta = loadFixtureMeta(benchDir, entry.fixture)
    const stats = computeStats({
      fixture: entry.fixture,
      result: entry.round,
      labels: meta.labels,
      expectations: meta.expectations,
    })
    const score = typeof entry.round?.score?.score === 'number' && Number.isFinite(entry.round.score.score)
      ? entry.round.score.score
      : null
    current.push({
      fixture: entry.fixture,
      score,
      gatePassed: entry.round?.gate?.passed === true,
      recall: stats.recall,
      precision: stats.precision,
    })
  }
  return current
}

/** Load a baseline document (or null when missing/invalid). */
export function loadBaselineFile(file = DEFAULT_BASELINE_FILE) {
  if (typeof file !== 'string' || file === '') return null
  return readJson(file)
}

function formatPercent(value) {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`
}

function formatSigned(value, digits = 1) {
  if (value === null || value === undefined) return '—'
  const rounded = Number(value.toFixed(digits))
  return `${rounded > 0 ? '+' : ''}${rounded}`
}

/** Human-readable drift report lines. */
export function formatDriftReport(result) {
  const lines = []
  const summary = result?.summary ?? {}
  lines.push(
    `[漂移] fixtures=${result?.fixtures?.length ?? 0} compared=${summary.fixturesCompared ?? 0} `
    + `meanScoreDelta=${formatSigned(summary.meanScoreDelta)} meanRecallDelta=${formatSigned(summary.meanRecallDelta, 3)} `
    + `passRateDelta=${formatSigned(summary.passRateDelta, 3)}`,
  )
  for (const entry of Array.isArray(result?.fixtures) ? result.fixtures : []) {
    const score = entry.current?.score ?? entry.baseline?.score ?? null
    const delta = entry.status === 'compared' ? formatSigned(entry.scoreDelta) : entry.status
    lines.push(
      `[${entry.fixture}] status=${entry.status} score=${score ?? '—'} delta=${delta} `
      + `gate=${entry.current?.gatePassed ?? entry.baseline?.gatePassed ?? '—'} `
      + `recall=${formatPercent(entry.current?.recall ?? entry.baseline?.recall)}`,
    )
  }
  if (result?.drift === true) {
    lines.push(`[结论] DRIFT（${result.alerts.length} 条告警）`)
    for (const alert of result.alerts) lines.push(`  - ${alert.kind}: ${alert.message}`)
  } else {
    lines.push('[结论] 无漂移（在阈值内）')
  }
  return lines
}

/**
 * Parse CLI arguments.
 * @param {string[]} argv
 */
export function parseArgs(argv = []) {
  const options = {
    resultsDir: DEFAULT_RESULTS_DIR,
    baselineFile: DEFAULT_BASELINE_FILE,
    json: false,
    help: false,
  }
  const list = Array.isArray(argv) ? argv : []
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index]
    if (arg === '--json') {
      options.json = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--results' || arg === '--baseline') {
      const value = list[index + 1]
      if (typeof value === 'string' && value !== '' && !value.startsWith('--')) {
        if (arg === '--results') options.resultsDir = path.resolve(value)
        else options.baselineFile = path.resolve(value)
        index += 1
      }
    } else if (arg.startsWith('--results=')) {
      options.resultsDir = path.resolve(arg.slice('--results='.length))
    } else if (arg.startsWith('--baseline=')) {
      options.baselineFile = path.resolve(arg.slice('--baseline='.length))
    }
  }
  return options
}

const USAGE_TEXT = [
  'benchmark 漂移检查（v2.0 Stage A）：将 benchmarks/results 与基线对比，分数/recall/通过率下降超过阈值时退出码为 1。',
  '用法：node redteam-console/benchmarks/drift.mjs [--results <dir>] [--baseline <file>] [--json]',
  `默认 results=${DEFAULT_RESULTS_DIR}`,
  `默认 baseline=${DEFAULT_BASELINE_FILE}（基线文件格式见脚本头部注释）`,
  '没有 results 或缺基线时打印说明并以 0 退出；本脚本不调用 LLM、不联网。',
].join('\n')

/**
 * CLI main. Returns the process exit code (1 = drift detected).
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
  if (!isDirectory(options.resultsDir)) {
    log(USAGE_TEXT)
    return 0
  }
  const current = currentFixturesFromResults({ resultsDir: options.resultsDir })
  if (current.length === 0) {
    log(`${USAGE_TEXT}\n结果目录为空：${options.resultsDir}`)
    return 0
  }
  const baseline = loadBaselineFile(options.baselineFile)
  if (baseline === null) {
    log(`未找到可解析的基线文件：${options.baselineFile}\n${USAGE_TEXT}`)
    return 0
  }
  const result = computeDrift(current, baseline)
  if (options.json) {
    log(JSON.stringify({ ...result, resultsDir: options.resultsDir, baselineFile: options.baselineFile }, null, 2))
  } else {
    for (const line of formatDriftReport(result)) log(line)
  }
  return result.drift ? 1 : 0
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`[drift] 执行失败：${error?.message || error}`)
    process.exitCode = 1
  }
}

// Exported for the calibration/tests to accept a new baseline without extra flags.
export { buildBaselineDocument }
