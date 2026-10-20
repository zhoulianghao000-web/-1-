import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregateJudgeScores,
  clampScore,
  computeGate,
  countSupportedFindings,
  extractJson,
  isPlainObject,
  truncateText,
  validateAttack,
  validateScore,
} from '../lib/rubric.js'
import { LIMITS } from '../lib/constants.js'

const VALID_ATTACK = {
  verdict: 'HOLD',
  summary: '核心页面能打开，但证据链不完整，存在可复现的功能缺陷。',
  findings: [
    {
      severity: 'BLOCKER',
      title: '提交按钮调用不存在的函数',
      evidence: 'app.js:42 handleSubmit 未定义，点击后控制台报错',
      attack: '打开页面，填写表单并点击提交',
      impact: '核心流程不可用，用户数据无法提交',
      fix: '定义并绑定 handleSubmit，补上错误处理',
      confidence: 'high',
      verified: true,
    },
    {
      severity: 'MAJOR',
      title: '移动端导航遮挡内容',
      evidence: 'style.css:88 header 固定高度 120px',
      attack: '390x844 视口打开首页并滚动到主内容区',
      impact: '移动端首屏内容被遮挡，可访问性下降',
      fix: '改为响应式高度或使用 sticky',
      confidence: 'medium',
      verified: false,
    },
  ],
  solid: ['入口 HTML 引用的脚本文件存在'],
  unverified: [{ item: '深色模式对比度', needs: '需要渲染深色模式截图' }],
  nextSteps: '先修 BLOCKER，再复核移动端布局。',
}

const VALID_SCORE = {
  score: 95,
  verdict: 'PASS',
  findingsCount: 4,
  validFindings: [
    { title: '提交按钮调用不存在的函数', severity: 'BLOCKER', supported: true, note: '已在 app.js 中复现' },
    { title: '移动端导航遮挡内容', severity: 'MAJOR', supported: true, note: '截图可见' },
    { title: 'F3', severity: 'MINOR', supported: true, note: '已定位' },
    { title: 'F4', severity: 'MINOR', supported: true, note: '已定位' },
    { title: 'F5 猜测项', severity: 'MAJOR', supported: false, note: '证据不足' },
  ],
  deductions: [{ points: 5, reason: '移动端仍有遮挡', fix: '响应式修复' }],
  mustFix: [],
  screenshots: { count: 4, quality: 'good', note: '4 张齐全' },
  nextAction: 'stop',
  rationale: '证据充分，分级合理。',
}

// ---------------------------------------------------------------------------
// extractJson
// ---------------------------------------------------------------------------

test('extractJson parses a pure JSON object', () => {
  assert.deepEqual(extractJson('{"a":1,"b":[2,3]}'), { a: 1, b: [2, 3] })
})

test('extractJson finds the last object in prose', () => {
  const text = '先说明一下：\n{"first":true}\n最终结果如下：\n{"verdict":"PASS","findings":[]}\n以上。'
  assert.deepEqual(extractJson(text), { verdict: 'PASS', findings: [] })
})

test('extractJson strips markdown fences', () => {
  const text = '```json\n{"score":95.5,"verdict":"PASS"}\n```'
  assert.deepEqual(extractJson(text), { score: 95.5, verdict: 'PASS' })
})

test('extractJson ignores braces inside strings', () => {
  const text = '输出：{"summary":"这里有 }{ 和 \\" 引号","ok":true}'
  assert.deepEqual(extractJson(text), { summary: '这里有 }{ 和 " 引号', ok: true })
})

test('extractJson survives truncated input', () => {
  assert.equal(extractJson('{"verdict":"BLOCK","findings":[{"title":"x"'), null)
  assert.equal(extractJson('{"a":1'), null)
})

test('extractJson returns null for hostile/non-object input', () => {
  assert.equal(extractJson(''), null)
  assert.equal(extractJson('   '), null)
  assert.equal(extractJson(null), null)
  assert.equal(extractJson(42), null)
  assert.equal(extractJson('[1,2,3]'), null)
  assert.equal(extractJson('no json here'), null)
  assert.equal(extractJson('{'.repeat(5000)), null)
  const protoPayload = extractJson('{"__proto__":{"polluted":true}}')
  assert.equal({}.polluted, undefined)
  assert.equal(Object.getPrototypeOf(protoPayload), Object.prototype)
})

