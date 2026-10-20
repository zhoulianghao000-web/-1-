/**
 * v1.2 2.2 zero-dependency CDP runner tests.
 *
 * The real browser is never launched: pipe framing, request/response matching,
 * event dispatch, timeouts, cleanup and the interaction-card logic are covered
 * with fake pipes / a fake CDP connection. (`test/manual-cdp-smoke.mjs` is the
 * opt-in script that exercises the real chrome-headless-shell pipe.)
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildChromeArgs,
  createCdpConnection,
  createCdpMessageDecoder,
  encodeCdpMessage,
  isAllowedNavigationUrl,
  resolveKeyDefinition,
  runInteractionCard,
} from '../lib/cdp.js'

function pngHeader(width, height, byteLength = 2048) {
  const buffer = Buffer.alloc(byteLength)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'latin1')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  buffer[24] = 8
  buffer[25] = 6
  return buffer
}

/** Fake writable pipe: records every encoded frame. */
class FakeWritable {
  constructor() {
    this.chunks = []
  }

  write(chunk) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return true
  }

  on() {}

  off() {}
}

class FakeReadable extends EventEmitter {}

function framesOf(writable) {
  const merged = Buffer.concat(writable.chunks)
  return merged.toString('utf8')
    .split('\0')
    .filter((frame) => frame.trim() !== '')
    .map((frame) => JSON.parse(frame))
}

function respond(readable, message) {
  readable.emit('data', Buffer.from(`${JSON.stringify(message)}\0`, 'utf8'))
}

// ---------------------------------------------------------------------------
// pure protocol helpers
// ---------------------------------------------------------------------------

test('encodeCdpMessage NUL-terminates JSON frames', () => {
  const encoded = encodeCdpMessage({ id: 1, method: 'Page.enable', params: {} })
  assert.equal(encoded.endsWith('\0'), true)
  assert.deepEqual(JSON.parse(encoded.slice(0, -1)), { id: 1, method: 'Page.enable', params: {} })
})

test('decoder handles fragmentation, multiple frames, UTF-8 splits and invalid frames', () => {
  const received = []
  const invalid = []
  const decoder = createCdpMessageDecoder((message) => received.push(message), { onInvalid: (frame) => invalid.push(frame) })
  const first = encodeCdpMessage({ id: 1, method: 'A', result: { text: '中文内容' } })
  const second = encodeCdpMessage({ id: 2, method: 'B', result: {} })
  const bytes = Buffer.from(`${first}${second}`, 'utf8')
  // Push one byte at a time: multi-byte UTF-8 characters are split too.
  for (const byte of bytes) decoder.push(Buffer.from([byte]))
  assert.equal(received.length, 2)
  assert.equal(received[0].result.text, '中文内容')
  assert.equal(received[1].id, 2)
  assert.equal(decoder.pending().length, 0)

  decoder.push(Buffer.from('not json\0\0', 'utf8'))
  decoder.push(Buffer.from(`${encodeCdpMessage({ id: 3 })}\0`, 'utf8'))
  assert.equal(invalid.length, 1)
  assert.equal(received.length, 3)
  assert.equal(received[2].id, 3)
  decoder.reset()
  assert.equal(decoder.pending().length, 0)
})

test('createCdpConnection matches responses by id, in any order', async () => {
  const writable = new FakeWritable()
  const readable = new FakeReadable()
  const connection = createCdpConnection({ writable, readable, defaultTimeoutMs: 500 })
  const firstPromise = connection.send('Page.enable', {}, { timeoutMs: 500 })
  const secondPromise = connection.send('Runtime.evaluate', { expression: '1' }, { timeoutMs: 500 })
  const frames = framesOf(writable)
  assert.equal(frames.length, 2)
  assert.equal(frames[0].method, 'Page.enable')
  assert.equal(frames[1].method, 'Runtime.evaluate')
  // Respond out of order.
  respond(readable, { id: frames[1].id, result: { result: { value: 1 } } })
  respond(readable, { id: frames[0].id, result: { ok: true } })
  assert.deepEqual(await firstPromise, { ok: true })
  assert.deepEqual(await secondPromise, { result: { value: 1 } })
  connection.close()
})

