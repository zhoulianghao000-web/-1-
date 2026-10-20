import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { LIMITS, STATE_SCHEMA_VERSION } from '../lib/constants.js'
import {
  canonicalStringify,
  computeIntegrityHash,
  createCycle,
  createEmptyState,
  createStore,
  cycleDeliverableRoot,
  findCycleByTarget,
  findCyclesByDeliverableRoot,
  findCyclesForDeliverable,
  findReviewingCycleForSession,
  isPathInsideOrEqual,
  latestPassedRound,
  latestRoundOf,
  listCycles,
  newCycleId,
  newestCycleByDeliverableRoot,
  newestCycleForDeliverable,
  resolveStateDir,
  startRound,
  toPublicState,
  trimState,
  verifyIntegrity,
} from '../lib/store.js'

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rtc-store-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

test('resolveStateDir prefers config.stateDir, then DSH_HOME, then ~/.dsh', () => {
  assert.equal(resolveStateDir({ stateDir: 'C:\\tmp\\rtc-state' }), path.resolve('C:\\tmp\\rtc-state'))
  assert.equal(
    resolveStateDir({ stateDir: '' }, { DSH_HOME: 'C:\\dsh-home' }, 'C:\\Users\\tester'),
    path.resolve('C:\\dsh-home', 'adversarial-review'),
  )
  assert.equal(
    resolveStateDir({}, {}, 'C:\\Users\\tester'),
    path.resolve('C:\\Users\\tester', '.dsh', 'adversarial-review'),
  )
})

test('createStore starts empty when state.json is missing', async (t) => {
  const dir = await tempDir(t)
  const store = createStore({ stateDir: dir })
  const state = await store.init()
  assert.equal(STATE_SCHEMA_VERSION, 3)
  assert.equal(state.schemaVersion, 3)
  assert.equal(createEmptyState(1).schemaVersion, 3)
  assert.deepEqual(state.cycles, [])
  assert.equal(store.isLoaded(), true)
  assert.equal(store.peek(), state)
  await assert.rejects(access(path.join(dir, 'state.json')))
})

test('cycle/round lifecycle persists atomically and reloads', async (t) => {
  const dir = await tempDir(t)
  const store = createStore({ stateDir: dir })
  await store.init()
  const target = path.join(dir, 'demo-project')
  const cycle = await store.mutate((state) => createCycle(state, {
    target,
    title: '演示项目',
    sessionId: 'session-1',
    required: { score: 95, findings: 3, shots: 4 },
    now: 1000,
  }))
  const round = await store.mutate(() => startRound(cycle, { now: 2000 }))
  assert.equal(round.n, 1)
  assert.equal(round.status, 'running')
  // v1.1 audit fields exist from the very first write (additive on schema v2).
  assert.deepEqual(round.judges, [])
  assert.deepEqual(round.judgeSessionIds, [])
  assert.equal(round.judgeRaw, null)
  assert.equal(round.promptHashes, null)
  assert.equal(round.modelRoute, null)
  assert.equal(round.disagreement, null)

  await store.mutate(() => {
    round.status = 'completed'
    round.finishedAt = 3000
    round.attack = { verdict: 'HOLD', summary: 's', findings: [], solid: [], unverified: [] }
    round.score = { score: 75, verdict: 'HOLD', findingsCount: 1, validFindings: [], deductions: [], mustFix: ['fix'], screenshots: { count: 4, quality: 'good', note: '' }, nextAction: 'fix_and_review', rationale: 'r' }
    round.gate = { passed: false, score: 75, requiredScore: 95, findings: 1, requiredFindings: 3, shots: 0, requiredShots: 4, failReasons: ['评分 75 < 要求 95'] }
    round.shots = [{ file: 'r1-s1-home.png', url: 'file:///x', width: 1280, height: 800, bytes: 2048, page: 'index.html', renderedAt: 1 }]
    round.timings = { shotsMs: 12, attackMs: 34, judgeMs: 56 }
  })

  // Written JSON is complete and no tmp file is left behind.
  const names = await readdir(dir)
  assert.deepEqual(names.sort(), ['state.json'])
  const raw = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
  assert.equal(raw.schemaVersion, STATE_SCHEMA_VERSION)
  assert.equal(raw.cycles.length, 1)
  assert.equal(raw.cycles[0].rounds[0].gate.passed, false)

  // Reload from disk through a fresh store.
  const reloaded = createStore({ stateDir: dir })
  await reloaded.init()
  assert.equal(reloaded.state.cycles.length, 1)
  const restored = reloaded.state.cycles[0]
  assert.equal(restored.target, path.resolve(target))
  assert.equal(restored.status, 'reviewing')
  assert.equal(restored.rounds.length, 1)
  assert.equal(restored.rounds[0].status, 'completed')
  assert.equal(restored.rounds[0].shots[0].file, 'r1-s1-home.png')
  assert.equal(restored.rounds[0].gate.score, 75)
  assert.equal(restored.sessionId, 'session-1')
})

