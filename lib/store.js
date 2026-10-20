/**
 * Durable state for the red-team console.
 *
 * `<stateDir>/state.json` holds every cycle/round. All writes go through one
 * in-module promise queue and are atomic (tmp file + rename); corrupt or
 * unreadable JSON is quarantined instead of overwritten, and the evidence
 * directory (`<stateDir>/shots/...`) is never touched by this module.
 *
 * Pure helpers live next to `createStore` so the lifecycle can be unit tested
 * without a Host.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { LEGACY_RUBRIC_VERSION, LIMITS, PROFILES, ROUND_MODES, RUBRIC_VERSION, STATE_SCHEMA_VERSION } from './constants.js'
import { normalizeProgress } from './progress.js'
import { computeGate } from './rubric.js'

export const CYCLE_STATUSES = Object.freeze(['reviewing', 'passed'])
export const ROUND_STATUSES = Object.freeze(['running', 'completed', 'failed'])
const SAFE_CYCLE_ID = /^[A-Za-z0-9._-]{1,80}$/
const SAFE_SNAPSHOT_FILE = /^snapshots\/[A-Za-z0-9._-]{1,80}\/r\d{1,4}\.json$/
const DEFAULT_REQUIRED = Object.freeze({ score: 95, findings: 3, shots: 4 })

/** True for non-null, non-array objects. */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringOr(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Resolve the state directory exactly as the contract requires:
 * `config.stateDir`, else `$DSH_HOME/adversarial-review`, else `~/.dsh/adversarial-review`.
 */
export function resolveStateDir(config, env = process.env, home = os.homedir()) {
  const configured = isPlainObject(config) ? stringOr(config.stateDir).trim() : ''
  if (configured !== '') return path.resolve(configured)
  const dshHome = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : path.join(home, '.dsh')
  return path.resolve(dshHome, 'adversarial-review')
}

/** Empty, well-formed state document. */
export function createEmptyState(now = Date.now()) {
  return { schemaVersion: STATE_SCHEMA_VERSION, updatedAt: now, cycles: [] }
}

/** Absolute target path (empty string when the input is not a usable path). */
export function normalizeTargetPath(target) {
  if (typeof target !== 'string' || target.trim() === '') return ''
  try {
    return path.resolve(target.trim())
  } catch {
    return ''
  }
}

/** Comparison key for targets: Windows is case-insensitive. */
export function targetKey(target) {
  const resolved = normalizeTargetPath(target)
  if (resolved === '') return ''
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** True when both paths name the same target directory. */
export function sameTarget(left, right) {
  const key = targetKey(left)
  return key !== '' && key === targetKey(right)
}

/** Deliverable root of a cycle: explicit binding, else the reviewed target. */
export function cycleDeliverableRoot(cycle) {
  if (!isPlainObject(cycle)) return ''
  const explicit = normalizeTargetPath(cycle.deliverableRoot)
  return explicit !== '' ? explicit : normalizeTargetPath(cycle.target)
}

/** True when `absPath` equals or lives inside `root` (Windows case-insensitive). */
export function isPathInsideOrEqual(root, absPath) {
  const rootK = targetKey(root)
  const pathK = targetKey(absPath)
  if (rootK === '' || pathK === '') return false
  return pathK === rootK || pathK.startsWith(rootK + path.sep)
}

// ---------------------------------------------------------------------------
// state integrity (v1.1 1.4): a sha256 hash chain over the persisted document
// ---------------------------------------------------------------------------

/** Canonical JSON: sorted object keys, arrays in their original order. */
export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? 'null' : encoded
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item === undefined ? null : item)).join(',')}]`
  }
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`
}

/**
 * sha256 over the canonical `{schemaVersion, updatedAt, cycles}` document.
 * The integrity record itself is never part of the hash (it is the seal).
 */
export function computeIntegrityHash(document) {
  const source = isPlainObject(document) ? document : {}
  return createHash('sha256')
    .update(canonicalStringify({
      schemaVersion: source.schemaVersion,
      updatedAt: source.updatedAt,
      cycles: source.cycles,
    }), 'utf8')
    .digest('hex')
}

/** Build the top-level integrity record for a document about to be persisted. */
export function createIntegrityRecord(document, previousHash = null) {
  const source = isPlainObject(document) ? document : {}
  return {
    algorithm: 'sha256',
    hash: computeIntegrityHash(source),
    previousHash: typeof previousHash === 'string' && previousHash !== '' ? previousHash : null,
    updatedAt: numberOr(source.updatedAt, 0),
  }
}

/**
 * Verify a parsed state document's integrity seal.
 * @returns {{status: 'ok'|'missing'|'invalid'|'mismatch', hash: string|null, error: string|null}}
 */
export function verifyIntegrity(parsed) {
  if (!isPlainObject(parsed) || !isPlainObject(parsed.integrity)) {
    return { status: 'missing', hash: null, error: null }
  }
  const record = parsed.integrity
  if (record.algorithm !== 'sha256' || typeof record.hash !== 'string' || !/^[0-9a-f]{64}$/.test(record.hash)) {
    return { status: 'invalid', hash: null, error: 'state.json 的 integrity 记录格式不合法' }
  }
  const expected = computeIntegrityHash(parsed)
  if (expected !== record.hash) {
    return { status: 'mismatch', hash: null, error: `state.json 完整性校验失败（内容哈希 ${expected.slice(0, 12)}… ≠ 记录 ${record.hash.slice(0, 12)}…）` }
  }
  return { status: 'ok', hash: record.hash, error: null }
}

/** New cycle id, e.g. `c-m1x2y3-abcd12`. */
export function newCycleId(now = Date.now(), random = Math.random) {
  const stamp = Math.floor(Math.abs(numberOr(now, Date.now()))).toString(36)
  const roll = Math.floor(Math.abs(numberOr(random(), 0.5)) * 36 ** 6).toString(36).padStart(6, '0').slice(-6)
  return `c-${stamp}-${roll}`
}

/** Latest cycle recorded for a target (regardless of status), or null. */
export function findCycleByTarget(state, target) {
  if (!isPlainObject(state) || !Array.isArray(state.cycles)) return null
  const key = targetKey(target)
  if (key === '') return null
  for (let index = state.cycles.length - 1; index >= 0; index -= 1) {
    const cycle = state.cycles[index]
    if (isPlainObject(cycle) && targetKey(cycle.target) === key) return cycle
  }
  return null
}

/** Cycle by exact id, or null. */
export function findCycleById(state, id) {
  if (!isPlainObject(state) || !Array.isArray(state.cycles)) return null
  return state.cycles.find((cycle) => isPlainObject(cycle) && cycle.id === id) ?? null
}

/** Latest reviewing cycle created by one session (used by the tool guard). */
export function findReviewingCycleForSession(state, sessionId) {
  if (!isPlainObject(state) || !Array.isArray(state.cycles) || typeof sessionId !== 'string') return null
  let found = null
  for (const cycle of state.cycles) {
    if (!isPlainObject(cycle)) continue
    if (cycle.status !== 'reviewing') continue
    if (cycle.sessionId !== sessionId) continue
    if (found === null || numberOr(cycle.updatedAt, 0) >= numberOr(found.updatedAt, 0)) found = cycle
  }
  return found
}

/** Last round of a cycle, or null. */
export function latestRoundOf(cycle) {
  if (!isPlainObject(cycle) || !Array.isArray(cycle.rounds) || cycle.rounds.length === 0) return null
  return cycle.rounds[cycle.rounds.length - 1]
}

/** Every well-formed cycle of a state document (newest keeps storage order). */
export function listCycles(state) {
  if (!isPlainObject(state) || !Array.isArray(state.cycles)) return []
  return state.cycles.filter(isPlainObject)
}

/**
 * Latest round of a cycle when that round actually passed the gate, else null.
 * Used by the tool guard: "最新一轮已通过" is the only state that may deliver.
 */
