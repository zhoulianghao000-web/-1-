/**
 * v1.1 1.5 — `review_probe` Host implementation.
 *
 * Review subagents (red team + judges) no longer have shell or network tools in
 * their presets. They can only ask the Host to run a small whitelist of
 * read-only actions against the reviewed project:
 *
 * - `list-files`   read-only tree listing of the target (excluded dirs skipped)
 * - `read-text`    read one text file inside the target (size-capped, binary rejected)
 * - `check-syntax` `node --check` every .js/.mjs file in the target (read-only, concurrency ≤4)
 * - `run-tests`    copy the target to a throwaway temp dir and run `npm test` there
 * - `run-metrics`  v1.2 2.4: copy the target, run the project-declared
 *                  `modeling-run.json` commands offline in that copy and return
 *                  the declared metrics JSON (see `lib/sandbox.js`)
 *
 * Every action is confined to the `targetDir` recorded in the review registry;
 * `run-tests` never writes to the reviewed project — only to its temp copy, which
 * is removed afterwards (best-effort, failures never throw). All spawns capture
 * output, obey a timeout and kill the process tree; this module never throws.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { LIMITS } from './constants.js'
import { redactText } from './redact.js'
import { isInsideOrEqual, lookupReviewChild } from './review-registry.js'

/** v2.0: never inherit host secrets into project commands. */
const SAFE_PROBE_ENV_KEYS = Object.freeze([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
])

/** Minimal, secret-free environment for `run-tests` inside the temp copy. */
export function buildProbeEnv(extra = {}) {
  const env = {}
  for (const key of SAFE_PROBE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  Object.assign(env, extra)
  env.npm_config_offline = 'true'
  env.npm_config_audit = 'false'
  env.npm_config_fund = 'false'
  env.HTTP_PROXY = 'http://127.0.0.1:9'
  env.HTTPS_PROXY = 'http://127.0.0.1:9'
  env.http_proxy = 'http://127.0.0.1:9'
  env.https_proxy = 'http://127.0.0.1:9'
  return env
}

/** Directories never traversed by `list-files` / `check-syntax`. */
export const PROBE_EXCLUDED_DIRS = Object.freeze([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  '.next',
  '.cache',
  'coverage',
])

/** Directory-name prefixes never traversed (e.g. webpack `dist-*` builds). */
const PROBE_EXCLUDED_PREFIXES = Object.freeze(['dist-'])

/** Copy-plan exclusions: `.git` always; `node_modules` only on the retry pass. */
const COPY_SKIP_BASE = Object.freeze(['.git'])
const COPY_SKIP_SMALL = Object.freeze(['.git', 'node_modules'])

export const PROBE_ACTIONS = Object.freeze(['run-tests', 'check-syntax', 'list-files', 'read-text', 'run-metrics'])

const SYNTAX_EXTENSIONS = Object.freeze(['.js', '.mjs'])
/** Hard cap on captured process output held in memory (tails only survive). */
const CAPTURE_MEMORY_CHARS = 256 * 1024
const SYNTAX_ERROR_CHARS = 1200
const MAX_COPY_PATH_CHARS = 4000

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function toPositiveInt(value, fallback, min, max) {
  const numeric = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.floor(numeric)))
}

function resolveInside(root, raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const text = raw.trim()
  let resolved = ''
  try {
    resolved = path.isAbsolute(text) ? path.resolve(text) : path.resolve(root, text)
  } catch {
    return null
  }
  return isInsideOrEqual(root, resolved) ? resolved : null
}

function relativeTo(root, absPath) {
  try {
    const relative = path.relative(root, absPath)
    return relative === '' ? '.' : relative.split(path.sep).join('/')
  } catch {
    return absPath
  }
}

