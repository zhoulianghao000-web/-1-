/**
 * v1.1 1.5 — in-memory registry of review subagent sessions + reviewer tool policy.
 *
 * The Host orchestrator registers every red-team/judge child session right after
 * `subagents.startActivation()` returns, and unregisters it in `finally`. The
 * registry lives only in the Host process memory (never persisted): it is the
 * authority the tool guard uses to (a) deny dangerous tools to reviewers and
 * (b) restrict filesystem reads to the reviewed project root.
 *
 * Zero dependencies, module-level state, pure helpers — safe to import from the
 * Host entry, the orchestrator and tests.
 */

import path from 'node:path'
import { realpathSync } from 'node:fs'

/** sessionId → record. Module-level, Host process only. */
const reviewChildren = new Map()

/** realpathSync that returns null for missing/unreadable paths (never throws). */
function realPathOrNull(candidate) {
  try {
    return realpathSync(candidate)
  } catch {
    return null
  }
}

/**
 * Tools a review child must never use. Reviews are hard read-only: no shell, no
 * network fetch, no file writes, no delivery, no goal completion, no spawning
 * further agents, no team-board mutations and no user prompts.
 */
export const REVIEWER_DENIED_TOOLS = Object.freeze([
  'plugin_manager',
  'subagent',
  'subagent_fork',
  'workflow',
  'update_goal',
  'present',
  'bash',
  'pwsh',
  'write',
  'edit',
  'create_worktree',
  'ask_user_question',
  // v2.0: review children must not start/write review rounds or read the full
  // state (a round/batch would derive new child sessions and write state).
  'adversarial_review_round',
  'adversarial_review_batch',
  'adversarial_review_status',
])

const DENIED_TOOL_SET = new Set(REVIEWER_DENIED_TOOLS)

/**
 * v2.0: review children are DEFAULT-DENY. Only these tools may reach the tool
 * engine, so global readers (modlens/MCP/web) can never bypass fs confinement.
 */
export const REVIEWER_ALLOWED_TOOLS = Object.freeze([
  'read',
  'read_image',
  'glob',
  'grep',
  'read_text',
  'review_probe',
  'skill',
  // The harness uses this framework tool for the reviewer's structured result;
  // denying it makes every review child end with stopReason=error.
  'structured_output',
])

const ALLOWED_TOOL_SET = new Set(REVIEWER_ALLOWED_TOOLS)

/** Team tools all share this prefix (`team_task_*`). */
const DENIED_TOOL_PREFIXES = Object.freeze(['team_'])

/**
 * Filesystem tools whose path argument must stay inside the reviewed project.
 * Names verified against the Host tool catalog: read / read_image / glob / grep.
 * `read_text` is kept for forward compatibility if such a tool is ever mounted.
 */
export const REVIEWER_PATH_TOOLS = Object.freeze(['read', 'read_image', 'glob', 'grep', 'read_text'])

const PATH_TOOL_SET = new Set(REVIEWER_PATH_TOOLS)

/** Tools whose path argument is optional (they default to the child cwd). */
const PATH_OPTIONAL_TOOL_SET = new Set(['glob', 'grep'])