export function latestPassedRound(cycle) {
  const round = latestRoundOf(cycle)
  if (!isPlainObject(round) || !isPlainObject(round.gate)) return null
  return round.gate.passed === true ? round : null
}

/** Cycles whose deliverable root is exactly `root`. */
export function findCyclesByDeliverableRoot(state, root) {
  const key = targetKey(root)
  if (key === '') return []
  return listCycles(state).filter((cycle) => targetKey(cycleDeliverableRoot(cycle)) === key)
}

/**
 * Cycles whose deliverable root equals or contains `absPath`.
 * This is the guard's project-level lookup: it deliberately ignores session ids,
 * so a subagent or a fork cannot deliver files of a reviewed project.
 */
export function findCyclesForDeliverable(state, absPath) {
  const resolved = normalizeTargetPath(absPath)
  if (resolved === '') return []
  return listCycles(state).filter((cycle) => isPathInsideOrEqual(cycleDeliverableRoot(cycle), resolved))
}

/**
 * v1.3 3.2: newest cycle (by updatedAt, then storage order) whose deliverable
 * root covers `absPath`. The guard must evaluate the newest cycle per deliverable
 * root so an older passed cycle can never authorise delivery of a project whose
 * latest review is still running/failed.
 */
export function newestCycleForDeliverable(state, absPath) {
  const resolved = normalizeTargetPath(absPath)
  if (resolved === '') return null
  const cycles = listCycles(state)
  let best = null
  let bestRank = { updatedAt: Number.NEGATIVE_INFINITY, index: -1 }
  for (let index = 0; index < cycles.length; index += 1) {
    const cycle = cycles[index]
    if (!isPathInsideOrEqual(cycleDeliverableRoot(cycle), resolved)) continue
    const updatedAt = numberOr(cycle.updatedAt, 0)
    if (updatedAt > bestRank.updatedAt || (updatedAt === bestRank.updatedAt && index > bestRank.index)) {
      best = cycle
      bestRank = { updatedAt, index }
    }
  }
  return best
}

/** Newest cycle whose deliverable root is exactly `root`, or null. */
export function newestCycleByDeliverableRoot(state, root) {
  const key = targetKey(root)
  if (key === '') return null
  const cycles = listCycles(state)
  let best = null
  let bestRank = { updatedAt: Number.NEGATIVE_INFINITY, index: -1 }
  for (let index = 0; index < cycles.length; index += 1) {
    const cycle = cycles[index]
    if (targetKey(cycleDeliverableRoot(cycle)) !== key) continue
    const updatedAt = numberOr(cycle.updatedAt, 0)
    if (updatedAt > bestRank.updatedAt || (updatedAt === bestRank.updatedAt && index > bestRank.index)) {
      best = cycle
      bestRank = { updatedAt, index }
    }
  }
  return best
}

function normalizeRequired(rawRequired) {
  const source = isPlainObject(rawRequired) ? rawRequired : {}
  return {
    score: numberOr(source.score, DEFAULT_REQUIRED.score),
    findings: Math.max(0, Math.round(numberOr(source.findings, DEFAULT_REQUIRED.findings))),
    shots: Math.max(0, Math.round(numberOr(source.shots, DEFAULT_REQUIRED.shots))),
  }
}

/** Append a fresh cycle and return it. */
export function createCycle(state, options = {}) {
  const {
    target,
    title,
    sessionId = null,
    required,
    deliverableRoot,
    now = Date.now(),
    // v1.3 3.2: reopened cycles point at the passed cycle they replace.
    reopenedFrom = null,
    reopenCount = 0,
  } = isPlainObject(options) ? options : {}
  const absoluteTarget = normalizeTargetPath(target)
  if (absoluteTarget === '') throw new Error('createCycle 需要合法的 target 路径')
  const absoluteRoot = normalizeTargetPath(deliverableRoot) || absoluteTarget
  const reopenedFromId = typeof reopenedFrom === 'string' && SAFE_CYCLE_ID.test(reopenedFrom) ? reopenedFrom : null
  const cycle = {
    id: isPlainObject(options) && typeof options.id === 'string' && SAFE_CYCLE_ID.test(options.id)
      ? options.id
      : newCycleId(now),
    target: absoluteTarget,
    title: stringOr(title).trim() !== '' ? stringOr(title).trim().slice(0, 300) : path.basename(absoluteTarget),
    createdAt: now,
    updatedAt: now,
    status: 'reviewing',
    sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null,
    deliverableRoot: absoluteRoot,
    required: normalizeRequired(required),
    // v1.3 3.2: lifecycle audit for reopen/incremental cycles (0/null for fresh).
    reopenCount: Math.max(0, Math.floor(numberOr(reopenCount, 0))),
    reopenedFrom: reopenedFromId,
    rounds: [],
  }
  state.cycles.push(cycle)
  return cycle
}

/** Start (and return) the next round of a cycle. */
export function startRound(cycle, options = {}) {
  const {
    now = Date.now(),
    profile = null,
    mode = 'fresh',
  } = isPlainObject(options) ? options : {}
  const previous = latestRoundOf(cycle)
  const nextNumber = previous && Number.isInteger(previous.n) ? previous.n + 1 : cycle.rounds.length + 1
  const round = {
    n: nextNumber,
    status: 'running',
    rubricVersion: RUBRIC_VERSION,
    startedAt: now,
    finishedAt: null,
    error: null,
    shots: [],
    attack: null,
    score: null,
    gate: null,
    // v1.1 audit records (all optional/additive; older state simply lacks them).
    promptHashes: null,
    modelRoute: null,
    disagreement: null,
    judgeRaw: null,
    judges: [],
    attackerSessionId: null,
    judgeSessionId: null,
    judgeSessionIds: [],
    // v1.1 1.3/1.4 additive: project manifest summary + redaction marker.
    snapshot: null,
    redaction: { hit: false, count: 0 },
    timings: { shotsMs: 0, attackMs: 0, judgeMs: 0 },
    // v1.2 additive: domain profile + evidence-card records (see lib/evidence.js).
    profile: PROFILES.includes(profile) ? profile : null,
    evidence: [],
    // v1.3 additive: lifecycle/incremental/progress/noise/cost records.
    mode: ROUND_MODES.includes(mode) ? mode : 'fresh',
    progress: null,
    noise: null,
    cost: null,
    incremental: null,
  }
  cycle.rounds.push(round)
  cycle.updatedAt = now
  return round
}

function normalizeShot(raw) {
  if (!isPlainObject(raw)) return null
  const file = stringOr(raw.file).trim()
  if (file === '' || path.basename(file) !== file) return null
  const shot = {
    file,
    url: stringOr(raw.url),
    width: Math.max(0, Math.round(numberOr(raw.width, 0))),
    height: Math.max(0, Math.round(numberOr(raw.height, 0))),
    bytes: Math.max(0, Math.round(numberOr(raw.bytes, 0))),
    page: stringOr(raw.page),
    renderedAt: numberOr(raw.renderedAt, 0),
  }
  // v1.1 1.4: sha256 of the PNG bytes (legacy shots simply lack it).
  if (typeof raw.sha256 === 'string' && /^[0-9a-f]{64}$/.test(raw.sha256)) shot.sha256 = raw.sha256
  return shot
}

/** v1.1 1.3 `round.snapshot`: compact manifest summary (never the file list). */
function normalizeSnapshot(raw) {
  if (!isPlainObject(raw)) return null
  const manifestHash = typeof raw.manifestHash === 'string' && raw.manifestHash.trim() !== ''
    ? raw.manifestHash.trim().slice(0, 128)
    : ''
  if (manifestHash === '') return null
  const filesFile = typeof raw.filesFile === 'string' && SAFE_SNAPSHOT_FILE.test(raw.filesFile.trim())
    ? raw.filesFile.trim()
    : null
  return {
    manifestHash,
    gitCommit: typeof raw.gitCommit === 'string' && /^[0-9a-f]{7,64}$/i.test(raw.gitCommit) ? raw.gitCommit.toLowerCase() : null,
    fileCount: Math.max(0, Math.round(numberOr(raw.fileCount, 0))),
    hashedBytes: Math.max(0, Math.round(numberOr(raw.hashedBytes, 0))),
    truncated: raw.truncated === true,
    skippedCount: Math.max(0, Math.round(numberOr(raw.skippedCount, 0))),
    createdAt: numberOr(raw.createdAt, 0),
    // v1.3 3.2: relative path of the persisted snapshot file list.
    filesFile,
  }
}