function shouldSkipDir(name) {
  if (PROBE_EXCLUDED_DIRS.includes(name)) return true
  return PROBE_EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/**
 * Read-only recursive walk. Symbolic links are never followed (prevents escapes
 * through links inside the reviewed project).
 *
 * @returns {Promise<{files: {path: string, size: number}[], truncated: boolean, bytes: number}>}
 */
async function walkTree(root, options = {}) {
  const {
    skipDirNames = [],
    maxFiles = Number.POSITIVE_INFINITY,
    budgetBytes = Number.POSITIVE_INFINITY,
    withSize = false,
    filter = null,
    fsImpl = fs,
    // `list-files` / `check-syntax` skip the heavy build/dependency dirs; the
    // temp-copy planner must NOT skip node_modules by default (only via
    // `skipDirNames`, so the "include node_modules unless over budget" rule
    // can be expressed by the caller).
    excludeHeavyDirs = true,
  } = isPlainObject(options) ? options : {}
  const skip = new Set(skipDirNames)
  const files = []
  let bytes = 0
  let truncated = false
  const pending = [root]
  while (pending.length > 0) {
    if (files.length >= maxFiles || bytes >= budgetBytes) {
      truncated = true
      break
    }
    const current = pending.shift()
    let entries = []
    try {
      entries = await fsImpl.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (files.length >= maxFiles || bytes >= budgetBytes) {
        truncated = true
        break
      }
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (skip.has(entry.name) || (excludeHeavyDirs && shouldSkipDir(entry.name))) continue
        pending.push(full)
        continue
      }
      if (!entry.isFile()) continue
      if (typeof filter === 'function' && !filter(full)) continue
      let size = 0
      if (withSize) {
        try {
          const stat = await fsImpl.stat(full)
          size = Number.isFinite(stat.size) ? stat.size : 0
        } catch {
          continue
        }
      }
      files.push({ path: full, size })
      bytes += size
    }
  }
  if (files.length >= maxFiles || bytes >= budgetBytes) truncated = true
  return { files, truncated, bytes }
}

async function realRoot(targetDir) {
  try {
    return await fs.realpath(targetDir)
  } catch {
    return targetDir
  }
}

/** Resolve + prove a path is a real file/dir inside the reviewed target. */
async function resolveExistingInside(targetDir, raw) {
  const resolved = resolveInside(targetDir, raw)
  if (resolved === null) return { ok: false, error: `路径不在被评审项目目录内：${String(raw)}` }
  let real = ''
  try {
    real = await fs.realpath(resolved)
  } catch {
    return { ok: false, error: `路径不存在或不可访问：${String(raw)}` }
  }
  const root = await realRoot(targetDir)
  if (!isInsideOrEqual(root, real)) return { ok: false, error: `路径不在被评审项目目录内：${String(raw)}` }
  return { ok: true, resolved: real }
}

// ---------------------------------------------------------------------------
// list-files
// ---------------------------------------------------------------------------

async function probeListFiles({ targetDir, args }) {
  const maxFiles = toPositiveInt(args.maxFiles, LIMITS.probeDefaultListFiles, 1, LIMITS.probeMaxListFiles)
  let base = targetDir
  if (typeof args.path === 'string' && args.path.trim() !== '') {
    const checked = await resolveExistingInside(targetDir, args.path)
    if (!checked.ok) return { ok: false, action: 'list-files', error: checked.error }
    base = checked.resolved
  }
  let stat = null
  try {
    stat = await fs.stat(base)
  } catch (error) {
    return { ok: false, action: 'list-files', error: `目录不可访问：${error?.message || error}` }
  }
  if (!stat.isDirectory()) {
    return {
      ok: true,
      action: 'list-files',
      root: relativeTo(targetDir, base),
      files: [{ path: relativeTo(targetDir, base), size: stat.size }],
      count: 1,
      truncated: false,
    }
  }
  const walked = await walkTree(base, { maxFiles, withSize: true })
  const files = walked.files.map((file) => ({
    path: relativeTo(targetDir, file.path),
    size: file.size,
  }))
  return {
    ok: true,
    action: 'list-files',
    root: relativeTo(targetDir, base),
    files,
    count: files.length,
    truncated: walked.truncated,
  }
}

