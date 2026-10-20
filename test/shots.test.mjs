import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildDefaultSpecs,
  buildShotFilename,
  cleanRoundShots,
  detectEntryFile,
  isLoopbackHostname,
  normalizeAllowedOrigins,
  normalizeSpecs,
  pathToFileUrl,
  pngDimensions,
  renderShots,
  resolveChromePath,
  slugifyName,
  verifyRoundShotFiles,
  verifyShotFile,
  writeReportHtml,
} from '../lib/shots.js'

// A genuine 1x1 PNG (signature + IHDR are enough for header parsing).
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const TINY_PNG = Buffer.from(TINY_PNG_BASE64, 'base64')

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rtc-shots-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

test('pngDimensions parses a real 1x1 PNG', () => {
  assert.deepEqual(pngDimensions(TINY_PNG), { width: 1, height: 1 })
})

test('pngDimensions rejects non-PNG/hostile buffers', () => {
  assert.equal(pngDimensions(null), null)
  assert.equal(pngDimensions(undefined), null)
  assert.equal(pngDimensions(Buffer.alloc(0)), null)
  assert.equal(pngDimensions(Buffer.from('hello world')), null)
  assert.equal(pngDimensions(TINY_PNG.subarray(0, 20)), null)
  const badSignature = Buffer.from(TINY_PNG)
  badSignature[1] = 0x00
  assert.equal(pngDimensions(badSignature), null)
  const badChunk = Buffer.from(TINY_PNG)
  badChunk.writeUInt32BE(12, 8)
  assert.equal(pngDimensions(badChunk), null)
  const zeroWidth = pngHeader(0, 10)
  assert.equal(pngDimensions(zeroWidth), null)
  assert.deepEqual(pngDimensions(new Uint8Array(TINY_PNG)), { width: 1, height: 1 })
})

test('pathToFileUrl encodes spaces and drive letters', () => {
  if (process.platform === 'win32') {
    assert.equal(pathToFileUrl('C:\\a b\\x.html'), 'file:///C:/a%20b/x.html')
  }
  assert.ok(pathToFileUrl(path.join(os.tmpdir(), 'a b.html')).startsWith('file:///'))
})

test('slugifyName/buildShotFilename are filesystem-safe and unique per index', () => {
  assert.equal(slugifyName('Desktop Home!'), 'desktop-home')
  assert.equal(slugifyName('中文'), 'shot')
  assert.equal(buildShotFilename(2, 0, 'desktop'), 'r2-s1-desktop.png')
  assert.equal(buildShotFilename(2, 3, '中文'), 'r2-s4-shot-4.png')
  assert.match(buildShotFilename(10, 11, 'x'), /^r10-s12-x\.png$/)
})

test('detectEntryFile prefers index.html then public/dist/src', () => {
  const target = 'C:\\demo'
  assert.equal(detectEntryFile({ targetDir: target, exists: () => true }), path.join(target, 'index.html'))
  assert.equal(
    detectEntryFile({
      targetDir: target,
      exists: (candidate) => candidate.endsWith(path.join('public', 'index.html')),
    }),
    path.join(target, 'public', 'index.html'),
  )
  assert.equal(detectEntryFile({ targetDir: target, exists: () => false }), null)
  assert.equal(detectEntryFile({ targetDir: '', exists: () => true }), null)
})

test('buildDefaultSpecs produces requiredShots viewport specs', () => {
  const target = 'C:\\demo'
  const specs = buildDefaultSpecs({ targetDir: target, entryFile: path.join(target, 'index.html'), requiredShots: 4 })
  assert.equal(specs.length, 4)
  assert.deepEqual(specs.map((spec) => [spec.width, spec.height]), [[1440, 900], [1280, 800], [768, 1024], [390, 844]])
  assert.equal(specs[0].kind, 'path')
  assert.equal(specs[0].path, 'index.html')
  assert.equal(specs[0].page, 'index.html')
  const two = buildDefaultSpecs({ targetDir: target, entryFile: path.join(target, 'index.html'), requiredShots: 2 })
  assert.equal(two.length, 2)
})

