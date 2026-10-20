/**
 * v1.2 2.1 evidence-framework tests.
 *
 * Pure-logic coverage: card normalization (4 cards / exclusivity / steps /
 * 白名单 / limits), legacy shots mapping, all-screenshot + mixed rendering,
 * artifact naming/sha256/cleanup, verification (tamper detection) and the
 * compact/manifest projections used by prompts and the tool result.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { deflateSync } from 'node:zlib'

import { LIMITS } from '../lib/constants.js'
import {
  buildCompactEvidence,
  buildEvidenceFromShots,
  buildEvidenceManifest,
  emptyEvidenceMeta,
  normalizeEvidenceCards,
  normalizeEvidenceMeta,
  normalizeShotSpecsToCards,
  renderEvidenceCards,
  renderImageEvidenceCard,
  renderPdfTextEvidenceCard,
  representativeArtifact,
  shotFromArtifact,
  toInteractionCard,
  verifyEvidenceArtifacts,
} from '../lib/evidence.js'
import { buildExtraArtifactFilename, resolveKeyDefinition } from '../lib/cdp.js'
import { buildShotFilename, slugifyName } from '../lib/shots.js'

const TARGET = process.platform === 'win32' ? 'C:\\demo' : '/demo'

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Synthesize a >1KB buffer with a valid PNG signature + IHDR of the given size. */
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

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rtc-evidence-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

function card(overrides = {}) {
  return {
    kind: 'screenshot',
    path: 'index.html',
    width: 1440,
    height: 900,
    name: 'home',
    ...overrides,
  }
}

function fourCards(overrides = {}) {
  return [
    card({ name: 'start', ...(overrides[0] ?? {}) }),
    card({ name: 'play', ...(overrides[1] ?? {}) }),
    card({ name: 'menu', ...(overrides[2] ?? {}) }),
    card({ name: 'end', ...(overrides[3] ?? {}) }),
  ]
}

