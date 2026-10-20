/**
 * v1.2 2.4 — modeling metrics sandbox (`review_probe` action `run-metrics`).
 *
 * A modeling project declares reproducible commands in `modeling-run.json` at
 * its root:
 *
 *   {
 *     "commands": [["python3", "run.py"], ["node", "scripts/eval.js"]],
 *     "metricsFile": "metrics.json",      // optional, default metrics.json
 *     "timeoutSeconds": 120               // optional per-command budget
 *   }
 *
 * The Host copies the project to a throwaway temp directory (exactly the
 * `run-tests` copy budget from lib/probe.js), runs every command **without a
 * shell** (`spawn(argv[0], argv.slice(1))`, cwd = the temp copy) with an
 * offline environment (npm offline, proxy endpoints pointed at a dead loopback
 * port, fixed PYTHONHASHSEED), kills the process tree on timeout, then reads the
 * declared metrics JSON from the COPY. The reviewed project itself is never
 * written; the copy and all browsers/processes are cleaned up in `finally`.
 *
 * Security limits (documented, not an OS sandbox):
 * - writes: only the temp copy is intended to be written (cwd + TMPDIR point at
 *   it); a hostile project could still write elsewhere on the machine with the
 *   Host user's permissions — reviewers only run projects whose commands are
 *   inspected first, and the project is frozen by the review snapshot;
 * - network: blocked at the environment level only (proxy vars / offline env);
 *   it is NOT a firewall;
 * - outputs: stdout/stderr tails ≤4000 chars, metrics JSON ≤64KB, ≤20 commands,
 *   ≤600s whole run.
 *
 * This module never throws: failures become `{ok:false, action:'run-metrics',
 * error, ...}` so the probe tool can report them safely.
 */

import { createHash } from 'node:crypto'
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  LIMITS,
  MODELING_DEFAULT_METRICS_FILE,
  MODELING_RUN_FILE,
} from './constants.js'
import { captureProcess, copyTree, planCopy, tailOf } from './probe.js'
import { redactText, redactValue } from './redact.js'

const MAX_RELATIVE_PATH_CHARS = 500

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false
  return true
}

function safeKillTree(child) {
  if (child === null || typeof child !== 'object') return
  try {
    if (typeof child.kill === 'function') child.kill()
  } catch {
    // best effort
  }
  const pid = Number.isInteger(child.pid) ? child.pid : null
  if (process.platform === 'win32' && pid !== null) {
    try {
      nodeSpawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 })
    } catch {
      // best effort
    }
  }
}

function resolveDeps(overrides) {
  const source = isPlainObject(overrides) ? overrides : {}
  return {
    spawn: typeof source.spawn === 'function' ? source.spawn : nodeSpawn,
    killTree: typeof source.killTree === 'function' ? source.killTree : safeKillTree,
    makeTempDir: typeof source.makeTempDir === 'function'
      ? source.makeTempDir
      : () => fs.mkdtemp(path.join(os.tmpdir(), 'rtc-sandbox-')),
    removeTempDir: typeof source.removeTempDir === 'function'
      ? source.removeTempDir
      : (dir) => fs.rm(dir, { recursive: true, force: true }),
    fsImpl: isPlainObject(source.fsImpl) ? source.fsImpl : fs,
    now: typeof source.now === 'function' ? source.now : Date.now,
  }
}

