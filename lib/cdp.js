/**
 * Zero-dependency Chrome DevTools Protocol interaction runner (v1.2 2.2).
 *
 * The Host already ships a headless browser (`lib/shots.js#resolveChromePath`
 * prefers Playwright's `chrome-headless-shell`). This module starts the same
 * binary with `--remote-debugging-pipe`, speaks raw CDP over file descriptors
 * 3 (parent → browser) and 4 (browser → parent) using NUL-delimited JSON, and
 * drives one scripted evidence card:
 *
 *   Target.createTarget → Target.attachToTarget(flatten) → Page/Runtime/Log/
 *   Network/Performance.enable → Emulation.setDeviceMetricsOverride →
 *   Page.navigate + load/readyState + 2×rAF → Input/Runtime actions →
 *   Page.captureScreenshot → Performance.getMetrics + 1s rAF FPS sample.
 *
 * There is no `eval` API and no arbitrary script injection surface: the only
 * scripted expressions are fixed strings with a `JSON.stringify`-quoted
 * selector, and clicks use `document.querySelector(selector).click()`.
 *
 * Everything is bounded and leaks nothing:
 * - every request has a timeout and the whole card has a deadline
 *   (`interactionTimeoutSeconds`, default 60 s);
 * - console/network collectors truncate (flags on the metadata);
 * - `runInteractionCard` NEVER throws: failures become `{ok:false,error}`;
 * - the browser process tree is killed and the temp `--user-data-dir` removed
 *   in `finally`, on success, failure and timeout alike.
 *
 * Pure protocol helpers (`encodeCdpMessage`, `createCdpMessageDecoder`,
 * `resolveKeyDefinition`, `createCdpConnection`, `isAllowedNavigationUrl`) are
 * unit tested with fake pipes; `runInteractionCard` accepts injected
 * spawn/connection/fs/clock functions so tests never launch a browser.
 */

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { LIMITS } from './constants.js'
import {
  buildShotFilename,
  isLoopbackHostname,
  normalizeAllowedOrigins,
  pngDimensions,
  slugifyName,
  verifyShotFile,
} from './shots.js'

/** Default timeout for one CDP request (the card deadline stays the outer bound). */
export const DEFAULT_CDP_TIMEOUT_MS = 10_000
/** Page navigation gets a larger budget than a plain command. */
const NAV_TIMEOUT_MS = 20_000
const READY_STATE_TIMEOUT_MS = 5_000
const FRAME_SETTLE_TIMEOUT_MS = 5_000
const FPS_SAMPLE_MS = 1_000
const MAX_PERF_METRICS = 12
const MIN_PNG_BYTES = 1024

const NAMED_KEYS = Object.freeze({
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
})

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncateText(value, maxChars) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  if (maxChars <= 0 || text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(ms))))
}

/** Serialize one pipe frame: JSON + NUL terminator (Chrome's pipe framing). */
export function encodeCdpMessage(message) {
  return `${JSON.stringify(message)}\0`
}

/**
 * Incremental NUL-delimited frame decoder.
 *
 * Buffers raw bytes and only decodes complete frames, so a multi-byte UTF-8
 * character split across two pipe chunks can never corrupt a message. Invalid
 * JSON frames are reported through `onInvalid` and skipped; decoding continues.
 *
 * @returns {{push: (chunk: Buffer|Uint8Array|string|null) => number, pending: () => Buffer, reset: () => void}}
 */
export function createCdpMessageDecoder(onMessage, options = {}) {
  const { onInvalid = null } = isPlainObject(options) ? options : {}
  const chunks = []
  const emit = typeof onMessage === 'function' ? onMessage : () => {}
  const invalid = typeof onInvalid === 'function' ? onInvalid : () => {}
  return {
    push(chunk) {
      if (chunk === null || chunk === undefined) return 0
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      let merged = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
      chunks.length = 0
      let count = 0
      let index = merged.indexOf(0)
      while (index !== -1) {
        const frame = merged.subarray(0, index).toString('utf8')
        merged = merged.subarray(index + 1)
        if (frame.trim() !== '') {
          let parsed = null
          try {
            parsed = JSON.parse(frame)
          } catch {
            parsed = null
          }
          if (isPlainObject(parsed)) {
            emit(parsed)
            count += 1
          } else {
            invalid(frame)
          }
        }
        index = merged.indexOf(0)
      }
      if (merged.length > 0) chunks.push(merged)
      return count
    },
    pending() {
      return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks)
    },
    reset() {
      chunks.length = 0
    },
  }
}

