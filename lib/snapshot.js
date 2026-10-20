/**
 * Project snapshot manifest (v1.1 1.3): a deterministic, dependency-free
 * fingerprint of the reviewed project.
 *
 * The manifest is what binds a passed review to the exact files that were
 * reviewed: `manifestHash` is a sha256 over the canonical JSON of every file
 * entry (path/size/mtimeMs/sha256), sorted by path. The content hash is only
 * computed for text-reasonable regular files inside the byte budget; oversized
 * files are recorded as `{path,size,mtimeMs,skipped:true}` so the manifest stays
 * cheap on huge projects while still detecting any file added/removed/resized.
 *
 * Two implementations are provided:
 * - `computeSnapshot()` is async (node:fs/promises) and used by a review round.
 * - `computeSnapshotSync()` is synchronous (node:fs) and is used by the
 *   synchronous tool guard (`present` / `update_goal`), which runs at step
 *   boundaries and cannot await.
 * Both share the same normalization/finalization code and must produce the same
 * `manifestHash` for the same directory (unit-tested).
 *
 * Every failure (missing path, permission error, hostile path) is returned as a
 * structured `{ok:false, error:{code,message,path?}}` object — this module never
 * throws. Symlinks are never followed (they are recorded as skipped entries) so
 * a snapshot can never leak outside the reviewed root.
 */

import { createHash } from 'node:crypto'
import fsSyncDefault from 'node:fs'
import fsDefault from 'node:fs/promises'
import path from 'node:path'

const SHA256_HEX = /^[0-9a-f]{64}$/
const GIT_SHA = /^[0-9a-f]{40,64}$/i
const MAX_SKIP_PATTERN_LENGTH = 80

/**
 * Hard limits for one snapshot. They keep a review round bounded and make the
 * synchronous guard cheap even on a big project. `skipDirs` entries are
 * matched case-insensitively against directory names and support a trailing
 * `*` wildcard (e.g. `dist-*`). Callers may append extra patterns.
 */
export const SNAPSHOT_LIMITS = Object.freeze({
  maxFiles: 20000,
  // v2.0: raised so normal build bundles are content-hashed. If a snapshot is
  // still truncated, the delivery guard fails closed (see index.js).
  maxHashBytes: 512 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  skipDirs: Object.freeze([
    '.git',
    'node_modules',
    '__pycache__',
    '.venv',
    'venv',
    // v2.0: build outputs are intentionally NOT skipped. They are often the
    // delivered artifact, so the post-review snapshot guard must cover them.
    // (.next and dist* are therefore hashed like normal source files.)
    '.cache',
    'coverage',
    '.idea',
    '.vscode',
  ]),
})

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/** Merge caller limits over `SNAPSHOT_LIMITS`; extra skipDirs are appended. */
export function resolveSnapshotLimits(rawLimits) {
  const source = isPlainObject(rawLimits) ? rawLimits : {}
  const extraSkip = Array.isArray(source.skipDirs)
    ? source.skipDirs
      .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
      .map((entry) => entry.trim().slice(0, MAX_SKIP_PATTERN_LENGTH))
    : []
  const skipDirs = []
  const seen = new Set()
  for (const entry of [...SNAPSHOT_LIMITS.skipDirs, ...extraSkip]) {
    const key = entry.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    skipDirs.push(entry)
  }
  return {
    maxFiles: positiveInteger(source.maxFiles, SNAPSHOT_LIMITS.maxFiles),
    maxHashBytes: positiveInteger(source.maxHashBytes, SNAPSHOT_LIMITS.maxHashBytes),
    maxFileBytes: positiveInteger(source.maxFileBytes, SNAPSHOT_LIMITS.maxFileBytes),
    skipDirs,
  }
}

/**
 * True when a directory name is excluded from the manifest.
 * Supports exact names and one trailing `*` wildcard (`dist-*`).
 */
