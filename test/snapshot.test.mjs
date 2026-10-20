import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  SNAPSHOT_LIMITS,
  computeSnapshot,
  computeSnapshotSync,
  findGitCommit,
  isSkippedDirName,
  resolveSnapshotLimits,
} from '../lib/snapshot.js'

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rtc-snap-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

const SHA256_RE = /^[0-9a-f]{64}$/

function writeGitCheckout(root, commit) {
  mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true })
  writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(path.join(root, '.git', 'refs', 'heads', 'main'), `${commit}\n`)
}

test('SNAPSHOT_LIMITS expose the documented bounds and skip dirs', () => {
  assert.equal(SNAPSHOT_LIMITS.maxFiles, 20000)
  assert.equal(SNAPSHOT_LIMITS.maxHashBytes, 512 * 1024 * 1024)
  assert.equal(SNAPSHOT_LIMITS.maxFileBytes, 64 * 1024 * 1024)
  // v2.0: dist / .next build outputs are covered by the snapshot.
  for (const dir of ['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.cache', 'coverage', '.idea', '.vscode']) {
    assert.ok(SNAPSHOT_LIMITS.skipDirs.includes(dir), `missing skip dir ${dir}`)
  }
  assert.equal(SNAPSHOT_LIMITS.skipDirs.includes('dist'), false)
  assert.equal(SNAPSHOT_LIMITS.skipDirs.includes('dist-*'), false)
  assert.equal(SNAPSHOT_LIMITS.skipDirs.includes('.next'), false)
  assert.equal(isSkippedDirName('node_modules'), true)
  assert.equal(isSkippedDirName('NODE_MODULES'), true)
  assert.equal(isSkippedDirName('dist-2024'), false)
  assert.equal(isSkippedDirName('.next'), false)
  assert.equal(isSkippedDirName('distribution'), false)
  assert.equal(isSkippedDirName('src'), false)
  // Extra patterns append to (never replace) the defaults.
  const limits = resolveSnapshotLimits({ skipDirs: ['build'], maxFiles: 7 })
  assert.equal(limits.maxFiles, 7)
  assert.ok(limits.skipDirs.includes('node_modules'))
  assert.ok(limits.skipDirs.includes('build'))
})

test('computeSnapshot fingerprints an empty directory deterministically', async (t) => {
  const dir = await tempDir(t)
  const first = await computeSnapshot(dir)
  const second = await computeSnapshotSync(dir)
  assert.equal(first.ok, true, first.error?.message)
  assert.equal(first.schemaVersion, 1)
  assert.equal(first.targetDir, path.resolve(dir))
  assert.equal(first.fileCount, 0)
  assert.equal(first.hashedBytes, 0)
  assert.equal(first.truncated, false)
  assert.equal(first.skippedCount, 0)
  assert.deepEqual(first.files, [])
  assert.match(first.manifestHash, SHA256_RE)
  assert.equal(first.manifestHash, second.manifestHash)
})

test('computeSnapshot hashes nested files, sorts paths and detects content changes', async (t) => {
  const dir = await tempDir(t)
  await mkdir(path.join(dir, 'src', 'nested'), { recursive: true })
  await writeFile(path.join(dir, 'index.html'), '<h1>hello</h1>')
  await writeFile(path.join(dir, 'src', 'app.js'), 'console.log(1)')
  await writeFile(path.join(dir, 'src', 'nested', 'deep.js'), 'export default 1')

  const snapshot = await computeSnapshot(dir)
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.fileCount, 3)
  assert.deepEqual(snapshot.files.map((entry) => entry.path), ['index.html', 'src/app.js', 'src/nested/deep.js'])
  for (const entry of snapshot.files) {
    assert.equal(path.isAbsolute(entry.path), false)
    assert.equal(entry.path.includes('\\'), false)
    assert.match(entry.sha256, SHA256_RE)
    assert.ok(Number.isFinite(entry.size))
    assert.ok(Number.isFinite(entry.mtimeMs))
  }
  assert.ok(snapshot.hashedBytes > 0)

  // Same content again → same manifest hash (mtime unchanged, no rewrite yet).
  const again = await computeSnapshot(dir)
  assert.equal(again.manifestHash, snapshot.manifestHash)

  await writeFile(path.join(dir, 'src', 'app.js'), 'console.log(2)')
  const changed = await computeSnapshot(dir)
  assert.notEqual(changed.manifestHash, snapshot.manifestHash)
  const changedFile = changed.files.find((entry) => entry.path === 'src/app.js')
  assert.notEqual(changedFile.sha256, snapshot.files.find((entry) => entry.path === 'src/app.js').sha256)

  // New/deleted files also change the manifest hash.
  await writeFile(path.join(dir, 'extra.txt'), 'x')
  const added = await computeSnapshot(dir)
  assert.notEqual(added.manifestHash, changed.manifestHash)
})

