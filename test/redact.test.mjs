import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_DEPTH,
  redactText,
  redactTextWithStats,
  redactValue,
  redactValueWithStats,
} from '../lib/redact.js'

test('redactText removes the documented credential shapes but keeps context', () => {
  const openai = '请求头里出现 sk-AbCdEf1234567890XYZ，注意这是致命问题'
  const redacted = redactText(openai)
  assert.equal(redacted.includes('sk-AbCdEf1234567890XYZ'), false)
  assert.ok(redacted.includes('[REDACTED:openai-key]'))
  assert.ok(redacted.includes('请求头里出现'))
  assert.ok(redacted.includes('注意这是致命问题'))

  const bearer = redactText('Authorization: Bearer abcdefghij.klmnop123')
  assert.equal(bearer.includes('abcdefghij.klmnop123'), false)
  assert.ok(bearer.includes('Bearer [REDACTED:bearer]'))

  const aws = redactText('配置项 AKIAABCDEFGHIJKLMNOP 泄漏')
  assert.equal(aws.includes('AKIAABCDEFGHIJKLMNOP'), false)
  assert.ok(aws.includes('[REDACTED:aws-access-key]'))

  const key = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEA1234567890',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n')
  const redactedKey = redactText(`夹在日志中的私钥：\n${key}\n后续证据`)
  assert.equal(redactedKey.includes('MIIEowIBAAKCAQEA1234567890'), false)
  assert.ok(redactedKey.includes('[REDACTED:private-key]'))
  assert.ok(redactedKey.includes('夹在日志中的私钥'))
  assert.ok(redactedKey.includes('后续证据'))

  const assignment = redactText('api_key = "abcdefgh12345" 以及 token: xyz98765432')
  assert.equal(assignment.includes('abcdefgh12345'), false)
  assert.equal(assignment.includes('xyz98765432'), false)
  assert.ok(assignment.includes('api_key'))
  assert.ok(assignment.includes('[REDACTED:assignment]'))
  assert.ok(assignment.includes('以及'))

  const password = redactText('DB_PASSWORD=SuperSecret99')
  assert.equal(password.includes('SuperSecret99'), false)
  assert.ok(password.includes('[REDACTED:assignment]'))
})

test('redactText leaves ordinary evidence and short values untouched', () => {
  const normal = [
    'app.js:42 的抽牌按钮没有绑定事件监听器，点击无响应。',
    '测试覆盖率 85%，缺少移动端视口验证。',
    'score = 92.5 < 要求 95',
    'token: 1234', // shorter than the 8-char minimum is not a credential
    'const apiKeyName = "not-a-secret-field"',
    'AKIA short is not an AWS key',
  ].join('\n')
  assert.equal(redactText(normal), normal)
  assert.equal(redactText(''), '')
  assert.equal(redactText(null), '')
  assert.deepEqual(redactTextWithStats('干净证据'), { text: '干净证据', count: 0 })
})

test('redactTextWithStats counts replacements', () => {
  const result = redactTextWithStats('sk-ABCDEFGHIJ1 与 sk-ZYXWVUTSRQ2 两个 key')
  assert.equal(result.count, 2)
  assert.equal(result.text.includes('sk-ABCDEFGHIJ1'), false)
  assert.equal(result.text.includes('sk-ZYXWVUTSRQ2'), false)
})

test('redactValue deep-copies and redacts nested evidence without mutating input', () => {
  const input = {
    verdict: 'HOLD',
    summary: '发现密钥 sk-ABCDEFGHIJKLMNOP 泄漏',
    findings: [{
      severity: 'BLOCKER',
      title: '前端硬编码 API key',
      evidence: 'config.js:3 api_key="an-example-secret-123"',
      attack: '读取源码',
      impact: '凭证泄漏',
      fix: '改为服务端注入',
      confidence: 'high',
      verified: true,
    }],
    score: 0,
    solid: ['Bearer abcdefghijklmnop 出现在测试里'],
    nested: { list: [{ token: 'token=abcdefghijk' }] },
  }
  const { value, count } = redactValueWithStats(input)
  assert.ok(count >= 3)
  const serialized = JSON.stringify(value)
  assert.equal(serialized.includes('sk-ABCDEFGHIJKLMNOP'), false)
  assert.equal(serialized.includes('an-example-secret-123'), false)
  assert.equal(serialized.includes('abcdefghijklmnop'), false)
  // Input object was not mutated.
  assert.ok(JSON.stringify(input).includes('sk-ABCDEFGHIJKLMNOP'))
  // Structure and non-string values survive.
  assert.equal(value.verdict, 'HOLD')
  assert.equal(value.score, 0)
  assert.equal(value.findings.length, 1)
  assert.equal(value.findings[0].severity, 'BLOCKER')
  assert.equal(value.findings[0].verified, true)
  assert.ok(value.findings[0].title.includes('硬编码'))
  assert.ok(value.summary.includes('发现密钥'))

  const plain = redactValue({ ok: true, n: 1, list: ['a', 2, null] })
  assert.deepEqual(plain, { ok: true, n: 1, list: ['a', 2, null] })
})

test('redactValue bounds depth/entries and keeps unsupported values safe', () => {
  let deep = { leaf: 'x' }
  for (let index = 0; index < MAX_DEPTH + 5; index += 1) deep = { child: deep }
  const redacted = redactValue(deep)
  assert.equal(JSON.stringify(redacted).includes('[REDACTED:depth]'), true)

  const big = { list: Array.from({ length: 10 }, (_unused, index) => index) }
  assert.equal(redactValue(big).list.length, 10)
  assert.equal(redactValue({ fn: () => 1 }).fn, null)
  assert.equal(redactValue(undefined), undefined)
})