// ---------------------------------------------------------------------------
// read-text
// ---------------------------------------------------------------------------

async function probeReadText({ targetDir, args }) {
  if (typeof args.path !== 'string' || args.path.trim() === '') {
    return { ok: false, action: 'read-text', error: 'read-text 需要 path 参数（被评审项目内的文件相对路径）' }
  }
  const maxBytes = toPositiveInt(args.maxBytes, LIMITS.probeDefaultReadBytes, 1, LIMITS.probeMaxReadBytes)
  const checked = await resolveExistingInside(targetDir, args.path)
  if (!checked.ok) return { ok: false, action: 'read-text', error: checked.error }
  let stat = null
  try {
    stat = await fs.stat(checked.resolved)
  } catch (error) {
    return { ok: false, action: 'read-text', error: `文件不可访问：${error?.message || error}` }
  }
  if (!stat.isFile()) return { ok: false, action: 'read-text', error: `不是普通文件：${String(args.path)}` }
  if (stat.size > maxBytes) {
    return {
      ok: false,
      action: 'read-text',
      error: `文件超过读取上限（${stat.size} 字节 > 上限 ${maxBytes} 字节）：${relativeTo(targetDir, checked.resolved)}`,
    }
  }
  let buffer = null
  try {
    buffer = await fs.readFile(checked.resolved)
  } catch (error) {
    return { ok: false, action: 'read-text', error: `文件读取失败：${error?.message || error}` }
  }
  if (buffer.includes(0)) {
    return { ok: false, action: 'read-text', error: `拒绝读取二进制文件（包含 NUL 字节）：${relativeTo(targetDir, checked.resolved)}` }
  }
  const content = buffer.toString('utf8')
  return {
    ok: true,
    action: 'read-text',
    path: relativeTo(targetDir, checked.resolved),
    bytes: buffer.length,
    content,
  }
}

// ---------------------------------------------------------------------------
// process capture (child_process wrapper)
// ---------------------------------------------------------------------------

/** Trim a captured stream to its tail (exported for `lib/sandbox.js` reuse). */
export function tailOf(buffer, maxChars) {
  const text = typeof buffer === 'string' ? buffer : ''
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(text.length - maxChars), truncated: true }
}

function defaultKillTree(child) {
  if (child === null || typeof child !== 'object') return
  try {
    if (typeof child.kill === 'function') child.kill('SIGKILL')
  } catch {
    // Best-effort kill only.
  }
  const pid = child.pid
  if (process.platform === 'win32' && Number.isInteger(pid) && pid > 0) {
    try {
      const killer = nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      if (killer && typeof killer.on === 'function') killer.on('error', () => {})
    } catch {
      // taskkill is a best-effort tree kill; the direct kill above already ran.
    }
  }
}

/** Spawn one command, capture its output, enforce a timeout and kill the tree.
 * Resolves (never rejects) with `{exitCode, stdout, stderr, timedOut, error, ...}`.
 * Exported so `lib/sandbox.js` uses the exact same capture/kill semantics.
 */
