/**
 * v1.1 1.5 tests: review-child registry, reviewer tool policy and review_probe.
 *
 * review_probe is exercised through its public entry with injected `deps`
 * (fake spawn / temp dir / killTree) so the suite never spawns real processes
 * and never touches the real temp directory.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  PROBE_ACTIONS,
  PROBE_EXCLUDED_DIRS,
  runReviewProbe,
} from '../lib/probe.js'
import {
  REVIEWER_DENIED_TOOLS,
  REVIEWER_PATH_TOOLS,
  clearReviewRegistry,
  evaluateReviewerAccess,
  isInsideOrEqual,
  listReviewChildren,
  lookupReviewChild,
  registerReviewChild,
  unregisterReviewChild,
} from '../lib/review-registry.js'

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rtc-probe-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

function withCleanRegistry(t) {
  clearReviewRegistry()
  t.after(() => clearReviewRegistry())
}

function registerChild(targetDir, sessionId = 'child-review-1', stage = 'attacker') {
  return registerReviewChild(sessionId, { targetDir, stage, cycleId: 'c-test' })
}

function makeFakeChild(pid) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {
    child.killed = true
  }
  return child
}

/**
 * Fake `spawn` used through review_probe's `deps`. `handler({command, args,
 * options, child, index})` runs on `setImmediate`; the handler emits data/close.
 */
function makeFakeSpawn(handler) {
  const calls = []
  const spawn = (command, args, options) => {
    const child = makeFakeChild(9000 + calls.length)
    const record = { command, args, options, child }
    calls.push(record)
    setImmediate(() => handler({ ...record, index: calls.length - 1 }))
    return child
  }
  return { spawn, calls }
}

/** Fake temp-copy deps: every copy lives under `<dir>/temp-root` and is tracked. */
function makeFakeTempDeps(dir, extra = {}) {
  const tempRoot = path.join(dir, 'temp-root')
  const created = []
  const removed = []
  const killed = []
  let counter = 0
  return {
    tempRoot,
    created,
    removed,
    killed,
    deps: {
      makeTempDir: async () => {
        await mkdir(tempRoot, { recursive: true })
        const copyDir = path.join(tempRoot, `copy-${counter}`)
        counter += 1
        await mkdir(copyDir, { recursive: true })
        created.push(copyDir)
        return copyDir
      },
      removeTempDir: async (target) => {
        removed.push(target)
        await rm(target, { recursive: true, force: true })
      },
      killTree: (child) => {
        killed.push(child)
        if (typeof child?.kill === 'function') child.kill()
      },
      ...extra,
    },
  }
}

// ---------------------------------------------------------------------------
// review-registry: pure module-level functions
// ---------------------------------------------------------------------------

test('review registry: register / lookup / list / unregister / clear', (t) => {
  withCleanRegistry(t)
  const target = path.resolve('C:\\projects\\demo')
  assert.equal(lookupReviewChild('missing'), null)
  assert.deepEqual(listReviewChildren(), [])

  const attacker = registerReviewChild('child-a', { targetDir: target, stage: 'attacker', cycleId: 'c-1', now: 100 })
  assert.equal(attacker.sessionId, 'child-a')
  assert.equal(attacker.targetDir, target)
  assert.equal(attacker.stage, 'attacker')
  assert.equal(attacker.cycleId, 'c-1')
  assert.equal(attacker.registeredAt, 100)
  assert.equal(Object.isFrozen(attacker), true)
  // Mutating the returned copy never changes the registry.
  try {
    attacker.stage = 'hacked'
  } catch {
    // Frozen object: assignment throws in strict mode (ESM is strict).
  }
  assert.equal(lookupReviewChild('child-a').stage, 'attacker')

  registerReviewChild('child-j', { targetDir: target, stage: 'judge', cycleId: 'c-1' })
  assert.equal(listReviewChildren().length, 2)
  assert.equal(listReviewChildren().map((record) => record.sessionId).sort().join(','), 'child-a,child-j')
  // Re-registering replaces the record (same child id).
  registerReviewChild('child-a', { targetDir: target, stage: 'judge', cycleId: 'c-2' })
  assert.equal(lookupReviewChild('child-a').stage, 'judge')
  assert.equal(lookupReviewChild('child-a').cycleId, 'c-2')

  assert.equal(unregisterReviewChild('child-a'), true)
  assert.equal(unregisterReviewChild('child-a'), false)
  assert.equal(lookupReviewChild('child-a'), null)
  assert.equal(unregisterReviewChild(''), false)
  assert.equal(registerReviewChild('', {}), null)
  assert.equal(registerReviewChild(null, {}), null)
  assert.equal(registerReviewChild('   ', {}), null)

  clearReviewRegistry()
  assert.deepEqual(listReviewChildren(), [])
})

