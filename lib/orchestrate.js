/**
 * One adversarial-review round (CONTRACT.md §2.3).
 *
 * Pipeline: validate args → resolve target → find/create cycle + round →
 * render 4 evidence screenshots → red-team child (fresh) → judge child (fresh,
 * sees only the red-team report) → report-page screenshots when there is no UI
 * → stop gate → persist → compact result.
 *
 * The exported `runReviewRound` NEVER throws: every failure becomes
 * `{ok:false, stage, error}` and marks the round failed on disk.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ATTACK_SCHEMA,
  EVIDENCE_KINDS,
  LIMITS,
  PROFILE_RUBRICS,
  PROFILES,
  ROUND_MODES,
  SCORE_SCHEMA,
  TOOL_ROUND,
} from './constants.js'
import {
  buildCompactEvidence,
  buildEvidenceFromShots,
  buildEvidenceManifest,
  normalizeEvidenceCards,
  renderEvidenceCards,
  verifyEvidenceArtifacts,
} from './evidence.js'
import {
  countKnownRepeats,
  dedupeFindings,
  dedupeMustFix,
  findingKey,
  knownFindingsFromRound,
} from './noise.js'
import { clearCancel, isCancelRequested, setRoundProgress } from './progress.js'
import { buildAttackerPrompt, buildJudgePrompt } from './prompts.js'
import { redactValueWithStats } from './redact.js'
import {
  aggregateJudgeScores,
  computeGate,
  countSupportedFindings,
  extractJson,
  isPlainObject,
  truncateText,
  validateAttack,
  validateScore,
} from './rubric.js'
import { renderReportPages } from './report.js'
import { lookupReviewChild, registerReviewChild, unregisterReviewChild } from './review-registry.js'
import { computeSnapshot, findGitCommit } from './snapshot.js'
import {
  buildDefaultSpecs,
  detectEntryFile,
  normalizeSpecs,
  renderShots as defaultRenderShots,
  verifyRoundShotFiles,
  writeReportHtml,
} from './shots.js'
import {
  createCycle,
  cycleDeliverableRoot,
  findCycleByTarget,
  findCyclesByDeliverableRoot,
  isPathInsideOrEqual,
  latestPassedRound,
  latestRoundOf,
  normalizeTargetPath,
  startRound,
  targetKey,
} from './store.js'

const RAW_EXCERPT_CHARS = 4000
/** Per-sample judge raw snippet persisted in `round.judges[]` (v1.1 audit). */
const JUDGE_RAW_SNIPPET_CHARS = 2000
const PROVIDER_FALLBACK_NAMES = Object.freeze(['spawn'])
/** Host package root (for `rubrics/<profile>.md`). */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** v1.2 2.3a: domain profile of a round (`code` fallback for legacy config). */
export function normalizeProfile(value) {
  return PROFILES.includes(value) ? value : 'code'
}

/**
 * Read the Host-trusted rubric for a domain profile. `override` exists only for
 * tests; a configured profile whose rubric file is missing fails the round with
 * a structured error (never silently reviews with the wrong rubric).
 * @returns {Promise<string>} rubric markdown ('' when the profile has none)
 */
export async function loadProfileRubric(profile, options = {}) {
  const {
    fsImpl = fs,
    packageRoot = PACKAGE_ROOT,
    override = null,
    maxChars = 30_000,
  } = isPlainObject(options) ? options : {}
  if (typeof override === 'string') return truncateText(override, maxChars)
  const relative = PROFILE_RUBRICS[normalizeProfile(profile)]
  if (typeof relative !== 'string' || relative === '') return ''
  try {
    const text = await fsImpl.readFile(path.join(packageRoot, relative), 'utf8')
    return truncateText(String(text ?? '').trim(), maxChars)
  } catch (error) {
    throw new ReviewError('internal', `读取领域 rubric 失败（${relative}）：${error?.message || error}`)
  }
}

/** v1.3 3.2: per-call lifecycle mode (`fresh` keeps the pre-v1.3 behaviour). */
export function normalizeMode(value) {
  return ROUND_MODES.includes(value) ? value : 'fresh'
}

/** Character length of a value's JSON-ish text (bounded, never throws). */
function textChars(value) {
  try {
    if (typeof value === 'string') return value.length
    return JSON.stringify(value ?? null)?.length ?? 0
  } catch {
    return 0
  }
}