test('createCdpConnection rejects CDP errors, timeouts and closed pipes', async () => {
  const writable = new FakeWritable()
  const readable = new FakeReadable()
  const connection = createCdpConnection({ writable, readable, defaultTimeoutMs: 500 })
  const errorPromise = connection.send('Bad.method', {}, { timeoutMs: 500 })
  const [frame] = framesOf(writable)
  respond(readable, { id: frame.id, error: { code: -32601, message: 'Method not found' } })
  await assert.rejects(errorPromise, /Method not found/)

  await assert.rejects(connection.send('Slow.method', {}, { timeoutMs: 20 }), /超时/)

  const pending = connection.send('Pending.method', {}, { timeoutMs: 500 })
  connection.close()
  await assert.rejects(pending, /已关闭/)
  await assert.rejects(connection.send('After.close', {}, { timeoutMs: 10 }), /已关闭/)

  const writable2 = new FakeWritable()
  const readable2 = new FakeReadable()
  const connection2 = createCdpConnection({ writable: writable2, readable: readable2, defaultTimeoutMs: 500 })
  const pending2 = connection2.send('Will.fail', {}, { timeoutMs: 500 })
  readable2.emit('end')
  await assert.rejects(pending2, /已关闭/)
})

test('createCdpConnection dispatches events with session filtering and unsubscribe', async () => {
  const writable = new FakeWritable()
  const readable = new FakeReadable()
  const connection = createCdpConnection({ writable, readable, defaultTimeoutMs: 500 })
  const seen = []
  const unsubscribe = connection.on('Page.loadEventFired', (params) => seen.push(params), { sessionId: 's1' })
  respond(readable, { method: 'Page.loadEventFired', params: { marker: 's1' }, sessionId: 's1' })
  respond(readable, { method: 'Page.loadEventFired', params: { marker: 's2' }, sessionId: 's2' })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].marker, 's1')

  const oncePromise = connection.once('Target.attachedToTarget', { timeoutMs: 200, sessionId: 's1' })
  respond(readable, { method: 'Target.attachedToTarget', params: { sessionId: 's1' }, sessionId: 's1' })
  assert.deepEqual(await oncePromise, { sessionId: 's1' })

  unsubscribe()
  respond(readable, { method: 'Page.loadEventFired', params: { marker: 's1' }, sessionId: 's1' })
  assert.equal(seen.length, 1)
  connection.close()
})