test('v2 state loads legacy rounds with audit defaults and keeps new audit records', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  const longRaw = '判官原始输出'.repeat(1000)
  const baseRound = {
    n: 1,
    status: 'completed',
    rubricVersion: 'v2-100',
    startedAt: 10,
    finishedAt: 20,
    error: null,
    shots: [],
    attack: null,
    score: {
      score: 92.5,
      verdict: 'HOLD',
      findingsCount: 3,
      validFindings: [],
      deductions: [],
      mustFix: [],
      screenshots: { count: 4, quality: 'good', note: '' },
      nextAction: 'fix_and_review',
      rationale: '旧轮次',
    },
    gate: { passed: false, score: 92.5, requiredScore: 95, findings: 3, requiredFindings: 3, shots: 4, requiredShots: 4, failReasons: ['评分 92.5 < 要求 95'] },
    attackerSessionId: 'legacy-attack',
    judgeSessionId: 'legacy-judge',
    timings: { shotsMs: 1, attackMs: 2, judgeMs: 3 },
  }
  const auditedRound = {
    ...baseRound,
    n: 2,
    promptHashes: { attacker: 'a'.repeat(64), judge: 'b'.repeat(64) },
    modelRoute: { attacker: { provider: 'alt', model: 'm1' }, judge: null, inherited: false },
    disagreement: { scoreSpread: 7.5, mustFixMismatch: true, verdictMismatch: false, disagree: true },
    judgeRaw: longRaw,
    judges: [{
      index: 0,
      sessionId: 'judge-a',
      score: 92.5,
      rawScore: 92.75,
      verdict: 'HOLD',
      findingsCount: 3,
      supportedCount: 2,
      mustFix: ['修复 A'],
      deductions: [{ points: 5, reason: 'r', fix: 'f' }],
      rationale: '理由',
      rawSnippet: '{"score":92.75}',
      warnings: ['w'],
      modelRoute: { provider: 'alt', model: 'judge-m' },
    }],
    judgeSessionId: 'judge-a',
    judgeSessionIds: ['judge-a'],
  }
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({
    schemaVersion: 2,
    updatedAt: 30,
    cycles: [{
      id: 'c-legacy-audit',
      target,
      title: '旧状态',
      createdAt: 1,
      updatedAt: 30,
      status: 'reviewing',
      sessionId: 's1',
      required: { score: 95, findings: 3, shots: 4 },
      rounds: [baseRound, auditedRound],
    }],
  }), 'utf8')

  const store = createStore({ stateDir: dir })
  await store.init()
  assert.equal(store.state.schemaVersion, 3)
  const [legacy, audited] = store.state.cycles[0].rounds
  // Legacy round: additive audit fields get safe defaults, loading never fails.
  assert.deepEqual(legacy.judges, [])
  assert.equal(legacy.promptHashes, null)
  assert.equal(legacy.modelRoute, null)
  assert.equal(legacy.disagreement, null)
  assert.equal(legacy.judgeRaw, null)
  assert.deepEqual(legacy.judgeSessionIds, ['legacy-judge'])
  assert.equal(legacy.gate.passed, false)
  // New round: every audit record survives a reload (judgeRaw capped at 4KB).
  assert.equal(audited.judges.length, 1)
  assert.deepEqual(audited.judges[0], {
    index: 0,
    sessionId: 'judge-a',
    score: 92.5,
    rawScore: 92.75,
    verdict: 'HOLD',
    findingsCount: 3,
    supportedCount: 2,
    mustFix: ['修复 A'],
    deductions: [{ points: 5, reason: 'r', fix: 'f' }],
    rationale: '理由',
    rawSnippet: '{"score":92.75}',
    warnings: ['w'],
    modelRoute: { provider: 'alt', model: 'judge-m' },
  })
  assert.deepEqual(audited.promptHashes, { attacker: 'a'.repeat(64), judge: 'b'.repeat(64) })
  assert.deepEqual(audited.modelRoute, {
    attacker: { provider: 'alt', model: 'm1' },
    judge: null,
    inherited: false,
  })
  assert.deepEqual(audited.disagreement, {
    scoreSpread: 7.5,
    mustFixMismatch: true,
    verdictMismatch: false,
    disagree: true,
  })
  assert.equal(audited.judgeRaw.length, 4000)
  assert.deepEqual(audited.judgeSessionIds, ['judge-a'])

  // New rounds still start with the same live shape.
  const started = await store.mutate((state) => {
    const cycle = createCycle(state, { target: path.join(dir, 'new-app'), now: 40 })
    return startRound(cycle, { now: 40 })
  })
  assert.equal(started.rubricVersion, 'v2-100')
  assert.deepEqual(started.judges, [])
  assert.equal(started.promptHashes, null)
})

test('corrupt state.json is quarantined and replaced by empty state', async (t) => {
  const dir = await tempDir(t)
  await writeFile(path.join(dir, 'state.json'), '{ this is not json', 'utf8')
  const store = createStore({ stateDir: dir })
  const state = await store.init()
  assert.deepEqual(state.cycles, [])
  assert.ok(store.lastReadError === null)
  const names = await readdir(dir)
  const backup = names.find((name) => name.startsWith('state.json.corrupt-'))
  assert.ok(backup, `expected a quarantine file, got ${names.join(',')}`)
  assert.equal(names.includes('state.json'), false)
  // Quarantined content is preserved, not overwritten.
  const backupText = await readFile(path.join(dir, backup), 'utf8')
  assert.equal(backupText, '{ this is not json')
  // Evidence directory is untouched by recovery.
  await assert.rejects(access(path.join(dir, 'shots')))
  // Store still writes afterwards.
  await store.mutate((current) => createCycle(current, { target: path.join(dir, 'p'), now: 5 }))
  assert.equal(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')).cycles.length, 1)
})

test('state with a foreign schemaVersion is quarantined', async (t) => {
  const dir = await tempDir(t)
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({ schemaVersion: 99, updatedAt: 1, cycles: [] }), 'utf8')
  const store = createStore({ stateDir: dir })
  await store.init()
  assert.deepEqual(store.state.cycles, [])
  const names = await readdir(dir)
  assert.ok(names.some((name) => name.startsWith('state.json.corrupt-')))
})