export function captureProcess(options = {}) {  const {
    spawnFn = nodeSpawn,
    killTree = defaultKillTree,
    command,
    args = [],
    cwd = undefined,
    env = undefined,
    timeoutMs = 120_000,
  } = isPlainObject(options) ? options : {}
  return new Promise((resolve) => {
    let child = null
    try {
      child = spawnFn(command, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, error, durationMs: 0 })
      return
    }
    if (child === null || typeof child !== 'object' || typeof child.on !== 'function') {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, error: new Error('spawn 未返回可用的子进程'), durationMs: 0 })
      return
    }
    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    let stdoutChars = 0
    let stderrChars = 0
    let settled = false
    let timedOut = false
    let timer = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve({ ...result, durationMs: Math.max(0, Date.now() - startedAt) })
    }
    timer = setTimeout(() => {
      timedOut = true
      try {
        killTree(child)
      } catch {
        // killTree is best-effort; resolve promptly so the probe never hangs.
      }
      finish({ exitCode: null, stdout, stderr, timedOut: true, error: null })
    }, Math.max(20, Math.round(timeoutMs)))
    const append = (target, chunk) => {
      let text = ''
      try {
        text = typeof chunk === 'string' ? chunk : String(chunk)
      } catch {
        text = ''
      }
      return text
    }
    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => {
        const text = append(stdout, chunk)
        stdoutChars += text.length
        stdout += text
        if (stdout.length > CAPTURE_MEMORY_CHARS) stdout = stdout.slice(-CAPTURE_MEMORY_CHARS)
      })
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => {
        const text = append(stderr, chunk)
        stderrChars += text.length
        stderr += text
        if (stderr.length > CAPTURE_MEMORY_CHARS) stderr = stderr.slice(-CAPTURE_MEMORY_CHARS)
      })
    }
    child.on('error', (error) => {
      finish({ exitCode: null, stdout, stderr, timedOut, error })
    })
    child.on('close', (code, signal) => {
      finish({
        exitCode: Number.isInteger(code) ? code : null,
        stdout,
        stderr,
        timedOut,
        signal: typeof signal === 'string' ? signal : null,
        error: null,
        stdoutChars,
        stderrChars,
      })
    })
  })
}

// ---------------------------------------------------------------------------
// check-syntax
// ---------------------------------------------------------------------------

function syntaxFailureFor(file, capture) {
  if (capture !== null && capture.timedOut === true) return '语法检查超时（process killed）'
  if (capture !== null && capture.error !== null && capture.error !== undefined) {
    return `无法执行 node --check：${capture.error?.message || capture.error}`
  }
  const stderr = redactText(tailOf(capture?.stderr ?? '', SYNTAX_ERROR_CHARS).text.trim())
  if (stderr !== '') return stderr
  return `node --check 退出码 ${capture?.exitCode ?? 'null'}`
}

async function probeCheckSyntax({ targetDir, deps, args }) {
  const startedAt = deps.now()
  const maxFiles = LIMITS.probeMaxSyntaxFiles
  let base = targetDir
  if (typeof args.path === 'string' && args.path.trim() !== '') {
    const checked = await resolveExistingInside(targetDir, args.path)
    if (!checked.ok) return { ok: false, action: 'check-syntax', error: checked.error }
    base = checked.resolved
  }
  const walked = await walkTree(base, {
    maxFiles: maxFiles + 1,
    filter: (full) => SYNTAX_EXTENSIONS.includes(path.extname(full).toLowerCase()),
  })
  const files = walked.files.slice(0, maxFiles)
  const deadline = startedAt + LIMITS.probeSyntaxTimeoutMs
  const failures = []
  let checked = 0
  let timedOut = false
  let cursor = 0
  const runOne = async (file) => {
    const remaining = deadline - deps.now()
    if (remaining <= 0) {
      timedOut = true
      return
    }
    const capture = await captureProcess({
      spawnFn: deps.spawn,
      killTree: deps.killTree,
      command: process.execPath,
      args: ['--check', file.path],
      // v2.0: keep the same whitelisted, secret-free env as run-tests.
      env: buildProbeEnv(),
      timeoutMs: Math.max(500, remaining),
    })
    checked += 1
    if (capture.timedOut === true) timedOut = true
    if (capture.exitCode === 0 && capture.error === null && capture.timedOut !== true) return
    failures.push({ file: relativeTo(targetDir, file.path), error: syntaxFailureFor(file.path, capture) })
  }
  const workers = Array.from(
    { length: Math.max(1, Math.min(LIMITS.probeSyntaxConcurrency, files.length)) },
    async () => {
      while (true) {
        if (deps.now() >= deadline) {
          timedOut = true
          return
        }
        const index = cursor
        cursor += 1
        if (index >= files.length) return
        await runOne(files[index])
      }
    },
  )
  await Promise.all(workers)
  return {
    ok: true,
    action: 'check-syntax',
    checked,
    failures,
    filesFound: files.length,
    truncated: walked.truncated || files.length < walked.files.length,
    timedOut,
    durationMs: Math.max(0, deps.now() - startedAt),
  }
}

