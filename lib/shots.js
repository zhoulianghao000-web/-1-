/**
 * Screenshot evidence for the red-team console (CONTRACT.md §2.5).
 *
 * Uses a headless Chrome/Edge binary via `--screenshot` — no browser automation
 * dependency. The pure helpers (`pngDimensions`, `normalizeSpecs`,
 * `resolveChromePath`, file-url conversion) are unit tested; `renderShots`
 * accepts injected spawn/fs/resolver functions so tests never launch a browser.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync as nodeExistsSync, readdirSync as nodeReaddirSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_SHOT_VIEWPORTS, LIMITS } from './constants.js'

const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** Contract: a valid evidence screenshot must be larger than 1KB. */
const MIN_PNG_BYTES = 1024
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,80}$/
const SHOT_FILE_NAME = /^r\d{1,4}-s\d{1,4}-[A-Za-z0-9._-]{1,80}\.png$/
const ENTRY_CANDIDATES = Object.freeze(['index.html', 'public/index.html', 'dist/index.html', 'src/index.html'])
const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 800

/** Parse PNG width/height from the IHDR chunk; null for anything that is not a PNG. */
export function pngDimensions(input) {
  if (input === null || input === undefined) return null
  let buffer = null
  if (Buffer.isBuffer(input)) buffer = input
  else if (input instanceof Uint8Array) buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  else if (Array.isArray(input)) buffer = Buffer.from(input)
  if (buffer === null || buffer.length < 33) return null
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (buffer[index] !== PNG_SIGNATURE[index]) return null
  }
  const chunkLength = buffer.readUInt32BE(8)
  if (chunkLength !== 13) return null
  const chunkType = buffer.toString('latin1', 12, 16)
  if (chunkType !== 'IHDR') return null
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

/** Convert an absolute filesystem path to a `file://` URL. */
export function pathToFileUrl(absPath) {
  const resolved = path.resolve(absPath)
  if (/^[A-Za-z]:[\\/]/.test(resolved)) {
    const posix = resolved.replace(/\\/g, '/')
    const [drive, ...segments] = posix.split('/')
    return `file:///${drive}/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`
  }
  const segments = resolved.split('/').map((segment, index) => (index === 0 ? '' : encodeURIComponent(segment)))
  return `file://${segments.join('/')}`
}

/** Slug used in screenshot filenames: lowercase ascii, dashes, max 32 chars. */
export function slugifyName(value, fallback = 'shot') {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug === '' ? fallback : slug
}

/** `r<N>-s<K>-<slug>.png` (K is 1-based). */
export function buildShotFilename(roundNo, index, name) {
  const round = Number.isInteger(roundNo) && roundNo > 0 ? roundNo : 1
  const shotIndex = Number.isInteger(index) && index >= 0 ? index + 1 : 1
  return `r${round}-s${shotIndex}-${slugifyName(name, `shot-${shotIndex}`)}.png`
}

/** First existing auto-detected entry file under the target, or null. */
export function detectEntryFile(options = {}) {
  const {
    targetDir,
    exists = nodeExistsSync,
    candidates = ENTRY_CANDIDATES,
  } = options
  if (typeof targetDir !== 'string' || targetDir.trim() === '') return null
  for (const candidate of candidates) {
    const absPath = path.join(targetDir, ...String(candidate).split('/'))
    try {
      if (exists(absPath)) return absPath
    } catch {
      // Treat unreadable entries as absent.
    }
  }
  return null
}

/** Four default viewport specs for the detected entry page. */
export function buildDefaultSpecs(options = {}) {
  const {
    targetDir,
    entryFile,
    viewports = DEFAULT_SHOT_VIEWPORTS,
    requiredShots = 4,
  } = options
  const viewportList = Array.isArray(viewports) && viewports.length > 0 ? viewports : DEFAULT_SHOT_VIEWPORTS
  const count = Math.max(1, Math.min(LIMITS.maxShots, Number.isInteger(requiredShots) ? requiredShots : viewportList.length))
  const relativeEntry = path.relative(path.resolve(targetDir), path.resolve(entryFile))
  const entryPath = relativeEntry !== '' ? relativeEntry : path.basename(entryFile)
  return Array.from({ length: count }, (_unused, index) => {
    const viewport = viewportList[index % viewportList.length]
    const cycle = Math.floor(index / viewportList.length) + 1
    return {
      kind: 'path',
      path: entryPath,
      width: viewport.width,
      height: viewport.height,
      name: cycle > 1 ? `${viewport.name || 'shot'}-${cycle}` : (viewport.name || `shot-${index + 1}`),
      page: entryPath.split(path.sep).join('/'),
    }
  })
}

