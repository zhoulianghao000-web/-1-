/**
 * v1.1 1.5 static preset checks: both reviewer presets are hard read-only.
 *
 * Reviews run in the bundle's two Agent presets; the only enforceable guarantee
 * that a reviewer cannot run shell/network tools is that those plugins are not
 * mounted at all. Filesystem access must stay read-only (write/edit disabled).
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PATCH_FILE = path.resolve(HERE, '..', 'cordis.patch.yml')

async function readPatchText() {
  return readFile(PATCH_FILE, 'utf8')
}

/**
 * Split the patch into top-level rows (plugin row + preset rows). Preset rows are
 * indented four spaces; nested plugin rows are indented ten, so a lookahead on
 * exactly four spaces finds only top-level entries.
 */
function splitTopLevelRows(text) {
  const rows = text.split(/\r?\n(?= {4}- id: )/)
  return rows.map((row) => row.replace(/\r\n/g, '\n'))
}

function findRow(text, id) {
  const row = splitTopLevelRows(text).find((entry) => entry.startsWith(`    - id: ${id}\n`) || entry.trimEnd().endsWith(`- id: ${id}`) || entry.includes(`    - id: ${id}\n`))
  assert.ok(row !== undefined, `cordis.patch.yml 缺少顶层行 ${id}`)
  return row
}

test('cordis.patch.yml: both reviewer presets have no shell/network tools', async () => {
  const text = await readPatchText()
  for (const presetId of ['preset-redteam-review', 'preset-review-judge']) {
    const block = findRow(text, presetId)
    for (const forbidden of ['tool-bash', 'tool-pwsh', 'tool-web', 'dsh-tool-bash', 'dsh-tool-pwsh', 'dsh-tool-web']) {
      assert.equal(block.includes(forbidden), false, `${presetId} 不得包含 ${forbidden}`)
    }
    // Sanity: the file itself must not mount those plugins at all any more.
    assert.equal(text.includes('@deepseek-ai/dsh-tool-pwsh'), false)
    assert.equal(text.includes('@deepseek-ai/dsh-tool-bash'), false)
    assert.equal(text.includes('@deepseek-ai/dsh-tool-web'), false)
  }
})

test('cordis.patch.yml: both reviewer presets keep filesystem read-only and the safe tool set', async () => {
  const text = await readPatchText()
  for (const presetId of ['preset-redteam-review', 'preset-review-judge']) {
    const block = findRow(text, presetId)
    // Filesystem plugin is still mounted, but read-only.
    assert.match(block, /id: tool-fs\n\s+name: '@deepseek-ai\/dsh-tool-fs'/)
    const fsIndex = block.indexOf('name: \'@deepseek-ai/dsh-tool-fs\'')
    assert.ok(fsIndex >= 0)
    const fsSlice = block.slice(fsIndex, fsIndex + 400)
    assert.match(fsSlice, /read: true/)
    assert.match(fsSlice, /readImage: true/)
    assert.match(fsSlice, /write: false/)
    assert.match(fsSlice, /edit: false/)
    // The rest of the reviewer surface stays available.
    for (const required of ['agent-instructions', 'time-context', 'tool-fs-search', 'skill-filesystem', 'tool-skill', 'compaction']) {
      assert.equal(block.includes(`id: ${required}`), true, `${presetId} 应保留 ${required}`)
    }
    // Read-only checks are done through the Host probe.
    assert.equal(block.includes('review_probe'), true, `${presetId} 应说明 review_probe`)
  }
})

test('cordis.patch.yml: host plugin row enables the v1.1 1.5 read-only/probe config', async () => {
  const text = await readPatchText()
  const block = findRow(text, 'adversarial-review-console')
  assert.match(block, /readOnlyReviewers: true/)
  assert.match(block, /probeTimeoutSeconds: 120/)
  assert.match(block, /probeMaxCopyBytes: 104857600/)
  assert.match(block, /probeMaxCopyFiles: 20000/)
})
