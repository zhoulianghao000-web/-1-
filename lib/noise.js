/**
 * v1.3 3.1 — automatic noise control (no human adjudication).
 *
 * The red team and judges may report the same defect several times (same title /
 * same evidence location) or split one issue into multiple near-duplicates. The
 * Host normalizes a severity-independent `findingKey` per finding and keeps the
 * best representative (supported first, then higher severity, then longer
 * evidence), while recording what was suppressed for audit and for the next
 * round's Host-generated "known findings" list.
 *
 * Everything here is pure and bounded: no I/O, no imports beyond constants.
 */

import { LIMITS } from './constants.js'

const FINDING_PATH_LINE_RE = /((?:[A-Za-z]:)?[A-Za-z0-9_.@/\\-]+\.[A-Za-z0-9]{1,10}):(\d{1,7})(?:\s*[-–]\s*(\d{1,7}))?/
const SEVERITY_RANK = Object.freeze({ BLOCKER: 3, MAJOR: 2, MINOR: 1 })

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOr(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/** Lowercase, strip punctuation/whitespace/symbols: the dedupe identity. */
export function normalizeFindingText(value) {
  return textOr(value)
    // v2.0: judge samples often prefix findings with F1 / A2 / [BLOCKER] tags;
    // strip those so the same finding from different judges shares one key.
    .replace(/^\s*(?:F|A|FINDING)[-\s_]?\d+\s*[:.)\-]?\s*/i, '')
    .replace(/^\s*\[(?:BLOCKER|CRITICAL|MAJOR|MINOR|HIGH|MEDIUM|LOW)\]\s*/i, '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 400)
}

/**
 * First `path:line` found in a finding (evidence first, then note/title/pathLine).
 * @returns {{path: string, line: number}|null}
 */
export function extractFindingLocation(finding) {
  if (!isPlainObject(finding)) return null
  const candidates = [finding.evidence, finding.note, finding.pathLine, finding.title]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    const match = FINDING_PATH_LINE_RE.exec(candidate)
    if (match === null) continue
    const file = match[1].replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
    const line = Number(match[2])
    if (file !== '' && Number.isInteger(line) && line > 0) return { path: file, line }
  }
  return null
}

/** Severity-independent dedupe key: normalized title + first path:line. */
export function findingKey(finding) {
  if (!isPlainObject(finding)) return ''
  const title = normalizeFindingText(finding.title)
  const location = extractFindingLocation(finding)
  const pathLine = location === null ? '' : `${location.path}:${location.line}`
  if (title === '' && pathLine === '') return ''
  return `${title}|${pathLine}`
}

function severityRank(finding) {
  const severity = typeof finding?.severity === 'string' ? finding.severity.toUpperCase() : ''
  return SEVERITY_RANK[severity] || 0
}

function isSupported(finding) {
  return finding?.supported === true || finding?.verified === true
}

function evidenceLength(finding) {
  for (const key of ['evidence', 'note', 'attack', 'impact']) {
    const value = finding?.[key]
    if (typeof value === 'string' && value !== '') return value.length
  }
  return 0
}

/**
 * Compare two findings for the same key: supported > unsupported, then higher
 * severity, then longer evidence. Returns true when `candidate` is better.
 */
function betterFinding(candidate, current) {
  const supportedDelta = (isSupported(candidate) ? 1 : 0) - (isSupported(current) ? 1 : 0)
  if (supportedDelta !== 0) return supportedDelta > 0
  const severityDelta = severityRank(candidate) - severityRank(current)
  if (severityDelta !== 0) return severityDelta > 0
  return evidenceLength(candidate) > evidenceLength(current)
}

/**
 * Keep one representative per {@link findingKey}.
 * @param {Array<object>} findings
 * @param {{maxFindings?: number}} [options]
 * @returns {{kept: object[], suppressed: {key: string, title: string, reason: string}[]}}
 */
