/**
 * v1.3 3.1 — automatic noise-control tests (pure module).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  countKnownRepeats,
  dedupeFindings,
  dedupeMustFix,
  extractFindingLocation,
  findingKey,
  knownFindingsFromRound,
  normalizeFindingText,
} from '../lib/noise.js'

function finding(overrides = {}) {
  return {
    severity: 'MAJOR',
    title: 'Broken start button',
    evidence: 'app.js:42 click handler missing',
    attack: 'click #start',
    impact: 'game cannot start',
    fix: 'bind handler',
    confidence: 'high',
    verified: true,
    ...overrides,
  }
}

test('normalizeFindingText strips punctuation/whitespace and lowercases', () => {
  assert.equal(normalizeFindingText('Broken  Start-Button!'), 'brokenstartbutton')
  assert.equal(normalizeFindingText('  '), '')
  assert.equal(normalizeFindingText(null), '')
})

test('v2.0: finding ID / severity prefixes do not create duplicate keys', () => {
  assert.equal(normalizeFindingText('F1 [BLOCKER] Broken start'), 'brokenstart')
  assert.equal(normalizeFindingText('A2: Broken start'), 'brokenstart')
  assert.equal(normalizeFindingText('[MAJOR] Broken start'), 'brokenstart')
  // Plain numeric titles (e.g. "404 page") must not be mistaken for an ID.
  assert.equal(normalizeFindingText('404 page broken'), '404pagebroken')
  const prefixed = finding({ severity: 'BLOCKER', title: 'F1 [BLOCKER] Broken start-button!', evidence: 'app.js:42' })
  const plain = finding({ severity: 'MAJOR', title: 'Broken start button', evidence: 'app.js:42' })
  assert.equal(findingKey(prefixed), findingKey(plain))
})

test('extractFindingLocation finds the first path:line in evidence/note/title', () => {
  assert.deepEqual(extractFindingLocation({ evidence: 'src/app.js:42 boom' }), { path: 'src/app.js', line: 42 })
  assert.deepEqual(extractFindingLocation({ note: 'C:\\ws\\App.JS:7' }), { path: 'c:/ws/app.js', line: 7 })
  assert.deepEqual(extractFindingLocation({ title: 'broken at index.html:3-9' }), { path: 'index.html', line: 3 })
  assert.equal(extractFindingLocation({ evidence: 'no location here' }), null)
  assert.equal(extractFindingLocation(null), null)
})

test('findingKey is severity-independent and combines title + first path:line', () => {
  const left = finding({ severity: 'BLOCKER', title: 'Broken  start-button!' })
  const right = finding({ severity: 'MINOR', title: 'broken start button', evidence: 'app.js:42 (same place)' })
  assert.equal(findingKey(left), findingKey(right))
  const otherLine = finding({ evidence: 'app.js:43 another line' })
  assert.notEqual(findingKey(left), findingKey(otherLine))
  const otherTitle = finding({ title: 'Different issue' })
  assert.notEqual(findingKey(left), findingKey(otherTitle))
  assert.equal(findingKey(null), '')
})

test('dedupeFindings keeps the best representative (supported > severity > evidence)', () => {
  const unsupported = finding({ title: 'Broken start button', evidence: 'app.js:42 click handler missing', verified: false, severity: 'BLOCKER' })
  const supported = finding({ title: 'Broken  start-button', evidence: 'app.js:42 click handler missing', verified: true, severity: 'MAJOR' })
  const duplicate = finding({ title: 'Broken start button!', evidence: 'app.js:42 click handler missing', verified: true, severity: 'MINOR' })
  const unrelated = finding({ title: 'Missing alt text', evidence: 'index.html:10', severity: 'MINOR' })
  const result = dedupeFindings([unsupported, supported, duplicate, unrelated])
  assert.equal(result.kept.length, 2)
  // Supported beats the unsupported BLOCKER duplicate.
  const keptStart = result.kept.find((entry) => entry.title.includes('start'))
  assert.equal(keptStart.severity, 'MAJOR')
  // The two duplicate titles are recorded as suppressed.
  assert.equal(result.suppressed.length, 2)
  assert.ok(result.suppressed.every((entry) => typeof entry.key === 'string' && entry.title !== '' && entry.reason !== ''))
  // Severity tie-break for judge-supported entries.
  const weak = finding({ title: 'Same issue', evidence: 'a.js:1', severity: 'MINOR', supported: true })
  const strong = finding({ title: 'Same issue', evidence: 'a.js:1', severity: 'BLOCKER', supported: true })
  assert.equal(dedupeFindings([weak, strong]).kept[0].severity, 'BLOCKER')
  // Longer evidence wins after severity/support ties.
  const short = finding({ title: 'Issue X', evidence: 'a.js:1', severity: 'MAJOR' })
  const long = finding({ title: 'Issue X', evidence: `a.js:1 ${'x'.repeat(200)}`, severity: 'MAJOR' })
  assert.equal(dedupeFindings([short, long]).kept[0].evidence.length > 100, true)
  // Findings without a title AND location are dropped from the key namespace.
  assert.deepEqual(dedupeFindings([{ severity: 'MINOR' }]), { kept: [], suppressed: [] })
  assert.deepEqual(dedupeFindings(null), { kept: [], suppressed: [] })
})

test('dedupeFindings caps distinct findings and marks the overflow', () => {
  const many = Array.from({ length: 45 }, (_unused, index) => finding({ title: `Issue ${index}`, evidence: `a.js:${index + 1}`, severity: 'MINOR' }))
  const result = dedupeFindings(many)
  assert.equal(result.kept.length, 40)
  assert.equal(result.suppressed.length, 5)
  assert.ok(result.suppressed.every((entry) => entry.reason.includes('上限')))
})

test('dedupeMustFix removes normalized duplicates and keeps first occurrence', () => {
  const result = dedupeMustFix(['Fix the start button', 'fix  the START button!!', 'Another fix', '', 42])
  assert.deepEqual(result.kept, ['Fix the start button', 'Another fix'])
  assert.equal(result.suppressed.length, 1)
  assert.match(result.suppressed[0].reason, /mustFix/)
  assert.deepEqual(dedupeMustFix(null), { kept: [], suppressed: [] })
})

test('knownFindingsFromRound exposes supported findings and prefers judge support', () => {
  const round = {
    attack: { findings: [finding({ title: 'Attacker-only', verified: false }), finding({ title: 'Supported', evidence: 'app.js:42' })] },
    score: {
      validFindings: [
        { title: 'Supported', severity: 'MAJOR', supported: true, note: 'app.js:42 verified' },
        { title: 'Unsupported', severity: 'MINOR', supported: false, note: 'x' },
        { title: 'Supported', severity: 'MINOR', supported: true, note: 'app.js:42 duplicate' },
      ],
    },
  }
  const known = knownFindingsFromRound(round)
  assert.equal(known.length, 1)
  assert.equal(known[0].title, 'Supported')
  assert.equal(known[0].pathLine, 'app.js:42')
  assert.equal(known[0].status, 'previously-reported')

  // Legacy round without a score falls back to verified attacker findings.
  const legacy = knownFindingsFromRound({ attack: { findings: [finding({ title: 'Legacy verified', verified: true })] } })
  assert.equal(legacy.length, 1)
  assert.equal(legacy[0].title, 'Legacy verified')
  assert.deepEqual(knownFindingsFromRound(null), [])

  // Bounded list.
  const huge = {
    score: {
      validFindings: Array.from({ length: 30 }, (_unused, index) => ({
        title: `Known ${index}`,
        severity: 'MINOR',
        supported: true,
        note: `file${index}.js:1`,
      })),
    },
  }
  assert.equal(knownFindingsFromRound(huge).length, 20)
})

test('countKnownRepeats counts current findings whose key matches the previous list', () => {
  const previous = [{ title: 'Broken start button', severity: 'MAJOR', pathLine: 'app.js:42', status: 'previously-reported' }]
  const current = [
    finding({ title: 'Broken  start button', evidence: 'app.js:42 again' }),
    finding({ title: 'Missing alt', evidence: 'index.html:10' }),
  ]
  assert.equal(countKnownRepeats(current, previous), 1)
  assert.equal(countKnownRepeats(current, []), 0)
  assert.equal(countKnownRepeats([], previous), 0)
  assert.equal(countKnownRepeats(null, null), 0)
})