/** Environment handed to every sandboxed command: whitelisted + offline + deterministic. */
export function buildSandboxEnv(baseEnv = process.env, options = {}) {
  const { tmpDir = '' } = isPlainObject(options) ? options : {}
  const SAFE_KEYS = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC',
    'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  ]
  const env = {}
  for (const key of SAFE_KEYS) {
    if (isPlainObject(baseEnv) && baseEnv[key] !== undefined) env[key] = baseEnv[key]
  }
  env.npm_config_offline = 'true'
  env.npm_config_audit = 'false'
  env.npm_config_fund = 'false'
  env.HTTP_PROXY = 'http://127.0.0.1:9'
  env.HTTPS_PROXY = 'http://127.0.0.1:9'
  env.http_proxy = 'http://127.0.0.1:9'
  env.https_proxy = 'http://127.0.0.1:9'
  env.ALL_PROXY = 'http://127.0.0.1:9'
  env.all_proxy = 'http://127.0.0.1:9'
  env.PYTHONHASHSEED = '0'
  env.PIP_NO_INDEX = '1'
  env.GIT_TERMINAL_PROMPT = '0'
  if (typeof tmpDir === 'string' && tmpDir !== '') {
    env.TMPDIR = tmpDir
    env.TMP = tmpDir
    env.TEMP = tmpDir
  }
  return env
}

/**
 * Validate the project-declared `modeling-run.json` payload.
 * @returns {{ok:true, commands: string[][], metricsFile: string, timeoutSeconds: number, warnings: string[]}|{ok:false, error: string}}
 */
export function validateModelingRunDeclaration(parsed, options = {}) {
  const { defaultTimeoutSeconds = 120 } = isPlainObject(options) ? options : {}
  if (!isPlainObject(parsed)) return { ok: false, error: 'modeling-run.json 必须是一个 JSON 对象' }
  const warnings = []
  if (!Array.isArray(parsed.commands) || parsed.commands.length === 0) {
    return { ok: false, error: 'modeling-run.json 缺少 commands（需为非空的 argv 数组数组，如 [["python3","run.py"]]）' }
  }
  if (parsed.commands.length > LIMITS.modelingMaxCommands) {
    return { ok: false, error: `modeling-run.json 的 commands 最多 ${LIMITS.modelingMaxCommands} 条（收到 ${parsed.commands.length} 条）` }
  }
  const commands = []
  for (let index = 0; index < parsed.commands.length; index += 1) {
    const entry = parsed.commands[index]
    const label = `commands[${index}]`
    if (!Array.isArray(entry) || entry.length === 0) {
      return { ok: false, error: `${label} 必须是 argv 数组（例如 ["node","run.js"]）；不支持 shell 字符串` }
    }
    if (entry.length - 1 > LIMITS.modelingMaxArgs) {
      return { ok: false, error: `${label} 参数过多（最多 ${LIMITS.modelingMaxArgs} 个参数）` }
    }
    const argv = []
    for (const rawArg of entry) {
      if (typeof rawArg !== 'string' || rawArg.trim() === '') {
        return { ok: false, error: `${label} 的每个 argv 元素必须是非空字符串` }
      }
      if (rawArg.length > LIMITS.modelingMaxArgChars) {
        return { ok: false, error: `${label} 的 argv 元素过长（最多 ${LIMITS.modelingMaxArgChars} 字符）` }
      }
      if (rawArg.includes('\0')) return { ok: false, error: `${label} 的 argv 含 NUL 字节` }
      argv.push(rawArg)
    }
    commands.push(argv)
  }
  let metricsFile = MODELING_DEFAULT_METRICS_FILE
  if (parsed.metricsFile !== undefined && parsed.metricsFile !== null) {
    if (typeof parsed.metricsFile !== 'string' || parsed.metricsFile.trim() === '') {
      return { ok: false, error: 'modeling-run.json 的 metricsFile 必须是非空相对路径字符串' }
    }
    metricsFile = parsed.metricsFile.trim()
    if (metricsFile.length > MAX_RELATIVE_PATH_CHARS || metricsFile.includes('\0')) {
      return { ok: false, error: 'modeling-run.json 的 metricsFile 非法' }
    }
    if (path.isAbsolute(metricsFile)) {
      return { ok: false, error: `modeling-run.json 的 metricsFile 必须是项目内相对路径：${metricsFile}` }
    }
    const normalized = path.posix.normalize(metricsFile.split(path.sep).join('/'))
    if (normalized === '..' || normalized.startsWith('../') || normalized === '.') {
      return { ok: false, error: `modeling-run.json 的 metricsFile 必须位于项目内：${metricsFile}` }
    }
  }
  let timeoutSeconds = Number.isFinite(defaultTimeoutSeconds) && defaultTimeoutSeconds > 0
    ? Math.min(600, Math.max(1, Math.round(defaultTimeoutSeconds)))
    : 120
  if (parsed.timeoutSeconds !== undefined && parsed.timeoutSeconds !== null) {
    const numeric = Number(parsed.timeoutSeconds)
    if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 600) {
      return { ok: false, error: 'modeling-run.json 的 timeoutSeconds 必须是 1–600 的数字' }
    }
    timeoutSeconds = Math.min(600, Math.max(1, Math.round(numeric)))
    warnings.push(`modeling-run.json 覆盖了每命令超时为 ${timeoutSeconds} 秒。`)
  }
  return { ok: true, commands, metricsFile, timeoutSeconds, warnings }
}