test('resolveKeyDefinition supports named keys, letters, digits and rejects others', () => {
  assert.deepEqual(resolveKeyDefinition('Space'), { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' })
  assert.equal(resolveKeyDefinition('Enter').windowsVirtualKeyCode, 13)
  assert.equal(resolveKeyDefinition('ArrowUp').windowsVirtualKeyCode, 38)
  assert.deepEqual(resolveKeyDefinition('w'), { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 })
  assert.deepEqual(resolveKeyDefinition('7'), { key: '7', code: 'Digit7', windowsVirtualKeyCode: 55 })
  assert.equal(resolveKeyDefinition('F13'), null)
  assert.equal(resolveKeyDefinition(''), null)
  assert.equal(resolveKeyDefinition(42), null)
})

test('buildChromeArgs contains the pipe/debug flags and viewport', () => {
  const args = buildChromeArgs({ width: 900, height: 700, userDataDir: 'C:\\tmp\\x' })
  for (const flag of ['--headless=new', '--remote-debugging-pipe', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1']) {
    assert.ok(args.includes(flag), `missing ${flag}`)
  }
  assert.ok(args.includes('--window-size=900,700'))
  assert.ok(args.includes('--user-data-dir=C:\\tmp\\x'))
  assert.equal(args[args.length - 1], 'about:blank')
})

test('isAllowedNavigationUrl enforces file/loopback/allowlist rules', () => {
  assert.equal(isAllowedNavigationUrl('file:///C:/demo/index.html').ok, true)
  assert.equal(isAllowedNavigationUrl('http://127.0.0.1:3000/').ok, true)
  assert.equal(isAllowedNavigationUrl('http://localhost:8080/a').ok, true)
  assert.equal(isAllowedNavigationUrl('https://allowed.example.com/app', { allowedOrigins: ['https://allowed.example.com'] }).ok, true)
  assert.equal(isAllowedNavigationUrl('https://evil.example.com/', {}).ok, false)
  assert.equal(isAllowedNavigationUrl('javascript:alert(1)', {}).ok, false)
  assert.equal(isAllowedNavigationUrl('not a url', {}).ok, false)
  assert.equal(isAllowedNavigationUrl('', {}).ok, false)
})

// ---------------------------------------------------------------------------
// runInteractionCard with a fake CDP connection
// ---------------------------------------------------------------------------

class FakeConnection {
  constructor(options = {}) {
    this.sent = []
    this.handlers = new Map()
    this.closed = false
    this.pngBase64 = options.pngBase64 ?? pngHeader(900, 700).toString('base64')
    this.clickResult = options.clickResult ?? { ok: true, tag: 'BUTTON' }
    this.clickException = options.clickException ?? null
    this.navigateHangs = options.navigateHangs === true
    this.perfMetrics = options.perfMetrics ?? [{ name: 'JSHeapUsedSize', value: 12345 }, { name: 'TaskDuration', value: 0.5 }]
    this.fpsSample = options.fpsSample ?? { frames: 60, ms: 1000 }
  }

  send(method, params = {}) {
    this.sent.push({ method, params })
    if (method === 'Target.createTarget') return Promise.resolve({ targetId: 'target-1' })
    if (method === 'Target.attachToTarget') return Promise.resolve({ sessionId: 'session-1' })
    if (method === 'Page.navigate') {
      if (this.navigateHangs) return new Promise(() => {})
      queueMicrotask(() => {
        this.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'boom' }] }, 'session-1')
        this.emit('Log.entryAdded', { entry: { level: 'error', source: 'javascript', text: 'log boom' } }, 'session-1')
        this.emit('Network.responseReceived', { response: { status: 404, url: 'http://127.0.0.1:9/missing.js' }, type: 'Script' }, 'session-1')
        this.emit('Network.responseReceived', { response: { status: 200, url: 'http://127.0.0.1:9/app.js' }, type: 'Script' }, 'session-1')
        this.emit('Page.loadEventFired', {}, 'session-1')
      })
      return Promise.resolve({ loaderId: 'loader-1' })
    }
    if (method === 'Page.captureScreenshot') return Promise.resolve({ data: this.pngBase64 })
    if (method === 'Runtime.evaluate') {
      const expression = String(params.expression ?? '')
      if (expression.includes('document.readyState')) return Promise.resolve({ result: { value: 'complete' } })
      if (expression.includes('querySelector')) {
        if (this.clickException !== null) {
          return Promise.resolve({ exceptionDetails: { text: 'SyntaxError', exception: { description: this.clickException } } })
        }
        return Promise.resolve({ result: { value: this.clickResult } })
      }
      if (expression.includes('performance.now')) return Promise.resolve({ result: { value: this.fpsSample } })
      return Promise.resolve({ result: { value: true } })
    }
    if (method === 'Performance.getMetrics') return Promise.resolve({ metrics: this.perfMetrics })
    return Promise.resolve({})
  }

  on(method, handler, options = {}) {
    const bucket = this.handlers.get(method) ?? []
    const entry = { handler, sessionId: options.sessionId ?? null }
    bucket.push(entry)
    this.handlers.set(method, bucket)
    return () => {
      this.handlers.set(method, (this.handlers.get(method) ?? []).filter((item) => item !== entry))
    }
  }

  once(method, options = {}) {
    return new Promise((resolve) => {
      const entry = {
        handler: (params) => {
          this.handlers.set(method, (this.handlers.get(method) ?? []).filter((item) => item !== entry))
          resolve(params)
        },
        sessionId: options.sessionId ?? null,
      }
      this.handlers.set(method, [...(this.handlers.get(method) ?? []), entry])
    })
  }

  emit(method, params, sessionId = null) {
    for (const entry of [...(this.handlers.get(method) ?? [])]) {
      if (entry.sessionId !== null && entry.sessionId !== sessionId) continue
      entry.handler(params, { method, params, sessionId })
    }
  }

  close() {
    this.closed = true
  }
}