/** Shared width/height normalization for screenshots and evidence cards. */
export function normalizeDimension(value, fallback, warnings, label) {
  if (value === undefined || value === null) return fallback
  const numeric = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN)
  if (!Number.isFinite(numeric)) {
    warnings.push(`${label} 不是合法数字，已使用默认值 ${fallback}`)
    return fallback
  }
  const rounded = Math.round(numeric)
  if (rounded < 100 || rounded > 8000) {
    warnings.push(`${label}（${rounded}）超出 100–8000 范围，已使用默认值 ${fallback}`)
    return fallback
  }
  return rounded
}

/** v1.1 1.4: loopback hostnames allowed for http(s) screenshot URLs. */
export function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return false
  const normalized = hostname.trim().toLowerCase()
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') return true
  if (normalized === '127.0.0.1') return true
  return normalized === '::ffff:127.0.0.1' || normalized === '[::ffff:127.0.0.1]'
}

/** Canonical origins from config `allowedOrigins` (invalid entries ignored). */
export function normalizeAllowedOrigins(allowedOrigins) {
  const origins = new Set()
  if (!Array.isArray(allowedOrigins)) return origins
  for (const entry of allowedOrigins) {
    if (typeof entry !== 'string' || entry.trim() === '') continue
    try {
      const parsed = new URL(entry.trim())
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origins.add(parsed.origin)
    } catch {
      // An unparsable allowlist entry is ignored, it must never widen access.
    }
  }
  return origins
}

/**
 * Validate and resolve screenshot specs.
 *
 * Accepts exactly `requiredShots` entries; each provides exactly one of `path`
 * (resolved inside the target) or `url`. v1.1 1.4 URL allowlist: an http(s)
 * URL is only accepted when its hostname is loopback (`127.0.0.1` / `::1` /
 * `localhost`, any port) or its exact origin is configured in
 * `allowedOrigins` (e.g. `http://127.0.0.1:3000`). Duplicates are rejected.
 * Returns `{ok:true, specs, warnings}` or `{ok:false, error}`.
 */
