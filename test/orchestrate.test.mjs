import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DEFAULT_CONFIG } from '../lib/constants.js'
import {
  ReviewError,
  __resetRoundLocks,
  acquireRoundLock,
  buildCompactResult,
  buildStatusSummary,
  describeRoundLock,
  parseAttackResult,
  parseScoreResult,
  pickSubagentProvider,
  readSnapshotFileList,
  releaseRoundLock,
  resolveDeliverableRoot,
  resolveJudgeSampleRoutes,
  resolveTargetDir,
  runReviewBatch,
  runReviewRound,
  validateRoundArgs,
} from '../lib/orchestrate.js'
import { __resetCancelRequests, getCancelRequest, requestCancel } from '../lib/progress.js'
import { computeSnapshotSync } from '../lib/snapshot.js'
import { clearReviewRegistry, listReviewChildren, lookupReviewChild } from '../lib/review-registry.js'
import { createStore, toPublicState } from '../lib/store.js'

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rtc-orch-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

function makePngHeader(width, height, byteLength = 2048) {
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

function makeAttack(overrides = {}) {
  return {
    verdict: 'HOLD',
    summary: '发现四处可复现问题。',
    findings: [
      { severity: 'MAJOR', title: '抽牌按钮无响应', evidence: 'app.js:42', attack: '点击抽牌', impact: '核心交互失效', fix: '绑定事件', confidence: 'high', verified: true },
      { severity: 'MAJOR', title: '移动端布局溢出', evidence: 'style.css:88', attack: '390x844 视口', impact: '横向滚动', fix: '响应式改造', confidence: 'medium', verified: true },
      { severity: 'MINOR', title: '缺少图片 alt', evidence: 'index.html:10', attack: '读屏工具', impact: '可访问性下降', fix: '补 alt', confidence: 'high', verified: true },
      { severity: 'MINOR', title: '控制台残留警告', evidence: 'console output', attack: '打开控制台', impact: '潜在风险', fix: '清理', confidence: 'low', verified: false },
    ],
    solid: ['入口引用的脚本文件都存在'],
    unverified: [{ item: '暗色主题对比度', needs: '暗色模式截图' }],
    ...overrides,
  }
}

function makeScore(overrides = {}) {
  return {
    score: 95,
    verdict: 'PASS',
    findingsCount: 4,
    validFindings: [
      // A passing report may keep only MINOR supported findings; supported
      // BLOCKER/MAJOR items are blocking by definition (gate rule).
      { title: '抽牌按钮无响应', severity: 'MINOR', supported: true, note: '已复现' },
      { title: '移动端布局溢出', severity: 'MINOR', supported: true, note: '截图可见' },
      { title: '缺少图片 alt', severity: 'MINOR', supported: true, note: '已定位' },
      { title: '控制台残留警告', severity: 'MINOR', supported: true, note: '已定位' },
    ],
    deductions: [],
    mustFix: [],
    screenshots: { count: 4, quality: 'good', note: '四张齐全' },
    nextAction: 'stop',
    rationale: '证据充分，分级合理。',
    ...overrides,
  }
}

/** In-memory subagents service whose activation handler is supplied per test. */
const DEFAULT_PROVIDER_CAPABILITIES = Object.freeze({
  agentOptions: false,
  agentPreset: true,
  outputSchema: true,
  depthLimit: false,
})

function makeFakeSubagents(handler, order = null, capabilities = null) {
  const calls = []
  const meta = { disposed: 0 }
  const provider = {
    name: 'spawn',
    capabilities: {
      ...DEFAULT_PROVIDER_CAPABILITIES,
      ...(capabilities === null ? {} : capabilities),
    },
    inheritsParentContext: false,
  }
  const service = {
    list: () => ['spawn'],
    getProvider: (name) => (name === 'spawn' ? provider : undefined),
    async startActivation(spec) {
      calls.push(spec)
      if (order !== null) order.push(String(spec.label || '').startsWith('judge') ? 'agent-judge' : 'agent-attack')
      return handler(spec, calls.length - 1, meta)
    },
  }
  return { service, calls, meta }
}

/** 0-based sample index parsed from a `judge-r<N>-<i>` label (single judge → 0). */
function judgeSampleIndex(spec) {
  const match = /^judge-r\d+-(\d+)$/.exec(String(spec.label || ''))
  return match === null ? 0 : Number(match[1]) - 1
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function completedActivation(payload, childId, structured = true) {
  return {
    childId,
    result: Promise.resolve({
      output: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
      structured: structured && typeof payload === 'object' ? payload : undefined,
      stopReason: 'completed',
    }),
    dispose: async () => {},
  }
}

/** Fake screenshot renderer that writes real PNG headers so verification passes. */
function makeFakeRenderShots(order = null, { fail = false } = {}) {
  const calls = []
  const fn = async (options) => {
    calls.push(options)
    if (order !== null) order.push('render')
    if (fail) {
      const partial = (options.specs || []).slice(0, 3).map((spec, index) => {
        const bytes = makePngHeader(spec.width, spec.height)
        return {
          file: `r${options.roundNo ?? 1}-s${index + 1}-shot.png`,
          width: spec.width,
          height: spec.height,
          bytes: bytes.length,
          sha256: sha256Buffer(bytes),
          page: spec.page,
          renderedAt: 1,
        }
      })
      return { ok: false, shots: partial, errors: ['模拟渲染失败'], warnings: [] }
    }
    const dir = path.join(options.stateDir, 'shots', options.cycleId)
    await mkdir(dir, { recursive: true })
    const shots = []
    const specs = Array.isArray(options.specs) ? options.specs : []
    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index]
      const slug = String(spec.name || `shot-${index + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'shot'
      const file = `r${options.roundNo ?? 1}-s${index + 1}-${slug}.png`
      const bytes = makePngHeader(spec.width, spec.height)
      await writeFile(path.join(dir, file), bytes)
      shots.push({
        file,
        url: 'file:///fake.png',
        width: spec.width,
        height: spec.height,
        bytes: bytes.length,
        sha256: sha256Buffer(bytes),
        page: spec.page,
        renderedAt: 1,
      })
    }
    return { ok: true, shots, errors: [], warnings: [] }
  }
  return { fn, calls }
}

function baseConfig(stateDir, overrides = {}) {
  // Most pre-v1.1 tests assume exactly one judge: pin it unless overridden.
  return { ...DEFAULT_CONFIG, stateDir, judgeSamples: 1, ...overrides }
}

function baseRoundOptions(config, store, target, extra = {}) {
  return {
    config,
    store,
    args: { target, title: '演示应用', claims: ['README 宣称支持移动端'] },
    agent: { id: 'session-1' },
    workingDirectory: { ensure: async () => target, defaultDirectory: target },
    now: Date.now,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// argument/target/provider helpers
// ---------------------------------------------------------------------------

test('validateRoundArgs rejects missing target / bad shots and normalizes strings', () => {
  assert.throws(() => validateRoundArgs(null, {}), (error) => error instanceof ReviewError && error.stage === 'arguments')
  assert.throws(() => validateRoundArgs({}, {}), (error) => error instanceof ReviewError && error.stage === 'arguments')
  assert.throws(() => validateRoundArgs({ target: 42 }, {}), (error) => error.stage === 'arguments')
  assert.throws(
    () => validateRoundArgs({ target: 'C:\\demo', shots: [{ path: 'a.html' }] }, { requiredShots: 4 }),
    (error) => error instanceof ReviewError && /恰好 4 个/.test(error.message),
  )
  assert.throws(() => validateRoundArgs({ target: 'C:\\demo', shots: 'nope' }, { requiredShots: 4 }), (error) => error.stage === 'arguments')

  const parsed = validateRoundArgs({
    target: ' C:\\demo ',
    title: '演示',
    claims: '单条宣称',
    focus: ['a11y', 42],
    shots: [],
  }, { requiredShots: 4 })
  assert.equal(parsed.target, 'C:\\demo')
  assert.deepEqual(parsed.claims, ['单条宣称'])
  assert.deepEqual(parsed.focus, ['a11y'])
  assert.equal(parsed.warnings.length, 2)
  assert.equal(parsed.profile, null)

  // v1.2 2.3a: per-call domain profile override.
  assert.equal(validateRoundArgs({ target: 'C:\\demo', profile: 'game' }, {}).profile, 'game')
  assert.throws(
    () => validateRoundArgs({ target: 'C:\\demo', profile: 'hacker' }, {}),
    (error) => error instanceof ReviewError && /profile/.test(error.message),
  )
})

test('resolveTargetDir resolves relative targets against the caller directory', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const resolved = await resolveTargetDir('app', {
    workingDirectory: { ensure: async () => dir },
    agent: { id: 'session-1' },
  })
  assert.equal(resolved, path.resolve(target))
  await assert.rejects(
    resolveTargetDir(path.join(dir, 'missing'), {}),
    (error) => error instanceof ReviewError && error.stage === 'target',
  )
  const file = path.join(dir, 'file.txt')
  await writeFile(file, 'x')
  await assert.rejects(resolveTargetDir(file, {}), (error) => error.stage === 'target')
})

test('pickSubagentProvider prefers wanted, falls back to spawn, then capable providers', () => {
  const wanted = { name: 'custom', capabilities: {} }
  const spawn = { name: 'spawn', capabilities: {} }
  assert.equal(pickSubagentProvider({
    getProvider: (name) => (name === 'custom' ? wanted : name === 'spawn' ? spawn : undefined),
    list: () => ['custom', 'spawn'],
  }, 'missing'), spawn)
  assert.equal(pickSubagentProvider({
    getProvider: (name) => (name === 'custom' ? wanted : undefined),
    list: () => ['custom'],
  }, 'custom'), wanted)
  const capable = { name: 'beta', capabilities: { agentPreset: true, outputSchema: false } }
  assert.equal(pickSubagentProvider({
    getProvider: (name) => (name === 'beta' ? capable : undefined),
    list: () => ['alpha', 'beta'],
  }, 'nope'), capable)
  assert.equal(pickSubagentProvider({ getProvider: () => undefined, list: () => [] }, 'spawn'), null)
  assert.equal(pickSubagentProvider(null, 'spawn'), null)
  assert.equal(pickSubagentProvider({ getProvider: () => { throw new Error('boom') }, list: () => { throw new Error('boom') } }, 'spawn'), null)
})

test('parseAttackResult/parseScoreResult handle structured, fenced and hostile output', () => {
  const attack = makeAttack()
  const fromStructured = parseAttackResult({
    output: [{ type: 'text', text: JSON.stringify(attack) }],
    structured: attack,
    stopReason: 'completed',
  })
  assert.equal(fromStructured.attack.findings.length, 4)

  const fromText = parseAttackResult({
    output: [{ type: 'text', text: `先说明。\n\`\`\`json\n${JSON.stringify(attack)}\n\`\`\`` }],
    stopReason: 'completed',
  })
  assert.equal(fromText.attack.verdict, 'HOLD')

  assert.throws(() => parseAttackResult({ output: [{ type: 'text', text: '抱歉，我不能输出 JSON' }] }), (error) => {
    assert.equal(error instanceof ReviewError, true)
    assert.equal(error.stage, 'attacker-parse')
    assert.ok(error.raw.includes('抱歉'))
    return true
  })

  const score = makeScore()
  assert.equal(parseScoreResult({ output: [{ type: 'text', text: JSON.stringify(score) }] }).score.score, 95)
  assert.throws(() => parseScoreResult({ output: [{ type: 'text', text: '{"score":"not a number"}' }] }), (error) => error.stage === 'judge-parse')
  assert.throws(() => parseScoreResult(undefined), (error) => error.stage === 'judge-parse')
})

test('buildCompactResult keeps the contract top-level shape', () => {
  const cycle = { id: 'c-1', target: 'C:\\demo', title: '演示' }
  const round = {
    n: 2,
    rubricVersion: 'v2-100',
    promptHashes: { attacker: 'a'.repeat(64), judge: 'b'.repeat(64) },
    modelRoute: { attacker: null, judge: null, inherited: true },
    judges: [{ index: 0, sessionId: 'child-judge', score: 95, rawScore: 95, verdict: 'PASS', mustFix: [] }],
    shots: [{ file: 'r2-s1-desktop.png', width: 1440, height: 900, bytes: 2048, url: 'file:///x', page: 'index.html' }],
    attack: makeAttack(),
    score: makeScore({ score: 95 }),
    gate: { passed: true, score: 95, requiredScore: 95, findings: 4, requiredFindings: 3, shots: 4, requiredShots: 4, failReasons: [] },
  }
  const result = buildCompactResult({ cycle, round, warnings: ['w'] })
  assert.deepEqual(Object.keys(result).sort(), [
    'attack', 'cycleId', 'gate', 'judges', 'message', 'mode', 'modelRoute', 'nextAction',
    'ok', 'promptHashes', 'reopen', 'round', 'rubricVersion', 'score', 'shots', 'target', 'warnings',
  ])
  // Null optional fields are omitted so the tool output schema validates.
  assert.equal('evidence' in result, false)
  assert.equal('profile' in result, false)
  assert.equal('noise' in result, false)
  assert.equal('cost' in result, false)
  assert.equal('incremental' in result, false)
  assert.equal(result.ok, true)
  assert.equal(result.cycleId, 'c-1')
  assert.equal(result.round, 2)
  assert.equal(result.nextAction, 'stop')
  assert.equal(result.rubricVersion, 'v2-100')
  assert.deepEqual(result.promptHashes, { attacker: 'a'.repeat(64), judge: 'b'.repeat(64) })
  assert.deepEqual(result.modelRoute, { attacker: null, judge: null, inherited: true, samples: [] })
  assert.deepEqual(result.judges, [
    { index: 0, sessionId: 'child-judge', score: 95, rawScore: 95, verdict: 'PASS', mustFixCount: 0, modelRoute: null },
  ])
  assert.deepEqual(result.shots, [{ file: 'r2-s1-desktop.png', width: 1440, height: 900, bytes: 2048, url: 'file:///x' }])
  assert.ok(result.message.includes('已达标'))
  assert.deepEqual(result.warnings, ['w'])

  // Legacy rounds (no v1.1 audit fields) must not break the compact result.
  const legacy = buildCompactResult({ cycle, round: { n: 1, shots: [], attack: null, score: null, gate: null } })
  assert.deepEqual(legacy.judges, [])
  assert.equal(legacy.rubricVersion, undefined)
  assert.equal(legacy.promptHashes, undefined)
  assert.equal(legacy.modelRoute, undefined)

  const failedGate = buildCompactResult({
    cycle,
    round: { ...round, gate: { passed: false, score: 75, requiredScore: 95, findings: 2, requiredFindings: 3, shots: 4, requiredShots: 4, failReasons: ['评分 75 < 要求 95'] } },
  })
  assert.equal(failedGate.nextAction, 'fix_and_review')
  assert.ok(failedGate.message.includes('未达标'))
})

