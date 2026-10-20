/**
 * v1.1 1.6 tests: calibration v0 runner statistics (fake results, no LLM).
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  collectStats,
  computeStats,
  findingMatchesLabel,
  formatReport,
  loadResults,
  normalizeText,
  summarize,
} from '../benchmarks/runner.mjs'

const LABELS = {
  fixture: 'fake-web',
  labels: [
    { id: 'K1', category: 'dead-link', path: 'index.html', line: 21 },
    { id: 'K2', category: 'hardcoded-secret', path: 'app.js', line: 2 },
    { id: 'K3', category: 'form-nan', path: 'app.js', line: 14, lines: [14, 15] },
  ],
  expectations: { gatePassed: false },
}

function makeFinding({ title = '问题', evidence = '', severity = 'MAJOR' } = {}) {
  return { severity, title, evidence, attack: '触发方式', impact: '影响', fix: '修复', confidence: 'high', verified: true }
}

function makeResult(findings, gatePassed = false) {
  return {
    ok: true,
    shots: [{ file: 'a.png' }, { file: 'b.png' }, { file: 'c.png' }, { file: 'd.png' }],
    attack: { verdict: 'HOLD', summary: '摘要', findings, solid: [], unverified: [] },
    gate: { passed: gatePassed, score: gatePassed ? 95 : 70, failReasons: gatePassed ? [] : ['评分 70 < 要求 95'] },
  }
}

test('runner: label matching accepts path:line, path + 行号, and file-only labels', () => {
  assert.equal(findingMatchesLabel(makeFinding({ evidence: 'index.html:21 死链' }), LABELS.labels[0]), true)
  assert.equal(findingMatchesLabel(makeFinding({ evidence: 'app.js:2 硬编码 sk-…' }), LABELS.labels[1]), true)
  assert.equal(findingMatchesLabel(makeFinding({ evidence: 'app.js 第 15 行 NaN' }), LABELS.labels[2]), true)
  assert.equal(findingMatchesLabel(makeFinding({ evidence: 'app.js:14 parseInt' }), LABELS.labels[2]), true)
  // Wrong file / wrong line / unrelated finding never match.
  assert.equal(findingMatchesLabel(makeFinding({ evidence: 'other.js:21' }), LABELS.labels[0]), false)
  assert.equal(findingMatchesLabel(makeFinding({ evidence: 'index.html:22' }), LABELS.labels[0]), false)
  assert.equal(findingMatchesLabel(makeFinding({ evidence: 'styles.css:3' }), LABELS.labels[0]), false)
  assert.equal(findingMatchesLabel(makeFinding({ evidence: 'Index.HTML:21' }), { path: 'index.html', line: 21 }), true)
  assert.equal(findingMatchesLabel(makeFinding({ evidence: 'x' }), { path: '' }), false)
  assert.equal(findingMatchesLabel(null, LABELS.labels[0]), false)
  assert.equal(normalizeText('C:\\ws\\APP.JS'), 'c:/ws/app.js')
})

test('runner: computeStats reports recall / precision / extra / gate expectation', () => {
  const result = makeResult([
    makeFinding({ title: '死链', evidence: 'index.html:21', severity: 'MAJOR' }),
    makeFinding({ title: '硬编码密钥', evidence: 'app.js:2', severity: 'BLOCKER' }),
    makeFinding({ title: '表单 NaN', evidence: 'app.js 第 15 行', severity: 'MINOR' }),
    makeFinding({ title: '无证据的样式偏好', evidence: 'styles.css:3', severity: 'MINOR' }),
  ], false)
  const stats = computeStats({ fixture: 'fake-web', result, labels: LABELS, expectations: LABELS.expectations })
  assert.equal(stats.fixture, 'fake-web')
  assert.equal(stats.labels, 3)
  assert.equal(stats.reported, 4)
  assert.equal(stats.matched, 3)
  assert.equal(stats.missedIds.length, 0)
  assert.equal(stats.extra, 1)
  assert.equal(stats.recall, 1)
  assert.equal(stats.precision, 0.75)
  assert.equal(stats.gatePassed, false)
  assert.equal(stats.expectedGatePassed, false)
  assert.equal(stats.gateOk, true)

  // Missing labels are surfaced.
  const low = computeStats({
    fixture: 'fake-web',
    result: makeResult([makeFinding({ evidence: 'index.html:21' })]),
    labels: LABELS,
    expectations: LABELS.expectations,
  })
  assert.equal(low.recall, 1 / 3)
  assert.equal(low.precision, 1)
  assert.deepEqual(low.missedIds.sort(), ['K2', 'K3'])

  // Gate expectation mismatch is flagged.
  const mismatch = computeStats({
    fixture: 'fake-web',
    result: makeResult([makeFinding({ evidence: 'index.html:21' })], true),
    labels: LABELS,
    expectations: LABELS.expectations,
  })
  assert.equal(mismatch.gatePassed, true)
  assert.equal(mismatch.gateOk, false)
})

test('runner: fixtures without labels only report the gate expectation', () => {
  const stats = computeStats({
    fixture: 'injection-web',
    result: makeResult([makeFinding({ evidence: 'app.js:5 renderStatus' })]),
    labels: null,
    expectations: { gatePassed: false },
  })
  assert.equal(stats.labels, 0)
  assert.equal(stats.recall, null)
  assert.equal(stats.precision, null)
  assert.equal(stats.gateOk, true)
})

test('runner: summarize aggregates labeled fixtures and flags gate mismatches', () => {
  const one = computeStats({
    fixture: 'a',
    result: makeResult([makeFinding({ evidence: 'index.html:21' })]),
    labels: LABELS,
    expectations: LABELS.expectations,
  })
  const two = computeStats({
    fixture: 'b',
    result: makeResult([makeFinding({ evidence: 'app.js:2' })], true),
    labels: { labels: [{ id: 'X', path: 'app.js', line: 2 }] },
    expectations: { gatePassed: false },
  })
  const summary = summarize([one, two])
  assert.equal(summary.fixtures, 2)
  assert.equal(summary.labeledFixtures, 2)
  assert.equal(summary.labels, 4)
  assert.equal(summary.matched, 2)
  assert.equal(summary.recall, 0.5)
  assert.deepEqual(summary.gateMismatches, ['b'])

  const lines = formatReport([one, two], summary)
  assert.ok(lines.some((line) => line.startsWith('[a] labels=3')))
  assert.ok(lines.some((line) => line.includes('gateMismatches=b')))
  assert.ok(lines[lines.length - 1].startsWith('[汇总]'))
})

test('runner: collectStats reads real fixture labels and injected round JSON', () => {
  const round = makeResult([
    makeFinding({ title: '死链', evidence: 'index.html:21' }),
    makeFinding({ title: '硬编码密钥', evidence: 'app.js:2', severity: 'BLOCKER' }),
  ])
  const collected = collectStats({ results: [{ fixture: 'known-bugs-web', round }] })
  assert.equal(collected.stats.length, 1)
  const stats = collected.stats[0]
  assert.equal(stats.fixture, 'known-bugs-web')
  assert.equal(stats.labels, 5)
  assert.equal(stats.matched, 2)
  assert.equal(stats.recall, 2 / 5)
  assert.equal(stats.expectedGatePassed, false)

  const injection = collectStats({ results: [{ fixture: 'injection-web', round: makeResult([]) }] })
  // v2.0: injection-web now ships labels too (20-project calibration corpus).
  assert.equal(injection.stats[0].labels, 3)
  assert.equal(injection.stats[0].expectedGatePassed, false)
})

test('runner: loadResults tolerates missing dirs, wrappers and corrupt files', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rtc-bench-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  assert.deepEqual(loadResults(path.join(dir, 'missing')), [])
  await writeFile(path.join(dir, 'one.json'), JSON.stringify(makeResult([makeFinding({ evidence: 'a.js:1' })])))
  await writeFile(path.join(dir, 'wrapped.json'), JSON.stringify({ fixture: 'wrapped', round: makeResult([]) }))
  await writeFile(path.join(dir, 'bom.json'), `\uFEFF${JSON.stringify(makeResult([]))}`)
  await writeFile(path.join(dir, 'broken.json'), '{not json')
  await writeFile(path.join(dir, '_ignored.json'), JSON.stringify(makeResult([])))
  const loaded = loadResults(dir)
  assert.deepEqual(loaded.map((entry) => entry.fixture).sort(), ['bom', 'one', 'wrapped'])
  assert.equal(loaded.find((entry) => entry.fixture === 'wrapped').round.attack.findings.length, 0)
})

test('runner: formatReport output is human-readable for every fixture kind', () => {
  const stats = computeStats({
    fixture: 'injection-web',
    result: makeResult([]),
    labels: null,
    expectations: { gatePassed: false },
  })
  const lines = formatReport([stats], summarize([stats]))
  assert.ok(lines[0].includes('无 labels'))
  assert.ok(lines[0].includes('gatePassed=false（预期 false ✓）'))
})