test('v1.3 regression: auto-detected specs must be normalized to absolute target paths', () => {
  const target = 'C:\\demo'
  const raw = buildDefaultSpecs({ targetDir: target, entryFile: path.join(target, 'index.html'), requiredShots: 4 })
  assert.equal(raw[0].path, 'index.html')
  const normalized = normalizeSpecs(raw, { targetDir: target, requiredShots: 4 })
  assert.equal(normalized.ok, true, normalized.error)
  for (const spec of normalized.specs) {
    assert.equal(path.isAbsolute(spec.path), true)
    assert.equal(path.dirname(spec.path), path.resolve(target))
    assert.equal(spec.page, 'index.html')
  }
})

test('normalizeSpecs accepts exactly four valid mixed specs', () => {
  const target = 'C:\\demo'
  const specs = [
    { path: 'index.html' },
    { path: 'public/home.html', width: 390, height: '844' },
    { url: 'http://127.0.0.1:3000/', name: 'local' },
    { url: 'https://example.com/app', width: 1440 },
  ]
  const result = normalizeSpecs(specs, { targetDir: target, requiredShots: 4, allowedOrigins: ['https://example.com'] })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.specs.length, 4)
  assert.equal(result.specs[0].path, path.resolve(target, 'index.html'))
  assert.equal(result.specs[0].page, 'index.html')
  assert.equal(result.specs[1].width, 390)
  assert.equal(result.specs[1].height, 844)
  assert.equal(result.specs[2].kind, 'url')
  assert.equal(result.specs[2].page, 'http://127.0.0.1:3000/')
  assert.equal(result.specs[3].width, 1440)
})

test('normalizeSpecs allows the same page at different viewports (README demo shape)', () => {
  const result = normalizeSpecs([
    { path: 'index.html', width: 1440, height: 900, name: 'home-desktop' },
    { path: 'shop.html', width: 1440, height: 900, name: 'shop' },
    { path: 'reading.html', width: 1440, height: 900, name: 'reading' },
    { path: 'index.html', width: 390, height: 844, name: 'home-mobile' },
  ], { targetDir: 'C:\\demo', requiredShots: 4 })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.specs.length, 4)
  assert.equal(result.specs[3].width, 390)
})

test('normalizeSpecs rejects missing path/url, both, duplicates and wrong count', () => {
  const target = 'C:\\demo'
  const options = { targetDir: target, requiredShots: 4, allowedOrigins: ['https://x.test', 'https://y.test'] }
  assert.equal(normalizeSpecs([{ path: 'a.html' }], options).ok, false)
  assert.match(normalizeSpecs([{ path: 'a.html' }], options).error, /恰好 4 个/)

  const missing = normalizeSpecs([{ name: 'x' }, { path: 'b.html' }, { url: 'https://x.test/' }, { url: 'https://y.test/' }], options)
  assert.equal(missing.ok, false)
  assert.match(missing.error, /path 或 url/)

  const both = normalizeSpecs([{ path: 'a.html', url: 'https://x.test/' }, { path: 'b.html' }, { url: 'https://x.test/1' }, { url: 'https://y.test/' }], options)
  assert.equal(both.ok, false)
  assert.match(both.error, /互斥/)

  const duplicatePath = normalizeSpecs([
    { path: 'index.html' },
    { path: 'index.html' },
    { url: 'https://x.test/' },
    { url: 'https://y.test/' },
  ], options)
  assert.equal(duplicatePath.ok, false)
  assert.match(duplicatePath.error, /重复/)

  const duplicateUrl = normalizeSpecs([
    { path: 'a.html' },
    { path: 'b.html' },
    { url: 'https://x.test/same' },
    { url: 'https://x.test/same' },
  ], options)
  assert.equal(duplicateUrl.ok, false)
  assert.match(duplicateUrl.error, /重复/)
})

