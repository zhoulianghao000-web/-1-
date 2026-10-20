import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DEFAULT_CONFIG, HTTP_PREFIX, TOOL_BATCH, TOOL_PROBE, TOOL_ROUND, TOOL_STATUS } from '../lib/constants.js'
import { apply, buildEffectiveConfig } from '../index.js'
import { clearReviewRegistry, registerReviewChild } from '../lib/review-registry.js'
import { computeSnapshotSync } from '../lib/snapshot.js'

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rtc-index-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

function makePng(width, height, byteLength = 2048) {
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

/** Minimal fake Cordis context capturing every registration. */
function createFakeContext(services = {}) {
  const registrations = { tools: [], guards: [], sections: [], routes: [] }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: (name) => services[name],
    effect: (factory) => {
      const disposer = factory()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    tools: {
      register: (definition) => {
        registrations.tools.push(definition)
        return () => {}
      },
      guard: (guard) => {
        registrations.guards.push(guard)
        return () => {}
      },
    },
  }
  return { ctx, registrations, services }
}

function installFakeWebServer(services, registrations) {
  services.webServer = {
    register: (route) => {
      registrations.routes.push(route)
      return () => {}
    },
    getOrigin: () => 'http://127.0.0.1:12345',
  }
  return services.webServer
}

function installFakeSystemPrompt(services, registrations) {
  services.systemPrompt = {
    section: (section) => {
      registrations.sections.push(section)
      return () => {}
    },
  }
  return services.systemPrompt
}

function makeWorkingDirectory(target) {
  return { ensure: async () => target, defaultDirectory: target }
}

function applyPlugin(services, config) {
  const { ctx, registrations } = createFakeContext(services)
  apply(ctx, config)
  return { ctx, registrations, services }
}

function findTool(registrations, name) {
  return registrations.tools.find((tool) => tool.name === name)
}

function makeExec(agentId = 'session-A') {
  return { agent: { id: agentId }, arguments: {}, signal: new AbortController().signal }
}

function makeRequest({ method = 'GET', url = '/', headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  return { method, url, headers, socket: { remoteAddress } }
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: null,
    body: null,
    writableEnded: false,
    destroyed: false,
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers ?? null
      return this
    },
    end(body) {
      if (body !== undefined) this.body = body
      this.writableEnded = true
      return this
    },
  }
}

function baseConfig(stateDir, overrides = {}) {
  return { ...DEFAULT_CONFIG, stateDir, ...overrides }
}

// ---------------------------------------------------------------------------
// config + wiring
// ---------------------------------------------------------------------------

test('buildEffectiveConfig clamps every value and ignores unknown keys', () => {
  const config = buildEffectiveConfig({
    requiredScore: 99,
    requiredFindings: 0,
    requiredShots: 'nope',
    maxRounds: 9999,
    roundTimeoutSeconds: 1,
    screenshotTimeoutSeconds: 0,
    enabled: 'yes',
    announceToAgent: false,
    stateDir: 42,
    unknownKey: 'ignored',
    anotherUnknown: { deep: true },
  })
  assert.equal(Object.isFrozen(config), true)
  assert.equal(config.requiredScore, 99)
  // requiredScore is bounded by 0–100, not by the old 0–10 scale.
  assert.equal(buildEffectiveConfig({ requiredScore: 420 }).requiredScore, 100)
  assert.equal(buildEffectiveConfig({ requiredScore: -5 }).requiredScore, 0)
  assert.equal(buildEffectiveConfig({ requiredScore: '95' }).requiredScore, 95)
  assert.equal(config.requiredFindings, 1)
  assert.equal(config.requiredShots, DEFAULT_CONFIG.requiredShots)
  assert.equal(config.maxRounds, 40)
  assert.equal(config.roundTimeoutSeconds, 30)
  assert.equal(config.screenshotTimeoutSeconds, 5)
  assert.equal(config.enabled, true)
  assert.equal(config.announceToAgent, false)
  assert.equal(config.stateDir, '')
  // v1.1 1.3/1.4 config surface: bounded arrays + snapshot limits.
  assert.deepEqual(config.deliverableRoots, [])
  assert.deepEqual(config.allowedOrigins, [])
  assert.equal(config.snapshotMaxFiles, 20000)
  assert.equal(config.snapshotMaxHashBytes, 536870912)
  assert.equal(config.snapshotMaxFileBytes, 67108864)
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'unknownKey'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'anotherUnknown'), false)
  assert.deepEqual({ ...buildEffectiveConfig(null) }, { ...DEFAULT_CONFIG })
  assert.deepEqual({ ...buildEffectiveConfig('nope') }, { ...DEFAULT_CONFIG })
})

test('apply rejects invalid judgeModels instead of silently falling back', () => {
  // CONTRACT §2.14: invalid judgeModels must fail loudly; a silent fallback to
  // DEFAULT_CONFIG would also reset stateDir and could fail-open the gates.
  assert.throws(
    () => applyPlugin({}, baseConfig('state', { judgeModels: [{ model: '' }] })),
    /judgeModels|模型/,
  )
})

test('buildEffectiveConfig sanitizes deliverableRoots / allowedOrigins / snapshot limits', () => {
  const roots = buildEffectiveConfig({
    deliverableRoots: ['C:\\ws', ' C:\\ws ', 42, '', 'C:\\ws\\app'],
    allowedOrigins: ['http://127.0.0.1:3000', 'javascript:alert(1)', 'https://a.test/path', 'nope'],
    snapshotMaxFiles: 999999,
    snapshotMaxHashBytes: '123',
  })
  assert.deepEqual(roots.deliverableRoots, [path.resolve('C:\\ws'), path.resolve('C:\\ws\\app')])
  assert.deepEqual(roots.allowedOrigins, ['http://127.0.0.1:3000', 'https://a.test'])
  assert.equal(roots.snapshotMaxFiles, 200000)
  assert.equal(roots.snapshotMaxHashBytes, 1024)
  assert.equal(Object.isFrozen(roots.deliverableRoots), true)
  // Non-array / hostile values fall back to the defaults.
  assert.deepEqual(buildEffectiveConfig({ deliverableRoots: 'C:\\x' }).deliverableRoots, [])
  assert.deepEqual(buildEffectiveConfig({ allowedOrigins: null }).allowedOrigins, [])
})

test('buildEffectiveConfig bounds judgeSamples and passes model-route strings', () => {
  assert.equal(DEFAULT_CONFIG.judgeSamples, 2)
  assert.equal(buildEffectiveConfig({}).judgeSamples, 2)
  assert.equal(buildEffectiveConfig(null).judgeSamples, 2)
  assert.equal(buildEffectiveConfig({ judgeSamples: 1 }).judgeSamples, 1)
  assert.equal(buildEffectiveConfig({ judgeSamples: 2 }).judgeSamples, 2)
  assert.equal(buildEffectiveConfig({ judgeSamples: 3 }).judgeSamples, 3)
  assert.equal(buildEffectiveConfig({ judgeSamples: 0 }).judgeSamples, 1)
  assert.equal(buildEffectiveConfig({ judgeSamples: -9 }).judgeSamples, 1)
  assert.equal(buildEffectiveConfig({ judgeSamples: 99 }).judgeSamples, 3)
  assert.equal(buildEffectiveConfig({ judgeSamples: '2' }).judgeSamples, 2)
  assert.equal(buildEffectiveConfig({ judgeSamples: 2.4 }).judgeSamples, 2)
  assert.equal(buildEffectiveConfig({ judgeSamples: 2.6 }).judgeSamples, 3)
  assert.equal(buildEffectiveConfig({ judgeSamples: 'nope' }).judgeSamples, 2)
  assert.equal(buildEffectiveConfig({ judgeSamples: null }).judgeSamples, 2)

  const routed = buildEffectiveConfig({
    attackerProvider: 'alt',
    attackerModel: 'attack-x',
    attackerReasoningEffort: 'low',
    judgeProvider: 'alt',
    judgeModel: 'judge-x',
    judgeReasoningEffort: 'high',
  })
  assert.equal(routed.attackerProvider, 'alt')
  assert.equal(routed.attackerModel, 'attack-x')
  assert.equal(routed.attackerReasoningEffort, 'low')
  assert.equal(routed.judgeProvider, 'alt')
  assert.equal(routed.judgeModel, 'judge-x')
  assert.equal(routed.judgeReasoningEffort, 'high')

  // Non-strings never reach the child; missing values mean "inherit".
  const ignored = buildEffectiveConfig({ judgeModel: 42, judgeProvider: null, attackerModel: { x: 1 } })
  assert.equal(ignored.judgeModel, '')
  assert.equal(ignored.judgeProvider, '')
  assert.equal(ignored.attackerModel, '')
  assert.equal(DEFAULT_CONFIG.attackerProvider, '')
  assert.equal(DEFAULT_CONFIG.attackerModel, '')
  assert.equal(DEFAULT_CONFIG.attackerReasoningEffort, '')
  assert.equal(DEFAULT_CONFIG.judgeProvider, '')
  assert.equal(DEFAULT_CONFIG.judgeModel, '')
  assert.equal(DEFAULT_CONFIG.judgeReasoningEffort, '')
})

