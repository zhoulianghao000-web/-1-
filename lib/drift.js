/**
 * v2.0 Stage A — benchmark drift detection.
 *
 * Pure comparison of a fresh calibration run ("current") against an accepted
 * baseline. Inputs are maps or arrays of `{fixture, score, gatePassed, recall?,
 * precision?}`; the same fixture set is compared per fixture and aggregated.
 *
 * Thresholds are absolute *worsening* deltas (current − baseline):
 * - `driftScoreDelta`      (default 5 points)
 * - `driftRecallDelta`     (default 0.10)
 * - `driftPassRateDelta`   (default 0.10)
 *
 * Missing baseline fixtures are also an alert: silently dropping a fixture from
 * a calibration run must not look like an improvement.
 */

import { DEFAULT_CONFIG, LIMITS } from './constants.js'

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function threshold(value, fallback, { min = 0, max = 100 } = {}) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

/** Normalize one fixture record (unknown fields dropped, values bounded). */
function normalizeEntry(raw, fallbackFixture = '') {
  if (!isPlainObject(raw)) return null
  const fixture = typeof raw.fixture === 'string' && raw.fixture.trim() !== ''
    ? raw.fixture.trim().slice(0, 200)
    : fallbackFixture
  if (fixture === '') return null
  return {
    fixture,
    score: finiteOrNull(raw.score),
    gatePassed: typeof raw.gatePassed === 'boolean' ? raw.gatePassed : null,
    recall: finiteOrNull(raw.recall),
    precision: finiteOrNull(raw.precision),
  }
}

/**
 * Accept arrays, `{fixtures:{name:record}}`, `{fixtures:[record]}` or a direct
 * name→record map. Duplicate fixture names keep the last value.
 */
function normalizeFixtures(input) {
  const byName = new Map()
  const add = (raw, fallbackFixture) => {
    const entry = normalizeEntry(raw, fallbackFixture)
    if (entry !== null) byName.set(entry.fixture, entry)
  }
  if (Array.isArray(input)) {
    for (const raw of input.slice(0, LIMITS.maxCalibrationFixtures)) add(raw)
  } else if (isPlainObject(input)) {
    const nested = input.fixtures
    if (Array.isArray(nested)) {
      for (const raw of nested.slice(0, LIMITS.maxCalibrationFixtures)) add(raw)
    } else if (isPlainObject(nested)) {
      for (const [name, raw] of Object.entries(nested).slice(0, LIMITS.maxCalibrationFixtures)) {
        add(isPlainObject(raw) ? { ...raw, fixture: raw.fixture ?? name } : null, name)
      }
    } else {
      for (const [name, raw] of Object.entries(input).slice(0, LIMITS.maxCalibrationFixtures)) {
        if (!isPlainObject(raw)) continue
        add({ ...raw, fixture: raw.fixture ?? name }, name)
      }
    }
  }
  return byName
}

function meanOrNull(values) {
  const list = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
  if (list.length === 0) return null
  return list.reduce((total, value) => total + value, 0) / list.length
}

function passRate(entries) {
  const known = entries.filter((entry) => typeof entry.gatePassed === 'boolean')
  if (known.length === 0) return null
  return known.filter((entry) => entry.gatePassed === true).length / known.length
}

/**
 * Compare current fixture scores against a baseline.
 *
 * @param {object|Array} current
 * @param {object|Array} baseline
 * @param {object} [options] thresholds (`driftScoreDelta` etc.)
 * @returns {{ok: boolean, drift: boolean, alerts: object[], fixtures: object[], summary: object, thresholds: object}}
 */