// ---------------------------------------------------------------------------
// full round: report-page fallback (no Web entry)
// ---------------------------------------------------------------------------

test('runReviewRound completes a report-page round and passes the gate', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const order = []
  const fakeShots = makeFakeRenderShots(order)
  const fakeSubagents = makeFakeSubagents((spec) => {
    if (spec.label.startsWith('judge')) return completedActivation(makeScore(), 'child-judge')
    return completedActivation(makeAttack(), 'child-attack')
  }, order)

  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))

  assert.equal(result.ok, true, result.error)
  assert.equal(result.gate.passed, true)
  assert.equal(result.nextAction, 'stop')
  assert.equal(result.round, 1)
  assert.equal(result.shots.length, 4)
  assert.ok(result.warnings.some((warning) => warning.includes('评审报告页')))

  // Report-page evidence is rendered once as neutral placeholders BEFORE both
  // children, then re-rendered with the completed round (v2.0 fix).
  assert.deepEqual(order, ['render', 'agent-attack', 'agent-judge', 'render'])
  assert.equal(fakeShots.calls.length, 2)
  assert.equal(fakeShots.calls[0].specs.length, 4)
  assert.equal(fakeShots.calls[1].specs.length, 4)

  // Both children, fresh sessions, correct presets/labels, delivery caller.
  assert.equal(fakeSubagents.calls.length, 2)
  assert.equal(fakeSubagents.calls[0].label, 'redteam-r1')
  assert.equal(fakeSubagents.calls[1].label, 'judge-r1-1')
  assert.equal(fakeSubagents.calls[0].provider, 'spawn')
  assert.equal(fakeSubagents.calls[0].delivery, 'caller')
  assert.equal(fakeSubagents.calls[0].request.agentPreset, DEFAULT_CONFIG.attackerPreset)
  assert.equal(fakeSubagents.calls[1].request.agentPreset, DEFAULT_CONFIG.judgePreset)
  assert.equal(fakeSubagents.calls[0].request.cwd, target)
  assert.equal(fakeSubagents.calls[0].request.parent.id, 'session-1')
  assert.ok(fakeSubagents.calls[0].request.prompt[0].text.includes('红队'))
  assert.ok(fakeSubagents.calls[1].request.prompt[0].text.includes('独立评分员'))
  // No model routing configured → no agentOptions is sent (inherit route).
  assert.equal(fakeSubagents.calls[0].request.agentOptions, undefined)
  assert.equal(fakeSubagents.calls[1].request.agentOptions, undefined)
  // Judge isolation: it sees the red-team report, never the builder claims.
  const judgePrompt = fakeSubagents.calls[1].request.prompt[0].text
  assert.ok(judgePrompt.includes('抽牌按钮无响应'))
  assert.equal(judgePrompt.includes('README 宣称支持移动端'), false)
  // v1.1: the judge must sample files independently and write locatable notes.
  assert.ok(judgePrompt.includes('至少 3 个项目文件'))
  assert.ok(judgePrompt.includes('至少打开 1 个测试或构建配置'))
  assert.ok(judgePrompt.includes('路径:行号'))
  assert.ok(judgePrompt.includes('supported=false'))

  // v1.1 audit fields travel in the compact result.
  assert.equal(result.rubricVersion, 'v2-100')
  assert.match(result.promptHashes.attacker, /^[0-9a-f]{64}$/)
  assert.match(result.promptHashes.judge, /^[0-9a-f]{64}$/)
  assert.equal(result.promptHashes.attacker, sha256(fakeSubagents.calls[0].request.prompt[0].text))
  assert.equal(result.promptHashes.judge, sha256(judgePrompt))
  assert.deepEqual(result.modelRoute, { attacker: null, judge: null, inherited: true, samples: [null] })
  assert.deepEqual(result.judges, [
    { index: 0, sessionId: 'child-judge', score: 95, rawScore: 95, verdict: 'PASS', mustFixCount: 0, modelRoute: null },
  ])

  // Persisted lifecycle: completed round, passed cycle, timings present.
  const reloaded = createStore({ stateDir: config.stateDir })
  await reloaded.init()
  const cycle = reloaded.state.cycles[0]
  assert.equal(cycle.status, 'passed')
  assert.equal(cycle.rounds.length, 1)
  const round = cycle.rounds[0]
  assert.equal(round.status, 'completed')
  assert.equal(round.gate.passed, true)
  assert.equal(round.shots.length, 4)
  assert.equal(round.attackerSessionId, 'child-attack')
  assert.equal(round.judgeSessionId, 'child-judge')
  assert.equal(round.timings.attackMs >= 0, true)
  assert.equal(round.timings.judgeMs >= 0, true)
  // v1.1 audit records persisted on the round (single-judge mode).
  assert.equal(round.rubricVersion, 'v2-100')
  assert.equal(round.judges.length, 1)
  assert.equal(round.judges[0].sessionId, 'child-judge')
  assert.equal(round.judges[0].index, 0)
  assert.equal(round.judges[0].score, 95)
  assert.equal(round.judges[0].rawScore, 95)
  assert.ok(round.judges[0].rawSnippet.length > 0)
  assert.equal(round.judges[0].rawSnippet.length <= 2000, true)
  assert.deepEqual(round.judgeSessionIds, ['child-judge'])
  assert.equal(typeof round.judgeRaw, 'string')
  assert.ok(round.judgeRaw.length > 0)
  assert.equal(round.judgeRaw.length <= 4000, true)
  assert.deepEqual(round.modelRoute, { attacker: null, judge: null, inherited: true, samples: [null] })
  assert.deepEqual(round.disagreement, {
    scoreSpread: 0,
    mustFixMismatch: false,
    verdictMismatch: false,
    disagree: false,
  })
  assert.equal(round.score.rawScore, 95)
  assert.equal(round.score.supportedCount, 4)

  // A passed cycle refuses further rounds.
  const again = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(again.ok, false)
  assert.equal(again.stage, 'cycle-passed')
})

// ---------------------------------------------------------------------------
// dual judges (v1.1 1.2)
// ---------------------------------------------------------------------------

test('runReviewRound aggregates two judges with the lower median and mustFix union', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'), { judgeSamples: 2 })
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const sampleScores = [
    makeScore({ score: 95, verdict: 'PASS', mustFix: ['修复甲'] }),
    makeScore({ score: 85, verdict: 'HOLD', mustFix: ['修复乙'], nextAction: 'fix_and_review' }),
  ]
  const fakeSubagents = makeFakeSubagents((spec) => {
    if (String(spec.label).startsWith('judge')) {
      const sample = judgeSampleIndex(spec)
      return completedActivation(sampleScores[sample], `child-judge-${sample + 1}`)
    }
    return completedActivation(makeAttack(), 'child-attack')
  })

  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(result.ok, true, result.error)
  assert.equal(result.gate.passed, false)
  // Even sample count → the LOWER of the two middle values (85, not 90).
  assert.equal(result.score.score, 85)
  assert.equal(result.score.rawScore, 85)
  assert.equal(result.score.findingsCount, 4)
  assert.equal(result.score.supportedCount, 4)
  assert.deepEqual(result.score.mustFix, ['修复甲', '修复乙'])
  assert.equal(result.score.disagreement.scoreSpread, 10)
  assert.equal(result.score.disagreement.mustFixMismatch, true)
  assert.equal(result.score.disagreement.verdictMismatch, true)
  assert.equal(result.score.disagreement.disagree, true)
  assert.equal(result.judges.length, 2)
  assert.deepEqual(result.judges.map((judge) => judge.index), [0, 1])
  assert.deepEqual(result.judges.map((judge) => judge.score), [95, 85])
  assert.deepEqual(result.judges.map((judge) => judge.rawScore), [95, 85])
  assert.deepEqual(result.judges.map((judge) => judge.mustFixCount), [1, 1])
  assert.equal(result.judges[0].sessionId, 'child-judge-1')
  assert.equal(result.judges[1].sessionId, 'child-judge-2')

  // Persisted: both samples, all session ids, disagreement, conservative aggregate.
  const round = store.state.cycles[0].rounds[0]
  assert.equal(round.status, 'completed')
  assert.equal(round.score.score, 85)
  assert.equal(round.judgeSessionId, 'child-judge-1')
  assert.deepEqual(round.judgeSessionIds, ['child-judge-1', 'child-judge-2'])
  assert.equal(round.judges.length, 2)
  assert.equal(round.judges[1].mustFix.length, 1)
  assert.equal(round.judges[1].rawSnippet.length > 0, true)
  assert.equal(round.disagreement.disagree, true)
  assert.ok(round.gate.failReasons.some((reason) => reason.includes('评分 85')))

  // Independent sessions with byte-identical prompts.
  const judgeCalls = fakeSubagents.calls.filter((call) => String(call.label).startsWith('judge'))
  assert.equal(judgeCalls.length, 2)
  assert.equal(judgeCalls[0].label, 'judge-r1-1')
  assert.equal(judgeCalls[1].label, 'judge-r1-2')
  assert.equal(judgeCalls[0].request.prompt[0].text, judgeCalls[1].request.prompt[0].text)
})

test('runReviewRound flags a mustFix mismatch even when both judges score 95', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'), { judgeSamples: 2 })
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const sampleScores = [
    makeScore({ score: 95, verdict: 'PASS' }),
    makeScore({ score: 95, verdict: 'PASS', mustFix: ['修复抽牌按钮'], nextAction: 'fix_and_review' }),
  ]
  const fakeSubagents = makeFakeSubagents((spec) => {
    if (String(spec.label).startsWith('judge')) {
      return completedActivation(sampleScores[judgeSampleIndex(spec)], `child-judge-${judgeSampleIndex(spec) + 1}`)
    }
    return completedActivation(makeAttack(), 'child-attack')
  })

  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(result.ok, true, result.error)
  assert.equal(result.score.score, 95)
  assert.deepEqual(result.score.mustFix, ['修复抽牌按钮'])
  assert.equal(result.score.disagreement.scoreSpread, 0)
  assert.equal(result.score.disagreement.mustFixMismatch, true)
  assert.equal(result.score.disagreement.verdictMismatch, false)
  assert.equal(result.score.disagreement.disagree, true)
  assert.equal(result.gate.passed, false)
  assert.ok(result.gate.failReasons.some((reason) => reason.includes('mustFix')))
})

test('runReviewRound passes the gate when both judges agree on a clean 95', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  // Both judges return the same clean PASS.
  const config = baseConfig(path.join(dir, 'state'), { judgeSamples: 2 })
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const fakeSubagents = makeFakeSubagents((spec) => {
    if (String(spec.label).startsWith('judge')) {
      return completedActivation(makeScore(), `child-judge-${judgeSampleIndex(spec) + 1}`)
    }
    return completedActivation(makeAttack(), 'child-attack')
  })

  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(result.ok, true, result.error)
  assert.equal(result.score.score, 95)
  assert.deepEqual(result.score.mustFix, [])
  assert.deepEqual(result.score.blockingFindings, [])
  assert.ok(result.score.validFindings.every((finding) => finding.supported === true))
  assert.equal(result.score.disagreement.disagree, false)
  assert.equal(result.score.disagreement.scoreSpread, 0)
  assert.equal(result.gate.passed, true)
  assert.equal(result.nextAction, 'stop')
  // Both independent judge sessions are recorded, and each prompt is identical.
  const judgeCalls = fakeSubagents.calls.filter((call) => String(call.label).startsWith('judge'))
  assert.equal(judgeCalls.length, 2)
  assert.deepEqual(judgeCalls.map((call) => call.label), ['judge-r1-1', 'judge-r1-2'])
  assert.equal(judgeCalls[0].request.prompt[0].text, judgeCalls[1].request.prompt[0].text)
  assert.deepEqual(store.state.cycles[0].rounds[0].judgeSessionIds, ['child-judge-1', 'child-judge-2'])
})

test('runReviewRound blocks when only one judge supports a MAJOR blocker', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'), { judgeSamples: 2 })
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const minorFindings = [
    { title: '缺少图片 alt', severity: 'MINOR', supported: true, note: 'index.html:10' },
    { title: '控制台残留警告', severity: 'MINOR', supported: true, note: 'app.js:90' },
    { title: '移动端间距偏小', severity: 'MINOR', supported: true, note: 'styles.css:120' },
  ]
  const sampleScores = [
    makeScore({
      score: 95,
      verdict: 'PASS',
      findingsCount: 4,
      validFindings: [{ title: '核心交互失效', severity: 'MAJOR', supported: true, note: 'app.js:42' }, ...minorFindings],
    }),
    makeScore({ score: 95, verdict: 'PASS', findingsCount: 3, validFindings: minorFindings }),
  ]
  const fakeSubagents = makeFakeSubagents((spec) => {
    if (String(spec.label).startsWith('judge')) {
      return completedActivation(sampleScores[judgeSampleIndex(spec)], `child-judge-${judgeSampleIndex(spec) + 1}`)
    }
    return completedActivation(makeAttack(), 'child-attack')
  })

  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(result.ok, true, result.error)
  assert.equal(result.score.score, 95)
  assert.deepEqual(result.score.mustFix, [])
  // Union of any-sample supported blocking findings → gate can never pass.
  assert.equal(result.score.blockingFindings.length, 1)
  assert.equal(result.score.blockingFindings[0].severity, 'MAJOR')
  assert.equal(result.gate.passed, false)
  assert.equal(result.gate.failReasons.length, 1)
  assert.ok(result.gate.failReasons[0].includes('阻断项'))
  // Intersection semantics: the MAJOR exists in only one sample → not supported.
  const major = result.score.validFindings.find((finding) => finding.title === '核心交互失效')
  assert.equal(major.supported, false)
})