// ---------------------------------------------------------------------------
// v2.0 Stage A: strict judgeModels validation + drift threshold config
// ---------------------------------------------------------------------------

test('buildEffectiveConfig validates judgeModels strictly', () => {
  assert.deepEqual([...DEFAULT_CONFIG.judgeModels], [])
  assert.deepEqual([...buildEffectiveConfig({}).judgeModels], [])
  const valid = buildEffectiveConfig({
    judgeModels: [
      { provider: ' p1 ', model: 'm1' },
      { model: 'm2', reasoningEffort: 'high' },
      {},
    ],
  })
  assert.deepEqual(valid.judgeModels, [
    { provider: 'p1', model: 'm1' },
    { model: 'm2', reasoningEffort: 'high' },
    {},
  ])
  assert.equal(Object.isFrozen(valid.judgeModels), true)
  assert.equal(Object.isFrozen(valid.judgeModels[0]), true)

  const invalidCases = [
    ['null', null],
    ['非数组', 'nope'],
    ['非数组对象', { provider: 'p' }],
    ['超过 3 个', [{ provider: 'p' }, { provider: 'p' }, { provider: 'p' }, { provider: 'p' }]],
    ['非对象条目', ['model']],
    ['数组条目', [[]]],
    ['未知字段', [{ provider: 'p', secret: 'x' }]],
    ['空字符串', [{ model: '  ' }]],
    ['非字符串', [{ model: 42 }]],
    ['过长', [{ model: 'x'.repeat(201) }]],
  ]
  for (const [label, value] of invalidCases) {
    assert.throws(
      () => buildEffectiveConfig({ judgeModels: value }),
      (error) => error instanceof Error && error.message.includes('judgeModels'),
      label,
    )
  }
})

test('v2.0 buildEffectiveConfig bounds drift thresholds', () => {
  assert.equal(DEFAULT_CONFIG.driftScoreDelta, 5)
  assert.equal(DEFAULT_CONFIG.driftRecallDelta, 0.1)
  assert.equal(DEFAULT_CONFIG.driftPassRateDelta, 0.1)
  assert.equal(buildEffectiveConfig({}).driftScoreDelta, 5)
  assert.equal(buildEffectiveConfig({ driftScoreDelta: 8 }).driftScoreDelta, 8)
  assert.equal(buildEffectiveConfig({ driftScoreDelta: 0 }).driftScoreDelta, 0.1)
  assert.equal(buildEffectiveConfig({ driftScoreDelta: 999 }).driftScoreDelta, 100)
  assert.equal(buildEffectiveConfig({ driftScoreDelta: '7.5' }).driftScoreDelta, 7.5)
  assert.equal(buildEffectiveConfig({ driftScoreDelta: 'nope' }).driftScoreDelta, 5)
  assert.equal(buildEffectiveConfig({ driftRecallDelta: 0.25 }).driftRecallDelta, 0.25)
  assert.equal(buildEffectiveConfig({ driftRecallDelta: -1 }).driftRecallDelta, 0)
  assert.equal(buildEffectiveConfig({ driftRecallDelta: 2 }).driftRecallDelta, 1)
  assert.equal(buildEffectiveConfig({ driftPassRateDelta: 0.5 }).driftPassRateDelta, 0.5)
  assert.equal(buildEffectiveConfig({ driftPassRateDelta: 'bad' }).driftPassRateDelta, 0.1)
})

test('apply registers both tools, the guard and no optional surfaces when services are absent', async (t) => {
  const dir = await tempDir(t)
  const { registrations } = applyPlugin({}, baseConfig(path.join(dir, 'state')))
  assert.deepEqual(registrations.tools.map((tool) => tool.name).sort(), [TOOL_BATCH, TOOL_PROBE, TOOL_ROUND, TOOL_STATUS].sort())
  assert.equal(registrations.guards.length, 1)
  assert.equal(registrations.routes.length, 0)
  assert.equal(registrations.sections.length, 0)

  const roundTool = findTool(registrations, TOOL_ROUND)
  // Worst case: 1 attacker + 3 judges × 2160s + 4 interaction cards × 600s =
  // 11040s; the outer tool budget is 14_400_000ms (4h), strictly above it.
  assert.equal(roundTool.timeoutMs, 14_400_000)
  assert.ok(roundTool.timeoutMs > (1 + 3) * 2160_000 + 4 * 600_000)
  assert.equal(roundTool.parameters.type, 'object')
  assert.equal(roundTool.parameters.additionalProperties, false)
  assert.deepEqual(roundTool.parameters.required, ['target'])
  assert.equal(typeof roundTool.execute, 'function')
  assert.equal(typeof roundTool.output.render, 'function')
  assert.deepEqual(roundTool.output.render(null, { ok: true }), [{ type: 'text', text: '{"ok":true}' }])

  const statusTool = findTool(registrations, TOOL_STATUS)
  assert.equal(statusTool.parameters.additionalProperties, false)
})

test('apply registers routes/section when the optional services exist (and respects toggles)', async (t) => {
  const dir = await tempDir(t)
  const services = {}
  const scope = createFakeContext(services)
  installFakeWebServer(services, scope.registrations)
  installFakeSystemPrompt(services, scope.registrations)
  apply(scope.ctx, baseConfig(path.join(dir, 'state')))
  assert.equal(scope.registrations.routes.length, 1)
  const route = scope.registrations.routes[0]
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, HTTP_PREFIX)
  assert.equal(typeof route.handler, 'function')
  assert.equal(scope.registrations.sections.length, 1)
  const section = scope.registrations.sections[0]
  assert.equal(section.name, 'adversarial-review')
  assert.equal(section.order, 900)
  assert.ok(section.text.includes(TOOL_ROUND))
  assert.ok(section.text.includes('gate.passed'))

  // announceToAgent=false → no section.
  const quietServices = {}
  const quiet = createFakeContext(quietServices)
  installFakeSystemPrompt(quietServices, quiet.registrations)
  apply(quiet.ctx, baseConfig(path.join(dir, 'state-3'), { announceToAgent: false }))
  assert.equal(quiet.registrations.sections.length, 0)

  // enabled=false → nothing registered at all.
  const disabledServices = {}
  const disabled = createFakeContext(disabledServices)
  installFakeWebServer(disabledServices, disabled.registrations)
  apply(disabled.ctx, baseConfig(path.join(dir, 'state-4'), { enabled: false }))
  assert.equal(disabled.registrations.tools.length, 0)
  assert.equal(disabled.registrations.routes.length, 0)
  assert.equal(disabled.registrations.sections.length, 0)
  assert.equal(disabled.registrations.guards.length, 0)
})

// ---------------------------------------------------------------------------
// tool execute + guard + status through the public plugin surface
// ---------------------------------------------------------------------------