test('extractJson keeps only the last valid object and ignores invalid braces', () => {
  const text = '{{broken}} then {"ok":1} and {"ok":2}'
  assert.deepEqual(extractJson(text), { ok: 2 })
})

// ---------------------------------------------------------------------------
// scores/utilities
// ---------------------------------------------------------------------------

test('clampScore snaps DOWN to 0.5 steps inside 0–100 and never rounds up', () => {
  assert.equal(clampScore(92.4), 92)
  assert.equal(clampScore(87.4), 87)
  // The stop-gate is a threshold: raw scores below 95 must never become 95 by
  // display rounding, and 95.25 must become 95.0 (not 95.5).
  assert.equal(clampScore(87.5), 87.5)
  assert.equal(clampScore(89.9), 89.5)
  assert.equal(clampScore(94.4), 94)
  assert.equal(clampScore(94.5), 94.5)
  assert.equal(clampScore(94.99), 94.5)
  assert.equal(clampScore(92.5), 92.5)
  assert.equal(clampScore(95.25), 95)
  assert.equal(clampScore(97.4), 97)
  assert.equal(clampScore(-3), 0)
  assert.equal(clampScore(420), 100)
  assert.equal(clampScore(Number.NaN), 0)
  assert.equal(clampScore('8'), 0)
})

test('truncateText bounds hostile text', () => {
  assert.equal(truncateText(undefined), '')
  assert.equal(truncateText(123), '')
  const long = 'x'.repeat(LIMITS.maxTextChars + 50)
  const cut = truncateText(long)
  assert.equal(cut.length, LIMITS.maxTextChars)
  assert.ok(cut.endsWith('…'))
})

test('isPlainObject rejects arrays/null/primitives', () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject('x'), false)
})

// ---------------------------------------------------------------------------
// validateAttack
// ---------------------------------------------------------------------------

test('validateAttack normalizes a valid payload', () => {
  const result = validateAttack(VALID_ATTACK)
  assert.equal(result.ok, true)
  assert.equal(result.attack.verdict, 'HOLD')
  assert.equal(result.attack.findings.length, 2)
  assert.equal(result.attack.findings[0].id, 'F1')
  assert.equal(result.attack.findings[0].severity, 'BLOCKER')
  assert.equal(result.attack.findings[1].id, 'F2')
  assert.deepEqual(result.attack.solid, ['入口 HTML 引用的脚本文件存在'])
  assert.equal(result.attack.unverified[0].item, '深色模式对比度')
})

test('validateAttack rejects invalid shapes', () => {
  assert.equal(validateAttack(null).ok, false)
  assert.equal(validateAttack([]).ok, false)
  assert.equal(validateAttack('text').ok, false)
  assert.equal(validateAttack({ verdict: 'MAYBE', findings: [] }).ok, false)
  assert.equal(validateAttack({ verdict: 'PASS', findings: 'nope' }).ok, false)
  assert.equal(validateAttack({ verdict: 'PASS', findings: [null, 42, {}] }).ok, false)
})

test('validateAttack tolerates missing optional fields with warnings', () => {
  const result = validateAttack({ verdict: 'pass', findings: [] })
  assert.equal(result.ok, true)
  assert.equal(result.attack.verdict, 'PASS')
  assert.deepEqual(result.attack.findings, [])
  assert.ok(result.warnings.some((warning) => warning.includes('summary')))
})

test('validateAttack normalizes bad enum case and caps counts/text', () => {
  const findings = Array.from({ length: LIMITS.maxFindings + 5 }, (_unused, index) => ({
    severity: 'blocker',
    title: `问题 ${index}`,
    evidence: 'e'.repeat(LIMITS.maxTextChars + 20),
    attack: 'a',
    impact: 'i',
    fix: 'f',
    confidence: 'HIGH',
    verified: 'yes',
  }))
  const result = validateAttack({ verdict: 'block', summary: 's', findings })
  assert.equal(result.ok, true)
  assert.equal(result.attack.findings.length, LIMITS.maxFindings)
  assert.equal(result.attack.findings[0].severity, 'BLOCKER')
  assert.equal(result.attack.findings[0].confidence, 'high')
  assert.equal(result.attack.findings[0].verified, false)
  assert.equal(result.attack.findings[0].evidence.length, LIMITS.maxTextChars)
  assert.ok(result.warnings.some((warning) => warning.includes('截断')))
})