/** Structured CDP failure (never thrown outside the connection). */
export class CdpError extends Error {
  constructor(message, options = {}) {
    super(typeof message === 'string' && message !== '' ? message : 'CDP 调用失败')
    this.name = 'CdpError'
    this.code = typeof options?.code === 'string' ? options.code : 'cdp-error'
    this.method = typeof options?.method === 'string' ? options.method : null
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

function describeCdpError(method, error) {
  if (isPlainObject(error)) {
    const text = typeof error.message === 'string' && error.message !== '' ? error.message : JSON.stringify(error)
    return new CdpError(`${method} 失败：${truncateText(text, 400)}`, { method })
  }
  return new CdpError(`${method} 失败：${truncateText(error, 400)}`, { method })
}

/**
 * Minimal CDP client over a pipe pair.
 *
 * `writable.write()` receives NUL-delimited JSON, `readable` is expected to be
 * a Node Readable emitting `data` / `error` / `end`. Responses are matched by
 * numeric `id`; events are dispatched by `method` (optionally filtered by the
 * flattened `sessionId`).
 *
 * @returns {{send: Function, on: Function, once: Function, onAny: Function, close: Function,
 *            isClosed: () => boolean, nextId: () => number}}
 */
export function createCdpConnection(options = {}) {
  const {
    writable,
    readable,
    defaultTimeoutMs = DEFAULT_CDP_TIMEOUT_MS,
    onInvalidMessage = null,
  } = isPlainObject(options) ? options : {}
  if (!writable || typeof writable.write !== 'function') throw new CdpError('CDP 连接需要可写管道')
  if (!readable || typeof readable.on !== 'function') throw new CdpError('CDP 连接需要可读管道')

  let nextRequestId = 1
  let closed = false
  let closeError = null
  const pending = new Map()
  const listeners = new Map()
  const anyListeners = new Set()

  const rejectPending = (error) => {
    for (const entry of pending.values()) {
      try { entry.timer !== null && clearTimeout(entry.timer) } catch { /* ignore */ }
      try { entry.reject(error) } catch { /* ignore */ }
    }
    pending.clear()
  }

  const fail = (error) => {
    if (closed) return
    closed = true
    closeError = error instanceof Error ? error : new CdpError(String(error))
    rejectPending(closeError)
    listeners.clear()
    anyListeners.clear()
  }

  const dispatch = (message) => {
    if (closed) return
    if (Number.isInteger(message.id)) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (entry.timer !== null) {
        try { clearTimeout(entry.timer) } catch { /* ignore */ }
      }
      if (isPlainObject(message.error)) {
        entry.reject(describeCdpError(entry.method, message.error))
      } else {
        entry.resolve(isPlainObject(message.result) ? message.result : {})
      }
      return
    }
    if (typeof message.method !== 'string' || message.method === '') return
    const params = isPlainObject(message.params) ? message.params : {}
    const bucket = listeners.get(message.method)
    if (bucket !== undefined) {
      for (const entry of [...bucket]) {
        if (entry.sessionId !== null && entry.sessionId !== message.sessionId) continue
        try { entry.handler(params, message) } catch { /* a listener never breaks the pipe */ }
      }
    }
    for (const entry of [...anyListeners]) {
      if (entry.sessionId !== null && entry.sessionId !== message.sessionId) continue
      try { entry.handler(params, message) } catch { /* ignore */ }
    }
  }

  const decoder = createCdpMessageDecoder(dispatch, { onInvalid: onInvalidMessage })

  const onData = (chunk) => decoder.push(chunk)
  const onEnd = () => fail(new CdpError('CDP 管道已关闭', { code: 'closed' }))
  const onError = (error) => fail(new CdpError(`CDP 管道错误：${truncateText(error?.message || error, 300)}`, { code: 'pipe-error', cause: error }))
  readable.on('data', onData)
  readable.on('error', onError)
  readable.on('end', onEnd)
  if (typeof writable.on === 'function') writable.on('error', onError)

  function send(method, params = {}, sendOptions = {}) {
    if (typeof method !== 'string' || method === '') return Promise.reject(new CdpError('CDP 方法名不能为空'))
    if (closed) return Promise.reject(closeError ?? new CdpError('CDP 连接已关闭', { code: 'closed' }))
    const timeoutMs = Number.isFinite(sendOptions?.timeoutMs) && sendOptions.timeoutMs > 0
      ? Math.round(sendOptions.timeoutMs)
      : defaultTimeoutMs
    const id = nextRequestId
    nextRequestId += 1
    const message = { id, method, params: isPlainObject(params) ? params : {} }
    if (typeof sendOptions?.sessionId === 'string' && sendOptions.sessionId !== '') {
      message.sessionId = sendOptions.sessionId
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new CdpError(`CDP 请求超时（${method}，${timeoutMs}ms）`, { code: 'timeout', method }))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer, method })
      try {
        writable.write(encodeCdpMessage(message))
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(new CdpError(`CDP 写入失败（${method}）：${truncateText(error?.message || error, 300)}`, { code: 'write-error', method, cause: error }))
      }
    })
  }

  function on(method, handler, listenerOptions = {}) {
    if (typeof method !== 'string' || typeof handler !== 'function') return () => {}
    const entry = {
      handler,
      sessionId: typeof listenerOptions?.sessionId === 'string' && listenerOptions.sessionId !== ''
        ? listenerOptions.sessionId
        : null,
    }
    let bucket = listeners.get(method)
    if (bucket === undefined) {
      bucket = new Set()
      listeners.set(method, bucket)
    }
    bucket.add(entry)
    return () => {
      const current = listeners.get(method)
      if (current !== undefined) current.delete(entry)
    }
  }

  function onAny(handler, listenerOptions = {}) {
    if (typeof handler !== 'function') return () => {}
    const entry = {
      handler,
      sessionId: typeof listenerOptions?.sessionId === 'string' && listenerOptions.sessionId !== ''
        ? listenerOptions.sessionId
        : null,
    }
    anyListeners.add(entry)
    return () => anyListeners.delete(entry)
  }

  function once(method, onceOptions = {}) {
    const timeoutMs = Number.isFinite(onceOptions?.timeoutMs) && onceOptions.timeoutMs > 0
      ? Math.round(onceOptions.timeoutMs)
      : defaultTimeoutMs
    const sessionId = typeof onceOptions?.sessionId === 'string' && onceOptions.sessionId !== ''
      ? onceOptions.sessionId
      : null
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        try { clearTimeout(timer) } catch { /* ignore */ }
        unsubscribe()
        if (error) reject(error)
        else resolve(value)
      }
      const timer = setTimeout(() => finish(new CdpError(`等待事件超时（${method}）`, { code: 'timeout', method })), timeoutMs)
      const unsubscribe = on(method, (params, message) => {
        if (typeof onceOptions?.predicate === 'function' && onceOptions.predicate(params, message) !== true) return
        finish(null, params)
      }, { sessionId })
      if (closed) finish(closeError ?? new CdpError('CDP 连接已关闭', { code: 'closed' }))
    })
  }

  function close(error = null) {
    if (!closed) {
      closed = true
      closeError = error instanceof Error ? error : new CdpError('CDP 连接已关闭', { code: 'closed' })
      rejectPending(closeError)
      listeners.clear()
      anyListeners.clear()
    }
    if (typeof readable.off === 'function') {
      try { readable.off('data', onData) } catch { /* ignore */ }
      try { readable.off('error', onError) } catch { /* ignore */ }
      try { readable.off('end', onEnd) } catch { /* ignore */ }
    }
    if (typeof writable.off === 'function') {
      try { writable.off('error', onError) } catch { /* ignore */ }
    }
  }

  return {
    send,
    on,
    once,
    onAny,
    close,
    isClosed: () => closed,
    nextId: () => nextRequestId,
  }
}