test('round tool fails gracefully without subagents, status works, and guards block completion/present', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const stateDir = path.join(dir, 'state')
  const services = { workingDirectory: makeWorkingDirectory(target) }
  const { registrations } = applyPlugin(services, baseConfig(stateDir))
  const roundTool = findTool(registrations, TOOL_ROUND)
  const statusTool = findTool(registrations, TOOL_STATUS)
  const guard = registrations.guards[0]

  const exec = makeExec()
  const roundResult = await roundTool.execute({ target, title: '演示应用' }, exec)
  assert.equal(roundResult.ok, false)
  assert.equal(roundResult.stage, 'subagents-unavailable')
  assert.match(roundResult.error, /子智能体服务/)

  const status = await statusTool.execute({}, exec)
  assert.equal(status.ok, true)
  assert.equal(status.version, 1)
  assert.equal(status.cycles.length, 1)
  assert.equal(status.cycles[0].target, target)
  assert.equal(status.cycles[0].latest.status, 'failed')
  assert.equal(status.cycles[0].latest.gatePassed, null)

  // Guard blocks completing the goal in the cycle-owning session.
  const blocked = guard({ name: 'update_goal', arguments: { action: 'complete' }, agent: { id: 'session-A' } })
  assert.equal(typeof blocked, 'string')
  assert.match(blocked, /红队评审台/)
  assert.match(blocked, /尚未通过门控/)
  // Other sessions / other actions are untouched.
  assert.equal(guard({ name: 'update_goal', arguments: { action: 'complete' }, agent: { id: 'session-B' } }), undefined)
  assert.equal(guard({ name: 'update_goal', arguments: { action: 'edit' }, agent: { id: 'session-A' } }), undefined)
  assert.equal(guard({ name: 'read', arguments: {}, agent: { id: 'session-A' } }), undefined)
  assert.equal(guard(null), undefined)

  // v2.0 goalGateRoots: only exact delivery roots are enforced, so nested
  // calibration fixtures / demos that are intentionally defective cannot block
  // completion. A parent directory is NOT a match (exact root only).
  const outOfScopeConfig = baseConfig(stateDir, { goalGateRoots: [dir] })
  const outOfScope = applyPlugin({ workingDirectory: makeWorkingDirectory(target) }, outOfScopeConfig)
  await findTool(outOfScope.registrations, TOOL_STATUS).execute({})
  const outOfScopeGuard = outOfScope.registrations.guards[0]
  // CONTRACT §guard: goalGateRoots only gates the roots it lists. A session
  // whose reviewed roots are all out-of-scope is not gated by this scope and
  // may complete normally (out-of-scope fixtures must not block the goal).
  assert.equal(
    outOfScopeGuard({ name: 'update_goal', arguments: { action: 'complete' }, agent: { id: 'session-A' } }),
    undefined,
  )

  const inScopeConfig = baseConfig(stateDir, { goalGateRoots: [target] })
  const inScope = applyPlugin({ workingDirectory: makeWorkingDirectory(target) }, inScopeConfig)
  await findTool(inScope.registrations, TOOL_STATUS).execute({})
  const inScopeGuard = inScope.registrations.guards[0]
  assert.match(
    inScopeGuard({ name: 'update_goal', arguments: { action: 'complete' }, agent: { id: 'session-A' } }),
    /尚未通过门控/,
  )

  // present(): files inside an unpassed target are blocked, outside are not.
  const insideFile = path.join(target, 'index.html')
  await writeFile(insideFile, '<h1>x</h1>')
  const outsideFile = path.join(dir, 'elsewhere.txt')
  await writeFile(outsideFile, 'x')
  assert.equal(
    typeof guard({ name: 'present', arguments: { files: [{ path: insideFile }] }, agent: { id: 'session-A' } }),
    'string',
  )
  assert.equal(
    guard({ name: 'present', arguments: { files: [{ path: outsideFile }] }, agent: { id: 'session-A' } }),
    undefined,
  )
  // v1.1 1.3: the present gate is project-level — a different session (or a
  // forked/subagent session) may not deliver files of a reviewed project.
  const crossSession = guard({ name: 'present', arguments: { files: [{ path: insideFile }] }, agent: { id: 'session-B' } })
  assert.equal(typeof crossSession, 'string')
  assert.match(crossSession, /红队评审台/)
  // A present without any agent still cannot bypass the project gate.
  assert.equal(typeof guard({ name: 'present', arguments: { files: [{ path: insideFile }] } }), 'string')

  // Status tool validates its own arguments.
  assert.equal((await statusTool.execute({ target: 42 }, exec)).stage, 'arguments')
  assert.equal((await statusTool.execute({ limit: 999 }, exec)).stage, 'arguments')
  const filtered = await statusTool.execute({ target, limit: 1 }, exec)
  assert.equal(filtered.cycles.length, 1)
})

test('late webServer service is picked up by the next tool call', async (t) => {
  const dir = await tempDir(t)
  const stateDir = path.join(dir, 'state')
  const services = {}
  const { registrations } = applyPlugin(services, baseConfig(stateDir))
  assert.equal(registrations.routes.length, 0)
  const statusTool = findTool(registrations, TOOL_STATUS)
  assert.ok(statusTool)
  // The Host composes webServer after the plugin row: a later call retries.
  installFakeWebServer(services, registrations)
  const status = await statusTool.execute({}, makeExec())
  assert.equal(status.ok, true)
  assert.equal(registrations.routes.length, 1)
})

// ---------------------------------------------------------------------------
// guard toggles
// ---------------------------------------------------------------------------

test('enforceGoalGate / enforceGateOnPresent toggles disable the guard', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  await writeFile(path.join(target, 'index.html'), '<h1>x</h1>')
  const services = { workingDirectory: makeWorkingDirectory(target) }
  const { registrations } = applyPlugin(services, baseConfig(path.join(dir, 'state'), {
    enforceGoalGate: false,
    enforceGateOnPresent: false,
  }))
  const roundTool = findTool(registrations, TOOL_ROUND)
  const guard = registrations.guards[0]
  // Create a failed reviewing cycle, then prove both guards stay off.
  const failed = await roundTool.execute({ target }, makeExec())
  assert.equal(failed.ok, false)
  assert.equal(guard({ name: 'update_goal', arguments: { action: 'complete' }, agent: { id: 'session-A' } }), undefined)
  assert.equal(guard({
    name: 'present',
    arguments: { files: [{ path: path.join(target, 'index.html') }] },
    agent: { id: 'session-A' },
  }), undefined)
})

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

test('HTTP routes: fenced state JSON, PNG evidence, traversal and method rejection', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const stateDir = path.join(dir, 'state')
  const services = { workingDirectory: makeWorkingDirectory(target) }
  const scope = createFakeContext(services)
  installFakeWebServer(services, scope.registrations)
  apply(scope.ctx, baseConfig(stateDir))
  const registrations = scope.registrations
  const statusTool = findTool(registrations, TOOL_STATUS)
  const roundTool = findTool(registrations, TOOL_ROUND)

  // Create one failed cycle so /state has content.
  await roundTool.execute({ target }, makeExec())
  const route = registrations.routes[0]
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, HTTP_PREFIX)

  const stateResponse = makeResponse()
  await route.handler(makeRequest({ url: `${HTTP_PREFIX}/state` }), stateResponse)
  assert.equal(stateResponse.statusCode, 200)
  assert.equal(stateResponse.headers['cache-control'], 'no-store')
  const stateBody = JSON.parse(stateResponse.body)
  assert.equal(stateBody.ok, true)
  assert.equal(stateBody.version, 1)
  assert.equal(stateBody.cycles.length, 1)
  assert.equal(stateBody.cycles[0].rounds.length, 1)
  assert.equal(stateBody.cycles[0].rounds[0].shots.length, 0)

  // Fence: non-loopback without same-origin markers is rejected.
  const forbidden = makeResponse()
  await route.handler(makeRequest({ url: `${HTTP_PREFIX}/state`, remoteAddress: '10.0.0.7' }), forbidden)
  assert.equal(forbidden.statusCode, 403)
  assert.equal(JSON.parse(forbidden.body).ok, false)

  // v2.0: a bare Sec-Fetch-Site header is spoofable and no longer authorizes a
  // non-loopback socket; only an explicit loopback Origin does.
  const sameOrigin = makeResponse()
  await route.handler(makeRequest({
    url: `${HTTP_PREFIX}/state`,
    remoteAddress: '10.0.0.7',
    headers: { 'sec-fetch-site': 'same-origin' },
  }), sameOrigin)
  assert.equal(sameOrigin.statusCode, 403)

  // Only GET.
  const post = makeResponse()
  await route.handler(makeRequest({ method: 'POST', url: `${HTTP_PREFIX}/state` }), post)
  assert.equal(post.statusCode, 405)

  // Unknown subpath.
  const unknown = makeResponse()
  await route.handler(makeRequest({ url: `${HTTP_PREFIX}/unknown` }), unknown)
  assert.equal(unknown.statusCode, 404)

  // PNG evidence route.
  const shotDir = path.join(stateDir, 'shots', 'c-test')
  await mkdir(shotDir, { recursive: true })
  const pngBuffer = makePng(1440, 900)
  await writeFile(path.join(shotDir, 'r1-s1-desktop.png'), pngBuffer)
  const shot = makeResponse()
  await route.handler(makeRequest({ url: `${HTTP_PREFIX}/shot?cycleId=c-test&file=r1-s1-desktop.png` }), shot)
  assert.equal(shot.statusCode, 200)
  assert.equal(shot.headers['content-type'], 'image/png')
  assert.equal(shot.headers['cache-control'], 'private, max-age=3600')
  assert.equal(Buffer.isBuffer(shot.body), true)
  assert.deepEqual([...shot.body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])

  const missing = makeResponse()
  await route.handler(makeRequest({ url: `${HTTP_PREFIX}/shot?cycleId=c-test&file=r1-s2-missing.png` }), missing)
  assert.equal(missing.statusCode, 404)

  for (const query of [
    'cycleId=..%2Fescape&file=r1-s1-desktop.png',
    'cycleId=c-test&file=..%2Fstate.json',
    'cycleId=c-test&file=not-a-shot.png',
    'cycleId=c-test',
  ]) {
    const bad = makeResponse()
    await route.handler(makeRequest({ url: `${HTTP_PREFIX}/shot?${query}` }), bad)
    assert.equal(bad.statusCode, 400, `expected 400 for ${query}`)
  }

  // Status tool remains usable after the HTTP round-trips.
  const status = await statusTool.execute({}, makeExec())
  assert.equal(status.ok, true)
})

