/**
 * Opt-in REAL smoke test for the zero-dependency CDP runner (v1.2 2.2).
 *
 * Not part of the unit suite: it launches the real `chrome-headless-shell`
 * found by `resolveChromePath()` and drives a tiny local game page through
 * `--remote-debugging-pipe`. Run it manually when validating the host browser:
 *
 *   node redteam-console/test/manual-cdp-smoke.mjs
 *
 * Exit code 0 = pipe protocol + navigation + click/key/screenshot + console/
 * perf collection + cleanup all worked against the real binary.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runInteractionCard } from '../lib/cdp.js'
import { renderEvidenceCards, verifyEvidenceArtifacts } from '../lib/evidence.js'
import { pathToFileUrl, resolveChromePath } from '../lib/shots.js'

const startedAt = Date.now()
const resolution = resolveChromePath()
if (typeof resolution.path !== 'string' || resolution.path === '') {
  console.error('[smoke] SKIP: no headless browser found:', resolution.warnings.join(' / '))
  process.exit(2)
}
console.log(`[smoke] chrome: ${resolution.path} (source=${resolution.source})`)

const root = await mkdtemp(path.join(os.tmpdir(), 'rtc-cdp-smoke-'))
const target = path.join(root, 'game')
const outDir = path.join(root, 'state', 'shots', 'c-smoke')
try {
  await writeFile(path.join(root, '.keep'), '')
  await mkdir(target, { recursive: true })
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>smoke game</title>
<style>body{margin:0;background:#123;color:#eee;font:16px sans-serif}canvas{display:block}</style>
</head><body>
<button id="start" type="button">START</button>
<div id="status">idle</div>
<canvas id="game" width="800" height="600"></canvas>
<script>
  let frames = 0
  const status = document.getElementById('status')
  document.getElementById('start').addEventListener('click', () => {
    status.textContent = 'playing'
    console.log('game started')
  })
  window.addEventListener('keydown', (event) => {
    if (event.code === 'Space') {
      status.textContent = 'paused'
      console.warn('space pressed')
      document.title = 'paused'
    }
  })
  const ctx = document.getElementById('game').getContext('2d')
  function tick() {
    frames += 1
    ctx.fillStyle = frames % 2 ? '#1a2' : '#2a1'
    ctx.fillRect(0, 0, 800, 600)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
</script>
</body></html>`
  await writeFile(path.join(target, 'index.html'), html, 'utf8')
  const card = {
    kind: 'interaction',
    name: 'smoke-playthrough',
    slug: 'smoke-playthrough',
    width: 800,
    height: 600,
    url: pathToFileUrl(path.join(target, 'index.html')),
    page: 'index.html',
    collect: { console: true, network: true, perf: true },
    steps: [
      { action: 'click', selector: '#start' },
      { action: 'wait', ms: 250 },
      { action: 'screenshot', name: 'playing' },
      { action: 'key', key: 'Space' },
      { action: 'wait', ms: 150 },
      { action: 'screenshot', name: 'after-space' },
    ],
  }
  const result = await runInteractionCard({
    card,
    outDir,
    roundNo: 1,
    shotIndex: 1,
    chrome: { path: resolution.path },
    config: { interactionTimeoutSeconds: 20, allowedOrigins: [] },
  })
  console.log('[smoke] elapsedMs:', Date.now() - startedAt)
  console.log('[smoke] ok:', result.ok, 'error:', result.error ?? null)
  console.log('[smoke] artifacts:', result.artifacts.map((artifact) => `${artifact.file} ${artifact.width}x${artifact.height} ${artifact.bytes}B sha=${artifact.sha256.slice(0, 12)}…`))
  console.log('[smoke] console:', JSON.stringify(result.meta.console))
  console.log('[smoke] network:', JSON.stringify(result.meta.network))
  console.log('[smoke] perf:', JSON.stringify(result.meta.perf))
  console.log('[smoke] steps:', JSON.stringify(result.meta.steps))
  const ok = result.ok === true
    && result.artifacts.length === 2
    && result.artifacts.every((artifact) => artifact.width === 800 && artifact.height === 600)
    && result.meta.console.events.some((event) => event.includes('game started'))
    && result.meta.console.events.some((event) => event.includes('space pressed'))
  console.log(ok ? '[smoke] PASS phase1 (single interaction card)' : '[smoke] FAIL phase1')

  // Phase 2: full evidence plan (2 screenshot + 2 interaction cards) rendered
  // by the real framework, then verified exactly like the orchestrator does.
  const evidenceStartedAt = Date.now()
  const cards = [
    {
      kind: 'screenshot',
      name: 'start-screen',
      slug: 'start-screen',
      width: 800,
      height: 600,
      path: path.join(target, 'index.html'),
      url: pathToFileUrl(path.join(target, 'index.html')),
      page: 'index.html',
      collect: { console: false, network: false, perf: false },
      steps: [],
    },
    {
      kind: 'interaction',
      name: 'playthrough',
      slug: 'playthrough',
      width: 800,
      height: 600,
      url: pathToFileUrl(path.join(target, 'index.html')),
      page: 'index.html',
      collect: { console: true, network: true, perf: true },
      steps: [
        { action: 'click', selector: '#start' },
        { action: 'wait', ms: 120 },
        { action: 'screenshot', name: 'playing' },
        { action: 'key', key: 'Space' },
        { action: 'wait', ms: 80 },
        { action: 'screenshot', name: 'paused' },
      ],
    },
    {
      kind: 'screenshot',
      name: 'menu-screen',
      slug: 'menu-screen',
      width: 800,
      height: 600,
      path: path.join(target, 'index.html'),
      url: pathToFileUrl(path.join(target, 'index.html')),
      page: 'index.html',
      collect: { console: false, network: false, perf: false },
      steps: [],
    },
    {
      kind: 'interaction',
      name: 'end-state',
      slug: 'end-state',
      width: 800,
      height: 600,
      url: pathToFileUrl(path.join(target, 'index.html')),
      page: 'index.html',
      collect: { console: true, network: false, perf: false },
      steps: [
        { action: 'click', selector: '#start' },
        { action: 'key', key: 'Escape' },
        { action: 'wait', ms: 60 },
      ],
    },
  ]
  const rendered = await renderEvidenceCards({
    cards,
    targetDir: target,
    stateDir: path.join(root, 'state'),
    cycleId: 'c-smoke',
    roundNo: 1,
    requiredEvidence: 4,
    config: { screenshotTimeoutSeconds: 20, interactionTimeoutSeconds: 20, allowedOrigins: [] },
    chrome: { path: resolution.path },
  })
  console.log('[smoke] evidence elapsedMs:', Date.now() - evidenceStartedAt)
  console.log('[smoke] evidence ok:', rendered.ok, 'error:', rendered.error ?? null)
  console.log('[smoke] evidence cards:', rendered.evidence.map((evidenceCard) => `${evidenceCard.kind}:${evidenceCard.name}:${evidenceCard.artifacts.length}artifacts`).join(' | '))
  console.log('[smoke] evidence rep shots:', rendered.shots.map((shot) => shot.file))
  const evidenceVerification = rendered.ok
    ? await verifyEvidenceArtifacts({
      evidence: rendered.evidence,
      shotsDir: path.join(root, 'state', 'shots', 'c-smoke'),
      requiredEvidence: 4,
    })
    : { ok: false, error: rendered.error }
  console.log('[smoke] evidence verification:', JSON.stringify(evidenceVerification))
  const evidenceOk = rendered.ok === true
    && rendered.shots.length === 4
    && rendered.shots.every((shot, index) => shot.file === `r1-s${index + 1}-${['start-screen', 'playthrough', 'menu-screen', 'end-state'][index]}.png`)
    && rendered.evidence[1].artifacts.length === 2
    && rendered.evidence[1].artifacts[1].file === 'r1-s2-x2-paused.png'
    && rendered.evidence[1].meta.console.errors === 0
    && evidenceVerification.ok === true
  console.log(evidenceOk ? '[smoke] PASS phase2 (4-card evidence plan)' : '[smoke] FAIL phase2')

  // Phase 3: legacy `shots` compatibility — four specs in ONE batched render,
  // mapped to four screenshot evidence cards with the legacy file names.
  const legacyStartedAt = Date.now()
  const legacy = await renderEvidenceCards({
    specs: [1440, 1280, 768, 390].map((width, index) => ({
      kind: 'path',
      path: path.join(target, 'index.html'),
      width,
      height: [900, 800, 1024, 844][index],
      name: ['desktop', 'laptop', 'tablet', 'mobile'][index],
      page: 'index.html',
    })),
    targetDir: target,
    stateDir: path.join(root, 'state'),
    cycleId: 'c-legacy',
    roundNo: 2,
    requiredEvidence: 4,
    config: { screenshotTimeoutSeconds: 20, allowedOrigins: [] },
  })
  const legacyVerification = legacy.ok
    ? await verifyEvidenceArtifacts({
      evidence: legacy.evidence,
      shotsDir: path.join(root, 'state', 'shots', 'c-legacy'),
      requiredEvidence: 4,
    })
    : { ok: false, error: legacy.error }
  console.log('[smoke] legacy elapsedMs:', Date.now() - legacyStartedAt, 'ok:', legacy.ok, 'error:', legacy.error ?? null)
  console.log('[smoke] legacy shots:', legacy.shots.map((shot) => `${shot.file} ${shot.width}x${shot.height}`))
  const legacyOk = legacy.ok === true
    && legacy.shots.length === 4
    && legacy.evidence.every((evidenceCard) => evidenceCard.kind === 'screenshot')
    && legacyVerification.ok === true
  console.log(legacyOk ? '[smoke] PASS phase3 (legacy shots compatibility)' : '[smoke] FAIL phase3')
  process.exitCode = ok && evidenceOk && legacyOk ? 0 : 1
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
