/**
 * v1.3 3.3 — in-flight round progress and cancellation.
 *
 * Progress itself lives on `round.progress` in the durable state (so the SSE
 * endpoint and the Web panel always show what the Host actually did). This
 * module holds:
 * - the per-process cancel-request registry (`POST /cancel?cycleId=...` sets a
 *   flag; `runReviewRound` checks it at checkpoints and aborts);
 * - the bounded progress projection used by the SSE endpoint;
 * - a helper that persists a progress stage through `store.mutate`.
 *
 * The cancel registry is intentionally in-memory: a Host restart does not resume
 * rounds, so a stale request must not leak into a later process.
 */

import { PROGRESS_STAGES } from './constants.js'

/** cycleId -> {requestedAt, reason} */
const cancelRequests = new Map()

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringOr(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function truncateText(value, maxChars) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  if (maxChars <= 0 || text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

/** Normalize `round.progress`; null for legacy rounds. */
export function normalizeProgress(raw) {
  if (!isPlainObject(raw)) return null
  if (!PROGRESS_STAGES.includes(raw.stage)) return null
  return {
    stage: raw.stage,
    updatedAt: Math.max(0, numberOr(raw.updatedAt, 0)),
    detail: truncateText(stringOr(raw.detail), 500),
  }
}

/**
 * Request cancellation for one in-flight cycle.
 * @returns {{ok: true, cancelled: boolean, reason: string}}
 */
export function requestCancel(cycleId, reason = '用户请求取消当前评审轮次') {
  const key = typeof cycleId === 'string' ? cycleId.trim() : ''
  if (key === '') return { ok: false, cancelled: false, reason: '缺少 cycleId' }
  cancelRequests.set(key, { requestedAt: Date.now(), reason: truncateText(reason, 300) })
  return { ok: true, cancelled: true, reason: truncateText(reason, 300) }
}

/** True when a cancellation was requested for this cycle. */
export function isCancelRequested(cycleId) {
  if (typeof cycleId !== 'string' || cycleId === '') return false
  return cancelRequests.has(cycleId)
}

/** Current cancel request for diagnostics/tests, or null. */
export function getCancelRequest(cycleId) {
  if (typeof cycleId !== 'string' || cycleId === '') return null
  const entry = cancelRequests.get(cycleId)
  return entry === undefined ? null : { ...entry }
}

/** Clear a finished round's request so later rounds are unaffected. */
export function clearCancel(cycleId) {
  if (typeof cycleId !== 'string' || cycleId === '') return false
  return cancelRequests.delete(cycleId)
}

/** Test helper: clear every pending cancel request. */
export function __resetCancelRequests() {
  cancelRequests.clear()
}

/**
 * Compact progress snapshot for the SSE stream / public state.
 * @param {object} round
 * @param {number} [now]
 */
export function progressView(round, now = Date.now()) {
  const progress = normalizeProgress(round?.progress)
  const finished = round?.status === 'completed' || round?.status === 'failed'
  const stage = progress === null
    ? (round?.status === 'running' ? 'evidence' : (finished ? 'done' : null))
    : progress.stage
  return {
    round: Number.isInteger(round?.n) ? round.n : null,
    stage: stage ?? 'unknown',
    updatedAt: progress === null ? numberOr(round?.startedAt, 0) : progress.updatedAt,
    detail: progress === null ? '' : progress.detail,
    done: finished || stage === 'done' || stage === 'cancelled' || (round?.status !== 'running' && round?.status !== undefined),
    serverTime: now,
  }
}

/**
 * Persist one progress stage on the round (and bump the cycle's updatedAt).
 * Progress persistence must never break the review itself.
 * @returns {Promise<boolean>} true when the mutation was applied
 */
export async function setRoundProgress(options = {}) {
  const { store, cycle, round, stage } = isPlainObject(options) ? options : {}
  if (!store || typeof store.mutate !== 'function' || !cycle || !round) return false
  if (!PROGRESS_STAGES.includes(stage)) return false
  const now = typeof options.now === 'function' ? options.now : Date.now
  const detail = truncateText(typeof options.detail === 'string' ? options.detail : '', 500)
  try {
    await store.mutate(() => {
      round.progress = { stage, updatedAt: now(), detail }
      cycle.updatedAt = now()
    })
    return true
  } catch {
    // Progress is best-effort diagnostics; a failed write must not fail the round.
    return false
  }
}