test('status tool renders compact JSON text through the tool output contract', async (t) => {
  const dir = await tempDir(t)
  const { registrations } = applyPlugin({}, baseConfig(path.join(dir, 'state')))
  const statusTool = findTool(registrations, TOOL_STATUS)
  const value = await statusTool.execute({}, makeExec())
  const content = statusTool.output.render(null, value)
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'text')
  const parsed = JSON.parse(content[0].text)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.cycles, [])
})

// ---------------------------------------------------------------------------
// v1.1 1.3/1.4: project-level guard matrix (snapshot binding)
// ---------------------------------------------------------------------------

/** A completed round document with an optional snapshot seal. */
function makeGuardRound({ snapshot = null, passed = false, failReasons = [], score = passed ? 95 : 80 } = {}) {
  const round = {
    n: 1,
    status: 'completed',
    rubricVersion: 'v2-100',
    startedAt: 10,
    finishedAt: 20,
    error: null,
    shots: [],
    attack: null,
    score: null,
    gate: {
      passed,
      score,
      requiredScore: 95,
      findings: passed ? 4 : 0,
      requiredFindings: 3,
      shots: passed ? 4 : 0,
      requiredShots: 4,
      failReasons,
    },
  }
  if (snapshot !== null) round.snapshot = snapshot
  return round
}

function makeGuardCycle({ id, target, deliverableRoot, sessionId, status, round }) {
  return {
    id,
    target,
    title: `项目 ${id}`,
    createdAt: 1,
    updatedAt: 2,
    status,
    sessionId,
    ...(deliverableRoot === undefined ? {} : { deliverableRoot }),
    required: { score: 95, findings: 3, shots: 4 },
    rounds: [round],
  }
}

function makeSnapshotRecord(manifestHash, filesFile = null) {
  return {
    manifestHash,
    gitCommit: null,
    fileCount: 1,
    hashedBytes: 10,
    truncated: false,
    skippedCount: 0,
    createdAt: 5,
    filesFile,
  }
}

/** Persist a passed round's hashed file list (v2.0 guard needs it). */
async function writeSnapshotFiles(stateDir, cycleId, roundNo, manifestHash, entries) {
  const dir = path.join(stateDir, 'snapshots', cycleId)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `r${roundNo}.json`)
  await writeFile(file, JSON.stringify({
    manifestHash,
    files: entries.map((entry) => ({ path: entry, size: 10, mtimeMs: 5, sha256: 'a'.repeat(64) })),
  }), 'utf8')
  return `snapshots/${cycleId}/r${roundNo}.json`
}