function interactionCard(overrides = {}) {
  return card({
    kind: 'interaction',
    name: 'playthrough',
    steps: [
      { action: 'click', selector: '#start' },
      { action: 'key', key: 'Space' },
      { action: 'wait', ms: 50 },
      { action: 'screenshot', name: 'playing' },
    ],
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

test('normalizeEvidenceCards accepts four mixed cards with defaults and resolves paths/urls', () => {
  const result = normalizeEvidenceCards([
    card(),
    interactionCard({ name: 'boss-fight', width: 900, height: 700 }),
    card({ path: 'public/menu.html', name: 'menu' }),
    { kind: 'screenshot', url: 'http://127.0.0.1:3000/end', name: 'end' },
  ], { targetDir: TARGET, requiredEvidence: 4, allowedOrigins: [] })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.cards.length, 4)
  const [first, second, third, fourth] = result.cards
  assert.equal(first.kind, 'screenshot')
  assert.equal(first.width, 1440)
  assert.equal(first.height, 900)
  assert.equal(first.page, 'index.html')
  assert.match(first.url, /^file:\/\//)
  assert.equal(path.isAbsolute(first.path), true)
  assert.deepEqual(first.collect, { console: true, network: true, perf: true })
  assert.equal(second.kind, 'interaction')
  assert.equal(second.width, 900)
  assert.equal(second.steps.length, 4)
  assert.deepEqual(second.steps[1], { action: 'key', key: 'Space' })
  assert.equal(third.path, path.resolve(TARGET, 'public', 'menu.html'))
  assert.equal(fourth.path, null)
  assert.equal(fourth.url, 'http://127.0.0.1:3000/end')
})

test('normalizeEvidenceCards rejects wrong count / unknown kind / path-url combinations', () => {
  const base = { targetDir: TARGET }
  assert.match(normalizeEvidenceCards([card()], base).error, /恰好 4 个/)
  assert.match(normalizeEvidenceCards(fourCards([{ kind: 'video' }]), base).error, /kind/)
  assert.match(normalizeEvidenceCards(fourCards([{ path: undefined }]), base).error, /path 或 url/)
  assert.match(normalizeEvidenceCards(fourCards([{ url: 'http://127.0.0.1:1/' }]), base).error, /互斥/)
  assert.match(normalizeEvidenceCards(fourCards([{ path: '..\\..\\Windows\\win.ini' }]), base).error, /target 目录内/)
})

test('normalizeEvidenceCards enforces the http(s) origin allowlist and file/url purity', () => {
  const base = { targetDir: TARGET }
  assert.match(normalizeEvidenceCards(fourCards([{ url: 'https://evil.example.com/', path: undefined }]), base).error, /白名单/)
  assert.match(normalizeEvidenceCards(fourCards([{ url: 'javascript:alert(1)', path: undefined }]), base).error, /http/)
  assert.match(normalizeEvidenceCards(fourCards([{ url: 'file:///c:/secret.txt', path: undefined }]), base).error, /http/)
  const allowed = normalizeEvidenceCards(fourCards([
    { url: 'https://allowed.example.com/a', path: undefined },
    { url: 'http://localhost:8080/b', path: undefined },
    { url: 'http://[::1]:5173/c', path: undefined },
    { url: 'https://allowed.example.com/d', path: undefined },
  ]), { ...base, allowedOrigins: ['https://allowed.example.com'] })
  assert.equal(allowed.ok, true, allowed.error)
})

test('normalizeEvidenceCards validates interaction steps strictly', () => {
  const base = { targetDir: TARGET }
  assert.match(normalizeEvidenceCards([interactionCard({ steps: [{ action: 'eval' }] }), card(), card(), card()], base).error, /action 不合法/)
  const clickMissing = [interactionCard({ steps: [{ action: 'click' }] }), card(), card(), card()]
  assert.match(normalizeEvidenceCards(clickMissing, base).error, /selector/)
  const badKey = [interactionCard({ steps: [{ action: 'key', key: 'F13' }] }), card(), card(), card()]
  assert.match(normalizeEvidenceCards(badKey, base).error, /key/)
  const badWait = [interactionCard({ steps: [{ action: 'wait', ms: -1 }] }), card(), card(), card()]
  assert.match(normalizeEvidenceCards(badWait, base).error, /ms/)
  const gotoBoth = [interactionCard({ steps: [{ action: 'goto', path: 'a.html', url: 'http://127.0.0.1:1/' }] }), card(), card(), card()]
  assert.match(normalizeEvidenceCards(gotoBoth, base).error, /互斥/)
  const tooManySteps = [interactionCard({ steps: Array.from({ length: LIMITS.maxEvidenceStepsPerCard + 1 }, () => ({ action: 'wait', ms: 1 })) }), card(), card(), card()]
  assert.match(normalizeEvidenceCards(tooManySteps, base).error, /最多/)
  // Bounded artifact budget: four interaction cards each with 7 frames = 28 > 24.
  const overBudget = [1, 2, 3, 4].map((index) => interactionCard({
    name: `play-${index}`,
    steps: Array.from({ length: 7 }, (_unused, stepIndex) => ({ action: 'screenshot', name: `frame-${stepIndex}` })),
  }))
  assert.match(normalizeEvidenceCards(overBudget, base).error, /超过上限/)
})

test('normalizeEvidenceCards accepts goto/wait/key/screenshot steps and warns on screenshot steps', () => {
  const result = normalizeEvidenceCards([
    interactionCard({ steps: [
      { action: 'goto', path: 'game.html' },
      { action: 'goto', url: 'http://127.0.0.1:3000/' },
      { action: 'wait' },
      { action: 'screenshot' },
    ] }),
    card({ steps: [{ action: 'click', selector: '#ignored' }] }),
    card(),
    card(),
  ], { targetDir: TARGET, requiredEvidence: 4 })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.cards[0].steps[0].action, 'goto')
  assert.equal(result.cards[0].steps[0].page, 'game.html')
  assert.equal(result.cards[0].steps[1].url, 'http://127.0.0.1:3000/')
  assert.equal(result.cards[0].steps[2].ms, 300)
  assert.equal(result.cards[0].steps[3].name, 'step-4')
  assert.equal(result.cards[1].steps.length, 0)
  assert.ok(result.warnings.some((warning) => warning.includes('steps 已忽略')))
})

test('normalizeShotSpecsToCards maps legacy normalized specs to screenshot cards', () => {
  const cards = normalizeShotSpecsToCards([
    { kind: 'path', path: path.resolve(TARGET, 'index.html'), width: 1440, height: 900, name: 'desktop', page: 'index.html' },
    { kind: 'url', url: 'http://127.0.0.1:3000/', width: 390, height: 844, name: 'mobile', page: 'http://127.0.0.1:3000/' },
  ], { targetDir: TARGET })
  assert.equal(cards.length, 2)
  assert.equal(cards[0].kind, 'screenshot')
  assert.equal(cards[0].page, 'index.html')
  assert.match(cards[0].url, /^file:\/\//)
  assert.equal(cards[1].path, null)
  assert.equal(cards[1].url, 'http://127.0.0.1:3000/')
  assert.equal(cards[1].width, 390)
})

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function makeRenderShots() {
  const calls = []
  const fn = async (options) => {
    calls.push(options)
    const dir = path.join(options.stateDir, 'shots', options.cycleId)
    await mkdir(dir, { recursive: true })
    const offset = Number.isInteger(options.shotIndexOffset) ? options.shotIndexOffset : 0
    const shots = []
    const specs = Array.isArray(options.specs) ? options.specs : []
    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index]
      const file = buildShotFilename(options.roundNo ?? 1, index + offset, spec.name)
      const bytes = pngHeader(spec.width, spec.height)
      await writeFile(path.join(dir, file), bytes)
      shots.push({
        file,
        path: path.join(dir, file),
        url: `file:///${file}`,
        width: spec.width,
        height: spec.height,
        bytes: bytes.length,
        sha256: sha256Buffer(bytes),
        page: spec.page ?? '',
        renderedAt: 1,
      })
    }
    return { ok: true, shots, errors: [], warnings: [] }
  }
  return { fn, calls }
}

function makeInteractionRunner() {
  const calls = []
  const fn = async (options) => {
    calls.push(options)
    const { card: interaction } = options
    const dir = options.outDir
    await mkdir(dir, { recursive: true })
    const frameCount = Math.max(1, (interaction.steps || []).filter((step) => step.action === 'screenshot').length)
    const artifacts = []
    for (let position = 1; position <= frameCount; position += 1) {
      const name = position === 1 ? interaction.name : `frame-${position}`
      const file = position === 1
        ? buildShotFilename(options.roundNo, options.shotIndex - 1, name)
        : buildExtraArtifactFilename(options.roundNo, options.shotIndex, position, name)
      const bytes = pngHeader(interaction.width, interaction.height)
      await writeFile(path.join(dir, file), bytes)
      artifacts.push({
        file,
        path: path.join(dir, file),
        width: interaction.width,
        height: interaction.height,
        bytes: bytes.length,
        sha256: sha256Buffer(bytes),
        mime: 'image/png',
        kind: 'screenshot',
        stepName: position === 1 ? null : name,
      })
    }
    return {
      ok: true,
      artifacts,
      meta: {
        url: interaction.url,
        page: interaction.page,
        console: { events: ['error: boom'], errors: 2, truncated: false },
        network: { requests: 9, failures: 1, truncated: false, failureSamples: ['404 GET /missing.js'] },
        perf: { metrics: { JSHeapUsedSize: 1234 }, fps: 57.5 },
        steps: (interaction.steps || []).map((step) => ({ action: step.action, ok: true })),
      },
    }
  }
  return { fn, calls }
}

test('renderEvidenceCards all-screenshot plan uses ONE renderShots call and keeps legacy names', async (t) => {
  const dir = await tempDir(t)
  const { fn, calls } = makeRenderShots()
  const result = await renderEvidenceCards({
    specs: [
      { kind: 'path', path: path.resolve(TARGET, 'index.html'), width: 1440, height: 900, name: 'desktop', page: 'index.html' },
      { kind: 'path', path: path.resolve(TARGET, 'index.html'), width: 1280, height: 800, name: 'laptop', page: 'index.html' },
      { kind: 'path', path: path.resolve(TARGET, 'index.html'), width: 768, height: 1024, name: 'tablet', page: 'index.html' },
      { kind: 'path', path: path.resolve(TARGET, 'index.html'), width: 390, height: 844, name: 'mobile', page: 'index.html' },
    ],
    targetDir: TARGET,
    stateDir: dir,
    cycleId: 'c-test',
    roundNo: 1,
    requiredEvidence: 4,
    config: {},
    renderShotsImpl: fn,
    now: () => 42,
  })
  assert.equal(result.ok, true, result.error)
  // One batched call = the pre-v1.2 screenshot behaviour.
  assert.equal(calls.length, 1)
  assert.equal(calls[0].specs.length, 4)
  assert.equal(result.evidence.length, 4)
  assert.equal(result.artifactsCount, 4)
  assert.deepEqual(result.shots.map((shot) => shot.file), [
    'r1-s1-desktop.png', 'r1-s2-laptop.png', 'r1-s3-tablet.png', 'r1-s4-mobile.png',
  ])
  for (const card of result.evidence) {
    assert.equal(card.kind, 'screenshot')
    assert.equal(card.artifacts.length, 1)
    assert.match(card.artifacts[0].sha256, /^[0-9a-f]{64}$/)
  }
  const verification = await verifyEvidenceArtifacts({
    evidence: result.evidence,
    shotsDir: path.join(dir, 'shots', 'c-test'),
    requiredEvidence: 4,
  })
  assert.equal(verification.ok, true, verification.error)
  assert.equal(verification.artifacts, 4)
})

test('renderEvidenceCards mixed plan renders per-card with shotIndexOffset and extra frames', async (t) => {
  const dir = await tempDir(t)
  const renderShots = makeRenderShots()
  const interactionRunner = makeInteractionRunner()
  const result = await renderEvidenceCards({
    cards: [
      { ...card({ name: 'start' }), index: 0, slug: 'start', collect: { console: false, network: false, perf: false }, steps: [] },
      { ...interactionCard(), index: 1, slug: 'playthrough', width: 900, height: 700, collect: { console: true, network: true, perf: true } },
      { ...card({ name: 'menu' }), index: 2, slug: 'menu', collect: { console: false, network: false, perf: false }, steps: [] },
      { ...card({ name: 'end' }), index: 3, slug: 'end', collect: { console: false, network: false, perf: false }, steps: [] },
    ],
    targetDir: TARGET,
    stateDir: dir,
    cycleId: 'c-test',
    roundNo: 2,
    requiredEvidence: 4,
    config: {},
    renderShotsImpl: renderShots.fn,
    runInteractionCardImpl: interactionRunner.fn,
    now: () => 7,
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.shots.length, 4)
  assert.equal(result.evidence[1].kind, 'interaction')
  assert.equal(result.evidence[1].meta.console.errors, 2)
  assert.equal(result.evidence[1].meta.network.failures, 1)
  assert.equal(result.evidence[1].meta.perf.fps, 57.5)
  // Representative filenames follow the card index (s1..s4) even when cards
  // are rendered by different engines.
  assert.deepEqual(result.shots.map((shot) => shot.file), [
    'r2-s1-start.png', 'r2-s2-playthrough.png', 'r2-s3-menu.png', 'r2-s4-end.png',
  ])
  const verification = await verifyEvidenceArtifacts({
    evidence: result.evidence,
    shotsDir: path.join(dir, 'shots', 'c-test'),
    requiredEvidence: 4,
  })
  assert.equal(verification.ok, true, verification.error)
  const manifest = buildEvidenceManifest(result.evidence)
  assert.equal(manifest[1].kind, 'interaction')
  assert.equal(manifest[1].consoleErrors, 2)
  assert.equal(manifest[1].networkFailures, 1)
  assert.equal(manifest[1].fps, 57.5)
  const compact = buildCompactEvidence(result.evidence)
  assert.equal(compact.cardCount, 4)
  assert.equal(compact.consoleErrors, 2)
  assert.equal(compact.networkFailures, 1)
  assert.equal(compact.artifactCount, 4)
})

test('renderEvidenceCards cleans only this round\'s leftover artifacts', async (t) => {
  const dir = await tempDir(t)
  const shotDir = path.join(dir, 'shots', 'c-test')
  await mkdir(shotDir, { recursive: true })
  await writeFile(path.join(shotDir, 'r1-s1-stale.png'), 'old')
  await writeFile(path.join(shotDir, 'r1-s2-stale.json'), '{}')
  await writeFile(path.join(shotDir, 'r2-s1-other-round.png'), 'keep')
  await writeFile(path.join(shotDir, 'notes.txt'), 'keep')
  const { fn } = makeRenderShots()
  const result = await renderEvidenceCards({
    specs: [
      { kind: 'path', path: path.resolve(TARGET, 'index.html'), width: 1440, height: 900, name: 'a', page: 'index.html' },
      { kind: 'path', path: path.resolve(TARGET, 'index.html'), width: 1280, height: 800, name: 'b', page: 'index.html' },
      { kind: 'path', path: path.resolve(TARGET, 'index.html'), width: 768, height: 1024, name: 'c', page: 'index.html' },
      { kind: 'path', path: path.resolve(TARGET, 'index.html'), width: 390, height: 844, name: 'd', page: 'index.html' },
    ],
    targetDir: TARGET,
    stateDir: dir,
    cycleId: 'c-test',
    roundNo: 1,
    requiredEvidence: 4,
    renderShotsImpl: fn,
  })
  assert.equal(result.ok, true, result.error)
  const files = (await readdir(shotDir)).sort()
  assert.equal(files.includes('r1-s1-stale.png'), false)
  assert.equal(files.includes('r1-s2-stale.json'), false)
  assert.equal(files.includes('r2-s1-other-round.png'), true)
  assert.equal(files.includes('notes.txt'), true)
})

test('renderEvidenceCards surfaces renderer/interaction failures as structured errors', async (t) => {
  const dir = await tempDir(t)
  const failingRenderer = async () => ({ ok: false, shots: [], errors: ['模拟渲染失败'], warnings: [] })
  const failed = await renderEvidenceCards({
    specs: [
      { kind: 'path', path: path.resolve(TARGET, 'index.html'), width: 1440, height: 900, name: 'a', page: 'index.html' },
      { kind: 'path', path: path.resolve(TARGET, 'index.html'), width: 1440, height: 900, name: 'b', page: 'index.html' },
      { kind: 'path', path: path.resolve(TARGET, 'index.html'), width: 1440, height: 900, name: 'c', page: 'index.html' },
      { kind: 'path', path: path.resolve(TARGET, 'index.html'), width: 1440, height: 900, name: 'd', page: 'index.html' },
    ],
    targetDir: TARGET,
    stateDir: dir,
    cycleId: 'c-test',
    roundNo: 1,
    requiredEvidence: 4,
    renderShotsImpl: failingRenderer,
  })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /模拟渲染失败/)

  const { fn: renderer } = makeRenderShots()
  const failingInteraction = async () => ({ ok: false, error: 'selector「#missing」找不到元素', artifacts: [], meta: {} })
  const mixed = await renderEvidenceCards({
    cards: [
      { ...card({ name: 'start' }), index: 0, slug: 'start', collect: {}, steps: [] },
      { ...interactionCard(), index: 1, slug: 'play', collect: {}, steps: [] },
      { ...card({ name: 'menu' }), index: 2, slug: 'menu', collect: {}, steps: [] },
      { ...card({ name: 'end' }), index: 3, slug: 'end', collect: {}, steps: [] },
    ],
    targetDir: TARGET,
    stateDir: dir,
    cycleId: 'c-test-2',
    roundNo: 1,
    requiredEvidence: 4,
    renderShotsImpl: renderer,
    runInteractionCardImpl: failingInteraction,
  })
  assert.equal(mixed.ok, false)
  assert.match(mixed.error, /#missing/)
})

test('renderEvidenceCards rejects missing stateDir / unsafe cycleId without touching browsers', async () => {
  const { fn } = makeRenderShots()
  const noState = await renderEvidenceCards({ specs: [], renderShotsImpl: fn })
  assert.equal(noState.ok, false)
  assert.match(noState.error, /stateDir/)
  const badCycle = await renderEvidenceCards({
    specs: [{ kind: 'path', path: path.resolve(TARGET, 'index.html'), width: 100, height: 100, name: 'a', page: 'index.html' }],
    stateDir: os.tmpdir(),
    cycleId: '../escape',
    renderShotsImpl: fn,
  })
  assert.equal(badCycle.ok, false)
  assert.match(badCycle.error, /cycleId/)
})

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

async function goodEvidence(t) {
  const dir = await tempDir(t)
  const shotDir = path.join(dir, 'shots', 'c-test')
  await mkdir(shotDir, { recursive: true })
  const evidence = []
  for (let index = 0; index < 4; index += 1) {
    const file = `r1-s${index + 1}-shot.png`
    const bytes = pngHeader(1280, 800)
    await writeFile(path.join(shotDir, file), bytes)
    evidence.push({
      index,
      name: `shot-${index + 1}`,
      kind: 'screenshot',
      artifacts: [{
        file,
        path: path.join(shotDir, file),
        width: 1280,
        height: 800,
        bytes: bytes.length,
        sha256: sha256Buffer(bytes),
        mime: 'image/png',
        kind: 'screenshot',
        stepName: null,
      }],
      meta: emptyEvidenceMeta({ page: 'index.html' }),
    })
  }
  return { dir, shotDir, evidence }
}

test('verifyEvidenceArtifacts enforces images, sha256, dimensions and the artifact cap', async (t) => {
  const { dir, shotDir, evidence } = await goodEvidence(t)
  const ok = await verifyEvidenceArtifacts({ evidence, shotsDir: shotDir, requiredEvidence: 4 })
  assert.equal(ok.ok, true, ok.error)
  assert.equal(ok.artifacts, 4)

  const wrongCount = await verifyEvidenceArtifacts({ evidence: evidence.slice(0, 3), shotsDir: shotDir, requiredEvidence: 4 })
  assert.equal(wrongCount.ok, false)
  assert.match(wrongCount.error, /必须恰好 4 张/)

  const noImage = await verifyEvidenceArtifacts({
    evidence: evidence.map((card, index) => (index === 0 ? { ...card, artifacts: [] } : card)),
    shotsDir: shotDir,
    requiredEvidence: 4,
  })
  assert.equal(noImage.ok, false)
  assert.match(noImage.error, /至少 1 张/)

  const noHash = await verifyEvidenceArtifacts({
    evidence: evidence.map((card, index) => (index === 0
      ? { ...card, artifacts: [{ ...card.artifacts[0], sha256: null }] }
      : card)),
    shotsDir: shotDir,
    requiredEvidence: 4,
  })
  assert.equal(noHash.ok, false)
  assert.match(noHash.error, /sha256/)

  // Tamper with one PNG after hashes were recorded.
  const tamperedPath = path.join(shotDir, evidence[2].artifacts[0].file)
  const tampered = Buffer.from(await readFile(tamperedPath))
  tampered[tampered.length - 2] ^= 0xff
  await writeFile(tamperedPath, tampered)
  const tamper = await verifyEvidenceArtifacts({ evidence, shotsDir: shotDir, requiredEvidence: 4 })
  assert.equal(tamper.ok, false)
  assert.match(tamper.error, /sha256/)

  const traversal = await verifyEvidenceArtifacts({
    evidence: evidence.map((card, index) => (index === 0
      ? { ...card, artifacts: [{ ...card.artifacts[0], file: '../escape.png' }] }
      : card)),
    shotsDir: shotDir,
    requiredEvidence: 4,
  })
  assert.equal(traversal.ok, false)
  assert.match(traversal.error, /不合法/)
  assert.equal(path.isAbsolute(dir), true)
})

test('buildEvidenceFromShots maps rendered legacy shots to screenshot cards', () => {
  const shots = [1, 2, 3, 4].map((index) => ({
    file: `r1-s${index}-page-${index}.png`,
    path: `/state/shots/c1/r1-s${index}-page-${index}.png`,
    url: `file:///state/shots/c1/r1-s${index}-page-${index}.png`,
    width: 1440,
    height: 900,
    bytes: 2048,
    sha256: 'a'.repeat(64),
    page: `page-${index}.html`,
    renderedAt: 1,
  }))
  const result = buildEvidenceFromShots({ shots, requiredShots: 4 })
  assert.equal(result.ok, true)
  assert.equal(result.evidence.length, 4)
  assert.equal(result.evidence[0].kind, 'screenshot')
  assert.equal(result.evidence[0].name, 'page-1.html')
  assert.equal(result.evidence[0].artifacts[0].file, 'r1-s1-page-1.png')
  assert.equal(result.evidence[0].meta.console.errors, 0)
  assert.equal(buildEvidenceFromShots({ shots: shots.slice(0, 3), requiredShots: 4 }).ok, false)
  assert.equal(buildEvidenceFromShots({ shots: [] }).ok, false)
})

test('manifest keeps reviewer-only evidence path; compact projection drops logs/base64/paths', async (t) => {
  const { evidence } = await goodEvidence(t)
  evidence[0].kind = 'interaction'
  evidence[0].meta = {
    url: 'file:///C:/secret/state/index.html',
    page: 'index.html',
    console: { events: ['error: boom', `x`.repeat(5000)], errors: 3, truncated: true },
    network: { requests: 12, failures: 2, truncated: false, failureSamples: ['404 GET /a.js'] },
    perf: { metrics: { JSHeapUsedSize: 1 }, fps: 59.9 },
    steps: [{ action: 'click', selector: '#start', ms: 5 }],
  }
  evidence[0].artifacts.push({
    file: 'r1-s1-x2-extra.png',
    path: '/abs/path/extra.png',
    width: 1280,
    height: 800,
    bytes: 2048,
    sha256: 'b'.repeat(64),
    mime: 'image/png',
    kind: 'screenshot',
    stepName: 'extra',
  })
  const compact = buildCompactEvidence(evidence)
  const serialized = JSON.stringify(compact)
  assert.equal(serialized.includes('/abs/path'), false)
  assert.equal(serialized.includes('base64'), false)
  assert.equal(serialized.includes('boom'), false)
  assert.equal(compact.cards[0].artifactCount, 2)
  assert.equal(compact.cards[0].consoleErrorCount, 3)
  const manifest = buildEvidenceManifest(evidence)
  assert.equal(manifest[0].kind, 'interaction')
  assert.equal(manifest[0].artifactCount, 2)
  assert.equal(manifest[0].file, 'r1-s1-shot.png')
  assert.equal(manifest[0].consoleErrors, 3)
  assert.equal(manifest[0].networkFailures, 2)
  assert.equal(manifest[0].fps, 59.9)
  assert.equal(manifest[0].stepCount, 1)
  // The prompt manifest carries the reviewer-only absolute path so the review
  // child can read the image (its fs guard allows exactly this evidence dir).
  assert.equal(manifest[0].filePath, evidence[0].artifacts[0].path)
  // The compact/public projection must never carry that path.
  assert.equal(Object.prototype.hasOwnProperty.call(compact.cards[0], 'filePath'), false)
  assert.equal(serialized.includes(String(evidence[0].artifacts[0].path)), false)
  assert.equal(JSON.stringify(manifest).includes('/abs/path'), false)
})

test('representativeArtifact / shotFromArtifact / toInteractionCard / extra names', () => {
  const evidenceCard = {
    index: 1,
    name: 'play',
    kind: 'interaction',
    artifacts: [
      { file: 'r1-s2-play.png', path: '/x/r1-s2-play.png', width: 900, height: 700, bytes: 2048, sha256: 'c'.repeat(64), mime: 'image/png', kind: 'screenshot' },
      { file: 'r1-s2-x2-frame.png', path: '/x/r1-s2-x2-frame.png', width: 900, height: 700, bytes: 2048, sha256: 'd'.repeat(64), mime: 'image/png', kind: 'screenshot' },
    ],
    meta: emptyEvidenceMeta(),
  }
  assert.equal(representativeArtifact(evidenceCard).file, 'r1-s2-play.png')
  assert.equal(representativeArtifact({ artifacts: [] }), null)
  const shot = shotFromArtifact({ page: 'game.html' }, representativeArtifact(evidenceCard), 99)
  assert.equal(shot.file, 'r1-s2-play.png')
  assert.equal(shot.page, 'game.html')
  assert.equal(shot.renderedAt, 99)
  assert.match(shot.url, /^file:\/\//)
  assert.equal(shotFromArtifact(null, null), null)
  assert.equal(buildExtraArtifactFilename(3, 2, 2, 'menu frame'), 'r3-s2-x2-menu-frame.png')
  assert.match(buildExtraArtifactFilename(3, 2, 2, '帧'), /^r3-s2-x2-frame\.png$/)

  const interaction = toInteractionCard({
    name: 'play',
    slug: 'play',
    width: 900,
    height: 700,
    url: 'file:///x/game.html',
    page: 'game.html',
    collect: { console: true, network: true, perf: true },
    steps: [{ action: 'key', key: 'Space' }],
  })
  assert.equal(interaction.kind, 'interaction')
  assert.deepEqual(interaction.steps, [{ action: 'key', key: 'Space' }])
  assert.equal(resolveKeyDefinition('Space').code, 'Space')
})

test('normalizeEvidenceMeta bounds console events, network samples, metrics and steps', () => {
  const meta = normalizeEvidenceMeta({
    url: 'u'.repeat(2000),
    page: 'p',
    console: { events: Array.from({ length: 200 }, () => 'e'.repeat(500)), errors: -5, truncated: true },
    network: { requests: 999, failures: -1, truncated: true, failureSamples: Array.from({ length: 50 }, () => 'f') },
    perf: { metrics: Object.fromEntries(Array.from({ length: 30 }, (_unused, index) => [`m${index}`, index])), fps: 12.345 },
    steps: Array.from({ length: 50 }, () => ({ action: 'wait', ms: 3 })),
  }, null)
  assert.equal(meta.url.length <= 1000, true)
  assert.equal(meta.console.events.length, LIMITS.maxEvidenceConsoleEvents)
  assert.equal(meta.console.events[0].length <= LIMITS.evidenceEventChars, true)
  assert.equal(meta.console.errors, 0)
  assert.equal(meta.network.requests, 999)
  assert.equal(meta.network.failures, 0)
  assert.equal(meta.network.failureSamples.length, LIMITS.maxEvidenceFailureSamples)
  assert.equal(Object.keys(meta.perf.metrics).length <= 12, true)
  assert.equal(meta.perf.fps, 12.35)
  assert.equal(meta.steps.length <= LIMITS.maxEvidenceStepsPerCard + 2, true)
  assert.equal(slugifyName('play through'), 'play-through')
})

// ---------------------------------------------------------------------------
// v1.2 2.3b: image + pdf-text evidence cards
// ---------------------------------------------------------------------------

/** Minimal multi-page PDF fixture (mirrors pdf.test.mjs helpers). */
function makePdf({ pages = ['BT (Default page) Tj ET'], flate = false } = {}) {
  const objects = []
  const kids = []
  let next = 3
  for (const content of pages) {
    const pageNumber = next
    const contentNumber = next + 1
    next += 2
    kids.push(`${pageNumber} 0 R`)
    const raw = Buffer.from(content, 'latin1')
    const stream = flate ? deflateSync(raw) : raw
    objects.push(`${pageNumber} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNumber} 0 R >>\nendobj\n`)
    const filter = flate ? ' /Filter /FlateDecode' : ''
    objects.push(`${contentNumber} 0 obj\n<< /Length ${stream.length}${filter} >>\nstream\n${stream.toString('latin1')}\nendstream\nendobj\n`)
  }
  return Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>\nendobj\n${objects.join('')}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1')
}

function imageCard(overrides = {}) {
  return { kind: 'image', path: 'figures/result.png', name: 'result-chart', ...overrides }
}

function pdfCard(overrides = {}) {
  return { kind: 'pdf-text', path: 'paper.pdf', name: 'paper-page-1', ...overrides }
}

test('normalizeEvidenceCards accepts image/pdf-text cards and enforces local file rules', () => {
  const result = normalizeEvidenceCards([
    imageCard(),
    pdfCard({ page: 2 }),
    card({ name: 'home' }),
    interactionCard({ name: 'play' }),
  ], { targetDir: TARGET, requiredEvidence: 4 })
  assert.equal(result.ok, true, result.error)
  const [image, pdf] = result.cards
  assert.equal(image.kind, 'image')
  assert.equal(image.path, path.resolve(TARGET, 'figures', 'result.png'))
  assert.equal(image.pdfPage, null)
  assert.equal(pdf.kind, 'pdf-text')
  assert.equal(pdf.pdfPage, 2)
  assert.equal(pdf.width, 1200)
  assert.equal(pdf.height, 1600)
  assert.equal(image.name, 'result-chart')
  assert.equal(pdf.name, 'paper-page-1')

  assert.match(normalizeEvidenceCards([
    imageCard({ path: 'figures/result.jpg' }), pdfCard(), card(), card(),
  ], { targetDir: TARGET, requiredEvidence: 4 }).error, /PNG/)
  assert.match(normalizeEvidenceCards([
    imageCard(), pdfCard({ path: 'notes.txt' }), card(), card(),
  ], { targetDir: TARGET, requiredEvidence: 4 }).error, /\.pdf/)
  assert.match(normalizeEvidenceCards([
    imageCard({ url: 'http://127.0.0.1:1/x.png' }), pdfCard(), card(), card(),
  ], { targetDir: TARGET, requiredEvidence: 4 }).error, /不支持 url/)
  assert.match(normalizeEvidenceCards([
    imageCard({ path: '../escape.png' }), pdfCard(), card(), card(),
  ], { targetDir: TARGET, requiredEvidence: 4 }).error, /target 目录内/)
  assert.match(normalizeEvidenceCards([
    imageCard(), pdfCard({ page: 0 }), card(), card(),
  ], { targetDir: TARGET, requiredEvidence: 4 }).error, /page/)
  assert.match(normalizeEvidenceCards([
    imageCard(), pdfCard({ page: 'x' }), card(), card(),
  ], { targetDir: TARGET, requiredEvidence: 4 }).error, /page/)
  // Default card name follows the file / page.
  const defaults = normalizeEvidenceCards([
    imageCard({ name: undefined }), pdfCard({ name: undefined }), card(), card(),
  ], { targetDir: TARGET, requiredEvidence: 4 })
  assert.equal(defaults.ok, true, defaults.error)
  assert.equal(defaults.cards[0].name, 'result')
  assert.equal(defaults.cards[1].name, 'pdf-page-1')
})

test('renderImageEvidenceCard copies the project PNG with real dimensions and sha256', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'proj')
  const shotDir = path.join(dir, 'state', 'shots', 'c-test')
  await mkdir(path.join(target, 'figures'), { recursive: true })
  await mkdir(shotDir, { recursive: true })
  const png = pngHeader(640, 480, 4096)
  await writeFile(path.join(target, 'figures', 'result.png'), png)
  const normalized = normalizeEvidenceCards([
    imageCard(), pdfCard(), card(), card(),
  ], { targetDir: target, requiredEvidence: 4 })
  assert.equal(normalized.ok, true, normalized.error)
  const result = await renderImageEvidenceCard({
    card: normalized.cards[0],
    shotDir,
    roundNo: 1,
    shotIndex: 1,
    now: () => 123,
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.artifacts.length, 1)
  const artifact = result.artifacts[0]
  assert.equal(artifact.file, 'r1-s1-result-chart.png')
  assert.equal(artifact.width, 640)
  assert.equal(artifact.height, 480)
  assert.equal(artifact.kind, 'image')
  assert.equal(artifact.mime, 'image/png')
  assert.equal(artifact.sha256, sha256Buffer(png))
  assert.deepEqual(await readFile(artifact.path), png)
  assert.equal(result.shot.file, 'r1-s1-result-chart.png')
  assert.equal(result.shot.width, 640)
  assert.equal(result.shot.renderedAt, 123)

  const missing = await renderImageEvidenceCard({ card: { ...normalized.cards[0], path: path.join(target, 'nope.png') }, shotDir })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /不存在/)
  const notPng = path.join(target, 'figures', 'fake.png')
  await writeFile(notPng, Buffer.from('not a png'.repeat(300)))
  const invalid = await renderImageEvidenceCard({ card: { ...normalized.cards[0], path: notPng }, shotDir })
  assert.equal(invalid.ok, false)
  assert.match(invalid.error, /不是有效的 PNG/)
})

test('renderPdfTextEvidenceCard renders the selected page into PNG + text artifacts', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'proj')
  const stateDir = path.join(dir, 'state')
  const shotDir = path.join(stateDir, 'shots', 'c-test')
  await mkdir(target, { recursive: true })
  await mkdir(shotDir, { recursive: true })
  const pdfBytes = makePdf({
    pages: ['BT (Abstract: accuracy 0.95) Tj ET', 'BT (Results: accuracy 0.81 with <script>alert(1)</script>) Tj ET'],
    flate: true,
  })
  await writeFile(path.join(target, 'paper.pdf'), pdfBytes)
  const renderShots = makeRenderShots()
  const capturedHtml = []
  const renderer = async (options) => {
    capturedHtml.push(await readFile(options.specs[0].path, 'utf8'))
    return renderShots.fn(options)
  }
  const normalized = normalizeEvidenceCards([
    imageCard(), pdfCard({ page: 2 }), card(), card(),
  ], { targetDir: target, requiredEvidence: 4 })
  assert.equal(normalized.ok, true, normalized.error)
  const result = await renderPdfTextEvidenceCard({
    card: normalized.cards[1],
    stateDir,
    cycleId: 'c-test',
    shotDir,
    roundNo: 1,
    shotIndex: 2,
    shotIndexOffset: 1,
    config: {},
    renderShotsImpl: renderer,
    now: () => 5,
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.artifacts.length, 2)
  const [pngArtifact, textArtifact] = result.artifacts
  assert.equal(pngArtifact.file, 'r1-s2-paper-page-1.png')
  assert.equal(pngArtifact.kind, 'pdf-text')
  assert.equal(pngArtifact.mime, 'image/png')
  assert.equal(pngArtifact.width, 1200)
  assert.equal(pngArtifact.height, 1600)
  assert.equal(textArtifact.file, 'r1-s2-pdf.txt')
  assert.equal(textArtifact.kind, 'text')
  assert.equal(textArtifact.mime, 'text/plain')
  assert.equal(textArtifact.bytes, Buffer.byteLength(await readFile(textArtifact.path, 'utf8')))
  const textContent = await readFile(textArtifact.path, 'utf8')
  assert.match(textContent, /Page: 2 \/ 2/)
  assert.match(textContent, /PDF-SHA256:/)
  assert.match(textContent, /accuracy 0\.81/)
  // The rendered HTML page is escaped and shows the selected page only.
  assert.equal(capturedHtml.length, 1)
  assert.ok(capturedHtml[0].includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.equal(capturedHtml[0].includes('<script>alert(1)</script>'), false)
  assert.ok(capturedHtml[0].includes('第 2/2 页'))
  assert.equal(capturedHtml[0].includes('Abstract: accuracy 0.95'), false)
  // No temp HTML left behind.
  assert.deepEqual(await readdir(path.join(stateDir, 'tmp')), [])
  // Evidence meta carries extraction provenance.
  assert.equal(result.evidenceCard.kind, 'pdf-text')
  assert.equal(result.evidenceCard.meta.pageCount, 2)
  assert.equal(result.evidenceCard.meta.page, 2)
  assert.equal(result.evidenceCard.meta.pdfSha256, sha256Buffer(pdfBytes))
  assert.equal(result.evidenceCard.meta.extractedChars > 0, true)
})

test('renderPdfTextEvidenceCard reports out-of-range pages and extraction failures', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'proj')
  const stateDir = path.join(dir, 'state')
  const shotDir = path.join(stateDir, 'shots', 'c-test')
  await mkdir(target, { recursive: true })
  await mkdir(shotDir, { recursive: true })
  await writeFile(path.join(target, 'paper.pdf'), makePdf())
  const normalized = normalizeEvidenceCards([
    imageCard(), pdfCard({ page: 9 }), card(), card(),
  ], { targetDir: target, requiredEvidence: 4 })
  const outOfRange = await renderPdfTextEvidenceCard({
    card: normalized.cards[1], stateDir, cycleId: 'c-test', shotDir, roundNo: 1, shotIndex: 2,
  })
  assert.equal(outOfRange.ok, false)
  assert.match(outOfRange.error, /只有 1 页/)

  const failed = await renderPdfTextEvidenceCard({
    card: { ...normalized.cards[1], pdfPage: 1 },
    stateDir,
    cycleId: 'c-test',
    shotDir,
    roundNo: 1,
    shotIndex: 2,
    extractPdfTextImpl: async () => ({ ok: false, error: '模拟解压失败' }),
  })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /模拟解压失败/)
})