export function dedupeFindings(findings, options = {}) {
  const maxFindings = Number.isInteger(options?.maxFindings) && options.maxFindings > 0
    ? Math.min(LIMITS.maxFindings, options.maxFindings)
    : LIMITS.maxFindings
  const list = Array.isArray(findings) ? findings.filter(isPlainObject) : []
  const bestIndexByKey = new Map()
  const firstIndexByKey = new Map()
  for (let index = 0; index < list.length; index += 1) {
    const key = findingKey(list[index])
    if (key === '') continue
    if (!firstIndexByKey.has(key)) firstIndexByKey.set(key, index)
    const currentBest = bestIndexByKey.get(key)
    if (currentBest === undefined || betterFinding(list[index], list[currentBest])) {
      bestIndexByKey.set(key, index)
    }
  }
  // Keep distinct keys ordered by first appearance, capped to `maxFindings`.
  const orderedKeys = [...firstIndexByKey.entries()]
    .sort((left, right) => left[1] - right[1])
    .map((entry) => entry[0])
  const keptKeys = new Set(orderedKeys.slice(0, maxFindings))
  const kept = []
  for (const key of orderedKeys) {
    if (!keptKeys.has(key)) continue
    const index = bestIndexByKey.get(key)
    if (index !== undefined) kept.push(list[index])
  }
  const suppressed = []
  for (let index = 0; index < list.length; index += 1) {
    const finding = list[index]
    const key = findingKey(finding)
    if (key === '') continue
    if (!keptKeys.has(key)) {
      if (suppressed.length >= LIMITS.maxFindings) break
      suppressed.push({
        key,
        title: textOr(finding.title).slice(0, 200) || '(untitled)',
        reason: `发现数超过上限 ${maxFindings}，已抑制`,
      })
      continue
    }
    if (bestIndexByKey.get(key) === index) continue
    if (suppressed.length >= LIMITS.maxFindings) break
    const best = list[bestIndexByKey.get(key)]
    suppressed.push({
      key,
      title: textOr(finding.title).slice(0, 200) || '(untitled)',
      reason: `与保留的代表项「${textOr(best?.title).slice(0, 120) || '(untitled)'}」同 key（supported/severity/证据长度较低）`,
    })
  }
  return { kept, suppressed }
}

/**
 * De-duplicate a `mustFix` string list by its normalized text (first occurrence
 * wins; already-clean lists are returned without suppression entries).
 * @param {string[]} list
 * @returns {{kept: string[], suppressed: {key: string, title: string, reason: string}[]}}
 */
export function dedupeMustFix(list) {
  const items = Array.isArray(list) ? list : []
  const seen = new Set()
  const kept = []
  const suppressed = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '') continue
    const key = normalizeFindingText(text)
    if (key === '') continue
    if (seen.has(key)) {
      if (suppressed.length < LIMITS.maxMustFix) {
        suppressed.push({ key, title: text.slice(0, 200), reason: 'mustFix 重复项（按规范化文本去重）' })
      }
      continue
    }
    seen.add(key)
    if (kept.length < LIMITS.maxMustFix) kept.push(text)
  }
  return { kept, suppressed }
}

/**
 * Supported findings from one round (for the next round's Host-generated
 * "known findings" list). Judge-supported (`score.validFindings`) wins; a
 * legacy round without a score falls back to the attacker report.
 * @param {object} round
 * @param {{maxFindings?: number}} [options]
 * @returns {{title: string, severity: string, pathLine: string, status: string}[]}
 */
export function knownFindingsFromRound(round, options = {}) {
  const max = Number.isInteger(options?.maxFindings) && options.maxFindings > 0
    ? Math.min(LIMITS.maxKnownFindings, options.maxFindings)
    : LIMITS.maxKnownFindings
  if (!isPlainObject(round)) return []
  const scoreFindings = isPlainObject(round.score) && Array.isArray(round.score.validFindings)
    ? round.score.validFindings
    : null
  const source = scoreFindings !== null
    ? scoreFindings.filter((finding) => isPlainObject(finding) && finding.supported === true)
    : (isPlainObject(round.attack) && Array.isArray(round.attack.findings)
      ? round.attack.findings.filter((finding) => isPlainObject(finding) && finding.verified === true)
      : [])
  const out = []
  const seen = new Set()
  for (const finding of source) {
    const key = findingKey(finding)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    const location = extractFindingLocation(finding)
    out.push({
      title: textOr(finding.title).slice(0, 300) || '(untitled)',
      severity: typeof finding.severity === 'string' ? finding.severity.toUpperCase() : 'MINOR',
      pathLine: location === null ? '' : `${location.path}:${location.line}`,
      status: 'previously-reported',
    })
    if (out.length >= max) break
  }
  return out
}

/** Count current findings whose key matches `knownFindings`. */
export function countKnownRepeats(findings, knownFindings) {
  const knownKeys = new Set((Array.isArray(knownFindings) ? knownFindings : [])
    .map((entry) => findingKey(entry))
    .filter((key) => key !== ''))
  if (knownKeys.size === 0) return 0
  const currentKeys = new Set((Array.isArray(findings) ? findings : [])
    .map((finding) => findingKey(finding))
    .filter((key) => key !== ''))
  let count = 0
  for (const key of currentKeys) {
    if (knownKeys.has(key)) count += 1
  }
  return count
}
