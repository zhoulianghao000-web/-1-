/**
 * Secret redaction for persisted review evidence (v1.1 1.4).
 *
 * The red-team/judge children can echo project content or their own environment
 * into titles, notes, raw snippets and JSON blobs. Before that text is written
 * to `state.json` (or served by the Web panel) every string is passed through
 * this module: well-known credential shapes are replaced with
 * `[REDACTED:<kind>]`, while the surrounding evidence text stays readable.
 *
 * Redaction is deliberately conservative (no entropy heuristics that could eat
 * legitimate code snippets): the patterns are the documented secret formats.
 * `redactText()`/`redactValue()` are the public helpers; the `*WithStats`
 * variants additionally return how many replacements were made so the round can
 * record a `{hit, count}` audit marker.
 */

const MAX_TEXT_CHARS = 200_000
const MAX_DEPTH = 12
const MAX_ENTRIES = 5000
const MAX_REDACTIONS = 2000

/** Catch most `api_key: value`, `secret = "value"`, `token=...`, `password:...`. */
const ASSIGNMENT_PATTERN = /(api[_-]?key|secret|token|password)\b(\s*[:=]\s*)(["']?)([^\s"',;]{8,})/gi
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{10,}/g
const AWS_KEY_PATTERN = /\bAKIA[0-9A-Z]{16}\b/g
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._-]{10,}/g

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function capText(text) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  return value.length > MAX_TEXT_CHARS ? value.slice(0, MAX_TEXT_CHARS) : value
}

/**
 * Replace every documented credential shape in `text`.
 *
 * @param {string} text
 * @param {{count?: {value: number}}} [stats] internal counters
 * @returns {string} redacted (and length-capped) text
 */
function redactTextInternal(text, stats) {
  let output = capText(text)
  if (output === '') return output
  const replace = (pattern, replacement) => {
    output = output.replace(pattern, (...args) => {
      const next = typeof replacement === 'function' ? replacement(...args) : replacement
      if (stats !== undefined) stats.value += 1
      return next
    })
  }
  // Order matters: structured assignments first (so `api_key=sk-...` is not
  // reported twice), then the block/credential formats.
  replace(ASSIGNMENT_PATTERN, (_match, key, separator) => `${key}${separator}[REDACTED:assignment]`)
  replace(PRIVATE_KEY_PATTERN, '[REDACTED:private-key]')
  replace(OPENAI_KEY_PATTERN, '[REDACTED:openai-key]')
  replace(AWS_KEY_PATTERN, '[REDACTED:aws-access-key]')
  replace(BEARER_PATTERN, 'Bearer [REDACTED:bearer]')
  if (stats !== undefined) {
    // Keep the audit counter bounded even for hostile multi-megabyte text.
    if (stats.value > MAX_REDACTIONS) stats.value = MAX_REDACTIONS
  }
  return output
}

/**
 * Redact secrets from one string, preserving the surrounding evidence context.
 * @param {string} text
 * @returns {string}
 */
export function redactText(text) {
  return redactTextInternal(text, undefined)
}

/**
 * Redact one string and report how many replacements were made.
 * @param {string} text
 * @returns {{text: string, count: number}}
 */
export function redactTextWithStats(text) {
  const stats = { value: 0 }
  const output = redactTextInternal(text, stats)
  return { text: output, count: stats.value }
}

function redactValueInternal(value, stats, depth) {
  if (typeof value === 'string') return redactTextInternal(value, stats)
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'undefined') return value
  if (depth >= MAX_DEPTH) return '[REDACTED:depth]'
  if (Array.isArray(value)) {
    const out = []
    for (let index = 0; index < value.length && index < MAX_ENTRIES; index += 1) {
      out.push(redactValueInternal(value[index], stats, depth + 1))
    }
    return out
  }
  if (isPlainObject(value)) {
    const out = {}
    let count = 0
    for (const key of Object.keys(value)) {
      if (count >= MAX_ENTRIES) break
      count += 1
      out[key] = redactValueInternal(value[key], stats, depth + 1)
    }
    return out
  }
  // Functions/symbols/bigints are not persistable JSON; drop them safely.
  return null
}

/**
 * Deep-copy `value` with every contained string redacted. Arrays keep order,
 * plain objects keep their keys; unsupported values become null.
 * @param {*} value
 * @returns {*}
 */
export function redactValue(value) {
  return redactValueInternal(value, undefined, 0)
}

/**
 * Deep-copy + redact and report the total number of replacements, so a round can
 * persist `redaction: {hit, count}`.
 * @param {*} value
 * @returns {{value: *, count: number}}
 */
export function redactValueWithStats(value) {
  const stats = { value: 0 }
  const redacted = redactValueInternal(value, stats, 0)
  return { value: redacted, count: stats.value }
}

export { MAX_TEXT_CHARS, MAX_DEPTH, MAX_ENTRIES }