// ---------------------------------------------------------------------------
// run-tests (read-only temp copy)
// ---------------------------------------------------------------------------

/** Copy the planned files into the throwaway temp root (exported for sandbox reuse). */
export async function copyTree(sourceRoot, copyRoot, files, fsImpl) {
  for (const file of files) {
    const relative = path.relative(sourceRoot, file.path)
    if (relative === '' || relative.length > MAX_COPY_PATH_CHARS) continue
    const destination = path.join(copyRoot, relative)
    const destinationDir = path.dirname(destination)
    try {
      await fsImpl.mkdir(destinationDir, { recursive: true })
      await fsImpl.copyFile(file.path, destination)
    } catch (error) {
      return { ok: false, error: `复制临时副本失败：${error?.message || error}` }
    }
  }
  return { ok: true }
}

/**
 * Plan the copy: every target file except `.git` within the configured budget.
 * If that is too large, retry without `node_modules` (with a warning).
 * Exported so `lib/sandbox.js` uses the same copy budget rules.
 */
export async function planCopy(targetDir, { maxFiles, maxBytes }) {
  const full = await walkTree(targetDir, {
    skipDirNames: COPY_SKIP_BASE,
    maxFiles: maxFiles + 1,
    budgetBytes: maxBytes + 1,
    withSize: true,
    excludeHeavyDirs: false,
  })
  if (full.files.length <= maxFiles && full.bytes <= maxBytes) {
    return { ok: true, files: full.files, bytes: full.bytes, skippedNodeModules: false, warnings: [] }
  }
  const small = await walkTree(targetDir, {
    skipDirNames: COPY_SKIP_SMALL,
    maxFiles: maxFiles + 1,
    budgetBytes: maxBytes + 1,
    withSize: true,
    excludeHeavyDirs: false,
  })
  if (small.files.length <= maxFiles && small.bytes <= maxBytes) {
    return {
      ok: true,
      files: small.files,
      bytes: small.bytes,
      skippedNodeModules: true,
      warnings: [`node_modules 未复制到临时副本（超出 probeMaxCopyBytes=${maxBytes} / probeMaxCopyFiles=${maxFiles} 预算），测试可能因缺少依赖失败。`],
    }
  }
  return {
    ok: false,
    error: `项目文件数/体积超过只读副本上限（probeMaxCopyFiles=${maxFiles}、probeMaxCopyBytes=${maxBytes}），已拒绝在临时副本中运行测试。`,
    files: [],
    bytes: 0,
    warnings: [],
  }
}