test('review registry: isInsideOrEqual handles nested and escaping paths', () => {
  assert.equal(isInsideOrEqual('C:\\ws\\app', 'C:\\ws\\app\\index.html'), true)
  assert.equal(isInsideOrEqual('C:\\ws\\app', 'C:\\ws\\app'), true)
  assert.equal(isInsideOrEqual('C:\\ws\\app', 'C:\\ws\\app2\\x.js'), false)
  assert.equal(isInsideOrEqual('C:\\ws\\app', 'C:\\ws\\other\\x.js'), false)
  assert.equal(isInsideOrEqual('', 'C:\\ws'), false)
})

test('review registry: reviewer tool policy denies dangerous tools and escapes', () => {
  const target = path.resolve('C:\\projects\\demo')
  const record = { sessionId: 'child', targetDir: target, stage: 'judge', cycleId: 'c' }

  for (const tool of REVIEWER_DENIED_TOOLS) {
    const reason = evaluateReviewerAccess(record, tool, {})
    assert.equal(typeof reason, 'string', `${tool} 应被拒绝`)
    assert.match(reason, /硬只读/)
  }
  assert.match(evaluateReviewerAccess(record, 'team_task_create', {}), /硬只读/)
  assert.equal(evaluateReviewerAccess(record, 'review_probe', { action: 'list-files' }), null)
  assert.match(evaluateReviewerAccess(record, 'adversarial_review_status', {}), /允许名单|硬只读/)
  assert.match(evaluateReviewerAccess(record, 'adversarial_review_round', {}), /允许名单|硬只读/)
  assert.match(evaluateReviewerAccess(record, 'adversarial_review_batch', {}), /允许名单|硬只读/)
  // v2.0 default-deny: global readers / URL tools / MCP must be refused.
  assert.match(evaluateReviewerAccess(record, 'modlens_read_image', { path: 'C:\\Windows\\x.jpg' }), /允许名单/)
  assert.match(evaluateReviewerAccess(record, 'list_mcp_resources', {}), /允许名单/)
  assert.match(evaluateReviewerAccess(record, 'read_mcp_resource', {}), /允许名单/)
  // The framework structured-output channel must stay allowed (result delivery).
  assert.equal(evaluateReviewerAccess(record, 'structured_output', {}), null)
  assert.match(evaluateReviewerAccess(record, 'web_fetch', { url: 'https://example.com' }), /允许名单/)

  // Filesystem tool names are path-checked.
  for (const tool of REVIEWER_PATH_TOOLS) {
    assert.equal(evaluateReviewerAccess(record, tool, { file_path: path.join(target, 'index.html') }), null)
    assert.equal(evaluateReviewerAccess(record, tool, { path: path.join(target, 'index.html') }), null)
    assert.equal(evaluateReviewerAccess(record, tool, { path: 'index.html' }), null)
    assert.equal(typeof evaluateReviewerAccess(record, tool, { path: '../secret.txt' }), 'string')
    assert.match(evaluateReviewerAccess(record, tool, { path: path.join(path.dirname(target), 'secret.txt') }), /拒绝访问/)
    assert.match(evaluateReviewerAccess(record, tool, { path: '' }), /fail-closed/)
    assert.match(evaluateReviewerAccess(record, tool, { path: 42 }), /fail-closed/)
    if (tool === 'glob' || tool === 'grep') {
      // Optional path → the child cwd (= target root) is the safe default.
      assert.equal(evaluateReviewerAccess(record, tool, {}), null)
    } else {
      assert.match(evaluateReviewerAccess(record, tool, {}), /fail-closed/)
    }
  }
  // glob/grep may omit the path (defaults to the child cwd = target root).
  assert.equal(evaluateReviewerAccess(record, 'glob', { pattern: '**/*.js' }), null)
  assert.equal(evaluateReviewerAccess(record, 'grep', { pattern: 'secret' }), null)

  // Degenerate records fail closed.
  assert.match(evaluateReviewerAccess(null, 'read', { path: 'index.html' }), /缺少评审登记/)
  assert.match(evaluateReviewerAccess({ targetDir: '' }, 'read', { path: 'index.html' }), /缺少评审登记/)
  assert.match(evaluateReviewerAccess(record, '', {}), /无法识别工具名/)
})