test('v1.1 guard matrix: cross-session present, snapshot mismatch, legacy and reviewing cycles', async (t) => {
  const dir = await tempDir(t)
  const stateDir = path.join(dir, 'state')
  await mkdir(stateDir, { recursive: true })

  // Project A: passed and unchanged → delivery allowed.
  const appA = path.join(dir, 'app-a')
  await mkdir(appA, { recursive: true })
  await writeFile(path.join(appA, 'index.html'), '<h1>A</h1>')
  const hashA = computeSnapshotSync(appA).manifestHash

  // Project B: passed, then modified → delivery blocked.
  const appB = path.join(dir, 'app-b')
  await mkdir(appB, { recursive: true })
  await writeFile(path.join(appB, 'index.html'), '<h1>B-original</h1>')
  const hashB = computeSnapshotSync(appB).manifestHash
  await writeFile(path.join(appB, 'index.html'), '<h1>B-modified</h1>')

  // Project C: passed before snapshots existed (legacy) → delivery allowed.
  const appC = path.join(dir, 'app-c')
  await mkdir(appC, { recursive: true })
  await writeFile(path.join(appC, 'index.html'), '<h1>C</h1>')

  // Project D: still reviewing (failed gate) → delivery blocked.
  const appD = path.join(dir, 'app-d')
  await mkdir(appD, { recursive: true })
  await writeFile(path.join(appD, 'index.html'), '<h1>D</h1>')

  // Project E: passed snapshot, but the project root is gone → fail-closed.
  const appE = path.join(dir, 'app-e')
  await mkdir(appE, { recursive: true })
  await writeFile(path.join(appE, 'index.html'), '<h1>E</h1>')
  const hashE = computeSnapshotSync(appE).manifestHash
  await rm(appE, { recursive: true, force: true })

  // Project F: same session owns an out-of-scope failed fixture root; a scoped
  // goalGateRoots=[appA] must still allow sess-a to complete on appA.
  const appF = path.join(dir, 'app-f')
  await mkdir(appF, { recursive: true })
  await writeFile(path.join(appF, 'index.html'), '<h1>F</h1>')

  const filesA = await writeSnapshotFiles(stateDir, 'c-a', 1, hashA, ['index.html'])
  const filesB = await writeSnapshotFiles(stateDir, 'c-b', 1, hashB, ['index.html'])

  await writeFile(path.join(stateDir, 'state.json'), JSON.stringify({
    schemaVersion: 2,
    updatedAt: 100,
    cycles: [
      makeGuardCycle({ id: 'c-a', target: appA, sessionId: 'sess-a', status: 'passed', round: makeGuardRound({ snapshot: makeSnapshotRecord(hashA, filesA), passed: true }) }),
      makeGuardCycle({ id: 'c-b', target: appB, sessionId: 'sess-b', status: 'passed', round: makeGuardRound({ snapshot: makeSnapshotRecord(hashB, filesB), passed: true }) }),
      makeGuardCycle({ id: 'c-c', target: appC, sessionId: 'sess-c', status: 'passed', round: makeGuardRound({ passed: true }) }),
      makeGuardCycle({ id: 'c-d', target: appD, sessionId: 'sess-d', status: 'reviewing', round: makeGuardRound({ passed: false, failReasons: ['评分 80 < 要求 95'] }) }),
      makeGuardCycle({ id: 'c-e', target: appE, sessionId: 'sess-e', status: 'passed', round: makeGuardRound({ snapshot: makeSnapshotRecord(hashE), passed: true }) }),
      makeGuardCycle({ id: 'c-f', target: appF, sessionId: 'sess-a', status: 'reviewing', round: makeGuardRound({ passed: false, failReasons: ['评分 40 < 要求 95'] }) }),
    ],
  }), 'utf8')

  const services = { workingDirectory: makeWorkingDirectory(appA) }
  const { registrations } = applyPlugin(services, baseConfig(stateDir))
  const statusTool = findTool(registrations, TOOL_STATUS)
  const guard = registrations.guards[0]
  assert.equal(typeof guard, 'function')

  // Force the store to load; status also exposes integrity diagnostics.
  const status = await statusTool.execute({})
  assert.equal(status.ok, true)
  assert.equal(status.cycles.length, 6)
  // v1.3: loading the v2 fixture migrates + re-seals it as v3.
  assert.equal(status.integrity.verified, true)
  assert.match(status.integrity.hash, /^[0-9a-f]{64}$/)
  assert.equal(status.integrity.error, null)

  const present = (filePath, agentId = 'some-other-session') => guard({
    name: 'present',
    arguments: { files: [{ path: filePath }] },
    agent: agentId === null ? undefined : { id: agentId },
  })

  // passed + unchanged: any session may deliver.
  assert.equal(present(path.join(appA, 'index.html')), undefined)
  assert.equal(present(path.join(appA, 'index.html'), 'entirely-different-session'), undefined)
  assert.equal(present(path.join(appA, 'index.html'), null), undefined)

  // passed + changed: blocked with a re-review instruction.
  const changed = present(path.join(appB, 'index.html'))
  assert.equal(typeof changed, 'string')
  assert.match(changed, /快照哈希不一致/)
  assert.match(changed, /重新评审/)
  // The cycle's own session is blocked too (no pass-then-edit-then-deliver).
  assert.match(present(path.join(appB, 'index.html'), 'sess-b'), /快照哈希不一致/)

  // legacy passed round without a snapshot file list: fail closed for present
  // (it cannot prove the submitted file was not changed after review).
  const legacy = present(path.join(appC, 'index.html'))
  assert.equal(typeof legacy, 'string')
  assert.match(legacy, /快照文件清单|重新评审/)

  // still reviewing: cross-session block with the usual gate reason.
  const reviewing = present(path.join(appD, 'index.html'))
  assert.equal(typeof reviewing, 'string')
  assert.match(reviewing, /尚未通过门控/)
  assert.match(present(path.join(appD, 'index.html'), 'sess-d'), /尚未通过门控/)

  // Project root deleted after passing: fail closed, do not crash.
  const unreachable = present(path.join(appE, 'index.html'))
  assert.equal(typeof unreachable, 'string')
  assert.match(unreachable, /快照重算失败|不可访问/)

  // Outside every deliverable root: allowed.
  const outside = path.join(dir, 'outside.txt')
  await writeFile(outside, 'x')
  assert.equal(present(outside), undefined)

  // Relative paths are resolved against every known deliverable root; a
  // mismatch anywhere in the submission still blocks.
  assert.equal(typeof present('index.html', 'sess-a'), 'string')
  assert.match(present('index.html', 'sess-a'), /快照哈希不一致/)
  assert.equal(typeof present('index.html', 'sess-b'), 'string')

  // update_goal(complete): passed-but-modified session is blocked…
  const completeChanged = guard({ name: 'update_goal', arguments: { action: 'complete' }, agent: { id: 'sess-b' } })
  assert.equal(typeof completeChanged, 'string')
  assert.match(completeChanged, /快照哈希不一致/)
  // …a reviewing session keeps the old block…
  assert.match(
    guard({ name: 'update_goal', arguments: { action: 'complete' }, agent: { id: 'sess-d' } }),
    /尚未通过门控/,
  )
  // …legacy passed rounds without a snapshot/file list are now fail-closed for
  // completion too (must reopen/incremental to re-review)…
  const completeLegacy = guard({ name: 'update_goal', arguments: { action: 'complete' }, agent: { id: 'sess-c' } })
  assert.equal(typeof completeLegacy, 'string')
  assert.match(completeLegacy, /快照|重新评审/)
  // v2.0: positive goalGateRoots path — a passed goal root scoped exactly must
  // allow completion even though the same session owns other (failed) fixture
  // roots; those nested/other roots are intentionally excluded by the scope.
  const scoped = applyPlugin(
    { workingDirectory: makeWorkingDirectory(appA) },
    baseConfig(stateDir, { goalGateRoots: [appA] }),
  )
  await findTool(scoped.registrations, TOOL_STATUS).execute({})
  const scopedGuard = scoped.registrations.guards[0]
  assert.equal(
    scopedGuard({ name: 'update_goal', arguments: { action: 'complete' }, agent: { id: 'sess-a' } }),
    undefined,
  )
  // …while unrelated sessions / other actions remain allowed.
  assert.equal(guard({ name: 'update_goal', arguments: { action: 'complete' }, agent: { id: 'sess-unrelated' } }), undefined)
  assert.equal(guard({ name: 'update_goal', arguments: { action: 'edit' }, agent: { id: 'sess-b' } }), undefined)
  assert.equal(guard({ name: 'update_goal', arguments: { action: 'complete' } }), undefined)
  assert.equal(guard(null), undefined)
})

// ---------------------------------------------------------------------------
// v1.1 1.5: hard read-only reviewers + review_probe
// ---------------------------------------------------------------------------

test('v2.0 present gate checks every overlapping deliverable root (no fail-open)', async (t) => {
  const dir = await tempDir(t)
  const stateDir = path.join(dir, 'state')
  await mkdir(stateDir, { recursive: true })
  const parent = path.join(dir, 'parent')
  const child = path.join(parent, 'child')
  await mkdir(child, { recursive: true })
  await writeFile(path.join(child, 'index.html'), '<h1>child</h1>')
  const hashParent = computeSnapshotSync(parent).manifestHash
  const filesParent = await writeSnapshotFiles(stateDir, 'c-parent', 1, hashParent, ['child/index.html'])
  await writeFile(path.join(stateDir, 'state.json'), JSON.stringify({
    schemaVersion: 2,
    updatedAt: 100,
    cycles: [
      // Parent root passed; child root (nested) failed. The submitted file is
      // covered by BOTH roots, so the child failure must reject delivery even
      // though the parent cycle is newer/first.
      makeGuardCycle({ id: 'c-parent', target: parent, sessionId: 'sess-x', status: 'passed', round: makeGuardRound({ snapshot: makeSnapshotRecord(hashParent, filesParent), passed: true }) }),
      makeGuardCycle({ id: 'c-child', target: child, sessionId: 'sess-x', status: 'reviewing', round: makeGuardRound({ passed: false, failReasons: ['评分 60 < 要求 95'] }) }),
    ],
  }), 'utf8')
  const { registrations } = applyPlugin({ workingDirectory: makeWorkingDirectory(parent) }, baseConfig(stateDir))
  await findTool(registrations, TOOL_STATUS).execute({})
  const guard = registrations.guards[0]
  const blocked = guard({
    name: 'present',
    arguments: { files: [{ path: path.join(child, 'index.html') }] },
    agent: { id: 'sess-x' },
  })
  assert.equal(typeof blocked, 'string')
  assert.match(blocked, /尚未通过门控|评分/)
})

test('v2.0 completion gate is session-scoped for a shared delivery root', async (t) => {
  const dir = await tempDir(t)
  const stateDir = path.join(dir, 'state')
  await mkdir(stateDir, { recursive: true })
  const shared = path.join(dir, 'shared-app')
  await mkdir(shared, { recursive: true })
  await writeFile(path.join(shared, 'index.html'), '<h1>shared</h1>')
  const hash = computeSnapshotSync(shared).manifestHash
  const filesA = await writeSnapshotFiles(stateDir, 'c-passed-a', 1, hash, ['index.html'])
  const filesD = await writeSnapshotFiles(stateDir, 'c-passed-d', 1, hash, ['index.html'])
  const passedA = makeGuardCycle({ id: 'c-passed-a', target: shared, sessionId: 'sess-a', status: 'passed', round: makeGuardRound({ snapshot: makeSnapshotRecord(hash, filesA), passed: true }) })
  const passedD = makeGuardCycle({ id: 'c-passed-d', target: shared, sessionId: 'sess-d', status: 'passed', round: makeGuardRound({ snapshot: makeSnapshotRecord(hash, filesD), passed: true }) })
  const failedB = makeGuardCycle({ id: 'c-fail-b', target: shared, sessionId: 'sess-b', status: 'reviewing', round: makeGuardRound({ passed: false, failReasons: ['评分 50 < 要求 95'] }) })
  const failedC = makeGuardCycle({ id: 'c-fail-c', target: shared, sessionId: 'sess-c', status: 'reviewing', round: makeGuardRound({ passed: false, failReasons: ['评分 40 < 要求 95'] }) })
  passedA.updatedAt = 10
  failedB.updatedAt = 20
  failedC.updatedAt = 5
  passedD.updatedAt = 30
  await writeFile(path.join(stateDir, 'state.json'), JSON.stringify({
    schemaVersion: 2,
    updatedAt: 100,
    cycles: [passedA, failedB, failedC, passedD],
  }), 'utf8')
  const { registrations } = applyPlugin({ workingDirectory: makeWorkingDirectory(shared) }, baseConfig(stateDir))
  await findTool(registrations, TOOL_STATUS).execute({})
  const guard = registrations.guards[0]
  // sess-a's own newest cycle passed → completion allowed even though another
  // session's newer failed cycle exists for the same root.
  assert.equal(
    guard({ name: 'update_goal', arguments: { action: 'complete' }, agent: { id: 'sess-a' } }),
    undefined,
  )
  // sess-c's own newest cycle failed → completion blocked even though another
  // session has a newer passed cycle for the same root (no cross-session fail-open).
  const blocked = guard({ name: 'update_goal', arguments: { action: 'complete' }, agent: { id: 'sess-c' } })
  assert.equal(typeof blocked, 'string')
  assert.match(blocked, /尚未通过门控/)
})