async function probeRunTests({ targetDir, config, deps }) {
  const startedAt = deps.now()
  const timeoutSeconds = Math.max(0.05, Number.isFinite(config?.probeTimeoutSeconds) && config.probeTimeoutSeconds > 0
    ? config.probeTimeoutSeconds
    : 120)
  const maxFiles = toPositiveInt(config?.probeMaxCopyFiles, 20000, 1, 200000)
  const maxBytes = toPositiveInt(config?.probeMaxCopyBytes, 100 * 1024 * 1024, 1024, 2 * 1024 * 1024 * 1024)
  const plan = await planCopy(targetDir, { maxFiles, maxBytes })
  if (!plan.ok) return { ok: false, action: 'run-tests', command: 'npm test', error: plan.error, warnings: plan.warnings }

  let copyRoot = ''
  try {
    copyRoot = await deps.makeTempDir()
  } catch (error) {
    return { ok: false, action: 'run-tests', command: 'npm test', error: `无法创建临时副本目录：${error?.message || error}` }
  }
  const warnings = [...plan.warnings]
  let copiedFiles = 0
  let copiedBytes = 0
  try {
    const copied = await copyTree(targetDir, copyRoot, plan.files, deps.fsImpl)
    if (!copied.ok) return { ok: false, action: 'run-tests', command: 'npm test', error: copied.error, warnings }
    copiedFiles = plan.files.length
    copiedBytes = plan.bytes

    // The package script is read from the COPY, never from the project itself.
    let packageJson = null
    try {
      const packageText = String(await deps.fsImpl.readFile(path.join(copyRoot, 'package.json'), 'utf8')).replace(/^\uFEFF/, '')
      packageJson = JSON.parse(packageText)
    } catch (error) {
      // No readable package.json means no `scripts.test`: do not guess a
      // command, return the same explicit error (detail kept in warnings).
      return {
        ok: false,
        action: 'run-tests',
        command: 'npm test',
        error: '项目没有 package.json scripts.test',
        copiedFiles,
        copiedBytes,
        warnings: [...warnings, `package.json 读取/解析失败：${error?.code || error?.message || error}`],
      }
    }
    const testScript = isPlainObject(packageJson?.scripts) ? packageJson.scripts.test : undefined
    if (typeof testScript !== 'string' || testScript.trim() === '') {
      return {
        ok: false,
        action: 'run-tests',
        command: 'npm test',
        error: '项目没有 package.json scripts.test',
        copiedFiles,
        copiedBytes,
        warnings,
      }
    }

    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const args = ['test']
    const env = buildProbeEnv()
    let capture = await captureProcess({
      spawnFn: deps.spawn,
      killTree: deps.killTree,
      command,
      args,
      cwd: copyRoot,
      env,
      timeoutMs: Math.max(50, Math.round(timeoutSeconds * 1000)),
    })
    let invokedCommand = `${command} ${args.join(' ')}`
    // Windows does not execute `.cmd` files through CreateProcess: a plain
    // `spawn('npm.cmd')` fails with `spawn EINVAL`. Retry once through the
    // command interpreter (still a fixed command, no caller-controlled text).
    const spawnErrorCode = typeof capture.error?.code === 'string' ? capture.error.code : ''
    if (process.platform === 'win32' && capture.error !== null && capture.error !== undefined
      && capture.timedOut !== true && ['EINVAL', 'ENOENT', 'EPERM'].includes(spawnErrorCode)) {
      warnings.push(`直接启动「${command}」失败（${spawnErrorCode}）：改用 ${process.env.ComSpec || 'cmd.exe'} /d /s /c "npm test" 重试。`)
      capture = await captureProcess({
        spawnFn: deps.spawn,
        killTree: deps.killTree,
        command: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', 'npm test'],
        cwd: copyRoot,
        env,
        timeoutMs: Math.max(50, Math.round(timeoutSeconds * 1000)),
      })
      invokedCommand = `${process.env.ComSpec || 'cmd.exe'} /d /s /c "npm test"`
    }
    const stdout = tailOf(capture.stdout, LIMITS.probeOutputTailChars)
    const stderr = tailOf(capture.stderr, LIMITS.probeOutputTailChars)
    if (capture.timedOut === true) {
      warnings.push(`测试命令超过 probeTimeoutSeconds=${timeoutSeconds} 秒，已终止进程树。`)
    }
    const spawnError = capture.error ?? null
    const ok = capture.timedOut !== true && spawnError === null && capture.exitCode === 0
    const result = {
      ok,
      action: 'run-tests',
      command: invokedCommand,
      exitCode: capture.exitCode ?? null,
      durationMs: Math.max(0, deps.now() - startedAt),
      stdoutTail: redactText(stdout.text),
      stderrTail: redactText(stderr.text),
      copiedFiles,
      copiedBytes,
      truncated: stdout.truncated || stderr.truncated,
      timedOut: capture.timedOut === true,
      warnings,
    }
    if (spawnError !== null) result.error = `测试命令启动/执行失败：${spawnError?.message || spawnError}`
    else if (capture.timedOut === true) result.error = `测试命令超时（${timeoutSeconds} 秒），已终止进程树。`
    else if (capture.exitCode !== 0) result.error = `测试命令退出码 ${capture.exitCode ?? 'null'}（测试未通过）`
    return result
  } finally {
    // Temp copy cleanup must never throw, and must not mask the probe result.
    try {
      await deps.removeTempDir(copyRoot)
    } catch {
      // Best-effort cleanup only.
    }
  }
}