test('schemaVersion 1 state is migrated to v2 (scores ×10, pass line 95, R5 stays passed)', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'demo-tarot-app')
  const v1Round = (n, score, passed) => ({
    n,
    status: 'completed',
    startedAt: 1000 + n,
    finishedAt: 2000 + n,
    error: null,
    shots: Array.from({ length: 4 }, (_unused, index) => ({
      file: `r${n}-s${index + 1}-shot.png`,
      url: 'file:///x',
      width: 1280,
      height: 800,
      bytes: 2048,
      page: 'index.html',
      renderedAt: 1,
    })),
    attack: { verdict: passed ? 'PASS' : 'HOLD', summary: `第 ${n} 轮`, findings: [], solid: [], unverified: [] },
    score: {
      score,
      verdict: passed ? 'PASS' : 'HOLD',
      findingsCount: 4,
      validFindings: [
        { title: 'F1', severity: 'MINOR', supported: true, note: '' },
        { title: 'F2', severity: 'MINOR', supported: true, note: '' },
        { title: 'F3', severity: 'MINOR', supported: true, note: '' },
        { title: 'F4', severity: 'MINOR', supported: true, note: '' },
      ],
      deductions: [{ points: 0.5, reason: '小问题', fix: '修复' }],
      mustFix: passed ? [] : ['修复问题'],
      screenshots: { count: 4, quality: 'good', note: '' },
      nextAction: passed ? 'stop' : 'fix_and_review',
      rationale: `第 ${n} 轮`,
    },
    gate: {
      passed,
      score,
      requiredScore: 9,
      findings: 4,
      requiredFindings: 3,
      shots: 4,
      requiredShots: 4,
      failReasons: passed ? [] : [`评分 ${score} < 要求 9`],
    },
    attackerSessionId: 'session-attacker',
    judgeSessionId: 'session-judge',
    timings: { shotsMs: 1, attackMs: 2, judgeMs: 3 },
  })
  const v1State = {
    schemaVersion: 1,
    updatedAt: 5000,
    cycles: [{
      id: 'c-migrate-1',
      target,
      title: '演示塔罗',
      createdAt: 1000,
      updatedAt: 5000,
      status: 'passed',
      sessionId: 'session-1',
      required: { score: 9, findings: 3, shots: 4 },
      // R1 6.0, R2–R4 8.5, R5 9.5: only the last round passed under the old gate.
      rounds: [v1Round(1, 6, false), v1Round(2, 8.5, false), v1Round(3, 8.5, false), v1Round(4, 8.5, false), v1Round(5, 9.5, true)],
    }],
  }
  await writeFile(path.join(dir, 'state.json'), JSON.stringify(v1State), 'utf8')

  const store = createStore({ stateDir: dir })
  await store.init()
  assert.equal(store.state.schemaVersion, 3)
  assert.equal(store.state.cycles.length, 1)
  const cycle = store.state.cycles[0]
  assert.equal(cycle.required.score, 95)
  assert.equal(cycle.status, 'passed')
  assert.equal(cycle.rounds.length, 5)
  assert.deepEqual(cycle.rounds.map((round) => round.score.score), [60, 85, 85, 85, 95])
  assert.deepEqual(cycle.rounds.map((round) => round.gate.score), [60, 85, 85, 85, 95])
  assert.deepEqual(cycle.rounds.map((round) => round.gate.requiredScore), [95, 95, 95, 95, 95])
  assert.deepEqual(cycle.rounds.map((round) => round.score.deductions[0].points), [5, 5, 5, 5, 5])
  assert.deepEqual(cycle.rounds.map((round) => round.rubricVersion), [
    'legacy-10', 'legacy-10', 'legacy-10', 'legacy-10', 'legacy-10',
  ])
  assert.deepEqual(cycle.rounds.map((round) => round.gate.passed), [false, false, false, false, true])
  assert.deepEqual(cycle.rounds[4].gate.failReasons, [])
  assert.ok(cycle.rounds[0].gate.failReasons.some((reason) => reason.includes('评分 60 < 要求 95')))
  assert.ok(cycle.rounds[3].gate.failReasons.some((reason) => reason.includes('评分 85 < 要求 95')))

  // Migration is persisted immediately as v2 so the demo history survives reloads.
  const persisted = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
  assert.equal(persisted.schemaVersion, 3)
  assert.equal(persisted.cycles[0].required.score, 95)
  assert.equal(persisted.cycles[0].rounds[4].score.score, 95)
  assert.equal(persisted.cycles[0].rounds[0].rubricVersion, 'legacy-10')
  const reloaded = createStore({ stateDir: dir })
  await reloaded.init()
  assert.equal(reloaded.state.cycles[0].rounds[4].gate.passed, true)
  assert.equal(reloaded.state.cycles[0].status, 'passed')

  // New rounds are stamped with the v2-100 rubric and the 95 pass line.
  const created = await store.mutate((state) => {
    const freshCycle = createCycle(state, { target: path.join(dir, 'new-app'), now: 6000 })
    return { cycle: freshCycle, round: startRound(freshCycle, { now: 6000 }) }
  })
  assert.equal(created.cycle.required.score, 95)
  assert.equal(created.round.rubricVersion, 'v2-100')
})

test('find helpers locate cycles by target and reviewing session', async (t) => {
  const dir = await tempDir(t)
  const store = createStore({ stateDir: dir })
  await store.init()
  const target = path.join(dir, 'app')
  const now = Date.now()
  await store.mutate((state) => {
    const first = createCycle(state, { target, sessionId: 's1', now: now - 10 })
    startRound(first, { now: now - 10 })
    first.rounds[0].status = 'failed'
    const second = createCycle(state, { target, sessionId: 's2', now: now - 5 })
    const round = startRound(second, { now: now - 5 })
    round.status = 'completed'
    round.gate = { passed: false, failReasons: ['x'] }
  })
  const latest = findCycleByTarget(store.state, target)
  assert.ok(latest)
  assert.equal(latest.sessionId, 's2')
  assert.equal(findReviewingCycleForSession(store.state, 's2'), latest)
  assert.equal(findReviewingCycleForSession(store.state, 'missing'), null)
  assert.equal(latestRoundOf(latest).n, 1)
  assert.equal(findCycleByTarget(store.state, path.join(dir, 'nope')), null)
})

test('trimState enforces cycle and round caps without breaking ordering', () => {
  const state = createEmptyState(0)
  for (let index = 0; index < 5; index += 1) {
    const cycle = createCycle(state, { target: `C:\\p${index}`, now: index + 1 })
    for (let roundIndex = 0; roundIndex < 4; roundIndex += 1) {
      startRound(cycle, { now: index * 10 + roundIndex })
    }
  }
  trimState(state, { maxCycles: 3, maxRoundsPerCycle: 2 })
  assert.equal(state.cycles.length, 3)
  // Oldest cycles are dropped; newest remain.
  assert.deepEqual(state.cycles.map((cycle) => path.basename(cycle.target)).sort(), ['p2', 'p3', 'p4'])
  for (const cycle of state.cycles) {
    assert.equal(cycle.rounds.length, 2)
    assert.deepEqual(cycle.rounds.map((round) => round.n), [3, 4])
  }
})

test('default caps match the shared LIMITS', async (t) => {
  const dir = await tempDir(t)
  const store = createStore({ stateDir: dir })
  await store.init()
  const now = Date.now()
  await store.mutate((state) => {
    for (let index = 0; index < LIMITS.maxCycles + 5; index += 1) {
      createCycle(state, { target: path.join(dir, `p-${index}`), now: now + index })
    }
  })
  assert.equal(store.state.cycles.length, LIMITS.maxCycles)
})