export function computeDrift(current, baseline, options = {}) {
  const settings = isPlainObject(options) ? options : {}
  const extra = isPlainObject(settings.thresholds) ? settings.thresholds : {}
  const thresholds = {
    driftScoreDelta: threshold(extra.driftScoreDelta ?? settings.driftScoreDelta, DEFAULT_CONFIG.driftScoreDelta, { min: 0.1, max: 100 }),
    driftRecallDelta: threshold(extra.driftRecallDelta ?? settings.driftRecallDelta, DEFAULT_CONFIG.driftRecallDelta, { min: 0, max: 1 }),
    driftPassRateDelta: threshold(extra.driftPassRateDelta ?? settings.driftPassRateDelta, DEFAULT_CONFIG.driftPassRateDelta, { min: 0, max: 1 }),
  }

  const currentFixtures = normalizeFixtures(current)
  const baselineFixtures = normalizeFixtures(baseline)
  const names = [...new Set([...currentFixtures.keys(), ...baselineFixtures.keys()])].sort((left, right) => left.localeCompare(right))
  const alerts = []
  const fixtures = []
  const scoreDeltas = []
  const recallDeltas = []

  const pushAlert = (alert) => {
    if (alerts.length >= LIMITS.maxDriftAlerts) return
    alerts.push(alert)
  }

  for (const fixture of names) {
    if (fixtures.length >= LIMITS.maxDriftFixtures) break
    const before = baselineFixtures.get(fixture) ?? null
    const after = currentFixtures.get(fixture) ?? null
    const scoreDelta = before?.score !== null && before?.score !== undefined
      && after?.score !== null && after?.score !== undefined
      ? after.score - before.score
      : null
    const recallDelta = before?.recall !== null && before?.recall !== undefined
      && after?.recall !== null && after?.recall !== undefined
      ? after.recall - before.recall
      : null
    const precisionDelta = before?.precision !== null && before?.precision !== undefined
      && after?.precision !== null && after?.precision !== undefined
      ? after.precision - before.precision
      : null

    if (before === null) {
      fixtures.push({ fixture, status: 'new', baseline: null, current: after, scoreDelta, recallDelta, precisionDelta, gateChanged: null })
      continue
    }
    if (after === null) {
      fixtures.push({ fixture, status: 'missing', baseline: before, current: null, scoreDelta, recallDelta, precisionDelta, gateChanged: null })
      pushAlert({
        kind: 'missing-fixture',
        fixture,
        current: null,
        baseline: before.score,
        delta: null,
        threshold: null,
        message: `基线 fixture「${fixture}」在本次结果中缺失（不能当作无回归）`,
      })
      continue
    }

    const gateChanged = typeof before.gatePassed === 'boolean' && typeof after.gatePassed === 'boolean'
      ? before.gatePassed !== after.gatePassed
      : null
    fixtures.push({
      fixture,
      status: 'compared',
      baseline: before,
      current: after,
      scoreDelta,
      recallDelta,
      precisionDelta,
      gateChanged,
    })
    if (scoreDelta !== null) scoreDeltas.push(scoreDelta)
    if (recallDelta !== null) recallDeltas.push(recallDelta)
    if (scoreDelta !== null && scoreDelta <= -thresholds.driftScoreDelta + 1e-9) {
      pushAlert({
        kind: 'score-regression',
        fixture,
        current: after.score,
        baseline: before.score,
        delta: Math.round(scoreDelta * 10) / 10,
        threshold: thresholds.driftScoreDelta,
        message: `「${fixture}」评分下降 ${Math.abs(scoreDelta).toFixed(1)} 分（阈值 ${thresholds.driftScoreDelta}）`,
      })
    }
    if (recallDelta !== null && recallDelta <= -thresholds.driftRecallDelta + 1e-9) {
      pushAlert({
        kind: 'recall-regression',
        fixture,
        current: after.recall,
        baseline: before.recall,
        delta: Math.round(recallDelta * 1000) / 1000,
        threshold: thresholds.driftRecallDelta,
        message: `「${fixture}」recall 下降 ${(Math.abs(recallDelta) * 100).toFixed(1)} 个百分点（阈值 ${(thresholds.driftRecallDelta * 100).toFixed(1)}）`,
      })
    }
    if (gateChanged === true && before.gatePassed === true && after.gatePassed === false) {
      pushAlert({
        kind: 'gate-regression',
        fixture,
        current: false,
        baseline: true,
        delta: -1,
        threshold: null,
        message: `「${fixture}」基线通过（gatePassed=true）但本次未通过`,
      })
    }
  }

  const comparedBaseline = [...baselineFixtures.values()].filter((entry) => currentFixtures.has(entry.fixture))
  const comparedCurrent = comparedBaseline.map((entry) => currentFixtures.get(entry.fixture))
  const baselinePassRate = passRate(comparedBaseline)
  const currentPassRate = passRate(comparedCurrent)
  const passRateDelta = baselinePassRate !== null && currentPassRate !== null
    ? currentPassRate - baselinePassRate
    : null
  if (passRateDelta !== null && passRateDelta <= -thresholds.driftPassRateDelta + 1e-9) {
    pushAlert({
      kind: 'pass-rate-regression',
      fixture: null,
      current: currentPassRate,
      baseline: baselinePassRate,
      delta: Math.round(passRateDelta * 1000) / 1000,
      threshold: thresholds.driftPassRateDelta,
      message: `通过率下降 ${(Math.abs(passRateDelta) * 100).toFixed(1)} 个百分点（阈值 ${(thresholds.driftPassRateDelta * 100).toFixed(1)}）`,
    })
  }

  return {
    ok: true,
    drift: alerts.length > 0,
    alerts,
    fixtures,
    summary: {
      fixturesCompared: comparedBaseline.length,
      fixturesCurrent: currentFixtures.size,
      fixturesBaseline: baselineFixtures.size,
      meanScoreDelta: meanOrNull(scoreDeltas),
      meanRecallDelta: meanOrNull(recallDeltas),
      passRateDelta,
      baselinePassRate,
      currentPassRate,
    },
    thresholds,
  }
}

/**
 * Build a baseline document from current entries (for accepting a new
 * calibration run as the reference).
 *
 * @param {object|Array} current fixtures
 * @param {{now?: () => number|number, generatedAt?: number}} [options]
 */
export function buildBaselineDocument(current, options = {}) {
  const settings = isPlainObject(options) ? options : {}
  const fixtures = {}
  for (const entry of normalizeFixtures(current).values()) {
    fixtures[entry.fixture] = {
      score: entry.score,
      gatePassed: entry.gatePassed,
      recall: entry.recall,
      precision: entry.precision,
    }
  }
  const generatedAt = typeof settings.generatedAt === 'number' && Number.isFinite(settings.generatedAt)
    ? settings.generatedAt
    : (typeof settings.now === 'function' ? settings.now() : Date.now())
  return { version: 1, generatedAt, fixtures }
}
