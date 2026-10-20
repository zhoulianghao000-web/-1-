#!/usr/bin/env node
/**
 * 校准集 v0 统计 runner（零依赖、不调用任何 LLM）。
 *
 * 用法（在插件目录下）：
 *   node redteam-console/benchmarks/runner.mjs
 *   node redteam-console/benchmarks/runner.mjs --results <dir>
 *
 * 输入：
 *   benchmarks/results/<fixture>.json   —— 由 adversarial_review_round 返回并原样保存的 round JSON
 *   benchmarks/<fixture>/labels.json    —— 已知缺陷标注（path:line + category，供 recall 计算）
 *   benchmarks/<fixture>/review-package.json —— 可选；无 labels 的 fixture 从其 expectations 读取预期
 *
 * 输出：每个 fixture 的 recall / precision / gate 是否符合预期，以及汇总。
 * 没有 results 时打印说明并以 0 退出（不视为失败）。
 *
 * recall    = 命中的已知缺陷数 / 已知缺陷总数
 * precision = 命中至少一个已知缺陷的报告发现数 / 报告发现总数
 * 匹配口径：red-team finding 的 evidence/title/attack 文本中出现 `path:line`
 *          （或 path 与行号在同一段内），即视为命中该 label。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Normalize text for matching: forward slashes, lower case. */
