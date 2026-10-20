/**
 * Pure grading helpers for the red-team console host plugin.
 *
 * Everything in this module is deterministic and free of I/O: JSON extraction
 * from hostile model output, normalization/validation of the attacker and judge
 * payloads, and the stop-gate calculation from CONTRACT.md §2.6.
 *
 * No imports beyond the Lead-owned shared constants.
 */

import {
  ATTACK_VERDICTS,
  CONFIDENCES,
  LIMITS,
  SCORE_VERDICTS,
  SEVERITIES,
} from './constants.js'
import { summarizeRounded } from './stats.js'

/** Inputs larger than this are truncated from the head before scanning. */
const MAX_JSON_INPUT = 400_000
/** How many top-level brace candidates are remembered while scanning. */
const MAX_JSON_CANDIDATES = 400
/** Structured arrays are capped by the shared limits; these are local safety caps. */
const MAX_SOLID_ITEMS = 30
const MAX_UNVERIFIED_ITEMS = 30
const MAX_VALID_FINDINGS = 80
const MAX_QUOTE_CHARS = 500

/** True for non-null, non-array objects. */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Clamp a score to 0–100 and snap it DOWN to the 0.5 step.
 *
 * Rounding is deliberately conservative: a judge's 94.75 must become 94.5, never
 * 95.0, so a below-threshold raw score can never cross the stop gate through
 * display rounding.
 */
export function clampScore(value) {
  const numeric = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(numeric)) return 0
  const clamped = Math.min(100, Math.max(0, numeric))
  return Math.floor(clamped * 2) / 2
}

/**
 * Bound one model-authored string. Non-strings become `''` (defensive: model
 * payloads can contain arrays/objects where a string was requested).
 */
export function truncateText(value, max = LIMITS.maxTextChars) {
  if (typeof value !== 'string') return ''
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0
  if (limit === 0 || value.length <= limit) return value
  return value.slice(0, Math.max(0, limit - 1)) + '…'
}

function textField(value, max) {
  return truncateText(value, max).trim()
}

/** Normalize one enum-ish value, accepting case-insensitive matches only. */
function normalizeEnum(value, allowed) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (allowed.includes(trimmed)) return trimmed
  const upper = trimmed.toUpperCase()
  if (allowed.includes(upper)) return upper
  const lower = trimmed.toLowerCase()
  if (allowed.includes(lower)) return lower
  return null
}

function stringList(value, maxItems, maxChars) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (out.length >= maxItems) break
    const text = textField(item, maxChars)
    if (text !== '') out.push(text)
  }
  return out
}

function tryParseObject(candidate) {
  if (typeof candidate !== 'string') return null
  const trimmed = candidate.trim()
  if (trimmed === '' || trimmed.length > MAX_JSON_INPUT) return null
  try {
    const parsed = JSON.parse(trimmed)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Collect complete top-level `{...}` substrings while ignoring braces in strings. */
function collectTopLevelObjects(text) {
  const found = []
  const stack = []
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      stack.push(index)
      continue
    }
    if (char === '}') {
      if (stack.length === 0) continue
      const start = stack.pop()
      if (stack.length === 0) {
        found.push(text.slice(start, index + 1))
        if (found.length > MAX_JSON_CANDIDATES) found.shift()
      }
    }
  }
  return found
}

/**
 * Extract the last JSON object from model output.
 *
 * Handles: pure JSON, fenced ```json blocks, prose before/after the object,
 * braces inside strings, and truncation. Hostile or unparseable input returns
 * `null` — it never throws and never returns a non-object.
 */