function numberOrLocal(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** True when the cycle's latest round passed the gate (legacy status fallback). */
function cycleIsPassed(cycle) {
  if (!isPlainObject(cycle)) return false
  const round = latestRoundOf(cycle)
  if (round !== null && isPlainObject(round.gate)) return round.gate.passed === true
  return cycle.status === 'passed'
}

const SNAPSHOT_FILE_RELATIVE = /^snapshots\/[A-Za-z0-9._-]{1,80}\/r\d{1,4}\.json$/

/**
 * Persist one round's snapshot file list to `<stateDir>/snapshots/<cycleId>/r<N>.json`.
 * The review state only stores the *relative* path (`round.snapshot.filesFile`).
 * @returns {Promise<string|null>} relative path, or null on failure
 */
export async function writeSnapshotFileList(options = {}) {
  const { stateDir, cycleId, roundNo, snapshot, fsImpl = fs, maxBytes = LIMITS.maxStateBytes } = isPlainObject(options) ? options : {}
  if (typeof stateDir !== 'string' || stateDir === '') return null
  if (typeof cycleId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(cycleId)) return null
  if (!Number.isInteger(roundNo) || roundNo <= 0) return null
  const files = Array.isArray(snapshot?.files) ? snapshot.files : []
  if (files.length === 0) return null
  const payload = JSON.stringify({
    schemaVersion: 1,
    manifestHash: typeof snapshot?.manifestHash === 'string' ? snapshot.manifestHash : '',
    round: roundNo,
    files,
  })
  if (Buffer.byteLength(payload, 'utf8') > maxBytes) return null
  try {
    const dir = path.join(path.resolve(stateDir), 'snapshots', cycleId)
    await fsImpl.mkdir(dir, { recursive: true })
    await fsImpl.writeFile(path.join(dir, `r${roundNo}.json`), payload, 'utf8')
    return `snapshots/${cycleId}/r${roundNo}.json`
  } catch {
    return null
  }
}

/** Read one persisted snapshot file list; null when missing/broken. */
export async function readSnapshotFileList(options = {}) {
  const { stateDir, filesFile, fsImpl = fs } = isPlainObject(options) ? options : {}
  if (typeof stateDir !== 'string' || stateDir === '') return null
  if (typeof filesFile !== 'string' || !SNAPSHOT_FILE_RELATIVE.test(filesFile)) return null
  try {
    const text = await fsImpl.readFile(path.join(path.resolve(stateDir), ...filesFile.split('/')), 'utf8')
    const parsed = JSON.parse(text)
    if (!isPlainObject(parsed) || !Array.isArray(parsed.files)) return null
    return parsed.files.filter(isPlainObject)
  } catch {
    return null
  }
}

/**
 * Diff two snapshot file lists. A file is "changed" when its content hash differs
 * (or, for legacy/skipped entries, its size/mtime differs).
 * @returns {{changedFiles: string[], addedFiles: string[], removedFiles: string[], truncated: boolean, unchangedCount: number}}
 */
export function diffSnapshotFiles(baseFiles, currentFiles, options = {}) {
  const maxEntries = Number.isInteger(options.maxChangedFiles) && options.maxChangedFiles > 0
    ? Math.min(LIMITS.maxIncrementalFilesStored, options.maxChangedFiles)
    : 200
  const base = new Map()
  for (const file of Array.isArray(baseFiles) ? baseFiles : []) {
    if (isPlainObject(file) && typeof file.path === 'string') base.set(file.path, file)
  }
  const current = new Map()
  for (const file of Array.isArray(currentFiles) ? currentFiles : []) {
    if (isPlainObject(file) && typeof file.path === 'string') current.set(file.path, file)
  }
  const changed = []
  const added = []
  const removed = []
  let unchangedCount = 0
  for (const [filePath, file] of current) {
    const previous = base.get(filePath)
    if (previous === undefined) {
      added.push(filePath)
      continue
    }
    const previousHash = typeof previous.sha256 === 'string' ? previous.sha256 : null
    const currentHash = typeof file.sha256 === 'string' ? file.sha256 : null
    const different = previousHash !== null && currentHash !== null
      ? previousHash !== currentHash
      : (previous.size !== file.size || previous.mtimeMs !== file.mtimeMs)
    if (different) changed.push(filePath)
    else unchangedCount += 1
  }
  for (const [filePath] of base) {
    if (!current.has(filePath)) removed.push(filePath)
  }
  const sort = (list) => list.sort((left, right) => left.localeCompare(right))
  sort(changed)
  sort(added)
  sort(removed)
  let remaining = maxEntries
  const take = (list) => {
    const slice = list.slice(0, Math.max(0, remaining))
    remaining -= slice.length
    return slice
  }
  const out = {
    changedFiles: take(changed),
    addedFiles: take(added),
    removedFiles: take(removed),
    truncated: changed.length + added.length + removed.length > maxEntries,
    unchangedCount,
  }
  return out
}

/** Structured stage error; `stage` is what the tool result reports. */
export class ReviewError extends Error {
  constructor(stage, message, options = {}) {
    super(typeof message === 'string' && message !== '' ? message : '未知错误')
    this.name = 'ReviewError'
    this.stage = typeof stage === 'string' && stage !== '' ? stage : 'internal'
    this.raw = typeof options?.raw === 'string' && options.raw !== '' ? options.raw : null
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

// ---------------------------------------------------------------------------
// v1.1 1.3: deliverable-root binding + per-root concurrency lock
// ---------------------------------------------------------------------------

/**
 * Resolve which declared deliverable root a review target belongs to.
 *
 * - `deliverableRoots` empty → the target itself is its deliverable root.
 * - otherwise the target must equal or live inside one declared root; the most
 *   specific (longest) matching root wins. A sub-directory can therefore never
 *   become an independent "deliverable" when a broader root is declared.
 *
 * @param {string} targetDir resolved target directory
 * @param {string[]} deliverableRoots config `deliverableRoots`
 * @returns {string} absolute deliverable root
 * @throws {ReviewError} stage `arguments` when the target is outside every root
 */
export function resolveDeliverableRoot(targetDir, deliverableRoots) {
  const target = normalizeTargetPath(targetDir)
  if (target === '') throw new ReviewError('arguments', '无法解析评审 target 路径')
  const roots = Array.isArray(deliverableRoots)
    ? deliverableRoots.map((root) => normalizeTargetPath(root)).filter((root) => root !== '')
    : []
  if (roots.length === 0) return target
  let best = ''
  for (const root of roots) {
    if (!isPathInsideOrEqual(root, target)) continue
    if (root.length > best.length) best = root
  }
  if (best === '') {
    throw new ReviewError(
      'arguments',
      `target「${target}」不在已声明的交付根（deliverableRoots）内：${roots.join('、')}。请把被评审项目放在交付根内，或直接以交付根作为 target。`,
    )
  }
  return best
}

/** Module-level in-flight round slots, one per deliverable root (B-15). */
const activeRoundLocks = new Map()

/**
 * Try to acquire the single in-flight round slot for a deliverable root.
 * @returns {object|null} lock record, or null when the root is already busy
 */
export function acquireRoundLock(root, info = {}) {
  const key = targetKey(root)
  if (key === '') return null
  if (activeRoundLocks.has(key)) return null
  const lock = {
    rootKey: key,
    deliverableRoot: normalizeTargetPath(root),
    cycleId: typeof info?.cycleId === 'string' ? info.cycleId : null,
    round: Number.isInteger(info?.round) ? info.round : null,
    startedAt: Number.isFinite(info?.startedAt) ? info.startedAt : Date.now(),
  }
  activeRoundLocks.set(key, lock)
  return lock
}

/** Release the round slot for a deliverable root (always called in `finally`). */
export function releaseRoundLock(root) {
  const key = targetKey(root)
  if (key !== '') activeRoundLocks.delete(key)
}

/** Copy of the current lock for a deliverable root (diagnostics/tests). */
export function describeRoundLock(root) {
  const key = targetKey(root)
  if (key === '') return null
  const lock = activeRoundLocks.get(key)
  return lock === undefined ? null : { ...lock }
}

/** Clear every in-flight lock (unit-test helper only). */
export function __resetRoundLocks() {
  activeRoundLocks.clear()
}

function busyRoundResult(deliverableRoot) {
  const holder = describeRoundLock(deliverableRoot)
  const detail = holder === null
    ? ''
    : `（进行中：cycle ${holder.cycleId || '—'}，第 ${holder.round ?? '—'} 轮）`
  return {
    ok: false,
    stage: 'busy',
    error: `该交付根「${deliverableRoot}」已有评审轮次进行中${detail}，请等待其结束后再重试；并发评审会破坏证据与快照的一致性。`,
  }
}

function optionalText(value, maxChars, warnings, label) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    warnings.push(`${label} 不是字符串，已忽略`)
    return ''
  }
  return truncateText(value.trim(), maxChars)
}

function formatSeconds(milliseconds) {
  const seconds = milliseconds / 1000
  return Number.isInteger(seconds) ? String(seconds) : String(Math.round(seconds * 100) / 100)
}

function stringArrayField(value, { maxItems, maxChars, warnings, label }) {
  if (value === undefined || value === null) return []
  const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : null
  if (items === null) throw new ReviewError('arguments', `${label} 必须是字符串数组`)
  if (!Array.isArray(value) && typeof value === 'string') warnings.push(`${label} 收到单个字符串，已按一项处理`)
  const out = []
  for (const item of items) {
    if (out.length >= maxItems) break
    if (typeof item !== 'string') {
      warnings.push(`${label} 含有非字符串条目，已忽略`)
      continue
    }
    const text = truncateText(item.trim(), maxChars)
    if (text !== '') out.push(text)
  }
  return out
}

/**
 * Self-contained validation/normalization of the round tool arguments.
 * Throws `ReviewError` with stage `arguments` on invalid input.
 */
export function validateRoundArgs(args, config = {}) {
  const warnings = []
  if (!isPlainObject(args)) throw new ReviewError('arguments', '参数必须是对象')
  if (typeof args.target !== 'string' || args.target.trim() === '') {
    throw new ReviewError('arguments', '参数 target 必填：被评审项目的绝对路径（也允许相对调用方工作目录的路径）')
  }
  const target = args.target.trim()
  if (target.length > 1000) throw new ReviewError('arguments', '参数 target 过长（超过 1000 字符）')

  const title = optionalText(args.title, 300, warnings, 'title')
  // v1.2 2.3a: per-call domain profile override (config.profile is the default).
  let profile = null
  if (args.profile !== undefined && args.profile !== null) {
    if (typeof args.profile !== 'string' || !PROFILES.includes(args.profile.trim())) {
      throw new ReviewError('arguments', `参数 profile 只支持 ${PROFILES.join(' | ')}（收到 ${String(args.profile)}）`)
    }
    profile = args.profile.trim()
  }
  const claims = stringArrayField(args.claims, { maxItems: 30, maxChars: 2000, warnings, label: 'claims' })
  const focus = stringArrayField(args.focus, { maxItems: 30, maxChars: 500, warnings, label: 'focus' })
  const outOfScope = optionalText(args.outOfScope, 4000, warnings, 'outOfScope')
  const environment = optionalText(args.environment, 4000, warnings, 'environment')
  const timeBudget = optionalText(args.timeBudget, 200, warnings, 'timeBudget')
  // v1.3 3.2: lifecycle mode (`fresh` default; reopen/incremental require a
  // previously passed cycle for the same target).
  let mode = 'fresh'
  if (args.mode !== undefined && args.mode !== null) {
    if (typeof args.mode !== 'string' || !ROUND_MODES.includes(args.mode.trim())) {
      throw new ReviewError('arguments', `参数 mode 只支持 ${ROUND_MODES.join(' | ')}（收到 ${String(args.mode)}）`)
    }
    mode = args.mode.trim()
  }

  const requiredShots = Number.isInteger(config?.requiredShots) && config.requiredShots > 0 ? config.requiredShots : 4
  let shots = []
  if (args.shots !== undefined && args.shots !== null) {
    if (!Array.isArray(args.shots)) {
      throw new ReviewError('arguments', '参数 shots 必须是数组，每个元素提供 path 或 url（恰好 4 个）')
    }
    if (args.shots.length > 0) {
      if (args.shots.length !== requiredShots) {
        throw new ReviewError('arguments', `参数 shots 必须恰好 ${requiredShots} 个（本次收到 ${args.shots.length} 个）；留空则由工具自动探测页面并渲染 ${requiredShots} 张`)
      }
      shots = args.shots
    }
  }
  // v1.2 2.1: `evidence` (4 evidence cards) is mutually exclusive with `shots`.
  // Detailed card validation happens after the target is resolved (paths/URLs
  // need the target root and the allowedOrigins config); here we only enforce
  // the shape and the exclusivity so a bad call is rejected before any state
  // is created.
  let evidence = []
  if (args.evidence !== undefined && args.evidence !== null) {
    if (!Array.isArray(args.evidence)) {
      throw new ReviewError('arguments', `参数 evidence 必须是数组（恰好 4 个证据卡，每卡 kind=${EVIDENCE_KINDS.join('|')}）`)
    }
    if (args.evidence.length > 0) {
      if (shots.length > 0) {
        throw new ReviewError('arguments', '参数 evidence 与 shots 互斥：同一轮只能提供其中一种证据规格（evidence 卡或旧 shots 数组）')
      }
      if (args.evidence.length !== requiredShots) {
        throw new ReviewError('arguments', `证据卡必须恰好 ${requiredShots} 个（本次收到 ${args.evidence.length} 个）`)
      }
      for (const card of args.evidence) {
        if (!isPlainObject(card)) throw new ReviewError('arguments', '每个证据卡必须是对象（kind 为 screenshot / interaction / image / pdf-text）')
      }
      evidence = args.evidence
    }
  }
  return { target, title, claims, focus, outOfScope, environment, timeBudget, shots, evidence, profile, mode, warnings }
}

/** Resolve a caller-supplied target path (absolute, or relative to the caller cwd) and prove it is a directory. */
export async function resolveTargetDir(rawTarget, options = {}) {
  const {
    workingDirectory = null,
    agent = null,
    fallbackCwd = process.cwd(),
    fsImpl = fs,
  } = isPlainObject(options) ? options : {}
  const target = typeof rawTarget === 'string' ? rawTarget.trim() : ''
  if (target === '') throw new ReviewError('target', 'target 不能为空')
  let base = typeof fallbackCwd === 'string' && fallbackCwd !== '' ? fallbackCwd : process.cwd()
  if (!path.isAbsolute(target) && workingDirectory !== null) {
    try {
      if (typeof workingDirectory.ensure === 'function' && agent !== null) {
        const ensured = await workingDirectory.ensure(agent)
        if (typeof ensured === 'string' && ensured !== '') base = ensured
      } else if (typeof workingDirectory.defaultDirectory === 'string' && workingDirectory.defaultDirectory !== '') {
        base = workingDirectory.defaultDirectory
      }
    } catch {
      // Fall back to process.cwd() when the caller directory cannot be resolved.
    }
  }
  let resolved = ''
  try {
    resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(base, target)
  } catch (error) {
    throw new ReviewError('target', `无法解析 target 路径：${target}`, { cause: error })
  }
  let stat = null
  try {
    stat = await fsImpl.stat(resolved)
  } catch (error) {
    throw new ReviewError('target', `target 目录不可访问：${resolved}（${error?.code || error?.message || error}）`, { cause: error })
  }
  if (!stat || typeof stat.isDirectory !== 'function' || !stat.isDirectory()) {
    throw new ReviewError('target', `target 不是目录：${resolved}`)
  }
  return resolved
}

function listProviderNames(subagents) {
  try {
    const names = typeof subagents?.list === 'function' ? subagents.list() : []
    return Array.isArray(names) && names.length > 0 ? names.join('、') : '无'
  } catch {
    return '未知'
  }
}

/**
 * Resilient provider selection: configured name → `spawn` → any registered
 * provider that advertises presets or structured output.
 */
export function pickSubagentProvider(subagents, wanted) {
  try {
    if (!subagents || typeof subagents.getProvider !== 'function') return null
    const preferred = typeof wanted === 'string' && wanted !== '' ? wanted : ''
    if (preferred !== '') {
      const provider = subagents.getProvider(preferred)
      if (provider && typeof provider.name === 'string' && provider.name !== '') return provider
    }
    for (const name of PROVIDER_FALLBACK_NAMES) {
      const provider = subagents.getProvider(name)
      if (provider && typeof provider.name === 'string' && provider.name !== '') return provider
    }
    const names = typeof subagents.list === 'function' ? subagents.list() : []
    if (!Array.isArray(names)) return null
    for (const name of names) {
      if (typeof name !== 'string') continue
      const provider = subagents.getProvider(name)
      if (!provider) continue
      const capabilities = isPlainObject(provider.capabilities) ? provider.capabilities : {}
      if (capabilities.agentPreset === true || capabilities.outputSchema === true) return provider
    }
    return null
  } catch {
    return null
  }
}

/** Concatenate every textual content block of a subagent result. */
function contentText(result) {
  if (!isPlainObject(result) || !Array.isArray(result.output)) return ''
  const parts = []
  for (const block of result.output) {
    if (isPlainObject(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

function rawExcerpt(result, maxChars = RAW_EXCERPT_CHARS) {
  const text = contentText(result)
  if (text !== '') return truncateText(text, maxChars)
  try {
    return truncateText(JSON.stringify(isPlainObject(result) ? (result.structured ?? result.output ?? null) : null), maxChars)
  } catch {
    return ''
  }
}

/** sha256 hex of a prompt text, stored on the round for audit/reproducibility. */
export function hashPromptText(text) {
  return createHash('sha256').update(typeof text === 'string' ? text : '', 'utf8').digest('hex')
}

/** Clamp `judgeSamples` to 1..LIMITS.maxJudgeSamples (missing/invalid → 2). */
export function normalizeJudgeSamples(value) {
  if (!Number.isInteger(value)) return 2
  return Math.min(LIMITS.maxJudgeSamples, Math.max(1, value))
}

function configRouteValue(config, key) {
  const value = isPlainObject(config) ? config[key] : ''
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Resolve the optional child model routes from config + provider capabilities.
 *
 * A route is only "requested" when the provider advertises `agentOptions`;
 * otherwise the configured values are dropped, a warning is recorded, and the
 * children inherit the parent route (the pre-v1.1 behaviour).
 */
export function resolveModelRoutes(config, caps, providerName = '') {
  const warnings = []
  const pick = (providerKey, modelKey, effortKey, roleLabel) => {
    const route = {}
    const provider = configRouteValue(config, providerKey)
    const model = configRouteValue(config, modelKey)
    const reasoningEffort = configRouteValue(config, effortKey)
    if (provider !== '') route.provider = provider
    if (model !== '') route.model = model
    if (reasoningEffort !== '') route.reasoningEffort = reasoningEffort
    if (Object.keys(route).length === 0) return null
    if (caps?.agentOptions !== true) {
      warnings.push(`provider「${providerName || '未知'}」不支持 agentOptions：${roleLabel}模型路由（${Object.keys(route).join('/')}）未生效，改用继承路由`)
      return null
    }
    return route
  }
  const attacker = pick('attackerProvider', 'attackerModel', 'attackerReasoningEffort', '红队')
  const judge = pick('judgeProvider', 'judgeModel', 'judgeReasoningEffort', '判官')
  return { attacker, judge, inherited: attacker === null && judge === null, warnings }
}

function readRouteFromConfig(config, providerKey, modelKey, effortKey) {
  const route = {}
  const provider = configRouteValue(config, providerKey)
  const model = configRouteValue(config, modelKey)
  const reasoningEffort = configRouteValue(config, effortKey)
  if (provider !== '') route.provider = provider
  if (model !== '') route.model = model
  if (reasoningEffort !== '') route.reasoningEffort = reasoningEffort
  return Object.keys(route).length === 0 ? null : route
}

const MODEL_ROUTE_FIELDS = Object.freeze(['provider', 'model', 'reasoningEffort'])

function mergeRoute(base, entry) {
  const route = base === null ? {} : { ...base }
  if (isPlainObject(entry)) {
    for (const key of MODEL_ROUTE_FIELDS) {
      const value = typeof entry[key] === 'string' ? entry[key].trim() : ''
      if (value !== '') route[key] = value
    }
  }
  return Object.keys(route).length === 0 ? null : route
}

/**
 * v2.0 Stage A: per-judge-sample model routes.
 *
 * `config.judgeModels[i]` overrides the default judge route for sample i;
 * samples without an entry inherit the default route. Extra entries are
 * ignored with a warning, and providers without `agentOptions` keep the
 * existing "inherit + warn" degradation (no routes requested).
 *
 * @returns {{samples: Array<object|null>, warnings: string[], configuredCount: number}}
 */
export function resolveJudgeSampleRoutes(options = {}) {
  const settings = isPlainObject(options) ? options : {}
  const { config = {}, caps = null, providerName = '' } = settings
  const judgeSamples = Number.isInteger(settings.judgeSamples) && settings.judgeSamples > 0
    ? Math.min(LIMITS.maxJudgeSamples, settings.judgeSamples)
    : normalizeJudgeSamples(config?.judgeSamples)
  const baseEffective = settings.baseJudge === undefined ? null : settings.baseJudge
  const baseRequested = readRouteFromConfig(config, 'judgeProvider', 'judgeModel', 'judgeReasoningEffort')
  const configured = Array.isArray(config?.judgeModels)
    ? config.judgeModels.filter((entry) => isPlainObject(entry)).slice(0, LIMITS.maxJudgeModels)
    : []
  const warnings = []
  if (configured.length > judgeSamples) {
    warnings.push(`judgeModels 配置了 ${configured.length} 个模型路由，但 judgeSamples=${judgeSamples}：忽略后 ${configured.length - judgeSamples} 个。`)
  }
  const samples = []
  let requestedAny = false
  for (let index = 0; index < judgeSamples; index += 1) {
    const entry = index < configured.length ? configured[index] : null
    const requested = mergeRoute(baseEffective, entry)
    requestedAny = requestedAny || requested !== null
    samples.push(caps?.agentOptions === true ? requested : null)
  }
  if (caps?.agentOptions !== true) {
    const configuredAny = configured.some((entry) => MODEL_ROUTE_FIELDS.some((key) => typeof entry[key] === 'string' && entry[key].trim() !== ''))
    // The base judge route warning is already emitted by resolveModelRoutes;
    // only add the sample-specific warning when no base route was requested.
    if (configuredAny && baseRequested === null) {
      warnings.push(`provider「${providerName || '未知'}」不支持 agentOptions：judgeModels 模型路由未生效，改用继承路由`)
    }
  }
  return { samples, warnings, configuredCount: configured.length, requestedAny }
}

/** Parse + validate the red-team child's structured/text result. */
export function parseAttackResult(result) {
  const candidates = []
  if (isPlainObject(result) && isPlainObject(result.structured)) candidates.push(result.structured)
  const text = contentText(result)
  const extracted = extractJson(text)
  if (extracted !== null) candidates.push(extracted)
  let lastError = '红队没有返回可解析的 JSON 对象（需要 verdict / summary / findings / solid / unverified 契约）'
  for (const candidate of candidates) {
    const validation = validateAttack(candidate)
    if (validation.ok) return { attack: validation.attack, warnings: validation.warnings }
    lastError = validation.error
  }
  throw new ReviewError('attacker-parse', candidates.length === 0
    ? lastError
    : `红队 JSON 不符合契约：${lastError}`, { raw: rawExcerpt(result) })
}

/** Parse + validate the judge child's structured/text result. */
export function parseScoreResult(result, options = {}) {
  const candidates = []
  if (isPlainObject(result) && isPlainObject(result.structured)) candidates.push(result.structured)
  const text = contentText(result)
  const extracted = extractJson(text)
  if (extracted !== null) candidates.push(extracted)
  let lastError = '判官没有返回可解析的 JSON 对象（需要 score / verdict / validFindings / mustFix 契约）'
  for (const candidate of candidates) {
    const validation = validateScore(candidate, options)
    if (validation.ok) return { score: validation.score, warnings: validation.warnings }
    lastError = validation.error
  }
  throw new ReviewError('judge-parse', candidates.length === 0
    ? lastError
    : `判官 JSON 不符合契约：${lastError}`, { raw: rawExcerpt(result) })
}

function resolveShotsManifest(shots) {
  if (!Array.isArray(shots)) return []
  return shots
    .filter((shot) => isPlainObject(shot) && typeof shot.file === 'string')
    .map((shot) => {
      const manifest = {
        file: shot.file,
        width: Number.isFinite(shot.width) ? shot.width : 0,
        height: Number.isFinite(shot.height) ? shot.height : 0,
        page: typeof shot.page === 'string' ? shot.page : '',
        url: typeof shot.url === 'string' ? shot.url : '',
      }
      // v1.1 1.5/1.6: the judge treats the Host manifest as the only authority
      // for screenshots, so the content hash travels with it.
      if (typeof shot.sha256 === 'string' && /^[0-9a-f]{64}$/.test(shot.sha256)) manifest.sha256 = shot.sha256
      return manifest
    })
}

function formatScoreNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—'
}

function compactRoute(route) {
  if (!isPlainObject(route)) return null
  const out = {}
  for (const [key, cap] of [['provider', 200], ['model', 200], ['reasoningEffort', 100]]) {
    if (typeof route[key] === 'string' && route[key].trim() !== '') out[key] = route[key].trim().slice(0, cap)
  }
  return Object.keys(out).length === 0 ? null : out
}

/** Bounded `round.modelRoute` projection (attacker/judge + per-sample routes). */
function compactModelRoute(raw) {
  if (!isPlainObject(raw)) return null
  return {
    attacker: compactRoute(raw.attacker),
    judge: compactRoute(raw.judge),
    inherited: raw.inherited === true,
    samples: Array.isArray(raw.samples)
      ? raw.samples.slice(0, LIMITS.maxJudgeSamples).map((route) => compactRoute(route))
      : [],
  }
}

function numberOrNullLocal(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null
}

/** Bounded v2.0 `score.scoreStats` projection (0–100, one decimal). */
function compactScoreStats(raw) {
  if (!isPlainObject(raw)) return null
  const ci = isPlainObject(raw.ci95) ? raw.ci95 : {}
  return {
    n: Number.isInteger(raw.n) && raw.n >= 0 ? raw.n : 0,
    mean: numberOrNullLocal(raw.mean),
    median: numberOrNullLocal(raw.median),
    stdev: numberOrNullLocal(raw.stdev),
    min: numberOrNullLocal(raw.min),
    max: numberOrNullLocal(raw.max),
    ci95: { low: numberOrNullLocal(ci.low), high: numberOrNullLocal(ci.high) },
  }
}

function compactJudge(entry) {
  if (!isPlainObject(entry)) return null
  return {
    index: Number.isInteger(entry.index) && entry.index >= 0 ? entry.index : 0,
    sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : null,
    score: typeof entry.score === 'number' && Number.isFinite(entry.score) ? entry.score : null,
    rawScore: typeof entry.rawScore === 'number' && Number.isFinite(entry.rawScore) ? entry.rawScore : null,
    verdict: typeof entry.verdict === 'string' ? entry.verdict : null,
    mustFixCount: Array.isArray(entry.mustFix) ? entry.mustFix.length : 0,
    modelRoute: compactRoute(entry.modelRoute),
  }
}

/**
 * Compact tool result (CONTRACT.md §2.2). `ok` is true when the round itself
 * completed; the stop decision is `gate.passed` / `nextAction`.
 */
export function buildCompactResult(options = {}) {
  const { cycle, round, warnings = [] } = isPlainObject(options) ? options : {}
  const gate = isPlainObject(round?.gate) ? round.gate : null
  const passed = gate?.passed === true
  const nextAction = passed ? 'stop' : 'fix_and_review'
  const failReasons = Array.isArray(gate?.failReasons) ? gate.failReasons : []
  const message = passed
    ? `已达标（总分 ${formatScoreNumber(gate.score)}/100，有效发现 ${gate.findings} 条，截图 ${gate.shots}/${gate.requiredShots}）。可以停止并交付；本轮评审判定为 PASS。`
    : `未达标：${failReasons.length > 0 ? failReasons.join('；') : '门控未通过'}。请按判官的 mustFix 与扣分项修复项目，然后再次调用 ${TOOL_ROUND}。只有 gate.passed=true 才允许停止/交付。`
  const shots = Array.isArray(round?.shots)
    ? round.shots.map((shot) => ({
      file: shot.file,
      width: shot.width,
      height: shot.height,
      bytes: shot.bytes,
      url: shot.url,
    }))
    : []
  const result = {
    ok: true,
    cycleId: cycle?.id ?? '',
    round: round?.n ?? 0,
    target: cycle?.target ?? '',
    rubricVersion: typeof round?.rubricVersion === 'string' ? round.rubricVersion : null,
    // v1.2 2.3a: domain profile used for this round (null on legacy rounds).
    profile: typeof round?.profile === 'string' && PROFILES.includes(round.profile) ? round.profile : null,
    // v1.3 3.1–3.4: lifecycle/noise/cost/incremental summaries (no paths/logs).
    mode: ROUND_MODES.includes(round?.mode) ? round.mode : 'fresh',
    reopen: {
      reopenedFrom: typeof cycle?.reopenedFrom === 'string' ? cycle.reopenedFrom : null,
      reopenCount: Number.isInteger(cycle?.reopenCount) ? cycle.reopenCount : 0,
    },
    noise: isPlainObject(round?.noise)
      ? {
        rawFindings: round.noise.rawFindings ?? 0,
        dedupedFindings: round.noise.dedupedFindings ?? 0,
        suppressedCount: Array.isArray(round.noise.suppressed) ? round.noise.suppressed.length : 0,
        knownRepeats: round.noise.knownRepeats ?? 0,
      }
      : null,
    cost: isPlainObject(round?.cost) ? { ...round.cost } : null,
    incremental: isPlainObject(round?.incremental)
      ? {
        mode: round.incremental.mode,
        baseCycleId: round.incremental.baseCycleId,
        baseRound: round.incremental.baseRound,
        changedCount: Array.isArray(round.incremental.changedFiles) ? round.incremental.changedFiles.length : 0,
        addedCount: Array.isArray(round.incremental.addedFiles) ? round.incremental.addedFiles.length : 0,
        removedCount: Array.isArray(round.incremental.removedFiles) ? round.incremental.removedFiles.length : 0,
        truncated: round.incremental.truncated === true,
        fullReview: round.incremental.fullReview === true,
        unchangedCount: round.incremental.unchangedCount ?? 0,
      }
      : null,
    promptHashes: isPlainObject(round?.promptHashes) ? round.promptHashes : null,
    modelRoute: compactModelRoute(round?.modelRoute),
    // v2.0 Stage A: bounded multi-judge score statistics (audit/calibration).
    scoreStats: compactScoreStats(round?.score?.scoreStats),
    shots,
    // v1.2 2.1: compact evidence-card summary (no logs/base64/paths).
    evidence: buildCompactEvidence(round?.evidence),
    attack: round?.attack ?? null,
    score: round?.score ?? null,
    gate,
    judges: Array.isArray(round?.judges) ? round.judges.map(compactJudge).filter(Boolean) : [],
    nextAction,
    message,
    warnings: Array.isArray(warnings) ? warnings : [],
  }
  // The tool output schema declares these as objects/strings; a null value would
  // fail output validation, so absent optional fields are omitted entirely.
  for (const key of ['rubricVersion', 'profile', 'reopen', 'noise', 'cost', 'incremental', 'promptHashes', 'modelRoute', 'scoreStats', 'evidence', 'attack', 'score', 'gate']) {
    if (result[key] === null || result[key] === undefined) delete result[key]
  }
  return result
}

/** Compact status summary used by `adversarial_review_status`. */
export async function buildStatusSummary(options = {}) {
  const {
    store,
    target = '',
    limit = 10,
    now = Date.now,
  } = isPlainObject(options) ? options : {}
  try {
    if (!store || typeof store.init !== 'function') return { ok: false, stage: 'store', error: '状态存储不可用' }
    await store.init()
    const state = store.state
    const cycles = Array.isArray(state?.cycles) ? state.cycles.filter(isPlainObject) : []
    const filtered = target === '' ? cycles : cycles.filter((cycle) => targetKey(cycle.target) === targetKey(target))
    const sorted = [...filtered].sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
    const max = Math.min(LIMITS.maxCycles, Math.max(1, Number.isInteger(limit) ? limit : 10))
    return {
      ok: true,
      version: 1,
      generatedAt: now(),
      // v1.1 1.4: surface state-integrity diagnostics to the calling agent.
      integrity: typeof store.integrity === 'function'
        ? store.integrity()
        : {
          verified: store.integrityVerified === true,
          hash: typeof store.lastIntegrityHash === 'string' ? store.lastIntegrityHash : null,
          error: store.lastIntegrityError === null || store.lastIntegrityError === undefined
            ? null
            : (store.lastIntegrityError.message || String(store.lastIntegrityError)),
        },
      cycles: sorted.slice(0, max).map((cycle) => {
        const latest = latestRoundOf(cycle)
        return {
          cycleId: cycle.id,
          target: cycle.target,
          title: cycle.title,
          status: cycle.status,
          required: cycle.required,
          rounds: Array.isArray(cycle.rounds) ? cycle.rounds.length : 0,
          latest: latest === null
            ? null
            : {
              n: latest.n,
              status: latest.status,
              score: isPlainObject(latest.score) && typeof latest.score.score === 'number' ? latest.score.score : null,
              verdict: isPlainObject(latest.score) && typeof latest.score.verdict === 'string' ? latest.score.verdict : null,
              gatePassed: isPlainObject(latest.gate) ? latest.gate.passed === true : null,
              findings: isPlainObject(latest.gate) ? latest.gate.findings : null,
              shots: Array.isArray(latest.shots) ? latest.shots.length : 0,
              mustFix: isPlainObject(latest.score) && Array.isArray(latest.score.mustFix) ? latest.score.mustFix.slice(0, 10) : [],
              failReasons: isPlainObject(latest.gate) && Array.isArray(latest.gate.failReasons) ? latest.gate.failReasons.slice(0, 10) : [],
              error: typeof latest.error === 'string' ? latest.error : null,
              finishedAt: latest.finishedAt ?? null,
            },
        }
      }),
    }
  } catch (error) {
    return { ok: false, stage: 'store', error: error?.message || String(error) }
  }
}

function normalizeRenderedShot(shot, now) {
  if (!isPlainObject(shot) || typeof shot.file !== 'string' || shot.file === '') return null
  const normalized = {
    file: path.basename(shot.file),
    url: typeof shot.url === 'string' ? shot.url : '',
    width: Number.isFinite(shot.width) ? Math.round(shot.width) : 0,
    height: Number.isFinite(shot.height) ? Math.round(shot.height) : 0,
    bytes: Number.isFinite(shot.bytes) ? Math.round(shot.bytes) : 0,
    page: typeof shot.page === 'string' ? shot.page : '',
    renderedAt: Number.isFinite(shot.renderedAt) ? shot.renderedAt : now,
  }
  // v1.1 1.4: content hash for tamper-evident evidence.
  if (typeof shot.sha256 === 'string' && /^[0-9a-f]{64}$/.test(shot.sha256)) normalized.sha256 = shot.sha256
  return normalized
}

/**
 * New rounds must record a sha256 for every screenshot (legacy rounds loaded
 * from old state may lack it; they are never re-gated).
 */
function assertShotHashes(shots) {
  const missing = (Array.isArray(shots) ? shots : []).filter((shot) => (
    !isPlainObject(shot) || typeof shot.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(shot.sha256)
  ))
  if (missing.length > 0) {
    const names = missing.map((shot) => (typeof shot?.file === 'string' ? shot.file : '?')).join('、')
    throw new ReviewError('screenshots', `截图缺少 sha256 内容哈希（${names}）：新轮次必须记录证据哈希，防止截图被替换。`)
  }
}

async function renderScreenshots(options) {
  const {
    renderImpl,
    stateDir,
    cycleId,
    roundNo,
    specs,
    config,
    warnings,
    cleanupFiles = [],
    now,
  } = options
  const renderer = typeof renderImpl === 'function' ? renderImpl : defaultRenderShots
  const timeoutSeconds = Number.isFinite(config?.screenshotTimeoutSeconds) && config.screenshotTimeoutSeconds > 0
    ? Math.round(config.screenshotTimeoutSeconds)
    : 45
  let result = null
  try {
    result = await renderer({
      cycleId,
      roundNo,
      stateDir,
      specs,
      requiredShots: config?.requiredShots,
      chromePath: typeof config?.chromePath === 'string' ? config.chromePath : '',
      timeoutMs: Math.max(5, timeoutSeconds) * 1000,
      cleanupFiles,
    })
  } catch (error) {
    return { ok: false, shots: [], error: `截图渲染异常：${error?.message || error}` }
  }
  if (!isPlainObject(result)) return { ok: false, shots: [], error: '截图渲染器返回了非法结果' }
  if (Array.isArray(result.warnings)) warnings.push(...result.warnings)
  const shots = Array.isArray(result.shots) ? result.shots.map((shot) => normalizeRenderedShot(shot, now())).filter(Boolean) : []
  if (result.ok !== true || shots.length !== config?.requiredShots) {
    const detail = typeof result.error === 'string' && result.error !== ''
      ? result.error
      : Array.isArray(result.errors) && typeof result.errors[0] === 'string' && result.errors[0] !== ''
        ? result.errors[0]
        : ''
    return {
      ok: false,
      shots,
      error: detail !== '' ? detail : `本轮截图只有 ${shots.length} 张，必须恰好 ${config?.requiredShots} 张`,
    }
  }
  return { ok: true, shots, error: null }
}

/**
 * v1.3 fix: judges may list blockers only in `blockingFindings` while leaving
 * the matching `validFindings` entry `supported:false`. Gate-affecting counts
 * therefore use the union (by findingKey) of explicitly supported validFindings
 * and all blockingFindings (blocking entries are supported by definition).
 */
function countSupportedUnion(validFindings, blockingFindings) {
  const keys = new Set()
  for (const finding of Array.isArray(validFindings) ? validFindings : []) {
    if (isPlainObject(finding) && finding.supported === true) keys.add(findingKey(finding))
  }
  for (const finding of Array.isArray(blockingFindings) ? blockingFindings : []) {
    if (isPlainObject(finding)) keys.add(findingKey(finding))
  }
  return keys.size
}

async function runSubagent(options) {
  const {
    subagents,
    provider,
    caps,
    label,
    stage,
    cwd,
    agent,
    promptText,
    outputSchema,
    preset,
    agentOptions = null,
    parentSignal,
    timeoutMs,
    cycleId = null,
    evidenceDir = '',
  } = options
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      controller.abort()
    } catch {
      // AbortController.abort never throws in practice.
    }
  }, timeoutMs)
  const onParentAbort = () => {
    try {
      controller.abort()
    } catch {
      // ignore
    }
  }
  let parentListenerAdded = false
  if (parentSignal && typeof parentSignal.addEventListener === 'function') {
    if (parentSignal.aborted === true) onParentAbort()
    else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true })
      parentListenerAdded = true
    }
  }
  let activation = null
  // v1.1 1.5: the child id is registered while the review child is running and
  // unregistered in `finally` (success, failure and timeout alike).
  let childId = null
  try {
    const request = {
      cwd,
      prompt: [{ type: 'text', text: promptText }],
      parent: agent,
    }
    if (caps?.agentPreset === true && typeof preset === 'string' && preset !== '') request.agentPreset = preset
    if (caps?.outputSchema === true && outputSchema !== undefined) request.outputSchema = outputSchema
    if (caps?.agentOptions === true && isPlainObject(agentOptions) && Object.keys(agentOptions).length > 0) {
      request.agentOptions = { ...agentOptions }
    }
    try {
      activation = await subagents.startActivation({
        provider: provider.name,
        label,
        request,
        signal: controller.signal,
        delivery: 'caller',
      })
    } catch (error) {
      throw new ReviewError(stage, `无法启动子智能体（provider=${provider.name}）：${error?.message || error}`, { cause: error })
    }
    if (!activation || typeof activation.result?.then !== 'function') {
      throw new ReviewError(stage, '子智能体激活结果缺失（startActivation 未返回 result Promise）')
    }
    // v1.1 1.5 / v2.0: the reviewer MUST be registered before it runs, otherwise
    // the tool guard (shell/write denial + fs confinement) would fail open.
    childId = typeof activation.childId === 'string' && activation.childId !== '' ? activation.childId : null
    if (childId === null) {
      throw new ReviewError(stage, '子智能体启动未返回 childId，无法登记评审会话；已中止本轮（fail-closed）')
    }
    const registered = registerReviewChild(childId, { targetDir: cwd, evidenceDir, stage, cycleId })
    if (registered === null || lookupReviewChild(childId) === null) {
      throw new ReviewError(stage, '评审会话登记失败（registry 未命中）；已中止本轮（fail-closed）')
    }
    let result = null
    // The manager may reject this promise after an abort raced the timeout;
    // pre-attach a catch so Node can never report an unhandled rejection.
    const resultPromise = activation.result
    resultPromise.catch(() => {})
    try {
      result = await Promise.race([
        resultPromise,
        new Promise((_resolve, reject) => {
          const rejectAborted = () => reject(new Error('aborted'))
          if (controller.signal.aborted) rejectAborted()
          else controller.signal.addEventListener('abort', rejectAborted, { once: true })
        }),
      ])
    } catch (error) {
      if (timedOut) throw new ReviewError(stage, `${stage === 'judge' ? '判官' : '红队'}子智能体超时（${formatSeconds(timeoutMs)} 秒）；已中止并标记本轮失败。`, { cause: error })
      if (parentSignal?.aborted === true) throw new ReviewError(stage, '评审已被调用方中止（工具调用被取消）。', { cause: error })
      throw new ReviewError(stage, `子智能体执行失败：${error?.message || error}`, { cause: error })
    }
    if (timedOut) {
      throw new ReviewError(stage, `${stage === 'judge' ? '判官' : '红队'}子智能体超时（${formatSeconds(timeoutMs)} 秒）；已中止并标记本轮失败。`)
    }
    if (!isPlainObject(result) || result.stopReason !== 'completed') {
      let diagnostic = ''
      if (isPlainObject(result)) {
        if (typeof result.diagnostic === 'string' && result.diagnostic !== '') diagnostic = result.diagnostic
        else if (typeof result.error === 'string' && result.error !== '') diagnostic = result.error
        else if (isPlainObject(result.error) && typeof result.error.message === 'string') diagnostic = result.error.message
        else if (typeof result.stopDetail === 'string' && result.stopDetail !== '') diagnostic = result.stopDetail
      }
      throw new ReviewError(stage, `子智能体未正常完成（stopReason=${String(isPlainObject(result) ? result.stopReason : 'missing')}${diagnostic === '' ? '' : `：${truncateText(diagnostic, 500)}`}）`)
    }
    return {
      result,
      childId,
    }
  } finally {
    // v1.1 1.5: a review child is a reviewer only for the duration of its run.
    // Unregister on success, failure, timeout and parent cancellation.
    if (childId !== null) unregisterReviewChild(childId)
    clearTimeout(timer)
    if (parentListenerAdded && typeof parentSignal.removeEventListener === 'function') {
      try {
        parentSignal.removeEventListener('abort', onParentAbort)
      } catch {
        // ignore
      }
    }
    if (activation !== null && typeof activation.dispose === 'function') {
      try {
        await activation.dispose()
      } catch {
        // Disposal failures must not mask the round result.
      }
    }
  }
}

