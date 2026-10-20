/**
 * Pure HTML renderer for the four report-page evidence screenshots used when a
 * target has no Web UI to render (CONTRACT.md §2.2 / §2.5).
 *
 * The four returned pages are the round's evidence: overview, findings, judge
 * score, and evidence recap. Everything derived from model/target text is
 * escaped before interpolation, no external resource is referenced, and the
 * output is deterministic for the same cycle/round input.
 */

import path from 'node:path'

/** Every call returns exactly this many pages (the screenshot invariant). */
export const REPORT_PAGE_COUNT = 4

const MAX_FIELD_CHARS = 2000
const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: "Segoe UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif; color: #1b1b1f; background: #f6f5f4; font-size: 15px; line-height: 1.65; }
header.rtc-report-header { background: #201d1d; color: #f6f5f4; padding: 40px 56px 32px; }
.rtc-report-brand { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; opacity: .72; margin-bottom: 10px; }
header h1 { margin: 0 0 8px; font-size: 32px; line-height: 1.25; }
header .rtc-sub { margin: 0; opacity: .78; font-size: 15px; }
main { padding: 36px 56px 24px; }
footer { padding: 20px 56px 40px; color: #6b6867; font-size: 12px; }
h2 { font-size: 19px; margin: 30px 0 12px; padding-bottom: 6px; border-bottom: 2px solid #ded9d6; }
h2:first-child { margin-top: 0; }
p { margin: 8px 0; }
.muted { color: #6b6867; }
.mono { font-family: "Cascadia Mono", Consolas, "Courier New", monospace; font-size: 13px; word-break: break-all; }
.grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.metric { background: #ffffff; border: 1px solid #ded9d6; border-radius: 12px; padding: 14px 16px; }
.metric .rtc-label { font-size: 12px; color: #6b6867; }
.metric .rtc-value { font-size: 26px; font-weight: 700; margin-top: 2px; }
.score-big { font-size: 68px; font-weight: 800; line-height: 1; letter-spacing: -.02em; }
.badge { display: inline-block; border-radius: 999px; padding: 4px 14px; font-weight: 700; font-size: 14px; }
.badge-pass { background: #d9f2df; color: #12602a; }
.badge-hold { background: #fdeccf; color: #7a4a00; }
.badge-block { background: #fbdad7; color: #7f1d1a; }
.card { background: #ffffff; border: 1px solid #ded9d6; border-left: 5px solid #b3261e; border-radius: 12px; padding: 16px 20px; margin: 14px 0; }
.card.sev-MAJOR { border-left-color: #c47f00; }
.card.sev-MINOR { border-left-color: #5b7a99; }
.card h3 { margin: 0 0 6px; font-size: 17px; }
.card .rtc-meta { font-size: 12px; color: #6b6867; margin-bottom: 8px; }
.card dt { font-weight: 600; margin-top: 8px; }
.card dd { margin: 2px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
table { width: 100%; border-collapse: collapse; background: #ffffff; border: 1px solid #ded9d6; border-radius: 12px; overflow: hidden; }
th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid #ece8e6; vertical-align: top; }
th { background: #efebe9; font-size: 13px; }
ul.rtc-list { margin: 6px 0; padding-left: 22px; }
ul.rtc-list li { margin: 4px 0; }
.finding-list { margin: 0; padding: 0; list-style: none; }
.rtc-evidence-note { background: #fff8e6; border: 1px solid #e8d49a; border-radius: 12px; padding: 14px 18px; }
.shot-row { font-family: "Cascadia Mono", Consolas, monospace; font-size: 13px; padding: 7px 0; border-bottom: 1px dashed #ded9d6; }
`

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function text(value, max = MAX_FIELD_CHARS) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, Math.max(0, max - 1)) + '…'
}

function list(value, maxItems = 30) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (out.length >= maxItems) break
    const entry = text(item, 500)
    if (entry !== '') out.push(entry)
  }
  return out
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatScore(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '—'
}

function formatTime(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—'
  try {
    return new Date(value).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')
  } catch {
    return '—'
  }
}

function verdictBadge(verdict) {
  const normalized = typeof verdict === 'string' ? verdict.toUpperCase() : 'HOLD'
  const css = normalized === 'PASS' ? 'badge-pass' : normalized === 'BLOCK' ? 'badge-block' : 'badge-hold'
  return `<span class="badge ${css}">${escapeHtml(normalized)}</span>`
}

function pageShell(title, subtitle, bodyHtml, footerText) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="rtc-report-header">
  <div class="rtc-report-brand">红队评审台 · Red-Team Review Console</div>
  <h1>${escapeHtml(title)}</h1>
  <p class="rtc-sub">${escapeHtml(subtitle)}</p>
</header>
<main>
${bodyHtml}
</main>
<footer>${escapeHtml(footerText)}</footer>
</body>
</html>`
}

function listItems(items, emptyText) {
  if (items.length === 0) return `<p class="muted">${escapeHtml(emptyText)}</p>`
  return `<ul class="rtc-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
}

function renderOverview(cycle, round, data) {
  const gate = data.gate
  const failReasons = list(gate.failReasons, 10)
  const placeholder = `
<div class="rtc-evidence-note">
<p><strong>评审前占位页</strong>：本轮红队与判官尚未开始/尚未完成。评审结束后 Host 会用完整结果重新渲染这 4 张报告页，最终评分、发现与门控数字以重新渲染后的页面为准。</p>
<p>本页只用于证明「本轮已生成固定 4 张证据卡」；请结合项目源码与红队/判官报告评审，不要根据占位数字判断质量。</p>
</div>`
  const gateLine = data.inProgress
    ? '<p class="muted">评审进行中（本页为占位，不含最终门控结论）。</p>'
    : gate.passed === true
      ? `<p>${verdictBadge('PASS')} 已达标（gate.passed = true）</p>`
      : `<p>${verdictBadge('HOLD')} 未达标（gate.passed = false）</p>${failReasons.length ? `<ul class="rtc-list">${failReasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>` : ''}`
  const metrics = data.inProgress
    ? [['评分 Score', '评审结束后写入'], ['有效发现 Supported', '评审结束后写入'], ['截图 Shots', '评审结束后写入']]
    : [
      ['评分 Score', `${formatScore(data.scoreValue)} / 100`],
      ['要求 Required', formatScore(data.requiredScore)],
      ['有效发现 Supported', `${data.supportedCount}`],
      ['截图 Shots', `${data.shotCount} / ${data.requiredShots}`],
    ]
  const body = `
<h2>本轮概览 · Round ${escapeHtml(round.n ?? 1)}</h2>
${data.inProgress ? placeholder : ''}
<div class="grid">${metrics.map(([label, value]) => `<div class="metric"><div class="rtc-label">${escapeHtml(label)}</div><div class="rtc-value">${escapeHtml(value)}</div></div>`).join('')}</div>
<h2>门控结论 · Gate</h2>
${gateLine}
<h2>审查对象 · Target</h2>
<p class="mono">${escapeHtml(data.target)}</p>
<p class="muted">项目标题：${escapeHtml(data.title)} · Cycle：<span class="mono">${escapeHtml(data.cycleId)}</span> · 状态：${escapeHtml(data.cycleStatus)} · 轮次状态：${escapeHtml(data.roundStatus)}</p>
<p class="muted">开始时间：${escapeHtml(formatTime(round.startedAt))} · 结束时间：${escapeHtml(formatTime(round.finishedAt))}</p>
<h2>红队摘要 · Attack summary</h2>
<p>${escapeHtml(data.attackSummary || (data.inProgress ? '（红队尚未开始）' : '（红队未提供摘要）'))}</p>
${round.error ? `<h2>本轮错误 · Error</h2><p class="mono">${escapeHtml(text(round.error, 1200))}</p>` : ''}
`
  return pageShell(
    `${data.title} · 第 ${round.n ?? 1} 轮评审报告`,
    '无 Web UI 目标的本轮证据：4 张评审报告页截图之一（概览）',
    body,
    `报告页 1/4 · ${data.cycleId} · round ${round.n ?? 1}`,
  )
}

function renderFindings(cycle, round, data) {
  const findings = Array.isArray(data.attack.findings) ? data.attack.findings.slice(0, 24) : []
  const cards = findings.map((finding, index) => {
    const severity = typeof finding.severity === 'string' ? finding.severity : 'MINOR'
    const judgeState = data.judgeByTitle.get(text(finding.title, 200))
    const judgeLine = judgeState === undefined
      ? ''
      : `<div class="rtc-meta">判官核实：${judgeState ? 'supported（已核实）' : 'unsupported（证据不足）'}</div>`
    return `<article class="card sev-${escapeHtml(severity)}">
<h3>F${index + 1} [${escapeHtml(severity)}] ${escapeHtml(text(finding.title, 300) || '（无标题）')}</h3>
<div class="rtc-meta">置信度：${escapeHtml(text(finding.confidence, 20) || 'low')} · 红队自评已核实：${finding.verified === true ? '是' : '否'}</div>
${judgeLine}
<dl>
<dt>证据 Evidence</dt><dd class="mono">${escapeHtml(text(finding.evidence) || '（未提供）')}</dd>
<dt>攻击方式 Attack</dt><dd>${escapeHtml(text(finding.attack) || '（未提供）')}</dd>
<dt>影响 Impact</dt><dd>${escapeHtml(text(finding.impact) || '（未提供）')}</dd>
<dt>修复方向 Fix</dt><dd>${escapeHtml(text(finding.fix) || '（未提供）')}</dd>
</dl>
</article>`
  }).join('')
  const body = data.inProgress
    ? `
<div class="rtc-evidence-note">
<p><strong>评审前占位页</strong>：红队尚未开始，因此本页暂无可展示的发现清单。</p>
<p>评审结束后 Host 会用完整结果重新渲染，最终发现清单以重新渲染后的页面为准。</p>
</div>`
    : `
<h2>发现清单 · Findings（${data.attack.findings?.length ?? 0} 条）</h2>
${cards || '<p class="muted">本轮红队未报告任何发现。</p>'}
${(data.attack.findings?.length ?? 0) > 24 ? '<p class="muted">仅展示前 24 条发现；完整内容见评审台 UI。</p>' : ''}
<h2>已验证稳固项 · Solid</h2>
${listItems(list(data.attack.solid, 20), '（无）')}
<h2>未验证项及所需证据 · Unverified</h2>
${data.attack.unverified?.length
    ? `<table><thead><tr><th>未验证项</th><th>需要的证据</th></tr></thead><tbody>${data.attack.unverified.slice(0, 20).map((entry) => `<tr><td>${escapeHtml(text(entry?.item, 500))}</td><td>${escapeHtml(text(entry?.needs, 1000))}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">（无）</p>'}
`
  return pageShell(
    `${data.title} · 发现清单`,
    `第 ${round.n ?? 1} 轮红队发现（按严重程度原样呈现）`,
    body,
    `报告页 2/4 · ${data.cycleId} · round ${round.n ?? 1}`,
  )
}

function renderScore(cycle, round, data) {
  const deductions = Array.isArray(data.score.deductions) ? data.score.deductions.slice(0, 20) : []
  const mustFix = list(data.score.mustFix, 20)
  const deductionRows = deductions.length
    ? deductions.map((entry) => `<tr><td>−${escapeHtml(formatScore(Number(entry?.points)))}</td><td>${escapeHtml(text(entry?.reason, 1000))}</td><td>${escapeHtml(text(entry?.fix, 1000))}</td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">无扣分项</td></tr>'
  const shotInfo = isObject(data.score.screenshots) ? data.score.screenshots : {}
  const body = data.inProgress
    ? `
<div class="rtc-evidence-note">
<p><strong>评审前占位页</strong>：判官尚未评分，因此本页不展示分数、扣分或 mustFix。</p>
<p>评审结束后 Host 会用完整结果重新渲染，最终评分以重新渲染后的页面为准。</p>
</div>`
    : `
<h2>判官评分 · Judge score</h2>
<div class="grid">
  <div class="metric" style="grid-column: span 2;"><div class="rtc-label">总分 Score</div><div class="score-big">${escapeHtml(formatScore(data.scoreValue))}<span class="muted" style="font-size: 20px;"> / 100</span></div></div>
  <div class="metric"><div class="rtc-label">结论 Verdict</div><div class="rtc-value">${verdictBadge(data.verdict)}</div></div>
  <div class="metric"><div class="rtc-label">有效发现 Findings</div><div class="rtc-value">${escapeHtml(String(data.supportedCount))} / ${escapeHtml(String(data.requiredFindings))}</div></div>
</div>
<h2>评分理由 · Rationale</h2>
<p style="white-space: pre-wrap; overflow-wrap: anywhere;">${escapeHtml(text(data.score.rationale) || '（判官未提供评分理由）')}</p>
<h2>扣分表 · Deductions</h2>
<table><thead><tr><th>扣分</th><th>原因</th><th>如何改回</th></tr></thead><tbody>${deductionRows}</tbody></table>
<h2>必须修复 · mustFix</h2>
${listItems(mustFix, '（mustFix 为空）')}
<h2>截图证据评估 · Screenshots</h2>
<p>判官评估：截图 ${escapeHtml(String(shotInfo.count ?? 0))} 张，质量 ${escapeHtml(text(shotInfo.quality, 20) || 'unknown')}。${escapeHtml(text(shotInfo.note))}</p>
<p class="muted">Host 实际渲染并在门控中使用的截图数：${escapeHtml(String(data.shotCount))} / ${escapeHtml(String(data.requiredShots))}。</p>
`
  return pageShell(
    `${data.title} · 判官评分`,
    `第 ${round.n ?? 1} 轮独立评分（判官只看到红队报告与证据，本报告页由 Host 生成）`,
    body,
    `报告页 3/4 · ${data.cycleId} · round ${round.n ?? 1}`,
  )
}

function renderEvidence(cycle, round, data) {
  const shots = Array.isArray(round.shots) ? round.shots : []
  const shotRows = shots.length
    ? shots.map((shot, index) => `<div class="shot-row">${index + 1}. ${escapeHtml(text(shot?.file, 200))} · ${escapeHtml(String(shot?.width ?? 0))}×${escapeHtml(String(shot?.height ?? 0))} · ${escapeHtml(text(shot?.page, 300))}</div>`).join('')
    : '<p class="muted">（本页为评审前占位，最终截图清单在评审结束后写入）</p>'
  const body = data.inProgress
    ? `
<div class="rtc-evidence-note">
<p><strong>评审前占位页</strong>：目标没有可渲染的 Web 入口，Host 以 4 张评审报告页作为本轮固定证据卡。</p>
<p>本页只是占位；评审结束后 Host 会用完整结果重新渲染这 4 页，最终证据清单与门控数字以重新渲染后的页面为准。</p>
</div>
<h2>本轮截图清单 · Shots</h2>
${shotRows}
`
    : `
<div class="rtc-evidence-note">
<p><strong>目标没有可渲染的 Web 入口</strong>（未找到 index.html / public/index.html / dist/index.html / src/index.html），Host 以 4 张评审报告页作为本轮固定证据截图。</p>
<p>本组截图共 ${escapeHtml(String(data.shotCount))} 张，门控要求恰好 ${escapeHtml(String(data.requiredShots))} 张。完整内容见左侧「红队评审台」面板。</p>
</div>
<h2>本轮截图清单 · Shots</h2>
${shotRows}
<h2>门控数字 · Gate numbers</h2>
<table><thead><tr><th>指标</th><th>当前</th><th>要求</th></tr></thead><tbody>
<tr><td>总分</td><td>${escapeHtml(formatScore(data.scoreValue))}</td><td>≥ ${escapeHtml(formatScore(data.requiredScore))}</td></tr>
<tr><td>有效发现（去重）</td><td>${escapeHtml(String(data.gate.findings ?? 0))}</td><td>≥ ${escapeHtml(String(data.requiredFindings))}</td></tr>
<tr><td>supported（交集/阻断）</td><td>${escapeHtml(String(data.supportedCount))}</td><td>≥ ${escapeHtml(String(data.requiredFindings))}</td></tr>
<tr><td>截图</td><td>${escapeHtml(String(data.shotCount))}</td><td>= ${escapeHtml(String(data.requiredShots))}</td></tr>
</tbody></table>
`
  return pageShell(
    `${data.title} · 证据截图`,
    `第 ${round.n ?? 1} 轮固定证据（4 张报告页）`,
    body,
    `报告页 4/4 · ${data.cycleId} · round ${round.n ?? 1}`,
  )
}

/**
 * Render the four report pages.
 *
 * @param {object} cycle stored cycle record (may be partial)
 * @param {object} round stored round record (may be partial)
 * @returns {{name: string, html: string}[]} exactly `REPORT_PAGE_COUNT` pages
 */
export function renderReportPages(cycle, round) {
  const safeCycle = isObject(cycle) ? cycle : {}
  const safeRound = isObject(round) ? round : {}
  const attack = isObject(safeRound.attack) ? safeRound.attack : {}
  const score = isObject(safeRound.score) ? safeRound.score : {}
  const gate = isObject(safeRound.gate) ? safeRound.gate : {}
  const required = isObject(safeCycle.required) ? safeCycle.required : {}

  const target = text(safeCycle.target, 500)
  const title = text(safeCycle.title, 300) || (target !== '' ? path.basename(target) : '未命名评审对象')
  const validFindings = Array.isArray(score.validFindings) ? score.validFindings : []
  const judgeByTitle = new Map()
  for (const entry of validFindings) {
    if (isObject(entry) && typeof entry.title === 'string') {
      judgeByTitle.set(text(entry.title, 200), entry.supported === true)
    }
  }
  const shotCount = Array.isArray(safeRound.shots) ? safeRound.shots.length : 0
  const data = {
    cycleId: text(safeCycle.id, 100) || 'c-unknown',
    title,
    target: target || '（未知 target）',
    cycleStatus: text(safeCycle.status, 20) || 'reviewing',
    roundStatus: text(safeRound.status, 20) || 'running',
    attack,
    attackSummary: text(attack.summary),
    score,
    scoreValue: typeof score.score === 'number' && Number.isFinite(score.score) ? score.score : null,
    verdict: typeof score.verdict === 'string' ? score.verdict : (typeof attack.verdict === 'string' ? attack.verdict : 'HOLD'),
    gate,
    requiredScore: typeof required.score === 'number' ? required.score : 95,
    requiredFindings: typeof required.findings === 'number' ? required.findings : 3,
    requiredShots: typeof required.shots === 'number' ? required.shots : 4,
    // v2.0: use the persisted gate-affecting count (intersection ∪ blocking
    // union), not a raw validFindings count that omits blockingFindings-only
    // supported MAJORs.
    supportedCount: Number.isInteger(score.supportedCount) && score.supportedCount >= 0
      ? score.supportedCount
      : validFindings.filter((entry) => isObject(entry) && entry.supported === true).length,
    shotCount,
    judgeByTitle,
    // v2.0 fix: pages rendered before the round completes are placeholders and
    // must NOT present empty scores/findings as review evidence.
    inProgress: safeRound.status !== 'completed' || typeof score.score !== 'number' || !Number.isFinite(score.score),
  }

  const roundNo = Number.isInteger(safeRound.n) && safeRound.n > 0 ? safeRound.n : 1
  const pages = [
    { slug: 'overview', html: renderOverview(safeCycle, safeRound, data) },
    { slug: 'findings', html: renderFindings(safeCycle, safeRound, data) },
    { slug: 'score', html: renderScore(safeCycle, safeRound, data) },
    { slug: 'evidence', html: renderEvidence(safeCycle, safeRound, data) },
  ]
  return pages.map((page, index) => ({
    name: `r${roundNo}-report-${index + 1}-${page.slug}.html`,
    html: page.html,
  }))
}

export { escapeHtml }