test('buildEffectiveConfig bounds the v1.1 1.5 read-only / probe config', () => {
  const defaults = buildEffectiveConfig({})
  assert.equal(defaults.readOnlyReviewers, true)
  assert.equal(defaults.probeTimeoutSeconds, 120)
  assert.equal(defaults.probeMaxCopyBytes, 104857600)
  assert.equal(defaults.probeMaxCopyFiles, 20000)
  assert.equal(DEFAULT_CONFIG.readOnlyReviewers, true)
  assert.equal(buildEffectiveConfig({ readOnlyReviewers: false }).readOnlyReviewers, false)
  assert.equal(buildEffectiveConfig({ readOnlyReviewers: 'yes' }).readOnlyReviewers, true)
  assert.equal(buildEffectiveConfig({ probeTimeoutSeconds: 1 }).probeTimeoutSeconds, 5)
  assert.equal(buildEffectiveConfig({ probeTimeoutSeconds: 9999 }).probeTimeoutSeconds, 600)
  assert.equal(buildEffectiveConfig({ probeTimeoutSeconds: '30' }).probeTimeoutSeconds, 30)
  assert.equal(buildEffectiveConfig({ probeMaxCopyBytes: 1 }).probeMaxCopyBytes, 1024)
  assert.equal(buildEffectiveConfig({ probeMaxCopyBytes: 'nope' }).probeMaxCopyBytes, 104857600)
  assert.equal(buildEffectiveConfig({ probeMaxCopyFiles: 0 }).probeMaxCopyFiles, 1)
  assert.equal(buildEffectiveConfig({ probeMaxCopyFiles: 'nope' }).probeMaxCopyFiles, 20000)
})

test('v1.1 1.5 guard: registered review children are hard read-only', async (t) => {
  t.after(() => clearReviewRegistry())
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  await writeFile(path.join(target, 'index.html'), '<h1>x</h1>')
  await mkdir(path.join(target, 'src'))
  await writeFile(path.join(target, 'src', 'app.js'), 'console.log(1)')
  const outside = path.join(dir, 'secret.txt')
  await writeFile(outside, 'supersecret')

  const { registrations } = applyPlugin({}, baseConfig(path.join(dir, 'state')))
  const guard = registrations.guards[0]
  assert.equal(typeof guard, 'function')
  // v2.0: gate tools are fail-closed until the async state load completes.
  await findTool(registrations, TOOL_STATUS).execute({})
  registerReviewChild('child-attacker', { targetDir: target, stage: 'attacker', cycleId: 'c-1' })
  registerReviewChild('child-judge', { targetDir: target, stage: 'judge', cycleId: 'c-1' })

  const call = (name, args = {}, agentId = 'child-attacker') => guard({
    name,
    arguments: args,
    agent: { id: agentId },
  })

  // Every dangerous tool is denied with a Chinese hard-read-only reason.
  for (const tool of [
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
    'team_task_create',
    'team_task_list',
  ]) {
    const reason = call(tool)
    assert.equal(typeof reason, 'string', `${tool} 应被拒绝`)
    assert.match(reason, /硬只读/, `${tool} 拒绝理由应说明硬只读`)
  }

  // review_probe is allowed; review round/batch/status are denied to reviewers.
  assert.equal(call('review_probe', { action: 'list-files' }), undefined)
  assert.match(call('adversarial_review_status', {}), /硬只读/)
  assert.match(call('adversarial_review_round', {}), /硬只读/)
  assert.match(call('adversarial_review_batch', {}), /硬只读/)

  // Filesystem reads inside the reviewed target are allowed (absolute + relative).
  assert.equal(call('read', { file_path: path.join(target, 'index.html') }), undefined)
  assert.equal(call('read', { file_path: 'index.html' }), undefined)
  assert.equal(call('read', { file_path: 'src/app.js' }), undefined)
  assert.equal(call('read_image', { path: path.join(target, 'index.html') }), undefined)
  assert.equal(call('glob', { path: target }), undefined)
  assert.equal(call('glob', { pattern: '**/*.js' }), undefined)
  assert.equal(call('grep', { path: 'index.html', pattern: 'h1' }), undefined)

  // Reads outside the reviewed target are denied (stateDir / secrets / other projects).
  const escaped = call('read', { file_path: outside })
  assert.equal(typeof escaped, 'string')
  assert.match(escaped, /只能读取被评审项目目录/)
  assert.match(call('read', { file_path: path.join(dir, 'state', 'state.json') }), /只能读取被评审项目目录/)
  assert.match(call('read', { file_path: '../secret.txt' }), /只能读取被评审项目目录/)
  assert.match(call('glob', { path: dir }), /只能读取被评审项目目录/)
  // Unresolvable path arguments fail closed.
  assert.match(call('read', {}), /fail-closed/)
  assert.match(call('read', { file_path: 42 }), /fail-closed/)

  // The judge child gets exactly the same restrictions.
  assert.match(call('pwsh', {}, 'child-judge'), /硬只读/)
  assert.match(call('present', {}, 'child-judge'), /硬只读/)
  assert.equal(call('read', { file_path: 'index.html' }, 'child-judge'), undefined)

  // Non-reviewer sessions are untouched.
  assert.equal(call('plugin_manager', {}, 'normal-session'), undefined)
  assert.equal(call('present', {}, 'normal-session'), undefined)
  assert.equal(call('read', { file_path: outside }, 'normal-session'), undefined)
  assert.equal(guard(null), undefined)

  // After unregistering, the reviewer rules no longer apply.
  clearReviewRegistry()
  assert.equal(call('pwsh', {}, 'child-attacker'), undefined)
  assert.equal(call('read', { file_path: outside }, 'child-attacker'), undefined)
})

test('v2.0: gate tools fail closed before the initial async state load', () => {
  const dir = path.join(os.tmpdir(), `rtc-unloaded-${process.pid}-${Date.now()}`)
  const { registrations } = applyPlugin({}, baseConfig(path.join(dir, 'state')))
  const guard = registrations.guards[0]
  const blockedPresent = guard({
    name: 'present',
    arguments: { files: [{ path: path.join(dir, 'app', 'index.html') }] },
    agent: { id: 'sess-x' },
  })
  assert.equal(typeof blockedPresent, 'string')
  assert.match(blockedPresent, /尚未加载/)
  assert.match(
    guard({ name: 'update_goal', arguments: { action: 'complete' }, agent: { id: 'sess-x' } }),
    /尚未加载/,
  )
  // Unrelated tools are not affected by the load window.
  assert.equal(guard({ name: 'read', arguments: { file_path: 'index.html' }, agent: { id: 'sess-x' } }), undefined)
  assert.equal(guard({ name: 'update_goal', arguments: { action: 'edit' }, agent: { id: 'sess-x' } }), undefined)
})