test('concurrent mutations are serialized and all survive a reload', async (t) => {
  const dir = await tempDir(t)
  const store = createStore({ stateDir: dir })
  await store.init()
  await Promise.all(Array.from({ length: 20 }, (_unused, index) => store.mutate((state) => createCycle(state, {
    target: path.join(dir, `concurrent-${index}`),
    now: 1000 + index,
  }))))
  assert.equal(store.state.cycles.length, 20)
  const reloaded = createStore({ stateDir: dir })
  await reloaded.init()
  assert.equal(reloaded.state.cycles.length, 20)
  const names = await readdir(dir)
  assert.equal(names.filter((name) => name.includes('.tmp-')).length, 0)
})

test('newCycleId is unique and URL/query safe', () => {
  const ids = new Set()
  for (let index = 0; index < 50; index += 1) ids.add(newCycleId(1700000000000 + index, () => index / 100))
  assert.equal(ids.size, 50)
  for (const id of ids) assert.match(id, /^c-[a-z0-9]+-[a-z0-9]+$/)
})

test('toPublicState sorts cycles by updatedAt desc and hides absolute paths', async (t) => {
  const dir = await tempDir(t)
  const store = createStore({ stateDir: dir })
  await store.init()
  await store.mutate((state) => {
    const older = createCycle(state, { target: path.join(dir, 'older'), now: 100 })
    older.updatedAt = 100
    const round = startRound(older, { now: 100 })
    round.status = 'completed'
    round.shots = [{ file: 'r1-s1-a.png', url: 'file:///C:/secret/state/shots/c-1/r1-s1-a.png', width: 1, height: 1, bytes: 2, page: 'C:\\secret\\state\\shots\\c-1\\index.html', renderedAt: 1 }]
    const newer = createCycle(state, { target: path.join(dir, 'newer'), now: 200 })
    newer.updatedAt = 200
  })
  const publicState = toPublicState(store.state, { generatedAt: 123 })
  assert.equal(publicState.ok, true)
  assert.equal(publicState.version, 1)
  assert.equal(publicState.generatedAt, 123)
  assert.equal(publicState.cycles.length, 2)
  assert.equal(publicState.cycles[0].target, path.resolve(path.join(dir, 'newer')))
  const shot = publicState.cycles[1].rounds[0].shots[0]
  // v1.1 1.4: the panel gets file metadata only — no evidence URL / absolute path.
  // v1.3: sha256 is a content hash (safe) for artifact integrity display.
  assert.deepEqual(Object.keys(shot).sort(), ['bytes', 'file', 'height', 'page', 'renderedAt', 'sha256', 'width'])
  assert.equal(JSON.stringify(publicState).includes('secret'), false)
  assert.equal(shot.page, 'index.html')
  assert.equal(shot.url, undefined)
  assert.equal(shot.sha256, null)
  assert.equal(publicState.cycles[1].rounds[0].attackerSessionId, null)
  assert.equal(publicState.cycles[1].sessionId, undefined)
})

test('mutate returns the mutation result and keeps in-memory state', async (t) => {
  const dir = await tempDir(t)
  const store = createStore({ stateDir: dir })
  const value = await store.mutate((state) => {
    assert.equal(state.cycles.length, 0)
    const cycle = createCycle(state, { target: path.join(dir, 'x'), now: 1 })
    return cycle.id
  })
  assert.match(value, /^c-/)
  assert.equal(store.state.cycles.length, 1)
})

// ---------------------------------------------------------------------------
// v1.1 1.4: state integrity hash chain
// ---------------------------------------------------------------------------

test('canonicalStringify sorts object keys and keeps array order', () => {
  assert.equal(canonicalStringify({ b: 1, a: [2, 1] }), '{"a":[2,1],"b":1}')
  assert.equal(canonicalStringify({ a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4}}')
  assert.equal(canonicalStringify([{ y: 1, x: 2 }]), '[{"x":2,"y":1}]')
  assert.equal(canonicalStringify(undefined), 'null')
})

test('state.json is sealed with sha256 and survives a reload', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const store = createStore({ stateDir: dir })
  await store.init()
  await store.mutate((state) => {
    const cycle = createCycle(state, { target, now: 10 })
    startRound(cycle, { now: 20 })
  })
  assert.equal(store.integrityVerified, true)
  assert.equal(store.lastIntegrityError, null)
  const raw = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
  assert.equal(raw.integrity.algorithm, 'sha256')
  assert.match(raw.integrity.hash, /^[0-9a-f]{64}$/)
  assert.equal(raw.integrity.previousHash, null)
  assert.equal(raw.integrity.updatedAt, raw.updatedAt)
  // The seal covers exactly {schemaVersion, updatedAt, cycles}.
  assert.equal(computeIntegrityHash(raw), raw.integrity.hash)
  assert.equal(verifyIntegrity(raw).status, 'ok')

  const reloaded = createStore({ stateDir: dir })
  await reloaded.init()
  assert.equal(reloaded.integrityVerified, true)
  assert.equal(reloaded.state.cycles.length, 1)
  assert.equal(reloaded.lastIntegrityHash, raw.integrity.hash)
  assert.deepEqual(reloaded.integrity(), { verified: true, hash: raw.integrity.hash, error: null })
})

test('tampered state content is detected, quarantined and never trusted', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const store = createStore({ stateDir: dir })
  await store.init()
  await store.mutate((state) => createCycle(state, { target, title: '原始标题', now: 10 }))
  const raw = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
  raw.cycles[0].title = '被篡改的标题'
  raw.cycles[0].status = 'passed'
  await writeFile(path.join(dir, 'state.json'), JSON.stringify(raw), 'utf8')

  const tampered = createStore({ stateDir: dir })
  await tampered.init()
  assert.deepEqual(tampered.state.cycles, [])
  assert.equal(tampered.integrityVerified, false)
  assert.ok(tampered.lastIntegrityError instanceof Error)
  assert.match(tampered.lastIntegrityError.message, /完整性校验失败/)
  const names = await readdir(dir)
  assert.ok(names.some((name) => name.startsWith('state.json.corrupt-')), `expected quarantine, got ${names.join(',')}`)
  assert.equal(names.includes('state.json'), false)
  // The tampered content is preserved in the quarantine backup.
  const backup = names.find((name) => name.startsWith('state.json.corrupt-'))
  assert.ok((await readFile(path.join(dir, backup), 'utf8')).includes('被篡改的标题'))
  // The store recovers: a new write produces a fresh, valid seal.
  await tampered.mutate((state) => createCycle(state, { target: path.join(dir, 'b'), now: 40 }))
  const recovered = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
  assert.equal(verifyIntegrity(recovered).status, 'ok')
  assert.equal(recovered.integrity.previousHash, null)
})