// ---------------------------------------------------------------------------
// validateScore
// ---------------------------------------------------------------------------

test('validateScore normalizes a valid payload and counts supported findings', () => {
  const result = validateScore(VALID_SCORE)
  assert.equal(result.ok, true)
  assert.equal(result.score.score, 95)
  assert.equal(result.score.verdict, 'PASS')
  assert.equal(result.score.findingsCount, 4)
  assert.equal(countSupportedFindings(result.score), 4)
  assert.deepEqual(result.score.mustFix, [])
  assert.equal(result.score.nextAction, 'stop')
})

test('v2.0: blockingFindings entries merge into supported findings', () => {
  const result = validateScore({
    ...VALID_SCORE,
    findingsCount: 0,
    validFindings: [{ title: 'Minor thing', severity: 'MINOR', supported: true, note: 'x' }],
    blockingFindings: [{ title: 'Fatal bug', severity: 'BLOCKER', note: 'app.js:1' }],
    mustFix: [],
  })
  assert.equal(result.ok, true)
  const blocker = result.score.validFindings.find((finding) => finding.title === 'Fatal bug')
  assert.equal(blocker.supported, true)
  assert.equal(blocker.severity, 'BLOCKER')
  assert.equal(result.score.supportedCount, 2)
})

test('validateScore snaps 0.5 steps and recomputes counts', () => {
  const result = validateScore({
    ...VALID_SCORE,
    score: 95.24,
    verdict: 'WAT',
    findingsCount: 1,
  })
  assert.equal(result.ok, true)
  assert.equal(result.score.score, 95)
  assert.equal(result.score.verdict, 'PASS')
  assert.equal(result.score.findingsCount, 4)
  assert.ok(result.warnings.length > 0)
})

test('validateScore rejects invalid shapes and missing score', () => {
  assert.equal(validateScore(null).ok, false)
  assert.equal(validateScore({}).ok, false)
  assert.equal(validateScore({ score: 'abc' }).ok, false)
  assert.equal(validateScore({ score: Number.POSITIVE_INFINITY }).ok, false)
})

test('validateScore forces fix_and_review when mustFix is non-empty', () => {
  const result = validateScore({ ...VALID_SCORE, nextAction: 'stop', mustFix: ['修复 A'] })
  assert.equal(result.ok, true)
  assert.equal(result.score.nextAction, 'fix_and_review')
  assert.ok(result.warnings.some((warning) => warning.includes('stop')))
})

test('validateScore caps mustFix/deductions and defaults screenshots', () => {
  const result = validateScore({
    score: 30,
    verdict: 'BLOCK',
    findingsCount: 2,
    validFindings: [],
    deductions: Array.from({ length: LIMITS.maxDeductions + 5 }, () => ({ points: 999, reason: 'r', fix: 'f' })),
    mustFix: Array.from({ length: LIMITS.maxMustFix + 5 }, (_unused, index) => `修复-${index}`),
    screenshots: { count: 'x', quality: 'wat', note: 5 },
    nextAction: 'stop',
    rationale: 'r',
  })
  assert.equal(result.ok, true)
  assert.equal(result.score.deductions.length, LIMITS.maxDeductions)
  assert.equal(result.score.deductions[0].points, 100)
  assert.equal(result.score.mustFix.length, LIMITS.maxMustFix)
  assert.deepEqual(result.score.screenshots, { count: 0, quality: 'bad', note: '' })
})