test('normalizeSpecs rejects path traversal and non-http URLs', () => {
  const options = { targetDir: 'C:\\demo', requiredShots: 4, allowedOrigins: ['https://x.test'] }
  const traversal = normalizeSpecs([
    { path: '..\\..\\Windows\\win.ini' },
    { path: 'b.html' },
    { url: 'https://x.test/1' },
    { url: 'https://x.test/2' },
  ], options)
  assert.equal(traversal.ok, false)
  assert.match(traversal.error, /target 目录内/)

  const javascript = normalizeSpecs([
    { path: 'a.html' },
    { path: 'b.html' },
    { url: 'javascript:alert(1)' },
    { url: 'https://x.test/2' },
  ], options)
  assert.equal(javascript.ok, false)
  assert.match(javascript.error, /http/)

  const fileUrl = normalizeSpecs([
    { path: 'a.html' },
    { path: 'b.html' },
    { url: 'file:///c:/secret.txt' },
    { url: 'https://x.test/2' },
  ], options)
  assert.equal(fileUrl.ok, false)

  const brokenUrl = normalizeSpecs([
    { path: 'a.html' },
    { path: 'b.html' },
    { url: 'not a url' },
    { url: 'https://x.test/2' },
  ], options)
  assert.equal(brokenUrl.ok, false)
})

test('normalizeSpecs falls back to default viewport on bad width/height with a warning', () => {
  const result = normalizeSpecs(
    [{ path: 'a.html', width: 'abc', height: 999999 }, { path: 'b.html' }, { url: 'https://x.test/1' }, { url: 'https://x.test/2' }],
    { targetDir: 'C:\\demo', requiredShots: 4, allowedOrigins: ['https://x.test'] },
  )
  assert.equal(result.ok, true)
  assert.equal(result.specs[0].width, 1280)
  assert.equal(result.specs[0].height, 800)
  assert.ok(result.warnings.length >= 2)
})

test('normalizeSpecs enforces the v1.1 URL origin allowlist', () => {
  const base = { targetDir: 'C:\\demo', requiredShots: 4 }
  const rejected = normalizeSpecs([
    { url: 'https://evil.example.com/page' },
    { path: 'a.html' },
    { path: 'b.html' },
    { url: 'http://127.0.0.1:3000/' },
  ], base)
  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /白名单/)

  // Port games and look-alike hosts must not slip through a configured origin.
  const portMismatch = normalizeSpecs([
    { url: 'https://allowed.example.com:8443/app' },
    { path: 'a.html' },
    { path: 'b.html' },
    { url: 'http://127.0.0.1:3000/' },
  ], { ...base, allowedOrigins: ['https://allowed.example.com'] })
  assert.equal(portMismatch.ok, false)
  assert.match(portMismatch.error, /白名单/)
  const suffixHost = normalizeSpecs([
    { url: 'https://allowed.example.com.evil.test/' },
    { path: 'a.html' },
    { path: 'b.html' },
    { url: 'http://127.0.0.1:3000/' },
  ], { ...base, allowedOrigins: ['https://allowed.example.com'] })
  assert.equal(suffixHost.ok, false)

  // Loopback hosts (any port) and explicitly configured origins are allowed.
  const allowed = normalizeSpecs([
    { url: 'http://127.0.0.1:8080/one' },
    { url: 'http://localhost:3000/two' },
    { url: 'http://[::1]:5173/three' },
    { url: 'https://allowed.example.com/app' },
  ], { ...base, allowedOrigins: ['https://allowed.example.com'] })
  assert.equal(allowed.ok, true, allowed.error)
  assert.deepEqual(allowed.specs.map((spec) => spec.kind), ['url', 'url', 'url', 'url'])
  assert.equal(allowed.specs[0].url, 'http://127.0.0.1:8080/one')
  assert.equal(allowed.specs[2].url, 'http://[::1]:5173/three')

  // A non-http allowlist entry can never widen access and is simply ignored.
  const invalidEntry = normalizeSpecs([
    { url: 'https://allowed.example.com/' },
    { path: 'a.html' },
    { path: 'b.html' },
    { url: 'http://127.0.0.1:1/' },
  ], { ...base, allowedOrigins: ['javascript:alert(1)', 42, ''] })
  assert.equal(invalidEntry.ok, false)

  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('localhost'), true)
  assert.equal(isLoopbackHostname('[::1]'), true)
  assert.equal(isLoopbackHostname('example.com'), false)
  assert.equal(isLoopbackHostname('localhost.evil.test'), false)
  assert.deepEqual([...normalizeAllowedOrigins(['https://a.test/path', 'nope', 'file:///x'])], ['https://a.test'])
})