test('integrity chain: each write references the previous seal', async (t) => {
  const dir = await tempDir(t)
  const store = createStore({ stateDir: dir })
  await store.init()
  await store.mutate((state) => createCycle(state, { target: path.join(dir, 'a'), now: 1 }))
  const first = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
  assert.equal(first.integrity.previousHash, null)

  await store.mutate((state) => createCycle(state, { target: path.join(dir, 'b'), now: 2 }))
  const second = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
  assert.equal(second.integrity.previousHash, first.integrity.hash)
  assert.notEqual(second.integrity.hash, first.integrity.hash)
  assert.equal(verifyIntegrity(second).status, 'ok')

  // A fresh store continues the chain from the last persisted seal.
  const reloaded = createStore({ stateDir: dir })
  await reloaded.init()
  assert.equal(reloaded.lastIntegrityHash, second.integrity.hash)
  await reloaded.mutate((state) => createCycle(state, { target: path.join(dir, 'c'), now: 3 }))
  const third = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
  assert.equal(third.integrity.previousHash, second.integrity.hash)
})

test('legacy v2 state without integrity is accepted and sealed on the next write', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'legacy-app')
  await mkdir(target)
  // A pre-1.4 v2 document: schemaVersion 2, no integrity record.
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({
    schemaVersion: 2,
    updatedAt: 500,
    cycles: [{
      id: 'c-legacy',
      target,
      title: '旧数据',
      createdAt: 1,
      updatedAt: 500,
      status: 'reviewing',
      sessionId: 's1',
      required: { score: 95, findings: 3, shots: 4 },
      rounds: [],
    }],
  }), 'utf8')

  const store = createStore({ stateDir: dir })
  await store.init()
  assert.equal(store.state.cycles.length, 1)
  // v1.3: loading a v2 document migrates it to v3 and re-seals it immediately.
  assert.equal(store.state.schemaVersion, 3)
  assert.equal(store.integrityVerified, true)
  assert.match(store.lastIntegrityHash, /^[0-9a-f]{64}$/)
  assert.equal(store.lastIntegrityError, null)
  // Old cycles bind their deliverable root to their own target.
  assert.equal(store.state.cycles[0].deliverableRoot, path.resolve(target))
  assert.equal(store.state.cycles[0].reopenCount, 0)
  assert.equal(store.state.cycles[0].reopenedFrom, null)
  // The pre-v3 file is backed up before the migrated document is written.
  assert.equal(typeof store.lastMigrationBackup, 'string')
  assert.match(path.basename(store.lastMigrationBackup), /^state\.json\.pre-v3-/)
  assert.equal((await readdir(dir)).some((file) => /^state\.json\.pre-v3-/.test(file)), true)

  await store.mutate((state) => createCycle(state, { target: path.join(dir, 'new-app'), now: 600 }))
  const sealed = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
  assert.equal(sealed.integrity.algorithm, 'sha256')
  // The migration persist already extended the integrity chain once.
  assert.match(sealed.integrity.previousHash, /^[0-9a-f]{64}$/)
  assert.equal(verifyIntegrity(sealed).status, 'ok')
  const reloaded = createStore({ stateDir: dir })
  await reloaded.init()
  assert.equal(reloaded.integrityVerified, true)
  assert.equal(reloaded.state.cycles.length, 2)
})

// ---------------------------------------------------------------------------
// v1.1 1.3: deliverable roots + guard helpers
// ---------------------------------------------------------------------------

test('deliverableRoot binds cycles and containment helpers ignore sessions', async (t) => {
  const dir = await tempDir(t)
  const store = createStore({ stateDir: dir })
  await store.init()
  const workspace = path.join(dir, 'workspace')
  const subApp = path.join(workspace, 'app')
  const otherApp = path.join(dir, 'other-app')
  await mkdir(subApp, { recursive: true })
  await mkdir(otherApp, { recursive: true })
  const now = Date.now()
  await store.mutate((state) => {
    const rootBound = createCycle(state, { target: subApp, deliverableRoot: workspace, sessionId: 's1', now })
    const targetBound = createCycle(state, { target: otherApp, title: '另一个', sessionId: 's2', now: now + 1 })
    const round = startRound(rootBound, { now })
    round.status = 'completed'
    round.gate = { passed: true, score: 95, failReasons: [] }
    startRound(targetBound, { now })
  })
  const [rootCycle, targetCycle] = store.state.cycles
  assert.equal(rootCycle.deliverableRoot, path.resolve(workspace))
  assert.equal(targetCycle.deliverableRoot, path.resolve(otherApp))
  assert.equal(cycleDeliverableRoot(rootCycle), path.resolve(workspace))
  assert.deepEqual(listCycles(store.state).map((cycle) => cycle.id), [rootCycle.id, targetCycle.id])

  assert.equal(isPathInsideOrEqual(workspace, subApp), true)
  assert.equal(isPathInsideOrEqual(workspace, path.join(subApp, 'index.html')), true)
  assert.equal(isPathInsideOrEqual(workspace, path.join(dir, 'workspace2')), false)
  assert.deepEqual(findCyclesForDeliverable(store.state, path.join(subApp, 'index.html')).map((cycle) => cycle.id), [rootCycle.id])
  assert.deepEqual(findCyclesForDeliverable(store.state, path.join(otherApp, 'x.txt')).map((cycle) => cycle.id), [targetCycle.id])
  assert.deepEqual(findCyclesForDeliverable(store.state, path.join(dir, 'unrelated.txt')), [])
  assert.equal(findCyclesByDeliverableRoot(store.state, workspace).length, 1)
  assert.equal(findCyclesByDeliverableRoot(store.state, path.join(dir, 'nope')).length, 0)

  // latestPassedRound only returns the latest round when the gate passed.
  assert.equal(latestPassedRound(rootCycle).n, 1)
  assert.equal(latestPassedRound(targetCycle), null)
  assert.equal(latestPassedRound({ rounds: [] }), null)
  assert.equal(latestPassedRound(null), null)
})