function makeFakeSpawn() {
  const calls = []
  const fn = (binary, args) => {
    calls.push({ binary, args })
    return {
      pid: 4242,
      stdio: [null, null, null, new FakeWritable(), new FakeReadable()],
      once: () => {},
      kill: () => {},
    }
  }
  return { fn, calls }
}

function interactionCard(overrides = {}) {
  return {
    kind: 'interaction',
    name: 'playthrough',
    slug: 'playthrough',
    width: 900,
    height: 700,
    url: 'file:///C:/demo/index.html',
    page: 'index.html',
    collect: { console: true, network: true, perf: true },
    steps: [
      { action: 'click', selector: '#start' },
      { action: 'key', key: 'Space' },
      { action: 'wait', ms: 5 },
      { action: 'screenshot', name: 'playing' },
    ],
    ...overrides,
  }
}

async function runCard(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rtc-cdp-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const removed = []
  const fsImpl = {
    mkdir,
    mkdtemp,
    writeFile,
    readFile,
    rm: async (target, opts) => {
      removed.push(String(target))
      await rm(target, opts)
    },
  }
  const spawn = makeFakeSpawn()
  const connection = options.connection ?? new FakeConnection(options.connectionOptions)
  const killCalls = []
  const result = await runInteractionCard({
    card: options.card ?? interactionCard(),
    outDir: path.join(dir, 'shots', 'c-test'),
    roundNo: options.roundNo ?? 2,
    shotIndex: options.shotIndex ?? 3,
    chrome: { path: 'C:\\fake\\chrome-headless-shell.exe' },
    config: { interactionTimeoutSeconds: options.timeoutSeconds ?? 60, allowedOrigins: [] },
    fsImpl,
    spawnImpl: spawn.fn,
    connectionFactory: async () => connection,
    killTree: (child) => killCalls.push(child?.pid ?? null),
    now: options.now ?? Date.now,
  })
  return { result, connection, spawn, killCalls, removed, dir }
}

test('runInteractionCard executes steps, captures a representative frame and collects evidence', async (t) => {
  const { result, connection, spawn, killCalls, removed, dir } = await runCard(t)
  assert.equal(result.ok, true, result.error)
  assert.equal(spawn.calls.length, 1)
  assert.ok(spawn.calls[0].args.includes('--remote-debugging-pipe'))
  assert.equal(connection.sent.some((entry) => entry.method === 'Target.createTarget'), true)
  assert.equal(connection.sent.some((entry) => entry.method === 'Target.attachToTarget'), true)
  assert.equal(connection.sent.some((entry) => entry.method === 'Emulation.setDeviceMetricsOverride'), true)
  assert.equal(connection.sent.filter((entry) => entry.method === 'Input.dispatchKeyEvent').length, 2)
  assert.equal(result.artifacts.length, 1)
  assert.equal(result.artifacts[0].file, 'r2-s3-playthrough.png')
  assert.match(result.artifacts[0].sha256, /^[0-9a-f]{64}$/)
  assert.equal(result.artifacts[0].width, 900)
  assert.equal(result.meta.console.errors, 2)
  assert.equal(result.meta.console.events.length >= 1, true)
  assert.equal(result.meta.network.requests, 2)
  assert.equal(result.meta.network.failures, 1)
  assert.equal(result.meta.perf.fps, 60)
  assert.equal(typeof result.meta.perf.metrics.JSHeapUsedSize, 'number')
  assert.deepEqual(result.meta.steps.map((step) => step.action), ['click', 'key', 'wait', 'screenshot'])
  // Cleanup: browser killed, CDP connection closed, temp dir removed.
  assert.deepEqual(killCalls, [4242])
  assert.equal(connection.closed, true)
  assert.equal(removed.length, 1)
  // The artifact really exists on disk in the evidence directory.
  const files = await readdir(path.join(dir, 'shots', 'c-test'))
  assert.equal(files.includes('r2-s3-playthrough.png'), true)
  const bytes = await readFile(result.artifacts[0].path)
  assert.ok(bytes.length > 1024)
})