test('resolveChromePath respects the documented order', () => {
  const target = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  const order = []
  const fakeExists = (candidate) => {
    order.push(candidate)
    return candidate === target
  }

  const fromConfig = resolveChromePath({ chromePath: target, platform: 'win32', exists: (candidate) => candidate === target })
  assert.deepEqual(fromConfig, { path: target, source: 'config', warnings: [] })

  const fromEnv = resolveChromePath({
    env: { DSH_CHROME_PATH: 'C:\\custom\\chrome.exe' },
    platform: 'win32',
    exists: (candidate) => candidate === 'C:\\custom\\chrome.exe',
  })
  assert.equal(fromEnv.source, 'env')
  assert.equal(fromEnv.path, 'C:\\custom\\chrome.exe')

  // Missing config path is a warning, and resolution continues.
  const afterBadConfig = resolveChromePath({
    chromePath: 'C:\\missing\\chrome.exe',
    platform: 'win32',
    exists: (candidate) => candidate === target,
  })
  assert.equal(afterBadConfig.path, target)
  assert.ok(afterBadConfig.warnings.some((warning) => warning.includes('chromePath')))

  // Playwright directories are ordered by descending chromium revision.
  const localAppData = 'C:\\Users\\tester\\AppData\\Local'
  const playwrightRoot = path.join(localAppData, 'ms-playwright')
  const honest = []
  const fromPlaywright = resolveChromePath({
    env: { LOCALAPPDATA: localAppData },
    platform: 'win32',
    home: 'C:\\Users\\tester',
    readdir: (dir) => {
      assert.equal(dir, playwrightRoot)
      return ['chromium-1000', 'chromium-1200', 'chromium_headless_shell-1', 'other']
    },
    exists: (candidate) => {
      honest.push(candidate)
      return candidate === path.join(playwrightRoot, 'chromium-1200', 'chrome-win64', 'chrome.exe')
    },
  })
  assert.equal(fromPlaywright.source, 'playwright')
  assert.equal(fromPlaywright.path, path.join(playwrightRoot, 'chromium-1200', 'chrome-win64', 'chrome.exe'))
  assert.equal(honest.some((candidate) => candidate.includes('chromium-1000')), false)

  const nothing = resolveChromePath({ platform: 'win32', env: {}, home: 'C:\\Users\\tester', readdir: () => [], exists: () => false })
  assert.equal(nothing.path, null)
  assert.ok(nothing.warnings.some((warning) => warning.includes('找不到')))
})

test('verifyShotFile enforces size, PNG signature and dimensions', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'shot.png')
  await writeFile(file, pngHeader(1440, 900))

  const good = await verifyShotFile(file, { width: 1440, height: 900 })
  assert.equal(good.ok, true)
  assert.equal(good.width, 1440)
  assert.equal(good.height, 900)
  assert.ok(good.bytes > 1024)
  assert.equal(good.sha256, createHash('sha256').update(await readFile(file)).digest('hex'))

  const wrongWidth = await verifyShotFile(file, { width: 390, height: 900 })
  assert.equal(wrongWidth.ok, false)
  assert.match(wrongWidth.error, /宽度/)

  const missing = await verifyShotFile(path.join(dir, 'missing.png'), { width: 1, height: 1 })
  assert.equal(missing.ok, false)

  const tiny = path.join(dir, 'tiny.png')
  await writeFile(tiny, TINY_PNG)
  const tooSmall = await verifyShotFile(tiny, {})
  assert.equal(tooSmall.ok, false)
  assert.match(tooSmall.error, /过小/)
})

test('cleanRoundShots removes only the same round PNGs', async (t) => {
  const dir = await tempDir(t)
  await writeFile(path.join(dir, 'r1-s1-a.png'), 'a')
  await writeFile(path.join(dir, 'r1-s2-b.png'), 'b')
  await writeFile(path.join(dir, 'r2-s1-c.png'), 'c')
  await writeFile(path.join(dir, 'notes.txt'), 'n')
  await cleanRoundShots(dir, 1)
  assert.deepEqual((await readdir(dir)).sort(), ['notes.txt', 'r2-s1-c.png'])
  await cleanRoundShots(path.join(dir, 'missing'), 1) // no throw
})