export function extractJson(input) {
  if (typeof input !== 'string') return null
  const clipped = input.length > MAX_JSON_INPUT ? input.slice(-MAX_JSON_INPUT) : input
  const source = clipped.charCodeAt(0) === 0xfeff ? clipped.slice(1) : clipped

  // 1. Fenced code blocks, last one first (models often wrap the contract JSON).
  const fence = /```[^\n`]*\n([\s\S]*?)```/g
  const fenced = []
  let match
  while ((match = fence.exec(source)) !== null) fenced.push(match[1])
  for (let index = fenced.length - 1; index >= 0; index -= 1) {
    const value = tryParseObject(fenced[index])
    if (value) return value
  }

  // 2. The whole payload is the JSON document.
  const whole = tryParseObject(source)
  if (whole) return whole

  // 3. Prose around the object: try the widest brace span first, then scan.
  const firstBrace = source.indexOf('{')
  const lastBrace = source.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const widest = tryParseObject(source.slice(firstBrace, lastBrace + 1))
    if (widest) return widest
  }
  const candidates = collectTopLevelObjects(source)
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const value = tryParseObject(candidates[index])
    if (value) return value
  }
  return null
}

/** Count judge findings explicitly marked as supported. */
export function countSupportedFindings(score) {
  if (!isPlainObject(score) || !Array.isArray(score.validFindings)) return 0
  let count = 0
  for (const finding of score.validFindings) {
    if (isPlainObject(finding) && finding.supported === true) count += 1
  }
  return count
}

/**
 * Validate + normalize the red-team payload.
 *
 * @returns {{ok: true, attack: object, warnings: string[]} | {ok: false, error: string}}
 */
export function validateAttack(raw) {
  const warnings = []
  if (!isPlainObject(raw)) return { ok: false, error: '红队输出不是 JSON 对象' }
  const verdict = normalizeEnum(raw.verdict, ATTACK_VERDICTS)
  if (!verdict) return { ok: false, error: '红队输出的 verdict 必须是 BLOCK / HOLD / PASS 之一' }

  let rawFindings = []
  if (Array.isArray(raw.findings)) rawFindings = raw.findings
  else if (raw.findings !== undefined && raw.findings !== null) return { ok: false, error: '红队输出的 findings 必须是数组' }
  else warnings.push('红队输出缺少 findings 数组，已按无发现处理')

  const summary = textField(raw.summary, LIMITS.maxTextChars)
  if (summary === '') warnings.push('红队输出缺少 summary，已按空摘要处理')

  const findings = []
  let dropped = 0
  for (const item of rawFindings) {
    if (!isPlainObject(item)) {
      dropped += 1
      continue
    }
    const title = textField(item.title, 200)
    if (title === '') {
      dropped += 1
      continue
    }
    const severity = normalizeEnum(item.severity, SEVERITIES)
    if (!severity) warnings.push(`发现「${title}」的 severity 不合法，已按 MINOR 处理`)
    findings.push({
      id: `F${findings.length + 1}`,
      severity: severity || 'MINOR',
      title,
      evidence: textField(item.evidence, LIMITS.maxTextChars),
      attack: textField(item.attack, LIMITS.maxTextChars),
      impact: textField(item.impact, LIMITS.maxTextChars),
      fix: textField(item.fix, LIMITS.maxTextChars),
      confidence: normalizeEnum(item.confidence, CONFIDENCES) || 'low',
      verified: item.verified === true,
    })
    if (findings.length >= LIMITS.maxFindings) {
      if (rawFindings.length > findings.length) {
        warnings.push(`发现数量超过上限 ${LIMITS.maxFindings}，其余已截断`)
      }
      break
    }
  }
  if (rawFindings.length > 0 && findings.length === 0) {
    return { ok: false, error: `红队输出的 ${rawFindings.length} 条 findings 都没有有效字段（至少需要非空 title）` }
  }
  if (dropped > 0 && findings.length > 0) warnings.push(`忽略了 ${dropped} 条结构不完整的发现`)

  const unverified = []
  if (Array.isArray(raw.unverified)) {
    for (const entry of raw.unverified) {
      if (unverified.length >= MAX_UNVERIFIED_ITEMS) break
      if (!isPlainObject(entry)) continue
      const item = textField(entry.item, MAX_QUOTE_CHARS)
      if (item === '') continue
      unverified.push({ item, needs: textField(entry.needs, 1000) })
    }
  } else if (raw.unverified !== undefined && raw.unverified !== null) {
    warnings.push('红队输出的 unverified 不是数组，已忽略')
  }

  return {
    ok: true,
    warnings,
    attack: {
      verdict,
      summary,
      findings,
      solid: stringList(raw.solid, MAX_SOLID_ITEMS, MAX_QUOTE_CHARS),
      unverified,
      nextSteps: textField(raw.nextSteps, LIMITS.maxTextChars),
    },
  }
}

/**
 * Validate + normalize the judge payload.
 *
 * @returns {{ok: true, score: object, warnings: string[]} | {ok: false, error: string}}
 */
export function validateScore(raw, options = {}) {
  const warnings = []
  if (!isPlainObject(raw)) return { ok: false, error: '判官输出不是 JSON 对象' }
  // v2.0: per-sample verdict must follow the configured pass line, not a
  // hardcoded 95 (requiredScore is configurable).
  const passLine = isPlainObject(options) && Number.isFinite(options.requiredScore) ? options.requiredScore : 95

  let rawScore = Number.NaN
  if (typeof raw.score === 'number') rawScore = raw.score
  else if (typeof raw.score === 'string' && raw.score.trim() !== '') rawScore = Number(raw.score)
  if (!Number.isFinite(rawScore)) return { ok: false, error: '判官输出的 score 必须是 0–100 的数字' }
  const score = clampScore(rawScore)
  if (score !== rawScore) warnings.push(`判官分数 ${rawScore} 已向下规整为 ${score}（0.5 步进，0–100，不会向上取整）`)

  const verdict = normalizeEnum(raw.verdict, SCORE_VERDICTS)
  if (!verdict) warnings.push('判官输出的 verdict 不合法，已按分数推导')
  const effectiveVerdict = verdict || (score >= passLine ? 'PASS' : score >= 60 ? 'HOLD' : 'BLOCK')

  const validFindings = []
  if (Array.isArray(raw.validFindings)) {
    for (const entry of raw.validFindings) {
      if (validFindings.length >= MAX_VALID_FINDINGS) break
      if (!isPlainObject(entry)) continue
      const title = textField(entry.title, 300)
      if (title === '') continue
      validFindings.push({
        title,
        severity: normalizeEnum(entry.severity, SEVERITIES) || 'MINOR',
        supported: entry.supported === true,
        note: textField(entry.note, 1000),
      })
    }
  } else if (raw.validFindings !== undefined && raw.validFindings !== null) {
    warnings.push('判官输出的 validFindings 不是数组，已按空数组处理')
  } else {
    warnings.push('判官输出缺少 validFindings，有效发现数按 0 处理')
  }
  // v2.0: some judges report supported blockers separately in blockingFindings.
  // Merge them into validFindings (supported:true, severity escalated) so any
  // supported BLOCKER/MAJOR always reaches the conservative aggregation.
  if (Array.isArray(raw.blockingFindings)) {
    const severityRank = { BLOCKER: 0, MAJOR: 1, MINOR: 2 }
    for (const entry of raw.blockingFindings) {
      if (validFindings.length >= MAX_VALID_FINDINGS) break
      if (!isPlainObject(entry)) continue
      const title = textField(entry.title, 300)
      if (title === '') continue
      const severity = normalizeEnum(entry.severity, SEVERITIES) || 'MAJOR'
      const existing = validFindings.find((finding) => finding.title === title)
      if (existing === undefined) {
        validFindings.push({ title, severity, supported: true, note: textField(entry.note, 1000) })
      } else {
        existing.supported = true
        if ((severityRank[severity] ?? 1) < (severityRank[existing.severity] ?? 2)) existing.severity = severity
      }
    }
  }
  const supportedCount = countSupportedFindings({ validFindings })

  let findingsCount = null
  if (typeof raw.findingsCount === 'number' && Number.isFinite(raw.findingsCount)) {
    findingsCount = Math.max(0, Math.round(raw.findingsCount))
  }
  if (findingsCount === null) {
    findingsCount = supportedCount
    warnings.push('判官输出的 findingsCount 不合法，已按 supported 发现数处理')
  } else if (supportedCount > findingsCount) {
    findingsCount = supportedCount
    warnings.push(`判官输出的 findingsCount（${raw.findingsCount}）小于 supported 发现数（${supportedCount}），已取较大值`)
  }

  const deductions = []
  if (Array.isArray(raw.deductions)) {
    for (const entry of raw.deductions) {
      if (deductions.length >= LIMITS.maxDeductions) break
      if (!isPlainObject(entry)) continue
      const points = typeof entry.points === 'number' ? entry.points : Number(entry.points)
      deductions.push({
        points: Number.isFinite(points) ? Math.min(100, Math.max(0, points)) : 0,
        reason: textField(entry.reason, 2000),
        fix: textField(entry.fix, 2000),
      })
    }
  } else if (raw.deductions !== undefined && raw.deductions !== null) {
    warnings.push('判官输出的 deductions 不是数组，已忽略')
  }

  let mustFix = stringList(raw.mustFix, LIMITS.maxMustFix, 2000)
  if (Array.isArray(raw.mustFix) && raw.mustFix.length > LIMITS.maxMustFix) {
    mustFix = mustFix.slice(0, LIMITS.maxMustFix)
    warnings.push(`mustFix 超过上限 ${LIMITS.maxMustFix} 条，其余已截断`)
  }

  const shotRaw = isPlainObject(raw.screenshots) ? raw.screenshots : {}
  const screenshots = {
    count: Number.isFinite(Number(shotRaw.count)) ? Math.max(0, Math.round(Number(shotRaw.count))) : 0,
    quality: normalizeEnum(shotRaw.quality, ['good', 'partial', 'bad']) || 'bad',
    note: textField(shotRaw.note, 2000),
  }

  let nextAction = raw.nextAction === 'stop' ? 'stop' : 'fix_and_review'
  if (nextAction === 'stop' && mustFix.length > 0) {
    nextAction = 'fix_and_review'
    warnings.push('判官给出了 stop 但仍列有 mustFix，已改为 fix_and_review')
  }

  return {
    ok: true,
    warnings,
    score: {
      score,
      // Raw judge value before the conservative 0.5-step clamp (audit record).
      rawScore,
      verdict: effectiveVerdict,
      findingsCount,
      supportedCount,
      validFindings,
      deductions,
      mustFix,
      screenshots,
      nextAction,
      rationale: textField(raw.rationale, LIMITS.maxTextChars),
    },
  }
}

function formatNumber(value) {
  return String(value)
}

/** Severity ranking used by the multi-judge aggregation (higher blocks harder). */
const SEVERITY_RANK = Object.freeze({ BLOCKER: 3, MAJOR: 2, MINOR: 1 })
/** Dedup key for findings: title only (same contract as the judge output). */
function findingTitle(finding) {
  return isPlainObject(finding) && typeof finding.title === 'string' ? finding.title.trim() : ''
}

function normalizeFindingSeverity(value) {
  return normalizeEnum(value, SEVERITIES) || 'MINOR'
}

/** Lower median: for an even number of samples the lower of the two middle values. */
function lowerMedian(values) {
  if (!Array.isArray(values) || values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor((sorted.length - 1) / 2)]
}

function sampleScoreValue(score) {
  if (!isPlainObject(score) || typeof score.score !== 'number' || !Number.isFinite(score.score)) return 0
  return clampScore(score.score)
}

function sampleRawScoreValue(score) {
  if (!isPlainObject(score) || typeof score.rawScore !== 'number' || !Number.isFinite(score.rawScore)) return null
  return score.rawScore
}

function sampleSupportedCount(score) {
  if (!isPlainObject(score)) return 0
  if (Number.isInteger(score.supportedCount) && score.supportedCount >= 0) return score.supportedCount
  return countSupportedFindings(score)
}

function sampleMustFix(score) {
  if (!isPlainObject(score) || !Array.isArray(score.mustFix)) return []
  return score.mustFix.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
}

function sameStringSet(left, right) {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

function deriveVerdict(score, passLine) {
  if (score >= passLine) return 'PASS'
  return score >= 60 ? 'HOLD' : 'BLOCK'
}

function defaultScreenshots() {
  return { count: 0, quality: 'bad', note: '' }
}

function normalizeScreenshots(raw) {
  if (!isPlainObject(raw)) return defaultScreenshots()
  const count = Number.isFinite(Number(raw.count)) ? Math.max(0, Math.round(Number(raw.count))) : 0
  const quality = normalizeEnum(raw.quality, ['good', 'partial', 'bad']) || 'bad'
  return { count, quality, note: textField(raw.note, 2000) }
}

/**
 * Aggregate N independent judge payloads into one conservative score (v1.1 1.2).
 *
 * Rules (deliberately pessimistic: disagreement can only lower the result):
 * - `score.score`: lower median of the sample scores, clamped DOWN to 0.5 steps.
 * - `findingsCount` / `supportedCount`: minimum across samples.
 * - `mustFix`: union, first-seen order, de-duplicated.
 * - `validFindings`: union by title; `supported` only when EVERY sample supports it.
 * - `blockingFindings`: any sample's supported BLOCKER/MAJOR (gate trusts this).
 * - `deductions`: every sample's deductions concatenated (bounded).
 * - `screenshots`: first sample (the Host still counts real screenshot files).
 * - `disagreement`: spread > 5 OR mustFix/verdict mismatch; a signal, not a gate.
 *
 * @param {Array<object>} scores normalized judge score objects (`validateScore().score`)
 * @param {object} [options]
 * @param {number} [options.requiredScore=95] pass line used for verdict/nextAction
 * @returns {object|null} aggregated score, or null for an empty sample list
 */
export function aggregateJudgeScores(scores, options = {}) {
  if (!Array.isArray(scores) || scores.length === 0) return null
  const settings = isPlainObject(options) ? options : {}
  const passLine = Number.isFinite(settings.requiredScore) ? settings.requiredScore : 95
  const samples = scores.filter(isPlainObject)
  if (samples.length === 0) return null

  const scoreValues = samples.map(sampleScoreValue)
  const rawScoreValues = samples.map(sampleRawScoreValue).filter((value) => value !== null)
  const aggregatedScore = clampScore(lowerMedian(scoreValues))
  const aggregatedRawScore = lowerMedian(rawScoreValues)

  const findingsCount = Math.min(...samples.map((sample) => (
    Number.isInteger(sample.findingsCount) && sample.findingsCount >= 0 ? sample.findingsCount : 0
  )))
  const supportedCount = Math.min(...samples.map(sampleSupportedCount))
  // v2.0: per-sample cleanliness (used by clean-pass, which must not let one
  // clean judge erase another judge's 1–2 supported findings).
  const perSampleSupported = samples.map(sampleSupportedCount)
  const perSampleFindings = samples.map((sample) => (
    Number.isInteger(sample.findingsCount) && sample.findingsCount >= 0 ? sample.findingsCount : 0
  ))

  // validFindings: union by title with intersection (AND) support semantics.
  const findingsByTitle = new Map()
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const sample = samples[sampleIndex]
    const list = Array.isArray(sample.validFindings) ? sample.validFindings : []
    for (const finding of list) {
      const title = findingTitle(finding)
      if (title === '') continue
      let entry = findingsByTitle.get(title)
      if (entry === undefined) {
        entry = { title, severity: normalizeFindingSeverity(finding.severity), supported: true, note: '', sampleIndexes: new Set(), unsupportedNote: '' }
        findingsByTitle.set(title, entry)
      }
      entry.sampleIndexes.add(sampleIndex)
      const severity = normalizeFindingSeverity(finding.severity)
      if ((SEVERITY_RANK[severity] || 0) > (SEVERITY_RANK[entry.severity] || 0)) entry.severity = severity
      const note = typeof finding.note === 'string' ? finding.note.trim() : ''
      if (entry.note === '' && note !== '') entry.note = note
      if (finding.supported !== true) {
        entry.supported = false
        if (entry.unsupportedNote === '' && note !== '') entry.unsupportedNote = note
      }
    }
  }
  const validFindings = []
  for (const entry of findingsByTitle.values()) {
    if (validFindings.length >= MAX_VALID_FINDINGS) break
    const supported = entry.supported === true && entry.sampleIndexes.size === samples.length
    validFindings.push({
      title: entry.title,
      severity: entry.severity,
      supported,
      note: supported ? entry.note : (entry.unsupportedNote !== '' ? entry.unsupportedNote : entry.note),
    })
  }

  // blockingFindings: any sample that marks a BLOCKER/MAJOR as supported blocks.
  const blockingByTitle = new Map()
  for (const sample of samples) {
    const list = Array.isArray(sample.validFindings) ? sample.validFindings : []
    for (const finding of list) {
      if (!isPlainObject(finding) || finding.supported !== true) continue
      const severity = normalizeFindingSeverity(finding.severity)
      if (severity !== 'BLOCKER' && severity !== 'MAJOR') continue
      const title = findingTitle(finding)
      if (title === '') continue
      const existing = blockingByTitle.get(title)
      const note = typeof finding.note === 'string' ? finding.note.trim() : ''
      if (existing === undefined) {
        blockingByTitle.set(title, { title, severity, supported: true, note })
      } else if ((SEVERITY_RANK[severity] || 0) > (SEVERITY_RANK[existing.severity] || 0)) {
        existing.severity = severity
      }
    }
  }
  const blockingFindings = [...blockingByTitle.values()].slice(0, MAX_VALID_FINDINGS)

  const mustFix = []
  const mustFixSeen = new Set()
  for (const sample of samples) {
    for (const item of sampleMustFix(sample)) {
      if (mustFix.length >= LIMITS.maxMustFix) break
      if (mustFixSeen.has(item)) continue
      mustFixSeen.add(item)
      mustFix.push(item)
    }
  }

  const deductions = []
  for (const sample of samples) {
    const list = Array.isArray(sample.deductions) ? sample.deductions : []
    for (const entry of list) {
      if (deductions.length >= LIMITS.maxDeductions) break
      if (!isPlainObject(entry)) continue
      deductions.push({
        points: typeof entry.points === 'number' && Number.isFinite(entry.points)
          ? Math.min(100, Math.max(0, entry.points))
          : 0,
        reason: textField(entry.reason, 2000),
        fix: textField(entry.fix, 2000),
      })
    }
  }

  const screenshots = normalizeScreenshots(samples[0].screenshots)

  // Disagreement metrics (audit/UI signal only — never changes the gate).
  const scoreSpread = Math.max(...scoreValues) - Math.min(...scoreValues)
  const mustFixSets = samples.map((sample) => new Set(sampleMustFix(sample)))
  const mustFixMismatch = mustFixSets.some((set) => !sameStringSet(set, mustFixSets[0]))
  const verdicts = samples.map((sample) => (typeof sample.verdict === 'string' ? sample.verdict : ''))
  const verdictMismatch = verdicts.some((verdict) => verdict !== verdicts[0])
  const disagreement = {
    scoreSpread,
    mustFixMismatch,
    verdictMismatch,
    disagree: scoreSpread > 5 || mustFixMismatch || verdictMismatch,
  }

  const rationales = samples
    .map((sample) => textField(sample.rationale, LIMITS.maxTextChars))
    .filter((rationale) => rationale !== '')
  const rationale = samples.length === 1
    ? (rationales[0] || '')
    : truncateText(rationales.map((entry, index) => `[判官 ${index + 1}] ${entry}`).join('\n'), LIMITS.maxTextChars)

  const verdict = deriveVerdict(aggregatedScore, passLine)
  const nextAction = mustFix.length === 0 && aggregatedScore >= passLine ? 'stop' : 'fix_and_review'

  // v2.0 Stage A: deterministic multi-judge statistics + 95% bootstrap CI.
  // The conservative `score` (lower median) and the gate semantics are
  // deliberately unchanged; these fields are audit/calibration only.
  const scoreStats = summarizeRounded(scoreValues)

  return {
    score: aggregatedScore,
    rawScore: aggregatedRawScore,
    verdict,
    findingsCount,
    supportedCount,
    perSampleSupported,
    perSampleFindings,
    validFindings,
    blockingFindings,
    deductions,
    mustFix,
    screenshots,
    nextAction,
    rationale,
    disagreement,
    // v2.0: sample count + mean/median/stdev/min/max/CI95 on the 0–100 scale.
    samples: samples.length,
    scoreStats,
    ci95: { low: scoreStats.ci95.low, high: scoreStats.ci95.high },
  }
}

/**
 * Stop-gate calculation (CONTRACT.md §2.6).
 *
 * @param {object} input
 * @param {object|null} input.score normalized judge score
 * @param {number} input.shots number of PNG evidence files actually rendered
 * @returns {{passed: boolean, score: number|null, requiredScore: number, findings: number,
 *   requiredFindings: number, shots: number, requiredShots: number, failReasons: string[]}}
 */
export function computeGate(input = {}) {
  const {
    score = null,
    shots = 0,
    requiredScore = 95,
    requiredFindings = 3,
    requiredShots = 4,
  } = isPlainObject(input) ? input : {}

  const failReasons = []
  const scoreValue = isPlainObject(score) && typeof score.score === 'number' && Number.isFinite(score.score)
    ? score.score
    : null
  const findingsCount = isPlainObject(score) && Number.isInteger(score.findingsCount) ? score.findingsCount : 0
  // Multi-judge aggregation stores the conservative minimum supported count and
  // an any-sample union of supported blocking findings; prefer both when present.
  const supportedCount = isPlainObject(score) && Number.isInteger(score.supportedCount) && score.supportedCount >= 0
    ? score.supportedCount
    : countSupportedFindings(score)
  const mustFix = isPlainObject(score) && Array.isArray(score.mustFix) ? score.mustFix : []
  const shotCount = Number.isInteger(shots) ? shots : 0
  const supportedBlocking = isPlainObject(score) && Array.isArray(score.blockingFindings)
    ? score.blockingFindings.filter((finding) => (
      isPlainObject(finding)
      && (finding.severity === 'BLOCKER' || finding.severity === 'MAJOR')
    ))
    : isPlainObject(score) && Array.isArray(score.validFindings)
      ? score.validFindings.filter((finding) => (
        isPlainObject(finding)
        && finding.supported === true
        && (finding.severity === 'BLOCKER' || finding.severity === 'MAJOR')
      ))
      : []

  const perSampleSupported = isPlainObject(score) && Array.isArray(score.perSampleSupported)
    ? score.perSampleSupported
    : null
  const perSampleFindings = isPlainObject(score) && Array.isArray(score.perSampleFindings)
    ? score.perSampleFindings
    : null
  const allSamplesClean = (perSampleSupported === null || perSampleSupported.every((count) => count === 0))
    && (perSampleFindings === null || perSampleFindings.every((count) => count === 0))
  // v2.0 clean-pass: a genuinely clean project cannot also produce 3 findings
  // without exceeding the MINOR deduction cap (3 × 2.5 = 92.5). If EVERY judge
  // sample explicitly reports ZERO supported findings, no blockers, empty
  // mustFix and a passing score, the findings minimum is satisfied by the clean
  // verdict. Per-sample check prevents one clean judge from erasing another
  // judge's 1–2 supported findings.
  const cleanPass = findingsCount === 0
    && supportedCount === 0
    && allSamplesClean
    && mustFix.length === 0
    && supportedBlocking.length === 0
    && scoreValue !== null
    && scoreValue >= requiredScore
  const findingsSatisfied = cleanPass || findingsCount >= requiredFindings
  const supportedSatisfied = cleanPass || supportedCount >= requiredFindings

  if (scoreValue === null) failReasons.push('缺少判官评分，不能判定通过')
  else if (scoreValue < requiredScore) failReasons.push(`评分 ${formatNumber(scoreValue)} < 要求 ${formatNumber(requiredScore)}`)

  if (!findingsSatisfied) {
    failReasons.push(`有效发现（去重后）${findingsCount} 条 < 要求 ${requiredFindings} 条（干净项目需 0 条 supported 且评分达标）`)
  }
  if (!supportedSatisfied) {
    failReasons.push(`判官核实有效（supported）的发现 ${supportedCount} 条 < 要求 ${requiredFindings} 条（干净项目需 0 条 supported 且评分达标）`)
  }
  if (shotCount !== requiredShots) {
    failReasons.push(`本轮截图 ${shotCount} 张，必须恰好 ${requiredShots} 张`)
  }
  if (mustFix.length > 0) {
    failReasons.push(`mustFix 仍有 ${mustFix.length} 项未清空`)
  }
  if (supportedBlocking.length > 0) {
    const blockerCount = supportedBlocking.filter((finding) => finding.severity === 'BLOCKER').length
    const majorCount = supportedBlocking.length - blockerCount
    failReasons.push(`存在判官认定为 supported 的阻断项（BLOCKER ${blockerCount} 条 / MAJOR ${majorCount} 条），必须修复后重评`)
  }

  return {
    passed: failReasons.length === 0 && scoreValue !== null,
    score: scoreValue,
    requiredScore,
    findings: findingsCount,
    requiredFindings,
    shots: shotCount,
    requiredShots,
    failReasons,
  }
}