/**
 * Run one complete adversarial-review round.
 *
 * @param {object} options
 * @param {object} options.config frozen effective plugin config
 * @param {object} options.store createStore() instance
 * @param {object} options.args raw tool arguments
 * @param {object|null} [options.agent] calling Agent (`exec.agent`)
 * @param {object|null} [options.subagents] `ctx.get('subagents')`
 * @param {object|null} [options.workingDirectory] `ctx.get('workingDirectory')`
 * @param {AbortSignal} [options.signal] caller cancellation (tool execution signal)
 * @param {Function} [options.renderShots] test injection point
 * @param {Function} [options.runInteractionCard] test injection point (defaults to lib/cdp.js)
 * @param {string|null} [options.profileRubric] test injection point for the domain rubric text
 * @param {Function} [options.computeSnapshot] test injection point (defaults to lib/snapshot.js)
 * @returns {Promise<object>} compact JSON result (never throws)
 */
export async function runReviewRound(options = {}) {
  const {
    config = {},
    store,
    args,
    agent = null,
    subagents = null,
    workingDirectory = null,
    signal,
    renderShots = null,
    runInteractionCard = null,
    profileRubric = null,
    computeSnapshot: computeSnapshotImpl = computeSnapshot,
    now = Date.now,
  } = isPlainObject(options) ? options : {}

  const requiredScore = Number.isFinite(config?.requiredScore) ? config.requiredScore : 95
  const requiredFindings = Number.isInteger(config?.requiredFindings) && config.requiredFindings > 0 ? config.requiredFindings : 3
  const requiredShots = Number.isInteger(config?.requiredShots) && config.requiredShots > 0 ? config.requiredShots : 4
  const maxRounds = Number.isInteger(config?.maxRounds) && config.maxRounds > 0 ? config.maxRounds : 12
  const warnings = []
  let cycle = null
  let round = null
  let lockKey = ''
  // v1.1 1.4: accumulate secret-redaction hits across the round.
  const redactionTotals = { hit: false, count: 0 }
  const redactRoundValue = (value) => {
    const redacted = redactValueWithStats(value)
    if (redacted.count > 0) {
      redactionTotals.hit = true
      redactionTotals.count += redacted.count
    }
    return redacted.value
  }
  const syncRedactionMarker = () => {
    if (round !== null) round.redaction = { hit: redactionTotals.hit, count: redactionTotals.count }
  }
  const startedAt = now()

  try {
    if (!store || typeof store.mutate !== 'function' || typeof store.init !== 'function') {
      throw new ReviewError('internal', '状态存储不可用（插件未正确初始化），无法运行评审轮次。')
    }
    const parsed = validateRoundArgs(args, config)
    warnings.push(...parsed.warnings)
    if (agent === null || typeof agent !== 'object' || typeof agent.id !== 'string') {
      throw new ReviewError('arguments', 'adversarial_review_round 必须由 Agent 会话调用（exec.agent 缺失）')
    }
    // v2.0: a review child must never start another round (defense in depth;
    // the tool guard denies it too). Otherwise it could target stateDir/other
    // projects and derive new sessions.
    if (lookupReviewChild(agent.id) !== null) {
      throw new ReviewError('forbidden', '评审子智能体不得调用 adversarial_review_round（只能通过 review_probe 做只读检查）。')
    }
    const targetDir = await resolveTargetDir(parsed.target, { workingDirectory, agent })
    // v1.1 1.3: resolve the delivery root and take the single per-root round
    // slot before touching the store, so a concurrent round is rejected without
    // creating a phantom round record.
    const deliverableRoot = resolveDeliverableRoot(targetDir, config?.deliverableRoots)
    if (targetKey(deliverableRoot) !== targetKey(targetDir)) {
      warnings.push(`本轮评审绑定到交付根「${deliverableRoot}」（target 位于该交付根内）；通过后同根下的所有文件都受交付门控约束。`)
    }
    const roundLock = acquireRoundLock(deliverableRoot, { startedAt })
    if (roundLock === null) return busyRoundResult(deliverableRoot)
    lockKey = targetKey(deliverableRoot)
    await store.init()

    // v1.2 2.3a: the domain profile (config, default `code`) is stamped on the
    // round and may inject a Host-trusted rubric into both prompts.
    const profile = parsed.profile !== null && parsed.profile !== undefined
      ? normalizeProfile(parsed.profile)
      : normalizeProfile(config?.profile)
    // Evidence strategy: explicit evidence cards → explicit legacy shots →
    // auto-detected entry page → Host-generated review report pages.
    let approach = { mode: 'report', specs: [], cards: null }
    const ensureEvidencePathExists = async (filePath, displayPage, label) => {
      let stat = null
      try {
        stat = await fs.stat(filePath)
      } catch {
        throw new ReviewError('arguments', `${label}的 path 不存在：${displayPage}（解析为 ${filePath}）`)
      }
      if (typeof stat?.isFile !== 'function' || !stat.isFile()) {
        throw new ReviewError('arguments', `${label}的 path 不是文件：${displayPage}`)
      }
    }
    if (parsed.evidence.length > 0) {
      const normalized = normalizeEvidenceCards(parsed.evidence, {
        targetDir,
        requiredEvidence: requiredShots,
        allowedOrigins: config?.allowedOrigins,
      })
      if (!normalized.ok) throw new ReviewError('arguments', normalized.error)
      warnings.push(...normalized.warnings)
      // Fail fast on a mistyped page path: the browser would otherwise render
      // its own error page and still produce a valid PNG.
      for (const card of normalized.cards) {
        if (typeof card.path === 'string' && card.path !== '') {
          await ensureEvidencePathExists(card.path, card.page, `第 ${card.index + 1} 张证据卡`)
        }
        for (const step of card.steps) {
          if (typeof step.path === 'string' && step.path !== '') {
            await ensureEvidencePathExists(step.path, step.page, `第 ${card.index + 1} 张证据卡的 goto 步骤`)
          }
        }
      }
      approach = { mode: 'evidence', cards: normalized.cards }
    } else if (parsed.shots.length > 0) {
      const normalized = normalizeSpecs(parsed.shots, {
        targetDir,
        requiredShots,
        allowedOrigins: config?.allowedOrigins,
      })
      if (!normalized.ok) throw new ReviewError('arguments', normalized.error)
      warnings.push(...normalized.warnings)
      // Fail fast on a mistyped page path: Chrome would otherwise capture its
      // own error page and still produce a valid PNG.
      for (const spec of normalized.specs) {
        if (spec.kind !== 'path') continue
        await ensureEvidencePathExists(spec.path, spec.page, '截图规格')
      }
      approach = { mode: 'explicit', specs: normalized.specs }
    } else {
      const entryFile = detectEntryFile({ targetDir })
      if (entryFile !== null) {
        // v1.3 fix: auto-detected specs carry paths relative to the target; they
        // MUST be normalized (absolute + existence/whitelist checks) before the
        // renderer turns them into file:// URLs. Otherwise `path.resolve` falls
        // back to the Host cwd and Chrome opens a nonexistent file.
        const normalizedAuto = normalizeSpecs(
          buildDefaultSpecs({ targetDir, entryFile, requiredShots }),
          {
            targetDir,
            requiredShots,
            allowedOrigins: config?.allowedOrigins,
          },
        )
        if (!normalizedAuto.ok) throw new ReviewError('screenshots', normalizedAuto.error)
        warnings.push(...normalizedAuto.warnings)
        for (const spec of normalizedAuto.specs) {
          if (spec.kind !== 'path') continue
          await ensureEvidencePathExists(spec.path, spec.page, '自动探测截图规格')
        }
        approach = { mode: 'auto', specs: normalizedAuto.specs }
      }
    }

    // v1.3 3.2: lifecycle mode (`fresh` default). reopen/incremental create a
    // brand-new cycle for the same target and only accept a previously passed
    // cycle as their base. `fresh` keeps the pre-v1.3 "passed refuses new round".
    const mode = normalizeMode(parsed.mode)
    let baseCycle = null
    const created = await store.mutate((state) => {
      // v1.1 1.3: one deliverable root maps to exactly one reviewed target —
      // this blocks "换靶子" (review a different sub-directory under the same
      // delivery root and then deliver it).
      const conflict = findCyclesByDeliverableRoot(state, deliverableRoot)
        .find((existingCycle) => targetKey(existingCycle.target) !== targetKey(targetDir))
      if (conflict !== undefined) {
        throw new ReviewError(
          'arguments',
          `交付根「${deliverableRoot}」已绑定评审 target「${conflict.target}」（cycle ${conflict.id}），不允许更换 target 绕开评审。请使用同一 target 继续评审。`,
        )
      }
      let existing = findCycleByTarget(state, targetDir)
      let passedBase = existing !== null && cycleIsPassed(existing) ? existing : null
      if (mode === 'fresh') {
        if (passedBase !== null) return { passedCycle: passedBase }
      } else if (passedBase === null) {
        // The latest cycle may be a failed reopen: fall back to the most recent
        // passed cycle for the same target as the reopen/incremental baseline.
        for (let index = state.cycles.length - 1; index >= 0; index -= 1) {
          const candidate = state.cycles[index]
          if (!isPlainObject(candidate) || targetKey(candidate.target) !== targetKey(targetDir)) continue
          if (cycleIsPassed(candidate)) {
            passedBase = candidate
            break
          }
        }
      }
      if (mode !== 'fresh') {
        if (passedBase === null) {
          throw new ReviewError(
            'arguments',
            `mode=${mode} 需要该 target 存在已通过门控（gate.passed=true）的 cycle；当前最新 cycle 尚未通过，请先用 mode:"fresh" 继续评审当前 cycle，或等其通过后再 ${mode}。`,
          )
        }
        const latestSameTarget = findCycleByTarget(state, targetDir)
        const reopenCount = Math.max(
          Number.isInteger(passedBase.reopenCount) ? passedBase.reopenCount : 0,
          latestSameTarget !== null && Number.isInteger(latestSameTarget.reopenCount) ? latestSameTarget.reopenCount : 0,
        ) + 1
        const reopenedCycle = createCycle(state, {
          target: targetDir,
          title: parsed.title !== '' ? parsed.title : passedBase.title,
          sessionId: agent.id,
          deliverableRoot,
          required: { score: requiredScore, findings: requiredFindings, shots: requiredShots },
          now: startedAt,
          reopenedFrom: passedBase.id,
          reopenCount,
        })
        const createdRound = startRound(reopenedCycle, { now: startedAt, profile, mode })
        return { cycle: reopenedCycle, round: createdRound, roundNo: createdRound.n, baseCycle: passedBase }
      }
      if (existing === null) {
        existing = createCycle(state, {
          target: targetDir,
          title: parsed.title,
          sessionId: agent.id,
          deliverableRoot,
          required: { score: requiredScore, findings: requiredFindings, shots: requiredShots },
          now: startedAt,
        })
      } else {
        // Reuse the deliverable root recorded on the cycle; the configuration
        // may never silently widen or narrow an existing review binding.
        const storedRoot = cycleDeliverableRoot(existing)
        if (storedRoot !== '' && targetKey(storedRoot) !== targetKey(deliverableRoot)) {
          throw new ReviewError(
            'arguments',
            `该 target 的既有 cycle 绑定交付根「${storedRoot}」，与本次解析的「${deliverableRoot}」不一致；请恢复原交付根配置或用新 target 重新评审。`,
          )
        }
        if (!existing.deliverableRoot) existing.deliverableRoot = deliverableRoot
      }
      const previous = latestRoundOf(existing)
      const roundNo = previous !== null && Number.isInteger(previous.n) ? previous.n + 1 : existing.rounds.length + 1
      if (roundNo > maxRounds) return { maxRounds: true, cycle: existing, roundNo }
      const createdRound = startRound(existing, { now: startedAt, profile, mode })
      return { cycle: existing, round: createdRound, roundNo: createdRound.n }
    })

    if (created?.passedCycle) {
      // v1.3 3.2: a passed cycle is still never re-reviewed in place — use the
      // explicit `mode:"reopen"`/`"incremental"` to create a new cycle.
      throw new ReviewError('cycle-passed', `target「${created.passedCycle.title || created.passedCycle.target}」的评审 cycle 已达标（gate.passed=true），拒绝在同一 cycle 内重复评审。如需继续迭代，请传 mode:"reopen" 或 mode:"incremental"（会创建新 cycle 并保留基线）；只有 gate.passed=true 才允许停止/交付。`)
    }
    if (created?.maxRounds) {
      throw new ReviewError('max-rounds', `已达到最大评审轮数 ${maxRounds}（第 ${created.roundNo} 轮被拒绝）。请用 mode:"reopen" 复开新 cycle（轮数上限重置），或人工介入。`)
    }
    cycle = created.cycle
    round = created.round
    baseCycle = created.baseCycle ?? null
    const roundNo = round.n
    roundLock.cycleId = cycle.id
    roundLock.round = roundNo

    // v1.3 3.1/3.2/3.3: previous-round knowledge for prompts, progress updates
    // and cancellation checkpoints.
    let previousRound = null
    if (baseCycle !== null) {
      previousRound = latestPassedRound(baseCycle) ?? latestRoundOf(baseCycle)
    } else if (Array.isArray(cycle.rounds) && cycle.rounds.length >= 2) {
      previousRound = cycle.rounds[cycle.rounds.length - 2]
    }
    const knownFindings = previousRound === null ? [] : knownFindingsFromRound(previousRound)
    const updateProgress = async (stage, detail = '') => {
      await setRoundProgress({ store, cycle, round, stage, detail, now })
    }
    const checkCancel = () => {
      if (isCancelRequested(cycle.id)) throw new ReviewError('cancelled', '评审已取消（用户请求）')
    }
    round.progress = { stage: 'evidence', updatedAt: startedAt, detail: '准备评审证据' }
    checkCancel()

    // 3. Subagent service + provider are validated before the (expensive)
    //    screenshot rendering so a missing capability fails fast and clearly.
    if (!subagents || typeof subagents.startActivation !== 'function') {
      throw new ReviewError(
        'subagents-unavailable',
        '子智能体服务（subagents）不可用：无法启动红队/判官子智能体。请确认当前 profile 安装了 subagent provider（spawn/fork）。',
      )
    }
    const provider = pickSubagentProvider(subagents, config?.childProvider)
    if (!provider) {
      throw new ReviewError('subagents-unavailable', `找不到可用的子智能体 provider（期望「${config?.childProvider || 'spawn'}」；已注册：${listProviderNames(subagents)}）`)
    }
    const caps = isPlainObject(provider.capabilities) ? provider.capabilities : {}
    const attackerPreset = caps.agentPreset === true ? config?.attackerPreset : undefined
    const judgePreset = caps.agentPreset === true ? config?.judgePreset : undefined
    if (typeof config?.attackerPreset === 'string' && config.attackerPreset !== '' && caps.agentPreset !== true) {
      warnings.push(`provider「${provider.name}」不支持 agentPreset：红队角色由提示词注入（预设 ${config.attackerPreset} 未生效）`)
    }
    if (typeof config?.judgePreset === 'string' && config.judgePreset !== '' && caps.agentPreset !== true) {
      warnings.push(`provider「${provider.name}」不支持 agentPreset：判官角色由提示词注入（预设 ${config.judgePreset} 未生效）`)
    }
    // v1.1 audit: optional child model routes. They are only requested when the
    // provider advertises `agentOptions`; otherwise warn and inherit the parent
    // route (pre-v1.1 behaviour). The requested route is persisted on the round.
    const modelRoutes = resolveModelRoutes(config, caps, provider.name)
    warnings.push(...modelRoutes.warnings)
    const judgeSamples = normalizeJudgeSamples(config?.judgeSamples)
    // v2.0 Stage A: optional per-sample judge model routes (judgeModels).
    const judgeRoutePlan = resolveJudgeSampleRoutes({
      config,
      caps,
      providerName: provider.name,
      judgeSamples,
      baseJudge: modelRoutes.judge,
    })
    warnings.push(...judgeRoutePlan.warnings)
    await store.mutate(() => {
      round.modelRoute = {
        attacker: modelRoutes.attacker === null ? null : { ...modelRoutes.attacker },
        judge: modelRoutes.judge === null ? null : { ...modelRoutes.judge },
        inherited: modelRoutes.inherited,
        samples: judgeRoutePlan.samples.map((route) => (route === null ? null : { ...route })),
      }
      cycle.updatedAt = now()
    })
    const timeoutSeconds = Number.isFinite(config?.roundTimeoutSeconds) && config.roundTimeoutSeconds > 0
      ? config.roundTimeoutSeconds
      : 900
    const timeoutMs = Math.max(50, Math.round(timeoutSeconds * 1000))

    // v1.1 1.3 / v2.0: freeze the DELIVERY ROOT (not just the target dir) so the
    // synchronous guard, which recomputes cycleDeliverableRoot(cycle), compares
    // identical trees when deliverableRoots is configured.
    const snapshot = await computeSnapshotImpl(deliverableRoot, {
      limits: {
        maxFiles: config?.snapshotMaxFiles,
        maxHashBytes: config?.snapshotMaxHashBytes,
        maxFileBytes: config?.snapshotMaxFileBytes,
      },
    })
    if (!isPlainObject(snapshot) || snapshot.ok === false || snapshot.schemaVersion !== 1
      || typeof snapshot.manifestHash !== 'string' || !/^[0-9a-f]{64}$/.test(snapshot.manifestHash)) {
      const detail = isPlainObject(snapshot?.error)
        ? (snapshot.error.message || '未知错误')
        : '快照返回结构不合法（缺少 manifestHash）'
      throw new ReviewError('snapshot', `评审快照生成失败：${detail}`)
    }
    const gitCommit = findGitCommit(targetDir)
    // v1.3 3.2: every round persists its snapshot file list under
    // `<stateDir>/snapshots/<cycleId>/r<N>.json`; state keeps only the relative
    // path so incremental rounds can diff against a passed baseline.
    const filesFile = await writeSnapshotFileList({
      stateDir: store.stateDir,
      cycleId: cycle.id,
      roundNo,
      snapshot,
    })
    if (filesFile === null) {
      warnings.push('快照文件清单写入失败：本轮 snapshot 只记录摘要哈希，后续 incremental 将退化为全量评审。')
    }
    const snapshotRecord = {
      manifestHash: snapshot.manifestHash,
      gitCommit: typeof gitCommit === 'string' ? gitCommit : null,
      fileCount: Number.isFinite(snapshot.fileCount) ? snapshot.fileCount : 0,
      hashedBytes: Number.isFinite(snapshot.hashedBytes) ? snapshot.hashedBytes : 0,
      truncated: snapshot.truncated === true,
      skippedCount: Number.isFinite(snapshot.skippedCount) ? snapshot.skippedCount : 0,
      createdAt: Number.isFinite(snapshot.createdAt) ? snapshot.createdAt : now(),
      filesFile,
    }
    // v1.3 3.2: incremental rounds diff the current snapshot against the latest
    // passed round's persisted file list. Any missing baseline degrades to a
    // full review (never silently skips checks).
    let incrementalRecord = null
    if (mode === 'incremental') {
      const baseRound = baseCycle === null ? null : (latestPassedRound(baseCycle) ?? latestRoundOf(baseCycle))
      const baseFilesFile = typeof baseRound?.snapshot?.filesFile === 'string' ? baseRound.snapshot.filesFile : ''
      const baseFiles = baseFilesFile === '' ? null : await readSnapshotFileList({ stateDir: store.stateDir, filesFile: baseFilesFile })
      const forcedFull = config?.incrementalFullReview === true
      const maxChangedFiles = Number.isInteger(config?.incrementalMaxChangedFiles) && config.incrementalMaxChangedFiles > 0
        ? config.incrementalMaxChangedFiles
        : 200
      const diff = baseFiles === null
        ? { changedFiles: [], addedFiles: [], removedFiles: [], truncated: false, unchangedCount: 0 }
        : diffSnapshotFiles(baseFiles, snapshot.files, { maxChangedFiles })
      const fullReview = forcedFull || baseFiles === null
      incrementalRecord = {
        mode: 'incremental',
        baseCycleId: baseCycle === null ? null : baseCycle.id,
        baseRound: baseRound !== null && Number.isInteger(baseRound.n) ? baseRound.n : null,
        baseManifestHash: typeof baseRound?.snapshot?.manifestHash === 'string' ? baseRound.snapshot.manifestHash : null,
        currentManifestHash: snapshot.manifestHash,
        ...diff,
        fullReview,
      }
      if (baseFiles === null) {
        warnings.push('增量评审基线快照文件清单不可用（旧轮次无 filesFile 或文件丢失）：本轮按全量评审执行。')
      }
      if (forcedFull) warnings.push('config.incrementalFullReview=true：本轮强制全量评审（仍记录变更清单）。')
      if (diff.truncated) warnings.push(`增量变更文件超过 incrementalMaxChangedFiles=${maxChangedFiles}，列表已截断。`)
    }
    await store.mutate(() => {
      round.snapshot = snapshotRecord
      round.incremental = incrementalRecord
      cycle.updatedAt = now()
    })
    if (snapshot.truncated === true) {
      warnings.push(`项目快照达到 maxFiles=${config?.snapshotMaxFiles ?? 'default'} 上限而截断：清单只覆盖前若干文件，guard 只能校验已记录部分。`)
    }
    if (snapshot.skippedCount > 0) {
      warnings.push(`项目快照有 ${snapshot.skippedCount} 个文件未计算内容哈希（超过大小/预算上限或符号链接），manifest 只记录其 size/mtime。`)
    }

    // v1.3 3.3: persist the evidence stage before the (slow) browser renders so
    // the SSE/UI progress stream reflects reality.
    await updateProgress('evidence', '渲染固定证据')
    checkCancel()

    // 3. Render the fixed screenshot evidence before the red team starts.
    //    Projects without a renderable Web entry get four review-report pages
    //    instead; those are produced BEFORE the children so the red team and
    //    the judge both receive a real four-shot manifest, and the judge never
    //    scores a "missing screenshots" cap that makes the gate unreachable.
    const renderReportEvidence = async (view = null) => {
      const shotsStarted = now()
      const pages = renderReportPages(view?.cycle ?? cycle, view?.round ?? round)
      const written = await writeReportHtml({
        stateDir: store.stateDir,
        cycleId: cycle.id,
        roundNo,
        pages,
        requiredShots,
      })
      if (!written.ok) {
        for (const file of Array.isArray(written.files) ? written.files : []) {
          try {
            await fs.unlink(file)
          } catch {
            // best-effort cleanup of partially written report HTML
          }
        }
        throw new ReviewError('screenshots', written.error || '报告页写入失败')
      }
      let rendered = null
      try {
        rendered = await renderScreenshots({
          renderImpl: renderShots,
          stateDir: store.stateDir,
          cycleId: cycle.id,
          roundNo,
          specs: written.specs,
          config,
          warnings,
          cleanupFiles: written.files,
          now,
        })
      } finally {
        for (const file of written.files) {
          try {
            await fs.unlink(file)
          } catch {
            // The temp HTML is best-effort cleanup only.
          }
        }
      }
      if (Array.isArray(rendered.shots) && rendered.shots.length > 0) {
        await store.mutate(() => {
          round.shots = rendered.shots
          round.timings.shotsMs = Math.max(0, now() - shotsStarted)
          cycle.updatedAt = now()
        })
      }
      if (!rendered.ok) throw new ReviewError('screenshots', rendered.error || '报告页截图渲染失败')
      const verification = await verifyRoundShotFiles({
        shots: rendered.shots,
        shotsDir: store.shotsDir(cycle.id),
        requiredShots,
      })
      if (!verification.ok) throw new ReviewError('screenshots', verification.error)
      assertShotHashes(rendered.shots)
    }

    // v1.2 2.1: evidence rendering. Explicit evidence cards / legacy shots /
    // auto-detected pages all go through the evidence framework; the legacy
    // all-screenshot plan still uses exactly one renderShots call.
    const evidenceStarted = now()
    if (approach.mode !== 'report') {
      const renderedEvidence = await renderEvidenceCards({
        cards: approach.mode === 'evidence' ? approach.cards : null,
        specs: approach.mode === 'evidence' ? null : approach.specs,
        targetDir,
        stateDir: store.stateDir,
        cycleId: cycle.id,
        roundNo,
        requiredEvidence: requiredShots,
        config,
        renderShotsImpl: typeof renderShots === 'function' ? renderShots : defaultRenderShots,
        runInteractionCardImpl: typeof runInteractionCard === 'function' ? runInteractionCard : undefined,
        now,
      })
      if (Array.isArray(renderedEvidence.warnings)) warnings.push(...renderedEvidence.warnings)
      if (renderedEvidence.shots.length > 0 || renderedEvidence.evidence.length > 0) {
        // Keep whatever evidence was rendered even if the round is about to fail.
        await store.mutate(() => {
          round.shots = renderedEvidence.shots.map((shot) => normalizeRenderedShot(shot, now())).filter(Boolean)
          round.evidence = renderedEvidence.evidence
          round.timings.shotsMs = Math.max(0, now() - evidenceStarted)
          cycle.updatedAt = now()
        })
      }
      if (!renderedEvidence.ok) throw new ReviewError('screenshots', renderedEvidence.error || '证据渲染失败')
      const verification = await verifyRoundShotFiles({
        shots: round.shots,
        shotsDir: store.shotsDir(cycle.id),
        requiredShots,
      })
      if (!verification.ok) throw new ReviewError('screenshots', verification.error)
      assertShotHashes(round.shots)
      const evidenceVerification = await verifyEvidenceArtifacts({
        evidence: round.evidence,
        shotsDir: store.shotsDir(cycle.id),
        requiredEvidence: requiredShots,
      })
      if (!evidenceVerification.ok) throw new ReviewError('screenshots', evidenceVerification.error)
    } else {
      warnings.push(`target 未找到可渲染的 Web 入口（index.html/public/index.html/dist/index.html/src/index.html），本轮 ${requiredShots} 张证据截图改为 Host 生成的评审报告页（在红队/判官启动前渲染）。`)
      await renderReportEvidence()
      // v1.2 2.1: report pages are real evidence too — expose them as screenshot
      // cards so prompts/compact results carry the same evidence manifest.
      const synthesized = buildEvidenceFromShots({ shots: round.shots, requiredShots })
      if (!synthesized.ok) throw new ReviewError('screenshots', synthesized.error)
      await store.mutate(() => {
        round.evidence = synthesized.evidence
        cycle.updatedAt = now()
      })
      const evidenceVerification = await verifyEvidenceArtifacts({
        evidence: round.evidence,
        shotsDir: store.shotsDir(cycle.id),
        requiredEvidence: requiredShots,
      })
      if (!evidenceVerification.ok) throw new ReviewError('screenshots', evidenceVerification.error)
    }

    // v1.3 3.3: checkpoint after evidence (cancellation is allowed up to here).
    await updateProgress('attacker', '证据渲染完成，准备红队审查')
    checkCancel()

    // v1.2 2.1/2.3a: compact Host manifest + domain rubric for the two prompts.
    // The rubric is Host-trusted data, so — unlike project content — it is NOT
    // untrusted-fenced (it still never grants new tool permissions).
    const evidenceManifest = buildEvidenceManifest(round.evidence)
    let profileRubricText = ''
    if (typeof profileRubric === 'string') {
      profileRubricText = profileRubric
    } else {
      try {
        profileRubricText = await loadProfileRubric(profile)
      } catch (error) {
        throw error instanceof ReviewError ? error : new ReviewError('internal', `读取领域 rubric 失败：${error?.message || error}`)
      }
    }

    // 5. Red team child.
    const attackPrompt = buildAttackerPrompt({
      target: targetDir,
      title: cycle.title,
      claims: parsed.claims,
      focus: parsed.focus,
      outOfScope: parsed.outOfScope,
      environment: parsed.environment,
      timeBudget: parsed.timeBudget,
      roundNo,
      shots: resolveShotsManifest(round.shots),
      shotsNote: approach.mode === 'report'
        ? '本项目未找到 Web UI，这 4 张是 Host 生成的中性占位报告页（目标概览/证据说明；评审开始前生成，不包含本次的发现或评分）。请据此做代码与报告核对；不要因为不是项目页面截图就额外扣分。'
        : '',
      requiredFindings,
      requiredShots,
      evidence: evidenceManifest,
      profile,
      profileRubric: profileRubricText,
      knownFindings,
      knownNote: knownFindings.length === 0
        ? ''
        : `上轮（cycle ${previousRound === null ? '—' : (baseCycle === null ? cycle.id : baseCycle.id)} 第 ${previousRound?.n ?? '—'} 轮）已核实支持的问题，请优先核对是否已修复/回归，不要重复占用预算。`,
      incremental: isPlainObject(round.incremental) ? round.incremental : null,
      mode,
    })
    // v1.1 audit: hash the exact attacker prompt text before the child starts.
    const attackPromptHash = hashPromptText(attackPrompt)
    await store.mutate(() => {
      round.promptHashes = { attacker: attackPromptHash, judge: null }
      cycle.updatedAt = now()
    })
    const attackStarted = now()
    const attacker = await runSubagent({
      subagents,
      provider,
      caps,
      label: `redteam-r${roundNo}`,
      stage: 'attacker',
      cwd: targetDir,
      cycleId: cycle.id,
      evidenceDir: store.shotsDir(cycle.id),
      agent,
      promptText: attackPrompt,
      outputSchema: ATTACK_SCHEMA,
      preset: attackerPreset,
      agentOptions: modelRoutes.attacker,
      parentSignal: signal,
      timeoutMs,
    })
    const attackMs = Math.max(0, now() - attackStarted)
    const parsedAttack = parseAttackResult(attacker.result)
    warnings.push(...parsedAttack.warnings)
    // v1.3 3.1: Host-side noise control. Keep one representative per findingKey
    // (supported > severity > longer evidence), record what was suppressed, and
    // count how many repeat a finding the previous round already reported.
    const rawAttackFindings = Array.isArray(parsedAttack.attack.findings) ? parsedAttack.attack.findings : []
    const attackNoise = dedupeFindings(rawAttackFindings)
    const noiseRecord = {
      rawFindings: rawAttackFindings.length,
      dedupedFindings: attackNoise.kept.length,
      suppressed: attackNoise.suppressed,
      knownRepeats: countKnownRepeats(attackNoise.kept, knownFindings),
    }
    if (attackNoise.suppressed.length > 0) {
      warnings.push(`自动降噪：红队原始发现 ${noiseRecord.rawFindings} 条，去重后 ${noiseRecord.dedupedFindings} 条（抑制 ${attackNoise.suppressed.length} 条叙述）。`)
    }
    if (noiseRecord.knownRepeats > 0) {
      warnings.push(`本轮有 ${noiseRecord.knownRepeats} 条发现与上轮已报告问题同 key（可能是回归未修复）。`)
    }
    // Suppressed titles/reasons can quote project secrets: redact before persist.
    const safeNoiseRecord = redactRoundValue(noiseRecord)
    parsedAttack.attack = redactRoundValue({ ...parsedAttack.attack, findings: attackNoise.kept })
    await store.mutate(() => {
      round.attack = parsedAttack.attack
      round.attackerSessionId = attacker.childId
      round.timings.attackMs = attackMs
      round.noise = safeNoiseRecord
      syncRedactionMarker()
      cycle.updatedAt = now()
    })
    // v1.3 3.3: checkpoint after the red team, before judges.
    await updateProgress('judge', '红队完成，启动独立判官')
    checkCancel()

    // 6. Judge children (judgeSamples independent sessions, run sequentially):
    //    each sees only the red-team report + shot manifest + target path. The
    //    prompts are byte-identical, but every judge is a fresh, isolated
    //    session with no visibility into the other samples.
    const judgePrompt = buildJudgePrompt({
      target: targetDir,
      title: cycle.title,
      roundNo,
      attack: parsedAttack.attack,
      shots: resolveShotsManifest(round.shots),
      shotsNote: approach.mode === 'report'
        ? '本项目未找到 Web UI，这 4 张是 Host 在评审开始前生成的中性占位报告页（目标概览/证据说明；不包含空的评分或发现数字）。评审结束后 Host 会用完整结果重新渲染它们；截图数量由 Host 门控强制，不要按「缺少项目页面截图」扣分。'
        : '',
      requiredScore,
      requiredFindings,
      requiredShots,
      evidence: evidenceManifest,
      profile,
      profileRubric: profileRubricText,
      knownFindings,
      knownNote: knownFindings.length === 0
        ? ''
        : '这些是上轮已核实支持的问题（Host 生成的数据）。复核本轮报告时请确认：已经修复的项不应被当作 supported；仍存在的项允许以「重复」引用。',
      mode,
    })
    const judgePromptHash = hashPromptText(judgePrompt)
    await store.mutate(() => {
      round.promptHashes = { attacker: attackPromptHash, judge: judgePromptHash }
      round.judges = []
      round.judgeSessionIds = []
      round.judgeSessionId = null
      cycle.updatedAt = now()
    })
    const judgeEntries = []
    const sampleScores = []
    let lastJudgeResult = null
    let judgeElapsedMs = 0
    for (let sampleIndex = 0; sampleIndex < judgeSamples; sampleIndex += 1) {
      // v1.3 3.3: a cancellation requested between judge samples stops the round.
      checkCancel()
      const sampleStarted = now()
      // v2.0 Stage A: sample-specific judge route (null = inherit).
      const sampleRoute = judgeRoutePlan.samples[sampleIndex] ?? null
      const judge = await runSubagent({
        subagents,
        provider,
        caps,
        label: `judge-r${roundNo}-${sampleIndex + 1}`,
        stage: 'judge',
        cwd: targetDir,
        cycleId: cycle.id,
        evidenceDir: store.shotsDir(cycle.id),
        agent,
        promptText: judgePrompt,
        outputSchema: SCORE_SCHEMA,
        preset: judgePreset,
        agentOptions: sampleRoute,
        parentSignal: signal,
        timeoutMs,
      })
      judgeElapsedMs += Math.max(0, now() - sampleStarted)
      const parsedScore = parseScoreResult(judge.result, { requiredScore })
      warnings.push(...parsedScore.warnings)
      // v1.3 3.1: de-duplicate this judge sample before aggregation/gate. The
      // raw judge payload is still recorded in `round.judges[]` for audit.
      const rawJudgeScore = parsedScore.score
      const judgeFindingsNoise = dedupeFindings(Array.isArray(rawJudgeScore.validFindings) ? rawJudgeScore.validFindings : [])
      const judgeBlockingNoise = dedupeFindings(Array.isArray(rawJudgeScore.blockingFindings) ? rawJudgeScore.blockingFindings : [])
      const judgeMustFixNoise = dedupeMustFix(rawJudgeScore.mustFix)
      const dedupedSupportedCount = countSupportedUnion(judgeFindingsNoise.kept, judgeBlockingNoise.kept)
      const judgeSuppressedCount = judgeFindingsNoise.suppressed.length
        + judgeBlockingNoise.suppressed.length
        + judgeMustFixNoise.suppressed.length
      if (judgeSuppressedCount > 0) {
        warnings.push(`自动降噪：判官样本 ${sampleIndex + 1} 有 ${judgeSuppressedCount} 条重复项已在聚合前去重（原始输出保留在 judges[].rawSnippet）。`)
      }
      // v1.1 1.4: scrub secrets before aggregation/persistence.
      const sampleScore = redactRoundValue({
        ...rawJudgeScore,
        validFindings: judgeFindingsNoise.kept,
        blockingFindings: judgeBlockingNoise.kept,
        mustFix: judgeMustFixNoise.kept,
        supportedCount: dedupedSupportedCount,
        findingsCount: dedupedSupportedCount,
      })
      sampleScores.push(sampleScore)
      judgeEntries.push({
        index: sampleIndex,
        sessionId: judge.childId,
        score: sampleScore.score,
        rawScore: typeof sampleScore.rawScore === 'number' && Number.isFinite(sampleScore.rawScore) ? sampleScore.rawScore : null,
        verdict: sampleScore.verdict,
        findingsCount: sampleScore.findingsCount,
        // v2.0: use the same deduped count for both audit fields; mixing the
        // deduped findingsCount with the raw supportedCount made judges[]
        // cross-checks inconsistent.
        supportedCount: sampleScore.supportedCount,
        // Free-text audit fields come from the redacted sample (the raw model
        // output is preserved only as the redacted rawSnippet below).
        mustFix: [...sampleScore.mustFix],
        deductions: sampleScore.deductions.map((deduction) => ({ ...deduction })),
        rationale: sampleScore.rationale,
        rawSnippet: redactRoundValue(rawExcerpt(judge.result, JUDGE_RAW_SNIPPET_CHARS)),
        warnings: [...parsedScore.warnings],
        modelRoute: sampleRoute === null ? null : { ...sampleRoute },
      })
      lastJudgeResult = judge.result
      // Persist each sample immediately so a later failure still leaves an
      // audit trail of the judges that already answered.
      await store.mutate(() => {
        round.judges = judgeEntries.map((entry) => ({ ...entry }))
        round.judgeSessionIds = judgeEntries.map((entry) => entry.sessionId).filter((id) => typeof id === 'string')
        round.judgeSessionId = round.judgeSessionIds.length > 0 ? round.judgeSessionIds[0] : null
        round.judgeRaw = redactRoundValue(rawExcerpt(judge.result, RAW_EXCERPT_CHARS))
        round.timings.judgeMs = judgeElapsedMs
        syncRedactionMarker()
        cycle.updatedAt = now()
      })
    }
    const aggregatedScore = aggregateJudgeScores(sampleScores, { requiredScore })
    if (aggregatedScore === null) {
      throw new ReviewError('judge-parse', '判官样本为空，无法聚合评分。')
    }
    const disagreement = isPlainObject(aggregatedScore.disagreement) ? aggregatedScore.disagreement : null
    // Belt-and-braces: the aggregate is built from already redacted samples, but
    // scrub it again immediately before it is persisted. v1.3 3.1: the final
    // gate-affecting projections (validFindings/blockingFindings/mustFix/supported
    // count) are de-duplicated a last time so duplicates across judge samples
    // cannot inflate the effective finding count.
    let redactedAggregate = redactRoundValue(aggregatedScore)
    const finalFindingsNoise = dedupeFindings(Array.isArray(redactedAggregate.validFindings) ? redactedAggregate.validFindings : [])
    const finalBlockingNoise = dedupeFindings(Array.isArray(redactedAggregate.blockingFindings) ? redactedAggregate.blockingFindings : [])
    const finalMustFixNoise = dedupeMustFix(redactedAggregate.mustFix)
    redactedAggregate = {
      ...redactedAggregate,
      validFindings: finalFindingsNoise.kept,
      blockingFindings: finalBlockingNoise.kept,
      mustFix: finalMustFixNoise.kept,
      supportedCount: countSupportedUnion(finalFindingsNoise.kept, finalBlockingNoise.kept),
      // v1.3 3.1: the gate counts de-duplicated supported findings (union of
      // supported validFindings and blockingFindings), never raw duplicates.
      findingsCount: countSupportedUnion(finalFindingsNoise.kept, finalBlockingNoise.kept),
    }
    await store.mutate(() => {
      round.score = redactedAggregate
      round.disagreement = disagreement
      round.judgeRaw = lastJudgeResult === null ? null : redactRoundValue(rawExcerpt(lastJudgeResult, RAW_EXCERPT_CHARS))
      round.timings.judgeMs = judgeElapsedMs
      syncRedactionMarker()
      cycle.updatedAt = now()
    })
    // v1.3 3.3: checkpoint after judges, before the gate.
    await updateProgress('gate', '判官完成，计算门控')
    checkCancel()

    // 8. Stop gate + persistence.
    const gate = computeGate({
      score: round.score,
      shots: Array.isArray(round.shots) ? round.shots.length : 0,
      requiredScore,
      requiredFindings,
      requiredShots,
    })
    const finishedAt = now()
    // v2.0 fix: report-mode pages must reflect the completed result, but they
    // must also be rendered BEFORE the completed state is persisted. If the
    // render/verify fails, the round must never be persisted as passed.
    let finalEvidence = null
    if (approach.mode === 'report') {
      const finalRoundView = { ...round, status: 'completed', gate, finishedAt }
      const finalCycleView = { ...cycle, status: gate.passed ? 'passed' : 'reviewing' }
      await renderReportEvidence({ round: finalRoundView, cycle: finalCycleView })
      finalEvidence = buildEvidenceFromShots({ shots: round.shots, requiredShots })
      if (!finalEvidence.ok) throw new ReviewError('screenshots', finalEvidence.error)
      round.evidence = finalEvidence.evidence
      const finalVerification = await verifyEvidenceArtifacts({
        evidence: round.evidence,
        shotsDir: store.shotsDir(cycle.id),
        requiredEvidence: requiredShots,
      })
      if (!finalVerification.ok) throw new ReviewError('screenshots', finalVerification.error)
    }
    // v1.3 3.4: bounded cost/latency audit record (timings + prompt/response sizes).
    const artifactCount = Array.isArray(round.evidence)
      ? round.evidence.reduce((total, card) => total + (Array.isArray(card?.artifacts) ? card.artifacts.length : 0), 0)
      : 0
    const cost = {
      totalMs: Math.max(0, finishedAt - startedAt),
      evidenceMs: Math.max(0, numberOrLocal(round.timings?.shotsMs, 0)),
      attackMs: Math.max(0, numberOrLocal(round.timings?.attackMs, 0)),
      judgeMs: Math.max(0, numberOrLocal(round.timings?.judgeMs, 0)),
      promptChars: attackPrompt.length,
      judgePromptChars: judgePrompt.length,
      attackChars: textChars(attacker.result),
      scoreChars: textChars(redactedAggregate),
      judgeSamples,
      artifactCount,
    }
    await store.mutate(() => {
      round.status = 'completed'
      round.finishedAt = finishedAt
      round.error = null
      round.gate = gate
      round.cost = cost
      round.progress = { stage: 'done', updatedAt: finishedAt, detail: '' }
      round.timings.totalMs = Math.max(0, finishedAt - startedAt)
      syncRedactionMarker()
      cycle.status = gate.passed ? 'passed' : 'reviewing'
      cycle.updatedAt = finishedAt
    })
    if (store.lastWriteError) warnings.push(`状态持久化失败（本轮结果仍有效）：${store.lastWriteError.message}`)
    return buildCompactResult({ cycle, round, warnings })
  } catch (error) {
    const reviewError = error instanceof ReviewError
      ? error
      : new ReviewError('internal', error?.message || String(error), { cause: error })
    if (cycle !== null && round !== null) {
      const failedAt = now()
      try {
        await store.mutate(() => {
          round.status = 'failed'
          round.finishedAt = failedAt
          round.error = truncateText(reviewError.message, 2000)
          if (reviewError.stage === 'cancelled') {
            round.progress = { stage: 'cancelled', updatedAt: failedAt, detail: '评审已取消（用户请求）' }
          }
          cycle.updatedAt = failedAt
        })
      } catch {
        // The in-memory record still carries the failure; persistence is best effort.
      }
    }
    if (store && store.lastWriteError) warnings.push(`状态持久化失败：${store.lastWriteError.message}`)
    const failure = { ok: false, stage: reviewError.stage, error: reviewError.message }
    if (cycle !== null && round !== null) {
      failure.cycleId = cycle.id
      failure.round = round.n
    }
    if (reviewError.raw !== null) failure.raw = reviewError.raw
    if (warnings.length > 0) failure.warnings = warnings
    return failure
  } finally {
    // v1.1 1.3: the per-deliverable-root slot must be released on success,
    // failure and unexpected exceptions alike.
    if (lockKey !== '') releaseRoundLock(lockKey)
    // v1.3 3.3: a cancel request only applies to the round that was running.
    if (cycle !== null && typeof cycle.id === 'string') clearCancel(cycle.id)
  }
}

