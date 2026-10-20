/**
 * v2.0 Stage A — deterministic statistics tests.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BOOTSTRAP_ITERATIONS,
  averageRanks,
  bootstrapMeanCI,
  finiteValues,
  mean,
  median,
  mulberry32,
  quantile,
  round1,
  spearman,
  stddev,
  summarize,
  summarizeRounded,
} from '../lib/stats.js'

test('finiteValues/mean/median handle empty and non-finite input', () => {
  assert.deepEqual(finiteValues([1, Number.NaN, 2, Infinity, '3', null]), [1, 2])
  assert.deepEqual(finiteValues(null), [])
  assert.equal(mean([]), null)
  assert.equal(mean([1, 2, 3]), 2)
  assert.equal(mean([2]), 2)
  assert.equal(median([]), null)
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(median([5]), 5)
})

test('stddev is the sample standard deviation (n-1)', () => {
  assert.equal(stddev([]), null)
  assert.equal(stddev([2]), null)
  assert.equal(stddev([1, 2, 3]), 1)
  assert.equal(stddev([2, 4, 4, 4, 5, 5, 7, 9]), Math.sqrt(32 / 7))
})

test('quantile uses linear interpolation and clamps p', () => {
  assert.equal(quantile([], 0.5), null)
  assert.equal(quantile([7]), 7)
  assert.equal(quantile([1, 2, 3, 4], 0), 1)
  assert.equal(quantile([1, 2, 3, 4], 1), 4)
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5)
  assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75)
  assert.equal(quantile([1, 2, 3, 4], -1), 1)
  assert.equal(quantile([1, 2, 3, 4], 5), 4)
  // Unsorted input must not matter.
  assert.equal(quantile([4, 1, 3, 2], 0.5), 2.5)
})

test('mulberry32 is deterministic and seed-dependent', () => {
  const first = mulberry32(1234)
  const second = mulberry32(1234)
  const third = mulberry32(9999)
  const firstValues = Array.from({ length: 5 }, () => first())
  const secondValues = Array.from({ length: 5 }, () => second())
  const thirdValues = Array.from({ length: 5 }, () => third())
  assert.deepEqual(firstValues, secondValues)
  assert.notDeepEqual(firstValues, thirdValues)
  for (const value of firstValues) {
    assert.equal(value >= 0 && value < 1, true)
  }
})

test('bootstrapMeanCI is deterministic, bounded by the observed range and handles n=0/1', () => {
  assert.deepEqual(bootstrapMeanCI([]), { low: null, high: null, level: 0.95, iterations: BOOTSTRAP_ITERATIONS })
  assert.deepEqual(bootstrapMeanCI([7]), { low: 7, high: 7, level: 0.95, iterations: BOOTSTRAP_ITERATIONS })
  const values = [10, 20, 30, 40, 50]
  const first = bootstrapMeanCI(values)
  const second = bootstrapMeanCI(values)
  assert.deepEqual(first, second)
  assert.equal(first.low <= 30, true)
  assert.equal(first.high >= 30, true)
  assert.equal(first.low >= 10, true)
  assert.equal(first.high <= 50, true)
  assert.equal(first.iterations, BOOTSTRAP_ITERATIONS)
  // Custom iterations/level are honored and bounded.
  const custom = bootstrapMeanCI(values, { iterations: 120, level: 0.9 })
  assert.equal(custom.iterations, 120)
  assert.equal(custom.level, 0.9)
  assert.equal(bootstrapMeanCI(values, { iterations: 1 }).iterations, 100)
  assert.equal(bootstrapMeanCI(values, { iterations: 999999 }).iterations, 20000)
})

test('summarize returns n/mean/median/stdev/min/max/ci95 and nulls for empty input', () => {
  const empty = summarize([])
  assert.equal(empty.n, 0)
  for (const key of ['mean', 'median', 'stdev', 'min', 'max']) assert.equal(empty[key], null)
  assert.equal(empty.ci95.low, null)
  assert.equal(empty.ci95.high, null)

  const one = summarize([42])
  assert.equal(one.n, 1)
  assert.equal(one.mean, 42)
  assert.equal(one.median, 42)
  assert.equal(one.stdev, null)
  assert.equal(one.min, 42)
  assert.equal(one.max, 42)
  assert.equal(one.ci95.low, 42)
  assert.equal(one.ci95.high, 42)

  const summary = summarize([1, 2, 3])
  assert.equal(summary.n, 3)
  assert.equal(summary.mean, 2)
  assert.equal(summary.median, 2)
  assert.equal(summary.stdev, 1)
  assert.equal(summary.min, 1)
  assert.equal(summary.max, 3)
  assert.equal(summary.ci95.low <= 2 && summary.ci95.high >= 2, true)
  // Summaries must be deterministic.
  assert.deepEqual(summary, summarize([1, 2, 3]))
  // Filtered non-finite values don't change n/mean.
  assert.equal(summarize([1, Number.NaN, 3]).n, 2)
})

test('summarizeRounded rounds every numeric field to one decimal', () => {
  const summary = summarizeRounded([1, 2, 4])
  assert.equal(summary.mean, 2.3)
  assert.equal(summary.median, 2)
  assert.equal(summary.stdev, 1.5)
  assert.equal(summary.min, 1)
  assert.equal(summary.max, 4)
  assert.equal(round1(1.25), 1.3)
  assert.equal(round1(null), null)
})

test('averageRanks assigns average ranks to ties', () => {
  assert.deepEqual(averageRanks([10, 20, 30]), [1, 2, 3])
  assert.deepEqual(averageRanks([10, 10, 30]), [1.5, 1.5, 3])
  assert.deepEqual(averageRanks([5, 5, 5, 5]), [2.5, 2.5, 2.5, 2.5])
})

test('spearman handles perfect, inverse, tied and undefined correlations', () => {
  assert.equal(spearman([1, 2, 3], [10, 20, 30]), 1)
  assert.equal(spearman([1, 2, 3], [30, 20, 10]), -1)
  assert.equal(spearman([1, 2, 3], [7, 7, 7]), null)
  assert.equal(spearman([], []), null)
  assert.equal(spearman([1], [2]), null)
  // Ties use average ranks (still a valid correlation).
  assert.equal(spearman([1, 2, 3, 4], [1, 2, 2, 4]) > 0.8, true)
  // Non-finite pairs are dropped; fewer than two pairs → null.
  assert.equal(spearman([1, Number.NaN], [2, 3]), null)
  // Clamped to [-1, 1].
  const clamped = spearman([1, 2], [1, 2])
  assert.equal(clamped, 1)
})