export function normalizeSpecs(rawSpecs, options = {}) {
  const {
    targetDir,
    requiredShots = 4,
    maxShots = LIMITS.maxShots,
    allowedOrigins = [],
  } = options
  if (!Array.isArray(rawSpecs)) return { ok: false, error: 'shots 必须是数组（每个元素提供 path 或 url）' }
  if (rawSpecs.length > maxShots) return { ok: false, error: `shots 最多允许 ${maxShots} 个，本次收到 ${rawSpecs.length} 个` }
  if (rawSpecs.length !== requiredShots) {
    return {
      ok: false,
      error: `截图规格必须恰好 ${requiredShots} 个（本次收到 ${rawSpecs.length} 个）。留空 shots 时工具会自动探测页面并渲染 ${requiredShots} 张。`,
    }
  }
  if (typeof targetDir !== 'string' || targetDir.trim() === '') {
    return { ok: false, error: '缺少 target 目录，无法解析截图 path' }
  }
  const resolvedTarget = path.resolve(targetDir)
  const allowedOriginSet = normalizeAllowedOrigins(allowedOrigins)
  const warnings = []
  const specs = []
  const seenPaths = new Map()
  const seenUrls = new Map()

  for (let index = 0; index < rawSpecs.length; index += 1) {
    const raw = rawSpecs[index]
    const label = `第 ${index + 1} 个截图规格`
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, error: `${label} 必须是对象` }
    }
    const rawPath = typeof raw.path === 'string' ? raw.path.trim() : ''
    const rawUrl = typeof raw.url === 'string' ? raw.url.trim() : ''
    if (rawPath !== '' && rawUrl !== '') {
      return { ok: false, error: `${label} 不能同时提供 path 和 url（二者互斥）` }
    }
    if (rawPath === '' && rawUrl === '') {
      return { ok: false, error: `${label} 必须提供 path 或 url 之一` }
    }
    const width = normalizeDimension(raw.width, DEFAULT_WIDTH, warnings, `${label} 的 width`)
    const height = normalizeDimension(raw.height, DEFAULT_HEIGHT, warnings, `${label} 的 height`)
    const rawName = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim().slice(0, 64) : `shot-${index + 1}`

    if (rawUrl !== '') {
      let parsed = null
      try {
        parsed = new URL(rawUrl)
      } catch {
        return { ok: false, error: `${label} 的 url 不是合法 URL：${rawUrl}` }
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: `${label} 的 url 只允许 http/https（收到 ${parsed.protocol}）：${rawUrl}` }
      }
      // v1.1 1.4 URL allowlist: loopback hosts or an explicitly configured origin.
      const hostname = parsed.hostname.toLowerCase()
      const originAllowed = allowedOriginSet.has(parsed.origin)
      if (!isLoopbackHostname(hostname) && !originAllowed) {
        return {
          ok: false,
          error: `${label} 的 url 主机不在白名单：${parsed.origin}（只允许 127.0.0.1 / ::1 / localhost 或配置项 allowedOrigins 中显式列出的 origin）`,
        }
      }
      // The same page may be captured at different viewports; only an
      // identical URL+viewport pair is a real duplicate.
      const key = `${parsed.href}|${width}x${height}`
      if (seenUrls.has(key)) {
        return { ok: false, error: `${label} 与第 ${seenUrls.get(key) + 1} 个截图规格重复（url 与视口尺寸相同）` }
      }
      seenUrls.set(key, index)
      specs.push({
        kind: 'url',
        url: parsed.href,
        width,
        height,
        name: rawName,
        page: parsed.href,
      })
      continue
    }

    const resolvedPath = path.resolve(resolvedTarget, rawPath)
    const relative = path.relative(resolvedTarget, resolvedPath)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      return { ok: false, error: `${label} 的 path 必须位于 target 目录内：${rawPath}` }
    }
    const pathIdentity = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath
    const key = `${pathIdentity}|${width}x${height}`
    if (seenPaths.has(key)) {
      return { ok: false, error: `${label} 与第 ${seenPaths.get(key) + 1} 个截图规格重复（path 与视口尺寸相同）：${rawPath}` }
    }
    seenPaths.set(key, index)
    specs.push({
      kind: 'path',
      path: resolvedPath,
      width,
      height,
      name: rawName,
      page: relative.split(path.sep).join('/'),
    })
  }
  return { ok: true, specs, warnings }
}

function isFileCandidate(exists, candidate) {
  try {
    return exists(candidate)
  } catch {
    return false
  }
}

function readDirSafe(readdir, dir) {
  try {
    return readdir(dir)
  } catch {
    return []
  }
}

/**
 * Resolve the browser binary in the contract's order:
 * config.chromePath → DSH_CHROME_PATH → playwright chromium-* (version desc) →
 * Program Files Chrome → Edge (x86 then x64) → optional non-Windows fallbacks.
 *
 * @returns {{path: string|null, source: string|null, warnings: string[]}}
 */