test('v1.1 1.5: readOnlyReviewers=false disables the guard enhancement (debug switch)', async (t) => {
  t.after(() => clearReviewRegistry())
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const outside = path.join(dir, 'secret.txt')
  await writeFile(outside, 'secret')
  const { registrations } = applyPlugin(
    {},
    baseConfig(path.join(dir, 'state'), { readOnlyReviewers: false }),
  )
  const guard = registrations.guards[0]
  registerReviewChild('child-x', { targetDir: target, stage: 'attacker' })
  assert.equal(guard({ name: 'pwsh', arguments: {}, agent: { id: 'child-x' } }), undefined)
  assert.equal(guard({ name: 'read', arguments: { file_path: outside }, agent: { id: 'child-x' } }), undefined)
})

test('v1.1 1.5: review_probe is registered globally but only reviewers may execute it', async (t) => {
  t.after(() => clearReviewRegistry())
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  await writeFile(path.join(target, 'index.html'), '<h1>probe</h1>')
  const { registrations } = applyPlugin({}, baseConfig(path.join(dir, 'state')))
  const probeTool = findTool(registrations, TOOL_PROBE)
  assert.ok(probeTool, 'review_probe 工具应注册')
  assert.equal(probeTool.parameters.additionalProperties, false)
  assert.deepEqual(probeTool.parameters.required, ['action'])
  assert.deepEqual(probeTool.parameters.properties.action.enum, ['run-tests', 'check-syntax', 'list-files', 'read-text', 'run-metrics'])
  assert.match(probeTool.description, /modeling-run\.json/)
  assert.match(probeTool.description, /run-metrics/)
  assert.equal(probeTool.timeoutMs, 900_000)
  assert.equal(typeof probeTool.output.render, 'function')

  // Non-review callers are rejected with the exact fixed message (no throw).
  const nonReview = await probeTool.execute({ action: 'list-files' }, { agent: { id: 'session-A' } })
  assert.deepEqual(nonReview, { ok: false, error: 'review_probe 仅限评审子智能体使用' })

  // Registered reviewers can probe their target only.
  registerReviewChild('child-probe', { targetDir: target, stage: 'attacker', cycleId: 'c-probe' })
  const listed = await probeTool.execute({ action: 'list-files' }, { agent: { id: 'child-probe' } })
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.files.map((file) => file.path), ['index.html'])

  const rendered = probeTool.output.render(null, listed)
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].type, 'text')
  assert.equal(JSON.parse(rendered[0].text).ok, true)
})

// ---------------------------------------------------------------------------
// v1.2 Stage A: profile config + evidence tool schema
// ---------------------------------------------------------------------------

test('v1.2 buildEffectiveConfig: profile enum and interaction timeout bounds', () => {
  assert.equal(DEFAULT_CONFIG.profile, 'code')
  assert.equal(DEFAULT_CONFIG.interactionTimeoutSeconds, 60)
  assert.equal(buildEffectiveConfig({}).profile, 'code')
  assert.equal(buildEffectiveConfig(null).profile, 'code')
  assert.equal(buildEffectiveConfig({ profile: 'game' }).profile, 'game')
  assert.equal(buildEffectiveConfig({ profile: 'web' }).profile, 'web')
  assert.equal(buildEffectiveConfig({ profile: 'modeling' }).profile, 'modeling')
  assert.equal(buildEffectiveConfig({ profile: 'code' }).profile, 'code')
  // Unknown / non-string profiles fall back to `code` (never a random rubric).
  assert.equal(buildEffectiveConfig({ profile: 'hacker' }).profile, 'code')
  assert.equal(buildEffectiveConfig({ profile: 'GAME' }).profile, 'code')
  assert.equal(buildEffectiveConfig({ profile: 42 }).profile, 'code')

  assert.equal(buildEffectiveConfig({ interactionTimeoutSeconds: 0 }).interactionTimeoutSeconds, 1)
  assert.equal(buildEffectiveConfig({ interactionTimeoutSeconds: 9999 }).interactionTimeoutSeconds, 600)
  assert.equal(buildEffectiveConfig({ interactionTimeoutSeconds: '30' }).interactionTimeoutSeconds, 30)
  assert.equal(buildEffectiveConfig({ interactionTimeoutSeconds: 'nope' }).interactionTimeoutSeconds, 60)
})

test('v1.2 round tool schema advertises evidence cards + profile/evidence output', async (t) => {
  const dir = await tempDir(t)
  const sections = []
  const services = {
    systemPrompt: {
      section: (section) => {
        sections.push(section)
        return () => {}
      },
    },
  }
  const { registrations } = applyPlugin(services, { stateDir: dir })
  const roundTool = findTool(registrations, TOOL_ROUND)
  assert.ok(roundTool !== undefined)
  const parameters = roundTool.parameters
  assert.equal(parameters.additionalProperties, false)
  assert.deepEqual(parameters.required, ['target'])
  assert.ok(parameters.properties.evidence !== undefined)
  assert.ok(parameters.properties.shots !== undefined)
  const evidence = parameters.properties.evidence
  assert.equal(evidence.type, 'array')
  assert.deepEqual(evidence.items.required, ['kind'])
  assert.deepEqual(evidence.items.properties.kind.enum, ['screenshot', 'interaction', 'image', 'pdf-text'])
  assert.equal(evidence.items.properties.page.type, 'integer')
  assert.equal(evidence.items.properties.steps.items.properties.action.enum.length, 5)
  assert.deepEqual(evidence.items.properties.steps.items.properties.action.enum, ['goto', 'wait', 'click', 'key', 'screenshot'])
  assert.equal(evidence.items.properties.steps.items.additionalProperties, false)
  assert.equal(evidence.items.properties.collect.additionalProperties, false)
  assert.match(parameters.properties.evidence.description, /与 shots 二选一/)
  assert.match(roundTool.description, /evidence/)

  assert.ok(roundTool.output.schema.properties.evidence !== undefined)
  assert.equal(roundTool.output.schema.properties.evidence.type, 'object')
  assert.equal(roundTool.output.schema.properties.profile.type, 'string')
  assert.equal(roundTool.timeoutMs, 14_400_000)
  assert.equal(typeof roundTool.output.render, 'function')

  // System prompt tells agents evidence cards are an option (4 representative
  // images still required by the gate).
  const section = sections.find((entry) => entry.name === 'adversarial-review')
  assert.ok(section !== undefined)
  assert.ok(section.text.includes('evidence'))
  assert.ok(section.text.includes('gate.passed'))
  assert.ok(section.text.includes('modeling') || section.text.includes('pdf-text'))
})

// ---------------------------------------------------------------------------
// v1.2 Stage C: modeling sandbox config + probe schema
// ---------------------------------------------------------------------------

test('v1.2 buildEffectiveConfig bounds modelingTimeoutSeconds', () => {
  assert.equal(DEFAULT_CONFIG.modelingTimeoutSeconds, 120)
  assert.equal(buildEffectiveConfig({}).modelingTimeoutSeconds, 120)
  assert.equal(buildEffectiveConfig({ modelingTimeoutSeconds: 1 }).modelingTimeoutSeconds, 1)
  assert.equal(buildEffectiveConfig({ modelingTimeoutSeconds: 600 }).modelingTimeoutSeconds, 600)
  assert.equal(buildEffectiveConfig({ modelingTimeoutSeconds: 0 }).modelingTimeoutSeconds, 1)
  assert.equal(buildEffectiveConfig({ modelingTimeoutSeconds: 9999 }).modelingTimeoutSeconds, 600)
  assert.equal(buildEffectiveConfig({ modelingTimeoutSeconds: '30' }).modelingTimeoutSeconds, 30)
  assert.equal(buildEffectiveConfig({ modelingTimeoutSeconds: 'nope' }).modelingTimeoutSeconds, 120)
})

test('v1.2 probe/round schemas advertise run-metrics and modeling evidence', async (t) => {
  const dir = await tempDir(t)
  const { registrations } = applyPlugin({}, baseConfig(dir))
  const probeTool = findTool(registrations, TOOL_PROBE)
  const probeOutput = probeTool.output.schema.properties
  assert.ok(probeOutput.metrics !== undefined)
  assert.ok(probeOutput.commands !== undefined)
  assert.ok(probeOutput.exitCodes !== undefined)
  assert.ok(probeOutput.sandbox !== undefined)
  assert.ok(probeOutput.metricsFile !== undefined)

  const roundTool = findTool(registrations, TOOL_ROUND)
  const evidence = roundTool.parameters.properties.evidence
  assert.ok(evidence.items.properties.page.description.includes('PDF'))
  assert.match(evidence.items.properties.path.description, /image/)
  assert.match(evidence.items.properties.path.description, /pdf-text/)
  assert.match(roundTool.description, /image/)
  assert.match(roundTool.description, /pdf-text/)
  assert.match(roundTool.output.schema.properties.evidence.description, /pdf-text/)
})

