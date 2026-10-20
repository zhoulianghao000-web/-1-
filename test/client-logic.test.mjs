// Verification for the Red-Team Review Console client half (v1.3).
//
// The browser bundle cannot be imported directly: it expects
// window.__ModuleLoader__ and React. This test therefore:
//   1. reads the shipped text and checks the static contract (panel slots,
//      host routes, polling/stream cleanup, no credentials, i18n parity), and
//   2. evaluates the marked PURE region in a plain Node function, then exercises
//      the shipped search/group/format/diff/progress/artifact helpers directly.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const client = readFileSync(join(root, 'client.js'), 'utf8')
const localeEn = JSON.parse(readFileSync(join(root, 'locale', 'en.json'), 'utf8'))
const localeZh = JSON.parse(readFileSync(join(root, 'locale', 'zh.json'), 'utf8'))

const TEXT_BEGIN = '/* TEXT-BEGIN */'
const TEXT_END = '/* TEXT-END */'
const PURE_BEGIN = '/* PURE-BEGIN */'
const PURE_END = '/* PURE-END */'

function sliceRegion(beginMarker, endMarker) {
  const begin = client.indexOf(beginMarker)
  const end = client.indexOf(endMarker)
  assert.ok(begin >= 0, 'client.js must contain ' + beginMarker)
  assert.ok(end > begin, 'client.js must contain ' + endMarker + ' after ' + beginMarker)
  return client.slice(begin + beginMarker.length, end)
}

function readEmbeddedText() {
  const region = sliceRegion(TEXT_BEGIN, TEXT_END)
  const from = region.indexOf('{')
  const to = region.lastIndexOf('}')
  assert.ok(from >= 0 && to > from, 'the TEXT region must contain one object literal')
  return JSON.parse(region.slice(from, to + 1))
}

const PURE_NAMES = [
  'isObject', 'asArray', 'asString', 'toFiniteNumber', 'firstNumber', 'firstNumberOr', 'clamp',
  'cleanStringList', 'dedupeStrings', 'formatScoreText', 'formatCountText', 'formatDuration',
  'severityOrder', 'normalizeSeverity', 'normalizeTitle', 'judgeVerdictForTitle',
  'countSupportedFindings', 'roundNumberOf', 'sortRoundEntries', 'latestRoundEntry', 'cycleKeyOf',
  'cycleEntriesFrom', 'findCycleEntry', 'findRoundEntry', 'roundStatusKey', 'roundTone',
  'verdictTone', 'verdictKey', 'filterCycles', 'cycleLatestScore', 'sortCycles', 'normalizeGate',
  'normalizeState', 'describeError', 'normalizeStage', 'stagePercent', 'progressOf',
  'progressLabelKey', 'progressLabel', 'isRoundRunning', 'cycleHasRunningRound',
  'cyclesHaveRunningRound', 'parseProgressPayload', 'profileOf', 'profileKey', 'statusBadge',
  'judgesOf', 'judgeSamplesOf', 'disagreementOf', 'sessionIdsOf', 'noiseInfo', 'costInfo',
  'incrementalInfo', 'incrementalModeKey', 'safeFileName', 'shortSha', 'artifactKindKey', 'artifactLabel',
  'normalizeArtifact', 'evidenceKind', 'evidenceKindKey', 'isImageArtifact', 'isTextArtifact',
  'evidenceCards', 'evidenceKindCounts', 'extraArtifactsOf', 'shotUrl', 'artifactUrl', 'diffUrl',
  'progressUrl', 'cancelUrl', 'exportUrl', 'artifactPreviewUrl', 'buildShotSrc',
  'normalizeDiffStatus', 'normalizeDiff', 'diffBadge', 'diffChangeMap', 'diffSummaryForRound',
  'filterFindings', 'groupFindings'
]

function loadPureHelpers() {
  const region = sliceRegion(PURE_BEGIN, PURE_END)
  const factory = new Function(region + '\nreturn {' + PURE_NAMES.join(', ') + '}')
  const helpers = factory()
  for (const name of PURE_NAMES) assert.equal(typeof helpers[name], 'function', 'PURE helper ' + name + ' must be a function')
  return helpers
}

const pure = loadPureHelpers()

// ---------------------------------------------------------------------------
// Static contract
// ---------------------------------------------------------------------------