test('legacy cycle without deliverableRoot normalizes to its target', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'legacy-target')
  await mkdir(target)
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({
    schemaVersion: 2,
    updatedAt: 1,
    cycles: [{ id: 'c-x', target, title: 'x', createdAt: 1, updatedAt: 1, status: 'reviewing', rounds: [] }],
  }), 'utf8')
  const store = createStore({ stateDir: dir })
  await store.init()
  assert.equal(store.state.cycles[0].deliverableRoot, path.resolve(target))
  assert.equal(findCyclesForDeliverable(store.state, path.join(target, 'a.png')).length, 1)
})

// ---------------------------------------------------------------------------
// v1.2 Stage A: evidence/profile normalization + public projection
// ---------------------------------------------------------------------------

test('normalizeState keeps v1.2 evidence/profile and defaults legacy rounds to null', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'game')
  await mkdir(target)
  const bytes = Buffer.from('png')
  const evidence = [{
    index: 0,
    name: 'start',
    kind: 'screenshot',
    artifacts: [{
      file: 'r1-s1-start.png',
      path: path.join(dir, 'shots', 'c-x', 'r1-s1-start.png'),
      width: 1440,
      height: 900,
      bytes: 2048,
      sha256: 'a'.repeat(64),
      mime: 'image/png',
      kind: 'screenshot',
      stepName: null,
    }],
    meta: {
      url: 'file:///C:/secret/index.html',
      page: 'index.html',
      console: { events: ['error: boom'], errors: 1, truncated: false },
      network: { requests: 2, failures: 1, truncated: false, failureSamples: ['404 GET /a.js'] },
      perf: { metrics: { JSHeapUsedSize: 5 }, fps: 59.5 },
      steps: [{ action: 'click', selector: '#start', ms: 1 }],
    },
  }]
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({
    schemaVersion: 2,
    updatedAt: 1,
    cycles: [{
      id: 'c-x',
      target,
      title: 'x',
      createdAt: 1,
      updatedAt: 1,
      status: 'reviewing',
      rounds: [
        {
          n: 1,
          status: 'completed',
          profile: 'game',
          shots: [],
          evidence,
        },
        { n: 2, status: 'failed', shots: [] },
      ],
    }],
  }), 'utf8')
  const store = createStore({ stateDir: dir })
  await store.init()
  const [roundWithEvidence, legacy] = store.state.cycles[0].rounds
  assert.equal(roundWithEvidence.profile, 'game')
  assert.equal(roundWithEvidence.evidence.length, 1)
  assert.equal(roundWithEvidence.evidence[0].artifacts[0].sha256, 'a'.repeat(64))
  assert.equal(roundWithEvidence.evidence[0].meta.console.errors, 1)
  assert.equal(roundWithEvidence.evidence[0].meta.network.failures, 1)
  assert.equal(roundWithEvidence.evidence[0].meta.perf.fps, 59.5)
  // Legacy rounds (no profile/evidence) load as null, not as empty arrays.
  assert.equal(legacy.profile, null)
  assert.equal(legacy.evidence, null)
  // Malformed evidence is dropped rather than partially trusted.
  assert.equal(store.state.cycles[0].rounds[0].evidence[0].index, 0)
  assert.equal(typeof bytes.length, 'number')
})

test('normalizeState keeps v1.2 image/pdf-text evidence kinds and pdf provenance', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'model')
  await mkdir(target)
  const evidence = [
    {
      index: 0,
      name: 'chart',
      kind: 'image',
      artifacts: [{
        file: 'r1-s1-chart.png',
        path: path.join(dir, 'shots', 'c-m', 'r1-s1-chart.png'),
        width: 640,
        height: 480,
        bytes: 4096,
        sha256: 'b'.repeat(64),
        mime: 'image/png',
        kind: 'image',
      }],
      meta: { url: '', page: 'figures/chart.png' },
    },
    {
      index: 1,
      name: 'paper-page-2',
      kind: 'pdf-text',
      artifacts: [
        {
          file: 'r1-s2-paper.png',
          path: path.join(dir, 'shots', 'c-m', 'r1-s2-paper.png'),
          width: 1200,
          height: 1600,
          bytes: 2048,
          sha256: 'c'.repeat(64),
          mime: 'image/png',
          kind: 'pdf-text',
        },
        {
          file: 'r1-s2-pdf.txt',
          path: path.join(dir, 'shots', 'c-m', 'r1-s2-pdf.txt'),
          width: 0,
          height: 0,
          bytes: 321,
          sha256: 'd'.repeat(64),
          mime: 'text/plain',
          kind: 'text',
        },
      ],
      meta: {
        pageCount: 8,
        page: 2,
        extractedChars: 1234,
        truncated: true,
        pdfSha256: 'e'.repeat(64),
      },
    },
  ]
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({
    schemaVersion: 2,
    updatedAt: 1,
    cycles: [{
      id: 'c-m',
      target,
      title: 'model',
      createdAt: 1,
      updatedAt: 1,
      status: 'reviewing',
      rounds: [{ n: 1, status: 'completed', profile: 'modeling', shots: [], evidence }],
    }],
  }), 'utf8')
  const store = createStore({ stateDir: dir })
  await store.init()
  const round = store.state.cycles[0].rounds[0]
  assert.equal(round.profile, 'modeling')
  assert.equal(round.evidence[0].kind, 'image')
  assert.equal(round.evidence[1].kind, 'pdf-text')
  assert.equal(round.evidence[1].artifacts[1].mime, 'text/plain')
  assert.equal(round.evidence[1].meta.pageCount, 8)
  assert.equal(round.evidence[1].meta.page, 2)
  assert.equal(round.evidence[1].meta.extractedChars, 1234)
  assert.equal(round.evidence[1].meta.truncated, true)
  assert.equal(round.evidence[1].meta.pdfSha256, 'e'.repeat(64))

  const publicState = toPublicState(store.state, { generatedAt: 1 })
  const publicEvidence = publicState.cycles[0].rounds[0].evidence
  assert.deepEqual(publicEvidence.map((card) => card.kind), ['image', 'pdf-text'])
  assert.equal(publicEvidence[1].artifactCount, 2)
  assert.equal(publicEvidence[1].artifacts[1].kind, 'text')
  assert.equal(JSON.stringify(publicEvidence).includes('file:///'), false)
  assert.equal(JSON.stringify(publicEvidence).includes(path.join(dir, 'shots')), false)
  assert.equal('path' in publicEvidence[1].artifacts[1], false)
})