test('runReviewRound records requested model routes, or inherits with a warning', async (t) => {
  const dir = await tempDir(t)
  const supportingTarget = path.join(dir, 'app-routed')
  const fallbackTarget = path.join(dir, 'app-inherited')
  await mkdir(supportingTarget)
  await mkdir(fallbackTarget)

  const routedConfig = baseConfig(path.join(dir, 'state-routed'), {
    judgeSamples: 1,
    attackerProvider: 'alt',
    attackerModel: 'attack-x',
    judgeProvider: 'alt',
    judgeModel: 'judge-x',
    judgeReasoningEffort: 'high',
  })
  const routedStore = createStore({ stateDir: routedConfig.stateDir })
  const { fn: routedShots } = makeFakeRenderShots()
  const routed = makeFakeSubagents((spec) => (
    String(spec.label).startsWith('judge')
      ? completedActivation(makeScore(), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ), null, { agentOptions: true })
  const routedResult = await runReviewRound(baseRoundOptions(routedConfig, routedStore, supportingTarget, {
    subagents: routed.service,
    renderShots: routedShots,
  }))
  assert.equal(routedResult.ok, true, routedResult.error)
  assert.deepEqual(routed.calls[0].request.agentOptions, { provider: 'alt', model: 'attack-x' })
  assert.deepEqual(routed.calls[1].request.agentOptions, { provider: 'alt', model: 'judge-x', reasoningEffort: 'high' })
  const routedRound = routedStore.state.cycles[0].rounds[0]
  assert.deepEqual(routedRound.modelRoute, {
    attacker: { provider: 'alt', model: 'attack-x' },
    judge: { provider: 'alt', model: 'judge-x', reasoningEffort: 'high' },
    inherited: false,
    samples: [{ provider: 'alt', model: 'judge-x', reasoningEffort: 'high' }],
  })
  assert.deepEqual(routedResult.modelRoute, routedRound.modelRoute)

  // Provider without `agentOptions`: configured routes are dropped, inherit,
  // and the fallback is explained in warnings instead of failing the round.
  const fallbackConfig = baseConfig(path.join(dir, 'state-inherited'), {
    judgeSamples: 1,
    judgeModel: 'judge-x',
  })
  const fallbackStore = createStore({ stateDir: fallbackConfig.stateDir })
  const { fn: fallbackShots } = makeFakeRenderShots()
  const fallback = makeFakeSubagents((spec) => (
    String(spec.label).startsWith('judge')
      ? completedActivation(makeScore(), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))
  const fallbackResult = await runReviewRound(baseRoundOptions(fallbackConfig, fallbackStore, fallbackTarget, {
    subagents: fallback.service,
    renderShots: fallbackShots,
  }))
  assert.equal(fallbackResult.ok, true, fallbackResult.error)
  assert.equal(fallback.calls[0].request.agentOptions, undefined)
  assert.equal(fallback.calls[1].request.agentOptions, undefined)
  assert.ok(fallbackResult.warnings.some((warning) => warning.includes('不支持 agentOptions')))
  assert.deepEqual(fallbackStore.state.cycles[0].rounds[0].modelRoute, {
    attacker: null,
    judge: null,
    inherited: true,
    samples: [null],
  })
})

// ---------------------------------------------------------------------------
// v2.0 Stage A: per-sample judge model routes (judgeModels)
// ---------------------------------------------------------------------------

test('resolveJudgeSampleRoutes merges judgeModels over the default judge route', () => {
  const baseConfig = {
    judgeProvider: 'base',
    judgeModel: 'jbase',
    judgeReasoningEffort: 'low',
    judgeModels: [
      { provider: 'p1', model: 'm1' },
      { model: 'm2', reasoningEffort: 'high' },
    ],
  }
  const baseJudge = { provider: 'base', model: 'jbase', reasoningEffort: 'low' }
  const routed = resolveJudgeSampleRoutes({
    config: baseConfig,
    caps: { agentOptions: true },
    providerName: 'spawn',
    judgeSamples: 2,
    baseJudge,
  })
  assert.deepEqual(routed.samples, [
    { provider: 'p1', model: 'm1', reasoningEffort: 'low' },
    { provider: 'base', model: 'm2', reasoningEffort: 'high' },
  ])
  assert.deepEqual(routed.warnings, [])
  assert.equal(routed.configuredCount, 2)

  // Extra judgeModels entries are ignored with a warning.
  const extra = resolveJudgeSampleRoutes({
    config: { ...baseConfig, judgeModels: [...baseConfig.judgeModels, { model: 'm3' }] },
    caps: { agentOptions: true },
    judgeSamples: 2,
    baseJudge,
  })
  assert.deepEqual(extra.samples, routed.samples)
  assert.ok(extra.warnings.some((warning) => warning.includes('忽略后 1 个')))
  assert.equal(extra.configuredCount, 3)

  // Missing entries inherit the default route.
  const inherited = resolveJudgeSampleRoutes({
    config: { ...baseConfig, judgeModels: [{ model: 'only-first' }] },
    caps: { agentOptions: true },
    judgeSamples: 2,
    baseJudge,
  })
  assert.deepEqual(inherited.samples, [
    { provider: 'base', model: 'only-first', reasoningEffort: 'low' },
    baseJudge,
  ])

  // Providers without agentOptions request nothing and explain the drop.
  const dropped = resolveJudgeSampleRoutes({
    config: { judgeModels: [{ provider: 'p1', model: 'm1' }] },
    caps: { agentOptions: false },
    providerName: 'legacy',
    judgeSamples: 1,
    baseJudge: null,
  })
  assert.deepEqual(dropped.samples, [null])
  assert.ok(dropped.warnings.some((warning) => warning.includes('不支持 agentOptions')))
  // Unknown fields are ignored defensively (config validation rejects them).
  const unknown = resolveJudgeSampleRoutes({
    config: { judgeModels: [{ model: 'm', nonsense: 'x' }] },
    caps: { agentOptions: true },
    judgeSamples: 1,
    baseJudge: null,
  })
  assert.deepEqual(unknown.samples, [{ model: 'm' }])
})

test('runReviewRound routes each judge sample via judgeModels and audits routes/statistics', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'), {
    judgeSamples: 2,
    judgeProvider: 'base',
    judgeModel: 'jbase',
    judgeModels: [
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2', reasoningEffort: 'high' },
    ],
  })
  const store = createStore({ stateDir: config.stateDir })
  const { fn: renderShots } = makeFakeRenderShots()
  const fake = makeFakeSubagents((spec) => {
    const label = String(spec.label)
    if (label.startsWith('judge')) {
      const sample = label.endsWith('-1') ? 95 : 85
      return completedActivation(makeScore({ score: sample }), `child-judge-${sample}`)
    }
    return completedActivation(makeAttack(), 'child-attack')
  }, null, { agentOptions: true })
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fake.service,
    renderShots,
  }))
  assert.equal(result.ok, true, result.error)
  // Attacker keeps the default (no attacker route); judges use judgeModels[i].
  assert.equal(fake.calls[0].request.agentOptions, undefined)
  assert.deepEqual(fake.calls[1].request.agentOptions, { provider: 'p1', model: 'm1' })
  assert.deepEqual(fake.calls[2].request.agentOptions, { provider: 'p2', model: 'm2', reasoningEffort: 'high' })

  const round = store.state.cycles[0].rounds[0]
  assert.deepEqual(round.modelRoute, {
    attacker: null,
    judge: { provider: 'base', model: 'jbase' },
    inherited: false,
    samples: [
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2', reasoningEffort: 'high' },
    ],
  })
  assert.deepEqual(round.judges.map((judge) => judge.modelRoute), [
    { provider: 'p1', model: 'm1' },
    { provider: 'p2', model: 'm2', reasoningEffort: 'high' },
  ])
  // Lower-median gate score is unchanged: [85, 95] → 85.
  assert.equal(round.score.score, 85)
  assert.equal(round.score.samples, 2)
  assert.equal(round.score.scoreStats.n, 2)
  assert.equal(round.score.scoreStats.mean, 90)
  assert.equal(round.score.scoreStats.median, 90)
  assert.equal(round.score.scoreStats.stdev, 7.1)
  assert.equal(round.score.scoreStats.ci95.low <= 90 && round.score.scoreStats.ci95.high >= 90, true)
  assert.equal(round.gate.score, 85)
  // Compact result carries bounded per-sample routes + statistics.
  assert.deepEqual(result.modelRoute.samples, round.modelRoute.samples)
  assert.equal(result.scoreStats.mean, 90)
  assert.equal(result.scoreStats.median, 90)
  assert.equal(result.scoreStats.stdev, 7.1)
  assert.deepEqual(result.judges.map((judge) => judge.modelRoute), round.judges.map((judge) => judge.modelRoute))

  // Routes survive a state reload through the store normalizer.
  const reloaded = createStore({ stateDir: config.stateDir })
  await reloaded.init()
  const reloadedRound = reloaded.state.cycles[0].rounds[0]
  assert.deepEqual(reloadedRound.modelRoute.samples, round.modelRoute.samples)
  assert.deepEqual(reloadedRound.judges[1].modelRoute, { provider: 'p2', model: 'm2', reasoningEffort: 'high' })
})

test('runReviewRound falls back to the default judge route and degrades without agentOptions', async (t) => {
  const dir = await tempDir(t)
  const inheritTarget = path.join(dir, 'app-inherit')
  const dropTarget = path.join(dir, 'app-drop')
  await mkdir(inheritTarget)
  await mkdir(dropTarget)

  // judgeModels shorter than judgeSamples: remaining sample inherits the default route.
  const inheritConfig = baseConfig(path.join(dir, 'state-inherit'), {
    judgeSamples: 2,
    judgeProvider: 'base',
    judgeModel: 'jbase',
    judgeModels: [{ model: 'm1' }],
  })
  const inheritStore = createStore({ stateDir: inheritConfig.stateDir })
  const { fn: inheritShots } = makeFakeRenderShots()
  const inheritFake = makeFakeSubagents((spec) => (
    String(spec.label).startsWith('judge')
      ? completedActivation(makeScore(), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ), null, { agentOptions: true })
  const inheritResult = await runReviewRound(baseRoundOptions(inheritConfig, inheritStore, inheritTarget, {
    subagents: inheritFake.service,
    renderShots: inheritShots,
  }))
  assert.equal(inheritResult.ok, true, inheritResult.error)
  assert.deepEqual(inheritFake.calls[1].request.agentOptions, { provider: 'base', model: 'm1' })
  assert.deepEqual(inheritFake.calls[2].request.agentOptions, { provider: 'base', model: 'jbase' })

  // judgeModels configured but provider lacks agentOptions: no routes, one warning.
  const dropConfig = baseConfig(path.join(dir, 'state-drop'), {
    judgeSamples: 1,
    judgeModels: [{ provider: 'p1', model: 'm1' }],
  })
  const dropStore = createStore({ stateDir: dropConfig.stateDir })
  const { fn: dropShots } = makeFakeRenderShots()
  const dropFake = makeFakeSubagents((spec) => (
    String(spec.label).startsWith('judge')
      ? completedActivation(makeScore(), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))
  const dropResult = await runReviewRound(baseRoundOptions(dropConfig, dropStore, dropTarget, {
    subagents: dropFake.service,
    renderShots: dropShots,
  }))
  assert.equal(dropResult.ok, true, dropResult.error)
  assert.equal(dropFake.calls[1].request.agentOptions, undefined)
  assert.ok(dropResult.warnings.some((warning) => warning.includes('judgeModels 模型路由未生效')))
  const dropRound = dropStore.state.cycles[0].rounds[0]
  assert.deepEqual(dropRound.modelRoute.samples, [null])
  assert.equal(dropRound.judges[0].modelRoute, null)
})

test('runReviewRound allows follow-up rounds while the gate fails, then enforces maxRounds', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'), { maxRounds: 2 })
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const failingScore = makeScore({
    score: 75,
    verdict: 'HOLD',
    mustFix: ['修复抽牌按钮'],
    nextAction: 'fix_and_review',
  })
  const fakeSubagents = makeFakeSubagents((spec) => (
    spec.label.startsWith('judge')
      ? completedActivation(failingScore, 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))

  const first = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(first.ok, true)
  assert.equal(first.gate.passed, false)
  assert.equal(first.nextAction, 'fix_and_review')
  assert.ok(first.message.includes('未达标'))
  assert.equal(store.state.cycles[0].status, 'reviewing')

  const second = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(second.ok, true)
  assert.equal(second.round, 2)
  assert.equal(store.state.cycles[0].rounds.length, 2)

  const third = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(third.ok, false)
  assert.equal(third.stage, 'max-rounds')
  assert.equal(store.state.cycles[0].rounds.length, 2)
  assert.equal(store.state.cycles[0].rounds[1].status, 'completed')
})

test('runReviewRound rejects a mistyped explicit path before creating a round', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const { fn: shots } = makeFakeRenderShots()
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    args: {
      target,
      shots: [
        { path: 'missing.html' },
        { path: 'index.html' },
        { url: 'http://127.0.0.1:1/' },
        { url: 'http://127.0.0.1:2/' },
      ],
    },
    subagents: null,
    renderShots: shots,
  }))
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'arguments')
  assert.match(result.error, /不存在/)
  assert.equal(store.state.cycles.length, 0)
})

test('runReviewRound fails the round when fewer than 4 screenshots are produced', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  await writeFile(path.join(target, 'index.html'), '<h1>demo</h1>')
  await writeFile(path.join(target, 'home.html'), '<h1>home</h1>')
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots(null, { fail: true })
  let subagentCalls = 0
  const fakeSubagents = makeFakeSubagents(() => {
    subagentCalls += 1
    return completedActivation(makeAttack(), 'child')
  })

  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    args: {
      target,
      shots: [
        { path: 'index.html' },
        { path: 'home.html' },
        { url: 'http://127.0.0.1:1/' },
        { url: 'http://127.0.0.1:2/' },
      ],
    },
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'screenshots')
  assert.equal(subagentCalls, 0)
  assert.equal(store.state.cycles[0].rounds[0].status, 'failed')
  assert.match(store.state.cycles[0].rounds[0].error, /模拟渲染失败/)
  // Explicit specs are rendered BEFORE the children start.
  assert.equal(fakeShots.calls.length, 1)
})