async function readDeclaration(targetDir, config, deps) {
  const runFile = path.join(targetDir, MODELING_RUN_FILE)
  let buffer = null
  try {
    buffer = await deps.fsImpl.readFile(runFile)
  } catch (error) {
    return {
      ok: false,
      error: `项目缺少 ${MODELING_RUN_FILE}（需在 target 根声明 {commands:[[argv...]], metricsFile?, timeoutSeconds?}，由 Host 在只读临时副本中执行）。${error?.code === 'ENOENT' ? '文件不存在。' : (error?.message || '')}`,
    }
  }
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer)
  if (buffer.length > LIMITS.modelingRunFileMaxBytes) {
    return { ok: false, error: `${MODELING_RUN_FILE} 超过大小上限（${LIMITS.modelingRunFileMaxBytes} 字节）` }
  }
  let parsed = null
  try {
    parsed = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    return { ok: false, error: `${MODELING_RUN_FILE} 不是合法 JSON：${error?.message || error}` }
  }
  const defaultTimeoutSeconds = Number.isFinite(config?.modelingTimeoutSeconds) && config.modelingTimeoutSeconds > 0
    ? config.modelingTimeoutSeconds
    : 120
  const checked = validateModelingRunDeclaration(parsed, { defaultTimeoutSeconds })
  if (!checked.ok) return { ok: false, error: checked.error }
  return { ok: true, declaration: checked, sha256: createHash('sha256').update(buffer).digest('hex') }
}

function commandLabel(argv) {
  const text = argv.join(' ')
  return text.length > 300 ? `${text.slice(0, 299)}…` : text
}

/**
 * Run a project's declared modeling commands in a throws-away copy and collect
 * the declared metrics JSON. Never throws.
 *
 * @param {object} options
 * @param {string} options.targetDir reviewed project root (read-only)
 * @param {object} [options.config] effective plugin config
 * @param {object} [options.deps] injected spawn/killTree/temp-fs/now (tests)
 * @returns {Promise<object>} compact probe result
 */
