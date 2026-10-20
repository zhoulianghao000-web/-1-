/**
 * v2.0 Stage A — deterministic statistics for multi-judge/multi-model scoring.
 *
 * Pure, zero-dependency helpers used by the rubric aggregation (`scoreStats` /
 * `ci95`) and by the calibration/drift harness. Everything is deterministic:
 * the bootstrap uses a fixed seed via `mulberry32` unless the caller injects a
 * different seed, and non-finite inputs are filtered rather than trusted.
 *
 * Conventions:
 * - Empty/non-numeric input yields `null` statistics instead of NaN/Infinity.
 * - `stddev` is the sample standard deviation (n-1); undefined for n < 2.
 * - `quantile` uses linear interpolation (R type 7 / Excel PERCENTILE.INC).
 */

/** Bootstrap iterations used by `summarize` by default. */
export const BOOTSTRAP_ITERATIONS = 2000
/** Confidence level used by `summarize` by default. */
export const BOOTSTRAP_LEVEL = 0.95
/** Fixed seed so repeated runs produce byte-identical CIs. */
export const BOOTSTRAP_SEED = 0x5EED2026

/** Keep only finite numbers (never trusts strings/booleans/null). */
export function finiteValues(values) {
  if (!Array.isArray(values)) return []
  const out = []
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) out.push(value)
  }
  return out
}

/** Arithmetic mean, or null for an empty list. */
export function mean(values) {
  const list = finiteValues(values)
  if (list.length === 0) return null
  let total = 0
  for (const value of list) total += value
  return total / list.length
}

/** Median (average of the two middle values for an even count), or null. */
export function median(values) {
  const list = finiteValues(values)
  if (list.length === 0) return null
  const sorted = [...list].sort((left, right) => left - right)
  return medianSorted(sorted)
}