test('validateScore keeps the raw pre-clamp score and supported count for audit', () => {
  const result = validateScore({ ...VALID_SCORE, score: 95.24 })
  assert.equal(result.ok, true)
  assert.equal(result.score.score, 95)
  assert.equal(result.score.rawScore, 95.24)
  assert.equal(result.score.supportedCount, 4)
  assert.equal(
    validateScore({ score: 94.99, verdict: 'HOLD', validFindings: [] }).score.rawScore,
    94.99,
  )
  // Legacy/plain normalized scores keep working without the new fields.
  assert.equal(
    computeGate({ score: { score: 95, findingsCount: 3, validFindings: [] }, shots: 4 }).score,
    95,
  )
})

// ---------------------------------------------------------------------------
// v2.0 clean-pass gate
// ---------------------------------------------------------------------------

test('v2.0 clean-pass: zero supported findings + passing score passes the gate', () => {
  const clean = computeGate({
    score: { score: 100, findingsCount: 0, supportedCount: 0, validFindings: [], mustFix: [], blockingFindings: [] },
    shots: 4,
  })
  assert.equal(clean.passed, true)
  assert.deepEqual(clean.failReasons, [])

  // A partial review (1–2 findings) must NOT use the clean-pass path.
  const partial = computeGate({
    score: { score: 95, findingsCount: 2, supportedCount: 2, validFindings: [], mustFix: [], blockingFindings: [] },
    shots: 4,
  })
  assert.equal(partial.passed, false)
  assert.ok(partial.failReasons.some((reason) => reason.includes('干净项目需 0 条 supported')))

  // A clean verdict with a sub-threshold score still fails.
  const low = computeGate({
    score: { score: 90, findingsCount: 0, supportedCount: 0, validFindings: [], mustFix: [], blockingFindings: [] },
    shots: 4,
  })
  assert.equal(low.passed, false)

  // v2.0: clean-pass is per-sample — one clean judge must not erase another
  // judge's 1–2 supported findings.
  const mixed = computeGate({
    score: {
      score: 95,
      findingsCount: 0,
      supportedCount: 0,
      perSampleSupported: [0, 2],
      perSampleFindings: [0, 2],
      validFindings: [],
      mustFix: [],
      blockingFindings: [],
    },
    shots: 4,
  })
  assert.equal(mixed.passed, false)
  assert.ok(mixed.failReasons.some((reason) => reason.includes('干净项目需 0 条 supported')))
})

test('v2.0 validateScore derives per-sample verdict from the configured pass line', () => {
  const at90 = validateScore({ score: 92, validFindings: [] }, { requiredScore: 90 })
  assert.equal(at90.ok, true)
  assert.equal(at90.score.verdict, 'PASS')
  const default95 = validateScore({ score: 92, validFindings: [] })
  assert.equal(default95.score.verdict, 'HOLD')
})

// ---------------------------------------------------------------------------
// multi-judge aggregation (v1.1 1.2)
// ---------------------------------------------------------------------------

/** Minimal normalized judge score; `validateScore` output shape plus overrides. */
function judgeScore(overrides = {}) {
  return {
    score: 95,
    rawScore: 95,
    verdict: 'PASS',
    findingsCount: 3,
    supportedCount: 3,
    validFindings: [],
    deductions: [],
    mustFix: [],
    screenshots: { count: 4, quality: 'good', note: '四张齐全' },
    rationale: '证据充分。',
    ...overrides,
  }
}

test('aggregateJudgeScores returns null for empty or invalid sample lists', () => {
  assert.equal(aggregateJudgeScores([]), null)
  assert.equal(aggregateJudgeScores(null), null)
  assert.equal(aggregateJudgeScores('nope'), null)
  assert.equal(aggregateJudgeScores([null, 'x', 42]), null)
})