test('renderEvidenceCards supports a mixed four-kind plan and verifies every artifact', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'proj')
  const stateDir = path.join(dir, 'state')
  await mkdir(path.join(target, 'figures'), { recursive: true })
  await mkdir(target, { recursive: true })
  await writeFile(path.join(target, 'index.html'), '<h1>report</h1>')
  await writeFile(path.join(target, 'figures', 'result.png'), pngHeader(640, 480, 4096))
  await writeFile(path.join(target, 'paper.pdf'), makePdf({ pages: ['(Page one) Tj', '(Page two) Tj'] }))
  const normalized = normalizeEvidenceCards([
    imageCard(), pdfCard({ page: 1 }), card({ name: 'report' }), interactionCard({ name: 'playthrough' }),
  ], { targetDir: target, requiredEvidence: 4 })
  assert.equal(normalized.ok, true, normalized.error)
  const renderShots = makeRenderShots()
  const interaction = makeInteractionRunner()
  const result = await renderEvidenceCards({
    cards: normalized.cards,
    targetDir: target,
    stateDir,
    cycleId: 'c-test',
    roundNo: 1,
    requiredEvidence: 4,
    config: {},
    renderShotsImpl: renderShots.fn,
    runInteractionCardImpl: interaction.fn,
    now: () => 9,
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.shots.length, 4)
  assert.deepEqual(result.evidence.map((evidenceCard) => evidenceCard.kind), ['image', 'pdf-text', 'screenshot', 'interaction'])
  assert.deepEqual(result.shots.map((shot) => shot.file), [
    'r1-s1-result-chart.png',
    'r1-s2-paper-page-1.png',
    'r1-s3-report.png',
    'r1-s4-playthrough.png',
  ])
  // image 1 + pdf 2 + screenshot 1 + interaction 1 = 5 artifacts.
  assert.equal(result.artifactsCount, 5)
  const verification = await verifyEvidenceArtifacts({
    evidence: result.evidence,
    shotsDir: path.join(stateDir, 'shots', 'c-test'),
    requiredEvidence: 4,
  })
  assert.equal(verification.ok, true, verification.error)
  assert.equal(verification.artifacts, 5)
  // Text artifact is verified by sha256 + exact size, and tampering is detected.
  const textArtifact = result.evidence[1].artifacts.find((artifact) => artifact.mime === 'text/plain')
  const textPath = path.join(stateDir, 'shots', 'c-test', textArtifact.file)
  const original = await readFile(textPath, 'utf8')
  await writeFile(textPath, `${original} tampered`, 'utf8')
  const tampered = await verifyEvidenceArtifacts({
    evidence: result.evidence,
    shotsDir: path.join(stateDir, 'shots', 'c-test'),
    requiredEvidence: 4,
  })
  assert.equal(tampered.ok, false)
  assert.match(tampered.error, /sha256/)
})