// ---------------------------------------------------------------------------
// v1.3 3.1–3.4: schema v3 fields, bounded projections and newest-cycle helpers
// ---------------------------------------------------------------------------

test('startRound/createCycle default the v1.3 lifecycle fields', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  void t
  const state = createEmptyState(1)
  const fresh = createCycle(state, { target, now: 2 })
  assert.equal(fresh.reopenCount, 0)
  assert.equal(fresh.reopenedFrom, null)
  const freshRound = startRound(fresh, { now: 3 })
  assert.equal(freshRound.mode, 'fresh')
  assert.equal(freshRound.progress, null)
  assert.equal(freshRound.noise, null)
  assert.equal(freshRound.cost, null)
  assert.equal(freshRound.incremental, null)
  const reopened = createCycle(state, { target, now: 4, reopenedFrom: fresh.id, reopenCount: 2 })
  assert.equal(reopened.reopenCount, 2)
  assert.equal(reopened.reopenedFrom, fresh.id)
  const incrementalRound = startRound(reopened, { now: 5, mode: 'incremental' })
  assert.equal(incrementalRound.mode, 'incremental')
  const badModeRound = startRound(reopened, { now: 6, mode: 'hacked' })
  assert.equal(badModeRound.mode, 'fresh')
})

test('normalizeState bounds v3 progress/noise/cost/incremental records and public summaries', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const longPath = `${'x'.repeat(600)}.js`
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({
    schemaVersion: 3,
    updatedAt: 1,
    cycles: [{
      id: 'c-v3',
      target,
      title: 'v3',
      createdAt: 1,
      updatedAt: 2,
      status: 'reviewing',
      sessionId: 's1',
      reopenCount: 3,
      reopenedFrom: 'c-prev',
      required: { score: 95, findings: 3, shots: 4 },
      rounds: [{
        n: 1,
        status: 'completed',
        mode: 'incremental',
        progress: { stage: 'done', updatedAt: 9, detail: 'x'.repeat(900) },
        noise: {
          rawFindings: 7,
          dedupedFindings: 5,
          knownRepeats: 2,
          suppressed: Array.from({ length: 40 }, (_unused, index) => ({ key: `k${index}`, title: 't'.repeat(300), reason: 'r'.repeat(400) })),
        },
        cost: { totalMs: 10, evidenceMs: 1, attackMs: 2, judgeMs: 3, promptChars: 4, judgePromptChars: 5, attackChars: 6, scoreChars: 7, judgeSamples: 2, artifactCount: 5 },
        incremental: {
          mode: 'incremental',
          baseCycleId: 'c-base',
          baseRound: 2,
          baseManifestHash: 'a'.repeat(64),
          currentManifestHash: 'b'.repeat(64),
          changedFiles: ['src/app.js', '../escape.js', '/abs.js', longPath],
          addedFiles: ['new.js'],
          removedFiles: ['dead.js'],
          truncated: true,
          fullReview: false,
          unchangedCount: 12,
        },
        snapshot: {
          manifestHash: 'c'.repeat(64),
          fileCount: 3,
          hashedBytes: 30,
          truncated: false,
          skippedCount: 0,
          createdAt: 2,
          filesFile: 'snapshots/c-v3/r1.json',
        },
        shots: [],
      }, {
        n: 2,
        status: 'running',
        progress: { stage: 'nonsense', updatedAt: 1 },
        snapshot: { manifestHash: 'd'.repeat(64), filesFile: '../escape.json' },
        shots: [],
      }],
    }],
  }), 'utf8')
  const store = createStore({ stateDir: dir })
  await store.init()
  const cycle = store.state.cycles[0]
  assert.equal(cycle.reopenCount, 3)
  assert.equal(cycle.reopenedFrom, 'c-prev')
  const [first, second] = cycle.rounds
  assert.equal(first.mode, 'incremental')
  assert.equal(first.progress.stage, 'done')
  assert.equal(first.progress.detail.length <= 500, true)
  assert.equal(first.noise.suppressed.length, LIMITS.maxNoiseSuppressed)
  assert.equal(first.noise.suppressed[0].title.length <= 200, true)
  assert.equal(first.cost.totalMs, 10)
  assert.equal(first.cost.artifactCount, 5)
  // Escaping/absolute incremental paths are dropped; long paths truncated.
  assert.equal(first.incremental.changedFiles.includes('../escape.js'), false)
  assert.equal(first.incremental.changedFiles.includes('/abs.js'), false)
  assert.equal(first.incremental.changedFiles.includes('src/app.js'), true)
  assert.equal(first.incremental.changedFiles.every((entry) => entry.length <= 500), true)
  assert.equal(first.incremental.truncated, true)
  assert.equal(first.snapshot.filesFile, 'snapshots/c-v3/r1.json')
  // Invalid values normalize to null rather than trusted.
  assert.equal(second.progress, null)
  assert.equal(second.snapshot.filesFile, null)

  const publicState = toPublicState(store.state, { generatedAt: 1 })
  const publicCycle = publicState.cycles[0]
  assert.equal(publicCycle.reopenCount, 3)
  assert.equal(publicCycle.reopenedFrom, 'c-prev')
  const publicRound = publicCycle.rounds[0]
  assert.equal(publicRound.mode, 'incremental')
  assert.equal(publicRound.progress.stage, 'done')
  assert.equal(publicRound.noise.dedupedFindings, 5)
  assert.equal(publicRound.cost.totalMs, 10)
  assert.equal(publicRound.incremental.changedFiles.includes('src/app.js'), true)
  assert.equal(publicRound.incremental.changedFiles.length <= 100, true)
  // No Host filesystem paths or snapshot file references leak in the summaries.
  assert.equal(JSON.stringify(publicRound).includes(dir), false)
  assert.equal(JSON.stringify(publicState).includes('snapshots/'), false)
})