test('aggregateJudgeScores takes the lower median and conservative minimum counts', () => {
  // Even sample count → the lower of the two middle values.
  assert.equal(aggregateJudgeScores([judgeScore({ score: 95 }), judgeScore({ score: 85 })]).score, 85)
  // Odd sample count → the true middle value.
  assert.equal(aggregateJudgeScores([
    judgeScore({ score: 83 }), judgeScore({ score: 95 }), judgeScore({ score: 91 }),
  ]).score, 91)
  assert.equal(aggregateJudgeScores([
    judgeScore({ score: 90 }), judgeScore({ score: 95 }), judgeScore({ score: 90 }), judgeScore({ score: 95 }),
  ]).score, 90)
  // The median is clamped DOWN to 0.5 steps (never up).
  assert.equal(aggregateJudgeScores([judgeScore({ score: 94.75 })]).score, 94.5)

  const aggregate = aggregateJudgeScores([
    judgeScore({ findingsCount: 5, supportedCount: 4 }),
    judgeScore({ findingsCount: 3, supportedCount: 3 }),
  ])
  assert.equal(aggregate.findingsCount, 3)
  assert.equal(aggregate.supportedCount, 3)
  assert.equal(aggregate.rawScore, 95)
  assert.equal(aggregate.verdict, 'PASS')
  assert.equal(aggregate.nextAction, 'stop')
})

test('aggregateJudgeScores unions mustFix and intersects supported findings by title', () => {
  const aggregate = aggregateJudgeScores([
    judgeScore({
      validFindings: [
        { title: 'A', severity: 'MINOR', supported: true, note: 'a.js:1' },
        { title: 'B', severity: 'MAJOR', supported: true, note: 'b.js:2' },
      ],
      mustFix: ['修复 A', '修复 B'],
      deductions: [{ points: 2.5, reason: 'A', fix: '修 A' }],
    }),
    judgeScore({
      validFindings: [
        { title: 'A', severity: 'MINOR', supported: true, note: 'a.js:1 已复核' },
        { title: 'B', severity: 'MAJOR', supported: false, note: '行号对不上' },
        { title: 'C', severity: 'MINOR', supported: true, note: 'c.js:3' },
      ],
      mustFix: ['修复 B', '修复 C'],
      deductions: [{ points: 5, reason: 'B', fix: '修 B' }],
    }),
  ])
  assert.deepEqual(aggregate.mustFix, ['修复 A', '修复 B', '修复 C'])
  assert.equal(aggregate.validFindings.length, 3)
  const byTitle = new Map(aggregate.validFindings.map((finding) => [finding.title, finding]))
  assert.equal(byTitle.get('A').supported, true)
  assert.equal(byTitle.get('A').note, 'a.js:1')
  // One judge disputed B → intersection semantics make it unsupported.
  assert.equal(byTitle.get('B').supported, false)
  assert.equal(byTitle.get('B').note, '行号对不上')
  // C exists in only one sample → not supported by every judge.
  assert.equal(byTitle.get('C').supported, false)
  // Deductions are merged (all entries kept), screenshots from the first sample.
  assert.equal(aggregate.deductions.length, 2)
  assert.equal(aggregate.deductions[1].points, 5)
  assert.deepEqual(aggregate.screenshots, { count: 4, quality: 'good', note: '四张齐全' })
  assert.ok(aggregate.rationale.includes('判官 1'))
  assert.ok(aggregate.rationale.includes('判官 2'))
})

test('aggregateJudgeScores unions any-sample supported blocking findings', () => {
  const aggregate = aggregateJudgeScores([
    judgeScore({
      validFindings: [
        { title: 'X', severity: 'MAJOR', supported: true, note: 'app.js:42' },
        { title: 'Y', severity: 'MINOR', supported: true, note: 'y.js:1' },
      ],
    }),
    judgeScore({
      validFindings: [
        { title: 'X', severity: 'MINOR', supported: true, note: 'app.js:42' },
        { title: 'Z', severity: 'BLOCKER', supported: true, note: 'z.js:2' },
      ],
    }),
  ])
  const blocking = new Map(aggregate.blockingFindings.map((finding) => [finding.title, finding]))
  assert.equal(blocking.size, 2)
  // Same title, different severities: the conservative (higher) severity wins.
  assert.equal(blocking.get('X').severity, 'MAJOR')
  assert.equal(blocking.get('Z').severity, 'BLOCKER')
  const validX = aggregate.validFindings.find((finding) => finding.title === 'X')
  assert.equal(validX.supported, true)
  assert.equal(validX.severity, 'MAJOR')
})