test('verifyEvidenceArtifacts rejects broken text artifacts and missing bytes records', async (t) => {
  const dir = await tempDir(t)
  const { shotDir, evidence } = await goodEvidence(t)
  const textFile = 'r1-s1-pdf.txt'
  const textBytes = Buffer.from('PDF text artifact', 'utf8')
  await writeFile(path.join(shotDir, textFile), textBytes)
  evidence[0].artifacts.push({
    file: textFile,
    path: path.join(shotDir, textFile),
    width: 0,
    height: 0,
    bytes: textBytes.length,
    sha256: sha256Buffer(textBytes),
    mime: 'text/plain',
    kind: 'text',
    stepName: null,
  })
  const ok = await verifyEvidenceArtifacts({ evidence, shotsDir: shotDir, requiredEvidence: 4 })
  assert.equal(ok.ok, true, ok.error)

  const wrongSize = JSON.parse(JSON.stringify(evidence))
  wrongSize[0].artifacts.find((artifact) => artifact.file === textFile).bytes = 1
  const sizeCheck = await verifyEvidenceArtifacts({ evidence: wrongSize, shotsDir: shotDir, requiredEvidence: 4 })
  assert.equal(sizeCheck.ok, false)
  assert.match(sizeCheck.error, /字节数/)

  const wrongMime = JSON.parse(JSON.stringify(evidence))
  wrongMime[0].artifacts.find((artifact) => artifact.file === textFile).mime = 'image/png'
  const mimeCheck = await verifyEvidenceArtifacts({ evidence: wrongMime, shotsDir: shotDir, requiredEvidence: 4 })
  assert.equal(mimeCheck.ok, false)
  assert.match(mimeCheck.error, /mime/)

  await rm(path.join(shotDir, textFile))
  const missing = await verifyEvidenceArtifacts({ evidence, shotsDir: shotDir, requiredEvidence: 4 })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /读取失败|不存在/)
  assert.equal(dir.startsWith(os.tmpdir()), true)
})