/** v1.1 1.4 `round.redaction`: {hit, count} audit marker for secret scrubbing. */
function normalizeRedaction(raw) {
  if (!isPlainObject(raw)) return { hit: false, count: 0 }
  return {
    hit: raw.hit === true,
    count: Math.max(0, Math.round(numberOr(raw.count, 0))),
  }
}

function normalizeTimings(raw) {
  const source = isPlainObject(raw) ? raw : {}
  return {
    shotsMs: Math.max(0, numberOr(source.shotsMs, 0)),
    attackMs: Math.max(0, numberOr(source.attackMs, 0)),
    judgeMs: Math.max(0, numberOr(source.judgeMs, 0)),
  }
}

// ---------------------------------------------------------------------------
// v1.3 3.1–3.4: noise / incremental / cost / progress / mode records
// ---------------------------------------------------------------------------

const NOISE_PATH_MAX = 64
const INCREMENTAL_PATH_MAX = 500

/** One normalized repo-relative path (forward slashes, bounded, no escapes). */
function normalizeRepoRelativePath(value, maxChars = INCREMENTAL_PATH_MAX) {
  const text = stringOr(value).trim().slice(0, maxChars).replace(/\\/g, '/')
  if (text === '' || text.startsWith('/') || text.includes('\0') || text === '..' || text.startsWith('../')) return ''
  return text
}