test('aggregateJudgeScores computes the disagreement signal without blocking on it', () => {
  const spread = aggregateJudgeScores([judgeScore({ score: 95 }), judgeScore({ score: 85, verdict: 'HOLD' })])
  assert.equal(spread.disagreement.scoreSpread, 10)
  assert.equal(spread.disagreement.disagree, true)

  // Exactly 5 points of spread is NOT disagreement (strictly greater than 5).
  const borderline = aggregateJudgeScores([judgeScore({ score: 95 }), judgeScore({ score: 90 })])
  assert.equal(borderline.disagreement.scoreSpread, 5)
  assert.equal(borderline.disagreement.disagree, false)

  const mustFix = aggregateJudgeScores([
    judgeScore({ validFindings: [{ title: 'A', supported: true, severity: 'MINOR' }] }),
    judgeScore({ validFindings: [{ title: 'A', supported: true, severity: 'MINOR' }], mustFix: ['修复 A'] }),
  ])
  assert.equal(mustFix.disagreement.mustFixMismatch, true)
  assert.equal(mustFix.disagreement.disagree, true)

  const verdict = aggregateJudgeScores([judgeScore({ verdict: 'PASS' }), judgeScore({ verdict: 'HOLD' })])
  assert.equal(verdict.disagreement.verdictMismatch, true)
  assert.equal(verdict.disagreement.disagree, true)

  const agreeing = aggregateJudgeScores([judgeScore(), judgeScore(), judgeScore()])
  assert.deepEqual(agreeing.disagreement, {
    scoreSpread: 0,
    mustFixMismatch: false,
    verdictMismatch: false,
    disagree: false,
  })
})

test('aggregateJudgeScores keeps single-sample behavior and derives the verdict', () => {  const single = judgeScore({
    score: 75,
    rawScore: 75,
    verdict: 'HOLD',
    validFindings: [{ title: 'A', severity: 'MAJOR', supported: true, note: 'a.js:1' }],
    mustFix: ['修复 A'],
    deductions: [{ points: 5, reason: 'A', fix: '修 A' }],
    rationale: '仍有阻断项。',
  })
  const aggregate = aggregateJudgeScores([single])
  assert.equal(aggregate.score, 75)
  assert.equal(aggregate.rawScore, 75)
  assert.equal(aggregate.findingsCount, 3)
  assert.equal(aggregate.supportedCount, 3)
  assert.deepEqual(aggregate.validFindings, single.validFindings)
  assert.deepEqual(aggregate.blockingFindings, [{ title: 'A', severity: 'MAJOR', supported: true, note: 'a.js:1' }])
  assert.deepEqual(aggregate.mustFix, ['修复 A'])
  assert.deepEqual(aggregate.deductions, single.deductions)
  assert.deepEqual(aggregate.screenshots, single.screenshots)
  assert.equal(aggregate.rationale, '仍有阻断项。')
  assert.equal(aggregate.disagreement.disagree, false)
  assert.equal(aggregate.verdict, 'HOLD')
  assert.equal(aggregate.nextAction, 'fix_and_review')

  // Derivation from the aggregated score: ≥95 PASS, ≥60 HOLD, else BLOCK.
  assert.equal(aggregateJudgeScores([judgeScore({ score: 96, verdict: 'HOLD' })]).verdict, 'PASS')
  assert.equal(aggregateJudgeScores([judgeScore({ score: 60, verdict: 'BLOCK' })]).verdict, 'HOLD')
  assert.equal(aggregateJudgeScores([judgeScore({ score: 59.5, verdict: 'HOLD' })]).verdict, 'BLOCK')
})

test('aggregateJudgeScores caps merged deductions and treats missing fields defensively', () => {
  const aggregate = aggregateJudgeScores([
    judgeScore({ deductions: Array.from({ length: LIMITS.maxDeductions }, () => ({ points: 1, reason: 'r', fix: 'f' })) }),
    judgeScore({ deductions: [{ points: 2.5, reason: 'extra', fix: 'g' }] }),
  ])
  assert.equal(aggregate.deductions.length, LIMITS.maxDeductions)
  const empty = aggregateJudgeScores([{}, {}])
  assert.equal(empty.score, 0)
  assert.equal(empty.findingsCount, 0)
  assert.equal(empty.supportedCount, 0)
  assert.deepEqual(empty.mustFix, [])
  assert.deepEqual(empty.validFindings, [])
  assert.equal(empty.verdict, 'BLOCK')
})

