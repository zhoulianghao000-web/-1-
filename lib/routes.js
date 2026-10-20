/**
 * HTTP routes consumed by the Web GUI panel (CONTRACT.md §2.7 / v1.3 §2.13).
 *
 * Prefix `/adversarial-review`:
 *   GET  /state?                     public state document
 *   GET  /shot?cycleId=&file=        representative PNG evidence
 *   GET  /artifact?cycleId=&file=    any evidence artifact (png/txt/json/log)
 *   GET  /diff?cycleId=              cross-round findings diff
 *   GET  /export?cycleId=&format=    Markdown|JSON report attachment
 *   GET  /progress?cycleId=          Server-Sent Events progress stream
 *   POST /cancel?cycleId=            request cancellation of the in-flight round
 *
 * Every request is fenced to loopback or a local same-origin browser request;
 * old paths stay GET-only, `/cancel` is POST-only and other methods get a JSON
 * 405. The returned handler never rejects: it catches its own failures and
 * always ends the reply.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { HTTP_PREFIX } from './constants.js'
import { buildDiff, buildExportMarkdown, buildExportPayload, exportFilename } from './export.js'
import { getCancelRequest, progressView, requestCancel } from './progress.js'
import { findCycleById, latestRoundOf, toPublicCycle, toPublicState } from './store.js'

const CYCLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const SHOT_FILE_PATTERN = /^r\d{1,4}-s\d{1,4}-[A-Za-z0-9._-]{1,80}\.png$/
const ARTIFACT_FILE_PATTERN = /^[A-Za-z0-9._-]{1,120}\.(png|txt|json|log)$/
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
})
const CONTENT_TYPES = Object.freeze({
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
})

function isIPv4Loopback(address) {
  const parts = String(address).split('.')
  if (parts.length !== 4) return false
  if (parts[0] !== '127') return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Loopback predicate for socket addresses: 127/8, ::1, IPv4-mapped. */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return false
  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost' || normalized === '[::1]' || normalized === '::1') return true
  return isIPv4Loopback(normalized)
}

/**
 * Access fence: loopback socket, or a browser same-origin marker / local Origin.
 * Never trusts X-Forwarded-For. v2.0: browser CSRF headers are checked even on
 * loopback, and `Sec-Fetch-Site` is NOT accepted as the only proof for a
 * non-loopback caller (it is trivially forgeable outside a browser).
 */
export function isAllowedRequest(req) {
  try {
    const headers = req?.headers ?? {}
    const origin = headers.origin
    const fetchSite = String(headers['sec-fetch-site'] ?? '').toLowerCase()
    let originIsLoopback = false
    if (typeof origin === 'string' && origin !== '') {
      const parsed = new URL(origin)
      originIsLoopback = isLoopbackHostname(parsed.hostname)
    }
    if (isLoopbackAddress(req?.socket?.remoteAddress)) {
      // Cross-site browser requests usually carry an Origin and/or a
      // cross-site Sec-Fetch-Site; reject those even though the socket is local.
      if (typeof origin === 'string' && origin !== '' && !originIsLoopback) return false
      // same-site is allowed for loopback (same host, different port is still
      // the local machine); only cross-site browser requests are rejected.
      if (fetchSite !== '' && fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none') return false
      return true
    }
    // Non-loopback sockets: the plugin is loopback-only by design. A client
    // Origin header is trivially forgeable, so it is never accepted as proof.
    return false
  } catch {
    // Malformed headers are simply not trusted.
    return false
  }
}

function writeJson(res, status, body, headers = {}) {
  try {
    if (res.writableEnded === true || res.destroyed === true) return
  } catch {
    return
  }
  const payload = JSON.stringify(body)
  try {
    res.writeHead(status, {
      ...JSON_HEADERS,
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload, 'utf8'),
      ...headers,
    })
    res.end(payload)
  } catch {
    try {
      res.end()
    } catch {
      // The socket is gone; nothing to do.
    }
  }
}

function writeBuffer(res, data, headers) {
  try {
    if (res.writableEnded === true || res.destroyed === true) return
    res.writeHead(200, {
      'content-length': data.length,
      'referrer-policy': 'no-referrer',
      ...headers,
    })
    res.end(data)
  } catch {
    try {
      res.end()
    } catch {
      // The socket is gone; nothing to do.
    }
  }
}