/**
 * Map a human key name to the CDP Input.dispatchKeyEvent fields.
 * Supports Space/Enter/Escape/Tab/Backspace/Delete/Arrows and single A–Z/0–9.
 * @returns {{key: string, code: string, windowsVirtualKeyCode: number, text?: string}|null}
 */
export function resolveKeyDefinition(name) {
  if (typeof name !== 'string') return null
  const text = name.trim()
  if (text === '') return null
  if (Object.prototype.hasOwnProperty.call(NAMED_KEYS, text)) return { ...NAMED_KEYS[text] }
  if (/^[A-Za-z]$/.test(text)) {
    const upper = text.toUpperCase()
    return { key: text.toLowerCase(), code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) }
  }
  if (/^[0-9]$/.test(text)) {
    return { key: text, code: `Digit${text}`, windowsVirtualKeyCode: text.charCodeAt(0) }
  }
  return null
}

/** Chrome command-line args for one interaction card (remote-debugging pipe). */
export function buildChromeArgs(options = {}) {
  const { width = 1440, height = 900, userDataDir = '' } = isPlainObject(options) ? options : {}
  const args = [
    '--headless=new',
    '--remote-debugging-pipe',
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--disable-crash-reporter',
    '--disable-breakpad',
    `--window-size=${width},${height}`,
  ]
  if (typeof userDataDir === 'string' && userDataDir !== '') args.push(`--user-data-dir=${userDataDir}`)
  args.push('about:blank')
  return args
}

