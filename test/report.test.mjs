import assert from 'node:assert/strict'
import test from 'node:test'

import { escapeHtml, renderReportPages, REPORT_PAGE_COUNT } from '../lib/report.js'

const CYCLE = {
  id: 'c-abc-123',
  target: 'C:\\work\\demo-tarot-app',
  title: '演示塔罗应用',
  createdAt: 1700000000000,
  updatedAt: 1700000100000,
  status: 'reviewing',
  required: { score: 95, findings: 3, shots: 4 },
}

const ROUND = {
  n: 2,
  status: 'completed',
  startedAt: 1700000000000,
  finishedAt: 1700000090000,
  error: null,
  shots: [
    { file: 'r2-s1-desktop.png', width: 1440, height: 900, bytes: 2048, page: 'index.html' },
    { file: 'r2-s2-laptop.png', width: 1280, height: 800, bytes: 2048, page: 'index.html' },
    { file: 'r2-s3-tablet.png', width: 768, height: 1024, bytes: 2048, page: 'index.html' },
    { file: 'r2-s4-mobile.png', width: 390, height: 844, bytes: 2048, page: 'index.html' },
  ],
  attack: {
    verdict: 'HOLD',
    summary: '页面能打开，但核心交互存在可复现崩溃。',
    findings: [
      {
        id: 'F1',
        severity: 'BLOCKER',
        title: '抽牌按钮抛异常',
        evidence: 'app.js:42 drawCard is not defined',
        attack: '点击「抽牌」',
        impact: '核心功能不可用',
        fix: '定义 drawCard 并补错误处理',
        confidence: 'high',
        verified: true,
      },
      {
        id: 'F2',
        severity: 'MAJOR',
        title: '移动端布局溢出',
        evidence: 'style.css:88 width: 1200px',
        attack: '390x844 视口打开',
        impact: '横向滚动',
        fix: '改为响应式宽度',
        confidence: 'medium',
        verified: true,
      },
    ],
    solid: ['静态资源引用完整'],
    unverified: [{ item: '暗色主题对比度', needs: '暗色截图' }],
    nextSteps: '先修 F1。',
  },
  score: {
    score: 75,
    verdict: 'HOLD',
    findingsCount: 2,
    validFindings: [
      { title: '抽牌按钮抛异常', severity: 'BLOCKER', supported: true, note: '已复现' },
      { title: '移动端布局溢出', severity: 'MAJOR', supported: true, note: '截图可见' },
    ],
    deductions: [{ points: 10, reason: 'BLOCKER 未修复', fix: '修复 drawCard' }],
    mustFix: ['修复抽牌崩溃', '修复移动端溢出'],
    screenshots: { count: 4, quality: 'good', note: '四张齐全' },
    nextAction: 'fix_and_review',
    rationale: '存在 BLOCKER，因此不能给到 95 分。',
  },
  gate: {
    passed: false,
    score: 75,
    requiredScore: 95,
    findings: 2,
    requiredFindings: 3,
    shots: 4,
    requiredShots: 4,
    failReasons: ['评分 75 < 要求 95', 'mustFix 仍有 2 项未清空'],
  },
  timings: { shotsMs: 1200, attackMs: 34000, judgeMs: 21000, totalMs: 57000 },
}

test('escapeHtml escapes every HTML-significant character', () => {
  assert.equal(escapeHtml('<script>alert("x&y")</script>'), '&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;')
  assert.equal(escapeHtml("' onmouseover='x"), '&#39; onmouseover=&#39;x')
})

test('renderReportPages returns exactly four non-empty standalone HTML pages', () => {
  const pages = renderReportPages(CYCLE, ROUND)
  assert.equal(pages.length, REPORT_PAGE_COUNT)
  assert.equal(pages.length, 4)
  const names = new Set()
  for (const page of pages) {
    assert.equal(typeof page.name, 'string')
    assert.equal(typeof page.html, 'string')
    assert.ok(page.html.length > 2000, `page ${page.name} should be substantial`)
    assert.match(page.html, /^<!doctype html>/i)
    assert.match(page.html, /<\/html>\s*$/)
    assert.ok(page.html.includes('第 2 轮'))
    names.add(page.name)
  }
  assert.equal(names.size, 4)
  for (const name of names) assert.match(name, /\.html$/)
})