function normalizeRepoPathList(raw, maxItems) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const entry of raw) {
    if (out.length >= maxItems) break
    const path = normalizeRepoRelativePath(entry)
    if (path === '' || seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

/** v1.3 3.1 `round.noise`: raw/deduped counts + bounded suppression audit. */
function normalizeNoise(raw) {
  if (!isPlainObject(raw)) return null
  const suppressed = []
  if (Array.isArray(raw.suppressed)) {
    for (const entry of raw.suppressed) {
      if (suppressed.length >= LIMITS.maxNoiseSuppressed) break
      if (!isPlainObject(entry)) continue
      suppressed.push({
        key: stringOr(entry.key).slice(0, 300),
        title: stringOr(entry.title).slice(0, 200),
        reason: stringOr(entry.reason).slice(0, 300),
      })
    }
  }
  return {
    rawFindings: Math.max(0, Math.round(numberOr(raw.rawFindings, 0))),
    dedupedFindings: Math.max(0, Math.round(numberOr(raw.dedupedFindings, 0))),
    suppressed,
    knownRepeats: Math.max(0, Math.round(numberOr(raw.knownRepeats, 0))),
  }
}

/** v1.3 3.4 `round.cost`: timings + prompt/response sizes + counts. */
function normalizeCost(raw) {
  if (!isPlainObject(raw)) return null
  const cost = {}
  for (const key of ['totalMs', 'evidenceMs', 'attackMs', 'judgeMs', 'promptChars', 'judgePromptChars', 'attackChars', 'scoreChars']) {
    cost[key] = Math.max(0, Math.round(numberOr(raw[key], 0)))
  }
  cost.judgeSamples = Math.max(0, Math.round(numberOr(raw.judgeSamples, 0)))
  cost.artifactCount = Math.max(0, Math.round(numberOr(raw.artifactCount, 0)))
  return cost
}

/** v1.3 3.2 `round.incremental`: changed/added/removed vs the passed baseline. */
function normalizeIncremental(raw) {
  if (!isPlainObject(raw)) return null
  const baseManifestHash = stringOr(raw.baseManifestHash).slice(0, 128)
  const currentManifestHash = stringOr(raw.currentManifestHash).slice(0, 128)
  const mode = raw.mode === 'incremental' || raw.mode === 'reopen' ? raw.mode : 'incremental'
  return {
    mode,
    baseCycleId: typeof raw.baseCycleId === 'string' && SAFE_CYCLE_ID.test(raw.baseCycleId) ? raw.baseCycleId : null,
    baseRound: Number.isInteger(raw.baseRound) && raw.baseRound > 0 ? raw.baseRound : null,
    baseManifestHash: /^[0-9a-f]{64}$/.test(baseManifestHash) ? baseManifestHash : null,
    currentManifestHash: /^[0-9a-f]{64}$/.test(currentManifestHash) ? currentManifestHash : null,
    changedFiles: normalizeRepoPathList(raw.changedFiles, LIMITS.maxIncrementalFilesStored),
    addedFiles: normalizeRepoPathList(raw.addedFiles, LIMITS.maxIncrementalFilesStored),
    removedFiles: normalizeRepoPathList(raw.removedFiles, LIMITS.maxIncrementalFilesStored),
    truncated: raw.truncated === true,
    fullReview: raw.fullReview === true,
    unchangedCount: Math.max(0, Math.round(numberOr(raw.unchangedCount, 0))),
  }
}

// ---------------------------------------------------------------------------
// v1.2 2.1: evidence-card records (`round.evidence`, old state → null)
// ---------------------------------------------------------------------------

const EVIDENCE_KIND_SET = new Set(['screenshot', 'interaction', 'image', 'pdf-text'])

function normalizeEvidenceArtifact(raw) {
  if (!isPlainObject(raw)) return null
  const file = stringOr(raw.file).trim()
  if (file === '' || path.basename(file) !== file) return null
  const artifact = {
    file: file.slice(0, 120),
    path: typeof raw.path === 'string' ? raw.path.slice(0, 1000) : '',
    width: Math.max(0, Math.round(numberOr(raw.width, 0))),
    height: Math.max(0, Math.round(numberOr(raw.height, 0))),
    bytes: Math.max(0, Math.round(numberOr(raw.bytes, 0))),
    // Evidence bytes are only trusted with a well-formed content hash.
    sha256: typeof raw.sha256 === 'string' && /^[0-9a-f]{64}$/.test(raw.sha256) ? raw.sha256 : null,
    mime: stringOr(raw.mime, 'image/png').slice(0, 80),
    kind: stringOr(raw.kind, 'screenshot').slice(0, 32),
  }
  if (typeof raw.stepName === 'string' && raw.stepName !== '') artifact.stepName = raw.stepName.slice(0, 64)
  return artifact
}

function normalizeEvidenceMeta(raw) {
  const source = isPlainObject(raw) ? raw : {}
  const consoleSource = isPlainObject(source.console) ? source.console : {}
  const networkSource = isPlainObject(source.network) ? source.network : {}
  const perfSource = isPlainObject(source.perf) ? source.perf : {}
  const metrics = {}
  if (isPlainObject(perfSource.metrics)) {
    for (const [key, value] of Object.entries(perfSource.metrics)) {
      if (Object.keys(metrics).length >= 12) break
      if (typeof key !== 'string' || key === '' || !Number.isFinite(value)) continue
      metrics[key.slice(0, 80)] = value
    }
  }
  const steps = []
  if (Array.isArray(source.steps)) {
    for (const step of source.steps) {
      if (steps.length >= LIMITS.maxEvidenceStepsPerCard + 2) break
      if (!isPlainObject(step)) continue
      const compact = { action: stringOr(step.action).slice(0, 24) || 'unknown' }
      for (const key of ['selector', 'key', 'name', 'file', 'tag', 'page']) {
        if (typeof step[key] === 'string' && step[key] !== '') compact[key] = step[key].slice(0, 200)
      }
      if (Number.isFinite(step.ms)) compact.ms = Math.max(0, Math.round(step.ms))
      steps.push(compact)
    }
  }
  return {
    url: stringOr(source.url).slice(0, 1000),
    // `page` is a display path for screenshot/interaction cards and the selected
    // 1-based page NUMBER for pdf-text cards (v1.2 2.3b).
    page: typeof source.page === 'string'
      ? source.page.slice(0, 500)
      : (Number.isInteger(source.page) && source.page >= 0 ? source.page : null),
    console: {
      events: Array.isArray(consoleSource.events)
        ? consoleSource.events.filter((item) => typeof item === 'string').slice(0, LIMITS.maxEvidenceConsoleEvents).map((item) => item.slice(0, LIMITS.evidenceEventChars))
        : [],
      errors: Math.max(0, Math.round(numberOr(consoleSource.errors, 0))),
      truncated: consoleSource.truncated === true,
    },
    network: {
      requests: Math.max(0, Math.round(numberOr(networkSource.requests, 0))),
      failures: Math.max(0, Math.round(numberOr(networkSource.failures, 0))),
      truncated: networkSource.truncated === true,
      failureSamples: Array.isArray(networkSource.failureSamples)
        ? networkSource.failureSamples.filter((item) => typeof item === 'string').slice(0, LIMITS.maxEvidenceFailureSamples).map((item) => item.slice(0, LIMITS.evidenceEventChars))
        : [],
    },
    perf: {
      metrics,
      fps: Number.isFinite(perfSource.fps) ? Math.round(perfSource.fps * 100) / 100 : null,
    },
    steps,
    // v1.2 2.3b: PDF extraction provenance (absent for non-pdf-text cards).
    pageCount: Number.isInteger(source.pageCount) && source.pageCount >= 0 ? source.pageCount : null,
    extractedChars: Number.isInteger(source.extractedChars) && source.extractedChars >= 0 ? source.extractedChars : null,
    truncated: source.truncated === true,
    pdfSha256: typeof source.pdfSha256 === 'string' && /^[0-9a-f]{64}$/.test(source.pdfSha256) ? source.pdfSha256 : null,
  }
}

/** Normalize `round.evidence`; absent/legacy rounds load as null. */
function normalizeEvidence(raw) {
  if (!Array.isArray(raw)) return null
  const cards = []
  let artifactBudget = LIMITS.maxEvidenceArtifacts
  for (const entry of raw) {
    if (cards.length >= LIMITS.maxEvidenceCards) break
    if (!isPlainObject(entry)) continue
    const artifacts = []
    if (Array.isArray(entry.artifacts)) {
      for (const artifactRaw of entry.artifacts) {
        if (artifactBudget <= 0) break
        const artifact = normalizeEvidenceArtifact(artifactRaw)
        if (artifact === null) continue
        artifacts.push(artifact)
        artifactBudget -= 1
      }
    }
    cards.push({
      index: Number.isInteger(entry.index) && entry.index >= 0 ? entry.index : cards.length,
      name: stringOr(entry.name).trim().slice(0, 64) || `evidence-${cards.length + 1}`,
      kind: EVIDENCE_KIND_SET.has(entry.kind) ? entry.kind : 'screenshot',
      artifacts,
      meta: normalizeEvidenceMeta(entry.meta),
    })
  }
  return cards.length === 0 ? null : cards
}

/** One optional child model route (`{provider?, model?, reasoningEffort?}`) or null. */
function normalizeOptionRoute(raw) {
  if (!isPlainObject(raw)) return null
  const route = {}
  for (const key of ['provider', 'model', 'reasoningEffort']) {
    const value = typeof raw[key] === 'string' ? raw[key].trim() : ''
    if (value !== '') route[key] = value
  }
  return Object.keys(route).length > 0 ? route : null
}

/** v1.1 `round.modelRoute`: requested attacker/judge routes + inherited flag. */
function normalizeModelRoute(raw) {
  if (!isPlainObject(raw)) return null
  const attacker = normalizeOptionRoute(raw.attacker)
  const judge = normalizeOptionRoute(raw.judge)
  const route = {
    attacker,
    judge,
    inherited: typeof raw.inherited === 'boolean' ? raw.inherited : attacker === null && judge === null,
  }
  // v2.0 Stage A: per-sample judge routes (absent on legacy rounds).
  if (Array.isArray(raw.samples)) {
    route.samples = raw.samples.slice(0, LIMITS.maxJudgeSamples).map((entry) => normalizeOptionRoute(entry))
  }
  return route
}

/** v1.1 `round.promptHashes`: sha256 hex strings for the two prompt texts. */
function normalizePromptHashes(raw) {
  if (!isPlainObject(raw)) return null
  const attacker = typeof raw.attacker === 'string' && raw.attacker !== '' ? raw.attacker : null
  const judge = typeof raw.judge === 'string' && raw.judge !== '' ? raw.judge : null
  return attacker === null && judge === null ? null : { attacker, judge }
}

/** v1.1 `round.disagreement`: audit-only multi-judge disagreement signal. */
function normalizeDisagreement(raw) {
  if (!isPlainObject(raw)) return null
  return {
    scoreSpread: Math.max(0, numberOr(raw.scoreSpread, 0)),
    mustFixMismatch: raw.mustFixMismatch === true,
    verdictMismatch: raw.verdictMismatch === true,
    disagree: raw.disagree === true,
  }
}

/** One persisted per-sample judge record (v1.1 `round.judges[]`). */
function normalizeJudgeEntry(raw, fallbackIndex) {
  if (!isPlainObject(raw)) return null
  return {
    index: Number.isInteger(raw.index) && raw.index >= 0 ? raw.index : fallbackIndex,
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId !== '' ? raw.sessionId : null,
    score: typeof raw.score === 'number' && Number.isFinite(raw.score) ? raw.score : null,
    rawScore: typeof raw.rawScore === 'number' && Number.isFinite(raw.rawScore) ? raw.rawScore : null,
    verdict: typeof raw.verdict === 'string' ? raw.verdict : null,
    findingsCount: Number.isInteger(raw.findingsCount) ? raw.findingsCount : null,
    supportedCount: Number.isInteger(raw.supportedCount) ? raw.supportedCount : null,
    mustFix: Array.isArray(raw.mustFix) ? raw.mustFix.filter((item) => typeof item === 'string') : [],
    deductions: Array.isArray(raw.deductions) ? raw.deductions.filter(isPlainObject) : [],
    rationale: stringOr(raw.rationale),
    rawSnippet: stringOr(raw.rawSnippet),
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((item) => typeof item === 'string') : [],
    modelRoute: normalizeOptionRoute(raw.modelRoute),
  }
}

function normalizeJudges(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    const normalized = normalizeJudgeEntry(entry, out.length)
    if (normalized !== null) out.push(normalized)
  }
  return out
}

function normalizeJudgeSessionIds(raw) {
  const ids = Array.isArray(raw.judgeSessionIds)
    ? raw.judgeSessionIds.filter((id) => typeof id === 'string' && id !== '')
    : []
  if (ids.length === 0 && typeof raw.judgeSessionId === 'string' && raw.judgeSessionId !== '') {
    // Older rounds only stored the first judge session; keep it queryable.
    return [raw.judgeSessionId]
  }
  return ids
}

function normalizeRound(raw, fallbackNumber, now) {
  if (!isPlainObject(raw)) return null
  const round = {
    n: Number.isInteger(raw.n) && raw.n > 0 ? raw.n : fallbackNumber,
    status: ROUND_STATUSES.includes(raw.status) ? raw.status : 'failed',
    rubricVersion: typeof raw.rubricVersion === 'string' && raw.rubricVersion !== '' ? raw.rubricVersion : null,
    startedAt: numberOr(raw.startedAt, now),
    finishedAt: numberOr(raw.finishedAt, 0) || null,
    error: typeof raw.error === 'string' ? raw.error : null,
    shots: Array.isArray(raw.shots) ? raw.shots.map(normalizeShot).filter(Boolean) : [],
    attack: isPlainObject(raw.attack) ? raw.attack : null,
    score: isPlainObject(raw.score) ? raw.score : null,
    gate: isPlainObject(raw.gate) ? raw.gate : null,
    // Audit fields are additive: legacy rounds load with explicit null/[] defaults.
    promptHashes: normalizePromptHashes(raw.promptHashes),
    modelRoute: normalizeModelRoute(raw.modelRoute),
    disagreement: normalizeDisagreement(raw.disagreement),
    judgeRaw: typeof raw.judgeRaw === 'string' ? raw.judgeRaw.slice(0, 4000) : null,
    judges: normalizeJudges(raw.judges),
    attackerSessionId: typeof raw.attackerSessionId === 'string' ? raw.attackerSessionId : null,
    judgeSessionId: typeof raw.judgeSessionId === 'string' ? raw.judgeSessionId : null,
    judgeSessionIds: normalizeJudgeSessionIds(raw),
    // v1.1 1.3/1.4 additive records: project manifest + redaction marker.
    snapshot: normalizeSnapshot(raw.snapshot),
    redaction: normalizeRedaction(raw.redaction),
    timings: normalizeTimings(raw.timings),
    // v1.2 2.1/2.3a additive: domain profile + evidence cards (null for legacy).
    profile: PROFILES.includes(raw.profile) ? raw.profile : null,
    evidence: normalizeEvidence(raw.evidence),
    // v1.3 additive: mode/progress/noise/cost/incremental (null for legacy).
    mode: ROUND_MODES.includes(raw.mode) ? raw.mode : 'fresh',
    progress: normalizeProgress(raw.progress),
    noise: normalizeNoise(raw.noise),
    cost: normalizeCost(raw.cost),
    incremental: normalizeIncremental(raw.incremental),
  }
  return round
}

function normalizeCycle(raw, index, now) {
  if (!isPlainObject(raw)) return null
  const target = normalizeTargetPath(raw.target)
  if (target === '') return null
  const rounds = Array.isArray(raw.rounds)
    ? raw.rounds.map((round, roundIndex) => normalizeRound(round, roundIndex + 1, now)).filter(Boolean)
    : []
  // Deduplicate round numbers; the last record for a number wins.
  const byNumber = new Map()
  for (const round of rounds) byNumber.set(round.n, round)
  const uniqueRounds = [...byNumber.values()].sort((left, right) => left.n - right.n)
  return {
    id: typeof raw.id === 'string' && SAFE_CYCLE_ID.test(raw.id) ? raw.id : newCycleId(now, () => (index + 1) / 97),
    target,
    title: stringOr(raw.title).trim() !== '' ? stringOr(raw.title).trim().slice(0, 300) : path.basename(target),
    createdAt: numberOr(raw.createdAt, now),
    updatedAt: numberOr(raw.updatedAt, now),
    status: CYCLE_STATUSES.includes(raw.status) ? raw.status : 'reviewing',
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId !== '' ? raw.sessionId : null,
    // v1.1 1.3: the delivery root a passed review is bound to. Legacy cycles
    // (no field) bind to their own target so old demo history keeps working.
    deliverableRoot: normalizeTargetPath(raw.deliverableRoot) || target,
    // v1.3 3.2: reopen lifecycle audit (0/null for fresh and legacy cycles).
    reopenCount: Math.max(0, Math.round(numberOr(raw.reopenCount, 0))),
    reopenedFrom: typeof raw.reopenedFrom === 'string' && SAFE_CYCLE_ID.test(raw.reopenedFrom) ? raw.reopenedFrom : null,
    required: normalizeRequired(raw.required),
    rounds: uniqueRounds,
  }
}

/** Coerce arbitrary parsed JSON into a safe in-memory state document. */
export function normalizeState(raw, now = Date.now()) {
  const state = createEmptyState(now)
  if (!isPlainObject(raw) || !Array.isArray(raw.cycles)) return state
  state.updatedAt = numberOr(raw.updatedAt, now)
  state.cycles = raw.cycles.map((cycle, index) => normalizeCycle(cycle, index, now)).filter(Boolean)
  return state
}

/** ×10 for a finite 10-point score; anything else is passed through untouched. */
function scaleLegacyScore(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value * 10 : value
}

function migrateV1Round(raw) {
  if (!isPlainObject(raw)) return raw
  const migrated = { ...raw, rubricVersion: LEGACY_RUBRIC_VERSION }
  if (isPlainObject(raw.score)) {
    const score = { ...raw.score, score: scaleLegacyScore(raw.score.score) }
    if (Array.isArray(raw.score.deductions)) {
      score.deductions = raw.score.deductions.map((entry) => (
        isPlainObject(entry) ? { ...entry, points: scaleLegacyScore(entry.points) } : entry
      ))
    }
    migrated.score = score
  }
  if (isPlainObject(raw.gate)) {
    migrated.gate = {
      ...raw.gate,
      score: scaleLegacyScore(raw.gate.score),
      requiredScore: DEFAULT_REQUIRED.score,
    }
  }
  return migrated
}

/**
 * Migrate a schemaVersion-1 (10-point rubric) state document to v2 (100-point).
 *
 * Pure transformation of the raw parsed JSON: every legacy round keeps its
 * evidence and is stamped `rubricVersion: 'legacy-10'`, while the numeric score
 * inputs are ×10 so they are comparable with new v2-100 rounds. Gates are not
 * trusted from v1 and are re-derived by `recomputeMigratedGates`.
 *
 * @returns {object|null} a v2-shaped document, or null when the input is unusable
 */
export function migrateStateV1(raw, now = Date.now()) {
  if (!isPlainObject(raw) || !Array.isArray(raw.cycles)) return null
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    updatedAt: numberOr(raw.updatedAt, now),
    cycles: raw.cycles.map((cycle) => {
      if (!isPlainObject(cycle)) return cycle
      const required = isPlainObject(cycle.required) ? cycle.required : {}
      return {
        ...cycle,
        required: {
          ...required,
          score: DEFAULT_REQUIRED.score,
        },
        rounds: Array.isArray(cycle.rounds) ? cycle.rounds.map((round) => migrateV1Round(round)) : [],
      }
    }),
  }
}