export function resolveChromePath(options = {}) {
  const {
    chromePath = '',
    env = process.env,
    platform = process.platform,
    home = os.homedir(),
    exists = nodeExistsSync,
    readdir = nodeReaddirSync,
  } = options
  const warnings = []
  const checked = new Set()
  const probe = (candidate, source) => {
    if (typeof candidate !== 'string' || candidate.trim() === '') return null
    const resolved = path.resolve(candidate.trim())
    if (checked.has(resolved)) return null
    checked.add(resolved)
    return isFileCandidate(exists, resolved) ? { path: resolved, source } : null
  }

  const configured = typeof chromePath === 'string' ? chromePath.trim() : ''
  if (configured !== '') {
    const hit = probe(configured, 'config')
    if (hit) return { ...hit, warnings }
    warnings.push(`config.chromePath 指向的浏览器不存在：${configured}（继续尝试其它来源）`)
  }

  const envPath = typeof env?.DSH_CHROME_PATH === 'string' ? env.DSH_CHROME_PATH.trim() : ''
  if (envPath !== '') {
    const hit = probe(envPath, 'env')
    if (hit) return { ...hit, warnings }
    warnings.push(`DSH_CHROME_PATH 指向的浏览器不存在：${envPath}（继续尝试其它来源）`)
  }

  if (platform === 'win32') {
    const localAppData = typeof env?.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.trim() !== ''
      ? env.LOCALAPPDATA.trim()
      : path.join(home, 'AppData', 'Local')
    const playwrightRoot = path.join(localAppData, 'ms-playwright')
    // Prefer Playwright's dedicated headless shell. On this deployment the
    // full Chrome/Edge binaries hang at startup in the host session, while the
    // shell renders the same pages (identical `--screenshot` behavior and
    // exact requested PNG dimensions).
    const shellVersions = []
    for (const name of readDirSafe(readdir, playwrightRoot)) {
      const match = /^chromium_headless_shell-(\d+)/.exec(String(name))
      if (match) shellVersions.push({ name: String(name), version: Number(match[1]) })
    }
    shellVersions.sort((left, right) => right.version - left.version || left.name.localeCompare(right.name))
    for (const entry of shellVersions) {
      for (const subdir of ['chrome-headless-shell-win64', 'chrome-headless-shell-win']) {
        const hit = probe(
          path.join(playwrightRoot, entry.name, subdir, 'chrome-headless-shell.exe'),
          'playwright-headless-shell',
        )
        if (hit) return { ...hit, warnings }
      }
    }
    const versions = []
    for (const name of readDirSafe(readdir, playwrightRoot)) {
      const match = /^chromium-(\d+)/.exec(String(name))
      if (match) versions.push({ name: String(name), version: Number(match[1]) })
    }
    versions.sort((left, right) => right.version - left.version || left.name.localeCompare(right.name))
    for (const entry of versions) {
      for (const subdir of ['chrome-win64', 'chrome-win']) {
        const hit = probe(path.join(playwrightRoot, entry.name, subdir, 'chrome.exe'), 'playwright')
        if (hit) return { ...hit, warnings }
      }
    }

    const programFiles = typeof env?.ProgramFiles === 'string' && env.ProgramFiles.trim() !== ''
      ? env.ProgramFiles.trim()
      : 'C:\\Program Files'
    const programFilesX86 = typeof env?.['ProgramFiles(x86)'] === 'string' && env['ProgramFiles(x86)'].trim() !== ''
      ? env['ProgramFiles(x86)'].trim()
      : 'C:\\Program Files (x86)'
    const windowsCandidates = [
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]
    for (const candidate of windowsCandidates) {
      const hit = probe(candidate, 'system')
      if (hit) return { ...hit, warnings }
    }
  } else {
    const unixCandidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
    for (const candidate of unixCandidates) {
      const hit = probe(candidate, 'system')
      if (hit) return { ...hit, warnings }
    }
  }

  warnings.push('找不到可用的无头浏览器（Chrome/Edge）。请安装 Chrome，或在插件配置 chromePath / 环境变量 DSH_CHROME_PATH 中指定可执行文件路径。')
  return { path: null, source: null, warnings }
}