test('report pages include the escaped target/title and findings', () => {
  const pages = renderReportPages(CYCLE, ROUND)
  const all = pages.map((page) => page.html).join('\n')
  assert.ok(all.includes('演示塔罗应用'))
  assert.ok(all.includes('C:\\work\\demo-tarot-app'))
  assert.ok(all.includes('抽牌按钮抛异常'))
  assert.ok(all.includes('75.0'))
  assert.ok(all.includes('/ 100'))
  assert.ok(all.includes('95.0'))
  assert.ok(all.includes('supported（已核实）'))
})

test('v2.0: report pages are neutral placeholders until the round completes', () => {
  const running = { ...ROUND, status: 'running', score: null, gate: null }
  const placeholder = renderReportPages(CYCLE, running).map((page) => page.html).join('\n')
  assert.ok(placeholder.includes('评审前占位'))
  assert.equal(placeholder.includes('0 / 4'), false)
  assert.equal(placeholder.includes('本轮红队未报告任何发现'), false)

  const completed = { ...ROUND, status: 'completed' }
  const finalHtml = renderReportPages(CYCLE, completed).map((page) => page.html).join('\n')
  assert.equal(finalHtml.includes('评审前占位'), false)
  assert.ok(finalHtml.includes('75.0'))
  assert.ok(finalHtml.includes('supported'))
})

test('v2.0: report pages use the persisted supportedCount (intersection ∪ blocking)', () => {
  const round = JSON.parse(JSON.stringify(ROUND))
  round.status = 'completed'
  round.score.supportedCount = 1
  // raw validFindings may all be unsupported while blockingFindings holds the
  // single supported MAJOR; the page must trust the gate-affecting count.
  for (const finding of round.score.validFindings) finding.supported = false
  round.score.blockingFindings = [{ title: 'X', severity: 'MAJOR', supported: true }]
  const html = renderReportPages(CYCLE, round).map((page) => page.html).join('\n')
  assert.ok(html.includes('supported（交集/阻断）'))
  assert.ok(html.includes('>1<'))
})

test('report pages escape hostile target/title/finding text (XSS)', () => {
  const hostile = JSON.parse(JSON.stringify(ROUND))
  hostile.attack.findings[0].title = '<script>alert(1)</script>'
  hostile.attack.findings[0].evidence = '"><img src=x onerror=alert(2)>'
  hostile.attack.summary = '</main><script>steal()</script>'
  hostile.score.mustFix = ['/><script>alert(3)</script>']
  const pages = renderReportPages(
    { ...CYCLE, title: '<script>alert("title")</script>', target: '<img src=x onerror=alert(4)>' },
    hostile,
  )
  const all = pages.map((page) => page.html).join('\n')
  assert.equal(all.includes('<script>alert'), false)
  assert.equal(all.includes('onerror=alert(4)>'), false)
  assert.ok(all.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(all.includes('&lt;img src=x onerror=alert(4)&gt;'))
  assert.ok(all.includes('&quot;&gt;&lt;img src=x onerror=alert(2)&gt;'))
})

test('renderReportPages tolerates missing/partial round data', () => {
  for (const round of [undefined, null, {}, { n: 1 }, { attack: null, score: null, gate: null, shots: [] }]) {
    const pages = renderReportPages(CYCLE, round)
    assert.equal(pages.length, 4)
    for (const page of pages) {
      assert.ok(page.html.includes('第 1 轮'))
      assert.ok(page.html.length > 1000)
    }
  }
  const emptyCyclePages = renderReportPages(undefined, undefined)
  assert.equal(emptyCyclePages.length, 4)
  assert.ok(emptyCyclePages[0].html.includes('未命名评审对象'))
})

test('renderReportPages is deterministic for the same input', () => {
  const first = renderReportPages(CYCLE, ROUND)
  const second = renderReportPages(CYCLE, ROUND)
  assert.deepEqual(first.map((page) => page.name), second.map((page) => page.name))
  assert.deepEqual(first.map((page) => page.html), second.map((page) => page.html))
})