test('v2.0: a target-internal symlink cannot escape the real target (realpath guard)', async (t) => {
  const dir = await tempDir(t)
  withCleanRegistry(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  const outsideDir = path.join(dir, 'outside')
  await mkdir(outsideDir)
  const outside = path.join(outsideDir, 'secret.txt')
  await writeFile(outside, 'secret-outside')
  let link = path.join(target, 'readme-link.txt')
  try {
    await symlink(outside, link)
  } catch {
    // On Windows a directory junction usually works without elevation.
    link = path.join(target, 'linked-dir')
    try {
      await symlink(outsideDir, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      t.skip('symlink/junction creation is not permitted in this environment')
      return
    }
  }
  registerReviewChild('child-link', { targetDir: target, stage: 'attacker', cycleId: 'c-link' })
  const record = lookupReviewChild('child-link')
  const readPath = link.endsWith('linked-dir') ? path.join(link, 'secret.txt') : link
  const lexicalInside = evaluateReviewerAccess(record, 'read', { file_path: path.join(target, path.basename(readPath)) })
  assert.equal(typeof lexicalInside, 'string')
  assert.match(lexicalInside, /符号链接/)
  assert.match(evaluateReviewerAccess(record, 'read', { file_path: readPath }), /符号链接/)
})

test('review registry: reviewer may read its own round evidence dir but not other state paths', () => {
  const target = path.resolve('C:\\projects\\demo')
  const evidence = path.resolve('C:\\Users\\x\\.dsh\\adversarial-review\\shots\\c-1')
  const record = { sessionId: 'child', targetDir: target, evidenceDir: evidence, stage: 'attacker', cycleId: 'c-1' }

  assert.equal(evaluateReviewerAccess(record, 'read_image', { path: path.join(evidence, 'r1-s1-home.png') }), null)
  assert.equal(evaluateReviewerAccess(record, 'read', { file_path: path.join(evidence, 'r1-s1-home.png') }), null)
  // Anything outside the target and the current round's evidence dir stays denied.
  assert.match(
    evaluateReviewerAccess(record, 'read', { file_path: path.join(path.dirname(evidence), 'state.json') }),
    /拒绝访问/,
  )
  assert.match(
    evaluateReviewerAccess(record, 'read', { file_path: path.join(path.dirname(path.dirname(evidence)), 'other', 'x.png') }),
    /拒绝访问/,
  )
})

// ---------------------------------------------------------------------------
// review_probe gating + action validation
// ---------------------------------------------------------------------------
test('review_probe: non-review callers are rejected with the fixed message', async (t) => {
  withCleanRegistry(t)
  const dir = await tempDir(t)
  registerChild(dir, 'child-review-1')
  const nonReview = await runReviewProbe({ args: { action: 'list-files' }, execution: { agent: { id: 'other-session' } } })
  assert.equal(nonReview.ok, false)
  assert.equal(nonReview.error, 'review_probe 仅限评审子智能体使用')
  const noAgent = await runReviewProbe({ args: { action: 'list-files' }, execution: null })
  assert.equal(noAgent.ok, false)
  assert.equal(noAgent.error, 'review_probe 仅限评审子智能体使用')

  const badAction = await runReviewProbe({ args: { action: 'shell' }, execution: { agent: { id: 'child-review-1' } } })
  assert.equal(badAction.ok, false)
  assert.match(badAction.error, /action 必须是/)
  const missingAction = await runReviewProbe({ args: {}, execution: { agent: { id: 'child-review-1' } } })
  assert.equal(missingAction.ok, false)
  assert.equal(PROBE_ACTIONS.length, 5)

  // Unregister → no longer a reviewer.
  unregisterReviewChild('child-review-1')
  const after = await runReviewProbe({ args: { action: 'list-files' }, execution: { agent: { id: 'child-review-1' } } })
  assert.equal(after.error, 'review_probe 仅限评审子智能体使用')
})

test('review_probe list-files: excludes heavy dirs, caps files and rejects escapes', async (t) => {
  withCleanRegistry(t)
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(path.join(target, 'src'), { recursive: true })
  await mkdir(path.join(target, 'node_modules', 'pkg'), { recursive: true })
  await mkdir(path.join(target, '.git'), { recursive: true })
  await mkdir(path.join(target, 'dist'), { recursive: true })
  await mkdir(path.join(target, 'dist-build'), { recursive: true })
  await writeFile(path.join(target, 'index.html'), '<h1>x</h1>')
  await writeFile(path.join(target, 'src', 'app.js'), 'console.log(1)')
  await writeFile(path.join(target, 'node_modules', 'pkg', 'index.js'), 'x')
  await writeFile(path.join(target, '.git', 'config'), 'x')
  await writeFile(path.join(target, 'dist', 'bundle.js'), 'x')
  await writeFile(path.join(target, 'dist-build', 'bundle.js'), 'x')
  await writeFile(path.join(dir, 'outside.txt'), 'secret')
  registerChild(target, 'child-review-1')

  const exec = { agent: { id: 'child-review-1' } }
  const listed = await runReviewProbe({ args: { action: 'list-files' }, execution: exec })
  assert.equal(listed.ok, true, listed.error)
  assert.equal(listed.action, 'list-files')
  const paths = listed.files.map((file) => file.path)
  assert.deepEqual(paths.sort(), ['index.html', 'src/app.js'])
  for (const file of listed.files) assert.equal(Number.isInteger(file.size), true)
  assert.equal(listed.count, 2)
  assert.equal(listed.truncated, false)
  for (const excluded of PROBE_EXCLUDED_DIRS) {
    assert.equal(paths.some((file) => file.startsWith(`${excluded}/`)), false)
  }

  // Sub-directory listing.
  const sub = await runReviewProbe({ args: { action: 'list-files', path: 'src' }, execution: exec })
  assert.equal(sub.ok, true)
  assert.deepEqual(sub.files.map((file) => file.path), ['src/app.js'])

  // maxFiles cap.
  const capped = await runReviewProbe({ args: { action: 'list-files', maxFiles: 1 }, execution: exec })
  assert.equal(capped.ok, true)
  assert.equal(capped.files.length, 1)
  assert.equal(capped.truncated, true)

  // Escapes are rejected.
  for (const escapePath of ['..', '../outside.txt', path.join(dir, 'outside.txt')]) {
    const blocked = await runReviewProbe({ args: { action: 'list-files', path: escapePath }, execution: exec })
    assert.equal(blocked.ok, false, `path=${escapePath} 应被拒绝`)
    assert.match(blocked.error, /不在被评审项目目录内/)
  }
})

test('review_probe read-text: content, size cap, binary rejection, escapes', async (t) => {
  withCleanRegistry(t)
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  await writeFile(path.join(target, 'index.html'), '<h1>hello</h1>\n中文内容\n')
  await writeFile(path.join(target, 'big.txt'), 'x'.repeat(200))
  await writeFile(path.join(target, 'binary.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x47]))
  await writeFile(path.join(dir, 'outside.txt'), 'secret')
  registerChild(target, 'child-review-1')
  const exec = { agent: { id: 'child-review-1' } }

  const read = await runReviewProbe({ args: { action: 'read-text', path: 'index.html' }, execution: exec })
  assert.equal(read.ok, true, read.error)
  assert.equal(read.path, 'index.html')
  assert.ok(read.content.includes('hello'))
  assert.ok(read.content.includes('中文内容'))
  assert.equal(read.bytes > 0, true)

  const tooBig = await runReviewProbe({ args: { action: 'read-text', path: 'big.txt', maxBytes: 10 }, execution: exec })
  assert.equal(tooBig.ok, false)
  assert.match(tooBig.error, /超过读取上限/)

  const binary = await runReviewProbe({ args: { action: 'read-text', path: 'binary.bin' }, execution: exec })
  assert.equal(binary.ok, false)
  assert.match(binary.error, /二进制/)

  const escape = await runReviewProbe({ args: { action: 'read-text', path: '../outside.txt' }, execution: exec })
  assert.equal(escape.ok, false)
  assert.match(escape.error, /不在被评审项目目录内/)

  const missing = await runReviewProbe({ args: { action: 'read-text', path: 'nope.txt' }, execution: exec })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /不存在或不可访问/)

  const noPath = await runReviewProbe({ args: { action: 'read-text' }, execution: exec })
  assert.equal(noPath.ok, false)
  assert.match(noPath.error, /需要 path/)
})

test('review_probe check-syntax: node --check results and excluded dirs', async (t) => {
  withCleanRegistry(t)
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(path.join(target, 'node_modules'), { recursive: true })
  await writeFile(path.join(target, 'good.js'), 'export const ok = 1\n')
  await writeFile(path.join(target, 'bad.mjs'), 'export const broken = {\n')
  await writeFile(path.join(target, 'notes.txt'), 'not js')
  await writeFile(path.join(target, 'node_modules', 'broken.js'), 'this is not javascript {')
  registerChild(target, 'child-review-1')

  const fake = makeFakeSpawn(({ args, child }) => {
    const file = String(args[args.length - 1] ?? '')
    if (file.endsWith('bad.mjs')) {
      child.stderr.emit('data', 'SyntaxError: Unexpected end of input')
      child.emit('close', 1, null)
      return
    }
    child.emit('close', 0, null)
  })
  const result = await runReviewProbe({
    args: { action: 'check-syntax' },
    execution: { agent: { id: 'child-review-1' } },
    deps: { spawn: fake.spawn },
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.action, 'check-syntax')
  assert.equal(result.checked, 2)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].file, 'bad.mjs')
  assert.match(result.failures[0].error, /SyntaxError/)
  assert.equal(result.timedOut, false)
  // node_modules is never traversed.
  assert.equal(fake.calls.some((call) => String(call.args[1]).includes('node_modules')), false)
})

// ---------------------------------------------------------------------------
// review_probe run-tests: read-only temp copy, fake spawn, cleanup, timeout
// ---------------------------------------------------------------------------

test('review_probe run-tests: project without scripts.test is rejected without spawning', async (t) => {
  withCleanRegistry(t)
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  await writeFile(path.join(target, 'package.json'), JSON.stringify({ name: 'no-tests', version: '1.0.0' }))
  registerChild(target, 'child-review-1')
  const fake = makeFakeSpawn(({ child }) => child.emit('close', 0, null))
  const temp = makeFakeTempDeps(dir)

  const result = await runReviewProbe({
    args: { action: 'run-tests' },
    execution: { agent: { id: 'child-review-1' } },
    config: { probeTimeoutSeconds: 5 },
    deps: { spawn: fake.spawn, ...temp.deps },
  })
  assert.equal(result.ok, false)
  assert.equal(result.action, 'run-tests')
  assert.equal(result.error, '项目没有 package.json scripts.test')
  assert.equal(fake.calls.length, 0)
  // The temp copy was created, used and removed.
  assert.equal(temp.created.length, 1)
  assert.equal(temp.removed.length, 1)
  assert.deepEqual(await readdir(temp.tempRoot), [])

  // A missing package.json is the same "no scripts.test" case: never guess a
  // command, return the explicit error and still clean up.
  const emptyTarget = path.join(dir, 'app-empty')
  await mkdir(emptyTarget)
  registerChild(emptyTarget, 'child-review-2')
  const missingPackage = await runReviewProbe({
    args: { action: 'run-tests' },
    execution: { agent: { id: 'child-review-2' } },
    config: { probeTimeoutSeconds: 5 },
    deps: { spawn: fake.spawn, ...temp.deps },
  })
  assert.equal(missingPackage.ok, false)
  assert.equal(missingPackage.error, '项目没有 package.json scripts.test')
  assert.ok(missingPackage.warnings.some((warning) => warning.includes('package.json')))
  assert.equal(fake.calls.length, 0)
  assert.deepEqual(await readdir(temp.tempRoot), [])
})

test('review_probe run-tests: runs npm test in the copy with offline env and cleans up', async (t) => {
  withCleanRegistry(t)
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(path.join(target, 'test'), { recursive: true })
  await writeFile(path.join(target, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }))
  await writeFile(path.join(target, 'index.html'), '<h1>x</h1>')
  await writeFile(path.join(target, 'test', 'a.test.js'), '// test')
  registerChild(target, 'child-review-1')
  const fake = makeFakeSpawn(({ child }) => {
    child.stdout.emit('data', 'ok 1 - demo\n')
    child.stderr.emit('data', '# tests 1\n')
    child.emit('close', 0, null)
  })
  const temp = makeFakeTempDeps(dir)

  const result = await runReviewProbe({
    args: { action: 'run-tests' },
    execution: { agent: { id: 'child-review-1' } },
    config: { probeTimeoutSeconds: 5 },
    deps: { spawn: fake.spawn, ...temp.deps },
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.exitCode, 0)
  assert.match(result.command, /npm/)
  assert.match(result.command, /test/)
  assert.ok(result.stdoutTail.includes('ok 1 - demo'))
  assert.ok(result.stderrTail.includes('# tests 1'))
  assert.equal(result.copiedFiles, 3)
  assert.ok(result.copiedBytes > 0)
  assert.equal(result.truncated, false)
  assert.equal(temp.created.length, 1)
  assert.deepEqual(await readdir(temp.tempRoot), [])

  // Spawn contract: npm.cmd/npm with `test`, cwd = temp copy, offline env.
  assert.equal(fake.calls.length, 1)
  const call = fake.calls[0]
  assert.equal(path.basename(call.command), process.platform === 'win32' ? 'npm.cmd' : 'npm')
  assert.deepEqual(call.args, ['test'])
  assert.equal(call.options.cwd, temp.created[0])
  assert.equal(call.options.env.npm_config_offline, 'true')
  assert.equal(call.options.env.HTTP_PROXY, 'http://127.0.0.1:9')
  assert.equal(call.options.env.HTTPS_PROXY, 'http://127.0.0.1:9')
})

test('review_probe run-tests: timeout kills the process tree and still cleans up', async (t) => {
  withCleanRegistry(t)
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  await writeFile(path.join(target, 'package.json'), JSON.stringify({ name: 'slow', scripts: { test: 'node slow.js' } }))
  registerChild(target, 'child-review-1')
  // Never emits close → the capture timeout must fire and kill the tree.
  const fake = makeFakeSpawn(() => {})
  const temp = makeFakeTempDeps(dir)

  const startedAt = Date.now()
  const result = await runReviewProbe({
    args: { action: 'run-tests' },
    execution: { agent: { id: 'child-review-1' } },
    config: { probeTimeoutSeconds: 0.1 },
    deps: { spawn: fake.spawn, ...temp.deps },
  })
  const elapsed = Date.now() - startedAt
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.match(result.error, /超时/)
  assert.equal(temp.killed.length, 1)
  assert.equal(fake.calls[0].child.killed, true)
  assert.ok(elapsed < 5000, `超时路径应快速返回，实际 ${elapsed}ms`)
  assert.deepEqual(await readdir(temp.tempRoot), [])
})

test('review_probe run-tests: Windows npm.cmd spawn failure falls back to cmd.exe', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('仅 Windows 需要 cmd.exe 回退')
    return
  }
  withCleanRegistry(t)
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  await writeFile(path.join(target, 'package.json'), JSON.stringify({ name: 'fallback', scripts: { test: 'true' } }))
  registerChild(target, 'child-review-1')
  const fake = makeFakeSpawn(({ index, child }) => {
    if (index === 0) {
      const error = new Error('spawn EINVAL')
      error.code = 'EINVAL'
      child.emit('error', error)
      return
    }
    child.stdout.emit('data', 'ok')
    child.emit('close', 0, null)
  })
  const temp = makeFakeTempDeps(dir)

  const result = await runReviewProbe({
    args: { action: 'run-tests' },
    execution: { agent: { id: 'child-review-1' } },
    config: { probeTimeoutSeconds: 5 },
    deps: { spawn: fake.spawn, ...temp.deps },
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(fake.calls.length, 2)
  assert.equal(path.basename(fake.calls[0].command), 'npm.cmd')
  assert.match(fake.calls[1].command, /cmd\.exe$/i)
  assert.deepEqual(fake.calls[1].args.slice(0, 3), ['/d', '/s', '/c'])
  assert.ok(result.warnings.some((warning) => warning.includes('npm.cmd')))
  assert.match(result.command, /cmd\.exe .*npm test/)
  assert.deepEqual(await readdir(temp.tempRoot), [])
})

test('review_probe run-tests: stdout/stderr are tail-truncated to 4000 chars', async (t) => {
  withCleanRegistry(t)
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  await writeFile(path.join(target, 'package.json'), JSON.stringify({ name: 'noisy', scripts: { test: 'noisy' } }))
  registerChild(target, 'child-review-1')
  const fake = makeFakeSpawn(({ child }) => {
    child.stdout.emit('data', `BEGIN-${'x'.repeat(9000)}-END`)
    child.stderr.emit('data', `ERR-${'y'.repeat(9000)}`)
    child.emit('close', 0, null)
  })
  const temp = makeFakeTempDeps(dir)

  const result = await runReviewProbe({
    args: { action: 'run-tests' },
    execution: { agent: { id: 'child-review-1' } },
    config: { probeTimeoutSeconds: 5 },
    deps: { spawn: fake.spawn, ...temp.deps },
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.stdoutTail.length, 4000)
  assert.equal(result.stderrTail.length, 4000)
  assert.equal(result.stdoutTail.endsWith('-END'), true)
  assert.equal(result.truncated, true)
})

test('review_probe run-tests: copy budget rejects oversized projects without spawning', async (t) => {
  withCleanRegistry(t)
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(target)
  await writeFile(path.join(target, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'true' } }))
  await writeFile(path.join(target, 'a.txt'), 'a')
  registerChild(target, 'child-review-1')
  const fake = makeFakeSpawn(({ child }) => child.emit('close', 0, null))
  const temp = makeFakeTempDeps(dir)

  const result = await runReviewProbe({
    args: { action: 'run-tests' },
    execution: { agent: { id: 'child-review-1' } },
    config: { probeTimeoutSeconds: 5, probeMaxCopyFiles: 1 },
    deps: { spawn: fake.spawn, ...temp.deps },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /上限/)
  assert.equal(fake.calls.length, 0)
  assert.equal(temp.created.length, 0)
})

test('review_probe run-tests: oversized node_modules is skipped with a warning', async (t) => {
  withCleanRegistry(t)
  const dir = await tempDir(t)
  const target = path.join(dir, 'app')
  await mkdir(path.join(target, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(path.join(target, 'package.json'), JSON.stringify({ name: 'with-modules', scripts: { test: 'true' } }))
  await writeFile(path.join(target, 'a.txt'), 'a')
  await writeFile(path.join(target, 'node_modules', 'pkg', 'index.js'), 'x')
  registerChild(target, 'child-review-1')
  const fake = makeFakeSpawn(({ child }) => child.emit('close', 0, null))
  const temp = makeFakeTempDeps(dir)

  const result = await runReviewProbe({
    args: { action: 'run-tests' },
    execution: { agent: { id: 'child-review-1' } },
    config: { probeTimeoutSeconds: 5, probeMaxCopyFiles: 2 },
    deps: { spawn: fake.spawn, ...temp.deps },
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.copiedFiles, 2)
  assert.ok(result.warnings.some((warning) => warning.includes('node_modules')))
  // node_modules really was not copied.
  assert.deepEqual(await readdir(temp.tempRoot), [])
})

test('review_probe: every action fails closed for unregistered callers', async () => {
  clearReviewRegistry()
  for (const action of PROBE_ACTIONS) {
    const result = await runReviewProbe({ args: { action }, execution: { agent: { id: 'intruder' } } })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'review_probe 仅限评审子智能体使用')
  }
})