test('manifest exposes pdf provenance to reviewers; compact stays path-free', async (t) => {
  const dir = await tempDir(t)
  const { shotDir, evidence } = await goodEvidence(t)
  const textFile = 'r1-s1-pdf.txt'
  const textBytes = Buffer.from('PDF extracted text', 'utf8')
  const textPath = path.join(shotDir, textFile)
  await writeFile(textPath, textBytes)
  evidence[0].kind = 'pdf-text'
  evidence[0].meta = {
    ...evidence[0].meta,
    pageCount: 5,
    page: 2,
    extractedChars: 19,
    truncated: false,
    pdfSha256: 'f'.repeat(64),
  }
  evidence[0].artifacts.push({
    file: textFile,
    path: textPath,
    width: 0,
    height: 0,
    bytes: textBytes.length,
    sha256: sha256Buffer(textBytes),
    mime: 'text/plain',
    kind: 'text',
    stepName: null,
  })
  const manifest = buildEvidenceManifest(evidence)
  assert.equal(manifest[0].kind, 'pdf-text')
  assert.equal(manifest[0].pageCount, 5)
  assert.equal(manifest[0].page, 2)
  assert.equal(manifest[0].extractedChars, 19)
  assert.equal(manifest[0].pdfSha256, 'f'.repeat(64))
  assert.equal(manifest[0].textFile, textFile)
  assert.equal(manifest[0].textFilePath, textPath)
  assert.equal(manifest[0].filePath, evidence[0].artifacts[0].path)

  const compact = buildCompactEvidence(evidence)
  const serialized = JSON.stringify(compact)
  assert.equal(serialized.includes(textPath), false)
  assert.equal(serialized.includes('PDF extracted text'), false)
  assert.equal(compact.cards[0].kind, 'pdf-text')
  assert.equal(compact.cards[0].artifactCount, 2)
  assert.equal(Object.prototype.hasOwnProperty.call(compact.cards[0], 'textFilePath'), false)
  assert.equal(dir.startsWith(os.tmpdir()), true)
})

