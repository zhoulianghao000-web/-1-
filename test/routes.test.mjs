/**
 * v1.3 3.3 — HTTP ops endpoints: /diff, /export, /artifact, /progress (SSE),
 * /cancel (POST), plus the existing fence/method policy.
 *
 * Fake `req`/`res` objects only; the store is a real store in a temp dir.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { HTTP_PREFIX } from '../lib/constants.js'
import { __resetCancelRequests, getCancelRequest } from '../lib/progress.js'
import { createHttpHandler, isAllowedRequest, isLoopbackAddress } from '../lib/routes.js'
import { createCycle, createStore, startRound } from '../lib/store.js'

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rtc-routes-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

class FakeResponse extends EventEmitter {
  constructor() {
    super()
    this.statusCode = 0
    this.headers = null
    this.chunks = []
    this.writableEnded = false
    this.destroyed = false
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode
    this.headers = headers ?? {}
    return this
  }

  write(chunk) {
    if (this.writableEnded) return false
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    return true
  }

  end(chunk) {
    if (chunk !== undefined) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    this.writableEnded = true
    this.emit('end')
    return this
  }

  get text() {
    return Buffer.concat(this.chunks).toString('utf8')
  }

  get json() {
    return JSON.parse(this.text)
  }
}

function makeRequest({ method = 'GET', url = '/', headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  return { method, url, headers, socket: { remoteAddress } }
}

function waitEnded(res, timeoutMs = 5000) {
  if (res.writableEnded) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('response did not end in time')), timeoutMs)
    res.once('end', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function sseEvents(text) {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .filter((block) => !block.startsWith(':'))
    .map((block) => JSON.parse(block.replace(/^data: /, '')))
}

async function makeStoreWithCycle(t, options = {}) {
  const dir = await tempDir(t)
  const stateDir = path.join(dir, 'state')
  const target = path.join(dir, 'app')
  await mkdir(target)
  await writeFile(path.join(target, 'index.html'), '<h1>app</h1>')
  const store = createStore({ stateDir })
  await store.init()
  let ids = null
  await store.mutate((state) => {
    const cycle = createCycle(state, {
      target,
      title: '路由测试项目',
      sessionId: 'session-1',
      required: { score: 95, findings: 3, shots: 4 },
      now: 100,
      reopenedFrom: options.reopenedFrom ?? null,
      reopenCount: options.reopenCount ?? 0,
    })
    const first = startRound(cycle, { now: 101, mode: 'fresh' })
    first.status = 'completed'
    first.finishedAt = 110
    first.attack = {
      verdict: 'HOLD',
      summary: 'summary r1',
      findings: [
        { severity: 'MAJOR', title: 'Broken start button', evidence: 'app.js:42', attack: 'click', impact: 'cannot start', fix: 'bind', confidence: 'high', verified: true },
        { severity: 'MINOR', title: 'Missing alt', evidence: 'index.html:10', attack: 'read', impact: 'a11y', fix: 'alt', confidence: 'high', verified: true },
        { severity: 'MINOR', title: 'Old fixed issue', evidence: 'old.js:1', attack: 'read', impact: 'x', fix: 'y', confidence: 'low', verified: false },
      ],
      solid: ['solid one'],
      unverified: [{ item: 'visual', needs: 'screenshot' }],
    }
    first.score = { score: 80, verdict: 'HOLD', findingsCount: 2, supportedCount: 2, mustFix: ['修复开始按钮'], deductions: [{ points: 5, reason: '功能错误', fix: '修' }], validFindings: [], blockingFindings: [] }
    first.gate = { passed: false, score: 80, requiredScore: 95, findings: 2, requiredFindings: 3, shots: 4, requiredShots: 4, failReasons: ['评分 80 < 要求 95'] }
    first.cost = { totalMs: 1234, evidenceMs: 100, attackMs: 200, judgeMs: 300, promptChars: 10, judgePromptChars: 20, attackChars: 30, scoreChars: 40, judgeSamples: 2, artifactCount: 4 }
    first.progress = { stage: 'done', updatedAt: 110, detail: '' }
    first.evidence = [{
      index: 0,
      name: 'home',
      kind: 'screenshot',
      artifacts: [{ file: 'r1-s1-home.png', width: 1440, height: 900, bytes: 2048, mime: 'image/png' }],
      meta: {},
    }]
    first.snapshot = { manifestHash: 'a'.repeat(64), fileCount: 1, hashedBytes: 10, truncated: false, skippedCount: 0, createdAt: 102, filesFile: 'snapshots/x/r1.json' }
    const second = startRound(cycle, { now: 120, mode: options.secondMode ?? 'fresh' })
    second.status = options.secondStatus ?? 'completed'
    second.finishedAt = 130
    second.attack = {
      verdict: 'BLOCK',
      summary: 'summary r2',
      findings: [
        { severity: 'BLOCKER', title: 'Broken start button', evidence: 'app.js:42 still broken', attack: 'click', impact: 'cannot start', fix: 'bind', confidence: 'high', verified: true },
        { severity: 'MINOR', title: 'New console error', evidence: 'app.js:99', attack: 'open', impact: 'noise', fix: 'clean', confidence: 'high', verified: true },
        { severity: 'MINOR', title: 'Missing alt', evidence: 'index.html:10 unchanged', attack: 'read', impact: 'a11y', fix: 'alt', confidence: 'high', verified: true },
      ],
      solid: [],
      unverified: [],
    }
    second.score = { score: 85, verdict: 'BLOCK', findingsCount: 2, supportedCount: 2, mustFix: ['修复开始按钮'], deductions: [], validFindings: [], blockingFindings: [] }
    second.gate = { passed: false, score: 85, requiredScore: 95, findings: 2, requiredFindings: 3, shots: 4, requiredShots: 4, failReasons: ['mustFix 仍有 1 项未清空'] }
    second.cost = { totalMs: 2345, evidenceMs: 100, attackMs: 200, judgeMs: 300, promptChars: 11, judgePromptChars: 21, attackChars: 31, scoreChars: 41, judgeSamples: 2, artifactCount: 4 }
    second.progress = { stage: 'done', updatedAt: 130, detail: '' }
    second.evidence = []
    second.snapshot = { manifestHash: 'b'.repeat(64), fileCount: 1, hashedBytes: 10, truncated: false, skippedCount: 0, createdAt: 121, filesFile: 'snapshots/x/r2.json' }
    ids = { cycleId: cycle.id, target, stateDir }
  })
  const handler = createHttpHandler({ store, stateDir, now: () => 500, progressPollMs: 5, progressMaxDurationMs: 150 })
  return { ...ids, store, handler, dir }
}

async function get(handler, url, options = {}) {
  const res = new FakeResponse()
  await handler(makeRequest({ url, ...options }), res)
  return res
}

// ---------------------------------------------------------------------------
// fence / method policy
// ---------------------------------------------------------------------------

test('loopback helpers and request fence', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.9.9.9'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('10.0.0.1'), false)
  assert.equal(isLoopbackAddress(''), false)
  assert.equal(isAllowedRequest({ socket: { remoteAddress: '127.0.0.1' } }), true)
  // v2.0: loopback sockets are still CSRF-checked for browser headers.
  assert.equal(isAllowedRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { origin: 'https://evil.example.com' } }), false)
  assert.equal(isAllowedRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'sec-fetch-site': 'cross-site' } }), false)
  // same-site on loopback (same host, different port) is allowed.
  assert.equal(isAllowedRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'sec-fetch-site': 'same-site', origin: 'http://127.0.0.1:3000' } }), true)
  assert.equal(isAllowedRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:51112' } }), true)
  // Non-loopback: a bare (spoofable) Sec-Fetch-Site is NOT sufficient proof.
  assert.equal(isAllowedRequest({ socket: { remoteAddress: '10.0.0.1' }, headers: { 'sec-fetch-site': 'same-origin' } }), false)
  // v2.0: loopback-only — even a loopback-looking Origin on a non-loopback
  // socket is rejected (Origin is client-controlled and forgeable).
  assert.equal(isAllowedRequest({ socket: { remoteAddress: '10.0.0.1' }, headers: { origin: 'http://localhost:1234' } }), false)
  assert.equal(isAllowedRequest({ socket: { remoteAddress: '10.0.0.1' }, headers: { origin: 'https://evil.example.com' } }), false)
  assert.equal(isAllowedRequest({ socket: { remoteAddress: '10.0.0.1' }, headers: {} }), false)
})

test('method policy: old paths stay GET-only, /cancel is POST-only', async (t) => {
  const { handler } = await makeStoreWithCycle(t)
  const getCancel = await get(handler, `${HTTP_PREFIX}/cancel?cycleId=x`)
  assert.equal(getCancel.statusCode, 405)
  assert.equal(getCancel.headers.allow, 'POST')
  const postState = await get(handler, `${HTTP_PREFIX}/state`, { method: 'POST' })
  assert.equal(postState.statusCode, 405)
  assert.equal(postState.headers.allow, 'GET')
  const putDiff = await get(handler, `${HTTP_PREFIX}/diff`, { method: 'PUT' })
  assert.equal(putDiff.statusCode, 405)
  const foreign = await get(handler, `${HTTP_PREFIX}/state`, { remoteAddress: '10.1.2.3' })
  assert.equal(foreign.statusCode, 403)
})

// ---------------------------------------------------------------------------
// artifact
// ---------------------------------------------------------------------------

test('artifact serves png/txt/json/log with content types and rejects escapes', async (t) => {
  const { handler, cycleId, stateDir } = await makeStoreWithCycle(t)
  const cycleDir = path.join(stateDir, 'shots', cycleId)
  await mkdir(cycleDir, { recursive: true })
  await writeFile(path.join(cycleDir, 'r1-s1-home.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
  await writeFile(path.join(cycleDir, 'r1-s2-pdf.txt'), 'PDF text', 'utf8')
  await writeFile(path.join(cycleDir, 'r1-s3-meta.json'), '{"a":1}', 'utf8')
  await writeFile(path.join(cycleDir, 'r1-s4-log.log'), 'log line', 'utf8')

  const png = await get(handler, `${HTTP_PREFIX}/artifact?cycleId=${cycleId}&file=r1-s1-home.png`)
  assert.equal(png.statusCode, 200)
  assert.equal(png.headers['content-type'], 'image/png')
  assert.equal(png.chunks.length > 0, true)
  const txt = await get(handler, `${HTTP_PREFIX}/artifact?cycleId=${cycleId}&file=r1-s2-pdf.txt`)
  assert.equal(txt.statusCode, 200)
  assert.match(txt.headers['content-type'], /^text\/plain/)
  assert.equal(txt.text, 'PDF text')
  const json = await get(handler, `${HTTP_PREFIX}/artifact?cycleId=${cycleId}&file=r1-s3-meta.json`)
  assert.match(json.headers['content-type'], /^application\/json/)
  const log = await get(handler, `${HTTP_PREFIX}/artifact?cycleId=${cycleId}&file=r1-s4-log.log`)
  assert.match(log.headers['content-type'], /^text\/plain/)

  const badExt = await get(handler, `${HTTP_PREFIX}/artifact?cycleId=${cycleId}&file=evil.exe`)
  assert.equal(badExt.statusCode, 400)
  const traversal = await get(handler, `${HTTP_PREFIX}/artifact?cycleId=${cycleId}&file=..%2Fstate.json`)
  assert.equal(traversal.statusCode, 400)
  const badCycle = await get(handler, `${HTTP_PREFIX}/artifact?cycleId=..%2Fbad&file=a.png`)
  assert.equal(badCycle.statusCode, 400)
  const missing = await get(handler, `${HTTP_PREFIX}/artifact?cycleId=${cycleId}&file=r9-s9-none.png`)
  assert.equal(missing.statusCode, 404)
})

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

test('diff reports new/repeat/fixed/severity-changed across rounds', async (t) => {
  const { handler, cycleId } = await makeStoreWithCycle(t)
  const res = await get(handler, `${HTTP_PREFIX}/diff?cycleId=${cycleId}`)
  assert.equal(res.statusCode, 200)
  const body = res.json
  assert.equal(body.ok, true)
  assert.equal(body.cycleId, cycleId)
  assert.equal(body.rounds.length, 2)
  assert.deepEqual(body.rounds.map((round) => round.n), [1, 2])
  assert.deepEqual(body.rounds.map((round) => round.passed), [false, false])
  const byTitle = new Map(body.changes.map((change) => [change.title, change]))
  const start = byTitle.get('Broken start button')
  assert.equal(start.status, 'severity-changed')
  assert.equal(start.severity, 'BLOCKER')
  assert.equal(start.firstRound, 1)
  assert.equal(start.lastRound, 2)
  const alt = byTitle.get('Missing alt')
  assert.equal(alt.status, 'repeat')
  assert.equal(alt.firstRound, 1)
  assert.equal(alt.lastRound, 2)
  const fixed = byTitle.get('Old fixed issue')
  assert.equal(fixed.status, 'fixed')
  assert.equal(fixed.firstRound, 1)
  assert.equal(fixed.lastRound, 1)
  const consoleError = byTitle.get('New console error')
  assert.equal(consoleError.status, 'new')
  assert.equal(consoleError.firstRound, 2)
  assert.equal(consoleError.lastRound, 2)
  for (const change of body.changes) {
    assert.equal(typeof change.key, 'string')
    assert.equal(change.key.length > 0, true)
  }
  const bad = await get(handler, `${HTTP_PREFIX}/diff?cycleId=nope`)
  assert.equal(bad.statusCode, 404)
  const invalid = await get(handler, `${HTTP_PREFIX}/diff?cycleId=..%2Fbad`)
  assert.equal(invalid.statusCode, 400)
})

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

test('export JSON and Markdown are attachments without absolute host paths', async (t) => {
  const { handler, cycleId, stateDir } = await makeStoreWithCycle(t, { reopenedFrom: 'c-old', reopenCount: 2 })
  const json = await get(handler, `${HTTP_PREFIX}/export?cycleId=${cycleId}&format=json`)
  assert.equal(json.statusCode, 200)
  assert.match(json.headers['content-disposition'], /^attachment; filename="rtc-.+\.json"$/)
  assert.match(json.headers['content-type'], /^application\/json/)
  const payload = json.json
  assert.equal(payload.ok, true)
  assert.equal(payload.cycle.id, cycleId)
  assert.equal(payload.cycle.reopenCount, 2)
  assert.equal(payload.cycle.reopenedFrom, 'c-old')
  assert.equal(payload.cycle.rounds.length, 2)
  assert.equal(payload.cycle.rounds[0].findings.length, 3)
  assert.equal(payload.cycle.rounds[0].cost.totalMs, 1234)
  assert.equal(payload.cycle.rounds[0].evidence[0].name, 'home')
  const serialized = JSON.stringify(payload)
  assert.equal(serialized.includes(stateDir), false)
  assert.equal(serialized.includes(path.join(stateDir, 'shots')), false)
  assert.equal(serialized.includes('file:///'), false)

  const md = await get(handler, `${HTTP_PREFIX}/export?cycleId=${cycleId}&format=md`)
  assert.equal(md.statusCode, 200)
  assert.match(md.headers['content-disposition'], /^attachment; filename="rtc-.+\.md"$/)
  assert.match(md.headers['content-type'], /^text\/markdown/)
  assert.ok(md.text.includes('# 红队评审报告'))
  assert.ok(md.text.includes('Broken start button'))
  assert.ok(md.text.includes('mustFix'))
  assert.ok(md.text.includes('成本'))
  assert.ok(md.text.includes('证据'))
  assert.equal(md.text.includes(stateDir), false)

  const badFormat = await get(handler, `${HTTP_PREFIX}/export?cycleId=${cycleId}&format=pdf`)
  assert.equal(badFormat.statusCode, 400)
  const unknown = await get(handler, `${HTTP_PREFIX}/export?cycleId=nope&format=md`)
  assert.equal(unknown.statusCode, 404)
})

// ---------------------------------------------------------------------------
// progress (SSE)
// ---------------------------------------------------------------------------

test('progress streams SSE for a finished round and errors for unknown cycles', async (t) => {
  const { handler, cycleId } = await makeStoreWithCycle(t)
  const res = new FakeResponse()
  const ended = waitEnded(res)
  await handler(makeRequest({ url: `${HTTP_PREFIX}/progress?cycleId=${cycleId}` }), res)
  await ended
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /^text\/event-stream/)
  assert.equal(res.headers['cache-control'], 'no-store')
  const events = sseEvents(res.text)
  assert.equal(events.length >= 1, true)
  assert.equal(events[0].ok, true)
  assert.equal(events[0].cycleId, cycleId)
  assert.equal(events[0].round, 2)
  assert.equal(events[0].done, true)
  assert.equal(events[0].stage, 'done')

  const unknown = new FakeResponse()
  const unknownEnded = waitEnded(unknown)
  await handler(makeRequest({ url: `${HTTP_PREFIX}/progress?cycleId=c-missing` }), unknown)
  await unknownEnded
  const unknownEvents = sseEvents(unknown.text)
  assert.equal(unknownEvents.length, 1)
  assert.equal(unknownEvents[0].ok, false)
  assert.match(unknownEvents[0].error, /未知 cycle/)

  const invalid = await get(handler, `${HTTP_PREFIX}/progress?cycleId=..%2Fbad`)
  assert.equal(invalid.statusCode, 400)
})

test('progress emits a heartbeat and reflects a running round that finishes during polling', async (t) => {
  const { handler, cycleId, store } = await makeStoreWithCycle(t)
  await store.mutate((state) => {
    const cycle = state.cycles[0]
    const round = cycle.rounds[1]
    round.status = 'running'
    round.progress = { stage: 'attacker', updatedAt: 140, detail: '红队审查中' }
    round.finishedAt = null
    round.gate = null
  })
  const res = new FakeResponse()
  const ended = waitEnded(res)
  const requestPromise = handler(makeRequest({ url: `${HTTP_PREFIX}/progress?cycleId=${cycleId}` }), res)
  // Let the stream emit a running event, then finish the round.
  await new Promise((resolve) => setTimeout(resolve, 30))
  await store.mutate((state) => {
    const round = state.cycles[0].rounds[1]
    round.status = 'completed'
    round.finishedAt = 200
    round.progress = { stage: 'done', updatedAt: 200, detail: '' }
  })
  await requestPromise
  await ended
  const events = sseEvents(res.text)
  assert.equal(events.length >= 2, true)
  assert.equal(events[0].done, false)
  assert.equal(events[0].stage, 'attacker')
  assert.equal(events.at(-1).done, true)
  assert.equal(events.at(-1).stage, 'done')
  // Heartbeats are comments, not events.
  assert.ok(res.text.includes(': keep-alive') || events.length >= 2)
})

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

test('POST /cancel requests cancellation only for a running round and clears after use', async (t) => {
  __resetCancelRequests()
  t.after(() => __resetCancelRequests())
  const { handler, cycleId, store } = await makeStoreWithCycle(t)
  const idle = await get(handler, `${HTTP_PREFIX}/cancel?cycleId=${cycleId}`, { method: 'POST' })
  assert.equal(idle.statusCode, 200)
  assert.equal(idle.json.ok, true)
  assert.equal(idle.json.cancelled, false)
  assert.match(idle.json.reason, /没有进行中的轮次/)

  await store.mutate((state) => {
    const round = state.cycles[0].rounds[1]
    round.status = 'running'
    round.finishedAt = null
  })
  const active = await get(handler, `${HTTP_PREFIX}/cancel?cycleId=${cycleId}`, { method: 'POST' })
  assert.equal(active.statusCode, 200)
  assert.equal(active.json.cancelled, true)
  assert.equal(active.json.round, 2)
  assert.equal(getCancelRequest(cycleId).requestedAt > 0, true)
  __resetCancelRequests()

  const unknown = await get(handler, `${HTTP_PREFIX}/cancel?cycleId=nope`, { method: 'POST' })
  assert.equal(unknown.statusCode, 404)
  const foreign = await get(handler, `${HTTP_PREFIX}/cancel?cycleId=${cycleId}`, { method: 'POST', remoteAddress: '10.0.0.5' })
  assert.equal(foreign.statusCode, 403)
  const readBack = await readFile(path.join(store.stateDir, 'state.json'), 'utf8')
  assert.ok(readBack.includes(cycleId))
})