test('verifyRoundShotFiles enforces the exactly-four-PNG invariant', async (t) => {
  const dir = await tempDir(t)
  const shotDir = path.join(dir, 'shots', 'c-test')
  await mkdir(shotDir, { recursive: true })
  const shots = []
  for (let index = 0; index < 4; index += 1) {
    const file = `r1-s${index + 1}-shot-${index + 1}.png`
    await writeFile(path.join(shotDir, file), pngHeader(1280, 800))
    shots.push({ file, width: 1280, height: 800, bytes: 2048 })
  }
  const ok = await verifyRoundShotFiles({ shots, shotsDir: shotDir, requiredShots: 4 })
  assert.equal(ok.ok, true)
  assert.equal(ok.count, 4)

  const tooFew = await verifyRoundShotFiles({ shots: shots.slice(0, 3), shotsDir: shotDir, requiredShots: 4 })
  assert.equal(tooFew.ok, false)
  assert.match(tooFew.error, /必须恰好 4 张/)

  const duplicate = await verifyRoundShotFiles({ shots: [...shots.slice(0, 3), shots[0]], shotsDir: shotDir, requiredShots: 4 })
  assert.equal(duplicate.ok, false)

  const badFile = await verifyRoundShotFiles({
    shots: [{ ...shots[0], file: '../escape.png' }, ...shots.slice(1)],
    shotsDir: shotDir,
    requiredShots: 4,
  })
  assert.equal(badFile.ok, false)

  const missing = await verifyRoundShotFiles({
    shots: [{ ...shots[0], file: 'r1-s1-missing.png' }, ...shots.slice(1)],
    shotsDir: shotDir,
    requiredShots: 4,
  })
  assert.equal(missing.ok, false)
})