test('runReviewRound degrades when subagents is unavailable, and requires a caller agent', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: null,
    renderShots: fakeShots.fn,
  }))
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'subagents-unavailable')
  assert.ok(result.error.includes('子智能体服务'))
  assert.equal(fakeShots.calls.length, 0)
  const failedRound = store.state.cycles[0].rounds[0]
  assert.equal(failedRound.status, 'failed')
  assert.ok(failedRound.error.length > 0)

  const withoutAgent = await runReviewRound({
    config,
    store,
    args: { target },
    agent: null,
    subagents: null,
    renderShots: fakeShots.fn,
  })
  assert.equal(withoutAgent.ok, false)
  assert.equal(withoutAgent.stage, 'arguments')
})

test('runReviewRound marks the round failed on attacker-parse and judge-parse errors', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'))

  const storeA = createStore({ stateDir: path.join(dir, 'state') })
  const badAttack = makeFakeSubagents(() => completedActivation('抱歉，我无法输出 JSON', 'child'))
  const { fn: shotsA } = makeFakeRenderShots()
  const attackFailure = await runReviewRound(baseRoundOptions(config, storeA, target, {
    subagents: badAttack.service,
    renderShots: shotsA,
  }))
  assert.equal(attackFailure.ok, false)
  assert.equal(attackFailure.stage, 'attacker-parse')
  assert.ok(typeof attackFailure.raw === 'string' && attackFailure.raw.length > 0)
  assert.equal(storeA.state.cycles[0].rounds[0].status, 'failed')

  const storeB = createStore({ stateDir: path.join(dir, 'state-b') })
  const configB = baseConfig(path.join(dir, 'state-b'))
  const badJudge = makeFakeSubagents((spec) => (
    spec.label.startsWith('judge')
      ? completedActivation('{"score":"nope"}', 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))
  const { fn: shotsB } = makeFakeRenderShots()
  const judgeFailure = await runReviewRound(baseRoundOptions(configB, storeB, target, {
    subagents: badJudge.service,
    renderShots: shotsB,
  }))
  assert.equal(judgeFailure.ok, false)
  assert.equal(judgeFailure.stage, 'judge-parse')
  const round = storeB.state.cycles[0].rounds[0]
  assert.equal(round.status, 'failed')
  assert.ok(round.attack !== null)
})

test('runReviewRound aborts a hung child on the round timeout', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'), { roundTimeoutSeconds: 0.05 })
  const store = createStore({ stateDir: config.stateDir })
  let disposed = 0
  const hung = makeFakeSubagents(() => ({
    childId: 'child-hung',
    result: new Promise(() => {}),
    dispose: async () => {
      disposed += 1
    },
  }))
  const { fn: shots } = makeFakeRenderShots()
  const startedAt = Date.now()
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: hung.service,
    renderShots: shots,
  }))
  const elapsed = Date.now() - startedAt
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'attacker')
  assert.match(result.error, /超时/)
  assert.ok(disposed >= 1)
  assert.ok(elapsed < 5000, `timeout path should be prompt, took ${elapsed}ms`)
  assert.equal(store.state.cycles[0].rounds[0].status, 'failed')
})

test('runReviewRound treats a non-completed stopReason as a failure', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const stopped = makeFakeSubagents(() => ({
    childId: 'child-stopped',
    result: Promise.resolve({
      output: [{ type: 'text', text: '{}' }],
      stopReason: 'error',
      diagnostic: 'provider exploded',
    }),
    dispose: async () => {},
  }))
  const { fn: shots } = makeFakeRenderShots()
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: stopped.service,
    renderShots: shots,
  }))
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'attacker')
  assert.match(result.error, /stopReason=error/)
  assert.match(result.error, /provider exploded/)
})

// ---------------------------------------------------------------------------
// status summary
// ---------------------------------------------------------------------------

test('buildStatusSummary lists cycles newest first and filters by target', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const fakeSubagents = makeFakeSubagents((spec) => (
    spec.label.startsWith('judge')
      ? completedActivation(makeScore({ score: 75, verdict: 'HOLD', mustFix: ['修复'] , nextAction: 'fix_and_review' }), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))
  await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))

  const summary = await buildStatusSummary({ store, now: () => 123, limit: 5 })
  assert.equal(summary.ok, true)
  assert.equal(summary.version, 1)
  assert.equal(summary.generatedAt, 123)
  assert.equal(summary.cycles.length, 1)
  assert.equal(summary.cycles[0].cycleId, store.state.cycles[0].id)
  assert.equal(summary.cycles[0].rounds, 1)
  assert.equal(summary.cycles[0].latest.gatePassed, false)
  assert.equal(summary.cycles[0].latest.score, 75)
  assert.deepEqual(summary.cycles[0].latest.mustFix, ['修复'])

  const filtered = await buildStatusSummary({ store, target })
  assert.equal(filtered.cycles.length, 1)
  const other = await buildStatusSummary({ store, target: path.join(dir, 'other') })
  assert.deepEqual(other.cycles, [])
  const broken = await buildStatusSummary({ store: null })
  assert.equal(broken.ok, false)
})

// ---------------------------------------------------------------------------
// v1.1 1.3: snapshots, deliverable roots and the concurrency lock
// ---------------------------------------------------------------------------

test('runReviewRound records the project snapshot and binds the deliverable root', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  await writeFile(path.join(target, 'index.html'), '<h1>snapshot</h1>')
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const fakeSubagents = makeFakeSubagents((spec) => (
    spec.label.startsWith('judge')
      ? completedActivation(makeScore(), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))

  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(result.ok, true, result.error)
  assert.equal(result.gate.passed, true)

  const cycle = store.state.cycles[0]
  assert.equal(cycle.deliverableRoot, path.resolve(target))
  const round = cycle.rounds[0]
  assert.ok(round.snapshot)
  assert.match(round.snapshot.manifestHash, /^[0-9a-f]{64}$/)
  // The manifest was taken BEFORE the round and the project did not change.
  assert.equal(round.snapshot.manifestHash, computeSnapshotSync(target).manifestHash)
  assert.equal(round.snapshot.gitCommit, null) // tmp dirs are not git checkouts
  assert.equal(round.snapshot.fileCount, 1)
  assert.equal(round.snapshot.truncated, false)
  assert.equal(round.snapshot.skippedCount, 0)
  assert.ok(round.snapshot.createdAt > 0)
  // Evidence records now carry content hashes.
  assert.equal(round.shots.length, 4)
  for (const shot of round.shots) assert.match(shot.sha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(round.redaction, { hit: false, count: 0 })
})

test('runReviewRound rejects targets outside deliverableRoots and blocks retargeting', async (t) => {
  const dir = await tempDir(t)
  const workspace = path.join(dir, 'workspace')
  const app1 = path.join(workspace, 'app1')
  const app2 = path.join(workspace, 'app2')
  const outside = path.join(dir, 'outside')
  await mkdir(app1, { recursive: true })
  await mkdir(app2, { recursive: true })
  await mkdir(outside, { recursive: true })

  // Unit-level resolver: most specific root, empty config, out-of-root.
  assert.equal(resolveDeliverableRoot(app1, [workspace]), path.resolve(workspace))
  assert.equal(resolveDeliverableRoot(app1, []), path.resolve(app1))
  assert.equal(resolveDeliverableRoot(app1, [dir, workspace]), path.resolve(workspace))
  assert.throws(
    () => resolveDeliverableRoot(outside, [workspace]),
    (error) => error instanceof ReviewError && error.stage === 'arguments' && /交付根/.test(error.message),
  )

  const config = baseConfig(path.join(dir, 'state'), { deliverableRoots: [workspace] })
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const fakeSubagents = makeFakeSubagents((spec) => (
    spec.label.startsWith('judge')
      ? completedActivation(makeScore(), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))
  const run = (target) => runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))

  // Out-of-root target: rejected as arguments, no cycle created.
  const rejected = await run(outside)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.stage, 'arguments')
  assert.match(rejected.error, /不在已声明的交付根/)
  assert.equal(store.state.cycles.length, 0)

  // In-root target: the cycle binds the DECLARED root, not the sub-directory.
  const first = await run(app1)
  assert.equal(first.ok, true, first.error)
  assert.equal(store.state.cycles.length, 1)
  assert.equal(store.state.cycles[0].target, path.resolve(app1))
  assert.equal(store.state.cycles[0].deliverableRoot, path.resolve(workspace))
  assert.ok(first.warnings.some((warning) => warning.includes('交付根')))

  // A second target under the same root is a "换靶子" attempt → rejected.
  const retarget = await run(app2)
  assert.equal(retarget.ok, false)
  assert.equal(retarget.stage, 'arguments')
  assert.match(retarget.error, /不允许更换 target/)
  assert.equal(store.state.cycles.length, 1)
  assert.equal(store.state.cycles[0].rounds.length, 1)
})

test('runReviewRound rejects a concurrent round on the same deliverable root (stage busy)', async (t) => {
  t.after(() => __resetRoundLocks())
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  let releaseAttacker = null
  const attackerGate = new Promise((resolve) => { releaseAttacker = resolve })
  const failingScore = makeScore({ score: 75, verdict: 'HOLD', mustFix: ['修复抽牌按钮'], nextAction: 'fix_and_review' })
  const fakeSubagents = makeFakeSubagents(async (spec) => {
    if (String(spec.label).startsWith('judge')) return completedActivation(failingScore, 'child-judge')
    await attackerGate
    return completedActivation(makeAttack(), 'child-attack')
  })
  const options = () => baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  })

  const first = runReviewRound(options())
  const deadline = Date.now() + 5000
  while (fakeSubagents.calls.length === 0 && Date.now() < deadline) await delay(10)
  assert.equal(fakeSubagents.calls.length, 1)
  const held = describeRoundLock(target)
  assert.ok(held !== null)
  assert.equal(held.cycleId, store.state.cycles[0].id)

  const second = await runReviewRound(options())
  assert.equal(second.ok, false)
  assert.equal(second.stage, 'busy')
  assert.match(second.error, /已有评审轮次进行中/)
  assert.equal(store.state.cycles[0].rounds.length, 1)

  releaseAttacker()
  const firstResult = await first
  assert.equal(firstResult.ok, true, firstResult.error)
  assert.equal(firstResult.round, 1)
  assert.equal(describeRoundLock(target), null)

  // The slot is free again → the next round is accepted.
  const third = await runReviewRound(options())
  assert.equal(third.ok, true, third.error)
  assert.equal(third.round, 2)
})

test('runReviewRound fails the round at stage snapshot before rendering when the manifest fails', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const fakeSubagents = makeFakeSubagents(() => completedActivation(makeAttack(), 'child'))

  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
    computeSnapshot: async () => ({ ok: false, error: { code: 'EACCES', message: '模拟不可读' } }),
  }))
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'snapshot')
  assert.match(result.error, /评审快照生成失败/)
  assert.match(result.error, /模拟不可读/)
  assert.equal(fakeShots.calls.length, 0)
  assert.equal(fakeSubagents.calls.length, 0)
  const round = store.state.cycles[0].rounds[0]
  assert.equal(round.status, 'failed')
  assert.match(round.error, /评审快照生成失败/)
  // The per-root lock was released even though the round failed.
  assert.equal(describeRoundLock(target), null)
})