/** Kill the browser and its helper processes (Windows needs taskkill /T). */
export function killProcessTree(child, options = {}) {
  const { platform = process.platform, spawnSyncImpl = nodeSpawnSync } = isPlainObject(options) ? options : {}
  if (!child || typeof child !== 'object') return
  const pid = Number.isInteger(child.pid) ? child.pid : null
  try {
    if (platform === 'win32' && pid !== null) {
      spawnSyncImpl('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 })
      return
    }
    child.kill()
  } catch {
    try { child.kill() } catch { /* already gone */ }
  }
}

/**
 * URL/path safety for one navigation target: `file://` URLs (produced from
 * target-relative paths by the evidence normalizer) or http(s) on a loopback
 * host / explicitly allowed origin. Anything else is rejected.
 * @returns {{ok: boolean, url?: string, error?: string}}
 */
export function isAllowedNavigationUrl(url, options = {}) {
  const { allowedOrigins = [] } = isPlainObject(options) ? options : {}
  if (typeof url !== 'string' || url.trim() === '') return { ok: false, error: '缺少导航 URL' }
  let parsed = null
  try {
    parsed = new URL(url.trim())
  } catch {
    return { ok: false, error: `导航 URL 不是合法 URL：${url}` }
  }
  if (parsed.protocol === 'file:') return { ok: true, url: parsed.href }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `导航 URL 只允许 file:// 或 http(s)：${parsed.protocol}` }
  }
  const allowed = normalizeAllowedOrigins(allowedOrigins)
  if (!isLoopbackHostname(parsed.hostname) && !allowed.has(parsed.origin)) {
    return {
      ok: false,
      error: `导航 URL 主机不在白名单：${parsed.origin}（只允许 127.0.0.1 / ::1 / localhost 或配置项 allowedOrigins 中显式列出的 origin）`,
    }
  }
  return { ok: true, url: parsed.href }
}

function emptyMeta(card) {
  return {
    url: typeof card?.url === 'string' ? card.url : '',
    page: typeof card?.page === 'string' ? card.page : '',
    console: { events: [], errors: 0, truncated: false },
    network: { requests: 0, failures: 0, truncated: false, failureSamples: [] },
    perf: { metrics: {}, fps: null },
    steps: [],
  }
}

function pushConsoleEvent(state, level, text, isError) {
  if (isError) state.errors += 1
  if (state.events.length >= LIMITS.maxEvidenceConsoleEvents) {
    state.truncated = true
    return
  }
  state.events.push(`${level}: ${truncateText(text, LIMITS.evidenceEventChars)}`)
}

function attachCollectors(connection, sessionId, consoleState, networkState) {
  connection.on('Runtime.consoleAPICalled', (params) => {
    const type = typeof params?.type === 'string' ? params.type : 'log'
    const args = Array.isArray(params?.args) ? params.args : []
    const text = args
      .map((arg) => (isPlainObject(arg) && typeof arg.value === 'string'
        ? arg.value
        : (isPlainObject(arg) && typeof arg.description === 'string' ? arg.description : (isPlainObject(arg) ? String(arg.type ?? '') : ''))))
      .filter((part) => part !== '')
      .join(' ')
    pushConsoleEvent(consoleState, type, text, type === 'error')
  }, { sessionId })
  connection.on('Log.entryAdded', (params) => {
    const entry = isPlainObject(params?.entry) ? params.entry : {}
    const level = typeof entry.level === 'string' ? entry.level : 'info'
    const text = `${typeof entry.source === 'string' ? `${entry.source} ` : ''}${typeof entry.text === 'string' ? entry.text : ''}`
    pushConsoleEvent(consoleState, `log:${level}`, text, level === 'error')
  }, { sessionId })
  connection.on('Network.responseReceived', (params) => {
    networkState.requests += 1
    const response = isPlainObject(params?.response) ? params.response : {}
    const status = Number.isFinite(response.status) ? response.status : 0
    if (status >= 400) {
      networkState.failures += 1
      if (networkState.failureSamples.length < LIMITS.maxEvidenceFailureSamples) {
        const url = typeof response.url === 'string' ? response.url : ''
        networkState.failureSamples.push(`${status} ${typeof params?.type === 'string' ? params.type : '?'} ${truncateText(url, 160)}`)
      }
    }
    if (networkState.requests > LIMITS.maxEvidenceNetworkEvents) networkState.truncated = true
  }, { sessionId })
  connection.on('Network.loadingFailed', (params) => {
    networkState.failures += 1
    if (networkState.failureSamples.length < LIMITS.maxEvidenceFailureSamples) {
      const errorText = typeof params?.errorText === 'string' ? params.errorText : 'loadingFailed'
      networkState.failureSamples.push(`${typeof params?.type === 'string' ? params.type : '?'} ${truncateText(errorText, 160)}`)
    }
    if (networkState.failures > LIMITS.maxEvidenceNetworkEvents) networkState.truncated = true
  }, { sessionId })
}

const RAF_SETTLE_EXPRESSION = 'new Promise((resolve) => { let frames = 0; const tick = () => { frames += 1; if (frames >= 2) resolve(true); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); })'
const FPS_EXPRESSION = `new Promise((resolve) => {
  let frames = 0
  const started = performance.now()
  const tick = () => {
    frames += 1
    const elapsed = performance.now() - started
    if (elapsed >= ${FPS_SAMPLE_MS}) resolve({ frames, ms: elapsed })
    else requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})`