/**
 * Migrate a schemaVersion-2 document to v3 (purely additive).
 *
 * Adds the v1.3 cycle lifecycle fields (`reopenCount`, `reopenedFrom`); rounds
 * are normalized later (their new optional fields default to null). The seal is
 * re-created on the next persist, and the pre-migration file is backed up as
 * `state.json.pre-v3-<ts>`.
 *
 * @returns {object|null} a v3-shaped document, or null when the input is unusable
 */
export function migrateStateV2(raw, now = Date.now()) {
  if (!isPlainObject(raw) || !Array.isArray(raw.cycles)) return null
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    updatedAt: numberOr(raw.updatedAt, now),
    cycles: raw.cycles.map((cycle) => {
      if (!isPlainObject(cycle)) return cycle
      return {
        ...cycle,
        reopenCount: Math.max(0, Math.round(numberOr(cycle.reopenCount, 0))),
        reopenedFrom: typeof cycle.reopenedFrom === 'string' && SAFE_CYCLE_ID.test(cycle.reopenedFrom) ? cycle.reopenedFrom : null,
      }
    }),
  }
}

/**
 * Re-derive every migrated gate from the (already ×10) score and real shot count,
 * then fix the cycle status from the latest round. Mutates `state` in place.
 */
function recomputeMigratedGates(state) {
  if (!isPlainObject(state) || !Array.isArray(state.cycles)) return state
  for (const cycle of state.cycles) {
    if (!isPlainObject(cycle) || !Array.isArray(cycle.rounds)) continue
    for (const round of cycle.rounds) {
      if (!isPlainObject(round)) continue
      if (!isPlainObject(round.score) && !isPlainObject(round.gate)) continue
      round.gate = computeGate({
        score: round.score,
        shots: Array.isArray(round.shots) ? round.shots.length : 0,
        requiredScore: cycle.required.score,
        requiredFindings: cycle.required.findings,
        requiredShots: cycle.required.shots,
      })
    }
    const latest = latestRoundOf(cycle)
    const latestPassed = isPlainObject(latest) && isPlainObject(latest.gate) && latest.gate.passed === true
    cycle.status = latestPassed ? 'passed' : 'reviewing'
  }
  return state
}