test('runReviewRound enforces the screenshot URL allowlist before creating a round', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const fakeShots = makeFakeRenderShots()
  const fakeSubagents = makeFakeSubagents((spec) => (
    spec.label.startsWith('judge')
      ? completedActivation(makeScore(), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))

  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const blocked = await runReviewRound(baseRoundOptions(config, store, target, {
    args: {
      target,
      shots: [
        { url: 'https://evil.example.com/a' },
        { url: 'http://127.0.0.1:3001/b' },
        { url: 'http://127.0.0.1:3002/c' },
        { url: 'http://127.0.0.1:3003/d' },
      ],
    },
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(blocked.ok, false)
  assert.equal(blocked.stage, 'arguments')
  assert.match(blocked.error, /白名单/)
  assert.equal(store.state.cycles.length, 0)

  // Same URLs with an explicit origin allowlist are accepted.
  const allowedConfig = baseConfig(path.join(dir, 'state-allowed'), { allowedOrigins: ['https://allowed.example.com'] })
  const allowedStore = createStore({ stateDir: allowedConfig.stateDir })
  const allowed = await runReviewRound(baseRoundOptions(allowedConfig, allowedStore, target, {
    args: {
      target,
      shots: [
        { url: 'https://allowed.example.com/a' },
        { url: 'http://127.0.0.1:3001/b' },
        { url: 'http://127.0.0.1:3002/c' },
        { url: 'http://localhost:3003/d' },
      ],
    },
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(allowed.ok, true, allowed.error)
  assert.equal(allowed.shots.length, 4)
})

test('runReviewRound refuses new rounds whose screenshots lack sha256 hashes', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  let subagentCalls = 0
  const fakeSubagents = makeFakeSubagents(() => {
    subagentCalls += 1
    return completedActivation(makeAttack(), 'child')
  })
  // Legacy-shaped renderer: real PNGs but no sha256 in the shot records.
  const legacyShots = async (options) => {
    const shotDir = path.join(options.stateDir, 'shots', options.cycleId)
    await mkdir(shotDir, { recursive: true })
    const shots = []
    for (let index = 0; index < options.specs.length; index += 1) {
      const spec = options.specs[index]
      const file = `r${options.roundNo ?? 1}-s${index + 1}-shot-${index + 1}.png`
      const bytes = makePngHeader(spec.width, spec.height)
      await writeFile(path.join(shotDir, file), bytes)
      shots.push({ file, width: spec.width, height: spec.height, bytes: bytes.length, page: spec.page, renderedAt: 1 })
    }
    return { ok: true, shots, errors: [], warnings: [] }
  }
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: legacyShots,
  }))
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'screenshots')
  assert.match(result.error, /sha256/)
  assert.equal(subagentCalls, 0)
  assert.equal(store.state.cycles[0].rounds[0].status, 'failed')
})

// ---------------------------------------------------------------------------
// v1.1 1.4: secret redaction of persisted evidence
// ---------------------------------------------------------------------------

test('runReviewRound redacts secrets from attack/score/judges/judgeRaw before persisting', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const secretAttack = makeAttack({
    summary: '发现前端硬编码 sk-ABCDEFGHIJKLMNOP 与 Bearer abcdefghijklmnop',
    findings: [{
      severity: 'BLOCKER',
      title: '前端 API key 泄漏',
      evidence: 'config.js:3 api_key="an-example-secret-123"',
      attack: '读取构建产物',
      impact: '凭证泄漏',
      fix: '改为服务端注入',
      confidence: 'high',
      verified: true,
    }, {
      severity: 'MINOR',
      title: 'AKIAABCDEFGHIJKLMNOP 出现在日志',
      evidence: 'debug.log:9',
      attack: '查看日志',
      impact: '凭证泄漏',
      fix: '清理日志',
      confidence: 'medium',
      verified: true,
    }, {
      severity: 'MINOR',
      title: '缺少图片 alt',
      evidence: 'index.html:10',
      attack: '读屏工具',
      impact: '可访问性下降',
      fix: '补 alt',
      confidence: 'high',
      verified: true,
    }],
  })
  const secretScore = makeScore({
    validFindings: [
      { title: 'sk-ZYXWVUTSRQPONM 出现在构建日志', severity: 'MINOR', supported: true, note: 'app.js:1' },
      { title: 'AKIAABCDEFGHIJKLMNOP 泄漏', severity: 'MINOR', supported: true, note: 'config.js:3' },
      { title: '缺少图片 alt', severity: 'MINOR', supported: true, note: 'index.html:10' },
      { title: '移动端布局溢出', severity: 'MINOR', supported: true, note: 'style.css:8' },
    ],
    rationale: '另外 token=abcdefghijk 在源码中出现。',
  })
  const fakeSubagents = makeFakeSubagents((spec) => (
    spec.label.startsWith('judge')
      ? completedActivation(secretScore, 'child-judge')
      : completedActivation(secretAttack, 'child-attack')
  ))

  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(result.ok, true, result.error)

  const persisted = store.state.cycles[0].rounds[0]
  assert.equal(persisted.redaction.hit, true)
  assert.ok(persisted.redaction.count >= 4)
  const persistedText = JSON.stringify({
    attack: persisted.attack,
    score: persisted.score,
    judges: persisted.judges,
    judgeRaw: persisted.judgeRaw,
  })
  for (const secret of [
    'sk-ABCDEFGHIJKLMNOP',
    'sk-ZYXWVUTSRQPONM',
    'Bearer abcdefghijklmnop',
    'AKIAABCDEFGHIJKLMNOP',
    'an-example-secret-123',
    'token=abcdefghijk',
  ]) {
    assert.equal(persistedText.includes(secret), false, `secret leaked: ${secret}`)
  }
  assert.ok(persistedText.includes('[REDACTED:openai-key]'))
  assert.ok(persistedText.includes('[REDACTED:aws-access-key]'))
  // Redaction keeps the evidence readable and does not disturb normal content.
  assert.ok(persisted.attack.findings[0].title.includes('前端 API key 泄漏'))
  assert.equal(persisted.score.score, 95)
  assert.equal(persisted.score.validFindings.length, 4)
  assert.ok(JSON.stringify(persisted.score).includes('移动端布局溢出'))
  // The compact tool result is redacted as well.
  assert.equal(JSON.stringify(result.attack).includes('sk-ABCDEFGHIJKLMNOP'), false)
  assert.equal(JSON.stringify(result.score).includes('an-example-secret-123'), false)
})

// ---------------------------------------------------------------------------
// v1.1 1.5: review-child registry lifecycle
// ---------------------------------------------------------------------------

test('v1.1 1.5: every review child is registered while running and unregistered afterwards', async (t) => {
  t.after(() => clearReviewRegistry())
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const { fn: shots } = makeFakeRenderShots()
  const observed = []
  const fakeSubagents = makeFakeSubagents((spec) => {
    const isJudge = String(spec.label).startsWith('judge')
    const childId = isJudge ? 'child-judge-1' : 'child-attack'
    const payload = isJudge ? makeScore() : makeAttack()
    // Resolve the activation after the registry has been populated (the
    // orchestrator registers right after startActivation returns).
    const result = delay(10).then(() => {
      observed.push({ label: spec.label, record: lookupReviewChild(childId) })
      return {
        output: [{ type: 'text', text: JSON.stringify(payload) }],
        structured: payload,
        stopReason: 'completed',
      }
    })
    return { childId, result, dispose: async () => {} }
  })

  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: shots,
  }))
  assert.equal(result.ok, true, result.error)
  assert.equal(observed.length, 2)
  const cycleId = store.state.cycles[0].id
  for (const entry of observed) {
    assert.ok(entry.record !== null, `${entry.label} 运行期间必须已登记为评审子会话`)
    assert.equal(entry.record.cycleId, cycleId)
    assert.equal(entry.record.targetDir, target)
    assert.equal(entry.record.sessionId, entry.label.startsWith('judge') ? 'child-judge-1' : 'child-attack')
  }
  assert.equal(observed[0].record.stage, 'attacker')
  assert.equal(observed[1].record.stage, 'judge')
  // finally: a review child is a reviewer only for the duration of its run.
  assert.deepEqual(listReviewChildren(), [])
  assert.equal(lookupReviewChild('child-attack'), null)
  assert.equal(lookupReviewChild('child-judge-1'), null)
})

test('v1.1 1.5: a timed-out review child is still unregistered', async (t) => {
  t.after(() => clearReviewRegistry())
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'), { roundTimeoutSeconds: 0.05 })
  const store = createStore({ stateDir: config.stateDir })
  const { fn: shots } = makeFakeRenderShots()
  let midRunRecord = null
  const hung = makeFakeSubagents(() => {
    // Sample the registry while the child is still running (well before the
    // 50ms timeout) to prove it was registered, not merely skipped.
    setTimeout(() => {
      midRunRecord = lookupReviewChild('child-hung')
    }, 20)
    return {
      childId: 'child-hung',
      result: new Promise(() => {}),
      dispose: async () => {},
    }
  })

  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: hung.service,
    renderShots: shots,
  }))
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'attacker')
  assert.match(result.error, /超时/)
  assert.ok(midRunRecord !== null, '超时前应已登记评审子会话')
  assert.equal(midRunRecord.stage, 'attacker')
  assert.equal(lookupReviewChild('child-hung'), null)
  assert.deepEqual(listReviewChildren(), [])
})

// ---------------------------------------------------------------------------
// v1.2 Stage A: evidence cards + domain profile
// ---------------------------------------------------------------------------