export function isSkippedDirName(name, skipDirs = SNAPSHOT_LIMITS.skipDirs) {
  const candidate = typeof name === 'string' ? name.toLowerCase() : ''
  if (candidate === '') return false
  for (const pattern of Array.isArray(skipDirs) ? skipDirs : []) {
    const normalized = String(pattern).toLowerCase()
    if (normalized === '') continue
    if (normalized.endsWith('*')) {
      if (candidate.startsWith(normalized.slice(0, -1))) return true
    } else if (candidate === normalized) {
      return true
    }
  }
  return false
}

/** Forward-slash relative path (stable across platforms for hashing). */
function toManifestPath(relativeParts) {
  return relativeParts.join('/')
}

function snapshotFailure(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } }
}

function finalizeSnapshot(options = {}) {
  const {
    targetDir,
    files,
    fileCount,
    hashedBytes,
    truncated,
    skippedCount,
    now,
  } = options
  const sorted = [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const canonicalFiles = sorted.map((entry) => (entry.sha256 === undefined
    ? { path: entry.path, size: entry.size, mtimeMs: entry.mtimeMs, skipped: true }
    : { path: entry.path, size: entry.size, mtimeMs: entry.mtimeMs, sha256: entry.sha256 }))
  const manifestHash = createHash('sha256')
    .update(canonicalJson({ schemaVersion: 1, files: canonicalFiles }), 'utf8')
    .digest('hex')
  return {
    ok: true,
    schemaVersion: 1,
    targetDir,
    createdAt: now,
    fileCount,
    hashedBytes,
    truncated,
    skippedCount,
    files: canonicalFiles,
    manifestHash,
  }
}

/** Small local canonical JSON stringifier (sorted object keys, arrays in order). */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? 'null' : encoded
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`
  }
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function entryMtimeMs(statValue) {
  const value = typeof statValue?.mtimeMs === 'number' && Number.isFinite(statValue.mtimeMs) ? statValue.mtimeMs : 0
  return Math.round(value)
}

function entrySize(statValue) {
  const value = typeof statValue?.size === 'number' && Number.isFinite(statValue.size) ? statValue.size : 0
  return Math.max(0, Math.round(value))
}

function normalizeNow(nowOption) {
  if (typeof nowOption === 'function') {
    try {
      const value = nowOption()
      if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value)
    } catch {
      // A broken clock provider must not break the snapshot.
    }
  }
  return Date.now()
}

/**
 * Compute a manifest with node:fs/promises.
 *
 * @param {string} targetDir absolute or relative directory to snapshot
 * @param {object} [options]
 * @param {object} [options.fs] promises-style fs implementation (tests)
 * @param {object} [options.limits] overrides/additions for SNAPSHOT_LIMITS
 * @param {Function} [options.now]
 * @returns {Promise<object>} snapshot document, or `{ok:false, error:{...}}`
 */
export async function computeSnapshot(targetDir, options = {}) {
  const fsImpl = isPlainObject(options) && options.fs ? options.fs : fsDefault
  const limits = resolveSnapshotLimits(isPlainObject(options) ? options.limits : null)
  const now = normalizeNow(isPlainObject(options) ? options.now : undefined)
  const root = typeof targetDir === 'string' ? targetDir.trim() : ''
  if (root === '') return snapshotFailure('EINVAL', '快照缺少 target 目录')
  let resolvedRoot = ''
  try {
    resolvedRoot = path.resolve(root)
  } catch (error) {
    return snapshotFailure('EINVAL', `无法解析 target 路径：${root}`, { cause: String(error?.message || error) })
  }
  let rootStat = null
  try {
    rootStat = await fsImpl.stat(resolvedRoot)
  } catch (error) {
    return snapshotFailure(error?.code || 'ENOENT', `target 目录不可访问：${resolvedRoot}（${error?.code || error?.message || error}）`, { path: resolvedRoot })
  }
  if (!rootStat || typeof rootStat.isDirectory !== 'function' || !rootStat.isDirectory()) {
    return snapshotFailure('ENOTDIR', `target 不是目录：${resolvedRoot}`, { path: resolvedRoot })
  }

  const files = []
  let fileCount = 0
  let hashedBytes = 0
  let skippedCount = 0
  let truncated = false
  const stack = [{ absolute: resolvedRoot, parts: [] }]
  let budgetExceeded = false

  try {
    while (stack.length > 0) {
      const current = stack.pop()
      let entries = []
      try {
        entries = await fsImpl.readdir(current.absolute, { withFileTypes: true })
      } catch (error) {
        return snapshotFailure(error?.code || 'EACCES', `无法读取目录：${current.absolute}（${error?.code || error?.message || error}）`, { path: current.absolute })
      }
      const names = (Array.isArray(entries) ? entries : []).map((entry) => String(entry?.name ?? '')).filter((name) => name !== '')
      names.sort()
      const subdirs = []
      for (const name of names) {
        const absolute = path.join(current.absolute, name)
        const parts = [...current.parts, name]
        let statValue = null
        try {
          statValue = await fsImpl.lstat(absolute)
        } catch (error) {
          return snapshotFailure(error?.code || 'ENOENT', `无法读取文件信息：${absolute}（${error?.code || error?.message || error}）`, { path: absolute })
        }
        if (typeof statValue?.isSymbolicLink === 'function' && statValue.isSymbolicLink()) {
          // v2.0: symlinks are not hashed (they could escape the reviewed root)
          // and cannot be granted a safe delivery guarantee. Fail the snapshot
          // with an actionable message instead of making a passed round
          // permanently undeliverable via skippedCount.
          return snapshotFailure(
            'SYMLINK_UNSUPPORTED',
            `项目包含符号链接，无法生成可验证的快照：${toManifestPath(parts)}。请移除符号链接（或替换为普通文件）后重新评审；如确需链接，请改用构建流程复制内容。`,
            { path: absolute },
          )
        }
        if (typeof statValue?.isDirectory === 'function' && statValue.isDirectory()) {
          if (isSkippedDirName(name, limits.skipDirs)) continue
          subdirs.push({ absolute, parts })
          continue
        }
        if (typeof statValue?.isFile !== 'function' || !statValue.isFile()) {
          // Sockets/FIFOs/devices cannot be reliably hashed; record size only.
          files.push({ path: toManifestPath(parts), size: 0, mtimeMs: entryMtimeMs(statValue) })
          fileCount += 1
          skippedCount += 1
          continue
        }
        if (files.length >= limits.maxFiles) {
          truncated = true
          break
        }
        const size = entrySize(statValue)
        const mtimeMs = entryMtimeMs(statValue)
        let sha256 = null
        if (size > limits.maxFileBytes || budgetExceeded) {
          skippedCount += 1
        } else if (hashedBytes + size > limits.maxHashBytes) {
          budgetExceeded = true
          skippedCount += 1
        } else {
          let buffer = null
          try {
            buffer = await fsImpl.readFile(absolute)
          } catch (error) {
            return snapshotFailure(error?.code || 'EACCES', `无法读取文件：${absolute}（${error?.code || error?.message || error}）`, { path: absolute })
          }
          const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
          if (bytes.length > limits.maxFileBytes) {
            skippedCount += 1
          } else if (hashedBytes + bytes.length > limits.maxHashBytes) {
            budgetExceeded = true
            skippedCount += 1
          } else {
            sha256 = createHash('sha256').update(bytes).digest('hex')
            hashedBytes += bytes.length
          }
        }
        const entry = { path: toManifestPath(parts), size, mtimeMs }
        if (sha256 !== null) entry.sha256 = sha256
        files.push(entry)
        fileCount += 1
      }
      if (truncated) break
      // Reverse so the smallest name is processed first with a LIFO stack.
      for (let index = subdirs.length - 1; index >= 0; index -= 1) stack.push(subdirs[index])
    }
  } catch (error) {
    return snapshotFailure(error?.code || 'EIO', `生成快照时发生内部错误：${error?.message || error}`, { path: resolvedRoot })
  }

  return finalizeSnapshot({
    targetDir: resolvedRoot,
    files,
    fileCount,
    hashedBytes,
    truncated,
    skippedCount,
    now,
  })
}

/**
 * Synchronous twin of `computeSnapshot` (node:fs). Used by the tool guard,
 * which runs synchronously; the resulting `manifestHash` must equal the async
 * one for the same directory.
 *
 * @param {string} targetDir
 * @param {object} [options]
 * @param {object} [options.fsSync] sync fs implementation (tests)
 * @param {object} [options.limits]
 * @param {Function} [options.now]
 * @returns {object} snapshot document, or `{ok:false, error:{...}}`
 */
export function computeSnapshotSync(targetDir, options = {}) {
  const fsImpl = isPlainObject(options) && options.fsSync ? options.fsSync : fsSyncDefault
  const limits = resolveSnapshotLimits(isPlainObject(options) ? options.limits : null)
  const now = normalizeNow(isPlainObject(options) ? options.now : undefined)
  const root = typeof targetDir === 'string' ? targetDir.trim() : ''
  if (root === '') return snapshotFailure('EINVAL', '快照缺少 target 目录')
  let resolvedRoot = ''
  try {
    resolvedRoot = path.resolve(root)
  } catch (error) {
    return snapshotFailure('EINVAL', `无法解析 target 路径：${root}`, { cause: String(error?.message || error) })
  }
  let rootStat = null
  try {
    rootStat = fsImpl.statSync(resolvedRoot)
  } catch (error) {
    return snapshotFailure(error?.code || 'ENOENT', `target 目录不可访问：${resolvedRoot}（${error?.code || error?.message || error}）`, { path: resolvedRoot })
  }
  if (!rootStat || typeof rootStat.isDirectory !== 'function' || !rootStat.isDirectory()) {
    return snapshotFailure('ENOTDIR', `target 不是目录：${resolvedRoot}`, { path: resolvedRoot })
  }

  const files = []
  let fileCount = 0
  let hashedBytes = 0
  let skippedCount = 0
  let truncated = false
  const stack = [{ absolute: resolvedRoot, parts: [] }]
  let budgetExceeded = false

  try {
    while (stack.length > 0) {
      const current = stack.pop()
      let entries = []
      try {
        entries = fsImpl.readdirSync(current.absolute, { withFileTypes: true })
      } catch (error) {
        return snapshotFailure(error?.code || 'EACCES', `无法读取目录：${current.absolute}（${error?.code || error?.message || error}）`, { path: current.absolute })
      }
      const names = (Array.isArray(entries) ? entries : []).map((entry) => String(entry?.name ?? '')).filter((name) => name !== '')
      names.sort()
      const subdirs = []
      for (const name of names) {
        const absolute = path.join(current.absolute, name)
        const parts = [...current.parts, name]
        let statValue = null
        try {
          statValue = fsImpl.lstatSync(absolute)
        } catch (error) {
          return snapshotFailure(error?.code || 'ENOENT', `无法读取文件信息：${absolute}（${error?.code || error?.message || error}）`, { path: absolute })
        }
        if (typeof statValue?.isSymbolicLink === 'function' && statValue.isSymbolicLink()) {
          return snapshotFailure(
            'SYMLINK_UNSUPPORTED',
            `项目包含符号链接，无法生成可验证的快照：${toManifestPath(parts)}。请移除符号链接（或替换为普通文件）后重新评审；如确需链接，请改用构建流程复制内容。`,
            { path: absolute },
          )
        }
        if (typeof statValue?.isDirectory === 'function' && statValue.isDirectory()) {
          if (isSkippedDirName(name, limits.skipDirs)) continue
          subdirs.push({ absolute, parts })
          continue
        }
        if (typeof statValue?.isFile !== 'function' || !statValue.isFile()) {
          files.push({ path: toManifestPath(parts), size: 0, mtimeMs: entryMtimeMs(statValue) })
          fileCount += 1
          skippedCount += 1
          continue
        }
        if (files.length >= limits.maxFiles) {
          truncated = true
          break
        }
        const size = entrySize(statValue)
        const mtimeMs = entryMtimeMs(statValue)
        let sha256 = null
        if (size > limits.maxFileBytes || budgetExceeded) {
          skippedCount += 1
        } else if (hashedBytes + size > limits.maxHashBytes) {
          budgetExceeded = true
          skippedCount += 1
        } else {
          let buffer = null
          try {
            buffer = fsImpl.readFileSync(absolute)
          } catch (error) {
            return snapshotFailure(error?.code || 'EACCES', `无法读取文件：${absolute}（${error?.code || error?.message || error}）`, { path: absolute })
          }
          const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
          if (bytes.length > limits.maxFileBytes) {
            skippedCount += 1
          } else if (hashedBytes + bytes.length > limits.maxHashBytes) {
            budgetExceeded = true
            skippedCount += 1
          } else {
            sha256 = createHash('sha256').update(bytes).digest('hex')
            hashedBytes += bytes.length
          }
        }
        const entry = { path: toManifestPath(parts), size, mtimeMs }
        if (sha256 !== null) entry.sha256 = sha256
        files.push(entry)
        fileCount += 1
      }
      if (truncated) break
      for (let index = subdirs.length - 1; index >= 0; index -= 1) stack.push(subdirs[index])
    }
  } catch (error) {
    return snapshotFailure(error?.code || 'EIO', `生成快照时发生内部错误：${error?.message || error}`, { path: resolvedRoot })
  }

  return finalizeSnapshot({
    targetDir: resolvedRoot,
    files,
    fileCount,
    hashedBytes,
    truncated,
    skippedCount,
    now,
  })
}

function isSafeRefName(refName) {
  if (typeof refName !== 'string' || refName === '' || refName.length > 300) return false
  if (!/^[A-Za-z0-9._/-]+$/.test(refName)) return false
  return !refName.split('/').some((part) => part === '' || part === '.' || part === '..')
}

function readFirstLine(filePath) {
  try {
    const text = fsSyncDefault.readFileSync(filePath, 'utf8')
    return String(text).split(/\r?\n/)[0].trim()
  } catch {
    return ''
  }
}

/**
 * Best-effort current git commit for `targetDir`, without ever running `git`.
 *
 * Supports a normal `.git/` directory, a `.git` file pointing at a worktree
 * gitdir, loose refs and `packed-refs`. Returns a lowercase commit hash, or
 * null when the directory is not a readable git checkout.
 */
export function findGitCommit(targetDir) {
  try {
    const root = typeof targetDir === 'string' ? path.resolve(targetDir.trim()) : ''
    if (root === '') return null
    const dotGit = path.join(root, '.git')
    let gitDir = dotGit
    let dotGitStat = null
    try {
      dotGitStat = fsSyncDefault.statSync(dotGit)
    } catch {
      return null
    }
    if (typeof dotGitStat?.isFile === 'function' && dotGitStat.isFile()) {
      const content = fsSyncDefault.readFileSync(dotGit, 'utf8')
      const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(String(content))
      if (match === null) return null
      gitDir = path.resolve(root, match[1])
    } else if (typeof dotGitStat?.isDirectory !== 'function' || !dotGitStat.isDirectory()) {
      return null
    }
    const head = readFirstLine(path.join(gitDir, 'HEAD'))
    if (head === '') return null
    if (GIT_SHA.test(head)) return head.toLowerCase()
    const refMatch = /^ref:\s*(.+)$/.exec(head)
    if (refMatch === null) return null
    const refName = refMatch[1].trim()
    if (!isSafeRefName(refName)) return null
    const loose = readFirstLine(path.join(gitDir, ...refName.split('/')))
    if (GIT_SHA.test(loose)) return loose.toLowerCase()
    try {
      const packed = fsSyncDefault.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8')
      for (const line of String(packed).split(/\r?\n/)) {
        const match = /^([0-9a-f]{40,64})\s+(\S+)$/i.exec(line.trim())
        if (match !== null && match[2] === refName) return match[1].toLowerCase()
      }
    } catch {
      // packed-refs is optional
    }
    return null
  } catch {
    return null
  }
}

export { SHA256_HEX, GIT_SHA }