/** Keep `maxCycles` cycles (newest by updatedAt) and `maxRoundsPerCycle` rounds each. */
export function trimState(state, options = {}) {
  if (!isPlainObject(state) || !Array.isArray(state.cycles)) return state
  const maxCycles = Number.isInteger(options.maxCycles) && options.maxCycles > 0 ? options.maxCycles : LIMITS.maxCycles
  const maxRounds = Number.isInteger(options.maxRoundsPerCycle) && options.maxRoundsPerCycle > 0
    ? options.maxRoundsPerCycle
    : LIMITS.maxRoundsPerCycle

  if (state.cycles.length > maxCycles) {
    const ranked = state.cycles
      .map((cycle, index) => ({ cycle, index, updatedAt: numberOr(isPlainObject(cycle) ? cycle.updatedAt : 0, 0) }))
      .sort((left, right) => left.updatedAt - right.updatedAt || left.index - right.index)
    const drop = new Set(ranked.slice(0, state.cycles.length - maxCycles).map((entry) => entry.index))
    state.cycles = state.cycles.filter((_cycle, index) => !drop.has(index))
  }
  for (const cycle of state.cycles) {
    if (!isPlainObject(cycle) || !Array.isArray(cycle.rounds)) continue
    if (cycle.rounds.length <= maxRounds) continue
    const sorted = [...cycle.rounds].sort((left, right) => numberOr(left?.n, 0) - numberOr(right?.n, 0))
    cycle.rounds = sorted.slice(-maxRounds)
  }
  return state
}

/** Trim aggressively until the serialized document fits the hard size limit. */
export function fitStateToLimit(state, maxBytes = LIMITS.maxStateBytes) {
  if (!isPlainObject(state) || !Array.isArray(state.cycles)) return false
  const fits = () => Buffer.byteLength(JSON.stringify(state), 'utf8') <= maxBytes
  if (fits()) return true
  for (const keepRounds of [10, 5, 2, 1]) {
    for (const cycle of state.cycles) {
      if (isPlainObject(cycle) && Array.isArray(cycle.rounds) && cycle.rounds.length > keepRounds) {
        cycle.rounds = cycle.rounds.slice(-keepRounds)
      }
    }
    if (fits()) return true
  }
  while (state.cycles.length > 1) {
    state.cycles.shift()
    if (fits()) return true
  }
  return fits()
}

/**
 * Public shot projection: only what the Web panel needs.
 *
 * v1.1 1.4: no filesystem path may leave the host, so the `file://` evidence
 * URL is dropped entirely (the panel fetches PNGs through
 * `/adversarial-review/shot?cycleId=...&file=...`) and an absolute `page` value
 * is reduced to its basename.
 */
export function publicShot(shot) {
  if (!isPlainObject(shot)) return null
  let page = stringOr(shot.page).slice(0, 500)
  if (page !== '' && path.isAbsolute(page)) page = path.basename(page)
  return {
    file: stringOr(shot.file),
    width: numberOr(shot.width, 0),
    height: numberOr(shot.height, 0),
    bytes: numberOr(shot.bytes, 0),
    page,
    renderedAt: numberOr(shot.renderedAt, 0),
    // v1.3 UI: content hash is safe to expose (no path/secret); legacy shots lack it.
    sha256: typeof shot.sha256 === 'string' && /^[0-9a-f]{64}$/.test(shot.sha256) ? shot.sha256 : null,
  }
}

function publicEvidenceCard(card) {
  if (!isPlainObject(card)) return null
  const meta = isPlainObject(card.meta) ? card.meta : {}
  const consoleBlock = isPlainObject(meta.console) ? meta.console : {}
  const networkBlock = isPlainObject(meta.network) ? meta.network : {}
  const perfBlock = isPlainObject(meta.perf) ? meta.perf : {}
  const artifacts = Array.isArray(card.artifacts) ? card.artifacts : []
  return {
    index: Number.isInteger(card.index) && card.index >= 0 ? card.index : 0,
    name: stringOr(card.name).slice(0, 64),
    kind: EVIDENCE_KIND_SET.has(card.kind) ? card.kind : 'screenshot',
    artifactCount: artifacts.length,
    consoleErrors: Math.max(0, Math.round(numberOr(consoleBlock.errors, 0))),
    networkFailures: Math.max(0, Math.round(numberOr(networkBlock.failures, 0))),
    perfFps: Number.isFinite(perfBlock.fps) ? Math.round(perfBlock.fps * 100) / 100 : null,
    // v1.3 UI support: filenames/dimensions only (never absolute paths/logs).
    artifacts: artifacts.map((artifact) => {
      const publicArtifact = {
        file: stringOr(artifact.file),
        width: Math.max(0, Math.round(numberOr(artifact.width, 0))),
        height: Math.max(0, Math.round(numberOr(artifact.height, 0))),
        kind: stringOr(artifact.kind, 'screenshot').slice(0, 32),
      }
      if (typeof artifact.stepName === 'string' && artifact.stepName !== '') publicArtifact.stepName = artifact.stepName.slice(0, 64)
      if (typeof artifact.sha256 === 'string' && /^[0-9a-f]{64}$/.test(artifact.sha256)) publicArtifact.sha256 = artifact.sha256
      return publicArtifact
    }),
  }
}

function publicIncremental(raw) {
  if (!isPlainObject(raw)) return null
  const cap = 100
  const trim = (list) => (Array.isArray(list) ? list.slice(0, cap) : [])
  const changedFiles = trim(raw.changedFiles)
  const addedFiles = trim(raw.addedFiles)
  const removedFiles = trim(raw.removedFiles)
  const truncated = raw.truncated === true
    || (Array.isArray(raw.changedFiles) && raw.changedFiles.length > cap)
    || (Array.isArray(raw.addedFiles) && raw.addedFiles.length > cap)
    || (Array.isArray(raw.removedFiles) && raw.removedFiles.length > cap)
  return {
    mode: raw.mode === 'reopen' ? 'reopen' : 'incremental',
    baseCycleId: typeof raw.baseCycleId === 'string' ? raw.baseCycleId : null,
    baseRound: Number.isInteger(raw.baseRound) ? raw.baseRound : null,
    changedFiles,
    addedFiles,
    removedFiles,
    truncated,
    fullReview: raw.fullReview === true,
    unchangedCount: Math.max(0, Math.round(numberOr(raw.unchangedCount, 0))),
  }
}

/** v2.0 bounded public route projection (`provider/model/reasoningEffort` only). */
function publicOptionRoute(raw) {
  if (!isPlainObject(raw)) return null
  const route = {}
  for (const [key, cap] of [['provider', 200], ['model', 200], ['reasoningEffort', 100]]) {
    const value = typeof raw[key] === 'string' ? raw[key].trim() : ''
    if (value !== '') route[key] = value.slice(0, cap)
  }
  return Object.keys(route).length === 0 ? null : route
}

function publicModelRoute(raw) {
  if (!isPlainObject(raw)) return null
  return {
    attacker: publicOptionRoute(raw.attacker),
    judge: publicOptionRoute(raw.judge),
    inherited: raw.inherited === true,
    samples: Array.isArray(raw.samples)
      ? raw.samples.slice(0, LIMITS.maxJudgeSamples).map((entry) => publicOptionRoute(entry))
      : [],
  }
}

/** v2.0 bounded public `scoreStats` (audit/calibration, one decimal). */
function publicScoreStats(raw) {
  if (!isPlainObject(raw)) return null
  const round1 = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null)
  const ci = isPlainObject(raw.ci95) ? raw.ci95 : {}
  return {
    n: Number.isInteger(raw.n) && raw.n >= 0 ? Math.min(1000, raw.n) : 0,
    mean: round1(raw.mean),
    median: round1(raw.median),
    stdev: round1(raw.stdev),
    min: round1(raw.min),
    max: round1(raw.max),
    ci95: { low: round1(ci.low), high: round1(ci.high) },
  }
}