/** Evidence-mode renderer that honours `shotIndexOffset` (mixed plans). */
function makeEvidenceRenderShots() {
  const calls = []
  const fn = async (options) => {
    calls.push(options)
    const dir = path.join(options.stateDir, 'shots', options.cycleId)
    await mkdir(dir, { recursive: true })
    const offset = Number.isInteger(options.shotIndexOffset) ? options.shotIndexOffset : 0
    const shots = []
    for (let index = 0; index < options.specs.length; index += 1) {
      const spec = options.specs[index]
      const slug = String(spec.name || `shot-${index + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, '-')
      const file = `r${options.roundNo ?? 1}-s${index + offset + 1}-${slug}.png`
      const bytes = makePngHeader(spec.width, spec.height)
      await writeFile(path.join(dir, file), bytes)
      shots.push({
        file,
        path: path.join(dir, file),
        width: spec.width,
        height: spec.height,
        bytes: bytes.length,
        sha256: sha256Buffer(bytes),
        page: spec.page,
        renderedAt: 1,
      })
    }
    return { ok: true, shots, errors: [], warnings: [] }
  }
  return { fn, calls }
}

/** Fake interaction runner writing real PNGs + console/network/perf stats. */
function makeEvidenceInteractionRunner() {
  const calls = []
  const fn = async (options) => {
    calls.push(options)
    const interaction = options.card
    const dir = options.outDir
    await mkdir(dir, { recursive: true })
    const slug = String(interaction.name || 'frame').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const file = `r${options.roundNo}-s${options.shotIndex}-${slug}.png`
    const bytes = makePngHeader(interaction.width, interaction.height)
    await writeFile(path.join(dir, file), bytes)
    return {
      ok: true,
      artifacts: [{
        file,
        path: path.join(dir, file),
        width: interaction.width,
        height: interaction.height,
        bytes: bytes.length,
        sha256: sha256Buffer(bytes),
        mime: 'image/png',
        kind: 'screenshot',
        stepName: null,
      }],
      meta: {
        url: interaction.url,
        page: interaction.page,
        console: { events: ['error: boom'], errors: 2, truncated: false },
        network: { requests: 5, failures: 1, truncated: false, failureSamples: ['404 GET /app.js'] },
        perf: { metrics: { JSHeapUsedSize: 1000 }, fps: 42.5 },
        steps: (interaction.steps || []).map((step) => ({ action: step.action })),
      },
    }
  }
  return { fn, calls }
}

function makeEvidenceCards() {
  return [
    { kind: 'screenshot', path: 'index.html', name: 'start', width: 1440, height: 900 },
    {
      kind: 'interaction',
      path: 'index.html',
      name: 'playthrough',
      width: 900,
      height: 700,
      steps: [
        { action: 'click', selector: '#start' },
        { action: 'screenshot', name: 'playing' },
      ],
    },
    { kind: 'screenshot', path: 'index.html', name: 'menu', width: 1280, height: 800 },
    { kind: 'screenshot', path: 'index.html', name: 'end', width: 768, height: 1024 },
  ]
}

test('validateRoundArgs enforces evidence/shot exclusivity and evidence card shape', () => {
  const evidence = makeEvidenceCards()
  assert.throws(
    () => validateRoundArgs({ target: 'C:\\demo', evidence: 'nope' }, { requiredShots: 4 }),
    (error) => error.stage === 'arguments' && /evidence 必须是数组/.test(error.message),
  )
  assert.throws(
    () => validateRoundArgs({ target: 'C:\\demo', evidence: evidence.slice(0, 3) }, { requiredShots: 4 }),
    (error) => error.stage === 'arguments' && /恰好 4 个/.test(error.message),
  )
  assert.throws(
    () => validateRoundArgs({ target: 'C:\\demo', evidence: [1, 2, 3, 4] }, { requiredShots: 4 }),
    (error) => error.stage === 'arguments' && /必须是对象/.test(error.message),
  )
  assert.throws(
    () => validateRoundArgs({
      target: 'C:\\demo',
      shots: [{ path: 'a.html' }, { path: 'b.html' }, { path: 'c.html' }, { path: 'd.html' }],
      evidence,
    }, { requiredShots: 4 }),
    (error) => error.stage === 'arguments' && /互斥/.test(error.message),
  )
  const accepted = validateRoundArgs({ target: 'C:\\demo', evidence, shots: [] }, { requiredShots: 4 })
  assert.equal(accepted.evidence.length, 4)
  assert.deepEqual(accepted.shots, [])
})

test('runReviewRound validates evidence paths before creating a round', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  await writeFile(path.join(target, 'index.html'), '<h1>demo</h1>')
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const { fn: renderer } = makeEvidenceRenderShots()
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    args: { target, evidence: makeEvidenceCards().map((card, index) => (index === 2 ? { ...card, path: 'missing.html' } : card)) },
    subagents: null,
    renderShots: renderer,
  }))
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'arguments')
  assert.match(result.error, /不存在/)
  assert.equal(store.state.cycles.length, 0)
})

test('runReviewRound executes a 4-card evidence plan (mixed kinds) with profile game', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  await writeFile(path.join(target, 'index.html'), '<h1>game</h1>')
  const config = baseConfig(path.join(dir, 'state'), { profile: 'game' })
  const store = createStore({ stateDir: config.stateDir })
  const renderer = makeEvidenceRenderShots()
  const interaction = makeEvidenceInteractionRunner()
  const fakeSubagents = makeFakeSubagents((spec) => (
    String(spec.label).startsWith('judge')
      ? completedActivation(makeScore(), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))

  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    args: { target, title: '游戏演示', evidence: makeEvidenceCards() },
    subagents: fakeSubagents.service,
    renderShots: renderer.fn,
    runInteractionCard: interaction.fn,
  }))
  assert.equal(result.ok, true, result.error)
  assert.equal(result.gate.passed, true)
  assert.equal(result.profile, 'game')
  assert.equal(result.shots.length, 4)
  assert.deepEqual(result.shots.map((shot) => shot.file), [
    'r1-s1-start.png', 'r1-s2-playthrough.png', 'r1-s3-menu.png', 'r1-s4-end.png',
  ])
  assert.equal(result.evidence.cardCount, 4)
  assert.equal(result.evidence.consoleErrors, 2)
  assert.equal(result.evidence.networkFailures, 1)
  assert.equal(result.evidence.cards[1].kind, 'interaction')
  assert.equal(result.evidence.cards[1].perfFps, 42.5)
  // One batched screenshot call is not used for a mixed plan: two per-card
  // screenshot renders + the interaction runner.
  assert.equal(renderer.calls.length, 3)
  assert.equal(interaction.calls.length, 1)
  assert.equal(interaction.calls[0].shotIndex, 2)

  // Prompts: Host evidence manifest (fenced) + game rubric (trusted).
  const attackerPrompt = fakeSubagents.calls[0].request.prompt[0].text
  assert.ok(attackerPrompt.includes('playthrough'))
  assert.ok(attackerPrompt.includes('本轮证据卡清单'))
  assert.ok(attackerPrompt.includes('游戏领域 rubric'))
  assert.ok(attackerPrompt.includes('核心循环'))
  const judgePrompt = fakeSubagents.calls[1].request.prompt[0].text
  assert.ok(judgePrompt.includes('逐卡评估证据覆盖'))
  assert.ok(judgePrompt.includes('游戏领域 rubric'))

  // Persisted evidence + profile survive a reload; public state drops paths/logs.
  const reloaded = createStore({ stateDir: config.stateDir })
  await reloaded.init()
  const round = reloaded.state.cycles[0].rounds[0]
  assert.equal(round.profile, 'game')
  assert.equal(round.evidence.length, 4)
  assert.equal(round.evidence[1].meta.console.errors, 2)
  const publicState = toPublicState(reloaded.state, { generatedAt: 1 })
  const publicRound = publicState.cycles[0].rounds[0]
  assert.equal(publicRound.evidence.length, 4)
  assert.equal(publicRound.evidence[1].kind, 'interaction')
  assert.equal(publicRound.evidence[1].consoleErrors, 2)
  assert.equal(JSON.stringify(publicRound.evidence).includes('file:///'), false)
  for (const card of publicRound.evidence) {
    for (const artifact of card.artifacts) {
      assert.equal(typeof artifact.file, 'string')
      assert.equal('path' in artifact, false)
    }
  }

  // The tool result never carries full logs or absolute paths either.
  const resultText = JSON.stringify(result.evidence)
  assert.equal(resultText.includes('file:///'), false)
  assert.equal(resultText.includes('boom'), false)
})

test('runReviewRound default profile is code and report mode synthesizes evidence cards', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const fakeSubagents = makeFakeSubagents((spec) => (
    spec.label.startsWith('judge')
      ? completedActivation(makeScore(), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(result.ok, true, result.error)
  assert.equal(result.profile, 'code')
  assert.equal(result.evidence.cardCount, 4)
  assert.equal(result.evidence.cards.every((card) => card.kind === 'screenshot'), true)
  const reloaded = createStore({ stateDir: config.stateDir })
  await reloaded.init()
  assert.equal(reloaded.state.cycles[0].rounds[0].evidence.length, 4)
  assert.equal(reloaded.state.cycles[0].rounds[0].profile, 'code')
})

test('runReviewRound fails the round when an interaction card fails (stage screenshots)', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  await writeFile(path.join(target, 'index.html'), '<h1>game</h1>')
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const renderer = makeEvidenceRenderShots()
  let subagentCalls = 0
  const fakeSubagents = makeFakeSubagents(() => {
    subagentCalls += 1
    return completedActivation(makeAttack(), 'child')
  })
  const failingInteraction = async () => ({ ok: false, error: 'click 步骤失败：找不到元素（selector「#missing」）', artifacts: [], meta: {} })
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    args: { target, evidence: makeEvidenceCards() },
    subagents: fakeSubagents.service,
    renderShots: renderer.fn,
    runInteractionCard: failingInteraction,
  }))
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'screenshots')
  assert.match(result.error, /#missing/)
  assert.equal(subagentCalls, 0)
  const failedRound = store.state.cycles[0].rounds[0]
  assert.equal(failedRound.status, 'failed')
  assert.equal(failedRound.evidence.length, 1)
})

test('each round cleans only its own stale artifacts and keeps other rounds', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  await writeFile(path.join(target, 'index.html'), '<h1>demo</h1>')
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const fakeSubagents = makeFakeSubagents((spec) => (
    spec.label.startsWith('judge')
      ? completedActivation(makeScore({ mustFix: ['继续修'], nextAction: 'fix_and_review' }), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))
  const first = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(first.ok, true, first.error)
  const shotDir = path.join(config.stateDir, 'shots', store.state.cycles[0].id)
  // Simulate a stale partial render left behind by a crashed round-2 attempt.
  await writeFile(path.join(shotDir, 'r2-s9-stale.png'), 'stale')
  const second = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(second.ok, true, second.error)
  assert.equal(second.round, 2)
  const files = await readFileDir(shotDir)
  assert.equal(files.includes('r2-s9-stale.png'), false, 'same-round stale artifact must be cleaned')
  assert.equal(files.filter((file) => file.startsWith('r1-')).length, 4, 'other rounds keep their evidence')
  assert.equal(files.filter((file) => file.startsWith('r2-')).length, 4)
})

/** `readdir` wrapper kept next to the test that uses it (no extra imports at top). */
async function readFileDir(dir) {
  const { readdir } = await import('node:fs/promises')
  return (await readdir(dir)).sort()
}

// ---------------------------------------------------------------------------
// v1.2 Stage C: modeling evidence (image + pdf-text) end-to-end
// ---------------------------------------------------------------------------

/** Minimal uncompressed PDF fixture (catalog + page tree + text content). */
function makeMinimalPdf(pages) {
  const objects = []
  const kids = []
  let next = 3
  for (const content of pages) {
    const pageNumber = next
    const contentNumber = next + 1
    next += 2
    kids.push(`${pageNumber} 0 R`)
    const buffer = Buffer.from(content, 'latin1')
    objects.push(`${pageNumber} 0 obj\n<< /Type /Page /Parent 2 0 R /Contents ${contentNumber} 0 R >>\nendobj\n`)
    objects.push(`${contentNumber} 0 obj\n<< /Length ${buffer.length} >>\nstream\n${buffer.toString('latin1')}\nendstream\nendobj\n`)
  }
  return Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>\nendobj\n${objects.join('')}%%EOF\n`, 'latin1')
}

test('runReviewRound executes a modeling evidence plan (image + pdf-text) with rubric + reproducible hint', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'model')
  await mkdir(path.join(target, 'figures'), { recursive: true })
  await writeFile(path.join(target, 'index.html'), '<h1>report</h1>')
  await writeFile(path.join(target, 'figures', 'result.png'), makePngHeader(640, 480, 4096))
  const pdfBytes = makeMinimalPdf([
    'BT (Abstract: claimed accuracy 0.95) Tj ET',
    'BT (Results: accuracy 0.81, seed missing) Tj ET',
  ])
  await writeFile(path.join(target, 'paper.pdf'), pdfBytes)
  const config = baseConfig(path.join(dir, 'state'), { profile: 'modeling' })
  const store = createStore({ stateDir: config.stateDir })
  const renderer = makeEvidenceRenderShots()
  const fakeSubagents = makeFakeSubagents((spec) => (
    String(spec.label).startsWith('judge')
      ? completedActivation(makeScore(), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))

  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    args: {
      target,
      title: '建模演示',
      evidence: [
        { kind: 'screenshot', path: 'index.html', name: 'report', width: 1440, height: 900 },
        { kind: 'image', path: 'figures/result.png', name: 'result-chart' },
        { kind: 'pdf-text', path: 'paper.pdf', page: 2, name: 'paper-p2' },
        { kind: 'screenshot', path: 'index.html', name: 'appendix', width: 1280, height: 800 },
      ],
    },
    subagents: fakeSubagents.service,
    renderShots: renderer.fn,
  }))
  assert.equal(result.ok, true, result.error)
  assert.equal(result.profile, 'modeling')
  assert.equal(result.shots.length, 4)
  assert.deepEqual(result.shots.map((shot) => shot.file), [
    'r1-s1-report.png',
    'r1-s2-result-chart.png',
    'r1-s3-paper-p2.png',
    'r1-s4-appendix.png',
  ])
  assert.equal(result.evidence.cardCount, 4)
  assert.deepEqual(result.evidence.cards.map((card) => card.kind), ['screenshot', 'image', 'pdf-text', 'screenshot'])
  // image 1 + pdf (PNG + text) 2 + screenshots 2 = 5 artifacts.
  assert.equal(result.evidence.artifactCount, 5)
  assert.equal(result.evidence.cards[1].artifactCount, 1)
  assert.equal(result.evidence.cards[2].artifactCount, 2)

  // Prompt: modeling rubric (trusted) + pdf/image manifest (fenced) + run-metrics hint.
  const attackerPrompt = fakeSubagents.calls[0].request.prompt[0].text
  assert.ok(attackerPrompt.includes('建模领域 rubric'))
  assert.ok(attackerPrompt.includes('数据质量与数据泄漏'))
  assert.ok(attackerPrompt.includes('run-metrics'))
  assert.ok(attackerPrompt.includes('modeling-run.json'))
  const evidenceFence = attackerPrompt.slice(attackerPrompt.indexOf('<UNTRUSTED_EVIDENCE>'), attackerPrompt.lastIndexOf('</UNTRUSTED_EVIDENCE>'))
  assert.ok(evidenceFence.includes('[image]'))
  assert.ok(evidenceFence.includes('[pdf-text]'))
  assert.ok(evidenceFence.includes('PDF 页：2/2'))
  const judgePrompt = fakeSubagents.calls[1].request.prompt[0].text
  assert.ok(judgePrompt.includes('数据质量与数据泄漏'))
  assert.ok(judgePrompt.includes('复现/指标类结论只采信 Host manifest'))

  // Persisted evidence keeps extraction provenance; public state drops paths/logs.
  const reloaded = createStore({ stateDir: config.stateDir })
  await reloaded.init()
  const round = reloaded.state.cycles[0].rounds[0]
  assert.equal(round.profile, 'modeling')
  assert.equal(round.evidence.length, 4)
  assert.equal(round.evidence[2].kind, 'pdf-text')
  assert.equal(round.evidence[2].meta.pageCount, 2)
  assert.equal(round.evidence[2].meta.page, 2)
  assert.equal(round.evidence[2].meta.pdfSha256, sha256Buffer(pdfBytes))
  assert.equal(round.evidence[2].artifacts.length, 2)
  assert.equal(round.evidence[2].artifacts[1].mime, 'text/plain')
  const publicState = toPublicState(reloaded.state, { generatedAt: 1 })
  const publicEvidence = publicState.cycles[0].rounds[0].evidence
  assert.equal(publicEvidence.length, 4)
  assert.equal(publicEvidence[2].kind, 'pdf-text')
  assert.equal(JSON.stringify(publicEvidence).includes('file:///'), false)
  // Target was not written by evidence rendering.
  assert.deepEqual((await readFileDir(target)).sort(), ['figures', 'index.html', 'paper.pdf'])
})

// ---------------------------------------------------------------------------
// v1.3 3.1: automatic noise control in the round pipeline
// ---------------------------------------------------------------------------

test('runReviewRound dedupes findings/mustFix before aggregation and gate, and records round.noise', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'), { requiredFindings: 3 })
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const duplicateAttack = makeAttack({
    findings: [
      { severity: 'MAJOR', title: 'Broken start button', evidence: 'app.js:42', attack: 'click', impact: 'cannot start', fix: 'bind', confidence: 'high', verified: true },
      { severity: 'MAJOR', title: 'Broken  start-button!', evidence: 'app.js:42 duplicate', attack: 'click', impact: 'cannot start', fix: 'bind', confidence: 'high', verified: true },
      { severity: 'MINOR', title: 'Missing alt text', evidence: 'index.html:10', attack: 'screen reader', impact: 'a11y', fix: 'alt', confidence: 'high', verified: true },
      { severity: 'MINOR', title: 'Console warning', evidence: 'app.js:99', attack: 'open console', impact: 'noise', fix: 'clean', confidence: 'medium', verified: true },
    ],
  })
  const duplicateScore = makeScore({
    score: 95,
    validFindings: [
      { title: 'Broken start button', severity: 'MINOR', supported: true, note: 'app.js:42' },
      { title: 'broken  start button!', severity: 'MINOR', supported: true, note: 'app.js:42 duplicated' },
      { title: 'Missing alt text', severity: 'MINOR', supported: true, note: 'index.html:10' },
      { title: 'Console warning', severity: 'MINOR', supported: true, note: 'app.js:99' },
    ],
    mustFix: ['Fix the start button', 'fix  the START button!!'],
  })
  const fakeSubagents = makeFakeSubagents((spec) => (
    String(spec.label).startsWith('judge')
      ? completedActivation(duplicateScore, 'child-judge')
      : completedActivation(duplicateAttack, 'child-attack')
  ))
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(result.ok, true, result.error)
  const round = store.state.cycles[0].rounds[0]
  // Attacker noise: 4 raw findings, 3 kept, one suppression record.
  assert.equal(round.noise.rawFindings, 4)
  assert.equal(round.noise.dedupedFindings, 3)
  assert.equal(round.noise.suppressed.length, 1)
  assert.equal(round.attack.findings.length, 3)
  // Judge sample is deduped before aggregation: 4 raw -> 3 supported.
  assert.equal(round.score.validFindings.length, 3)
  assert.equal(round.score.supportedCount, 3)
  assert.equal(round.gate.findings, 3)
  // mustFix duplicates are collapsed by key.
  assert.deepEqual(round.score.mustFix, ['Fix the start button'])
  // v2.0: both audit counts use the same deduped count (3, not the raw 4).
  assert.equal(round.judges[0].supportedCount, 3)
  assert.equal(round.judges[0].supportedCount, round.judges[0].findingsCount)
  assert.equal(Number.isInteger(round.judges[0].mustFix.length), true)
  // Compact result exposes the bounded noise summary.
  assert.equal(result.noise.rawFindings, 4)
  assert.equal(result.noise.dedupedFindings, 3)
  assert.equal(result.noise.suppressedCount, 1)
  assert.equal(result.gate.passed, false) // mustFix non-empty blocks 95
})

test('v1.3 regression: blockingFindings-only support still counts toward supported/findings', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'), { requiredFindings: 3, judgeSamples: 2 })
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const attack = makeAttack({
    findings: [
      { severity: 'MAJOR', title: 'Broken start', evidence: 'app.js:10', attack: 'click', impact: 'no start', fix: 'bind', confidence: 'high', verified: true },
      { severity: 'MINOR', title: 'Alt missing', evidence: 'index.html:3', attack: 'sr', impact: 'a11y', fix: 'alt', confidence: 'high', verified: true },
      { severity: 'MINOR', title: 'Console noise', evidence: 'app.js:20', attack: 'open console', impact: 'noise', fix: 'clean', confidence: 'high', verified: true },
    ],
  })
  // Two judge samples disagree on the same MAJOR's supported flag: aggregate
  // validFindings requires BOTH (AND) so it ends supported:false, while
  // blockingFindings blocks on ANY sample (OR). The gate-affecting supported
  // count must still be 1 (union), not 0.
  const scoreSupported = makeScore({
    score: 85,
    verdict: 'HOLD',
    findingsCount: 5,
    validFindings: [
      { title: 'Broken start', severity: 'MAJOR', supported: true, note: 'app.js:10' },
    ],
    mustFix: ['bind start button'],
    nextAction: 'fix_and_review',
  })
  const scoreUnsupported = makeScore({
    score: 85,
    verdict: 'HOLD',
    findingsCount: 5,
    validFindings: [
      { title: 'Broken start', severity: 'MAJOR', supported: false, note: 'not reproducible' },
    ],
    mustFix: ['bind start button'],
    nextAction: 'fix_and_review',
  })
  const subagents = makeFakeSubagents((spec) => {
    if (!String(spec.label).startsWith('judge')) return completedActivation(attack, 'child-attack')
    return completedActivation(String(spec.label).endsWith('-1') ? scoreSupported : scoreUnsupported, 'child-judge')
  })
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: subagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(result.ok, true, result.error)
  const round = store.state.cycles[0].rounds[0]
  assert.equal(round.score.validFindings[0].supported, false)
  assert.equal(round.score.blockingFindings.length, 1)
  assert.equal(round.score.supportedCount, 1)
  assert.equal(round.score.findingsCount, 1)
  assert.equal(round.gate.findings, 1)
  assert.equal(round.gate.passed, false)
})