test('image/pdf-text cards never break the legacy all-screenshot fast path', async (t) => {
  const dir = await tempDir(t)
  const stateDir = path.join(dir, 'state')
  const renderShots = makeRenderShots()
  const specs = [
    { kind: 'path', path: path.resolve(TARGET, 'index.html'), width: 1440, height: 900, name: 'desktop', page: 'index.html' },
    { kind: 'path', path: path.resolve(TARGET, 'index.html'), width: 1280, height: 800, name: 'laptop', page: 'index.html' },
    { kind: 'path', path: path.resolve(TARGET, 'index.html'), width: 768, height: 1024, name: 'tablet', page: 'index.html' },
    { kind: 'path', path: path.resolve(TARGET, 'index.html'), width: 390, height: 844, name: 'mobile', page: 'index.html' },
  ]
  const result = await renderEvidenceCards({
    specs,
    targetDir: TARGET,
    stateDir,
    cycleId: 'c-legacy',
    roundNo: 1,
    requiredEvidence: 4,
    config: {},
    renderShotsImpl: renderShots.fn,
  })
  assert.equal(result.ok, true, result.error)
  // Still exactly ONE batched render call for the legacy path.
  assert.equal(renderShots.calls.length, 1)
  assert.equal(renderShots.calls[0].specs.length, 4)
})