test('verifyRoundShotFiles detects tampered screenshots via sha256 and tolerates legacy records', async (t) => {
  const dir = await tempDir(t)
  const shotDir = path.join(dir, 'shots', 'c-test')
  await mkdir(shotDir, { recursive: true })
  const shots = []
  for (let index = 0; index < 4; index += 1) {
    const file = `r1-s${index + 1}-shot-${index + 1}.png`
    const bytes = pngHeader(1280, 800)
    await writeFile(path.join(shotDir, file), bytes)
    shots.push({
      file,
      width: 1280,
      height: 800,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  const ok = await verifyRoundShotFiles({ shots, shotsDir: shotDir, requiredShots: 4 })
  assert.equal(ok.ok, true, ok.error)

  // Flip one byte on disk after the hash was recorded → tamper detected.
  const tamperedPath = path.join(shotDir, shots[2].file)
  const tampered = Buffer.from(await readFile(tamperedPath))
  tampered[tampered.length - 2] ^= 0xff
  await writeFile(tamperedPath, tampered)
  const detected = await verifyRoundShotFiles({ shots, shotsDir: shotDir, requiredShots: 4 })
  assert.equal(detected.ok, false)
  assert.match(detected.error, /sha256/)

  // Legacy shot records without sha256 are still accepted (no false alarm).
  const legacyShots = shots.map(({ sha256: _omit, ...rest }) => rest)
  const legacy = await verifyRoundShotFiles({ shots: legacyShots, shotsDir: shotDir, requiredShots: 4 })
  assert.equal(legacy.ok, true, legacy.error)

  // Malformed hash records fail closed.
  const malformed = shots.map((shot, index) => (index === 0 ? { ...shot, sha256: 'not-a-hash' } : shot))
  const badHash = await verifyRoundShotFiles({ shots: malformed, shotsDir: shotDir, requiredShots: 4 })
  assert.equal(badHash.ok, false)
  assert.match(badHash.error, /格式不合法/)
})

test('renderShots fails fast with a clear error when no browser exists (never spawns)', async (t) => {
  const dir = await tempDir(t)
  let spawned = false
  const result = await renderShots({
    cycleId: 'c-test',
    roundNo: 1,
    stateDir: dir,
    specs: [{ kind: 'path', path: 'C:\\demo\\index.html', width: 1280, height: 800, name: 'desktop', page: 'index.html' }],
    requiredShots: 1,
    resolveChrome: () => ({ path: null, source: null, warnings: ['找不到可用的无头浏览器（测试注入）'] }),
    spawnImpl: () => {
      spawned = true
      throw new Error('must not spawn chrome in tests')
    },
  })
  assert.equal(result.ok, false)
  assert.equal(spawned, false)
  assert.match(result.error, /找不到可用的无头浏览器/)
})

test('renderShots rejects an unsafe cycleId before touching the filesystem', async (t) => {
  const dir = await tempDir(t)
  let spawned = false
  const result = await renderShots({
    cycleId: '../escape',
    stateDir: dir,
    specs: [{ kind: 'path', path: 'C:\\demo\\index.html', width: 10, height: 10 }],
    resolveChrome: () => ({ path: 'C:\\fake\\chrome.exe', warnings: [] }),
    exists: () => true,
    spawnImpl: () => {
      spawned = true
      throw new Error('must not spawn chrome in tests')
    },
  })
  assert.equal(result.ok, false)
  assert.equal(spawned, false)
  assert.match(result.error, /cycleId/)
})

test('renderShots records the sha256 of every PNG it produces', async (t) => {
  const dir = await tempDir(t)
  const png = pngHeader(1280, 800)
  const expectedSha = createHash('sha256').update(png).digest('hex')
  const spawnImpl = (_binary, args) => {
    const child = new EventEmitter()
    child.kill = () => {}
    const screenshotArg = String(args.find((arg) => arg.startsWith('--screenshot=')) ?? '')
    const outputPath = screenshotArg.slice('--screenshot='.length)
    // Emulate Chrome writing the artifact shortly after spawn.
    writeFile(outputPath, png).catch(() => {})
    return child
  }
  const result = await renderShots({
    cycleId: 'c-test',
    roundNo: 1,
    stateDir: dir,
    specs: [{ kind: 'path', path: 'C:\\demo\\index.html', width: 1280, height: 800, name: 'desktop', page: 'index.html' }],
    requiredShots: 1,
    resolveChrome: () => ({ path: 'C:\\fake\\chrome.exe', source: 'test', warnings: [] }),
    exists: () => true,
    spawnImpl,
    timeoutMs: 10_000,
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.shots.length, 1)
  assert.equal(result.shots[0].sha256, expectedSha)
  const onDisk = await readFile(path.join(dir, 'shots', 'c-test', result.shots[0].file))
  assert.equal(createHash('sha256').update(onDisk).digest('hex'), expectedSha)
})

test('writeReportHtml writes four temp pages and builds file:// specs', async (t) => {
  const dir = await tempDir(t)
  const pages = Array.from({ length: 4 }, (_unused, index) => ({ name: `r1-report-${index + 1}.html`, html: `<h1>${index}</h1>` }))
  const written = await writeReportHtml({ stateDir: dir, cycleId: 'c-test', roundNo: 1, pages, requiredShots: 4 })
  assert.equal(written.ok, true, written.error)
  assert.equal(written.files.length, 4)
  assert.equal(written.specs.length, 4)
  for (const file of written.files) {
    const content = await readFile(file, 'utf8')
    assert.match(content, /<h1>/)
    assert.ok(file.startsWith(path.join(dir, 'tmp')))
    assert.equal(path.extname(file), '.html')
  }
  assert.ok(written.specs.every((spec) => spec.url.startsWith('file:///')))
  for (const file of written.files) await rm(file, { force: true })

  const mismatch = await writeReportHtml({ stateDir: dir, cycleId: 'c-test', roundNo: 1, pages: pages.slice(0, 3), requiredShots: 4 })
  assert.equal(mismatch.ok, false)
  const unsafe = await writeReportHtml({ stateDir: dir, cycleId: '../x', roundNo: 1, pages, requiredShots: 4 })
  assert.equal(unsafe.ok, false)
})