function publicRound(round) {
  return {
    n: round.n,
    status: round.status,
    startedAt: round.startedAt,
    finishedAt: round.finishedAt,
    error: round.error,
    shots: round.shots.map(publicShot).filter(Boolean),
    attack: round.attack,
    score: round.score,
    // v2.0: bounded multi-judge statistics for the UI/calibration reports.
    scoreStats: publicScoreStats(round.score?.scoreStats),
    gate: round.gate,
    timings: round.timings,
    // v1.2: compact evidence summary for the (v1.3) panel; null for legacy rounds.
    evidence: Array.isArray(round.evidence) ? round.evidence.map(publicEvidenceCard).filter(Boolean) : null,
    // v1.3 UI: bounded audit fields (no prompt text, no raw output, no absolute paths).
    profile: PROFILES.includes(round.profile) ? round.profile : null,
    rubricVersion: typeof round.rubricVersion === 'string' ? round.rubricVersion.slice(0, 32) : null,
    modelRoute: publicModelRoute(round.modelRoute),
    attackerSessionId: typeof round.attackerSessionId === 'string' ? round.attackerSessionId.slice(0, 128) : null,
    judgeSessionIds: (Array.isArray(round.judgeSessionIds) ? round.judgeSessionIds : [])
      .filter((id) => typeof id === 'string' && id !== '')
      .slice(0, 3)
      .map((id) => id.slice(0, 128)),
    judges: (Array.isArray(round.judges) ? round.judges : []).slice(0, 3).map((judge) => ({
      index: Number.isInteger(judge?.index) ? judge.index : 0,
      sessionId: typeof judge?.sessionId === 'string' ? judge.sessionId.slice(0, 128) : null,
      score: typeof judge?.score === 'number' && Number.isFinite(judge.score) ? judge.score : null,
      rawScore: typeof judge?.rawScore === 'number' && Number.isFinite(judge.rawScore) ? judge.rawScore : null,
      verdict: typeof judge?.verdict === 'string' ? judge.verdict.slice(0, 32) : null,
      mustFixCount: Array.isArray(judge?.mustFix) ? judge.mustFix.length : 0,
      modelRoute: publicOptionRoute(judge?.modelRoute),
    })),
    // v1.3: lifecycle/progress/noise/cost summaries (bounded, no paths/logs).
    mode: ROUND_MODES.includes(round.mode) ? round.mode : 'fresh',
    progress: normalizeProgress(round.progress),
    noise: isPlainObject(round.noise)
      ? {
        rawFindings: Math.max(0, Math.round(numberOr(round.noise.rawFindings, 0))),
        dedupedFindings: Math.max(0, Math.round(numberOr(round.noise.dedupedFindings, 0))),
        suppressed: (Array.isArray(round.noise.suppressed) ? round.noise.suppressed : [])
          .slice(0, LIMITS.maxNoiseSuppressed)
          .map((entry) => ({ key: stringOr(entry?.key).slice(0, 300), title: stringOr(entry?.title).slice(0, 200), reason: stringOr(entry?.reason).slice(0, 300) })),
        knownRepeats: Math.max(0, Math.round(numberOr(round.noise.knownRepeats, 0))),
      }
      : null,
    cost: isPlainObject(round.cost) ? { ...round.cost } : null,
    incremental: publicIncremental(round.incremental),
  }
}

/** Public cycle projection used by `GET /adversarial-review/state` (CONTRACT §2.7). */
export function toPublicCycle(cycle) {
  return {
    id: cycle.id,
    target: cycle.target,
    title: cycle.title,
    createdAt: cycle.createdAt,
    updatedAt: cycle.updatedAt,
    status: cycle.status,
    required: cycle.required,
    // v1.3 3.2: reopen lifecycle audit.
    reopenCount: Math.max(0, Math.round(numberOr(cycle.reopenCount, 0))),
    reopenedFrom: typeof cycle.reopenedFrom === 'string' ? cycle.reopenedFrom : null,
    rounds: cycle.rounds.map(publicRound),
  }
}

/** Public state payload for the Web panel; cycles sorted by `updatedAt` desc. */
export function toPublicState(state, options = {}) {
  const { generatedAt = Date.now() } = isPlainObject(options) ? options : {}
  const cycles = isPlainObject(state) && Array.isArray(state.cycles) ? state.cycles : []
  const projected = cycles
    .filter((cycle) => isPlainObject(cycle))
    .map(toPublicCycle)
    .sort((left, right) => right.updatedAt - left.updatedAt)
  return { ok: true, version: 1, generatedAt, cycles: projected }
}

/** Normalize a single path segment (cycle ids for directories). */
function safeSegment(value) {
  const text = stringOr(value)
  return SAFE_CYCLE_ID.test(text) ? text : text.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
}

/**
 * Create the state store.
 *
 * All mutations are synchronous callbacks applied in queue order, then persisted
 * through one serialized atomic write. Persistence failures are recorded on
 * `lastWriteError` instead of rejecting the whole review round (the Host must
 * never crash because a disk write failed).
 */