/** Evaluate an expression; returns `{ok:true,value}` or `{ok:false,error}`. */
async function evaluateExpression(sent, sessionId, expression, options = {}) {
  const response = await sent('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: options?.awaitPromise === true,
    userGesture: false,
  }, { sessionId, timeoutMs: options?.timeoutMs })
  if (isPlainObject(response?.exceptionDetails)) {
    const detail = response.exceptionDetails.exception
    const text = isPlainObject(detail) && typeof detail.description === 'string'
      ? detail.description
      : (typeof response.exceptionDetails.text === 'string' ? response.exceptionDetails.text : '脚本异常')
    return { ok: false, error: truncateText(text, 300) }
  }
  return { ok: true, value: response?.result?.value }
}

async function waitReadyState(sent, sessionId, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    const outcome = await evaluateExpression(sent, sessionId, 'document.readyState', { timeoutMs: Math.min(5_000, timeoutMs) })
    if (outcome.ok && (outcome.value === 'complete' || outcome.value === 'interactive')) return true
    await delay(50)
  }
  return false
}

/** Navigate the attached page and wait for load + readyState + two rAF frames. */
async function navigatePage(sent, connection, sessionId, url, options = {}) {
  const timeoutMs = Number.isFinite(options?.timeoutMs) ? options.timeoutMs : NAV_TIMEOUT_MS
  const loadPromise = connection.once('Page.loadEventFired', {
    timeoutMs: Math.min(timeoutMs, NAV_TIMEOUT_MS),
    sessionId,
  }).catch(() => null)
  const result = await sent('Page.navigate', { url }, { sessionId, timeoutMs })
  if (isPlainObject(result) && typeof result.errorText === 'string' && result.errorText !== '') {
    throw new CdpError(`页面导航失败（${result.errorText}）：${url}`)
  }
  await loadPromise
  await waitReadyState(sent, sessionId, Math.min(READY_STATE_TIMEOUT_MS, timeoutMs))
  const settled = await evaluateExpression(sent, sessionId, RAF_SETTLE_EXPRESSION, {
    awaitPromise: true,
    timeoutMs: Math.min(FRAME_SETTLE_TIMEOUT_MS, timeoutMs),
  }).catch(() => ({ ok: false }))
  if (!settled.ok) return { warmed: false }
  return { warmed: true }
}

async function collectPerf(sent, sessionId, options = {}) {
  const timeoutMs = Number.isFinite(options?.timeoutMs) ? options.timeoutMs : DEFAULT_CDP_TIMEOUT_MS
  const metrics = {}
  try {
    const response = await sent('Performance.getMetrics', {}, { sessionId, timeoutMs })
    const list = Array.isArray(response?.metrics) ? response.metrics : []
    for (const metric of list) {
      if (Object.keys(metrics).length >= MAX_PERF_METRICS) break
      if (!isPlainObject(metric) || typeof metric.name !== 'string' || !Number.isFinite(metric.value)) continue
      metrics[metric.name] = metric.value
    }
  } catch {
    // Perf metrics are best effort; a missing sample must not fail the card.
  }
  let fps = null
  try {
    const sample = await evaluateExpression(sent, sessionId, FPS_EXPRESSION, {
      awaitPromise: true,
      timeoutMs: Math.min(FPS_SAMPLE_MS + 2_000, timeoutMs),
    })
    if (sample.ok && isPlainObject(sample.value) && Number.isFinite(sample.value.frames) && Number.isFinite(sample.value.ms) && sample.value.ms > 0) {
      fps = Math.round((sample.value.frames / (sample.value.ms / 1000)) * 100) / 100
    }
  } catch {
    // FPS is best effort too.
  }
  return { metrics, fps }
}

/** Extra artifact name: `r<N>-s<K>-x<idx>-<slug>.png` (idx = 1-based position). */
export function buildExtraArtifactFilename(roundNo, shotIndex, artifactIndex, name) {
  const round = Number.isInteger(roundNo) && roundNo > 0 ? roundNo : 1
  const shot = Number.isInteger(shotIndex) && shotIndex > 0 ? shotIndex : 1
  const position = Number.isInteger(artifactIndex) && artifactIndex > 0 ? artifactIndex : 1
  return `r${round}-s${shot}-x${position}-${slugifyName(name, 'frame')}.png`
}

/**
 * Run one `interaction` evidence card.
 *
 * @param {object} options
 * @param {object} options.card normalized interaction card (`url`, `page`,
 *   `width`, `height`, `name`, `steps`, `collect`)
 * @param {string} options.outDir evidence directory (stateDir/shots/<cycle>)
 * @param {number} [options.roundNo] round number used in artifact filenames
 * @param {number} [options.shotIndex] 1-based card index used in filenames
 * @param {{path: string}} options.chrome resolved browser binary
 * @param {object} [options.config] plugin config (`interactionTimeoutSeconds`, `allowedOrigins`)
 * @returns {Promise<{ok: boolean, artifacts: object[], meta: object, error?: string}>}
 *   Never throws.
 */