test('runReviewRound injects the previous round supported findings into attacker and judge prompts', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const failingScore = makeScore({
    score: 85,
    validFindings: [
      { title: 'Broken start button', severity: 'MAJOR', supported: true, note: 'app.js:42' },
      { title: 'Missing alt text', severity: 'MINOR', supported: true, note: 'index.html:10' },
      { title: 'Console warning', severity: 'MINOR', supported: true, note: 'app.js:99' },
    ],
    mustFix: ['修复开始按钮'],
  })
  const fakeSubagents = makeFakeSubagents((spec) => {
    const label = String(spec.label)
    if (label.startsWith('judge')) return completedActivation(failingScore, 'child-judge')
    if (label.endsWith('r2')) {
      return completedActivation(makeAttack({
        findings: [{
          severity: 'MAJOR',
          title: 'Broken start button',
          evidence: 'app.js:42 regression still present',
          attack: 'click',
          impact: 'cannot start',
          fix: 'bind',
          confidence: 'high',
          verified: true,
        }],
      }), 'child-attack')
    }
    return completedActivation(makeAttack(), 'child-attack')
  })
  const first = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(first.ok, true, first.error)
  assert.equal(first.gate.passed, false)
  const second = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(second.ok, true, second.error)
  assert.equal(second.round, 2)
  const attackerPrompt = fakeSubagents.calls.at(-2).request.prompt[0].text
  const judgePrompt = fakeSubagents.calls.at(-1).request.prompt[0].text
  assert.ok(attackerPrompt.includes('上轮已报告问题'))
  assert.ok(attackerPrompt.includes('Broken start button'))
  assert.ok(attackerPrompt.includes('app.js:42'))
  assert.ok(judgePrompt.includes('上轮已报告问题'))
  // Host data stays inside an untrusted fence.
  assert.equal(attackerPrompt.includes('</UNTRUSTED_CONTEXT><UNTRUSTED_CONTEXT>'), false)
  assert.ok(attackerPrompt.includes('<UNTRUSTED_CONTEXT>'))
  // knownRepeats counts the overlapping attacker finding (Broken start button).
  const round2 = store.state.cycles[0].rounds[1]
  assert.equal(round2.noise.knownRepeats >= 1, true)
})

// ---------------------------------------------------------------------------
// v1.3 3.2: reopen / incremental lifecycle
// ---------------------------------------------------------------------------