export function createStore(options = {}) {
  const {
    stateDir,
    now = Date.now,
    fsImpl = fs,
    maxCycles = LIMITS.maxCycles,
    maxRoundsPerCycle = LIMITS.maxRoundsPerCycle,
  } = isPlainObject(options) ? options : {}
  if (typeof stateDir !== 'string' || stateDir.trim() === '') throw new Error('createStore 需要 stateDir')

  const dir = path.resolve(stateDir)
  const statePath = path.join(dir, 'state.json')
  let state = createEmptyState(now())
  let loaded = false
  let initPromise = null
  let queue = Promise.resolve()
  let tmpCounter = 0
  let lastWriteError = null
  let lastReadError = null
  // v1.1 1.4 integrity chain state.
  let lastIntegrityHash = null
  let integrityVerified = false
  let lastIntegrityError = null
  // v1.3 3.0 state schema migration diagnostics.
  let lastMigrationBackup = null

  function enqueue(task) {
    const run = queue.then(task)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  async function quarantine() {
    try {
      const stamp = new Date(numberOr(now(), Date.now())).toISOString().replace(/[:.]/g, '-')
      let suffix = 0
      let backupPath = `${statePath}.corrupt-${stamp}`
      // Never clobber an existing quarantine file.
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          await fsImpl.access(backupPath)
          suffix += 1
          backupPath = `${statePath}.corrupt-${stamp}-${suffix}`
        } catch (error) {
          if (error?.code === 'ENOENT') break
          break
        }
      }
      await fsImpl.rename(statePath, backupPath)
    } catch (error) {
      lastReadError = error instanceof Error ? error : new Error(String(error))
    }
  }

  /**
   * v1.3 3.0: copy the pre-migration state file to `state.json.pre-v3-<ts>`
   * (suffix on collisions). Best effort: a backup failure is recorded but the
   * already-validated in-memory migration still proceeds.
   */
  async function backupPreV3() {
    try {
      const stamp = new Date(numberOr(now(), Date.now())).toISOString().replace(/[:.]/g, '-')
      let suffix = 0
      let backupPath = `${statePath}.pre-v3-${stamp}`
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          await fsImpl.access(backupPath)
          suffix += 1
          backupPath = `${statePath}.pre-v3-${stamp}-${suffix}`
        } catch (error) {
          if (error?.code === 'ENOENT') break
          break
        }
      }
      if (typeof fsImpl.copyFile === 'function') {
        await fsImpl.copyFile(statePath, backupPath)
      } else {
        const raw = await fsImpl.readFile(statePath)
        await fsImpl.writeFile(backupPath, raw)
      }
      lastMigrationBackup = backupPath
      return backupPath
    } catch (error) {
      lastReadError = error instanceof Error ? error : new Error(String(error))
      lastMigrationBackup = null
      return null
    }
  }

  async function loadInternal() {
    let raw = null
    try {
      raw = await fsImpl.readFile(statePath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') lastReadError = error instanceof Error ? error : new Error(String(error))
      raw = null
    }
    if (raw === null) {
      state = createEmptyState(now())
      loaded = true
      return state
    }
    let parsed = null
    try {
      parsed = JSON.parse(stripBom(raw))
    } catch {
      parsed = null
    }
    const legacyVersion = parsed !== null && isPlainObject(parsed) ? parsed.schemaVersion : undefined
    // v1.3 3.0: accepted on-disk versions are 1 (10-point), 2 (100-point) and
    // 3 (current). Anything else is quarantined exactly like corrupt JSON.
    const acceptedVersion = legacyVersion === 1 || legacyVersion === 2 || legacyVersion === STATE_SCHEMA_VERSION
    if (!isPlainObject(parsed) || !Array.isArray(parsed.cycles) || !acceptedVersion) {
      await quarantine()
      state = createEmptyState(now())
      loaded = true
      return state
    }
    // v1.1 1.4: verify the integrity seal BEFORE trusting anything else.
    // A seal that exists but does not match is treated exactly like corrupt
    // JSON (quarantine + empty state); a legacy state without a seal is
    // accepted and gets sealed on the next write.
    if (legacyVersion !== 1) {
      const verified = verifyIntegrity(parsed)
      if (verified.status === 'mismatch' || verified.status === 'invalid') {
        lastIntegrityError = new Error(verified.error || 'state.json 完整性校验失败')
        await quarantine()
        state = createEmptyState(now())
        loaded = true
        return state
      }
      if (verified.status === 'ok') {
        lastIntegrityHash = verified.hash
        integrityVerified = true
      }
    }
    if (legacyVersion === 1) {
      // v1 = 10-point rubric with pass line 9. Migrate in memory, re-derive the
      // gates from the ×10 score and real shot count, then persist as the
      // current schema (backup kept as `state.json.pre-v3-<ts>`).
      state = normalizeState(migrateStateV1(parsed, now()), now())
      trimState(state, { maxCycles, maxRoundsPerCycle })
      recomputeMigratedGates(state)
      loaded = true
      await backupPreV3()
      state.updatedAt = now()
      try {
        await persist()
      } catch (error) {
        // The migrated in-memory state is still valid; retry on the next write.
        lastWriteError = error instanceof Error ? error : new Error(String(error))
      }
      return state
    }
    if (legacyVersion === 2) {
      // v1.2 → v1.3: additive migration (reopen lifecycle fields); the state is
      // backed up before the re-sealed v3 document is written.
      state = normalizeState(migrateStateV2(parsed, now()), now())
      trimState(state, { maxCycles, maxRoundsPerCycle })
      loaded = true
      await backupPreV3()
      state.updatedAt = now()
      try {
        await persist()
      } catch (error) {
        lastWriteError = error instanceof Error ? error : new Error(String(error))
      }
      return state
    }
    state = normalizeState(parsed, now())
    trimState(state, { maxCycles, maxRoundsPerCycle })
    loaded = true
    return state
  }

  function init() {
    if (loaded) return Promise.resolve(state)
    if (initPromise === null) {
      initPromise = enqueue(loadInternal).then(
        (value) => value,
        (error) => {
          lastReadError = error instanceof Error ? error : new Error(String(error))
          state = createEmptyState(now())
          loaded = true
          return state
        },
      )
    }
    return initPromise
  }

  async function persist() {
    // The seal must never be part of the hashed document.
    delete state.integrity
    // Reserve room for the integrity record (~200 bytes) so a document that is
    // exactly at the limit still fits after sealing.
    const sealReserve = 512
    let payload = JSON.stringify(state)
    if (Buffer.byteLength(payload, 'utf8') + sealReserve > LIMITS.maxStateBytes) {
      if (!fitStateToLimit(state, LIMITS.maxStateBytes - sealReserve)) {
        throw new Error('状态文件超过 8MB 上限，无法持久化本轮状态')
      }
      payload = JSON.stringify(state)
    }
    // v1.1 1.4: seal the document with a sha256 hash chain before writing.
    state.integrity = createIntegrityRecord(state, lastIntegrityHash)
    payload = JSON.stringify(state)
    if (Buffer.byteLength(payload, 'utf8') > LIMITS.maxStateBytes) {
      // Defensive second pass: trim, re-seal, write.
      delete state.integrity
      if (!fitStateToLimit(state, LIMITS.maxStateBytes - sealReserve)) {
        throw new Error('状态文件超过 8MB 上限，无法持久化本轮状态')
      }
      state.integrity = createIntegrityRecord(state, lastIntegrityHash)
      payload = JSON.stringify(state)
    }
    await fsImpl.mkdir(dir, { recursive: true })
    tmpCounter += 1
    const tmpPath = path.join(dir, `state.json.tmp-${process.pid}-${tmpCounter}`)
    await fsImpl.writeFile(tmpPath, payload, 'utf8')
    try {
      await fsImpl.rename(tmpPath, statePath)
    } catch (error) {
      try {
        await fsImpl.unlink(tmpPath)
      } catch {
        // best effort cleanup only
      }
      throw error
    }
    lastIntegrityHash = state.integrity.hash
    integrityVerified = true
    lastIntegrityError = null
  }

  /**
   * Apply one synchronous mutation and persist it. Resolves to the mutation's
   * return value; a persistence failure is exposed through `lastWriteError`.
   */
  async function mutate(mutator) {
    if (typeof mutator !== 'function') throw new Error('store.mutate 需要函数')
    await init()
    return enqueue(async () => {
      const result = mutator(state)
      state.updatedAt = now()
      trimState(state, { maxCycles, maxRoundsPerCycle })
      try {
        await persist()
      } catch (error) {
        lastWriteError = error instanceof Error ? error : new Error(String(error))
      }
      return result
    })
  }

  return {
    get state() {
      return state
    },
    get stateDir() {
      return dir
    },
    get statePath() {
      return statePath
    },
    get lastWriteError() {
      return lastWriteError
    },
    get lastReadError() {
      return lastReadError
    },
    /** v1.1 1.4: true when the loaded/last-written document carried a valid seal. */
    get integrityVerified() {
      return integrityVerified
    },
    /** v1.1 1.4: null, or the Error explaining why the seal was rejected. */
    get lastIntegrityError() {
      return lastIntegrityError
    },
    /** Hash of the last persisted document (used to extend the chain). */
    get lastIntegrityHash() {
      return lastIntegrityHash
    },
    /** v1.3 3.0: path of the `state.json.pre-v3-<ts>` migration backup, if any. */
    get lastMigrationBackup() {
      return lastMigrationBackup
    },
    integrity() {
      return {
        verified: integrityVerified,
        hash: lastIntegrityHash,
        error: lastIntegrityError === null ? null : (lastIntegrityError.message || String(lastIntegrityError)),
      }
    },
    init,
    mutate,
    isLoaded: () => loaded,
    /** Synchronous snapshot for the tool guard; null until the first load. */
    peek: () => (loaded ? state : null),
    async flush() {
      await init()
      await queue
    },
    shotsDir(cycleId) {
      return path.join(dir, 'shots', safeSegment(cycleId))
    },
    /** v1.3 3.2: persisted snapshot file lists live under `<stateDir>/snapshots/`. */
    snapshotsDir(cycleId) {
      return path.join(dir, 'snapshots', safeSegment(cycleId))
    },
    tmpDir() {
      return path.join(dir, 'tmp')
    },
    findCycle(target) {
      return findCycleByTarget(state, target)
    },
    findCycleById(id) {
      return findCycleById(state, id)
    },
    findReviewingForSession(sessionId) {
      return findReviewingCycleForSession(state, sessionId)
    },
    latestRound(cycle) {
      return latestRoundOf(cycle)
    },
  }
}