export async function runInteractionCard(options = {}) {
  const source = isPlainObject(options) ? options : {}
  const {
    card,
    outDir,
    roundNo = 1,
    shotIndex = 1,
    chrome = null,
    config = {},
    fsImpl = fs,
    spawnImpl = nodeSpawn,
    connectionFactory = null,
    killTree = killProcessTree,
    now = Date.now,
  } = source

  const startedAt = now()
  const timeoutSeconds = Number.isFinite(config?.interactionTimeoutSeconds) && config.interactionTimeoutSeconds > 0
    ? config.interactionTimeoutSeconds
    : 60
  const timeoutMs = Math.max(1_000, Math.round(timeoutSeconds * 1000))
  const deadline = startedAt + timeoutMs
  const remaining = () => deadline - now()
  const artifacts = []
  const meta = emptyMeta(card)
  const timeoutError = () => new CdpError(`交互证据卡超时（${timeoutSeconds} 秒），已终止浏览器并清理临时目录`, { code: 'timeout' })

  let userDataDir = null
  let child = null
  let connection = null
  let spawnError = null

  const fail = (error) => ({
    ok: false,
    error: truncateText(error instanceof Error ? error.message : String(error), 800),
    artifacts,
    meta,
  })

  if (!isPlainObject(card) || card.kind !== 'interaction') {
    return fail('runInteractionCard 需要 kind=interaction 的证据卡')
  }
  if (typeof outDir !== 'string' || outDir.trim() === '') return fail('缺少证据输出目录')
  const allowed = isAllowedNavigationUrl(card.url, { allowedOrigins: config?.allowedOrigins })
  if (!allowed.ok) return fail(allowed.error)
  if (!isPlainObject(chrome) || typeof chrome.path !== 'string' || chrome.path.trim() === '') {
    return fail('找不到可用的无头浏览器（Chrome/Edge），无法执行 interaction 证据卡')
  }
  const width = Number.isInteger(card.width) && card.width > 0 ? card.width : 1440
  const height = Number.isInteger(card.height) && card.height > 0 ? card.height : 900

  const sent = (method, params = {}, sendOptions = {}) => {
    const left = remaining()
    if (left <= 100) return Promise.reject(timeoutError())
    const requestTimeout = Math.max(250, Math.min(sendOptions?.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS, left))
    let request = null
    try {
      request = connection.send(method, params, { sessionId: sendOptions?.sessionId, timeoutMs: requestTimeout })
    } catch (error) {
      return Promise.reject(error)
    }
    // The outer race guarantees the card deadline even with a connection
    // implementation that never settles (tests inject fake pipes this way).
    let timer = null
    const timeoutPromise = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(timeoutError()), requestTimeout)
    })
    return Promise.race([Promise.resolve(request), timeoutPromise]).finally(() => {
      if (timer !== null) {
        try { clearTimeout(timer) } catch { /* ignore */ }
      }
    })
  }

  try {
    await fsImpl.mkdir(outDir, { recursive: true })
    userDataDir = await fsImpl.mkdtemp(path.join(os.tmpdir(), 'dsh-rtc-cdp-'))
    child = spawnImpl(chrome.path, buildChromeArgs({ width, height, userDataDir }), {
      windowsHide: true,
      // fd 3 = parent → browser (CDP input), fd 4 = browser → parent (CDP output).
      // Node maps stdio[] entries 0–2 to the standard fds, so entries 3 AND 4
      // must both be piped for `child.stdio[3]` / `child.stdio[4]` to exist.
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    })
    if (!child || !Array.isArray(child.stdio) || child.stdio[3] === null || child.stdio[3] === undefined
      || child.stdio[4] === null || child.stdio[4] === undefined) {
      return fail('浏览器没有暴露 --remote-debugging-pipe 的 fd 3/4 管道')
    }
    if (typeof child.once === 'function') {
      child.once('error', (error) => { spawnError = error })
    }
    connection = typeof connectionFactory === 'function'
      ? await connectionFactory({ child, defaultTimeoutMs: Math.min(DEFAULT_CDP_TIMEOUT_MS, Math.max(250, remaining())), now, deadline })
      : createCdpConnection({
        writable: child.stdio[3],
        readable: child.stdio[4],
        defaultTimeoutMs: Math.min(DEFAULT_CDP_TIMEOUT_MS, Math.max(250, remaining())),
      })
    if (!connection || typeof connection.send !== 'function' || typeof connection.on !== 'function') {
      return fail('CDP 连接建立失败（pipe 未就绪）')
    }

    const created = await sent('Target.createTarget', { url: 'about:blank' })
    if (!isPlainObject(created) || typeof created.targetId !== 'string' || created.targetId === '') {
      throw new CdpError('Target.createTarget 未返回 targetId')
    }
    const attached = await sent('Target.attachToTarget', { targetId: created.targetId, flatten: true })
    if (!isPlainObject(attached) || typeof attached.sessionId !== 'string' || attached.sessionId === '') {
      throw new CdpError('Target.attachToTarget 未返回 sessionId')
    }
    const sessionId = attached.sessionId

    for (const method of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable', 'Performance.enable']) {
      try {
        await sent(method, {}, { sessionId })
      } catch (error) {
        // Performance/Log/Network are diagnostic extras; Page/Runtime are hard requirements.
        if (method === 'Page.enable' || method === 'Runtime.enable') throw error
      }
    }
    await sent('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    }, { sessionId })

    const consoleState = { events: [], errors: 0, truncated: false }
    const networkState = { requests: 0, failures: 0, truncated: false, failureSamples: [] }
    attachCollectors(connection, sessionId, consoleState, networkState)

    /** Capture one PNG and verify it before recording it as an artifact. */
    const captureArtifact = async (rawName, stepName) => {
      if (spawnError !== null) throw new CdpError(`浏览器启动失败：${spawnError?.message || spawnError}`)
      const captured = await sent('Page.captureScreenshot', { format: 'png', fromSurface: true }, { sessionId })
      const data = isPlainObject(captured) && typeof captured.data === 'string' ? captured.data : ''
      if (data === '') throw new CdpError('Page.captureScreenshot 没有返回图片数据')
      const bytes = Buffer.from(data, 'base64')
      const dimensions = pngDimensions(bytes)
      if (dimensions === null) throw new CdpError('CDP 截图不是有效的 PNG')
      if (dimensions.width !== width || dimensions.height !== height) {
        throw new CdpError(`CDP 截图尺寸 ${dimensions.width}x${dimensions.height} 与卡片要求 ${width}x${height} 不一致`)
      }
      if (bytes.length <= MIN_PNG_BYTES) throw new CdpError(`CDP 截图过小（${bytes.length} 字节）`)
      const position = artifacts.length + 1
      // The FIRST image of a card is its representative and is named after the
      // CARD (so `r<N>-s<K>-<card-slug>.png` matches the evidence card index);
      // extra frames are named after the step that captured them.
      const displayName = position === 1
        ? (typeof card.name === 'string' && card.name !== '' ? card.name : `frame-1`)
        : (typeof rawName === 'string' && rawName.trim() !== ''
          ? rawName.trim()
          : (typeof card.name === 'string' && card.name !== '' ? card.name : `frame-${position}`))
      const file = position === 1
        ? buildShotFilename(roundNo, Math.max(0, shotIndex - 1), displayName)
        : buildExtraArtifactFilename(roundNo, shotIndex, position, displayName)
      const absolutePath = path.join(outDir, file)
      await fsImpl.writeFile(absolutePath, bytes)
      const verified = await verifyShotFile(absolutePath, { width, height, fsImpl })
      if (!verified.ok) {
        try { await fsImpl.unlink(absolutePath) } catch { /* best effort */ }
        throw new CdpError(`截图 ${file} 校验失败：${verified.error}`)
      }
      artifacts.push({
        file,
        path: absolutePath,
        width: verified.width,
        height: verified.height,
        bytes: verified.bytes,
        sha256: verified.sha256,
        mime: 'image/png',
        kind: 'screenshot',
        stepName: typeof stepName === 'string' && stepName !== '' ? truncateText(stepName, 64) : (position === 1 ? null : displayName),
      })
      return artifacts[artifacts.length - 1]
    }

    try {
      await navigatePage(sent, connection, sessionId, allowed.url, { timeoutMs: Math.min(remaining(), NAV_TIMEOUT_MS) })
    } catch (error) {
      if (error instanceof CdpError && error.code === 'timeout') throw timeoutError()
      throw error
    }

    const steps = Array.isArray(card.steps) ? card.steps : []
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]
      if (remaining() <= 250) throw timeoutError()
      const stepStartedAt = now()
      const executed = { action: typeof step?.action === 'string' ? step.action : 'unknown' }
      if (step?.action === 'wait') {
        const ms = Number.isInteger(step.ms) && step.ms >= 0 ? step.ms : 300
        await delay(Math.max(0, Math.min(ms, remaining() - 200)))
        executed.ms = Math.max(0, now() - stepStartedAt)
      } else if (step?.action === 'goto') {
        const navigation = step.url !== undefined && step.url !== null
          ? isAllowedNavigationUrl(step.url, { allowedOrigins: config?.allowedOrigins })
          : null
        if (navigation !== null && !navigation.ok) throw new CdpError(navigation.error)
        await navigatePage(sent, connection, sessionId, navigation === null ? allowed.url : navigation.url, {
          timeoutMs: Math.min(remaining(), NAV_TIMEOUT_MS),
        })
        executed.page = typeof step.page === 'string' ? step.page : ''
        executed.ms = Math.max(0, now() - stepStartedAt)
      } else if (step?.action === 'click') {
        const selector = typeof step.selector === 'string' ? step.selector : ''
        const expression = `(() => {
  const selector = ${JSON.stringify(selector)}
  let element
  try { element = document.querySelector(selector) } catch (error) { return { ok: false, reason: 'invalid-selector', error: String((error && error.message) || error) } }
  if (!element) return { ok: false, reason: 'not-found' }
  if (typeof element.click !== 'function') return { ok: false, reason: 'not-clickable' }
  element.click()
  return { ok: true, tag: element.tagName }
})()`
        const outcome = await evaluateExpression(sent, sessionId, expression, { timeoutMs: Math.min(10_000, remaining()) })
        if (!outcome.ok) throw new CdpError(`click 步骤失败（selector「${selector}」）：${outcome.error}`)
        const value = isPlainObject(outcome.value) ? outcome.value : {}
        if (value.ok !== true) {
          const reason = value.reason === 'not-found'
            ? `找不到元素（selector「${selector}」）`
            : value.reason === 'invalid-selector'
              ? `selector 语法非法（「${selector}」）：${truncateText(value.error, 200)}`
              : `元素不可点击（selector「${selector}」）`
          throw new CdpError(`click 步骤失败：${reason}`)
        }
        executed.selector = truncateText(selector, 200)
        executed.tag = typeof value.tag === 'string' ? value.tag : ''
        executed.ms = Math.max(0, now() - stepStartedAt)
      } else if (step?.action === 'key') {
        const definition = resolveKeyDefinition(step.key)
        if (definition === null) throw new CdpError(`key 步骤失败：不支持的按键「${String(step.key ?? '')}」`)
        const keyDown = {
          type: 'keyDown',
          key: definition.key,
          code: definition.code,
          windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
          nativeVirtualKeyCode: definition.windowsVirtualKeyCode,
        }
        if (typeof definition.text === 'string') keyDown.text = definition.text
        await sent('Input.dispatchKeyEvent', keyDown, { sessionId })
        await sent('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: definition.key,
          code: definition.code,
          windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
          nativeVirtualKeyCode: definition.windowsVirtualKeyCode,
        }, { sessionId })
        executed.key = definition.code
        executed.ms = Math.max(0, now() - stepStartedAt)
      } else if (step?.action === 'screenshot') {
        const artifact = await captureArtifact(step.name, step.name)
        executed.name = typeof step.name === 'string' ? truncateText(step.name, 64) : ''
        executed.file = artifact.file
        executed.ms = Math.max(0, now() - stepStartedAt)
      } else {
        throw new CdpError(`不支持的交互步骤：${String(step?.action ?? '')}`)
      }
      meta.steps.push(executed)
    }

    // Contract: every card yields ≥1 image. An interaction plan without an
    // explicit screenshot step gets one automatic final frame.
    if (artifacts.length === 0) {
      const artifact = await captureArtifact(card.name, 'final')
      meta.steps.push({ action: 'screenshot', name: 'final', file: artifact.file })
    }

    if (card.collect?.perf === true) {
      meta.perf = await collectPerf(sent, sessionId, { timeoutMs: Math.min(5_000, Math.max(500, remaining() - 100)) })
    }
    meta.console = {
      events: [...consoleState.events],
      errors: consoleState.errors,
      truncated: consoleState.truncated,
    }
    meta.network = {
      requests: networkState.requests,
      failures: networkState.failures,
      truncated: networkState.truncated,
      failureSamples: [...networkState.failureSamples],
    }
    meta.url = allowed.url
    meta.page = typeof card.page === 'string' ? card.page : ''
    return { ok: true, artifacts, meta }
  } catch (error) {
    return fail(error)
  } finally {
    try {
      if (connection && typeof connection.close === 'function') connection.close()
    } catch {
      // Closing the client must never mask the result.
    }
    try {
      if (child !== null) killTree(child)
    } catch {
      // The process may already be gone.
    }
    if (userDataDir !== null) {
      // Windows may keep a handle for a moment after taskkill (AV/indexer);
      // retry briefly so a successful card does not leave temp dirs behind.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await fsImpl.rm(userDataDir, { recursive: true, force: true })
          break
        } catch {
          if (attempt === 4) break // a leaked temp dir is acceptable, a hang is not
          await delay(150)
        }
      }
    }
  }
}

/** sha256 helper shared by tests and callers that need to verify artifacts. */
export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}