export async function runModelingMetrics(options = {}) {
  const source = isPlainObject(options) ? options : {}
  const { targetDir = '', config = {}, deps: rawDeps } = source
  const deps = resolveDeps(rawDeps)
  const startedAt = deps.now()
  const action = 'run-metrics'
  const sandbox = { network: 'blocked-env', writes: 'temp-copy-only' }
  const warnings = []
  const base = { action, sandbox }
  if (typeof targetDir !== 'string' || targetDir.trim() === '') {
    return { ok: false, ...base, error: '缺少被评审项目目录（targetDir）' }
  }
  const declarationResult = await readDeclaration(targetDir, config, deps)
  if (!declarationResult.ok) return { ok: false, ...base, error: declarationResult.error }
  const declaration = declarationResult.declaration
  warnings.push(...declaration.warnings)
  const maxFiles = Number.isInteger(config?.probeMaxCopyFiles) && config.probeMaxCopyFiles > 0
    ? config.probeMaxCopyFiles
    : 20000
  const maxBytes = Number.isInteger(config?.probeMaxCopyBytes) && config.probeMaxCopyBytes > 0
    ? config.probeMaxCopyBytes
    : 100 * 1024 * 1024
  const plan = await planCopy(targetDir, { maxFiles, maxBytes })
  if (!plan.ok) {
    return { ok: false, ...base, error: plan.error, warnings: [...warnings, ...(Array.isArray(plan.warnings) ? plan.warnings : [])] }
  }
  warnings.push(...(Array.isArray(plan.warnings) ? plan.warnings : []))
  let copyRoot = ''
  try {
    copyRoot = await deps.makeTempDir()
  } catch (error) {
    return { ok: false, ...base, error: `无法创建沙箱临时副本目录：${error?.message || error}`, warnings }
  }
  const result = {
    ok: false,
    action,
    sandbox,
    commands: [],
    exitCodes: [],
    durationMs: 0,
    metrics: null,
    metricsFile: declaration.metricsFile,
    stdoutTail: '',
    stderrTail: '',
    copiedFiles: 0,
    copiedBytes: 0,
    truncated: false,
    timedOut: false,
    declarationSha256: declarationResult.sha256,
    warnings,
  }
  let stdoutAll = ''
  let stderrAll = ''
  let outputTruncated = false
  try {
    const copied = await copyTree(targetDir, copyRoot, plan.files, deps.fsImpl)
    if (!copied.ok) return { ...result, error: copied.error }
    result.copiedFiles = plan.files.length
    result.copiedBytes = plan.bytes
    // Metrics file must stay inside the throw-away copy (also checked earlier).
    const metricsPath = path.resolve(copyRoot, declaration.metricsFile)
    if (!isInside(copyRoot, metricsPath)) {
      return { ...result, error: `metricsFile 解析后不在临时副本内：${declaration.metricsFile}` }
    }
    const env = buildSandboxEnv(process.env, { tmpDir: copyRoot })
    const perCommandMs = Math.max(1, Math.round(declaration.timeoutSeconds)) * 1000
    const overallSeconds = Math.min(LIMITS.modelingMaxTotalSeconds, declaration.timeoutSeconds * declaration.commands.length)
    const deadline = startedAt + Math.max(1, overallSeconds) * 1000
    let firstError = ''
    for (let index = 0; index < declaration.commands.length; index += 1) {
      const argv = declaration.commands[index]
      const remaining = deadline - deps.now()
      if (remaining <= 50) {
        result.timedOut = true
        result.exitCodes.push(null)
        result.commands.push({ command: [...argv], exitCode: null, timedOut: true, durationMs: 0, skipped: true })
        if (firstError === '') firstError = `总预算 ${overallSeconds} 秒已用尽，第 ${index + 1} 条命令未执行`
        warnings.push(`run-metrics 总预算 ${overallSeconds} 秒用尽：第 ${index + 1} 条及后续命令已跳过。`)
        break
      }
      const timeoutMs = Math.max(50, Math.min(perCommandMs, remaining))
      const capture = await captureProcess({
        spawnFn: deps.spawn,
        killTree: deps.killTree,
        command: argv[0],
        args: argv.slice(1),
        cwd: copyRoot,
        env,
        timeoutMs,
      })
      const exitCode = Number.isInteger(capture.exitCode) ? capture.exitCode : null
      result.exitCodes.push(exitCode)
      result.commands.push({
        command: [...argv],
        exitCode,
        timedOut: capture.timedOut === true,
        durationMs: Number.isFinite(capture.durationMs) ? Math.max(0, Math.round(capture.durationMs)) : 0,
      })
      if (capture.timedOut === true) {
        result.timedOut = true
        warnings.push(`第 ${index + 1} 条命令执行超过 ${Math.round(timeoutMs / 1000)} 秒，已终止进程树。`)
      }
      const commandHeader = `$ ${commandLabel(argv)}\n`
      stdoutAll += `${commandHeader}${capture.stdout ?? ''}\n`
      stderrAll += `${commandHeader}${capture.stderr ?? ''}\n`
      if (capture.error !== null && capture.error !== undefined) {
        if (firstError === '') firstError = `第 ${index + 1} 条命令启动/执行失败：${capture.error?.message || capture.error}`
      } else if (capture.timedOut === true) {
        if (firstError === '') firstError = `第 ${index + 1} 条命令超时（${Math.round(timeoutMs / 1000)} 秒），已终止进程树`
      } else if (capture.exitCode !== 0) {
        if (firstError === '') firstError = `第 ${index + 1} 条命令退出码 ${capture.exitCode === null ? 'null' : capture.exitCode}（${commandLabel(argv)}）`
      }
    }
    const stdoutTail = tailOf(stdoutAll, LIMITS.probeOutputTailChars)
    const stderrTail = tailOf(stderrAll, LIMITS.probeOutputTailChars)
    result.stdoutTail = redactText(stdoutTail.text)
    result.stderrTail = redactText(stderrTail.text)
    outputTruncated = stdoutTail.truncated || stderrTail.truncated
    // Read the metrics JSON from the COPY, never from the reviewed project.
    // v2.0: refuse symlinks and any realpath escape from the throw-away copy.
    let metricsBuffer = null
    let metricsEscaped = false
    try {
      if (typeof deps.fsImpl.realpath === 'function') {
        const realMetrics = await deps.fsImpl.realpath(metricsPath)
        if (!isInside(copyRoot, realMetrics)) {
          metricsEscaped = true
          if (firstError === '') firstError = `metricsFile 经 realpath 解析到临时副本之外：${declaration.metricsFile}`
        }
      }
    } catch {
      // Missing metrics file is reported by the read below.
    }
    if (!metricsEscaped) {
      try {
        const metricsStat = await deps.fsImpl.lstat(metricsPath)
        if (typeof metricsStat?.isSymbolicLink === 'function' && metricsStat.isSymbolicLink()) {
          if (firstError === '') firstError = `metricsFile 不能是符号链接：${declaration.metricsFile}`
        } else {
          metricsBuffer = await deps.fsImpl.readFile(metricsPath)
        }
      } catch (error) {
        if (firstError === '') firstError = `未找到指标文件「${declaration.metricsFile}」：命令执行后应在临时副本中生成（${error?.code || error?.message || error}）`
      }
    }
    if (metricsBuffer !== null) {
      if (!Buffer.isBuffer(metricsBuffer)) metricsBuffer = Buffer.from(metricsBuffer)
      if (metricsBuffer.length > LIMITS.modelingMetricsMaxBytes) {
        if (firstError === '') firstError = `指标文件超过上限（${metricsBuffer.length} 字节 > ${LIMITS.modelingMetricsMaxBytes} 字节）`
      } else {
        try {
          const parsedMetrics = JSON.parse(metricsBuffer.toString('utf8').replace(/^\uFEFF/, ''))
          if (!isPlainObject(parsedMetrics)) {
            if (firstError === '') firstError = '指标文件必须是 JSON 对象'
          } else {
            result.metrics = redactValue(parsedMetrics)
          }
        } catch (error) {
          if (firstError === '') firstError = `指标文件不是合法 JSON：${error?.message || error}`
        }
      }
    }
    const allCommandsPassed = result.commands.length === declaration.commands.length
      && result.commands.every((entry) => entry.timedOut !== true && entry.exitCode === 0 && entry.skipped !== true)
    result.truncated = outputTruncated
    result.ok = allCommandsPassed && result.metrics !== null && !result.timedOut
    result.durationMs = Math.max(0, deps.now() - startedAt)
    if (!result.ok && firstError !== '') result.error = firstError
    else if (!result.ok) result.error = 'run-metrics 未成功（命令或指标文件不满足要求）'
    return result
  } catch (error) {
    return { ...result, durationMs: Math.max(0, deps.now() - startedAt), error: `run-metrics 执行异常：${error?.message || error}` }
  } finally {
    try {
      await deps.removeTempDir(copyRoot)
    } catch {
      // Temp cleanup is best effort and must never mask the result.
    }
  }
}
