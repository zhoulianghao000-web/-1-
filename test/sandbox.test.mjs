/**
 * v1.2 2.4 — modeling metrics sandbox (`review_probe` action `run-metrics`)
 * tests. Fake spawn/temp deps only; the reviewed target is never executed and
 * never written.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildSandboxEnv,
  runModelingMetrics,
  validateModelingRunDeclaration,
} from '../lib/sandbox.js'
import { runReviewProbe } from '../lib/probe.js'
import { clearReviewRegistry, registerReviewChild } from '../lib/review-registry.js'

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rtc-sandbox-test-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

function withCleanRegistry(t) {
  clearReviewRegistry()
  t.after(() => clearReviewRegistry())
}

function makeFakeChild(pid) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => {
    child.killed = true
  }
  return child
}

function makeFakeSpawn(handler) {
  const calls = []
  const spawn = (command, args, options) => {
    const child = makeFakeChild(8000 + calls.length)
    const record = { command, args, options, child }
    calls.push(record)
    setImmediate(() => handler({ ...record, index: calls.length - 1 }))
    return child
  }
  return { spawn, calls }
}

function makeFakeTempDeps(dir) {
  const tempRoot = path.join(dir, 'sandbox-copies')
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
    },
  }
}

async function makeModelingTarget(dir, options = {}) {
  const target = path.join(dir, 'model')
  await mkdir(target, { recursive: true })
  await writeFile(path.join(target, 'README.md'), '# model\nclaimed accuracy 0.95\n')
  await writeFile(path.join(target, 'run.js'), '// model entry\n')
  await writeFile(path.join(target, 'modeling-run.json'), JSON.stringify(options.declaration ?? {
    commands: [['node', 'run.js'], ['node', 'eval.js']],
    metricsFile: 'metrics.json',
    timeoutSeconds: 5,
  }))
  return target
}

const BASE_CONFIG = Object.freeze({
  modelingTimeoutSeconds: 5,
  probeTimeoutSeconds: 5,
  probeMaxCopyFiles: 500,
  probeMaxCopyBytes: 10 * 1024 * 1024,
})

function writerDeps(temp) {
  return { ...temp.deps }
}

// ---------------------------------------------------------------------------
// declaration / env helpers
// ---------------------------------------------------------------------------

test('buildSandboxEnv whitelists env, sets offline proxy/npm/python env and temp dirs', () => {
  const env = buildSandboxEnv({ PATH: '/bin', KEEP: 'yes', OPENAI_API_KEY: 'sk-secret' }, { tmpDir: '/tmp/copy' })
  assert.equal(env.PATH, '/bin')
  // v2.0: host secrets / arbitrary env vars are NOT inherited.
  assert.equal(env.KEEP, undefined)
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.npm_config_offline, 'true')
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:9')
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:9')
  assert.equal(env.PYTHONHASHSEED, '0')
  assert.equal(env.TMPDIR, '/tmp/copy')
  assert.equal(env.TEMP, '/tmp/copy')
})

test('validateModelingRunDeclaration accepts argv arrays and rejects shell strings / escapes', () => {
  const ok = validateModelingRunDeclaration({
    commands: [['python3', 'run.py'], ['node', 'eval.js', '--seed', '7']],
    metricsFile: 'reports/metrics.json',
    timeoutSeconds: 30,
  }, { defaultTimeoutSeconds: 120 })
  assert.equal(ok.ok, true, ok.error)
  assert.deepEqual(ok.commands, [['python3', 'run.py'], ['node', 'eval.js', '--seed', '7']])
  assert.equal(ok.metricsFile, 'reports/metrics.json')
  assert.equal(ok.timeoutSeconds, 30)

  const defaults = validateModelingRunDeclaration({ commands: [['node', 'x.js']] }, { defaultTimeoutSeconds: 42 })
  assert.equal(defaults.metricsFile, 'metrics.json')
  assert.equal(defaults.timeoutSeconds, 42)

  assert.match(validateModelingRunDeclaration(null).error, /JSON 对象/)
  assert.match(validateModelingRunDeclaration({}).error, /缺少 commands/)
  assert.match(validateModelingRunDeclaration({ commands: [] }).error, /缺少 commands/)
  assert.match(validateModelingRunDeclaration({ commands: ['echo hi'] }).error, /argv 数组/)
  assert.match(validateModelingRunDeclaration({ commands: [['node', '']] }).error, /非空字符串/)
  assert.match(validateModelingRunDeclaration({ commands: [['node', 42]] }).error, /非空字符串/)
  assert.match(validateModelingRunDeclaration({ commands: [['node', 'x'.repeat(3000)]] }).error, /过长/)
  assert.match(validateModelingRunDeclaration({
    commands: Array.from({ length: 21 }, () => ['node', 'x.js']),
  }).error, /最多 20/)
  assert.match(validateModelingRunDeclaration({ commands: [['node', 'x.js']], metricsFile: '/abs/metrics.json' }).error, /相对路径/)
  assert.match(validateModelingRunDeclaration({ commands: [['node', 'x.js']], metricsFile: '../outside.json' }).error, /项目内/)
  assert.match(validateModelingRunDeclaration({ commands: [['node', 'x.js']], timeoutSeconds: 0 }).error, /timeoutSeconds/)
  assert.match(validateModelingRunDeclaration({ commands: [['node', 'x.js']], timeoutSeconds: 9999 }).error, /timeoutSeconds/)
})

// ---------------------------------------------------------------------------
// run-metrics through review_probe
// ---------------------------------------------------------------------------

test('run-metrics: non-review callers are denied and missing modeling-run.json is explicit', async (t) => {
  withCleanRegistry(t)
  const dir = await tempDir(t)
  const target = path.join(dir, 'empty')
  await mkdir(target)
  const denied = await runReviewProbe({ args: { action: 'run-metrics' }, execution: { agent: { id: 'intruder' } } })
  assert.equal(denied.ok, false)
  assert.equal(denied.error, 'review_probe 仅限评审子智能体使用')

  registerReviewChild('child-metrics', { targetDir: target, stage: 'judge', cycleId: 'c-test' })
  const fake = makeFakeSpawn(() => {})
  const temp = makeFakeTempDeps(dir)
  const missing = await runReviewProbe({
    args: { action: 'run-metrics' },
    execution: { agent: { id: 'child-metrics' } },
    config: BASE_CONFIG,
    deps: { spawn: fake.spawn, ...writerDeps(temp) },
  })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /modeling-run\.json/)
  assert.equal(fake.calls.length, 0)
  assert.equal(temp.created.length, 0)
})

test('run-metrics: valid declaration runs commands sequentially in one temp copy, offline, then reads metrics', async (t) => {
  withCleanRegistry(t)
  const dir = await tempDir(t)
  const target = await makeModelingTarget(dir)
  registerReviewChild('child-metrics', { targetDir: target, stage: 'judge', cycleId: 'c-test' })
  const temp = makeFakeTempDeps(dir)
  const invoked = []
  const fake = makeFakeSpawn(async ({ command, args, options, child, index }) => {
    invoked.push({ command, args, cwd: options.cwd })
    if (index === 0) child.stdout.emit('data', 'training done\n')
    else child.stdout.emit('data', 'eval done\n')
    await writeFile(path.join(options.cwd, 'metrics.json'), JSON.stringify({ accuracy: 0.91, auc: 0.88 }), 'utf8')
    child.emit('close', 0, null)
  })
  const result = await runReviewProbe({
    args: { action: 'run-metrics' },
    execution: { agent: { id: 'child-metrics' } },
    config: BASE_CONFIG,
    deps: { spawn: fake.spawn, ...writerDeps(temp) },
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.action, 'run-metrics')
  assert.deepEqual(result.metrics, { accuracy: 0.91, auc: 0.88 })
  assert.deepEqual(result.exitCodes, [0, 0])
  assert.equal(result.commands.length, 2)
  assert.deepEqual(result.commands.map((entry) => entry.command), [['node', 'run.js'], ['node', 'eval.js']])
  assert.equal(result.metricsFile, 'metrics.json')
  assert.deepEqual(result.sandbox, { network: 'blocked-env', writes: 'temp-copy-only' })
  assert.ok(result.durationMs >= 0)
  assert.ok(result.copiedFiles >= 3)
  assert.ok(result.copiedBytes > 0)
  assert.equal(result.timedOut, false)
  assert.equal(result.truncated, false)
  assert.ok(result.stdoutTail.includes('training done'))
  assert.ok(result.stderrTail === '' || typeof result.stderrTail === 'string')
  // Both commands ran in the SAME sandbox copy (never the target), directly.
  assert.equal(invoked.length, 2)
  assert.equal(invoked[0].command, 'node')
  assert.equal(invoked[1].command, 'node')
  assert.equal(invoked[0].cwd, temp.created[0])
  assert.equal(invoked[1].cwd, temp.created[0])
  assert.notEqual(temp.created[0], target)
  // Offline env on every command.
  assert.equal(fake.calls[0].options.env.npm_config_offline, 'true')
  assert.equal(fake.calls[0].options.env.HTTP_PROXY, 'http://127.0.0.1:9')
  assert.equal(fake.calls[0].options.env.PYTHONHASHSEED, '0')
  // The reviewed target was not touched.
  assert.deepEqual((await readdir(target)).sort(), ['README.md', 'modeling-run.json', 'run.js'])
  await assert.rejects(readFile(path.join(target, 'metrics.json'), 'utf8'))
  // Temp copy cleaned up.
  assert.equal(temp.removed.length, 1)
  assert.deepEqual(await readdir(temp.tempRoot), [])
})

test('run-metrics: non-zero exit code fails with exitCodes and cleanup', async (t) => {
  withCleanRegistry(t)
  const dir = await tempDir(t)
  const target = await makeModelingTarget(dir)
  registerReviewChild('child-metrics', { targetDir: target, stage: 'judge', cycleId: 'c-test' })
  const temp = makeFakeTempDeps(dir)
  const fake = makeFakeSpawn(async ({ child, options, index }) => {
    if (index === 0) {
      child.stderr.emit('data', 'Traceback: boom\n')
      child.emit('close', 2, null)
      return
    }
    await writeFile(path.join(options.cwd, 'metrics.json'), JSON.stringify({ accuracy: 0.5 }), 'utf8')
    child.emit('close', 0, null)
  })
  const result = await runReviewProbe({
    args: { action: 'run-metrics' },
    execution: { agent: { id: 'child-metrics' } },
    config: BASE_CONFIG,
    deps: { spawn: fake.spawn, ...writerDeps(temp) },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /退出码 2/)
  assert.deepEqual(result.exitCodes, [2, 0])
  assert.ok(result.stderrTail.includes('Traceback'))
  assert.equal(temp.removed.length, 1)
})

test('run-metrics: command timeout kills the process tree and still cleans up', async (t) => {
  withCleanRegistry(t)
  const dir = await tempDir(t)
  const target = await makeModelingTarget(dir, {
    declaration: { commands: [['node', 'slow.js']], metricsFile: 'metrics.json', timeoutSeconds: 1 },
  })
  registerReviewChild('child-metrics', { targetDir: target, stage: 'judge', cycleId: 'c-test' })
  const temp = makeFakeTempDeps(dir)
  const fake = makeFakeSpawn(() => {}) // never closes
  const startedAt = Date.now()
  const result = await runReviewProbe({
    args: { action: 'run-metrics' },
    execution: { agent: { id: 'child-metrics' } },
    config: BASE_CONFIG,
    deps: { spawn: fake.spawn, ...writerDeps(temp) },
  })
  const elapsed = Date.now() - startedAt
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.match(result.error, /超时/)
  assert.ok(elapsed < 5000, `timeout path should be prompt, took ${elapsed}ms`)
  assert.equal(temp.killed.length >= 1, true)
  assert.equal(fake.calls[0].child.killed, true)
  assert.equal(temp.removed.length, 1)
  assert.deepEqual(await readdir(temp.tempRoot), [])
})

test('run-metrics: output tails are truncated and reported', async (t) => {
  withCleanRegistry(t)
  const dir = await tempDir(t)
  const target = await makeModelingTarget(dir, {
    declaration: { commands: [['node', 'noisy.js']], metricsFile: 'metrics.json', timeoutSeconds: 5 },
  })
  registerReviewChild('child-metrics', { targetDir: target, stage: 'judge', cycleId: 'c-test' })
  const temp = makeFakeTempDeps(dir)
  const fake = makeFakeSpawn(async ({ child, options }) => {
    child.stdout.emit('data', `BEGIN-${'x'.repeat(9000)}-END`)
    child.stderr.emit('data', `ERR-${'y'.repeat(9000)}`)
    await writeFile(path.join(options.cwd, 'metrics.json'), JSON.stringify({ ok: 1 }), 'utf8')
    child.emit('close', 0, null)
  })
  const result = await runReviewProbe({
    args: { action: 'run-metrics' },
    execution: { agent: { id: 'child-metrics' } },
    config: BASE_CONFIG,
    deps: { spawn: fake.spawn, ...writerDeps(temp) },
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.stdoutTail.length, 4000)
  assert.equal(result.stderrTail.length, 4000)
  assert.equal(result.stdoutTail.trimEnd().endsWith('-END'), true)
  assert.equal(result.truncated, true)
})

test('run-metrics: missing / invalid / oversized metrics files fail clearly', async (t) => {
  withCleanRegistry(t)
  const dir = await tempDir(t)
  const cases = [
    {
      name: 'missing',
      handler: async ({ child }) => { child.emit('close', 0, null) },
      pattern: /未找到指标文件/,
    },
    {
      name: 'invalid-json',
      handler: async ({ child, options }) => {
        await writeFile(path.join(options.cwd, 'metrics.json'), 'not json', 'utf8')
        child.emit('close', 0, null)
      },
      pattern: /不是合法 JSON/,
    },
    {
      name: 'not-object',
      handler: async ({ child, options }) => {
        await writeFile(path.join(options.cwd, 'metrics.json'), '[1,2,3]', 'utf8')
        child.emit('close', 0, null)
      },
      pattern: /JSON 对象/,
    },
    {
      name: 'oversized',
      handler: async ({ child, options }) => {
        await writeFile(path.join(options.cwd, 'metrics.json'), JSON.stringify({ blob: 'x'.repeat(70000) }), 'utf8')
        child.emit('close', 0, null)
      },
      pattern: /超过上限/,
    },
  ]
  for (const testCase of cases) {
    const target = path.join(dir, `model-${testCase.name}`)
    await mkdir(target)
    await writeFile(path.join(target, 'modeling-run.json'), JSON.stringify({ commands: [['node', 'run.js']], metricsFile: 'metrics.json', timeoutSeconds: 5 }))
    registerReviewChild(`child-${testCase.name}`, { targetDir: target, stage: 'judge', cycleId: 'c-test' })
    const temp = makeFakeTempDeps(dir)
    const fake = makeFakeSpawn(testCase.handler)
    const result = await runReviewProbe({
      args: { action: 'run-metrics' },
      execution: { agent: { id: `child-${testCase.name}` } },
      config: BASE_CONFIG,
      deps: { spawn: fake.spawn, ...writerDeps(temp) },
    })
    assert.equal(result.ok, false, testCase.name)
    assert.match(result.error, testCase.pattern, testCase.name)
    assert.equal(temp.removed.length, 1, testCase.name)
  }
})

test('run-metrics: invalid declarations fail before any copy/spawn', async (t) => {
  withCleanRegistry(t)
  const dir = await tempDir(t)
  const declarations = [
    { badJson: true },
    { commands: ['echo hi'] },
    { commands: [['node', 'x.js']], metricsFile: '../escape.json' },
    { commands: [] },
    { commands: [['node', 'x.js']], timeoutSeconds: 99999 },
  ]
  for (let index = 0; index < declarations.length; index += 1) {
    const target = path.join(dir, `bad-${index}`)
    await mkdir(target)
    await writeFile(
      path.join(target, 'modeling-run.json'),
      declarations[index].badJson === true ? '{ not json' : JSON.stringify(declarations[index]),
    )
    registerReviewChild(`child-bad-${index}`, { targetDir: target, stage: 'judge', cycleId: 'c-test' })
    const temp = makeFakeTempDeps(dir)
    const fake = makeFakeSpawn(() => {})
    const result = await runReviewProbe({
      args: { action: 'run-metrics' },
      execution: { agent: { id: `child-bad-${index}` } },
      config: BASE_CONFIG,
      deps: { spawn: fake.spawn, ...writerDeps(temp) },
    })
    assert.equal(result.ok, false, `case ${index}`)
    assert.equal(fake.calls.length, 0, `case ${index}`)
    assert.equal(temp.created.length, 0, `case ${index}`)
  }
})

test('runModelingMetrics can be called directly with deps (no registry needed)', async (t) => {
  const dir = await tempDir(t)
  const target = await makeModelingTarget(dir)
  const temp = makeFakeTempDeps(dir)
  const fake = makeFakeSpawn(async ({ child, options }) => {
    await writeFile(path.join(options.cwd, 'metrics.json'), JSON.stringify({ score: 1 }), 'utf8')
    child.emit('close', 0, null)
  })
  const result = await runModelingMetrics({
    targetDir: target,
    config: BASE_CONFIG,
    deps: { spawn: fake.spawn, ...writerDeps(temp) },
  })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.metrics, { score: 1 })
  const missingTarget = await runModelingMetrics({ targetDir: '', config: BASE_CONFIG, deps: {} })
  assert.equal(missingTarget.ok, false)
  assert.match(missingTarget.error, /targetDir/)
})