test('runInteractionCard auto-captures a frame when no screenshot step exists', async (t) => {
  const card = interactionCard({ name: 'idle', steps: [{ action: 'wait', ms: 1 }] })
  const { result } = await runCard(t, { card, shotIndex: 1 })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.artifacts.length, 1)
  assert.equal(result.artifacts[0].file, 'r2-s1-idle.png')
  assert.deepEqual(result.meta.steps.map((step) => step.action), ['wait', 'screenshot'])
})

test('runInteractionCard produces extra frames with x<idx> naming', async (t) => {
  const card = interactionCard({
    steps: [
      { action: 'screenshot', name: 'start' },
      { action: 'click', selector: '#go' },
      { action: 'screenshot', name: 'mid' },
    ],
  })
  const { result } = await runCard(t, { card, shotIndex: 2 })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.artifacts.map((artifact) => artifact.file), ['r2-s2-playthrough.png', 'r2-s2-x2-mid.png'])
  assert.equal(result.meta.steps.filter((step) => step.action === 'screenshot').length, 2)
})

test('runInteractionCard fails cleanly for missing elements, bad selectors and whitelist violations', async (t) => {
  const missing = await runCard(t, {
    connectionOptions: { clickResult: { ok: false, reason: 'not-found' } },
  })
  assert.equal(missing.result.ok, false)
  assert.match(missing.result.error, /找不到元素/)
  assert.deepEqual(missing.killCalls, [4242])
  assert.equal(missing.result.artifacts.length, 0)

  const invalid = await runCard(t, {
    connectionOptions: { clickException: 'SyntaxError: Failed to execute querySelector' },
  })
  assert.equal(invalid.result.ok, false)
  assert.match(invalid.result.error, /click 步骤失败/)

  const blocked = await runCard(t, { card: interactionCard({ url: 'https://evil.example.com/' }) })
  assert.equal(blocked.result.ok, false)
  assert.match(blocked.result.error, /白名单/)
  assert.equal(blocked.spawn.calls.length, 0)
})

test('runInteractionCard enforces the per-card timeout and still cleans up', async (t) => {
  const startedAt = Date.now()
  const { result, killCalls, removed } = await runCard(t, {
    connectionOptions: { navigateHangs: true },
    timeoutSeconds: 1,
  })
  const elapsed = Date.now() - startedAt
  assert.equal(result.ok, false)
  assert.match(result.error, /超时/)
  assert.ok(elapsed < 5000, `timeout should be prompt, took ${elapsed}ms`)
  assert.deepEqual(killCalls, [4242])
  assert.equal(removed.length, 1)
})

test('runInteractionCard never throws and rejects non-interaction cards', async () => {
  const result = await runInteractionCard({ card: { kind: 'screenshot' }, outDir: os.tmpdir() })
  assert.equal(result.ok, false)
  assert.match(result.error, /interaction/)
  const noChrome = await runInteractionCard({
    card: interactionCard(),
    outDir: path.join(os.tmpdir(), 'rtc-never'),
    chrome: null,
  })
  assert.equal(noChrome.ok, false)
  assert.match(noChrome.error, /无头浏览器/)
})