// ---------------------------------------------------------------------------
// multi-judge gate integration (v1.1 1.1/1.2)
// ---------------------------------------------------------------------------

test('computeGate prefers aggregated supportedCount over re-counting validFindings', () => {
  const score = {
    ...validateScore({ ...VALID_SCORE, score: 95 }).score,
    supportedCount: 2,
  }
  const gate = computeGate(gateInput({ score }))
  assert.equal(gate.passed, false)
  assert.ok(gate.failReasons.some((reason) => reason.includes('supported')))
})

test('computeGate prefers aggregated blockingFindings over the validFindings fallback', () => {
  const base = validateScore({
    ...VALID_SCORE,
    score: 95,
    validFindings: [
      { title: 'A', severity: 'MINOR', supported: true },
      { title: 'B', severity: 'MINOR', supported: true },
      { title: 'C', severity: 'MINOR', supported: true },
    ],
    findingsCount: 3,
  }).score
  const withoutBlocking = computeGate(gateInput({ score: base }))
  assert.equal(withoutBlocking.passed, true)
  const withBlocking = computeGate(gateInput({
    score: { ...base, blockingFindings: [{ title: '只被一个判官认定', severity: 'MAJOR', supported: true }] },
  }))
  assert.equal(withBlocking.passed, false)
  assert.ok(withBlocking.failReasons.some((reason) => reason.includes('阻断项')))
})

// ---------------------------------------------------------------------------
// computeGate
// ---------------------------------------------------------------------------

const PASSING_SCORE = validateScore({
  ...VALID_SCORE,
  validFindings: VALID_SCORE.validFindings.map((finding) => ({
    ...finding,
    // 95/100 means no supported BLOCKER/MAJOR blocking item remains; only MINOR
    // findings may keep a passing report.
    severity: finding.supported === true ? 'MINOR' : finding.severity,
  })),
}).score

function gateInput(overrides = {}) {
  return {
    score: PASSING_SCORE,
    shots: 4,
    requiredScore: 95,
    requiredFindings: 3,
    requiredShots: 4,
    ...overrides,
  }
}

test('computeGate passes only when every condition holds', () => {
  const gate = computeGate(gateInput())
  assert.equal(gate.passed, true)
  assert.deepEqual(gate.failReasons, [])
  assert.equal(gate.score, 95)
  assert.equal(gate.findings, 4)
  assert.equal(gate.shots, 4)
})

test('computeGate fails on low score', () => {
  const gate = computeGate(gateInput({ score: validateScore({ ...VALID_SCORE, score: 75, verdict: 'HOLD' }).score }))
  assert.equal(gate.passed, false)
  assert.ok(gate.failReasons.some((reason) => reason.includes('评分 75')))
})

test('computeGate fails on insufficient findings/supported findings', () => {
  const score = validateScore({
    ...VALID_SCORE,
    findingsCount: 2,
    validFindings: [
      { title: 'A', supported: true },
      { title: 'B', supported: false },
    ],
  }).score
  const gate = computeGate(gateInput({ score }))
  assert.equal(gate.passed, false)
  assert.ok(gate.failReasons.some((reason) => reason.includes('有效发现（去重后）2 条')))
  assert.ok(gate.failReasons.some((reason) => reason.includes('supported')))
})

test('computeGate requires exactly requiredShots screenshots', () => {
  for (const shots of [0, 3, 5]) {
    const gate = computeGate(gateInput({ shots }))
    assert.equal(gate.passed, false)
    assert.ok(gate.failReasons.some((reason) => reason.includes('截图')))
  }
})

test('computeGate fails when mustFix is non-empty', () => {
  const score = validateScore({ ...VALID_SCORE, mustFix: ['还差一个修复'] }).score
  const gate = computeGate(gateInput({ score }))
  assert.equal(gate.passed, false)
  assert.ok(gate.failReasons.some((reason) => reason.includes('mustFix')))
})