export function normalizeText(value) {
  return typeof value === 'string' ? value.replace(/\\/g, '/').toLowerCase() : ''
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Concatenate the locatable text of one red-team finding. */
export function findingEvidenceText(finding) {
  if (finding === null || typeof finding !== 'object') return ''
  return normalizeText([finding.evidence, finding.title, finding.attack].filter((part) => typeof part === 'string').join(' '))
}

/**
 * Does a reported finding locate one known-defect label?
 * @param {object} finding red-team finding
 * @param {object} label labels.json entry (`path`, optional `line` / `lines`)
 * @returns {boolean}
 */
export function findingMatchesLabel(finding, label) {
  const evidence = findingEvidenceText(finding)
  if (evidence === '') return false
  const file = normalizeText(label?.path)
  if (file === '') return false
  if (!evidence.includes(file)) return false
  const lines = Array.isArray(label?.lines) && label.lines.length > 0
    ? label.lines
    : (Number.isFinite(label?.line) ? [label.line] : [])
  if (lines.length === 0) return true
  for (const candidate of lines) {
    const line = Number(candidate)
    if (!Number.isFinite(line) || line <= 0) continue
    if (evidence.includes(`${file}:${line}`)) return true
    const loose = new RegExp(`${escapeRegExp(file)}[^0-9]{0,16}${line}(?![0-9])`)
    if (loose.test(evidence)) return true
  }
  return false
}

/**
 * Compute recall/precision/gate stats for one fixture.
 *
 * @param {object} options
 * @param {string} [options.fixture]
 * @param {object|null} [options.result] compact round JSON from adversarial_review_round
 * @param {object|null} [options.labels] labels.json content
 * @param {object|null} [options.expectations] merged expectations (labels or review-package)
 * @returns {object}
 */
export function computeStats(options = {}) {
  const { fixture = '', result = null, labels = null, expectations = null } = options
  const findings = Array.isArray(result?.attack?.findings)
    ? result.attack.findings.filter((finding) => finding !== null && typeof finding === 'object')
    : []
  const labelList = Array.isArray(labels?.labels)
    ? labels.labels.filter((label) => label !== null && typeof label === 'object')
    : []
  const matchedIds = []
  for (const label of labelList) {
    if (findings.some((finding) => findingMatchesLabel(finding, label))) {
      matchedIds.push(typeof label.id === 'string' ? label.id : String(label.id ?? matchedIds.length))
    }
  }
  const reportedMatches = findings.filter((finding) => labelList.some((label) => findingMatchesLabel(finding, label))).length
  const recall = labelList.length > 0 ? matchedIds.length / labelList.length : null
  // Precision is only defined for fixtures that actually have labels.
  const precision = labelList.length > 0 && findings.length > 0 ? reportedMatches / findings.length : null
  const missedIds = labelList
    .filter((label) => !matchedIds.includes(typeof label.id === 'string' ? label.id : String(label.id)))
    .map((label) => (typeof label.id === 'string' ? label.id : String(label.id ?? '?')))
  const gatePassed = result?.gate?.passed === true
  const expectedGatePassed = expectations !== null && typeof expectations?.gatePassed === 'boolean'
    ? expectations.gatePassed
    : null
  return {
    fixture,
    labels: labelList.length,
    reported: findings.length,
    matched: matchedIds.length,
    missedIds,
    extra: findings.length - reportedMatches,
    recall,
    precision,
    gatePassed,
    expectedGatePassed,
    gateOk: expectedGatePassed === null ? null : gatePassed === expectedGatePassed,
    verdict: typeof result?.attack?.verdict === 'string' ? result.attack.verdict : null,
  }
}

/** Aggregate a list of per-fixture stats (only fixtures with labels count). */
export function summarize(statsList) {
  const list = Array.isArray(statsList) ? statsList : []
  const labeled = list.filter((stats) => stats !== null && typeof stats === 'object' && stats.labels > 0)
  const totalLabels = labeled.reduce((sum, stats) => sum + stats.labels, 0)
  const totalMatched = labeled.reduce((sum, stats) => sum + stats.matched, 0)
  const totalReported = labeled.reduce((sum, stats) => sum + stats.reported, 0)
  const totalReportedMatches = labeled.reduce((sum, stats) => sum + (stats.reported - stats.extra), 0)
  const gateMismatches = list.filter((stats) => stats.gateOk === false)
  return {
    fixtures: list.length,
    labeledFixtures: labeled.length,
    labels: totalLabels,
    matched: totalMatched,
    reported: totalReported,
    reportedMatches: totalReportedMatches,
    recall: totalLabels > 0 ? totalMatched / totalLabels : null,
    precision: totalReported > 0 ? totalReportedMatches / totalReported : null,
    gateMismatches: gateMismatches.map((stats) => stats.fixture),
  }
}

function readJson(file) {
  try {
    // Tolerate a UTF-8 BOM (some editors/PowerShell write one).
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(text)
  } catch {
    return null
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** Load labels.json / review-package.json expectations for one fixture. */
export function loadFixtureMeta(benchDir, fixture) {
  const fixtureDir = path.join(benchDir, fixture)
  const labels = readJson(path.join(fixtureDir, 'labels.json'))
  const reviewPackage = readJson(path.join(fixtureDir, 'review-package.json'))
  const expectations = labels?.expectations ?? reviewPackage?.expectations ?? null
  return { labels, reviewPackage, expectations }
}

/** Load every `*.json` result file from the results directory. */
export function loadResults(resultsDir) {
  const results = []
  let entries = []
  try {
    entries = fs.readdirSync(resultsDir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
    if (entry.name.startsWith('_')) continue
    const file = path.join(resultsDir, entry.name)
    const parsed = readJson(file)
    if (parsed === null) continue
    const fixture = typeof parsed.fixture === 'string' && parsed.fixture !== ''
      ? parsed.fixture
      : path.basename(entry.name, path.extname(entry.name))
    // Accept either a raw round JSON or a `{fixture, round}` wrapper.
    const round = parsed !== null && typeof parsed === 'object' && parsed.round !== null && typeof parsed.round === 'object'
      ? parsed.round
      : parsed
    results.push({ fixture, round, file })
  }
  return results
}

function formatPercent(value) {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`
}

/**
 * Build the full per-fixture stats list from disk (or injected data for tests).
 *
 * @param {{benchDir?: string, resultsDir?: string, results?: object[]}} [options]
 * @returns {{stats: object[], summary: object, resultsDir: string}}
 */
export function collectStats(options = {}) {
  const benchDir = typeof options.benchDir === 'string' && options.benchDir !== '' ? options.benchDir : HERE
  const resultsDir = typeof options.resultsDir === 'string' && options.resultsDir !== ''
    ? options.resultsDir
    : path.join(benchDir, 'results')
  let results = Array.isArray(options.results)
    ? options.results
    : loadResults(resultsDir)
  // De-duplicate: keep the newest file per fixture (sorted directory order is not
  // a reliable timestamp, so the caller can pass explicit results instead).
  const seen = new Set()
  results = results.filter((entry) => {
    if (seen.has(entry.fixture)) return false
    seen.add(entry.fixture)
    return true
  })
  const stats = results.map((entry) => {
    const meta = loadFixtureMeta(benchDir, entry.fixture)
    return computeStats({
      fixture: entry.fixture,
      result: entry.round,
      labels: meta.labels,
      expectations: meta.expectations,
    })
  })
  return { stats, summary: summarize(stats), resultsDir }
}

/** Render the human-readable report lines. */
export function formatReport(statsList, summary) {
  const lines = []
  for (const stats of Array.isArray(statsList) ? statsList : []) {
    const gate = stats.expectedGatePassed === null
      ? `gatePassed=${stats.gatePassed}`
      : `gatePassed=${stats.gatePassed}（预期 ${stats.expectedGatePassed}${stats.gateOk === true ? ' ✓' : ' ✗'}）`
    if (stats.labels === 0) {
      lines.push(`[${stats.fixture}] 无 labels：reported=${stats.reported} ${gate}`)
      continue
    }
    lines.push(
      `[${stats.fixture}] labels=${stats.labels} reported=${stats.reported} matched=${stats.matched} `
      + `missed=${stats.missedIds.length > 0 ? stats.missedIds.join(',') : '-'} extra=${stats.extra} `
      + `recall=${formatPercent(stats.recall)} precision=${formatPercent(stats.precision)} ${gate}`,
    )
  }
  const totals = summary ?? summarize(statsList)
  lines.push(
    `[汇总] fixtures=${totals.fixtures} labeled=${totals.labeledFixtures} `
    + `labels=${totals.labels} matched=${totals.matched} reported=${totals.reported} `
    + `recall=${formatPercent(totals.recall)} precision=${formatPercent(totals.precision)} `
    + `gateMismatches=${totals.gateMismatches.length > 0 ? totals.gateMismatches.join(',') : '-'}`,
  )
  return lines
}

const USAGE_TEXT = [
  '校准集 v0 统计 runner：没有找到 results。',
  '1. 先对 fixture 跑一轮真实评审（在 Agent 会话中调用 adversarial_review_round，target 传 fixture 的绝对路径，',
  '   claims/focus/shots 取自对应 review-package.json）。',
  '2. 把返回的 round JSON 保存到 redteam-console/benchmarks/results/<fixture>.json。',
  '3. 重新运行：node redteam-console/benchmarks/runner.mjs',
  '本 runner 不调用任何 LLM；无 results 时退出码为 0。',
].join('\n')

/**
 * CLI entry point.
 * @param {string[]} argv args after the script name
 * @returns {number} process exit code
 */
export function main(argv = []) {
  let resultsDir = path.join(HERE, 'results')
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--results') {
      const value = argv[index + 1]
      if (typeof value === 'string' && value !== '') {
        resultsDir = path.resolve(value)
        index += 1
      }
    } else if (arg.startsWith('--results=')) {
      resultsDir = path.resolve(arg.slice('--results='.length))
    }
  }
  if (!isDirectory(resultsDir)) {
    console.log(USAGE_TEXT)
    return 0
  }
  const { stats, summary } = collectStats({ resultsDir })
  if (stats.length === 0) {
    console.log(USAGE_TEXT)
    return 0
  }
  for (const line of formatReport(stats, summary)) console.log(line)
  return 0
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`[runner] 执行失败：${error?.message || error}`)
    process.exitCode = 1
  }
}