function medianSorted(sorted) {
  const size = sorted.length
  if (size === 0) return null
  const middle = Math.floor(size / 2)
  return size % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Sample standard deviation (n-1), or null for fewer than two values. */
export function stddev(values) {
  const list = finiteValues(values)
  if (list.length < 2) return null
  const average = mean(list)
  let sumSquares = 0
  for (const value of list) {
    const delta = value - average
    sumSquares += delta * delta
  }
  return Math.sqrt(sumSquares / (list.length - 1))
}

/**
 * Linear-interpolated quantile in [0, 1] (R type 7), or null for empty input.
 * @param {number[]} values
 * @param {number} [p=0.5]
 */
export function quantile(values, p = 0.5) {
  const list = finiteValues(values)
  if (list.length === 0) return null
  const probability = typeof p === 'number' && Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0.5
  const sorted = [...list].sort((left, right) => left - right)
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

/** Mulberry32 PRNG: deterministic, tiny, good enough for bootstrap resampling. */
export function mulberry32(seed) {
  let state = (typeof seed === 'number' && Number.isFinite(seed) ? Math.floor(seed) : BOOTSTRAP_SEED) >>> 0
  return function next() {
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Percentile-bootstrap CI for the mean.
 * @param {number[]} values
 * @param {object} [options]
 * @param {number} [options.iterations] resample count (bounded 100..20000)
 * @param {number} [options.level] confidence level (bounded 0.5..0.999)
 * @param {number} [options.seed]
 * @returns {{low: number|null, high: number|null, level: number, iterations: number}}
 */
export function bootstrapMeanCI(values, options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const list = finiteValues(values)
  const level = typeof settings.level === 'number' && Number.isFinite(settings.level)
    ? Math.min(0.999, Math.max(0.5, settings.level))
    : BOOTSTRAP_LEVEL
  const iterations = Number.isInteger(settings.iterations) && settings.iterations > 0
    ? Math.min(20000, Math.max(100, settings.iterations))
    : BOOTSTRAP_ITERATIONS
  if (list.length === 0) return { low: null, high: null, level, iterations }
  if (list.length === 1) return { low: list[0], high: list[0], level, iterations }
  const random = mulberry32(settings.seed)
  const means = new Array(iterations)
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0
    for (let index = 0; index < list.length; index += 1) {
      total += list[Math.floor(random() * list.length)]
    }
    means[iteration] = total / list.length
  }
  const alpha = (1 - level) / 2
  return {
    low: quantile(means, alpha),
    high: quantile(means, 1 - alpha),
    level,
    iterations,
  }
}

/**
 * Compact summary: {n, mean, median, stdev, min, max, ci95:{low,high}}.
 * Empty input returns all null fields (n = 0) and a null CI.
 *
 * @param {number[]} values
 * @param {{iterations?: number, level?: number, seed?: number}} [options]
 */
export function summarize(values, options = {}) {
  const list = finiteValues(values)
  const n = list.length
  if (n === 0) {
    return {
      n: 0,
      mean: null,
      median: null,
      stdev: null,
      min: null,
      max: null,
      ci95: { low: null, high: null, level: BOOTSTRAP_LEVEL, iterations: BOOTSTRAP_ITERATIONS },
    }
  }
  let min = list[0]
  let max = list[0]
  for (const value of list) {
    if (value < min) min = value
    if (value > max) max = value
  }
  const ci = bootstrapMeanCI(list, options)
  return {
    n,
    mean: mean(list),
    median: median(list),
    stdev: stddev(list),
    min,
    max,
    ci95: { low: ci.low, high: ci.high, level: ci.level, iterations: ci.iterations },
  }
}

/** Average ranks with ties sharing the mean rank (Spearman building block). */
export function averageRanks(values) {
  const list = Array.isArray(values) ? values : []
  const indexed = list.map((value, index) => ({ value, index }))
  indexed.sort((left, right) => left.value - right.value)
  const ranks = new Array(list.length)
  let position = 0
  while (position < indexed.length) {
    let end = position
    while (end + 1 < indexed.length && indexed[end + 1].value === indexed[position].value) end += 1
    const average = (position + end) / 2 + 1
    for (let index = position; index <= end; index += 1) ranks[indexed[index].index] = average
    position = end + 1
  }
  return ranks
}

/**
 * Spearman rank correlation (average ranks for ties), or null when undefined
 * (fewer than two finite pairs, or a constant rank vector).
 *
 * @param {number[]} xs
 * @param {number[]} ys
 */
export function spearman(xs, ys) {
  const left = Array.isArray(xs) ? xs : []
  const right = Array.isArray(ys) ? ys : []
  const pairs = []
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const x = left[index]
    const y = right[index]
    if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
      pairs.push([x, y])
    }
  }
  if (pairs.length < 2) return null
  const rankX = averageRanks(pairs.map((pair) => pair[0]))
  const rankY = averageRanks(pairs.map((pair) => pair[1]))
  const meanX = mean(rankX)
  const meanY = mean(rankY)
  let covariance = 0
  let varianceX = 0
  let varianceY = 0
  for (let index = 0; index < rankX.length; index += 1) {
    const dx = rankX[index] - meanX
    const dy = rankY[index] - meanY
    covariance += dx * dy
    varianceX += dx * dx
    varianceY += dy * dy
  }
  if (varianceX === 0 || varianceY === 0) return null
  const correlation = covariance / Math.sqrt(varianceX * varianceY)
  return Math.min(1, Math.max(-1, correlation))
}

/** Round to one decimal place (used by rubric/calibration score stats). */
export function round1(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null
}

/** Summarize numeric values and round every numeric field to one decimal. */
export function summarizeRounded(values, options = {}) {
  const summary = summarize(values, options)
  return {
    n: summary.n,
    mean: round1(summary.mean),
    median: round1(summary.median),
    stdev: round1(summary.stdev),
    min: round1(summary.min),
    max: round1(summary.max),
    ci95: { low: round1(summary.ci95.low), high: round1(summary.ci95.high) },
  }
}