// ---------------------------------------------------------------------------
// v1.3 3.1–3.4: lifecycle config, batch tool, newest-cycle guard
// ---------------------------------------------------------------------------

test('v1.3 buildEffectiveConfig bounds incremental + batch config', () => {
  assert.equal(DEFAULT_CONFIG.incrementalMaxChangedFiles, 200)
  assert.equal(DEFAULT_CONFIG.incrementalFullReview, false)
  assert.equal(DEFAULT_CONFIG.maxBatchTargets, 10)
  assert.equal(buildEffectiveConfig({}).incrementalMaxChangedFiles, 200)
  assert.equal(buildEffectiveConfig({ incrementalMaxChangedFiles: 0 }).incrementalMaxChangedFiles, 1)
  assert.equal(buildEffectiveConfig({ incrementalMaxChangedFiles: 999999 }).incrementalMaxChangedFiles, 100000)
  assert.equal(buildEffectiveConfig({ incrementalMaxChangedFiles: '50' }).incrementalMaxChangedFiles, 50)
  assert.equal(buildEffectiveConfig({ incrementalMaxChangedFiles: 'nope' }).incrementalMaxChangedFiles, 200)
  assert.equal(buildEffectiveConfig({ incrementalFullReview: true }).incrementalFullReview, true)
  assert.equal(buildEffectiveConfig({ incrementalFullReview: 'yes' }).incrementalFullReview, false)
  assert.equal(buildEffectiveConfig({ maxBatchTargets: 2 }).maxBatchTargets, 2)
  assert.equal(buildEffectiveConfig({ maxBatchTargets: 99 }).maxBatchTargets, 10)
  assert.equal(buildEffectiveConfig({ maxBatchTargets: 1 }).maxBatchTargets, 2)
  assert.equal(buildEffectiveConfig({ maxBatchTargets: '3' }).maxBatchTargets, 3)
})

test('v1.3 tool schema: round mode + batch tool validation', async (t) => {
  const dir = await tempDir(t)
  const { registrations } = applyPlugin({}, baseConfig(path.join(dir, 'state')))
  const roundTool = findTool(registrations, TOOL_ROUND)
  assert.deepEqual(roundTool.parameters.properties.mode.enum, ['fresh', 'reopen', 'incremental'])
  const roundOutput = roundTool.output.schema.properties
  for (const key of ['mode', 'reopen', 'noise', 'cost', 'incremental']) assert.ok(roundOutput[key] !== undefined, key)

  const batchTool = findTool(registrations, TOOL_BATCH)
  assert.ok(batchTool !== undefined, 'batch tool should be registered')
  assert.equal(batchTool.timeoutMs, 14_400_000 * 10)
  assert.ok(batchTool.timeoutMs >= 14_400_000 * 10)
  assert.equal(batchTool.parameters.additionalProperties, false)
  assert.deepEqual(batchTool.parameters.required, ['targets'])
  assert.equal(batchTool.parameters.properties.targets.type, 'array')
  assert.ok(batchTool.parameters.properties.mode !== undefined)
  assert.ok(batchTool.parameters.properties.profile !== undefined)
  // Batch never accepts evidence/shots specs.
  assert.equal(batchTool.parameters.properties.evidence, undefined)
  assert.equal(batchTool.parameters.properties.shots, undefined)
  assert.match(batchTool.description, /maxBatchTargets|2–/)
  assert.match(batchTool.description, /顺序/)
  assert.ok(batchTool.output.schema.properties.summary !== undefined)

  // Argument validation happens inside the batch runner (no subagents needed).
  const tooFew = await batchTool.execute({ targets: [path.join(dir, 'app')] }, { agent: { id: 's1' } })
  assert.equal(tooFew.ok, false)
  assert.equal(tooFew.stage, 'arguments')
  assert.match(tooFew.error, /至少需要 2 个/)
  const duplicate = await batchTool.execute({
    targets: [path.join(dir, 'app'), path.join(dir, 'app')],
  }, { agent: { id: 's1' } })
  assert.equal(duplicate.ok, false)
  assert.match(duplicate.error, /重复/)
  const badMode = await batchTool.execute({
    targets: [path.join(dir, 'a'), path.join(dir, 'b')],
    mode: 'nonsense',
  }, { agent: { id: 's1' } })
  assert.equal(badMode.ok, false)
  assert.equal(badMode.stage, 'arguments')
})

test('v1.3 guard: the newest cycle per deliverable root wins over older passed cycles', async (t) => {
  const dir = await tempDir(t)
  const stateDir = path.join(dir, 'state')
  await mkdir(stateDir, { recursive: true })
  const workspaces = path.join(dir, 'ws')
  const app = path.join(workspaces, 'app')
  await mkdir(app, { recursive: true })
  await writeFile(path.join(app, 'index.html'), '<h1>app</h1>')
  const unchangedHash = computeSnapshotSync(workspaces).manifestHash

  // Older passed cycle + newer reviewing cycle on the SAME deliverable root.
  await writeFile(path.join(stateDir, 'state.json'), JSON.stringify({
    schemaVersion: 3,
    updatedAt: 100,
    cycles: [
      makeGuardCycle({ id: 'c-old-passed', target: app, deliverableRoot: workspaces, sessionId: 'sess-a', status: 'passed', round: makeGuardRound({ snapshot: makeSnapshotRecord(unchangedHash), passed: true }) }),
      {
        ...makeGuardCycle({ id: 'c-new-reviewing', target: app, deliverableRoot: workspaces, sessionId: 'sess-a', status: 'reviewing', round: makeGuardRound({ passed: false, failReasons: ['mustFix 仍有 1 项未清空'] }) }),
        updatedAt: 200,
      },
    ],
  }), 'utf8')
  {
    const { registrations } = applyPlugin({}, baseConfig(stateDir))
    const statusTool = findTool(registrations, TOOL_STATUS)
    await statusTool.execute({})
    const guard = registrations.guards[0]
    const blocked = guard({
      name: 'present',
      arguments: { files: [{ path: path.join(app, 'index.html') }] },
      agent: { id: 'other-session' },
    })
    assert.equal(typeof blocked, 'string')
    assert.match(blocked, /尚未通过门控/)
    // update_goal(complete) for the same session is blocked by the newest cycle too.
    const complete = guard({
      name: 'update_goal',
      arguments: { action: 'complete' },
      agent: { id: 'sess-a' },
    })
    assert.equal(typeof complete, 'string')
    assert.match(complete, /尚未通过门控/)
  }

  // Newest passed cycle + older reviewing stale cycle: delivery/completion allowed.
  const newPassedFiles = await writeSnapshotFiles(stateDir, 'c-new-passed', 1, unchangedHash, ['app/index.html'])
  await writeFile(path.join(stateDir, 'state.json'), JSON.stringify({
    schemaVersion: 3,
    updatedAt: 300,
    cycles: [
      {
        ...makeGuardCycle({ id: 'c-old-reviewing', target: app, deliverableRoot: workspaces, sessionId: 'sess-a', status: 'reviewing', round: makeGuardRound({ passed: false }) }),
        updatedAt: 100,
      },
      {
        ...makeGuardCycle({ id: 'c-new-passed', target: app, deliverableRoot: workspaces, sessionId: 'sess-a', status: 'passed', round: makeGuardRound({ snapshot: makeSnapshotRecord(unchangedHash, newPassedFiles), passed: true }) }),
        updatedAt: 300,
      },
    ],
  }), 'utf8')
  {
    const { registrations } = applyPlugin({}, baseConfig(stateDir))
    const statusTool = findTool(registrations, TOOL_STATUS)
    await statusTool.execute({})
    const guard = registrations.guards[0]
    assert.equal(guard({
      name: 'present',
      arguments: { files: [{ path: path.join(app, 'index.html') }] },
      agent: { id: 'other-session' },
    }), undefined)
    assert.equal(guard({
      name: 'update_goal',
      arguments: { action: 'complete' },
      agent: { id: 'sess-a' },
    }), undefined)
  }
})