// ---------------------------------------------------------------------------
// public entry
// ---------------------------------------------------------------------------

function defaultDeps() {
  return {
    spawn: nodeSpawn,
    killTree: defaultKillTree,
    makeTempDir: () => fs.mkdtemp(path.join(os.tmpdir(), 'rtc-probe-')),
    removeTempDir: (dir) => fs.rm(dir, { recursive: true, force: true }),
    fsImpl: fs,
    now: Date.now,
  }
}

function resolveDeps(overrides) {
  const base = defaultDeps()
  if (!isPlainObject(overrides)) return base
  const merged = { ...base }
  for (const key of Object.keys(base)) {
    if (overrides[key] !== undefined && overrides[key] !== null) merged[key] = overrides[key]
  }
  return merged
}

function rejectNonReviewer() {
  return { ok: false, error: 'review_probe 仅限评审子智能体使用' }
}

/**
 * Execute one `review_probe` call. Never throws.
 *
 * @param {object} options
 * @param {object} options.args raw tool arguments
 * @param {object|null} options.execution tool execution context (`execag.agent`)
 * @param {object} options.config effective plugin config
 * @param {object} [options.deps] test injection point (spawn/killTree/temp dir/fs)
 * @returns {Promise<object>} compact JSON result (text-rendered by the tool)
 */
export async function runReviewProbe(options = {}) {
  const opts = isPlainObject(options) ? options : {}
  const deps = resolveDeps(opts.deps)
  const execution = opts.execution ?? null
  const agentId = typeof execution?.agent?.id === 'string' ? execution.agent.id : ''
  const record = lookupReviewChild(agentId)
  if (record === null) return rejectNonReviewer()
  const targetDir = typeof record.targetDir === 'string' ? record.targetDir : ''
  if (targetDir === '') {
    return { ok: false, error: '评审登记缺少被评审项目目录（targetDir），无法执行 review_probe。' }
  }
  const args = isPlainObject(opts.args) ? opts.args : {}
  const action = typeof args.action === 'string' ? args.action.trim() : ''
  if (!PROBE_ACTIONS.includes(action)) {
    return { ok: false, error: `参数 action 必须是 ${PROBE_ACTIONS.join(' / ')} 之一` }
  }
  const config = isPlainObject(opts.config) ? opts.config : {}
  try {
    if (action === 'list-files') return await probeListFiles({ targetDir, args })
    if (action === 'read-text') return await probeReadText({ targetDir, args })
    if (action === 'check-syntax') return await probeCheckSyntax({ targetDir, deps, args })
    if (action === 'run-metrics') {
      // Dynamic import keeps the static module graph acyclic: sandbox.js imports
      // the copy/capture helpers from this module.
      const { runModelingMetrics } = await import('./sandbox.js')
      return await runModelingMetrics({ targetDir, config, deps })
    }
    return await probeRunTests({ targetDir, config, deps })
  } catch (error) {
    return { ok: false, action, error: `review_probe 执行异常：${error?.message || error}` }
  }
}