function writePng(res, data) {
  writeBuffer(res, data, {
    'content-type': 'image/png',
    'cache-control': 'private, max-age=3600',
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/**
 * Build the `(req, res)` handler for the registered prefix route.
 *
 * @param {object} options
 * @param {ReturnType<import('./store.js').createStore>} options.store
 * @param {string} [options.stateDir] defaults to `store.stateDir`
 * @param {() => number} [options.now]
 * @param {number} [options.progressPollMs] SSE poll interval (default 1000; tests inject small values)
 * @param {number} [options.progressMaxDurationMs] SSE hard end (default 30000)
 */
export function createHttpHandler(options = {}) {
  const {
    store,
    stateDir,
    now = Date.now,
    progressPollMs = 1000,
    progressMaxDurationMs = 30_000,
  } = options
  if (!store || typeof store.init !== 'function') throw new Error('createHttpHandler 需要 store')
  const shotRoot = path.resolve(typeof stateDir === 'string' && stateDir !== '' ? stateDir : store.stateDir)

  async function handleProgress(req, res, url) {
    const cycleId = url.searchParams.get('cycleId') ?? ''
    if (!CYCLE_ID_PATTERN.test(cycleId)) {
      writeJson(res, 400, { ok: false, error: 'cycleId 不合法' })
      return
    }
    await store.init()
    const headers = {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'referrer-policy': 'no-referrer',
    }
    let closed = false
    const onClose = () => { closed = true }
    try {
      if (res.destroyed === true || res.writableEnded === true) return
      res.writeHead(200, headers)
      if (typeof res.on === 'function') res.on('close', onClose)
    } catch {
      return
    }
    const writeEvent = (payload) => {
      if (closed) return false
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
        return true
      } catch {
        closed = true
        return false
      }
    }
    const writeComment = (text) => {
      if (closed) return
      try {
        res.write(`: ${text}\n\n`)
      } catch {
        closed = true
      }
    }
    try {
      const initialCycle = findCycleById(store.state, cycleId)
      if (initialCycle === null) {
        writeEvent({ ok: false, cycleId, error: `未知 cycle：${cycleId}` })
        return
      }
      const startedAt = now()
      let polls = 0
      while (!closed && now() - startedAt <= Math.max(50, progressMaxDurationMs)) {
        const cycle = findCycleById(store.state, cycleId)
        if (cycle === null) {
          writeEvent({ ok: false, cycleId, error: `未知 cycle：${cycleId}` })
          break
        }
        const round = latestRoundOf(cycle)
        const view = progressView(round, now())
        const accepted = writeEvent({
          ok: true,
          cycleId,
          round: view.round,
          stage: view.stage,
          updatedAt: view.updatedAt,
          done: view.done,
          detail: view.detail,
          serverTime: view.serverTime,
        })
        if (!accepted || view.done) break
        polls += 1
        if (polls % 5 === 0) writeComment('keep-alive')
        await delay(Math.max(1, progressPollMs))
      }
    } catch {
      // A broken SSE consumer must never crash the HTTP handler.
    } finally {
      try {
        res.end()
      } catch {
        // already ended/closed
      }
      if (typeof res.off === 'function') {
        try { res.off('close', onClose) } catch { /* ignore */ }
      }
    }
  }

  return async function adversarialReviewHttpHandler(req, res) {
    try {
      const method = String(req?.method ?? 'GET').toUpperCase()
      let url = null
      try {
        url = new URL(req.url ?? '/', 'http://localhost')
      } catch {
        writeJson(res, 400, { ok: false, error: '请求 URL 不合法' })
        return
      }
      const { pathname } = url
      const isCancelPath = pathname === `${HTTP_PREFIX}/cancel`

      // Method policy: old paths GET-only; /cancel POST-only; everything else 405.
      if (method === 'POST') {
        if (!isCancelPath) {
          writeJson(res, 405, { ok: false, error: '只允许 GET 请求' }, { allow: 'GET' })
          return
        }
      } else if (method === 'GET') {
        if (isCancelPath) {
          writeJson(res, 405, { ok: false, error: '取消评审只允许 POST 请求' }, { allow: 'POST' })
          return
        }
      } else {
        writeJson(res, 405, { ok: false, error: '不支持的请求方法' }, { allow: isCancelPath ? 'POST' : 'GET' })
        return
      }

      if (!isAllowedRequest(req)) {
        writeJson(res, 403, { ok: false, error: '禁止访问：仅允许本机回环或同源请求' })
        return
      }

      if (pathname === `${HTTP_PREFIX}/state`) {
        await store.init()
        writeJson(res, 200, toPublicState(store.state, { generatedAt: now() }))
        return
      }

      if (pathname === `${HTTP_PREFIX}/shot`) {
        const cycleId = url.searchParams.get('cycleId') ?? ''
        const file = url.searchParams.get('file') ?? ''
        if (!CYCLE_ID_PATTERN.test(cycleId)) {
          writeJson(res, 400, { ok: false, error: 'cycleId 不合法' })
          return
        }
        if (!SHOT_FILE_PATTERN.test(file)) {
          writeJson(res, 400, { ok: false, error: 'file 不合法（必须是本轮 PNG 文件名）' })
          return
        }
        const cycleDir = path.resolve(shotRoot, 'shots', cycleId)
        const target = path.resolve(cycleDir, file)
        if (path.dirname(target) !== cycleDir) {
          writeJson(res, 400, { ok: false, error: '路径越界，拒绝访问' })
          return
        }
        let data = null
        try {
          data = await fs.readFile(target)
        } catch (error) {
          if (error?.code === 'ENOENT' || error?.code === 'EISDIR') {
            writeJson(res, 404, { ok: false, error: `截图文件不存在：${file}` })
          } else {
            writeJson(res, 500, { ok: false, error: `读取截图失败：${error?.message || error}` })
          }
          return
        }
        writePng(res, data)
        return
      }

      if (pathname === `${HTTP_PREFIX}/artifact`) {
        const cycleId = url.searchParams.get('cycleId') ?? ''
        const file = url.searchParams.get('file') ?? ''
        if (!CYCLE_ID_PATTERN.test(cycleId)) {
          writeJson(res, 400, { ok: false, error: 'cycleId 不合法' })
          return
        }
        if (!ARTIFACT_FILE_PATTERN.test(file) || file.includes('..')) {
          writeJson(res, 400, { ok: false, error: 'file 不合法（只允许 png/txt/json/log 证据产物）' })
          return
        }
        const cycleDir = path.resolve(shotRoot, 'shots', cycleId)
        const target = path.resolve(cycleDir, file)
        if (path.dirname(target) !== cycleDir) {
          writeJson(res, 400, { ok: false, error: '路径越界，拒绝访问' })
          return
        }
        const contentType = CONTENT_TYPES[path.extname(file).toLowerCase()]
        if (contentType === undefined) {
          writeJson(res, 400, { ok: false, error: '不支持的证据文件类型' })
          return
        }
        let data = null
        try {
          data = await fs.readFile(target)
        } catch (error) {
          if (error?.code === 'ENOENT' || error?.code === 'EISDIR') {
            writeJson(res, 404, { ok: false, error: `证据文件不存在：${file}` })
          } else {
            writeJson(res, 500, { ok: false, error: `读取证据失败：${error?.message || error}` })
          }
          return
        }
        writeBuffer(res, data, {
          'content-type': contentType,
          'cache-control': 'private, max-age=3600',
        })
        return
      }

      if (pathname === `${HTTP_PREFIX}/diff`) {
        const cycleId = url.searchParams.get('cycleId') ?? ''
        if (!CYCLE_ID_PATTERN.test(cycleId)) {
          writeJson(res, 400, { ok: false, error: 'cycleId 不合法' })
          return
        }
        await store.init()
        const cycle = findCycleById(store.state, cycleId)
        if (cycle === null) {
          writeJson(res, 404, { ok: false, error: `未知 cycle：${cycleId}` })
          return
        }
        writeJson(res, 200, buildDiff(cycle, { now }))
        return
      }

      if (pathname === `${HTTP_PREFIX}/export`) {
        const cycleId = url.searchParams.get('cycleId') ?? ''
        const format = (url.searchParams.get('format') ?? 'json').toLowerCase()
        if (!CYCLE_ID_PATTERN.test(cycleId)) {
          writeJson(res, 400, { ok: false, error: 'cycleId 不合法' })
          return
        }
        if (format !== 'json' && format !== 'md') {
          writeJson(res, 400, { ok: false, error: 'format 只支持 md 或 json' })
          return
        }
        await store.init()
        const cycle = findCycleById(store.state, cycleId)
        if (cycle === null) {
          writeJson(res, 404, { ok: false, error: `未知 cycle：${cycleId}` })
          return
        }
        const payload = buildExportPayload(toPublicCycle(cycle), { now })
        const filename = exportFilename(cycleId, format, now())
        const disposition = `attachment; filename="${filename}"`
        if (format === 'md') {
          const markdown = buildExportMarkdown(payload)
          const buffer = Buffer.from(markdown, 'utf8')
          writeBuffer(res, buffer, {
            'content-type': 'text/markdown; charset=utf-8',
            'content-disposition': disposition,
            'cache-control': 'no-store',
          })
        } else {
          writeJson(res, 200, payload, {
            'content-disposition': disposition,
          })
        }
        return
      }

      if (pathname === `${HTTP_PREFIX}/progress`) {
        await handleProgress(req, res, url)
        return
      }

      if (isCancelPath) {
        const cycleId = url.searchParams.get('cycleId') ?? ''
        if (!CYCLE_ID_PATTERN.test(cycleId)) {
          writeJson(res, 400, { ok: false, error: 'cycleId 不合法' })
          return
        }
        await store.init()
        const cycle = findCycleById(store.state, cycleId)
        if (cycle === null) {
          writeJson(res, 404, { ok: false, error: `未知 cycle：${cycleId}` })
          return
        }
        const round = latestRoundOf(cycle)
        if (round === null || round.status !== 'running') {
          writeJson(res, 200, {
            ok: true,
            cancelled: false,
            cycleId,
            reason: '该 cycle 当前没有进行中的轮次',
            pending: getCancelRequest(cycleId) !== null,
          })
          return
        }
        const requested = requestCancel(cycleId)
        writeJson(res, 200, {
          ok: true,
          cancelled: requested.cancelled === true,
          cycleId,
          round: Number.isInteger(round.n) ? round.n : null,
          reason: requested.reason,
        })
        return
      }

      writeJson(res, 404, { ok: false, error: `未知接口：${pathname}` })
    } catch (error) {
      try {
        writeJson(res, 500, { ok: false, error: `服务内部错误：${error?.message || error}` })
      } catch {
        // The response helpers already swallow socket failures.
      }
    }
  }
}