/** Canonical path key used for containment checks (Windows is case-insensitive). */
function pathKey(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') return ''
  let resolved = ''
  try {
    resolved = path.resolve(candidate.trim())
  } catch {
    return ''
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** True when `absPath` equals or lives inside `root` (Windows case-insensitive). */
export function isInsideOrEqual(root, absPath) {
  const rootKey = pathKey(root)
  const targetKey = pathKey(absPath)
  if (rootKey === '' || targetKey === '') return false
  return targetKey === rootKey || targetKey.startsWith(rootKey + path.sep)
}

function normalizeDir(targetDir) {
  if (typeof targetDir !== 'string' || targetDir.trim() === '') return ''
  try {
    return path.resolve(targetDir.trim())
  } catch {
    return ''
  }
}

function isPlainObjectLike(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function publicRecord(record) {
  return Object.freeze({
    sessionId: record.sessionId,
    targetDir: record.targetDir,
    evidenceDir: record.evidenceDir,
    stage: record.stage,
    cycleId: record.cycleId,
    registeredAt: record.registeredAt,
  })
}

/**
 * Register one review child session.
 *
 * @param {string} sessionId `activation.childId` from the subagents service
 * @param {{targetDir?: string, evidenceDir?: string, stage?: string, cycleId?: string, now?: number}} [meta]
 * @returns {object|null} frozen record, or null when the sessionId is unusable
 */
export function registerReviewChild(sessionId, meta = {}) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return null
  const id = sessionId.trim()
  const info = isPlainObjectLike(meta) ? meta : {}
  const targetDir = normalizeDir(info.targetDir)
  const record = {
    sessionId: id,
    targetDir,
    // v1.1 Stage 3 fix: the reviewer may read the evidence screenshots Host
    // rendered for THIS round (stateDir is intentionally outside the target).
    evidenceDir: normalizeDir(info.evidenceDir),
    stage: typeof info.stage === 'string' && info.stage !== '' ? info.stage : 'review',
    cycleId: typeof info.cycleId === 'string' && info.cycleId !== '' ? info.cycleId : null,
    registeredAt: Number.isFinite(info.now) ? info.now : Date.now(),
  }
  reviewChildren.set(id, record)
  return publicRecord(record)
}

/**
 * Remove a review child session (success, failure and timeout all use this).
 * @returns {boolean} true when a record was removed
 */
export function unregisterReviewChild(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return false
  return reviewChildren.delete(sessionId.trim())
}

/**
 * @param {string} sessionId
 * @returns {object|null} frozen copy of the record, or null when not a reviewer
 */
export function lookupReviewChild(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return null
  const record = reviewChildren.get(sessionId.trim())
  return record === undefined ? null : publicRecord(record)
}

/** @returns {object[]} frozen copies of every registered review child */
export function listReviewChildren() {
  return [...reviewChildren.values()].map((record) => publicRecord(record))
}

/** Drop every record (unit-test helper only). */
export function clearReviewRegistry() {
  reviewChildren.clear()
}

/**
 * Reviewer tool policy (synchronous, pure, never throws).
 *
 * Returns `null` when the call is allowed, or a Chinese rejection reason when
 * the registered review child is not allowed to use the tool.
 *
 * @param {object} record registry record from `lookupReviewChild`
 * @param {string} toolName Host tool name
 * @param {object} [args] raw tool arguments
 * @returns {string|null}
 */
export function evaluateReviewerAccess(record, toolName, args = {}) {
  try {
    if (!isPlainObjectLike(record) || typeof record.targetDir !== 'string' || record.targetDir === '') {
      return '【红队评审台】评审者工具守卫缺少评审登记信息；为防止越权，已拒绝本次工具调用。'
    }
    const name = typeof toolName === 'string' ? toolName.trim() : ''
    if (name === '') {
      return '【红队评审台】评审者工具守卫无法识别工具名；为防止越权，已拒绝本次工具调用。'
    }

    // 1) Dangerous tools: denied outright, regardless of arguments.
    if (DENIED_TOOL_SET.has(name) || name.startsWith('team_')) {
      return `【红队评审台】评审子智能体是硬只读的：禁止使用工具「${name}」。评审只能通过 review_probe 做只读检查（run-tests / check-syntax / list-files / read-text），不能改文件、装依赖、联网、交付或结束目标。`
    }

    // 2) Filesystem reads: every path must resolve inside the reviewed target.
    if (PATH_TOOL_SET.has(name)) {
      const hasFileArg = isPlainObjectLike(args) && Object.prototype.hasOwnProperty.call(args, 'file_path')
      const hasPathArg = isPlainObjectLike(args) && Object.prototype.hasOwnProperty.call(args, 'path')
      if (!hasFileArg && !hasPathArg) {
        // glob/grep default to the child cwd (= targetDir), which is safe.
        if (PATH_OPTIONAL_TOOL_SET.has(name)) return null
        return `【红队评审台】评审子智能体的「${name}」必须显式提供目标项目内的 path/file_path；缺少路径参数时已 fail-closed 拒绝。`
      }
      const raw = hasFileArg ? args.file_path : args.path
      if (typeof raw !== 'string' || raw.trim() === '') {
        return `【红队评审台】评审子智能体的「${name}」路径参数无法解析；已 fail-closed 拒绝。`
      }
      const targetDir = record.targetDir
      const evidenceDir = typeof record.evidenceDir === 'string' ? record.evidenceDir : ''
      let resolved = ''
      try {
        resolved = path.isAbsolute(raw.trim())
          ? path.resolve(raw.trim())
          : path.resolve(targetDir, raw.trim())
      } catch {
        return `【红队评审台】评审子智能体的「${name}」路径参数无法解析；已 fail-closed 拒绝。`
      }
      const insideTarget = isInsideOrEqual(targetDir, resolved)
      const insideEvidence = evidenceDir !== '' && isInsideOrEqual(evidenceDir, resolved)
      if (!insideTarget && !insideEvidence) {
        return `【红队评审台】评审子智能体只能读取被评审项目目录「${targetDir}」（以及本轮证据目录）内的文件；已拒绝访问「${raw}」（评审者不得读取 stateDir 其他部分、密钥或其他项目）。`
      }
      // v2.0 (symlink hardening): lexical containment alone can be bypassed by
      // a symlink inside the target that points at stateDir/keys. Resolve the
      // real path (when it exists) and require it to stay inside the real
      // target/evidence roots too.
      const resolvedReal = realPathOrNull(resolved)
      if (resolvedReal !== null) {
        const targetReal = realPathOrNull(targetDir) || targetDir
        const evidenceReal = evidenceDir !== '' ? (realPathOrNull(evidenceDir) || evidenceDir) : ''
        const realInsideTarget = isInsideOrEqual(targetReal, resolvedReal)
        const realInsideEvidence = evidenceReal !== '' && isInsideOrEqual(evidenceReal, resolvedReal)
        if (!realInsideTarget && !realInsideEvidence) {
          return `【红队评审台】评审子智能体的「${name}」路径经符号链接解析后指向被评审项目之外；已拒绝访问「${raw}」（评审者不得读取 stateDir 其他部分、密钥或其他项目）。`
        }
      }
    }

    // 3) Default-deny: anything not explicitly allowed is refused. This closes
    // global readers (modlens/MCP/web/...) that are not in the path-tool list.
    if (!ALLOWED_TOOL_SET.has(name)) {
      return `【红队评审台】评审子智能体是硬只读的：工具「${name}」不在允许名单（${REVIEWER_ALLOWED_TOOLS.join(', ')}）中，已拒绝。`
    }
    return null
  } catch (error) {
    return `【红队评审台】评审者工具守卫校验异常（${error?.message || error}）；为防止越权，已拒绝本次工具调用。`
  }
}