/** Verify one rendered PNG: exists, > minBytes, valid PNG signature/IHDR, matching dimensions. */
export async function verifyShotFile(absPath, options = {}) {
  const {
    width,
    height,
    fsImpl = fs,
    minBytes = MIN_PNG_BYTES,
  } = options
  let data = null
  try {
    data = await fsImpl.readFile(absPath)
  } catch (error) {
    return { ok: false, error: error?.code === 'ENOENT' ? '文件不存在' : `读取失败：${error?.message || error}` }
  }
  if (!data || data.length <= minBytes) {
    return { ok: false, error: `文件过小（${data ? data.length : 0} 字节，要求 > ${minBytes} 字节）` }
  }
  const dimensions = pngDimensions(data)
  if (!dimensions) return { ok: false, error: '不是有效的 PNG 文件' }
  if (Number.isInteger(width) && dimensions.width !== width) {
    return { ok: false, error: `PNG 宽度 ${dimensions.width} 与请求的 ${width} 不一致` }
  }
  if (Number.isInteger(height) && dimensions.height !== height) {
    return { ok: false, error: `PNG 高度 ${dimensions.height} 与请求的 ${height} 不一致` }
  }
  const sha256 = createHash('sha256').update(data).digest('hex')
  return { ok: true, width: dimensions.width, height: dimensions.height, bytes: data.length, sha256 }
}

/**
 * Remove leftover evidence artifacts of the same round so exactly one render
 * set survives.
 *
 * v1.2 2.1: evidence cards may write more than PNGs (`r<N>-s<K>-x<idx>-…json`
 * logs / extra frames), so every file starting with `r<N>-` is removed. The
 * prefix is round-scoped, so artifacts of other rounds (and unrelated files)
 * are never touched.
 */