test('computeGate rejects a supported BLOCKER even when the score is passing', () => {
  const score = validateScore({
    ...VALID_SCORE,
    score: 95,
    validFindings: [{ title: '崩溃', severity: 'BLOCKER', supported: true }, { title: 'B', supported: true }, { title: 'C', supported: true }],
    findingsCount: 3,
  }).score
  const gate = computeGate(gateInput({ score }))
  assert.equal(gate.passed, false)
  assert.ok(gate.failReasons.some((reason) => reason.includes('阻断项')))
})

test('computeGate rejects a supported MAJOR even when the score is passing', () => {
  const score = validateScore({
    ...VALID_SCORE,
    score: 95,
    validFindings: [{ title: '核心交互失效', severity: 'MAJOR', supported: true }, { title: 'B', supported: true }, { title: 'C', supported: true }],
    findingsCount: 3,
  }).score
  const gate = computeGate(gateInput({ score }))
  assert.equal(gate.passed, false)
  assert.ok(gate.failReasons.some((reason) => reason.includes('阻断项')))
})

test('computeGate cannot be crossed by rounding a below-threshold raw score up', () => {
  const score = validateScore({ ...VALID_SCORE, score: 87.5, verdict: 'HOLD' }).score
  assert.equal(score.score, 87.5)
  const gate = computeGate(gateInput({ score }))
  assert.equal(gate.passed, false)
  assert.ok(gate.failReasons.some((reason) => reason.includes('评分 87.5')))
})

test('computeGate fails when judge score is missing', () => {
  const gate = computeGate(gateInput({ score: null }))
  assert.equal(gate.passed, false)
  assert.ok(gate.failReasons.some((reason) => reason.includes('缺少判官评分')))
})

// ---------------------------------------------------------------------------
// v2.0 Stage A: score statistics / CI on the aggregated judge samples
// ---------------------------------------------------------------------------

test('aggregateJudgeScores adds deterministic scoreStats/ci95 without changing the gate score', () => {
  const aggregate = aggregateJudgeScores([
    judgeScore({ score: 90, verdict: 'HOLD' }),
    judgeScore({ score: 95, verdict: 'PASS' }),
    judgeScore({ score: 100, verdict: 'PASS' }),
  ])
  // Conservative aggregate stays the lower median.
  assert.equal(aggregate.score, 95)
  assert.equal(aggregate.samples, 3)
  assert.equal(aggregate.scoreStats.n, 3)
  assert.equal(aggregate.scoreStats.mean, 95)
  assert.equal(aggregate.scoreStats.median, 95)
  assert.equal(aggregate.scoreStats.stdev, 5)
  assert.equal(aggregate.scoreStats.min, 90)
  assert.equal(aggregate.scoreStats.max, 100)
  assert.equal(aggregate.scoreStats.ci95.low >= 90 && aggregate.scoreStats.ci95.low <= 95, true)
  assert.equal(aggregate.scoreStats.ci95.high >= 95 && aggregate.scoreStats.ci95.high <= 100, true)
  assert.deepEqual(aggregate.ci95, aggregate.scoreStats.ci95)
  // Deterministic (fixed seeded bootstrap).
  assert.deepEqual(
    aggregateJudgeScores([judgeScore({ score: 90 }), judgeScore({ score: 95 }), judgeScore({ score: 100 })]).scoreStats,
    aggregate.scoreStats,
  )

  const two = aggregateJudgeScores([judgeScore({ score: 95 }), judgeScore({ score: 85 })])
  assert.equal(two.score, 85) // lower median unchanged
  assert.equal(two.scoreStats.mean, 90)
  assert.equal(two.scoreStats.median, 90)
  assert.equal(two.scoreStats.stdev, 7.1)
  assert.equal(two.ci95.low <= 90 && two.ci95.high >= 90, true)

  const single = aggregateJudgeScores([judgeScore({ score: 88.5 })])
  assert.equal(single.samples, 1)
  assert.equal(single.scoreStats.stdev, null)
  assert.deepEqual(single.scoreStats.ci95, { low: 88.5, high: 88.5 })

  // Gate semantics are untouched by the statistics.
  const gate = computeGate({
    score: aggregate,
    shots: 4,
    requiredScore: 95,
    requiredFindings: 3,
    requiredShots: 4,
  })
  assert.equal(gate.score, 95)
})