test('bundle shape: module-loader registration, React only, slots injected', () => {
  assert.match(client, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(client, /id:\s*'@local\/dsh-redteam-console'/)
  assert.match(client, /factory\(\s*require\s*\)\s*\{/)
  assert.match(client, /(?:const|var|let)\s+React\s*=\s*require\('react'\)/)
  assert.match(client, /inject:\s*\[\s*'slots'\s*\]/)
  assert.match(client, /apply:\s*apply/)
  assert.match(client, /ctx\.effect\(effectBody/)
  const required = [...client.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)].map((match) => match[2])
  assert.ok(required.length > 0, 'client.js must require React')
  for (const specifier of required) assert.equal(specifier, 'react', 'client.js may only require react')
})

test('both native panel registrations target the adversarial-review console', () => {
  assert.match(client, /slots\.inject\('sidebar\.panellist'/)
  assert.match(client, /name:\s*'sidebar\.panellist'/)
  assert.match(client, /id:\s*'adversarial-review'/)
  assert.match(client, /order:\s*30/)
  assert.match(client, /label:\s*function/)
  assert.match(client, /slots\.inject\('main'/)
  assert.match(client, /name:\s*'main'/)
  assert.match(client, /key:\s*'adversarial-review'/)
  assert.match(client, /function registerConsole\(ctx\)/)
  assert.match(client, /return function disposeRegistration\(\)/)
})

test('host review endpoints cover state, evidence, diff, export, progress and cancel', () => {
  for (const route of [
    '/adversarial-review/state',
    '/adversarial-review/shot',
    '/adversarial-review/artifact',
    '/adversarial-review/diff',
    '/adversarial-review/export',
    '/adversarial-review/progress',
    '/adversarial-review/cancel'
  ]) {
    assert.ok(client.includes("'" + route + "'"), 'client must target ' + route)
  }
  assert.ok(client.includes("'/adversarial-review/export'"), 'export link must use the host export route')
  assert.ok(client.includes('encodeURIComponent'), 'route parameters must be encoded')
  assert.ok(client.includes('&file='), 'artifact/shot routes must pass the file parameter')
  assert.ok(client.includes('&format='), 'export route must pass the format parameter')
  assert.ok(client.includes('onError'), 'evidence images need an onError fallback')
  assert.ok(client.includes("method: 'POST'"), 'cancel must be a POST request')
  assert.ok(client.includes('new EventSource('), 'live progress must use EventSource when available')
  assert.ok(client.includes('source.close()'), 'the progress stream must be closed')
  assert.ok(client.includes('download:'), 'export and text artifacts are download links')
  assert.ok(client.includes('target: \'_blank\''), 'image artifacts open in a new tab')
})

test('console stays read-only: no accept/reject/waive workflow controls or routes', () => {
  for (const pattern of [/\/accept/i, /\/reject/i, /\/waive/i, /\bwaive\b/i]) {
    assert.equal(client.match(pattern), null, 'client.js must not implement a manual decision workflow: ' + pattern)
  }
  // The only mutating call is the explicit cancel POST; every other route is read-only.
  const posts = [...client.matchAll(/method:\s*'POST'/g)]
  assert.equal(posts.length, 1, 'exactly one POST (cancel) is allowed')
})

test('no credentials, external URLs, hardcoded colors or forbidden imports', () => {
  const forbidden = [
    ['api key assignment', /api[_-]?key\s*[:=]/i],
    ['secret assignment', /secret\s*[:=]/i],
    ['bearer header', /bearer\s/i],
    ['deepseek client import', /require\(\s*['"]@deepseek-ai\//],
    ['external URL', /https?:\/\//],
    ['hardcoded hex color', /#[0-9a-f]{3,8}\b/i]
  ]
  for (const [label, pattern] of forbidden) {
    const match = client.match(pattern)
    assert.equal(match, null, 'client.js must not contain ' + label + '; found: ' + (match && match[0]))
  }
  assert.ok(!/localStorage/.test(client), 'client.js must not persist UI state in localStorage')
  assert.ok(!/document\.body/.test(client), 'client.js must not touch document.body')
})

test('polling lifecycle: adaptive cadence, visibility pause, timer/abort/stream cleanup', () => {
  assert.match(client, /var POLL_IDLE_MS = 5000/)
  assert.match(client, /var POLL_ACTIVE_MS = 2000/)
  assert.ok(client.includes('cyclesHaveRunningRound(lastCycles) ? POLL_ACTIVE_MS : POLL_IDLE_MS'), 'poll cadence must adapt to running rounds')
  assert.ok(client.includes("document.addEventListener('visibilitychange'"), 'polling must pause/resume on visibilitychange')
  assert.ok(client.includes("document.removeEventListener('visibilitychange'"), 'the visibility listener must be removed on cleanup')
  assert.ok(client.includes('clearTimeout(pendingTimer)'), 'the poll timer must be cleared')
  assert.ok(client.includes('AbortController'), 'in-flight requests must be aborted on cleanup')
  assert.ok(client.includes('function stopPolling()'), 'the polling effect must expose its cleanup')
  assert.ok(client.includes('function stopProgressStream()'), 'the progress stream must expose its cleanup')
  assert.ok(client.includes('function cleanupDiff()'), 'the diff request must be aborted on cleanup')
  assert.ok(client.includes('response.ok'), 'non-200 responses must be detected')
  assert.ok(client.includes('JSON.parse(raw)'), 'invalid JSON must be handled')
  assert.ok(client.includes("key: 'error.payload'"), 'an { ok: false } payload must be surfaced')
  assert.ok(client.includes('asArray(payload.cycles).filter(isObject)'), 'empty or malformed cycles must be tolerated')
})

test('embedded TEXT dictionaries: strict JSON, complete, no hardcoded mixed-language copy', () => {
  const text = readEmbeddedText()
  assert.ok(text.zh && typeof text.zh === 'object', 'TEXT.zh must be an object')
  assert.ok(text.en && typeof text.en === 'object', 'TEXT.en must be an object')
  const zhKeys = Object.keys(text.zh).sort()
  const enKeys = Object.keys(text.en).sort()
  assert.ok(zhKeys.length > 200, 'expected the full v1.3 dictionary, found ' + zhKeys.length + ' keys')
  assert.deepEqual(enKeys, zhKeys, 'zh and en dictionaries must carry exactly the same key set')
  for (const key of zhKeys) {
    assert.equal(typeof text.zh[key], 'string', 'TEXT.zh[' + key + '] must be a string')
    assert.equal(typeof text.en[key], 'string', 'TEXT.en[' + key + '] must be a string')
    assert.ok(text.zh[key].length > 0, 'TEXT.zh[' + key + '] must not be empty')
    assert.ok(text.en[key].length > 0, 'TEXT.en[' + key + '] must not be empty')
    if (/[\u4e00-\u9fff]/.test(text.en[key])) assert.fail('TEXT.en[' + key + '] must not contain Chinese copy: ' + text.en[key])
  }
  // No ASCII Chinese leakage in the English dictionary except documented tokens.
  for (const key of ['tabs.overview', 'cycles.search', 'progress.stage.attacker', 'evidence.title', 'cost.title', 'export.title']) {
    assert.ok(text.zh[key] && text.en[key], 'TEXT must define ' + key + ' in both languages')
  }
  // Chinese dictionary may keep the tool name in latin script only where intended.
  assert.ok(!/console|retry/i.test(text.zh['progress.running']), 'zh copy must not fall back to English words')
})

test('locale files carry the same UI dictionaries plus localized metadata', () => {
  const text = readEmbeddedText()
  assert.equal(localeEn.meta.title, 'Red-Team Review Console')
  assert.equal(localeZh.meta.title, '红队评审台')
  for (const [name, locale] of [['en', localeEn], ['zh', localeZh]]) {
    assert.ok(locale.meta, name + '.json must have a meta object')
    assert.equal(typeof locale.meta.description, 'string', name + '.json meta.description must be a string')
    assert.ok(locale.meta.description.includes('95/100'), name + '.json must advertise the 95/100 stop gate')
    assert.ok(locale.ui && typeof locale.ui === 'object', name + '.json must carry the UI dictionary')
  }
  assert.deepEqual(localeEn.ui, text.en, 'locale/en.json ui dictionary must match the embedded TEXT.en')
  assert.deepEqual(localeZh.ui, text.zh, 'locale/zh.json ui dictionary must match the embedded TEXT.zh')
})

test('client renders the 95/100 pass line, not the legacy 9/10 scale', () => {
  const text = readEmbeddedText()
  assert.match(client, /var REQUIRED_SCORE_FALLBACK = 95/)
  for (const lang of ['zh', 'en']) {
    assert.equal(text[lang]['gate.scoreOfTen'], '/ 100', 'TEXT.' + lang + " must render '/ 100'")
    assert.ok(text[lang]['gate.scoreAria'].includes('100'), 'TEXT.' + lang + ' gate aria must say 100 is the max')
    assert.ok(text[lang]['empty.step3'].includes('95/100'), 'TEXT.' + lang + ' empty.step3 must mention 95/100')
    assert.ok(!text[lang]['empty.step3'].includes('9/10'), 'TEXT.' + lang + ' empty.step3 must not keep 9/10')
  }
  assert.ok(client.includes('var markerPercent = clamp(info.requiredScore, 0, 100)'))
  assert.ok(client.includes("'aria-valuemax': 100"))
})

// ---------------------------------------------------------------------------
// Pure helper behaviour (the shipped functions, evaluated from client.js)
// ---------------------------------------------------------------------------

function fixtureCycle(overrides) {
  const cycle = {
    id: 'c-1',
    target: 'C:/work/demo-tarot-app',
    title: 'Demo Tarot',
    createdAt: 1740000000000,
    updatedAt: 1750000000000,
    status: 'reviewing',
    required: { score: 95, findings: 3, shots: 4 },
    reopenCount: 0,
    rounds: [
      {
        n: 1,
        status: 'completed',
        startedAt: 1740000000000,
        finishedAt: 1740000060000,
        profile: 'web',
        shots: [{ file: 'r1-s1-home.png', width: 1440, height: 900, bytes: 2048 }],
        attack: {
          verdict: 'HOLD',
          findings: [
            { severity: 'BLOCKER', title: 'Broken CTA', evidence: 'button#cta hidden', attack: 'click draw', impact: 'cannot draw', fix: 'raise z-index', confidence: 'high', verified: true },
            { severity: 'MAJOR', title: 'Low contrast', evidence: 'ratio 1.9:1', confidence: 'medium' },
            { severity: 'MINOR', title: 'Spacing drift', evidence: 'gap 3px', confidence: 'low' }
          ],
          solid: ['draw works'],
          unverified: [{ item: 'Mobile layout', needs: '375px shot' }]
        },
        score: { score: 82.5, verdict: 'HOLD', findingsCount: 3, mustFix: ['Fix CTA', 'fix cta', 'Contrast'], validFindings: [{ title: 'Broken CTA', supported: true, note: 'reproduced' }] },
        gate: { passed: false, score: 82.5, requiredScore: 95, findings: 3, requiredFindings: 3, shots: 4, requiredShots: 4, failReasons: ['评分 82.5 < 95'] }
      },
      {
        n: 2,
        status: 'completed',
        startedAt: 1740000100000,
        finishedAt: 1740000200000,
        profile: 'web',
        shots: [{ file: 'r2-s1-home.png', width: 1440, height: 900 }],
        attack: { verdict: 'PASS', findings: [] },
        score: { score: 96, verdict: 'PASS', findingsCount: 3, mustFix: [], validFindings: [] },
        gate: { passed: true, score: 96, requiredScore: 95, findings: 3, requiredFindings: 3, shots: 4, requiredShots: 4, failReasons: [] },
        judges: [{ sessionId: 'judge-a', score: 96 }, { sessionId: 'judge-b', score: 94 }]
      }
    ]
  }
  return Object.assign(cycle, overrides || {})
}

test('filterCycles searches title/target/id and filters by host status', () => {
  const cycles = [
    fixtureCycle({ id: 'c-1', title: 'Tarot shop', target: 'C:/work/tarot', status: 'reviewing' }),
    fixtureCycle({ id: 'c-2', title: 'Model report', target: 'C:/work/model', status: 'passed' }),
    null,
    'nope'
  ]
  assert.equal(pure.filterCycles(cycles, '', 'all').length, 2)
  assert.deepEqual(pure.filterCycles(cycles, 'tarot', 'all').map((cycle) => cycle.id), ['c-1'])
  assert.deepEqual(pure.filterCycles(cycles, 'C:/WORK/MODEL', 'all').map((cycle) => cycle.id), ['c-2'])
  assert.deepEqual(pure.filterCycles(cycles, 'c-1', 'all').map((cycle) => cycle.id), ['c-1'])
  assert.deepEqual(pure.filterCycles(cycles, '', 'passed').map((cycle) => cycle.id), ['c-2'])
  assert.deepEqual(pure.filterCycles(cycles, 'tarot', 'passed'), [])
  assert.deepEqual(pure.filterCycles(cycles, '', 'bogus').length, 2)
})

test('sortCycles supports updated-desc/asc and score-desc', () => {
  const older = fixtureCycle({ id: 'old', updatedAt: 1000, rounds: [] })
  const newer = fixtureCycle({ id: 'new', updatedAt: 9000 })
  assert.deepEqual(pure.sortCycles([older, newer], 'updated-desc').map((cycle) => cycle.id), ['new', 'old'])
  assert.deepEqual(pure.sortCycles([older, newer], 'updated-asc').map((cycle) => cycle.id), ['old', 'new'])
  assert.deepEqual(pure.sortCycles([older, newer], 'score-desc').map((cycle) => cycle.id), ['new', 'old'])
  assert.deepEqual(pure.sortCycles([older, newer], 'whatever').map((cycle) => cycle.id), ['new', 'old'])
})

test('statusBadge summarizes score, gate, rounds, profile and reopen count', () => {
  const badge = pure.statusBadge(fixtureCycle({ reopenCount: 2, reopenedFrom: 1 }))
  assert.equal(badge.status, 'reviewing')
  assert.equal(badge.labelKey, 'cycles.status.reviewing')
  assert.equal(badge.rounds, 2)
  assert.equal(badge.latestRound, 2)
  assert.equal(badge.score, 96)
  assert.equal(badge.gatePassed, true)
  assert.equal(badge.profile, 'web')
  assert.equal(badge.reopenCount, 2)
  assert.equal(badge.reopenedFrom, 1)
  const empty = pure.statusBadge({ id: 'x', status: 'passed', rounds: [] })
  assert.equal(empty.status, 'passed')
  assert.equal(empty.rounds, 0)
  assert.equal(empty.score, null)
})

test('severity ordering, grouping and findings search/filter', () => {
  assert.deepEqual(pure.severityOrder(), ['BLOCKER', 'MAJOR', 'MINOR'])
  assert.equal(pure.normalizeSeverity('blocker'), 'BLOCKER')
  assert.equal(pure.normalizeSeverity('critical'), 'MINOR')
  const findings = fixtureCycle().rounds[0].attack.findings
  const groups = pure.groupFindings(findings)
  assert.deepEqual(Object.keys(groups), ['BLOCKER', 'MAJOR', 'MINOR'])
  assert.equal(groups.BLOCKER.length, 1)
  assert.equal(groups.MAJOR.length, 1)
  assert.equal(groups.MINOR.length, 1)
  assert.equal(pure.filterFindings(findings, '', 'all').length, 3)
  assert.equal(pure.filterFindings(findings, '', 'BLOCKER').length, 1)
  assert.equal(pure.filterFindings(findings, 'z-index', 'all').length, 1)
  assert.equal(pure.filterFindings(findings, 'ratio', 'MAJOR').length, 1)
  assert.equal(pure.filterFindings(findings, 'nothing here', 'all').length, 0)
})

test('mustFix dedupe is case-insensitive and keeps the first spelling', () => {
  assert.deepEqual(pure.dedupeStrings(['Fix CTA', 'fix cta', '  ', 'Contrast', 'CONTRAST']), ['Fix CTA', 'Contrast'])
  assert.deepEqual(pure.cleanStringList(['a', 2, null, ' b ']), ['a', '2', 'b'])
})

test('formatScoreText / formatCountText / formatDuration stay clean and local', () => {
  assert.equal(pure.formatScoreText(95, '—'), '95')
  assert.equal(pure.formatScoreText(94.5, '—'), '94.5')
  assert.equal(pure.formatScoreText(null, '—'), '—')
  assert.equal(pure.formatScoreText('88', '—'), '88')
  assert.equal(pure.formatCountText(3), '3')
  assert.equal(pure.formatCountText(null, '—'), '—')
  assert.equal(pure.formatDuration(0), '0ms')
  assert.equal(pure.formatDuration(450), '450ms')
  assert.equal(pure.formatDuration(1500), '1.5s')
  assert.equal(pure.formatDuration(25000), '25s')
  assert.equal(pure.formatDuration(125000), '2m 05s')
  assert.equal(pure.formatDuration(3720000), '1h 02m')
  assert.equal(pure.formatDuration(null), '')
  assert.equal(pure.formatDuration(-5), '')
})

test('normalizeGate uses the 95 fallback and supports partial legacy rounds', () => {
  const cycle = fixtureCycle()
  const complete = pure.normalizeGate(cycle, cycle.rounds[1])
  assert.equal(complete.score, 96)
  assert.equal(complete.requiredScore, 95)
  assert.equal(complete.passed, true)
  assert.equal(complete.verdict, 'PASS')
  const legacy = pure.normalizeGate(cycle, { n: 3, status: 'completed', attack: { findings: [{ severity: 'MAJOR' }] }, score: { score: 70 } })
  assert.equal(legacy.score, 70)
  assert.equal(legacy.findings, 1)
  assert.equal(legacy.passed, false)
  assert.equal(pure.normalizeGate(null, null).requiredScore, 95)
})

test('normalizeState tolerates malformed payloads', () => {
  assert.equal(pure.normalizeState(null).ok, false)
  assert.equal(pure.normalizeState({ ok: false, error: 'boom' }).error, 'boom')
  assert.equal(pure.normalizeState({ ok: 'yes' }).ok, false)
  const ok = pure.normalizeState({ ok: true, cycles: [{ id: 'a' }, null, 3], generatedAt: '123', version: 2 })
  assert.equal(ok.ok, true)
  assert.equal(ok.cycles.length, 1)
  assert.equal(ok.generatedAt, 123)
  assert.equal(ok.version, 2)
})

test('progress stages normalize, percent-map and parse SSE payloads', () => {
  assert.equal(pure.normalizeStage('ATTACKER'), 'attacker')
  assert.equal(pure.normalizeStage('cancelled'), 'cancelled')
  assert.equal(pure.normalizeStage('bogus'), '')
  assert.equal(pure.stagePercent('evidence'), 15)
  assert.equal(pure.stagePercent('judge'), 70)
  assert.equal(pure.stagePercent('done'), 100)
  assert.equal(pure.stagePercent('bogus'), 0)
  assert.equal(pure.progressLabelKey({ stage: 'attacker' }), 'progress.stage.attacker')
  assert.equal(pure.progressLabelKey({ stage: 'done', cancelled: true }), 'progress.cancelled')
  assert.equal(pure.progressLabel({ stage: 'judge' }, (key) => 'T:' + key), 'T:progress.stage.judge')
  const parsed = pure.parseProgressPayload('{"cycleId":"c-1","round":2,"stage":"judge","updatedAt":99,"done":false}')
  assert.equal(parsed.cycleId, 'c-1')
  assert.equal(parsed.round, 2)
  assert.equal(parsed.stage, 'judge')
  assert.equal(parsed.done, false)
  assert.equal(pure.parseProgressPayload('not json'), null)
  assert.equal(pure.parseProgressPayload({ ok: false, cycleId: 'c-1', error: 'unknown cycle' }), null)
  assert.equal(pure.parseProgressPayload('{"stage":"judge"}'), null)
  assert.equal(pure.parseProgressPayload('{"cycleId":"c-1","stage":"cancelled"}').done, true)
})

test('progressOf derives a progress view from round status for legacy state', () => {
  const running = pure.progressOf({ n: 1, status: 'running', startedAt: 5 }, null)
  assert.equal(running.stage, 'evidence')
  assert.equal(running.derived, true)
  assert.equal(running.done, false)
  const failed = pure.progressOf({ n: 1, status: 'failed', finishedAt: 9, error: 'boom' }, null)
  assert.equal(failed.cancelled, true)
  assert.equal(failed.detail, 'boom')
  const raw = pure.progressOf({ n: 2, status: 'running', progress: { stage: 'judge', updatedAt: 7, detail: 'scoring' } }, null)
  assert.equal(raw.stage, 'judge')
  assert.equal(raw.derived, false)
  assert.equal(pure.isRoundRunning({ status: 'running' }), true)
  assert.equal(pure.isRoundRunning({ status: 'completed' }), false)
  assert.equal(pure.cyclesHaveRunningRound([{ rounds: [{ status: 'running' }] }]), true)
  assert.equal(pure.cyclesHaveRunningRound([{ rounds: [{ status: 'completed' }] }]), false)
})

test('diff payloads normalize and produce per-round badges', () => {
  const diff = pure.normalizeDiff({
    ok: true,
    cycleId: 'c-1',
    rounds: [{ n: 1, score: 82.5, passed: false }, { n: 2, score: 96, passed: true }],
    changes: [
      { key: 'k1', title: 'Broken CTA', severity: 'blocker', status: 'new', firstRound: 1, lastRound: 1 },
      { key: 'k2', title: 'Low contrast', severity: 'MAJOR', status: 'severity-changed', firstRound: 1, lastRound: 2 },
      { key: 'k3', title: 'Spacing drift', severity: 'MINOR', status: 'fixed', firstRound: 1, lastRound: 1 }
    ]
  })
  assert.equal(diff.rounds.length, 2)
  assert.equal(diff.changes[0].severity, 'BLOCKER')
  assert.equal(pure.diffBadge({ status: 'severity-changed' }).labelKey, 'diff.status.severityChanged')
  assert.equal(pure.diffBadge({ status: 'severity-changed' }).tone, 'changed')
  assert.equal(pure.diffBadge({ status: 'bogus' }), null)
  const summary = pure.diffSummaryForRound(diff, 2)
  assert.equal(summary.repeat, 0)
  assert.equal(summary.severityChanged, 1)
  assert.equal(summary.fixed, 1)
  const map = pure.diffChangeMap(diff)
  assert.equal(map['low contrast'].status, 'severity-changed')
  assert.equal(pure.normalizeDiff(null), null)
})

test('route builders encode parameters and fall back safely', () => {
  assert.equal(pure.exportUrl('c 1', 'md'), '/adversarial-review/export?cycleId=c%201&format=md')
  assert.equal(pure.exportUrl('c-1', 'json'), '/adversarial-review/export?cycleId=c-1&format=json')
  assert.equal(pure.exportUrl('c-1', 'exe'), '/adversarial-review/export?cycleId=c-1&format=md')
  assert.equal(pure.shotUrl('c-1', 'r1-s1-home.png'), '/adversarial-review/shot?cycleId=c-1&file=r1-s1-home.png')
  assert.match(pure.artifactUrl('c-1', '../evil.txt'), /^\/adversarial-review\/artifact\?cycleId=c-1&file=/)
  assert.ok(!pure.artifactUrl('c-1', '../evil.txt').includes('..'))
  assert.equal(pure.diffUrl('c-1'), '/adversarial-review/diff?cycleId=c-1')
  assert.equal(pure.progressUrl('c-1'), '/adversarial-review/progress?cycleId=c-1')
  assert.equal(pure.cancelUrl('c-1'), '/adversarial-review/cancel?cycleId=c-1')
  const shotFiles = ['r1-s1-home.png']
  assert.equal(pure.artifactPreviewUrl('c-1', 'r1-s1-home.png', shotFiles), '/adversarial-review/shot?cycleId=c-1&file=r1-s1-home.png')
  assert.equal(pure.artifactPreviewUrl('c-1', 'r1-e1-start.png', shotFiles), '/adversarial-review/artifact?cycleId=c-1&file=r1-e1-start.png')
})

test('artifact naming helpers sanitize hostile names and label kinds', () => {
  assert.equal(pure.safeFileName('C:\\evidence\\r1-c1.png'), 'r1-c1.png')
  assert.equal(pure.safeFileName('../../etc/passwd'), 'passwd')
  assert.equal(pure.safeFileName(''), '')
  assert.equal(pure.shortSha('abcdef0123456789'), 'abcdef0123...')
  assert.equal(pure.shortSha('abc'), 'abc')
  assert.equal(pure.shortSha(null), '')
  assert.equal(pure.artifactKindKey('text'), 'evidence.type.text')
  assert.equal(pure.artifactKindKey('log'), 'evidence.type.log')
  assert.equal(pure.artifactKindKey('screenshot'), 'evidence.kind.screenshot')
  assert.equal(pure.artifactKindKey('pdf-text'), 'evidence.kind.pdf-text')
  assert.equal(pure.artifactKindKey('bogus'), 'evidence.type.file')
  assert.equal(pure.artifactLabel({ file: 'r1-x.png' }), 'r1-x.png')
  assert.equal(pure.artifactLabel({ stepName: 'start screen', file: 'x.png' }), 'start screen')
  assert.equal(pure.isImageArtifact({ file: 'a.png' }), true)
  assert.equal(pure.isImageArtifact({ file: 'a.txt' }), false)
  assert.equal(pure.isTextArtifact({ file: 'console.log' }), true)
  assert.equal(pure.isTextArtifact({ file: 'a.png', kind: 'screenshot' }), false)
  assert.equal(pure.evidenceKind('pdf-page'), 'screenshot')
  assert.equal(pure.evidenceKind('interaction'), 'interaction')
})

test('evidenceCards groups artifacts per card and falls back to shots', () => {
  const round = {
    evidence: [
      {
        index: 0,
        name: 'start',
        kind: 'interaction',
        artifacts: [
          { file: 'C:/shots/r2-c1-start.png', width: 1280, height: 720, kind: 'screenshot' },
          { file: 'C:/logs/console.log', kind: 'log' },
          { file: 'C:/logs/network.json', kind: 'json' }
        ],
        consoleErrors: 2,
        networkFailures: 1,
        perfFps: 58.4
      },
      { index: 1, name: 'chart', kind: 'image', artifacts: [{ file: 'chart.png', width: 800, height: 600, kind: 'image' }] }
    ]
  }
  const cards = pure.evidenceCards(round)
  assert.equal(cards.length, 2)
  assert.equal(cards[0].artifactCount, 3)
  assert.equal(cards[0].artifacts.length, 3)
  assert.equal(cards[0].artifacts[0].file, 'r2-c1-start.png')
  assert.equal(cards[0].consoleErrors, 2)
  assert.equal(cards[0].perfFps, 58.4)
  assert.equal(pure.extraArtifactsOf(cards[0]).length, 2)
  const counts = pure.evidenceKindCounts(round)
  assert.deepEqual(counts, [{ kind: 'interaction', count: 1 }, { kind: 'image', count: 1 }])
  // legacy rounds have no evidence cards; shots become screenshot cards.
  const legacy = pure.evidenceCards({ shots: [{ file: 'r1-s1-a.png', width: 10, height: 20 }] })
  assert.equal(legacy.length, 1)
  assert.equal(legacy[0].kind, 'screenshot')
  assert.equal(legacy[0].artifacts[0].width, 10)
  assert.equal(pure.evidenceCards({}).length, 0)
})

test('noise, cost and incremental views normalize host payloads', () => {
  const noise = pure.noiseInfo({ noise: { rawFindings: 12, dedupedFindings: 7, suppressedCount: 4, knownRepeats: 2 } })
  assert.equal(noise.hasData, true)
  assert.equal(noise.rawFindings, 12)
  assert.equal(noise.suppressedCount, 4)
  // host v1.3 publishes the suppressed entries themselves; count them when the
  // aggregate count is absent and keep titles/reasons for the UI.
  const hostNoise = pure.noiseInfo({
    noise: { rawFindings: 9, dedupedFindings: 6, knownRepeats: 1, suppressed: [{ title: 'dup A', reason: 'repeat' }, { key: 'dup B' }] }
  })
  assert.equal(hostNoise.suppressedCount, 2)
  assert.equal(hostNoise.suppressed.length, 2)
  assert.equal(hostNoise.suppressed[0].title, 'dup A')
  assert.equal(hostNoise.suppressed[1].title, 'dup B')
  assert.equal(pure.noiseInfo({}).hasData, false)
  const cost = pure.costInfo({
    cost: { totalMs: 90000, evidenceMs: 20000, attackMs: 40000, judgeMs: 30000, promptChars: 12345, judgePromptChars: 6789 },
    judges: [{ score: 90 }, { score: 94 }],
    evidence: [{ index: 0, name: 'a', artifacts: [{ file: 'x.png' }, { file: 'y.txt' }] }]
  })
  assert.equal(cost.totalMs, 90000)
  assert.equal(cost.evidenceMs, 20000)
  assert.equal(cost.promptChars, 12345)
  assert.equal(cost.judgeSamples, 2)
  assert.equal(cost.artifactCount, 2)
  const fallback = pure.costInfo({ timings: { shotsMs: 1000, attackMs: 2000, judgeMs: 3000 } })
  assert.equal(fallback.totalMs, 6000)
  assert.equal(fallback.hasData, true)
  assert.equal(pure.costInfo({}).hasData, false)
  const inc = pure.incrementalInfo({
    incremental: { mode: 'changed-only', baseRound: 1, changedFiles: ['a.js'], addedFiles: ['b.js'], removedFiles: [], truncated: true, fullReview: false }
  })
  assert.equal(inc.hasData, true)
  assert.equal(inc.mode, 'changed-only')
  assert.equal(inc.modeKey, '')
  assert.equal(pure.incrementalModeKey('incremental'), 'overview.incremental.modeValue.incremental')
  assert.equal(pure.incrementalModeKey('reopen'), 'overview.incremental.modeValue.reopen')
  assert.equal(pure.incrementalModeKey('bogus'), '')
  const hostIncremental = pure.incrementalInfo({
    incremental: { mode: 'reopen', baseCycleId: 'c-0', baseRound: 2, changedFiles: [], unchangedCount: 43, fullReview: true }
  })
  assert.equal(hostIncremental.modeKey, 'overview.incremental.modeValue.reopen')
  assert.equal(hostIncremental.unchangedCount, 43)
  assert.equal(hostIncremental.baseCycleId, 'c-0')
  assert.equal(hostIncremental.fullReview, true)
  assert.equal(inc.baseRound, 1)
  assert.deepEqual(inc.changedFiles, ['a.js'])
  assert.equal(inc.truncated, true)
  assert.equal(pure.incrementalInfo({}).hasData, false)
})

test('judge sessions and disagreement are derived defensively', () => {
  const judges = pure.judgesOf({ judges: [{ sessionId: 'a', score: 90 }, { score: 96 }] })
  assert.equal(judges.length, 2)
  assert.equal(judges[1].score, 96)
  assert.equal(pure.judgeSamplesOf({ judges: [{}, {}] }), 2)
  assert.equal(pure.judgeSamplesOf({}), null)
  assert.equal(pure.disagreementOf({ judges: [{ score: 90 }, { score: 96 }] }), 6)
  assert.equal(pure.disagreementOf({ score: { disagreement: 2.5 } }), 2.5)
  // host v1.1 aggregation stores { scoreSpread, mustFixMismatch, verdictMismatch, disagree }
  assert.equal(pure.disagreementOf({ score: { disagreement: { scoreSpread: 7.5, disagree: true } } }), 7.5)
  assert.equal(pure.disagreementOf({ judges: [{ score: 90 }] }), null)
  const ids = pure.sessionIdsOf({ attackerSessionId: 'atk', judgeSessionIds: ['j1', 'j1', 'j2'] })
  assert.equal(ids.attackerSessionId, 'atk')
  assert.deepEqual(ids.judgeSessionIds, ['j1', 'j2'])
})

test('profiles, judging marks and titles normalize unknown values', () => {
  assert.equal(pure.profileKey('GAME'), 'profile.game')
  assert.equal(pure.profileKey('desktop'), '')
  assert.equal(pure.profileOf({ profile: 'modeling' }, {}), 'modeling')
  assert.equal(pure.profileOf({ score: { profile: 'web' } }, {}), 'web')
  assert.equal(pure.profileOf({}, { profile: 'code' }), 'code')
  const mark = pure.judgeVerdictForTitle([{ title: 'Broken  CTA', supported: true, note: 'ok' }], 'broken cta')
  assert.equal(mark.supported, true)
  assert.equal(mark.note, 'ok')
  assert.equal(pure.judgeVerdictForTitle([{ title: 'x', supported: false }], 'x').supported, false)
  assert.equal(pure.countSupportedFindings([{ supported: true }, { supported: false }, null]), 1)
  assert.equal(pure.verdictKey('hold'), 'verdict.HOLD')
  assert.equal(pure.verdictKey('bogus'), '')
  assert.equal(pure.roundNumberOf({ n: 4 }, 0), 4)
  assert.equal(pure.roundNumberOf({}, 2), 3)
  assert.equal(pure.latestRoundEntry(pure.sortRoundEntries([{ n: 2 }, { n: 1 }])).number, 2)
})

test('cycle entry keys are stable for the rail and selection', () => {
  const entries = pure.cycleEntriesFrom([{ id: 'c-1', rounds: [] }, { rounds: [] }, null])
  assert.equal(entries.length, 2)
  assert.equal(entries[0].key, 'c-1')
  assert.equal(entries[1].key, '@1')
  assert.equal(pure.findCycleEntry(entries, 'c-1').cycle.id, 'c-1')
  assert.equal(pure.findCycleEntry(entries, 'missing'), null)
  const rounds = pure.sortRoundEntries([{ n: 2 }, { n: 1 }])
  assert.equal(pure.findRoundEntry(rounds, 1).number, 1)
  assert.equal(pure.findRoundEntry(rounds, 99).number, 2)
})

test('icon is an original 24x24 currentColor glyph without scripts or external refs', () => {
  const icon = readFileSync(join(root, 'icon.svg'), 'utf8')
  assert.match(icon, /viewBox="0 0 24 24"/)
  assert.ok(icon.includes('currentColor'))
  assert.ok(!/<script/i.test(icon))
  assert.ok(!/\bhref\s*=/i.test(icon))
  assert.ok(!/\bsrc\s*=/i.test(icon))
})