export async function cleanRoundShots(dir, roundNo, options = {}) {
  const { fsImpl = fs } = options
  const prefix = `r${Number.isInteger(roundNo) && roundNo > 0 ? roundNo : 1}-`
  let entries = []
  try {
    entries = await fsImpl.readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  await Promise.all(entries
    .filter((name) => String(name).startsWith(prefix))
    .map((name) => Promise.resolve(fsImpl.unlink(path.join(dir, String(name)))).catch(() => {})))
}

/**
 * Orchestrator-side enforcement of the 4-screenshot invariant: every recorded
 * shot must be a real, unique, correctly-sized PNG in `<stateDir>/shots/<cycle>`.
 */
export async function verifyRoundShotFiles(options = {}) {
  const {
    shots,
    shotsDir,
    requiredShots = 4,
    minBytes = MIN_PNG_BYTES,
    fsImpl = fs,
  } = options
  if (!Array.isArray(shots)) return { ok: false, count: 0, error: '缺少截图记录' }
  const count = shots.length
  if (count !== requiredShots) {
    return { ok: false, count, error: `本轮截图 ${count} 张，必须恰好 ${requiredShots} 张` }
  }
  const seen = new Set()
  for (const shot of shots) {
    if (!shot || typeof shot.file !== 'string' || shot.file.trim() === '') {
      return { ok: false, count, error: '截图记录缺少文件名' }
    }
    if (path.basename(shot.file) !== shot.file || !SHOT_FILE_NAME.test(shot.file)) {
      return { ok: false, count, error: `截图文件名不合法：${shot.file}` }
    }
    if (seen.has(shot.file)) return { ok: false, count, error: `截图文件名重复：${shot.file}` }
    seen.add(shot.file)
    const verified = await verifyShotFile(path.join(shotsDir, shot.file), {
      width: Number.isInteger(shot.width) ? shot.width : undefined,
      height: Number.isInteger(shot.height) ? shot.height : undefined,
      minBytes,
      fsImpl,
    })
    if (!verified.ok) return { ok: false, count, error: `截图 ${shot.file} 校验失败：${verified.error}` }
    // v1.1 1.4: tamper-evident screenshot evidence. A recorded sha256 must match
    // the bytes on disk; legacy shots without a hash are accepted.
    if (shot.sha256 !== undefined && shot.sha256 !== null) {
      if (typeof shot.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(shot.sha256)) {
        return { ok: false, count, error: `截图 ${shot.file} 的 sha256 记录格式不合法` }
      }
      if (verified.sha256 !== shot.sha256) {
        return { ok: false, count, error: `截图 ${shot.file} 的 sha256 与文件内容不一致（证据可能被篡改）` }
      }
    }
  }
  return { ok: true, count, error: null }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readLogTail(logFile, fsImpl = fs, maxChars = 1500) {
  if (typeof logFile !== 'string' || logFile === '') return ''
  try {
    const text = await fsImpl.readFile(logFile, 'utf8')
    const trimmed = String(text).trim()
    return trimmed === '' ? '' : `；Chrome 日志尾部：${trimmed.slice(-maxChars)}`
  } catch {
    return ''
  }
}

/**
 * Wait for the screenshot artifact instead of the browser process.
 *
 * Headless Chrome on Windows can linger after writing `--screenshot` (crashpad
 * / first-run helpers, AV scans), so waiting for process exit hangs a healthy
 * render. This polls the PNG, accepts it once its size is stable, and kills the
 * browser; a browser that exits without writing fails fast with its log tail.
 */
async function waitForScreenshot(child, outputPath, options = {}) {
  const {
    timeoutMs = 90_000,
    pollMs = 250,
    fsImpl = fs,
    minBytes = MIN_PNG_BYTES,
    logFile = '',
  } = options
  const startedAt = Date.now()
  let lastSize = -1
  let stableSince = 0
  let spawnError = null
  let exitInfo = null
  child.once('error', (error) => { spawnError = error })
  child.once('exit', (code, signal) => { exitInfo = { code, signal } })
  const sizeOf = async () => {
    try {
      const stat = await fsImpl.stat(outputPath)
      return stat && typeof stat.isFile === 'function' && stat.isFile() ? stat.size : -1
    } catch {
      return -1
    }
  }
  while (Date.now() - startedAt <= timeoutMs) {
    if (spawnError !== null) {
      return { ok: false, error: `浏览器启动失败：${spawnError.message || spawnError}` }
    }
    const size = await sizeOf()
    if (size > minBytes) {
      if (size === lastSize) {
        if (stableSince === 0) stableSince = Date.now()
        else if (Date.now() - stableSince >= 600) {
          try { child.kill() } catch { /* already gone */ }
          return { ok: true }
        }
      } else {
        lastSize = size
        stableSince = 0
      }
    } else {
      lastSize = size
      stableSince = 0
      if (exitInfo !== null) {
        // The PNG may land just after process exit; allow one short grace poll.
        await delay(Math.min(800, pollMs * 3))
        if (await sizeOf() > minBytes) {
          try { child.kill() } catch { /* already gone */ }
          return { ok: true }
        }
        const logTail = await readLogTail(logFile, fsImpl)
        return {
          ok: false,
          error: `浏览器提前退出（code=${exitInfo.code === undefined ? 'null' : exitInfo.code}），没有产出截图${logTail}`,
        }
      }
    }
    await delay(pollMs)
  }
  try { child.kill() } catch { /* already gone */ }
  const logTail = await readLogTail(logFile, fsImpl)
  return { ok: false, error: `浏览器在 ${Math.round(timeoutMs / 1000)} 秒内没有产出稳定截图${logTail}` }
}

function buildChromeArgs(spec, outputPath, userDataDir) {
  const pageUrl = spec.kind === 'url' ? spec.url : pathToFileUrl(spec.path)
  return [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    // Windows display scaling must not change the PNG dimensions; the
    // orchestrator verifies the exact requested width/height.
    '--force-device-scale-factor=1',
    // Local trusted pages only: keep the render alive inside restricted
    // Windows host environments and skip the crash reporter that can hang.
    '--no-sandbox',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--virtual-time-budget=2500',
    `--window-size=${spec.width},${spec.height}`,
    `--screenshot=${outputPath}`,
    `--user-data-dir=${userDataDir}`,
    pageUrl,
  ]
}

/**
 * Render every spec to `<stateDir>/shots/<cycleId>/r<N>-s<K>-<slug>.png`.
 *
 * @returns {Promise<{ok: boolean, shots: object[], errors: string[], warnings: string[], error?: string}>}
 *   `ok` is true only when every requested screenshot rendered and passed PNG validation.
 */
export async function renderShots(options = {}) {
  const {
    cycleId,
    roundNo = 1,
    stateDir,
    specs = [],
    requiredShots,
    chromePath = '',
    env = process.env,
    platform = process.platform,
    home = os.homedir(),
    timeoutMs = 45_000,
    spawnImpl = nodeSpawn,
    exists = nodeExistsSync,
    readdir = nodeReaddirSync,
    fsImpl = fs,
    resolveChrome = resolveChromePath,
    cleanupFiles = [],
    // v1.2 2.1: when one shot is rendered on its own (mixed evidence plan) the
    // caller supplies its position so the legacy `r<N>-s<K>-…png` name keeps
    // matching the evidence card index.
    shotIndexOffset = 0,
    // v1.2 2.1: the evidence framework cleans the round's directory once before
    // rendering a mixed plan; individual per-card renders must not wipe earlier
    // cards of the same round.
    cleanBefore = true,
    now = Date.now,
  } = options

  const shots = []
  const errors = []
  const warnings = []
  const expected = Number.isInteger(requiredShots) ? requiredShots : (Array.isArray(specs) ? specs.length : 0)

  const cleanup = async () => {
    for (const file of cleanupFiles) {
      try {
        await fsImpl.unlink(file)
      } catch {
        // best effort
      }
    }
  }

  try {
    if (typeof stateDir !== 'string' || stateDir.trim() === '') {
      return { ok: false, error: '缺少 stateDir，无法保存截图', shots, errors, warnings }
    }
    if (typeof cycleId !== 'string' || !SAFE_SEGMENT.test(cycleId)) {
      return { ok: false, error: `cycleId 不合法，拒绝写入截图目录：${String(cycleId)}`, shots, errors, warnings }
    }
    if (!Array.isArray(specs) || specs.length === 0) {
      return { ok: false, error: '没有可渲染的截图规格', shots, errors, warnings }
    }

    let resolution = null
    try {
      resolution = typeof resolveChrome === 'function'
        ? resolveChrome({ chromePath, env, platform, home, exists, readdir })
        : null
    } catch (error) {
      resolution = { path: null, warnings: [`浏览器探测失败：${error?.message || error}`] }
    }
    if (!resolution || typeof resolution.path !== 'string' || resolution.path === '') {
      const detail = Array.isArray(resolution?.warnings) && resolution.warnings.length > 0
        ? ` ${resolution.warnings[resolution.warnings.length - 1]}`
        : ''
      return {
        ok: false,
        error: `找不到可用的无头浏览器（Chrome/Edge），无法渲染 ${expected} 张截图。${detail}`,
        shots,
        errors,
        warnings: [...warnings, ...(Array.isArray(resolution?.warnings) ? resolution.warnings : [])],
      }
    }
    if (!isFileCandidate(exists, resolution.path)) {
      return { ok: false, error: `浏览器可执行文件不存在：${resolution.path}`, shots, errors, warnings }
    }

    const shotDir = path.join(path.resolve(stateDir), 'shots', cycleId)
    await fsImpl.mkdir(shotDir, { recursive: true })
    if (cleanBefore !== false) await cleanRoundShots(shotDir, roundNo, { fsImpl })

    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index]
      const offset = Number.isInteger(shotIndexOffset) && shotIndexOffset >= 0 ? shotIndexOffset : 0
      const file = buildShotFilename(roundNo, index + offset, spec?.name)
      const outputPath = path.join(shotDir, file)
      let userDataDir = null
      let logFile = null
      let logHandle = null
      try {
        userDataDir = await fsImpl.mkdtemp(path.join(os.tmpdir(), 'dsh-rtc-chrome-'))
        const pageUrl = spec.kind === 'url' ? spec.url : pathToFileUrl(spec.path)
        const args = buildChromeArgs(spec, outputPath, userDataDir)
        const tmpDir = path.join(path.resolve(stateDir), 'tmp')
        await fsImpl.mkdir(tmpDir, { recursive: true })
        logFile = path.join(tmpDir, `${file}.chrome.log`)
        try {
          logHandle = await fsImpl.open(logFile, 'w')
        } catch {
          logHandle = null
        }
        const child = spawnImpl(resolution.path, args, {
          windowsHide: true,
          stdio: ['ignore', 'ignore', logHandle === null ? 'ignore' : logHandle.fd],
        })
        const outcome = await waitForScreenshot(child, outputPath, { timeoutMs, fsImpl, logFile })
        if (!outcome.ok) {
          errors.push(`${file} 渲染失败：${outcome.error}`)
          try {
            await fsImpl.unlink(outputPath)
          } catch {
            // best effort
          }
          continue
        }
        const verified = await verifyShotFile(outputPath, {
          width: spec.width,
          height: spec.height,
          fsImpl,
        })
        if (!verified.ok) {
          errors.push(`${file} 校验失败：${verified.error}`)
          try {
            await fsImpl.unlink(outputPath)
          } catch {
            // best effort
          }
          continue
        }
        shots.push({
          file,
          path: outputPath,
          url: pathToFileUrl(outputPath),
          width: verified.width,
          height: verified.height,
          bytes: verified.bytes,
          // v1.1 1.4: content hash persisted with the evidence record.
          sha256: verified.sha256,
          page: typeof spec.page === 'string' && spec.page !== '' ? spec.page : pageUrl,
          renderedAt: now(),
        })
      } catch (error) {
        errors.push(`${file} 渲染异常：${error?.message || error}`)
      } finally {
        if (logHandle !== null) {
          try {
            await logHandle.close()
          } catch {
            // The file may already be closed by the child teardown.
          }
        }
        if (logFile !== null) {
          try {
            await fsImpl.unlink(logFile)
          } catch {
            // best-effort cleanup of the diagnostic log
          }
        }
        if (userDataDir !== null) {
          try {
            await fsImpl.rm(userDataDir, { recursive: true, force: true })
          } catch {
            // Chrome may still hold a handle; a temp dir leak is acceptable.
          }
        }
      }
    }
  } catch (error) {
    errors.push(`截图流程异常：${error?.message || error}`)
  } finally {
    await cleanup()
  }

  const ok = errors.length === 0 && shots.length === expected && expected > 0
  const result = { ok, shots, errors, warnings }
  if (!ok) result.error = errors[0] || `截图数量不足：需要 ${expected} 张，实际 ${shots.length} 张`
  return result
}

