/**
 * v1.3 3.3 — read-only diff and report export projections.
 *
 * Pure helpers used by the `/diff` and `/export` HTTP endpoints (lib/routes.js):
 * - `buildDiff(cycle)`: per-round findings diff (new/repeat/fixed/severity-changed)
 *   computed from the Host's persisted (and Host-deduped) attacker reports;
 * - `buildExportPayload(publicCycle)`: JSON export with bounded evidence/noise/
 *   cost summaries and NO absolute Host paths / full logs;
 * - `buildExportMarkdown(payload)`: human-readable Markdown report;
 * - `exportFilename(cycleId, format, now)`: safe attachment filename.
 */

import { LIMITS } from './constants.js'
import { dedupeFindings, findingKey } from './noise.js'

const SEVERITY_RANK = Object.freeze({ BLOCKER: 3, MAJOR: 2, MINOR: 1 })

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringOr(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function truncateText(value, maxChars) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  if (maxChars <= 0 || text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

function severityRank(severity) {
  return SEVERITY_RANK[typeof severity === 'string' ? severity.toUpperCase() : ''] || 0
}

function findingKeyOf(finding) {
  return finding !== null && typeof finding === 'object' ? findingKey(finding) : ''
}

/**
 * Build the cross-round finding diff for one cycle.
 * @param {object} cycle normalized cycle (internal store shape)
 * @param {{now?: Function}} [options]
 * @returns {{ok: true, cycleId: string, rounds: object[], changes: object[], truncated: boolean}}
 */
export function buildDiff(cycle, options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const rounds = Array.isArray(cycle?.rounds) ? cycle.rounds.filter(isPlainObject) : []
  const roundsSummary = rounds.map((round) => ({
    n: round.n,
    score: isPlainObject(round.score) && Number.isFinite(round.score.score) ? round.score.score : null,
    passed: isPlainObject(round.gate) ? round.gate.passed === true : null,
  }))
  const history = new Map()
  let roundsWithFindings = 0
  for (const round of rounds) {
    const attackFindings = isPlainObject(round.attack) && Array.isArray(round.attack.findings)
      ? round.attack.findings
      : []
    if (attackFindings.length === 0) continue
    roundsWithFindings += 1
    const { kept } = dedupeFindings(attackFindings)
    for (const finding of kept) {
      const key = findingKeyOf(finding)
      if (key === '') continue
      let entry = history.get(key)
      if (entry === undefined) {
        entry = {
          key,
          title: truncateText(stringOr(finding.title), 300) || '(untitled)',
          severity: stringOr(finding.severity, 'MINOR').toUpperCase(),
          firstRound: round.n,
          lastRound: round.n,
          previousSeverity: null,
        }
        history.set(key, entry)
      } else {
        // Always keep the LATEST appearance's severity/title (so a downgrade is
        // visible as severity-changed); remember the previous one for status.
        entry.previousSeverity = entry.severity
        entry.lastRound = round.n
        entry.severity = stringOr(finding.severity, 'MINOR').toUpperCase()
        entry.title = truncateText(stringOr(finding.title), 300) || entry.title
      }
    }
  }
  const latestRoundWithFindings = roundsWithFindings === 0
    ? null
    : [...history.values()].reduce((max, entry) => Math.max(max, entry.lastRound), 0)
  const changes = []
  let truncated = false
  for (const entry of history.values()) {
    if (changes.length >= LIMITS.maxDiffChanges) {
      truncated = true
      break
    }
    let status = 'repeat'
    // Statuses are relative to the latest round that actually reported findings;
    // a trailing failed round (no report) must not label everything "fixed".
    if (latestRoundWithFindings === null) status = 'fixed'
    else if (entry.lastRound < latestRoundWithFindings) status = 'fixed'
    else if (entry.firstRound === entry.lastRound) status = 'new'
    else if (entry.previousSeverity !== null && entry.previousSeverity !== entry.severity) status = 'severity-changed'
    changes.push({
      key: entry.key,
      title: entry.title,
      severity: entry.severity,
      status,
      firstRound: entry.firstRound,
      lastRound: entry.lastRound,
    })
  }
  changes.sort((left, right) => (
    (left.firstRound - right.firstRound)
    || (severityRank(right.severity) - severityRank(left.severity))
    || left.title.localeCompare(right.title)
  ))
  return {
    ok: true,
    cycleId: typeof cycle?.id === 'string' ? cycle.id : '',
    generatedAt: now(),
    rounds: roundsSummary,
    changes,
    truncated,
  }
}

function roundFindings(round) {
  if (!isPlainObject(round.attack) || !Array.isArray(round.attack.findings)) return []
  return round.attack.findings
    .filter(isPlainObject)
    .slice(0, LIMITS.maxFindings)
    .map((finding) => ({
      severity: stringOr(finding.severity, 'MINOR').toUpperCase(),
      title: truncateText(stringOr(finding.title), 300),
      evidence: truncateText(stringOr(finding.evidence), 1200),
      attack: truncateText(stringOr(finding.attack), 1200),
      impact: truncateText(stringOr(finding.impact), 1200),
      fix: truncateText(stringOr(finding.fix), 1200),
      confidence: stringOr(finding.confidence, 'medium'),
      verified: finding.verified === true,
    }))
}

function roundEvidence(round) {
  const cards = Array.isArray(round?.evidence) ? round.evidence : []
  return cards.slice(0, LIMITS.maxEvidenceCards).map((card) => ({
    index: numberOr(card.index, 0),
    name: truncateText(stringOr(card.name), 64),
    kind: stringOr(card.kind, 'screenshot'),
    artifactCount: Array.isArray(card.artifacts) ? card.artifacts.length : 0,
    artifacts: (Array.isArray(card.artifacts) ? card.artifacts : []).slice(0, LIMITS.maxEvidenceArtifacts).map((artifact) => ({
      file: stringOr(artifact.file),
      width: numberOr(artifact.width, 0),
      height: numberOr(artifact.height, 0),
      bytes: numberOr(artifact.bytes, 0),
      mime: stringOr(artifact.mime, 'image/png'),
    })),
  }))
}

function roundSummary(round) {
  const score = isPlainObject(round.score) ? round.score : {}
  const gate = isPlainObject(round.gate) ? round.gate : {}
  return {
    n: round.n,
    status: round.status,
    mode: stringOr(round.mode, 'fresh'),
    score: Number.isFinite(score.score) ? score.score : null,
    rawScore: Number.isFinite(score.rawScore) ? score.rawScore : null,
    verdict: stringOr(score.verdict, ''),
    supportedCount: Number.isInteger(score.supportedCount) ? score.supportedCount : null,
    findingsCount: Number.isInteger(score.findingsCount) ? score.findingsCount : null,
    mustFix: Array.isArray(score.mustFix) ? score.mustFix.slice(0, LIMITS.maxMustFix).map((item) => truncateText(stringOr(item), 500)) : [],
    deductions: Array.isArray(score.deductions)
      ? score.deductions.slice(0, LIMITS.maxDeductions).map((entry) => ({
        points: numberOr(entry?.points, 0),
        reason: truncateText(stringOr(entry?.reason), 1000),
        fix: truncateText(stringOr(entry?.fix), 1000),
      }))
      : [],
    gate: {
      passed: gate.passed === true,
      score: numberOr(gate.score, null),
      requiredScore: numberOr(gate.requiredScore, null),
      findings: numberOr(gate.findings, null),
      requiredFindings: numberOr(gate.requiredFindings, null),
      shots: numberOr(gate.shots, null),
      requiredShots: numberOr(gate.requiredShots, null),
      failReasons: Array.isArray(gate.failReasons) ? gate.failReasons.slice(0, 20).map((reason) => truncateText(stringOr(reason), 500)) : [],
    },
    findings: roundFindings(round),
    solid: isPlainObject(round.attack) && Array.isArray(round.attack.solid)
      ? round.attack.solid.slice(0, 20).map((item) => truncateText(stringOr(item), 500))
      : [],
    unverified: isPlainObject(round.attack) && Array.isArray(round.attack.unverified)
      ? round.attack.unverified.slice(0, 20).map((item) => ({
        item: truncateText(stringOr(item?.item), 500),
        needs: truncateText(stringOr(item?.needs), 500),
      }))
      : [],
    cost: isPlainObject(round.cost) ? { ...round.cost } : null,
    noise: isPlainObject(round.noise)
      ? {
        rawFindings: numberOr(round.noise.rawFindings, 0),
        dedupedFindings: numberOr(round.noise.dedupedFindings, 0),
        knownRepeats: numberOr(round.noise.knownRepeats, 0),
        suppressed: (Array.isArray(round.noise.suppressed) ? round.noise.suppressed : []).slice(0, LIMITS.maxNoiseSuppressed).map((entry) => ({
          title: truncateText(stringOr(entry?.title), 200),
          reason: truncateText(stringOr(entry?.reason), 200),
        })),
      }
      : null,
    incremental: isPlainObject(round.incremental)
      ? {
        mode: stringOr(round.incremental.mode, 'incremental'),
        changedFiles: (Array.isArray(round.incremental.changedFiles) ? round.incremental.changedFiles : []).slice(0, 200),
        addedFiles: (Array.isArray(round.incremental.addedFiles) ? round.incremental.addedFiles : []).slice(0, 200),
        removedFiles: (Array.isArray(round.incremental.removedFiles) ? round.incremental.removedFiles : []).slice(0, 200),
        truncated: round.incremental.truncated === true,
        fullReview: round.incremental.fullReview === true,
      }
      : null,
    evidence: roundEvidence(round),
  }
}

/**
 * JSON export payload. `publicCycle` comes from `store.toPublicCycle` (target is
 * an absolute path, so only its basename is exported).
 * @param {object} publicCycle
 * @param {{now?: Function}} [options]
 */
export function buildExportPayload(publicCycle, options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const rounds = Array.isArray(publicCycle?.rounds) ? publicCycle.rounds : []
  return {
    ok: true,
    generatedAt: now(),
    format: 'json',
    cycle: {
      id: stringOr(publicCycle?.id),
      title: truncateText(stringOr(publicCycle?.title), 300),
      targetName: truncateText(stringOr(publicCycle?.target).split(/[\\/]/).filter(Boolean).pop() || '', 200),
      status: stringOr(publicCycle?.status, ''),
      required: isPlainObject(publicCycle?.required) ? { ...publicCycle.required } : null,
      reopenCount: numberOr(publicCycle?.reopenCount, 0),
      reopenedFrom: stringOr(publicCycle?.reopenedFrom, '') || null,
      rounds: rounds.map(roundSummary),
    },
  }
}

function markdownEscape(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
}

function formatScore(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—'
}

/** Render the JSON export payload as a human-readable Markdown report. */
export function buildExportMarkdown(payload) {
  const cycle = isPlainObject(payload?.cycle) ? payload.cycle : {}
  const lines = []
  lines.push(`# 红队评审报告 / Red-Team Review Report`)
  lines.push('')
  lines.push(`- 评审对象：${markdownEscape(cycle.title || cycle.targetName || '(untitled)')}`)
  lines.push(`- Cycle：${markdownEscape(cycle.id)}（状态 ${markdownEscape(cycle.status)}）`)
  if (cycle.reopenCount > 0) lines.push(`- 复评：第 ${cycle.reopenCount} 次 reopen（来自 ${markdownEscape(cycle.reopenedFrom || '—')}）`)
  lines.push(`- 导出时间：${new Date(numberOr(payload?.generatedAt, Date.now())).toISOString()}`)
  lines.push('')
  const rounds = Array.isArray(cycle.rounds) ? cycle.rounds : []
  if (rounds.length === 0) {
    lines.push('（没有评审轮次）')
  }
  for (const round of rounds) {
    const gate = isPlainObject(round.gate) ? round.gate : {}
    lines.push(`## 第 ${round.n} 轮（${markdownEscape(round.mode)}）`)
    lines.push('')
    lines.push(`- 分数：${formatScore(round.score)} / 100；结论：${markdownEscape(round.verdict) || '—'}；门控：${gate.passed === true ? 'PASS' : 'FAIL'}`)
    lines.push(`- 有效发现：${round.supportedCount ?? '—'}；截图/证据卡：${gate.shots ?? '—'}/${gate.requiredShots ?? '—'}；mustFix：${(round.mustFix || []).length} 项`)
    if (round.cost) {
      lines.push(`- 成本：总 ${round.cost.totalMs ?? 0}ms（证据 ${round.cost.evidenceMs ?? 0}ms / 红队 ${round.cost.attackMs ?? 0}ms / 判官 ${round.cost.judgeMs ?? 0}ms）；prompt 字符 ${round.cost.promptChars ?? 0} + ${round.cost.judgePromptChars ?? 0}`)
    }
    if (round.noise && round.noise.rawFindings > 0) {
      lines.push(`- 降噪：原始发现 ${round.noise.rawFindings} → ${round.noise.dedupedFindings}（抑制 ${round.noise.suppressed.length}，已知重复 ${round.noise.knownRepeats}）`)
    }
    if (round.incremental) {
      const inc = round.incremental
      lines.push(`- 增量：变更 ${inc.changedFiles.length} / 新增 ${inc.addedFiles.length} / 删除 ${inc.removedFiles.length}${inc.fullReview ? '（强制全量）' : ''}${inc.truncated ? '（列表截断）' : ''}`)
    }
    if ((round.gate?.failReasons || []).length > 0) {
      lines.push(`- 未通过原因：${round.gate.failReasons.map(markdownEscape).join('；')}`)
    }
    lines.push('')
    if ((round.mustFix || []).length > 0) {
      lines.push('### mustFix')
      lines.push('')
      for (const item of round.mustFix) lines.push(`- ${markdownEscape(item)}`)
      lines.push('')
    }
    if ((round.findings || []).length > 0) {
      lines.push('### 发现')
      lines.push('')
      lines.push('| 严重度 | 标题 | 证据 | 影响 | 修复方向 |')
      lines.push('|---|---|---|---|---|')
      for (const finding of round.findings) {
        lines.push(`| ${markdownEscape(finding.severity)} | ${markdownEscape(finding.title)} | ${markdownEscape(finding.evidence)} | ${markdownEscape(finding.impact)} | ${markdownEscape(finding.fix)} |`)
      }
      lines.push('')
    }
    if ((round.deductions || []).length > 0) {
      lines.push('### 扣分')
      lines.push('')
      for (const deduction of round.deductions) lines.push(`- −${formatScore(deduction.points)}：${markdownEscape(deduction.reason)}（修复：${markdownEscape(deduction.fix)}）`)
      lines.push('')
    }
    if ((round.evidence || []).length > 0) {
      lines.push('### 证据')
      lines.push('')
      for (const card of round.evidence) {
        const artifacts = (card.artifacts || []).map((artifact) => artifact.file).join('、')
        lines.push(`- [${markdownEscape(card.kind)}] ${markdownEscape(card.name)}：${markdownEscape(artifacts)}`)
      }
      lines.push('')
    }
  }
  lines.push('---')
  lines.push('')
  lines.push('Host 只读导出；证据文件通过 /artifact 查看，不包含绝对路径与完整日志。')
  return `${lines.join('\n')}\n`
}

/** Safe `Content-Disposition` attachment filename for one export. */
export function exportFilename(cycleId, format, now = Date.now) {
  const id = stringOr(cycleId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'cycle'
  const stampValue = typeof now === 'function' ? now() : numberOr(now, Date.now())
  const stamp = new Date(numberOr(stampValue, Date.now())).toISOString().replace(/[:.]/g, '-')
  const ext = format === 'md' ? 'md' : 'json'
  return `rtc-${id}-${stamp}.${ext}`
}