function passRoundSubagents() {
  return makeFakeSubagents((spec) => (
    String(spec.label).startsWith('judge')
      ? completedActivation(makeScore({ score: 95 }), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))
}

test('mode reopen creates a new cycle only after a passed cycle and resets the round cap', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const passing = passRoundSubagents()
  const first = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: passing.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(first.gate.passed, true)
  const passedCycleId = store.state.cycles[0].id

  // fresh on a passed target is still rejected, now with a reopen hint.
  const freshAgain = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: passing.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(freshAgain.ok, false)
  assert.equal(freshAgain.stage, 'cycle-passed')
  assert.match(freshAgain.error, /reopen/)
  assert.match(freshAgain.error, /incremental/)

  // reopen: new cycle, audit fields, and the old cycle is untouched.
  const failing = makeFakeSubagents((spec) => (
    String(spec.label).startsWith('judge')
      ? completedActivation(makeScore({ score: 85, mustFix: ['继续修'] }), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))
  const reopened = await runReviewRound(baseRoundOptions(config, store, target, {
    args: { target, mode: 'reopen', title: '复开评审' },
    subagents: failing.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(reopened.ok, true, reopened.error)
  assert.equal(reopened.mode, 'reopen')
  assert.equal(reopened.reopen.reopenedFrom, passedCycleId)
  assert.equal(reopened.reopen.reopenCount, 1)
  assert.notEqual(reopened.cycleId, passedCycleId)
  assert.equal(store.state.cycles.length, 2)
  const newCycle = store.state.cycles[1]
  assert.equal(newCycle.reopenedFrom, passedCycleId)
  assert.equal(newCycle.reopenCount, 1)
  assert.equal(newCycle.rounds.length, 1)
  assert.equal(newCycle.target, store.state.cycles[0].target)
  assert.equal(store.state.cycles[0].status, 'passed')
  assert.equal(store.state.cycles[0].rounds.length, 1)

  // reopen without any passed cycle is an argument error.
  const otherTarget = path.join(dir, 'other')
  await mkdir(otherTarget)
  const noBase = await runReviewRound(baseRoundOptions(config, store, otherTarget, {
    args: { target: otherTarget, mode: 'reopen' },
    subagents: passing.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(noBase.ok, false)
  assert.equal(noBase.stage, 'arguments')
  assert.match(noBase.error, /已通过/)
})

test('mode incremental diffs the passed baseline snapshot and focuses the prompt, writing filesFile lists', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  await writeFile(path.join(target, 'index.html'), '<h1>v1</h1>')
  await writeFile(path.join(target, 'keep.js'), 'export const keep = 1\n')
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const passing = passRoundSubagents()
  const baseline = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: passing.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(baseline.gate.passed, true)
  const baseCycle = store.state.cycles[0]
  const baseFilesFile = baseCycle.rounds[0].snapshot.filesFile
  assert.match(baseFilesFile, /^snapshots\/.+\/r1\.json$/)
  const baseSnapshotPath = path.join(config.stateDir, ...baseFilesFile.split('/'))
  const baseFileList = JSON.parse(await readFile(baseSnapshotPath, 'utf8'))
  assert.equal(baseFileList.files.some((file) => file.path === 'index.html'), true)
  const baseFiles = await readSnapshotFileList({ stateDir: config.stateDir, filesFile: baseFilesFile })
  assert.equal(Array.isArray(baseFiles), true)

  // Change one file, add one, remove one.
  await writeFile(path.join(target, 'index.html'), '<h1>v2 changed</h1>')
  await writeFile(path.join(target, 'extra.js'), 'export const extra = 2\n')
  await rm(path.join(target, 'keep.js'))
  const failing = makeFakeSubagents((spec) => (
    String(spec.label).startsWith('judge')
      ? completedActivation(makeScore({ score: 85, mustFix: ['继续修'] }), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))
  const incremental = await runReviewRound(baseRoundOptions(config, store, target, {
    args: { target, mode: 'incremental' },
    subagents: failing.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(incremental.ok, true, incremental.error)
  assert.equal(incremental.mode, 'incremental')
  const incrementalRound = store.state.cycles[1].rounds[0]
  assert.equal(incremental.incremental.baseCycleId, baseCycle.id)
  assert.equal(incremental.incremental.baseRound, 1)
  assert.equal(incremental.incremental.changedCount, 1)
  assert.equal(incremental.incremental.addedCount, 1)
  assert.equal(incremental.incremental.removedCount, 1)
  assert.deepEqual(incrementalRound.incremental.changedFiles, ['index.html'])
  assert.deepEqual(incrementalRound.incremental.addedFiles, ['extra.js'])
  assert.deepEqual(incrementalRound.incremental.removedFiles, ['keep.js'])
  assert.equal(incrementalRound.incremental.fullReview, false)
  assert.equal(incrementalRound.incremental.truncated, false)
  assert.equal(incrementalRound.incremental.unchangedCount >= 0, true)
  const newCycle = store.state.cycles[1]
  const round = newCycle.rounds[0]
  assert.equal(round.incremental.baseCycleId, baseCycle.id)
  assert.match(round.snapshot.filesFile, new RegExp(`^snapshots/${newCycle.id}/r1\\.json$`))
  assert.equal((await readdir(path.join(config.stateDir, 'snapshots', newCycle.id))).includes('r1.json'), true)

  const attackerPrompt = failing.calls.find((call) => String(call.label).startsWith('redteam')).request.prompt[0].text
  assert.ok(attackerPrompt.includes('增量评审范围'))
  assert.ok(attackerPrompt.includes('index.html'))
  assert.ok(attackerPrompt.includes('extra.js'))
  assert.ok(attackerPrompt.includes('keep.js'))
  assert.ok(attackerPrompt.includes('回归抽样'))

  // Forced full review still records the diff but sets fullReview + warning.
  const targetB = path.join(dir, 'app-b')
  await mkdir(targetB)
  await writeFile(path.join(targetB, 'index.html'), '<h1>B</h1>')
  const storeB = createStore({ stateDir: path.join(dir, 'state-b') })
  const configB = baseConfig(path.join(dir, 'state-b'))
  const passB = passRoundSubagents()
  await runReviewRound(baseRoundOptions(configB, storeB, targetB, { subagents: passB.service, renderShots: fakeShots.fn }))
  await writeFile(path.join(targetB, 'index.html'), '<h1>B2</h1>')
  const forced = await runReviewRound(baseRoundOptions(configB, storeB, targetB, {
    args: { target: targetB, mode: 'incremental' },
    subagents: passB.service,
    renderShots: fakeShots.fn,
    config: { ...configB, incrementalFullReview: true },
  }))
  assert.equal(forced.ok, true, forced.error)
  assert.equal(forced.incremental.fullReview, true)
  assert.equal(forced.incremental.changedCount, 1)
  assert.ok(forced.warnings.some((warning) => warning.includes('强制全量')))
})

// ---------------------------------------------------------------------------
// v1.3 3.3: cancellation checkpoints + cost records
// ---------------------------------------------------------------------------

test('cancel during evidence aborts with stage cancelled and clears the request', async (t) => {
  __resetCancelRequests()
  t.after(() => __resetCancelRequests())
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  let cancelledCycleId = ''
  const renderShots = async (options) => {
    cancelledCycleId = options.cycleId
    requestCancel(options.cycleId)
    // Still produce evidence; the checkpoint right after rendering aborts.
    const dirPath = path.join(options.stateDir, 'shots', options.cycleId)
    await mkdir(dirPath, { recursive: true })
    const shots = []
    for (let index = 0; index < options.specs.length; index += 1) {
      const spec = options.specs[index]
      const file = `r${options.roundNo}-s${index + 1}-shot-${index + 1}.png`
      const bytes = makePngHeader(spec.width, spec.height)
      await writeFile(path.join(dirPath, file), bytes)
      shots.push({ file, path: path.join(dirPath, file), width: spec.width, height: spec.height, bytes: bytes.length, sha256: sha256Buffer(bytes), page: spec.page, renderedAt: 1 })
    }
    return { ok: true, shots, errors: [], warnings: [] }
  }
  const fakeSubagents = makeFakeSubagents((spec) => (
    String(spec.label).startsWith('judge')
      ? completedActivation(makeScore(), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots,
  }))
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'cancelled')
  assert.equal(result.error, '评审已取消（用户请求）')
  const round = store.state.cycles[0].rounds[0]
  assert.equal(round.status, 'failed')
  assert.equal(round.error, '评审已取消（用户请求）')
  assert.equal(round.progress.stage, 'cancelled')
  assert.equal(getCancelRequest(cancelledCycleId), null)
  // The red team never ran.
  assert.equal(fakeSubagents.calls.length, 0)
})

test('cancel before judging aborts after the attacker stage', async (t) => {
  __resetCancelRequests()
  t.after(() => __resetCancelRequests())
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const fakeSubagents = makeFakeSubagents((spec) => {
    if (String(spec.label).startsWith('judge')) return completedActivation(makeScore(), 'child-judge')
    // The round exists by the time the attacker runs; cancel it now.
    requestCancel(store.state.cycles[0].id)
    return completedActivation(makeAttack(), 'child-attack')
  })
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'cancelled')
  const round = store.state.cycles[0].rounds[0]
  assert.equal(round.status, 'failed')
  assert.notEqual(round.attack, null) // attacker output was persisted before the checkpoint
  assert.equal(round.score, null)
  // Only the attacker was started.
  assert.equal(fakeSubagents.calls.length, 1)
})

test('cancel during the last judge sample aborts before the gate', async (t) => {
  __resetCancelRequests()
  t.after(() => __resetCancelRequests())
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'), { judgeSamples: 2 })
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const fakeSubagents = makeFakeSubagents((spec) => {
    const label = String(spec.label)
    if (!label.startsWith('judge')) return completedActivation(makeAttack(), 'child-attack')
    if (label.endsWith('-2')) requestCancel(store.state.cycles[0].id)
    return completedActivation(makeScore(), 'child-judge')
  })
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: fakeSubagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'cancelled')
  const round = store.state.cycles[0].rounds[0]
  assert.equal(round.status, 'failed')
  assert.notEqual(round.score, null) // the aggregate was computed before the gate checkpoint
  assert.equal(round.gate, null)
  assert.equal(fakeSubagents.calls.length, 3) // attacker + 2 judges
})

test('round.cost records timings, prompt/response sizes, judge samples and artifacts', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const passing = passRoundSubagents()
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: passing.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(result.ok, true, result.error)
  const round = store.state.cycles[0].rounds[0]
  assert.equal(Number.isInteger(round.cost.totalMs), true)
  assert.equal(round.cost.totalMs >= 0, true)
  assert.equal(round.cost.evidenceMs >= 0, true)
  assert.equal(round.cost.attackMs >= 0, true)
  assert.equal(round.cost.judgeMs >= 0, true)
  assert.equal(round.cost.promptChars > 0, true)
  assert.equal(round.cost.judgePromptChars > 0, true)
  assert.equal(round.cost.attackChars > 0, true)
  assert.equal(round.cost.scoreChars > 0, true)
  assert.equal(round.cost.judgeSamples, 1)
  assert.equal(round.cost.artifactCount, 4)
  assert.deepEqual(result.cost, round.cost)
  assert.equal(round.progress.stage, 'done')
})

// ---------------------------------------------------------------------------
// v1.3 3.4: sequential batch review
// ---------------------------------------------------------------------------

test('runReviewBatch validates targets and runs rounds sequentially, continuing after failures', async () => {
  const calls = []
  const runRound = async (options) => {
    calls.push(options)
    if (options.args.target === '/tmp/missing-target') {
      return { ok: false, stage: 'target', error: 'target 目录不可访问' }
    }
    return {
      ok: true,
      cycleId: `c-${options.args.target.length}`,
      round: 1,
      score: { score: options.args.target === '/tmp/bad' ? 60 : 95 },
      gate: { passed: options.args.target !== '/tmp/bad' },
    }
  }
  const baseArgs = {
    targets: ['/tmp/a', '/tmp/bad'],
    claims: ['c1'],
    profile: 'modeling',
    mode: 'reopen',
  }
  const result = await runReviewBatch({ config: { maxBatchTargets: 5 }, args: baseArgs, runRound })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.results.length, 2)
  assert.equal(result.results[0].target, '/tmp/a')
  assert.equal(result.results[0].ok, true)
  assert.equal(result.results[0].gate.passed, true)
  assert.equal(result.results[1].gate.passed, false)
  assert.deepEqual(result.summary, { total: 2, passed: 1, failed: 1 })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].args, { target: '/tmp/a', title: undefined, claims: ['c1'], focus: undefined, outOfScope: undefined, environment: undefined, timeBudget: undefined, profile: 'modeling', mode: 'reopen' })

  // Partial execution failure is captured per target, other targets continue.
  const partialCalls = []
  const partial = await runReviewBatch({
    config: { maxBatchTargets: 5 },
    args: { targets: ['/tmp/a', '/tmp/missing-target', '/tmp/c'] },
    runRound: async (options) => {
      partialCalls.push(options.args.target)
      if (options.args.target === '/tmp/missing-target') return { ok: false, stage: 'target', error: 'missing' }
      return { ok: true, cycleId: 'c', round: 1, score: { score: 95 }, gate: { passed: true } }
    },
  })
  assert.equal(partial.ok, true)
  assert.equal(partialCalls.length, 3)
  assert.equal(partial.results[1].ok, false)
  assert.equal(partial.results[1].error, 'missing')
  assert.deepEqual(partial.summary, { total: 3, passed: 2, failed: 1 })

  // A round implementation that throws is isolated to its target.
  const thrown = await runReviewBatch({
    config: { maxBatchTargets: 5 },
    args: { targets: ['/tmp/a', '/tmp/b'] },
    runRound: async (options) => {
      if (options.args.target === '/tmp/b') throw new Error('boom')
      return { ok: true, cycleId: 'c', round: 1, score: { score: 95 }, gate: { passed: true } }
    },
  })
  assert.equal(thrown.ok, true)
  assert.equal(thrown.results[0].ok, true)
  assert.equal(thrown.results[1].ok, false)
  assert.match(thrown.results[1].error, /boom/)
})

test('runReviewBatch rejects invalid target lists', async () => {
  const never = async () => { throw new Error('must not run') }
  const missing = await runReviewBatch({ config: {}, args: {}, runRound: never })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /targets/)
  const single = await runReviewBatch({ config: {}, args: { targets: ['/tmp/a'] }, runRound: never })
  assert.equal(single.ok, false)
  assert.match(single.error, /至少需要 2 个/)
  const tooMany = await runReviewBatch({
    config: { maxBatchTargets: 3 },
    args: { targets: ['/a', '/b', '/c', '/d'] },
    runRound: never,
  })
  assert.equal(tooMany.ok, false)
  assert.match(tooMany.error, /最多 3 个/)
  const duplicate = await runReviewBatch({ config: {}, args: { targets: ['/tmp/a', '/tmp/a '] }, runRound: never })
  assert.equal(duplicate.ok, false)
  assert.match(duplicate.error, /重复/)
  const badEntry = await runReviewBatch({ config: {}, args: { targets: ['/tmp/a', 42] }, runRound: never })
  assert.equal(badEntry.ok, false)
  assert.match(badEntry.error, /targets\[1\]/)
  const badMode = await runReviewBatch({ config: {}, args: { targets: ['/tmp/a', '/tmp/b'], mode: 'bad' }, runRound: never })
  assert.equal(badMode.ok, false)
  assert.equal(badMode.stage, 'arguments')
})

// ---------------------------------------------------------------------------
// v1.3 3.2: incremental degradation + maxRounds / reopen chain
// ---------------------------------------------------------------------------

test('incremental degrades to a full review when the baseline snapshot file is missing', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  await writeFile(path.join(target, 'index.html'), '<h1>v1</h1>')
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const passing = passRoundSubagents()
  const baseline = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: passing.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(baseline.gate.passed, true)
  const baseCycle = store.state.cycles[0]
  const baseFilesFile = baseCycle.rounds[0].snapshot.filesFile
  await rm(path.join(config.stateDir, ...baseFilesFile.split('/')))
  await writeFile(path.join(target, 'index.html'), '<h1>v2</h1>')
  const failing = makeFakeSubagents((spec) => (
    String(spec.label).startsWith('judge')
      ? completedActivation(makeScore({ score: 85, mustFix: ['继续修'] }), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    args: { target, mode: 'incremental' },
    subagents: failing.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(result.ok, true, result.error)
  const round = store.state.cycles[1].rounds[0]
  assert.equal(round.incremental.fullReview, true)
  assert.deepEqual(round.incremental.changedFiles, [])
  assert.equal(round.incremental.unchangedCount, 0)
  assert.ok(result.warnings.some((warning) => warning.includes('基线快照文件清单不可用')))
})

test('incremental caps changed file lists with a truncated flag', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  for (let index = 0; index < 4; index += 1) await writeFile(path.join(target, `file-${index}.js`), `export const v${index} = 1\n`)
  const config = baseConfig(path.join(dir, 'state'), { incrementalMaxChangedFiles: 2 })
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const passing = passRoundSubagents()
  await runReviewRound(baseRoundOptions(config, store, target, { subagents: passing.service, renderShots: fakeShots.fn }))
  for (let index = 0; index < 4; index += 1) await writeFile(path.join(target, `file-${index}.js`), `export const v${index} = 2\n`)
  const failing = makeFakeSubagents((spec) => (
    String(spec.label).startsWith('judge')
      ? completedActivation(makeScore({ score: 85, mustFix: ['继续修'] }), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    args: { target, mode: 'incremental' },
    subagents: failing.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(result.ok, true, result.error)
  const round = store.state.cycles[1].rounds[0]
  assert.equal(round.incremental.truncated, true)
  assert.equal(round.incremental.changedFiles.length, 2)
  assert.ok(result.warnings.some((warning) => warning.includes('incrementalMaxChangedFiles=2')))
})

test('maxRounds applies per cycle; reopen resets the cap and chains from the last passed cycle', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'), { maxRounds: 1 })
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const passing = passRoundSubagents()
  const first = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: passing.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(first.gate.passed, true)
  const passedCycleId = store.state.cycles[0].id
  const failing = makeFakeSubagents((spec) => (
    String(spec.label).startsWith('judge')
      ? completedActivation(makeScore({ score: 85, mustFix: ['继续修'] }), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))
  const reopened = await runReviewRound(baseRoundOptions(config, store, target, {
    args: { target, mode: 'reopen' },
    subagents: failing.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(reopened.ok, true, reopened.error)
  assert.equal(store.state.cycles.length, 2)
  // round 2 inside the reopened cycle exceeds maxRounds=1.
  const capped = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: failing.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(capped.ok, false)
  assert.equal(capped.stage, 'max-rounds')
  assert.match(capped.error, /mode:"reopen"/)
  // Another reopen is allowed: it bases on the latest passed cycle and bumps count.
  const reopenedAgain = await runReviewRound(baseRoundOptions(config, store, target, {
    args: { target, mode: 'reopen' },
    subagents: failing.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(reopenedAgain.ok, true, reopenedAgain.error)
  assert.equal(store.state.cycles.length, 3)
  assert.equal(reopenedAgain.reopen.reopenedFrom, passedCycleId)
  assert.equal(reopenedAgain.reopen.reopenCount, 2)
})

test('v2.0: review snapshot receives config.snapshotMaxFileBytes', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'), { snapshotMaxFileBytes: 12345 })
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const subagents = makeFakeSubagents((spec) => (
    String(spec.label).startsWith('judge')
      ? completedActivation(makeScore(), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))
  const options = baseRoundOptions(config, store, target, {
    subagents: subagents.service,
    renderShots: fakeShots.fn,
  })
  let captured = null
  const computeSnapshotImpl = async (root, opts) => {
    captured = opts
    return {
      ok: true,
      schemaVersion: 1,
      targetDir: root,
      createdAt: 1,
      fileCount: 0,
      hashedBytes: 0,
      truncated: false,
      skippedCount: 0,
      files: [],
      manifestHash: 'a'.repeat(64),
    }
  }
  options.computeSnapshot = computeSnapshotImpl
  const result = await runReviewRound(options)
  assert.equal(result.ok, true, result.error)
  assert.equal(captured.limits.maxFileBytes, 12345)
  assert.equal(captured.limits.maxFiles, config.snapshotMaxFiles)
  assert.equal(captured.limits.maxHashBytes, config.snapshotMaxHashBytes)
})

test('v2.0: missing childId fails closed instead of silently skipping registry', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const subagents = makeFakeSubagents(() => completedActivation(makeAttack(), undefined))
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: subagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'attacker')
  assert.match(result.error, /childId/)
  const round = store.state.cycles[0].rounds[0]
  assert.equal(round.status, 'failed')
  assert.equal(round.gate, null)
})

test('v2.0: round snapshot is bound to the configured deliverable root', async (t) => {
  const dir = await tempDir(t)
  const workspace = path.join(dir, 'ws')
  const target = path.join(workspace, 'app')
  await mkdir(target, { recursive: true })
  await writeFile(path.join(target, 'index.html'), '<h1>app</h1>')
  await writeFile(path.join(workspace, 'README.md'), 'workspace readme')
  const config = baseConfig(path.join(dir, 'state'), { deliverableRoots: [workspace] })
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const subagents = makeFakeSubagents((spec) => (
    String(spec.label).startsWith('judge')
      ? completedActivation(makeScore(), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: subagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(result.ok, true, result.error)
  const round = store.state.cycles[0].rounds[0]
  assert.equal(round.snapshot.manifestHash, computeSnapshotSync(workspace).manifestHash)
})

test('v2.0: report re-render failure cannot persist a passed round', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  let calls = 0
  const renderShots = (options) => {
    calls += 1
    if (calls === 2) throw new Error('report render boom')
    return fakeShots.fn(options)
  }
  const subagents = makeFakeSubagents((spec) => (
    String(spec.label).startsWith('judge')
      ? completedActivation(makeScore(), 'child-judge')
      : completedActivation(makeAttack(), 'child-attack')
  ))
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: subagents.service,
    renderShots,
  }))
  assert.equal(result.ok, false)
  const round = store.state.cycles[0].rounds[0]
  assert.equal(round.status, 'failed')
  assert.equal(round.gate, null)
  assert.equal(store.state.cycles[0].status, 'reviewing')
})

test('v2.0: supported count is the intersection of judges plus blocking union', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'), { judgeSamples: 2, requiredFindings: 3 })
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const finding = (title) => ({ title, severity: 'MINOR', supported: true, note: `${title}.js:1` })
  const scoreOne = makeScore({
    score: 95,
    verdict: 'PASS',
    findingsCount: 3,
    validFindings: [finding('A'), finding('B'), finding('C')],
    mustFix: [],
    nextAction: 'stop',
  })
  const scoreTwo = makeScore({
    score: 95,
    verdict: 'PASS',
    findingsCount: 3,
    validFindings: [finding('A'), finding('B'), finding('D')],
    mustFix: [],
    nextAction: 'stop',
  })
  const subagents = makeFakeSubagents((spec) => {
    if (!String(spec.label).startsWith('judge')) return completedActivation(makeAttack(), 'child-attack')
    return completedActivation(String(spec.label).endsWith('-1') ? scoreOne : scoreTwo, 'child-judge')
  })
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: subagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(result.ok, true, result.error)
  const round = store.state.cycles[0].rounds[0]
  // A and B are supported by both judges; C/D only by one => intersection = 2.
  assert.equal(round.score.supportedCount, 2)
  assert.equal(round.score.findingsCount, 2)
  assert.equal(round.gate.findings, 2)
  assert.equal(round.gate.passed, false)
  assert.ok(round.gate.failReasons.some((reason) => reason.includes('有效发现（去重后）')))
})

test('v2.0: a truly clean round (0 supported findings, 100) passes the gate end-to-end', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const config = baseConfig(path.join(dir, 'state'))
  const store = createStore({ stateDir: config.stateDir })
  const fakeShots = makeFakeRenderShots()
  const cleanScore = makeScore({
    score: 100,
    verdict: 'PASS',
    findingsCount: 0,
    validFindings: [],
    blockingFindings: [],
    deductions: [],
    mustFix: [],
    nextAction: 'stop',
  })
  const subagents = makeFakeSubagents((spec) => (
    String(spec.label).startsWith('judge')
      ? completedActivation(cleanScore, 'child-judge')
      : completedActivation(makeAttack({ findings: [] }), 'child-attack')
  ))
  const result = await runReviewRound(baseRoundOptions(config, store, target, {
    subagents: subagents.service,
    renderShots: fakeShots.fn,
  }))
  assert.equal(result.ok, true, result.error)
  assert.equal(result.gate.passed, true)
  assert.equal(result.gate.findings, 0)
  assert.equal(result.nextAction, 'stop')
  const round = store.state.cycles[0].rounds[0]
  assert.equal(round.score.supportedCount, 0)
  assert.equal(store.state.cycles[0].status, 'passed')
})