/**
 * Write report pages to `<stateDir>/tmp/` and build `file://` specs for them.
 * The caller must delete the returned `files` after rendering.
 */
export async function writeReportHtml(options = {}) {
  const {
    stateDir,
    cycleId,
    roundNo = 1,
    pages,
    requiredShots = 4,
    viewport = { width: 1440, height: 900 },
    fsImpl = fs,
  } = options
  const files = []
  try {
    if (typeof stateDir !== 'string' || stateDir.trim() === '') return { ok: false, error: '缺少 stateDir' }
    if (!Array.isArray(pages) || pages.length === 0) return { ok: false, error: '报告页为空' }
    if (!SAFE_SEGMENT.test(String(cycleId ?? ''))) return { ok: false, error: `cycleId 不合法：${String(cycleId)}` }
    const dir = path.join(path.resolve(stateDir), 'tmp')
    await fsImpl.mkdir(dir, { recursive: true })
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const specs = []
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index]
      const rawName = typeof page?.name === 'string' && page.name !== '' ? page.name : `report-${index + 1}.html`
      const slug = rawName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.html$/i, '').slice(0, 60) || `report-${index + 1}`
      const name = `${stamp}-r${roundNo}-p${index + 1}-${slug}.html`
      const file = path.join(dir, name)
      await fsImpl.writeFile(file, String(page?.html ?? ''), 'utf8')
      files.push(file)
      specs.push({
        kind: 'url',
        url: pathToFileUrl(file),
        width: viewport.width,
        height: viewport.height,
        name: `report-${index + 1}`,
        page: `report-page-${index + 1}`,
      })
    }
    if (specs.length !== requiredShots) {
      return { ok: false, error: `报告页数量 ${specs.length} 与要求的截图数 ${requiredShots} 不一致`, files }
    }
    return { ok: true, files, specs }
  } catch (error) {
    return { ok: false, error: `写入报告页失败：${error?.message || error}`, files }
  }
}