test('computeSnapshot skips configured directories and never follows symlinks', async (t) => {
  const dir = await tempDir(t)
  await writeFile(path.join(dir, 'keep.txt'), 'keep')
  for (const skipped of ['node_modules', '__pycache__', '.git', '.cache', 'coverage', '.vscode']) {
    await mkdir(path.join(dir, skipped), { recursive: true })
    await writeFile(path.join(dir, skipped, 'hidden.txt'), 'hidden')
  }
  // v2.0: build outputs are fingerprinted (they are often the delivered artifact).
  await mkdir(path.join(dir, 'dist-20240101'), { recursive: true })
  await writeFile(path.join(dir, 'dist-20240101', 'hidden.txt'), 'hidden')
  const snapshot = await computeSnapshot(dir)
  assert.deepEqual(snapshot.files.map((entry) => entry.path), ['dist-20240101/hidden.txt', 'keep.txt'])
  assert.equal(snapshot.fileCount, 2)

  // Custom skip dirs are appended, not substituted.
  await mkdir(path.join(dir, 'build'))
  await writeFile(path.join(dir, 'build', 'out.bin'), 'x')
  const custom = await computeSnapshot(dir, { limits: { skipDirs: ['build'] } })
  assert.deepEqual(custom.files.map((entry) => entry.path), ['dist-20240101/hidden.txt', 'keep.txt'])

  // Symlink/junction (create a directory junction on Windows without elevation).
  const outside = await tempDir(t)
  await writeFile(path.join(outside, 'secret.txt'), 'secret-outside')
  try {
    await symlink(outside, path.join(dir, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    t.skip('symlink/junction creation is not permitted in this environment')
  }
  // v2.0: symlinks cannot be hashed safely; the snapshot fails with an
  // actionable error instead of producing an undeliverable passed round.
  const withLink = await computeSnapshot(dir)
  assert.equal(withLink.ok, false)
  assert.equal(withLink.error.code, 'SYMLINK_UNSUPPORTED')
  assert.match(withLink.error.message, /符号链接/)
  const syncWithLink = computeSnapshotSync(dir)
  assert.equal(syncWithLink.ok, false)
  assert.equal(syncWithLink.error.code, 'SYMLINK_UNSUPPORTED')
  assert.equal(JSON.stringify(withLink).includes('secret-outside'), false)
})

test('computeSnapshot enforces file-count, per-file and hash-budget limits', async (t) => {
  const dir = await tempDir(t)
  for (let index = 0; index < 5; index += 1) {
    await writeFile(path.join(dir, `f${index}.txt`), `content-${index}`)
  }
  const truncated = await computeSnapshot(dir, { limits: { maxFiles: 3 } })
  assert.equal(truncated.truncated, true)
  assert.equal(truncated.fileCount, 3)
  assert.equal(truncated.files.length, 3)
  assert.equal(truncated.manifestHash.length, 64)

  // A file over maxFileBytes is recorded with size+mtime but no hash.
  const oversized = await computeSnapshot(dir, { limits: { maxFileBytes: 4 } })
  assert.equal(oversized.truncated, false)
  assert.equal(oversized.files.length, 5)
  for (const entry of oversized.files) {
    assert.equal(entry.sha256, undefined)
    assert.equal(entry.skipped, true)
  }
  assert.equal(oversized.skippedCount, 5)
  assert.equal(oversized.hashedBytes, 0)

  // Budget exhausted after the first small file: the rest is skipped, not fatal.
  const budgeted = await computeSnapshot(dir, { limits: { maxHashBytes: 10, maxFileBytes: 1024 } })
  assert.equal(budgeted.ok, true)
  assert.equal(budgeted.hashedBytes <= 10, true)
  assert.equal(budgeted.skippedCount >= 1, true)

  // Sync version produces identical manifests for every limit variant.
  for (const limits of [{ maxFiles: 3 }, { maxFileBytes: 4 }, { maxHashBytes: 10 }]) {
    const fromAsync = await computeSnapshot(dir, { limits })
    const fromSync = computeSnapshotSync(dir, { limits })
    assert.equal(fromSync.manifestHash, fromAsync.manifestHash, JSON.stringify(limits))
    assert.deepEqual(fromSync.files, fromAsync.files)
    assert.equal(fromSync.truncated, fromAsync.truncated)
    assert.equal(fromSync.skippedCount, fromAsync.skippedCount)
  }
})

test('computeSnapshotSync equals the async manifest for the same directory', async (t) => {
  const dir = await tempDir(t)
  await mkdir(path.join(dir, 'a', 'b'), { recursive: true })
  await writeFile(path.join(dir, 'a', 'one.txt'), 'one')
  await writeFile(path.join(dir, 'a', 'b', 'two.txt'), 'two-two-two')
  await writeFile(path.join(dir, 'root.md'), '# root')
  const fromAsync = await computeSnapshot(dir)
  const fromSync = computeSnapshotSync(dir)
  assert.equal(fromSync.ok, true)
  assert.equal(fromSync.manifestHash, fromAsync.manifestHash)
  assert.deepEqual(fromSync.files, fromAsync.files)
  assert.equal(fromSync.fileCount, fromAsync.fileCount)
  assert.equal(fromSync.hashedBytes, fromAsync.hashedBytes)
  // mkdtemp dirs are not git checkouts.
  assert.equal(fromAsync.targetDir, fromSync.targetDir)
})

test('findGitCommit reads loose refs, packed refs and detached HEAD without running git', async (t) => {
  const dir = await tempDir(t)
  const commit = 'a'.repeat(40)
  writeGitCheckout(dir, commit)
  assert.equal(findGitCommit(dir), commit)

  // Packed refs fallback when the ref file is missing.
  const packed = await tempDir(t)
  mkdirSync(path.join(packed, '.git'), { recursive: true })
  writeFileSync(path.join(packed, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(path.join(packed, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${'b'.repeat(40)} refs/heads/main\n`)
  assert.equal(findGitCommit(packed), 'b'.repeat(40))

  // Detached HEAD.
  const detached = await tempDir(t)
  mkdirSync(path.join(detached, '.git'), { recursive: true })
  writeFileSync(path.join(detached, '.git', 'HEAD'), `${'c'.repeat(40)}\n`)
  assert.equal(findGitCommit(detached), 'c'.repeat(40))

  // `.git` as a file pointing at a gitdir (worktree layout).
  const worktree = await tempDir(t)
  const worktreeGitDir = await tempDir(t)
  mkdirSync(path.join(worktreeGitDir, 'refs', 'heads'), { recursive: true })
  writeFileSync(path.join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/wt\n')
  writeFileSync(path.join(worktreeGitDir, 'refs', 'heads', 'wt'), `${'d'.repeat(40)}\n`)
  writeFileSync(path.join(worktree, '.git'), `gitdir: ${worktreeGitDir.replace(/\\/g, '/')}\n`)
  assert.equal(findGitCommit(worktree), 'd'.repeat(40))

  // Non-git, missing and bogus refs are null, never throws.
  assert.equal(findGitCommit(dir), commit)
  assert.equal(findGitCommit(path.join(dir, 'missing')), null)
  const bogus = await tempDir(t)
  mkdirSync(path.join(bogus, '.git'), { recursive: true })
  writeFileSync(path.join(bogus, '.git', 'HEAD'), 'ref: ..\\..\\escape\n')
  assert.equal(findGitCommit(bogus), null)
  assert.equal(findGitCommit(''), null)
})

test('computeSnapshot returns structured errors instead of throwing', async (t) => {
  const dir = await tempDir(t)
  const missing = await computeSnapshot(path.join(dir, 'nope'))
  assert.equal(missing.ok, false)
  assert.equal(typeof missing.error.message, 'string')
  assert.ok(missing.error.code)

  const file = path.join(dir, 'file.txt')
  await writeFile(file, 'x')
  const notDir = await computeSnapshot(file)
  assert.equal(notDir.ok, false)
  assert.equal(notDir.error.code, 'ENOTDIR')

  const syncMissing = computeSnapshotSync(path.join(dir, 'nope'))
  assert.equal(syncMissing.ok, false)
  assert.ok(syncMissing.error.message.includes('不可访问'))

  assert.equal((await computeSnapshot('')).ok, false)
  assert.equal(computeSnapshotSync(null).ok, false)
})