test('newestCycleForDeliverable / newestCycleByDeliverableRoot choose the latest cycle per root', async (t) => {
  const dir = await tempDir(t)
  const workspace = path.join(dir, 'ws')
  const app = path.join(workspace, 'app')
  const other = path.join(dir, 'other')
  await mkdir(app, { recursive: true })
  await mkdir(other, { recursive: true })
  const state = createEmptyState(1)
  const oldPassed = createCycle(state, { target: app, deliverableRoot: workspace, now: 1 })
  oldPassed.updatedAt = 10
  const oldRound = startRound(oldPassed, { now: 2 })
  oldRound.status = 'completed'
  oldRound.gate = { passed: true, score: 95 }
  oldPassed.status = 'passed'
  const newerReviewing = createCycle(state, { target: app, deliverableRoot: workspace, now: 20 })
  newerReviewing.updatedAt = 20
  const newerRound = startRound(newerReviewing, { now: 21 })
  newerRound.status = 'completed'
  newerRound.gate = { passed: false, score: 60 }
  newerReviewing.status = 'reviewing'
  const foreign = createCycle(state, { target: other, deliverableRoot: other, now: 30 })

  assert.equal(newestCycleForDeliverable(state, path.join(app, 'index.html')).id, newerReviewing.id)
  assert.equal(newestCycleByDeliverableRoot(state, workspace).id, newerReviewing.id)
  assert.equal(newestCycleByDeliverableRoot(state, other).id, foreign.id)
  assert.equal(newestCycleForDeliverable(state, path.join(dir, 'unrelated.txt')), null)
  assert.equal(newestCycleByDeliverableRoot(state, path.join(dir, 'nope')), null)
  assert.equal(newestCycleForDeliverable(state, ''), null)
  // Ties on updatedAt fall back to storage order (last wins).
  newerReviewing.updatedAt = 10
  assert.equal(newestCycleByDeliverableRoot(state, workspace).id, newerReviewing.id)
})

// ---------------------------------------------------------------------------
// v2.0 Stage A: per-sample model routes + score statistics persistence
// ---------------------------------------------------------------------------

test('v2.0 normalizes per-sample judge routes and bounded public score statistics', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({
    schemaVersion: STATE_SCHEMA_VERSION,
    updatedAt: 1,
    cycles: [{
      id: 'c-v2',
      target,
      title: 'v2',
      createdAt: 1,
      updatedAt: 2,
      status: 'reviewing',
      sessionId: 's1',
      required: { score: 95, findings: 3, shots: 4 },
      rounds: [{
        n: 1,
        status: 'completed',
        rubricVersion: 'v2-100',
        shots: [],
        modelRoute: {
          attacker: { provider: 'alt', model: 'a1' },
          judge: { provider: 'base', model: 'jbase' },
          inherited: false,
          samples: [
            { provider: 'p1', model: 'm1', model_extra: 'drop' },
            { model: 'm2' },
            null,
            { provider: 'p4' },
          ],
        },
        judges: [{
          index: 0,
          sessionId: 'j1',
          score: 95,
          modelRoute: { provider: 'p1', model: 'm1', nonsense: 'drop' },
        }],
        score: {
          score: 90,
          samples: 2,
          scoreStats: {
            n: 2,
            mean: 92.5,
            median: 92.5,
            stdev: 3.535,
            min: 90,
            max: 95,
            ci95: { low: 90.04, high: 94.96 },
          },
          ci95: { low: 90.04, high: 94.96 },
        },
        gate: { passed: false, score: 90 },
      }],
    }],
  }), 'utf8')
  const store = createStore({ stateDir: dir })
  await store.init()
  const round = store.state.cycles[0].rounds[0]
  assert.deepEqual(round.modelRoute.samples, [
    { provider: 'p1', model: 'm1' },
    { model: 'm2' },
    null,
  ]) // capped at maxJudgeSamples, unknown fields/trailing entry dropped
  assert.deepEqual(round.judges[0].modelRoute, { provider: 'p1', model: 'm1' })
  assert.equal(round.score.scoreStats.mean, 92.5)

  const publicState = toPublicState(store.state, { generatedAt: 1 })
  const publicRound = publicState.cycles[0].rounds[0]
  assert.deepEqual(publicRound.modelRoute.samples, [
    { provider: 'p1', model: 'm1' },
    { model: 'm2' },
    null,
  ])
  assert.deepEqual(publicRound.judges[0].modelRoute, { provider: 'p1', model: 'm1' })
  assert.deepEqual(publicRound.scoreStats, {
    n: 2,
    mean: 92.5,
    median: 92.5,
    stdev: 3.5,
    min: 90,
    max: 95,
    ci95: { low: 90, high: 95 },
  })

  // Legacy rounds keep loading (no samples key, no scoreStats).
  const legacy = {
    id: 'c-old', target, title: 'legacy', createdAt: 1, updatedAt: 1, status: 'reviewing', sessionId: 's',
    required: { score: 95, findings: 3, shots: 4 },
    rounds: [{ n: 1, status: 'completed', shots: [], modelRoute: { attacker: null, judge: null, inherited: true }, score: { score: 60 }, gate: { passed: false } }],
  }
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, updatedAt: 2, cycles: [legacy] }), 'utf8')
  const reloaded = createStore({ stateDir: dir })
  await reloaded.init()
  const legacyRound = reloaded.state.cycles[0].rounds[0]
  assert.equal('samples' in legacyRound.modelRoute, false)
  assert.deepEqual(legacyRound.modelRoute, { attacker: null, judge: null, inherited: true })
  const legacyPublic = toPublicState(reloaded.state).cycles[0].rounds[0]
  assert.equal(legacyPublic.scoreStats, null)
  assert.deepEqual(legacyPublic.modelRoute, { attacker: null, judge: null, inherited: true, samples: [] })
})