// ---------------------------------------------------------------------------
// v1.3 3.4: sequential batch review (2..maxBatchTargets targets)
// ---------------------------------------------------------------------------

/**
 * Run one review round per target, sequentially, continuing after failures.
 * `runReviewRound` is injected for tests; the tool wrapper uses the real one.
 *
 * @returns {Promise<{ok: true, results: object[], summary: {total: number, passed: number, failed: number}, warnings: string[]}>}
 */
export async function runReviewBatch(options = {}) {
  const {
    config = {},
    store,
    args,
    agent = null,
    subagents = null,
    workingDirectory = null,
    signal,
    runRound = runReviewRound,
    now = Date.now,
  } = isPlainObject(options) ? options : {}
  const warnings = []
  const fail = (error) => ({ ok: false, stage: 'arguments', error })
  // v2.0: review children must not batch-start reviews (defense in depth).
  if (agent !== null && typeof agent?.id === 'string' && lookupReviewChild(agent.id) !== null) {
    return { ok: false, stage: 'forbidden', error: '评审子智能体不得调用 adversarial_review_batch（只能通过 review_probe 做只读检查）。' }
  }
  if (!isPlainObject(args)) return fail('参数必须是对象')
  const targets = Array.isArray(args.targets) ? args.targets : null
  if (targets === null) return fail('参数 targets 必须是字符串数组（2 个及以上被评审项目路径）')
  const configuredMax = Number.isInteger(config?.maxBatchTargets) && config.maxBatchTargets > 0
    ? Math.min(LIMITS.maxBatchTargets, config.maxBatchTargets)
    : 10
  if (targets.length < 2) return fail(`参数 targets 至少需要 2 个（本次收到 ${targets.length} 个）`)
  if (targets.length > configuredMax) return fail(`参数 targets 最多 ${configuredMax} 个（本次收到 ${targets.length} 个）`)
  const cleaned = []
  const seen = new Set()
  for (let index = 0; index < targets.length; index += 1) {
    const raw = targets[index]
    if (typeof raw !== 'string' || raw.trim() === '') return fail(`targets[${index}] 必须是非空路径字符串`)
    const target = raw.trim()
    if (target.length > 1000) return fail(`targets[${index}] 过长（超过 1000 字符）`)
    const key = targetKey(target)
    if (key === '' || seen.has(key)) return fail(`targets 存在重复路径：${target}`)
    seen.add(key)
    cleaned.push(target)
  }
  // Validate the shared optional fields once (the per-target calls re-validate).
  const shared = {
    title: args.title,
    claims: args.claims,
    focus: args.focus,
    outOfScope: args.outOfScope,
    environment: args.environment,
    timeBudget: args.timeBudget,
    profile: args.profile,
    mode: args.mode,
  }
  try {
    validateRoundArgs({ target: cleaned[0], ...shared }, config)
  } catch (error) {
    return { ok: false, stage: error?.stage || 'arguments', error: error?.message || String(error) }
  }
  if (signal?.aborted === true) return { ok: false, stage: 'cancelled', error: '批量评审已被调用方取消。' }
  const results = []
  for (const target of cleaned) {
    if (signal?.aborted === true) {
      warnings.push(`批量评审在 target「${target}」前被调用方取消，剩余目标未执行。`)
      break
    }
    let result = null
    try {
      result = await runRound({
        config,
        store,
        args: { target, ...shared },
        agent,
        subagents,
        workingDirectory,
        signal,
        now: typeof now === 'function' ? now : Date.now,
      })
    } catch (error) {
      result = { ok: false, stage: 'internal', error: error?.message || String(error) }
    }
    const entry = {
      target,
      ok: result?.ok === true,
      cycleId: typeof result?.cycleId === 'string' ? result.cycleId : null,
      round: Number.isInteger(result?.round) ? result.round : null,
      score: isPlainObject(result?.score) && Number.isFinite(result.score.score) ? result.score.score : null,
      gate: isPlainObject(result?.gate) ? result.gate : null,
    }
    if (result?.ok !== true) {
      entry.error = typeof result?.error === 'string' ? result.error : '评审失败'
      if (typeof result?.stage === 'string') entry.stage = result.stage
    }
    results.push(entry)
  }
  const passed = results.filter((entry) => entry.ok === true && isPlainObject(entry.gate) && entry.gate.passed === true).length
  const failed = results.length - passed
  if (results.length !== cleaned.length) {
    warnings.push(`批量评审只执行了 ${results.length}/${cleaned.length} 个 target（调用方取消或提前结束）。`)
  }
  return {
    ok: true,
    results,
    summary: { total: results.length, passed, failed },
    warnings,
  }
}
