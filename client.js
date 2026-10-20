// Browser half of the Red-Team Review Console.
//
// Plain JavaScript in the lazy-CJS module-loader protocol: the host serves this
// file, it only registers its factory, and the factory returns a Cordis client
// plugin. There is no build step, no bundler, and no network fetch at load time
// beyond the two host review routes read from React effects.
//
// The console contributes a row to the shell's own sidebar panel list and its
// page to the layout's main slot, so it renders inside the same native
// container the built-in Plugins and Schedule pages use. All model work stays
// on the host; this file only reads review state and evidence images.
window.__ModuleLoader__.load({
  id: '@local/dsh-redteam-console',
  factory(require) {
    var React = require('react')
    var h = React.createElement

    var NS = 'adversarial-review'

    // Embedded dictionaries. Kept as one strict-JSON object literal inside the
    // TEXT markers so the static contract test can parse it and prove both
    // languages carry the same key set.
    /* TEXT-BEGIN */
    var TEXT = {
      "zh": {
        "app.title": "红队评审台",
        "app.subtitle": "只读运维看板：红队挑刺 → 独立判官打分 → 修到达标才能停；每轮固定 4 张证据，可看轮次对比、成本与导出。",
        "entry.label": "红队评审台",
        "common.dash": "—",
        "common.unknown": "未知",
        "status.loading": "加载中",
        "status.online": "在线",
        "status.offline": "离线",
        "status.aria": "连接状态：{state}",
        "status.retry": "重试",
        "status.retryAria": "重新读取评审状态",
        "status.refresh": "刷新",
        "status.refreshAria": "立即刷新评审状态",
        "error.title": "无法读取评审状态",
        "error.network": "请求失败，Host 路由可能未启动；5 秒后自动重试。",
        "error.http": "Host 返回 HTTP {status}；5 秒后自动重试。",
        "error.invalidJson": "Host 返回了无法解析的 JSON；5 秒后自动重试。",
        "error.payload": "状态数据格式不正确（ok 不为 true）。",
        "error.detail": "详情：",
        "error.boundaryTitle": "评审台渲染出错",
        "error.boundaryHint": "点击重试；如果仍然失败，请查看浏览器控制台中的错误。",
        "cycles.label": "评审周期",
        "cycles.rounds": "{count} 轮",
        "cycles.status.reviewing": "评审中",
        "cycles.status.passed": "已达标",
        "gate.title": "门控状态",
        "gate.scoreAria": "当前评分 {score} 分（满分 100），要求至少 {required} 分",
        "gate.required": "要求 ≥ {score}",
        "gate.scoreOfTen": "/ 100",
        "gate.markerAria": "{score} 分达标线",
        "gate.findings": "有效问题",
        "gate.findingsValue": "{count} / ≥{required}",
        "gate.findingsSupported": "判官核实 {count} 条",
        "gate.shots": "证据截图",
        "gate.shotsValue": "{count} / {required}",
        "gate.verdict": "结论",
        "gate.passed": "已达标，可以停止",
        "gate.passedHint": "评分、有效问题与截图要求都已满足；可以结束本轮交付。",
        "gate.failed": "未达标，必须继续修复",
        "gate.failReasons": "未达标原因",
        "gate.mustFix": "必须修复（mustFix）",
        "gate.noRound": "当前周期还没有轮次记录",
        "gate.roundRunning": "第 {round} 轮正在评审，完成前门控结果不可用。",
        "gate.missingScore": "暂无评分",
        "rounds.title": "轮次时间线",
        "rounds.chip": "R{n}",
        "rounds.chipAria": "第 {n} 轮，评分 {score}，{status}",
        "rounds.status.running": "进行中",
        "rounds.status.failed": "失败",
        "rounds.status.passed": "已达标",
        "rounds.status.held": "未达标",
        "findings.title": "发现清单",
        "findings.empty": "本轮没有发现记录。",
        "findings.groupCount": "{count} 条",
        "findings.untitled": "（未命名发现）",
        "findings.severity.BLOCKER": "阻断",
        "findings.severity.MAJOR": "严重",
        "findings.severity.MINOR": "轻微",
        "findings.evidence": "证据",
        "findings.attack": "攻击方式",
        "findings.impact": "影响",
        "findings.fix": "修复方向",
        "findings.confidenceValue": "置信度：{value}",
        "findings.confidence.high": "高",
        "findings.confidence.medium": "中",
        "findings.confidence.low": "低",
        "findings.confidence.unknown": "未知",
        "findings.judgeSupported": "判官：已核实",
        "findings.judgeUnsupported": "判官：证据不足",
        "findings.judgeNote": "判官备注",
        "findings.verified": "红队自验通过",
        "findings.unverified": "红队未自验",
        "attack.solidTitle": "已验证稳固项",
        "attack.solidEmpty": "本轮没有记录稳固项。",
        "attack.unverifiedTitle": "未验证项",
        "attack.unverifiedEmpty": "本轮没有未验证项。",
        "attack.needsLabel": "所需证据：{needs}",
        "stability.title": "稳定性与未验证项",
        "judge.title": "判官评分",
        "judge.findingsCountValue": "红队发现数：{count}",
        "judge.screenshotsLine": "截图质量：{quality}（{count} 张）",
        "judge.quality.good": "良好",
        "judge.quality.partial": "一般",
        "judge.quality.bad": "差",
        "judge.quality.unknown": "未知",
        "judge.rationaleTitle": "判官说明",
        "judge.deductionsTitle": "扣分明细",
        "judge.deductionsEmpty": "本轮没有扣分项。",
        "judge.points": "扣分",
        "judge.reason": "原因",
        "judge.fix": "修复方向",
        "judge.mustFixTitle": "必须修复",
        "judge.mustFixEmpty": "没有必须修复项。",
        "judge.missing": "本轮还没有判官评分。",
        "shots.title": "证据截图（每轮固定 4 张）",
        "shots.empty": "本轮没有截图记录。",
        "shots.alt": "证据截图 {file}",
        "shots.failed": "截图加载失败：{file}",
        "shots.failedHint": "文件可能还没生成或已被清理；再跑一轮评审会自动重建。",
        "shots.pixelSize": "{width} × {height}",
        "shots.bytes": "{bytes} 字节",
        "shots.kilobytes": "约 {value} KB",
        "meta.updated": "更新时间",
        "meta.roundCount": "轮数",
        "meta.target": "目标路径",
        "meta.version": "状态版本",
        "meta.unknown": "未知",
        "empty.title": "还没有评审记录",
        "empty.desc": "在对话里让 Agent 跑一轮红队评审；完成后评分、发现和截图会自动出现在这里。",
        "empty.reasonTitle": "状态里没有任何评审周期。",
        "empty.step1": "让 Agent 调用工具 {tool}，并传入 target（被评审项目的路径）。",
        "empty.step2": "可以传 4 个截图规格；留空时工具会自动探测页面并用 4 个视口截图。",
        "empty.step3": "评分低于 95/100 时，按 mustFix 修复后再次评审；只有门控通过才允许停止。",
        "empty.hint": "评审台在有轮次运行时每 2 秒、空闲时每 5 秒自动刷新；不需要手动刷新页面。",
        "loading.title": "正在读取评审状态",
        "loading.hint": "首次加载完成后会自动保持同步。",
        "verdict.PASS": "通过",
        "verdict.HOLD": "保留",
        "verdict.BLOCK": "阻断",
        "status.autoRefresh": "自动刷新 {seconds}s",
        "search.clearAria": "清空搜索",
        "tabs.ariaLabel": "评审详情标签页",
        "tabs.overview": "概览",
        "tabs.rounds": "轮次",
        "tabs.findings": "发现",
        "tabs.evidence": "证据",
        "tabs.cost": "成本",
        "tabs.export": "导出",
        "cycles.search": "搜索名称、路径或 ID",
        "cycles.searchAria": "搜索评审周期",
        "cycles.filterLabel": "按状态筛选",
        "cycles.filter.all": "全部",
        "cycles.filter.reviewing": "评审中",
        "cycles.filter.passed": "已达标",
        "cycles.sortLabel": "排序方式",
        "cycles.sort.updatedDesc": "最近更新",
        "cycles.sort.updatedAsc": "最早更新",
        "cycles.sort.scoreDesc": "评分从高到低",
        "cycles.countLabel": "{visible} / {total}",
        "cycles.target": "目标：{path}",
        "cycles.badge.rounds": "{count} 轮",
        "cycles.badge.reopen": "复评 {count}",
        "cycles.emptyFiltered": "没有符合条件的评审周期",
        "cycles.updatedAt": "更新于 {time}",
        "gate.passedShort": "通过",
        "gate.failedShort": "未通过",
        "overview.latestTitle": "最新轮次摘要",
        "overview.latestRound": "最新轮次",
        "overview.createdLabel": "创建",
        "overview.updatedLabel": "更新",
        "overview.reopen": "复评自第 {round} 轮（共 {count} 次）",
        "overview.incrementalTitle": "增量评审",
        "overview.incremental.mode": "模式：{mode}",
        "overview.incremental.base": "基准轮次：第 {round} 轮",
        "overview.incremental.changed": "变更 {count} 个文件",
        "overview.incremental.added": "新增 {count}",
        "overview.incremental.removed": "删除 {count}",
        "overview.incremental.truncated": "文件列表已截断",
        "overview.incremental.full": "全量评审",
        "progress.title": "评审进度",
        "progress.stage.evidence": "渲染证据",
        "progress.stage.attacker": "红队挑刺",
        "progress.stage.judge": "判官打分",
        "progress.stage.gate": "门控计算",
        "progress.stage.done": "已完成",
        "progress.stage.unknown": "未知阶段",
        "progress.cancelled": "已取消",
        "progress.waiting": "等待进度事件…",
        "progress.aria": "第 {round} 轮进度：{stage}，{percent}%",
        "progress.updated": "更新于 {time}",
        "progress.detail": "详情：{detail}",
        "progress.running": "进行中",
        "progress.doneHint": "本轮已结束",
        "progress.fallback": "实时进度流不可用，正在使用状态轮询。",
        "cancel.button": "取消本轮",
        "cancel.busy": "正在取消…",
        "cancel.aria": "取消正在进行的第 {round} 轮评审",
        "cancel.done": "已请求取消，等待本轮收尾。",
        "cancel.failed": "取消请求失败",
        "rounds.tableTitle": "轮次列表",
        "rounds.selectGroup": "选择要查看的轮次",
        "rounds.selectAria": "查看第 {n} 轮详情",
        "rounds.col.n": "轮次",
        "rounds.col.status": "状态",
        "rounds.col.score": "评分",
        "rounds.col.verdict": "结论",
        "rounds.col.judges": "判官",
        "rounds.col.disagreement": "分歧",
        "rounds.col.findings": "发现（核实）",
        "rounds.col.evidence": "证据产物",
        "rounds.col.cost": "成本",
        "rounds.col.diff": "轮次对比",
        "rounds.judgesValue": "{count} 位",
        "rounds.disagreementValue": "分歧 {value}",
        "rounds.findingsValue": "{count}（核实 {supported}）",
        "rounds.evidenceValue": "{kinds}，{count} 个产物",
        "diff.status.new": "新增",
        "diff.status.repeat": "重复",
        "diff.status.fixed": "已修复",
        "diff.status.severityChanged": "级别变化",
        "diff.summaryAria": "本轮对比：新增 {newCount}，重复 {repeat}，已修复 {fixed}，级别变化 {changed}",
        "diff.fetchError": "加载轮次对比失败。",
        "findings.search": "搜索发现（标题/证据/攻击/影响/修复）",
        "findings.searchAria": "搜索当前轮次的发现",
        "findings.filterLabel": "按严重度筛选",
        "findings.filter.all": "全部",
        "findings.filterEmpty": "没有匹配的发现",
        "findings.mustFixTitle": "必须修复（已去重）",
        "noise.raw": "原始发现",
        "noise.deduped": "去重后",
        "noise.suppressed": "已抑制",
        "noise.knownRepeats": "已知重复",
        "noise.empty": "本轮没有降噪记录。",
        "evidence.title": "证据与产物",
        "evidence.empty": "本轮没有证据记录。",
        "evidence.card": "证据卡 {index}",
        "evidence.artifacts": "{count} 个产物",
        "evidence.kind.screenshot": "截图",
        "evidence.kind.interaction": "交互回放",
        "evidence.kind.image": "项目图片",
        "evidence.kind.pdf-text": "PDF 文本页",
        "evidence.kind.report-page": "评审报告页",
        "evidence.kind.unknown": "其他证据",
        "evidence.type.text": "文本",
        "evidence.type.log": "日志",
        "evidence.type.json": "JSON",
        "evidence.type.console": "console 日志",
        "evidence.type.network": "网络日志",
        "evidence.type.metrics": "指标",
        "evidence.type.file": "文件",
        "evidence.kindCount": "{kind} ×{count}",
        "evidence.representative": "代表图",
        "evidence.representativeHint": "每轮固定 4 张代表图；点击可打开原图。",
        "evidence.extra": "额外产物",
        "evidence.consoleErrors": "console 错误 {count}",
        "evidence.networkFailures": "网络失败 {count}",
        "evidence.fps": "FPS {value}",
        "evidence.sha": "sha256 {value}",
        "evidence.dims": "{width} × {height}",
        "evidence.openImage": "打开大图：{file}",
        "evidence.download": "下载 {file}",
        "evidence.pdfText": "PDF 提取文本",
        "evidence.noArtifacts": "该证据卡没有额外产物。",
        "cost.title": "本地耗时与规模",
        "cost.note": "本地计时与字符数，不是计费账单；仅用于排查性能。",
        "cost.total": "总耗时",
        "cost.evidence": "证据渲染",
        "cost.attack": "红队阶段",
        "cost.judge": "判官阶段",
        "cost.promptChars": "红队提示词字符数",
        "cost.judgePromptChars": "判官提示词字符数",
        "cost.judgeSamples": "判官样本数",
        "cost.artifactCount": "证据产物数",
        "cost.profile": "领域 profile",
        "cost.empty": "本轮还没有成本记录。",
        "export.title": "导出与审计",
        "export.note": "下载由 Host 生成；导出文件包含当前周期（cycle）的轮次、评分、发现与证据清单。",
        "export.markdown": "下载 Markdown 报告",
        "export.json": "下载 JSON 数据",
        "export.sessionTitle": "子会话与审计 ID",
        "export.attackerSession": "红队会话",
        "export.judgeSessions": "判官会话",
        "export.noSession": "无记录",
        "export.copy": "复制",
        "export.copyAria": "复制 {label}",
        "export.copied": "已复制",
        "export.copyFailed": "复制失败，请手动选择文本",
        "export.rubricVersion": "规则版本",
        "profile.code": "代码",
        "profile.web": "网页",
        "profile.game": "游戏",
        "profile.modeling": "建模",
        "cancel.declined": "取消未被接受：{reason}",
        "noise.title": "降噪摘要",
        "overview.incremental.unchanged": "{count} 个文件未变化",
        "overview.incremental.modeValue.incremental": "增量",
        "overview.incremental.modeValue.reopen": "复评",
        "overview.incremental.modeValue.full": "全量",
        "noise.suppressedItem": "已抑制：{title}（{reason}）"
      },
      "en": {
        "app.title": "Red-Team Review Console",
        "app.subtitle": "Read-only operations board: red team attacks, an independent judge scores, and work continues until the gate passes; four evidence cards per round, with round diffs, cost, and export.",
        "entry.label": "Red-Team Review Console",
        "common.dash": "—",
        "common.unknown": "Unknown",
        "status.loading": "Loading",
        "status.online": "Live",
        "status.offline": "Offline",
        "status.aria": "Connection status: {state}",
        "status.retry": "Retry",
        "status.retryAria": "Reload the review state",
        "status.refresh": "Refresh",
        "status.refreshAria": "Refresh the review state now",
        "error.title": "Could not read review state",
        "error.network": "Request failed; the host route may be unavailable. Retrying in 5 seconds.",
        "error.http": "The host returned HTTP {status}. Retrying in 5 seconds.",
        "error.invalidJson": "The host returned unreadable JSON. Retrying in 5 seconds.",
        "error.payload": "Unexpected state payload (ok is not true).",
        "error.detail": "Details: ",
        "error.boundaryTitle": "The console failed to render",
        "error.boundaryHint": "Click retry; if it keeps failing, check the browser console for the error.",
        "cycles.label": "Review cycles",
        "cycles.rounds": "{count} rounds",
        "cycles.status.reviewing": "Reviewing",
        "cycles.status.passed": "Passed",
        "gate.title": "Gate status",
        "gate.scoreAria": "Current score {score} of 100; at least {required} required",
        "gate.required": "Required ≥ {score}",
        "gate.scoreOfTen": "/ 100",
        "gate.markerAria": "{score} threshold line",
        "gate.findings": "Valid findings",
        "gate.findingsValue": "{count} / ≥{required}",
        "gate.findingsSupported": "Judge confirmed {count}",
        "gate.shots": "Evidence shots",
        "gate.shotsValue": "{count} / {required}",
        "gate.verdict": "Verdict",
        "gate.passed": "Gate passed — you may stop",
        "gate.passedHint": "Score, supported findings, and screenshot requirements are all met; this delivery can stop.",
        "gate.failed": "Gate not passed — keep fixing",
        "gate.failReasons": "Why it did not pass",
        "gate.mustFix": "Must fix",
        "gate.noRound": "This cycle has no rounds yet",
        "gate.roundRunning": "Round {round} is still running; gate results are unavailable until it completes.",
        "gate.missingScore": "No score yet",
        "rounds.title": "Round timeline",
        "rounds.chip": "R{n}",
        "rounds.chipAria": "Round {n}, score {score}, {status}",
        "rounds.status.running": "running",
        "rounds.status.failed": "failed",
        "rounds.status.passed": "passed",
        "rounds.status.held": "not passed",
        "findings.title": "Findings",
        "findings.empty": "No findings recorded for this round.",
        "findings.groupCount": "{count}",
        "findings.untitled": "(untitled finding)",
        "findings.severity.BLOCKER": "Blocker",
        "findings.severity.MAJOR": "Major",
        "findings.severity.MINOR": "Minor",
        "findings.evidence": "Evidence",
        "findings.attack": "Attack",
        "findings.impact": "Impact",
        "findings.fix": "Fix direction",
        "findings.confidenceValue": "Confidence: {value}",
        "findings.confidence.high": "High",
        "findings.confidence.medium": "Medium",
        "findings.confidence.low": "Low",
        "findings.confidence.unknown": "Unknown",
        "findings.judgeSupported": "Judge: supported",
        "findings.judgeUnsupported": "Judge: unsupported",
        "findings.judgeNote": "Judge note",
        "findings.verified": "Verified by red team",
        "findings.unverified": "Not self-verified",
        "attack.solidTitle": "Solid items",
        "attack.solidEmpty": "No solid items recorded this round.",
        "attack.unverifiedTitle": "Unverified items",
        "attack.unverifiedEmpty": "No unverified items this round.",
        "attack.needsLabel": "Needs: {needs}",
        "stability.title": "Stability and open questions",
        "judge.title": "Judge score",
        "judge.findingsCountValue": "Red-team findings: {count}",
        "judge.screenshotsLine": "Screenshot quality: {quality} ({count})",
        "judge.quality.good": "good",
        "judge.quality.partial": "partial",
        "judge.quality.bad": "bad",
        "judge.quality.unknown": "unknown",
        "judge.rationaleTitle": "Judge rationale",
        "judge.deductionsTitle": "Deductions",
        "judge.deductionsEmpty": "No deductions this round.",
        "judge.points": "Points",
        "judge.reason": "Reason",
        "judge.fix": "Fix",
        "judge.mustFixTitle": "Must fix",
        "judge.mustFixEmpty": "Nothing required to fix.",
        "judge.missing": "No judge score for this round yet.",
        "shots.title": "Evidence screenshots (4 per round)",
        "shots.empty": "No screenshots recorded for this round.",
        "shots.alt": "Evidence screenshot {file}",
        "shots.failed": "Screenshot failed to load: {file}",
        "shots.failedHint": "The file may not exist yet or was cleaned up; running another review round rebuilds it.",
        "shots.pixelSize": "{width} × {height}",
        "shots.bytes": "{bytes} bytes",
        "shots.kilobytes": "~{value} KB",
        "meta.updated": "Updated",
        "meta.roundCount": "Rounds",
        "meta.target": "Target path",
        "meta.version": "State version",
        "meta.unknown": "Unknown",
        "empty.title": "No review records yet",
        "empty.desc": "Ask the agent to run an adversarial review round in the conversation; scores, findings, and screenshots appear here automatically.",
        "empty.reasonTitle": "The state contains no review cycles.",
        "empty.step1": "Ask the agent to call the {tool} tool with a target (the project path).",
        "empty.step2": "Pass four screenshot specs if needed; when omitted, the tool auto-detects the page and captures four viewports.",
        "empty.step3": "Below 95/100, fix the mustFix items and review again; stop only after the gate passes.",
        "empty.hint": "This console refreshes every 2s while a round is running and every 5s when idle; no manual reload needed.",
        "loading.title": "Loading review state",
        "loading.hint": "It stays in sync automatically once loaded.",
        "verdict.PASS": "PASS",
        "verdict.HOLD": "HOLD",
        "verdict.BLOCK": "BLOCK",
        "status.autoRefresh": "Auto refresh {seconds}s",
        "search.clearAria": "Clear the search",
        "tabs.ariaLabel": "Review detail tabs",
        "tabs.overview": "Overview",
        "tabs.rounds": "Rounds",
        "tabs.findings": "Findings",
        "tabs.evidence": "Evidence",
        "tabs.cost": "Cost",
        "tabs.export": "Export",
        "cycles.search": "Search name, path, or ID",
        "cycles.searchAria": "Search review cycles",
        "cycles.filterLabel": "Filter by status",
        "cycles.filter.all": "All",
        "cycles.filter.reviewing": "Reviewing",
        "cycles.filter.passed": "Passed",
        "cycles.sortLabel": "Sort by",
        "cycles.sort.updatedDesc": "Recently updated",
        "cycles.sort.updatedAsc": "Oldest updated",
        "cycles.sort.scoreDesc": "Highest score",
        "cycles.countLabel": "{visible} / {total}",
        "cycles.target": "Target: {path}",
        "cycles.badge.rounds": "{count} rounds",
        "cycles.badge.reopen": "Reopened {count}",
        "cycles.emptyFiltered": "No review cycles match the filters",
        "cycles.updatedAt": "Updated {time}",
        "gate.passedShort": "PASS",
        "gate.failedShort": "FAIL",
        "overview.latestTitle": "Latest round summary",
        "overview.latestRound": "Latest round",
        "overview.createdLabel": "Created",
        "overview.updatedLabel": "Updated",
        "overview.reopen": "Reopened from round {round} ({count} times)",
        "overview.incrementalTitle": "Incremental review",
        "overview.incremental.mode": "Mode: {mode}",
        "overview.incremental.base": "Base round: {round}",
        "overview.incremental.changed": "{count} changed files",
        "overview.incremental.added": "{count} added",
        "overview.incremental.removed": "{count} removed",
        "overview.incremental.truncated": "file list truncated",
        "overview.incremental.full": "Full review",
        "progress.title": "Review progress",
        "progress.stage.evidence": "Capturing evidence",
        "progress.stage.attacker": "Red-team attack",
        "progress.stage.judge": "Judge scoring",
        "progress.stage.gate": "Gate check",
        "progress.stage.done": "Done",
        "progress.stage.unknown": "Unknown stage",
        "progress.cancelled": "Cancelled",
        "progress.waiting": "Waiting for progress events…",
        "progress.aria": "Round {round} progress: {stage}, {percent}%",
        "progress.updated": "Updated {time}",
        "progress.detail": "Detail: {detail}",
        "progress.running": "Running",
        "progress.doneHint": "This round has finished",
        "progress.fallback": "Live progress stream unavailable; using state polling.",
        "cancel.button": "Cancel round",
        "cancel.busy": "Cancelling…",
        "cancel.aria": "Cancel the running review round {round}",
        "cancel.done": "Cancellation requested; waiting for the round to wind down.",
        "cancel.failed": "Cancel request failed",
        "rounds.tableTitle": "Rounds",
        "rounds.selectGroup": "Choose a round to view",
        "rounds.selectAria": "View round {n} details",
        "rounds.col.n": "Round",
        "rounds.col.status": "Status",
        "rounds.col.score": "Score",
        "rounds.col.verdict": "Verdict",
        "rounds.col.judges": "Judges",
        "rounds.col.disagreement": "Disagreement",
        "rounds.col.findings": "Findings (supported)",
        "rounds.col.evidence": "Evidence",
        "rounds.col.cost": "Cost",
        "rounds.col.diff": "Diff",
        "rounds.judgesValue": "{count}",
        "rounds.disagreementValue": "Δ {value}",
        "rounds.findingsValue": "{count} ({supported} supported)",
        "rounds.evidenceValue": "{kinds}, {count} artifacts",
        "diff.status.new": "New",
        "diff.status.repeat": "Repeat",
        "diff.status.fixed": "Fixed",
        "diff.status.severityChanged": "Severity changed",
        "diff.summaryAria": "Round diff: {newCount} new, {repeat} repeat, {fixed} fixed, {changed} severity changed",
        "diff.fetchError": "Could not load the round diff.",
        "findings.search": "Search findings (title/evidence/attack/impact/fix)",
        "findings.searchAria": "Search findings in the selected round",
        "findings.filterLabel": "Filter by severity",
        "findings.filter.all": "All",
        "findings.filterEmpty": "No findings match the filters",
        "findings.mustFixTitle": "Must fix (deduplicated)",
        "noise.raw": "Raw findings",
        "noise.deduped": "Deduplicated",
        "noise.suppressed": "Suppressed",
        "noise.knownRepeats": "Known repeats",
        "noise.empty": "No noise data for this round.",
        "evidence.title": "Evidence and artifacts",
        "evidence.empty": "No evidence recorded for this round.",
        "evidence.card": "Evidence card {index}",
        "evidence.artifacts": "{count} artifacts",
        "evidence.kind.screenshot": "Screenshot",
        "evidence.kind.interaction": "Interaction",
        "evidence.kind.image": "Project image",
        "evidence.kind.pdf-text": "PDF text page",
        "evidence.kind.report-page": "Report page",
        "evidence.kind.unknown": "Other evidence",
        "evidence.type.text": "text",
        "evidence.type.log": "log",
        "evidence.type.json": "JSON",
        "evidence.type.console": "console log",
        "evidence.type.network": "network log",
        "evidence.type.metrics": "metrics",
        "evidence.type.file": "file",
        "evidence.kindCount": "{kind} ×{count}",
        "evidence.representative": "Representative image",
        "evidence.representativeHint": "Four representative images per round; click to open the original.",
        "evidence.extra": "Additional artifacts",
        "evidence.consoleErrors": "Console errors {count}",
        "evidence.networkFailures": "Network failures {count}",
        "evidence.fps": "FPS {value}",
        "evidence.sha": "sha256 {value}",
        "evidence.dims": "{width} × {height}",
        "evidence.openImage": "Open full image: {file}",
        "evidence.download": "Download {file}",
        "evidence.pdfText": "Extracted PDF text",
        "evidence.noArtifacts": "No additional artifacts for this evidence card.",
        "cost.title": "Local timing and size",
        "cost.note": "Local timings and character counts, not a billing statement; for performance triage only.",
        "cost.total": "Total",
        "cost.evidence": "Evidence capture",
        "cost.attack": "Attacker",
        "cost.judge": "Judge",
        "cost.promptChars": "Attacker prompt chars",
        "cost.judgePromptChars": "Judge prompt chars",
        "cost.judgeSamples": "Judge samples",
        "cost.artifactCount": "Evidence artifacts",
        "cost.profile": "Domain profile",
        "cost.empty": "No cost data for this round yet.",
        "export.title": "Export and audit",
        "export.note": "Downloads are produced by the host; exports contain the cycle rounds, scores, findings, and evidence manifest.",
        "export.markdown": "Download Markdown report",
        "export.json": "Download JSON data",
        "export.sessionTitle": "Child sessions and audit IDs",
        "export.attackerSession": "Attacker session",
        "export.judgeSessions": "Judge sessions",
        "export.noSession": "Not recorded",
        "export.copy": "Copy",
        "export.copyAria": "Copy {label}",
        "export.copied": "Copied",
        "export.copyFailed": "Copy failed; select the text manually",
        "export.rubricVersion": "Rubric version",
        "profile.code": "Code",
        "profile.web": "Web",
        "profile.game": "Game",
        "profile.modeling": "Modeling",
        "cancel.declined": "Cancellation declined: {reason}",
        "noise.title": "Noise summary",
        "overview.incremental.unchanged": "{count} unchanged files",
        "overview.incremental.modeValue.incremental": "incremental",
        "overview.incremental.modeValue.reopen": "reopen",
        "overview.incremental.modeValue.full": "full",
        "noise.suppressedItem": "Suppressed: {title} ({reason})"
      }
    }
    /* TEXT-END */

    // ---------------------------------------------------------------------
    // Locale wiring. The locale service is optional: when the host provides it
    // the embedded dictionaries are registered and the active language is read
    // from its snapshot; otherwise the plain dictionary matches the document
    // language. Every call is guarded so a missing service never breaks render.
    // ---------------------------------------------------------------------
    var currentLocale = null
    var languageListeners = []

    function detectLanguage() {
      var lang = ''
      try {
        if (typeof document !== 'undefined' && document.documentElement) {
          lang = document.documentElement.lang || ''
        }
      } catch (error) {
        lang = ''
      }
      if (!lang) {
        try {
          lang = (typeof navigator !== 'undefined' && navigator && navigator.language) || ''
        } catch (error) {
          lang = ''
        }
      }
      return /^zh/i.test(lang) ? 'zh' : 'en'
    }

    function activeLanguage() {
      var active = ''
      if (currentLocale) {
        try {
          if (typeof currentLocale.getSnapshot === 'function') {
            var snapshot = currentLocale.getSnapshot()
            if (snapshot && typeof snapshot.active === 'string') active = snapshot.active
          }
        } catch (error) {
          active = ''
        }
      }
      if (active) return /^zh/i.test(active) ? 'zh' : 'en'
      return detectLanguage()
    }

    function translateTemplate(template, params) {
      var text = typeof template === 'string' ? template : ''
      if (!params) return text
      for (var name in params) {
        if (!Object.prototype.hasOwnProperty.call(params, name)) continue
        text = text.split('{' + name + '}').join(String(params[name]))
      }
      return text
    }

    function t(key, params) {
      var language = activeLanguage()
      var template = ''
      if (currentLocale && typeof currentLocale.translate === 'function') {
        try {
          var translated = currentLocale.translate(NS, key)
          if (typeof translated === 'string' && translated !== key) template = translated
        } catch (error) {
          template = ''
        }
      }
      if (!template) {
        var table = TEXT[language] || TEXT.en
        if (typeof table[key] === 'string') template = table[key]
        else if (typeof TEXT.en[key] === 'string') template = TEXT.en[key]
        else template = key
      }
      return translateTemplate(template, params)
    }

    function notifyLanguageChange() {
      var listeners = languageListeners.slice()
      for (var i = 0; i < listeners.length; i += 1) {
        try {
          listeners[i]()
        } catch (error) {
          console.error('[adversarial-review] language listener failed', error)
        }
      }
    }

    function subscribeLanguage(listener) {
      languageListeners.push(listener)
      return function unsubscribeLanguage() {
        var index = languageListeners.indexOf(listener)
        if (index >= 0) languageListeners.splice(index, 1)
      }
    }

    // ---------------------------------------------------------------------
    // Pure helpers (no React, no DOM, no locale lookups). They live inside the
    // PURE markers so the static test evaluates exactly the shipped functions
    // instead of a re-implementation. Keep this region dependency-free.
    // ---------------------------------------------------------------------
    /* PURE-BEGIN */
    var STATE_URL = '/adversarial-review/state'
    var SHOT_URL = '/adversarial-review/shot'
    var ARTIFACT_URL = '/adversarial-review/artifact'
    var DIFF_URL = '/adversarial-review/diff'
    var EXPORT_URL = '/adversarial-review/export'
    var PROGRESS_URL = '/adversarial-review/progress'
    var CANCEL_URL = '/adversarial-review/cancel'
    var POLL_IDLE_MS = 5000
    var POLL_ACTIVE_MS = 2000
    var REQUIRED_SCORE_FALLBACK = 95
    var REQUIRED_FINDINGS_FALLBACK = 3
    var REQUIRED_SHOTS_FALLBACK = 4
    var SEVERITY_ORDER = ['BLOCKER', 'MAJOR', 'MINOR']
    var CONFIDENCE_ORDER = ['high', 'medium', 'low']
    var PROGRESS_STAGES = ['evidence', 'attacker', 'judge', 'gate', 'done']
    var CYCLE_STATUSES = ['all', 'reviewing', 'passed']
    var EVIDENCE_KINDS = ['screenshot', 'interaction', 'image', 'pdf-text', 'report-page']
    var DIFF_STATUSES = ['new', 'repeat', 'fixed', 'severity-changed']
    var PROFILE_IDS = ['code', 'web', 'game', 'modeling']
    var TABS = ['overview', 'rounds', 'findings', 'evidence', 'cost', 'export']

    function isObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    function asString(value) {
      if (typeof value === 'string') return value
      if (typeof value === 'number' && isFinite(value)) return String(value)
      if (typeof value === 'boolean') return value ? 'true' : 'false'
      return ''
    }

    function toFiniteNumber(value) {
      if (typeof value === 'number' && isFinite(value)) return value
      if (typeof value === 'string' && value.trim() !== '') {
        var parsed = Number(value)
        if (isFinite(parsed)) return parsed
      }
      return null
    }

    function firstNumber(values) {
      for (var i = 0; i < values.length; i += 1) {
        var number = toFiniteNumber(values[i])
        if (number !== null) return number
      }
      return null
    }

    function firstNumberOr(values, fallback) {
      var number = firstNumber(values)
      return number === null ? fallback : number
    }

    function clamp(value, min, max) {
      var number = toFiniteNumber(value)
      if (number === null) return min
      if (number < min) return min
      if (number > max) return max
      return number
    }

    function cleanStringList(values) {
      var list = asArray(values)
      var result = []
      for (var i = 0; i < list.length; i += 1) {
        var text = asString(list[i]).trim()
        if (text) result.push(text)
      }
      return result
    }

    /** Dedupe a text list case-insensitively while keeping the first spelling. */
    function dedupeStrings(values) {
      var list = cleanStringList(values)
      var seen = {}
      var result = []
      for (var i = 0; i < list.length; i += 1) {
        var key = normalizeTitle(list[i])
        if (key === '' || seen[key] === true) continue
        seen[key] = true
        result.push(list[i])
      }
      return result
    }

    /** 0-100 score text: whole numbers stay clean, halves keep one decimal. */
    function formatScoreText(value, dashText) {
      var number = toFiniteNumber(value)
      if (number === null) return typeof dashText === 'string' ? dashText : ''
      if (Math.round(number) === number) return String(number)
      return number.toFixed(1)
    }

    function formatCountText(value, dashText) {
      var number = toFiniteNumber(value)
      if (number === null) return typeof dashText === 'string' ? dashText : ''
      return String(Math.round(number))
    }

    /** Compact local duration: 850ms / 1.5s / 25s / 2m 05s / 1h 02m. */
    function formatDuration(value) {
      var ms = toFiniteNumber(value)
      if (ms === null || ms < 0) return ''
      if (ms < 1000) return String(Math.round(ms)) + 'ms'
      var seconds = ms / 1000
      if (seconds < 10) return seconds.toFixed(1) + 's'
      if (seconds < 60) return String(Math.round(seconds)) + 's'
      var totalSeconds = Math.round(seconds)
      var minutes = Math.floor(totalSeconds / 60)
      var restSeconds = totalSeconds % 60
      if (minutes < 60) return String(minutes) + 'm ' + (restSeconds < 10 ? '0' + restSeconds : String(restSeconds)) + 's'
      var hours = Math.floor(minutes / 60)
      var restMinutes = minutes % 60
      return String(hours) + 'h ' + (restMinutes < 10 ? '0' + restMinutes : String(restMinutes)) + 'm'
    }

    function severityOrder() {
      return SEVERITY_ORDER.slice()
    }

    function normalizeSeverity(value) {
      var severity = asString(value).toUpperCase()
      return SEVERITY_ORDER.indexOf(severity) >= 0 ? severity : 'MINOR'
    }

    function normalizeTitle(value) {
      return asString(value).trim().toLowerCase().replace(/\s+/g, ' ')
    }

    function judgeVerdictForTitle(validFindings, title) {
      var target = normalizeTitle(title)
      if (!target) return null
      var list = asArray(validFindings)
      var fallback = null
      for (var i = 0; i < list.length; i += 1) {
        var item = list[i]
        if (!isObject(item) || normalizeTitle(item.title) !== target) continue
        var entry = { supported: item.supported === true, note: asString(item.note) }
        if (entry.supported) return entry
        if (fallback === null) fallback = entry
      }
      return fallback
    }

    function countSupportedFindings(validFindings) {
      var list = asArray(validFindings)
      var count = 0
      for (var i = 0; i < list.length; i += 1) {
        if (isObject(list[i]) && list[i].supported === true) count += 1
      }
      return count
    }

    function roundNumberOf(round, index) {
      var declared = firstNumber([round && round.n, round && round.round, round && round.number])
      return declared === null ? index + 1 : Math.round(declared)
    }

    function sortRoundEntries(rounds) {
      var list = asArray(rounds)
      var entries = []
      for (var i = 0; i < list.length; i += 1) {
        if (!isObject(list[i])) continue
        entries.push({ round: list[i], number: roundNumberOf(list[i], i) })
      }
      entries.sort(function orderRounds(left, right) {
        return left.number - right.number
      })
      return entries
    }

    function latestRoundEntry(entries) {
      var list = asArray(entries)
      return list.length > 0 ? list[list.length - 1] : null
    }

    function cycleKeyOf(cycle, index) {
      var id = asString(cycle && cycle.id)
      return id || ('@' + index)
    }

    /** Stable keyed entries for the rail; cycles arrive already ranked by the host. */
    function cycleEntriesFrom(cycles) {
      var list = asArray(cycles)
      var entries = []
      for (var i = 0; i < list.length; i += 1) {
        if (!isObject(list[i])) continue
        entries.push({ cycle: list[i], key: cycleKeyOf(list[i], i), index: i })
      }
      return entries
    }

    function findCycleEntry(entries, wantedKey) {
      if (!wantedKey) return null
      for (var i = 0; i < entries.length; i += 1) {
        if (entries[i].key === wantedKey) return entries[i]
      }
      return null
    }

    function findRoundEntry(entries, wantedNumber) {
      if (entries.length === 0) return null
      for (var i = 0; i < entries.length; i += 1) {
        if (entries[i].number === wantedNumber) return entries[i]
      }
      return entries[entries.length - 1]
    }

    function roundStatusKey(info) {
      if (info.passed) return 'rounds.status.passed'
      if (info.status === 'running') return 'rounds.status.running'
      if (info.status === 'failed') return 'rounds.status.failed'
      return 'rounds.status.held'
    }

    function roundTone(info) {
      if (info.passed) return 'passed'
      if (info.status === 'running') return 'running'
      if (info.status === 'failed') return 'failed'
      return 'held'
    }

    function verdictTone(verdict) {
      var upper = asString(verdict).toUpperCase()
      if (upper === 'PASS') return 'pass'
      if (upper === 'HOLD') return 'hold'
      if (upper === 'BLOCK') return 'block'
      return ''
    }

    function verdictKey(verdict) {
      var upper = asString(verdict).toUpperCase()
      if (upper === 'PASS' || upper === 'HOLD' || upper === 'BLOCK') return 'verdict.' + upper
      return ''
    }

    /** Cycle rail search: title, target or id, case-insensitive substring. */
    function filterCycles(cycles, query, statusFilter) {
      var list = asArray(cycles)
      var text = asString(query).trim().toLowerCase()
      var status = CYCLE_STATUSES.indexOf(asString(statusFilter)) >= 0 ? asString(statusFilter) : 'all'
      var result = []
      for (var i = 0; i < list.length; i += 1) {
        var cycle = list[i]
        if (!isObject(cycle)) continue
        var cycleStatus = asString(cycle.status) === 'passed' ? 'passed' : 'reviewing'
        if (status !== 'all' && cycleStatus !== status) continue
        if (text) {
          var haystack = [cycle.title, cycle.target, cycle.id].map(asString).join('\n').toLowerCase()
          if (haystack.indexOf(text) < 0) continue
        }
        result.push(cycle)
      }
      return result
    }

    function cycleUpdatedAt(cycle) {
      return toFiniteNumber(cycle && cycle.updatedAt)
    }

    function cycleLatestScore(cycle) {
      var entries = sortRoundEntries(cycle && cycle.rounds)
      if (entries.length === 0) return null
      return normalizeGate(cycle, entries[entries.length - 1].round).score
    }

    /** Sort a copy of the cycle list: updated desc/asc or score desc. */
    function sortCycles(cycles, mode) {
      var list = asArray(cycles).filter(isObject)
      var order = asString(mode)
      if (order === 'updated-asc') {
        list.sort(function ascending(left, right) {
          return (cycleUpdatedAt(left) === null ? 0 : cycleUpdatedAt(left)) - (cycleUpdatedAt(right) === null ? 0 : cycleUpdatedAt(right))
        })
      } else if (order === 'score-desc') {
        list.sort(function byScore(left, right) {
          var leftScore = cycleLatestScore(left)
          var rightScore = cycleLatestScore(right)
          if (leftScore !== rightScore) return (rightScore === null ? -1 : rightScore) - (leftScore === null ? -1 : leftScore)
          return (cycleUpdatedAt(right) === null ? 0 : cycleUpdatedAt(right)) - (cycleUpdatedAt(left) === null ? 0 : cycleUpdatedAt(left))
        })
      } else {
        list.sort(function descending(left, right) {
          return (cycleUpdatedAt(right) === null ? 0 : cycleUpdatedAt(right)) - (cycleUpdatedAt(left) === null ? 0 : cycleUpdatedAt(left))
        })
      }
      return list
    }

    function normalizeGate(cycle, round) {
      var gate = isObject(round && round.gate) ? round.gate : null
      var score = isObject(round && round.score) ? round.score : null
      var attack = isObject(round && round.attack) ? round.attack : null
      var required = isObject(cycle && cycle.required) ? cycle.required : {}
      var shots = asArray(round && round.shots)
      var findings = asArray(attack && attack.findings)
      var validFindings = isObject(score) ? score.validFindings : null
      return {
        score: firstNumber([gate && gate.score, score && score.score]),
        requiredScore: firstNumberOr([gate && gate.requiredScore, required.score], REQUIRED_SCORE_FALLBACK),
        findings: firstNumberOr([gate && gate.findings, score && score.findingsCount], findings.length),
        requiredFindings: firstNumberOr([gate && gate.requiredFindings, required.findings], REQUIRED_FINDINGS_FALLBACK),
        supported: firstNumberOr([score && score.supportedCount, gate && gate.supportedCount], countSupportedFindings(validFindings)),
        shots: firstNumberOr([gate && gate.shots], shots.length),
        requiredShots: firstNumberOr([gate && gate.requiredShots, required.shots], REQUIRED_SHOTS_FALLBACK),
        passed: gate !== null && gate.passed === true,
        hasGate: gate !== null,
        status: asString(round && round.status),
        failReasons: cleanStringList(gate && gate.failReasons),
        mustFix: cleanStringList(score && score.mustFix),
        verdict: asString(score && score.verdict) || asString(attack && attack.verdict)
      }
    }

    function normalizeState(payload) {
      if (!isObject(payload)) return { ok: false, error: '' }
      if (payload.ok === false) return { ok: false, error: asString(payload.error) }
      if (payload.ok !== true) return { ok: false, error: '' }
      return {
        ok: true,
        cycles: asArray(payload.cycles).filter(isObject),
        generatedAt: toFiniteNumber(payload.generatedAt),
        version: toFiniteNumber(payload.version)
      }
    }

    function describeError(error) {
      var code = error && error.rtcCode
      if (code === 'http') return { key: 'error.http', params: { status: String(error.rtcStatus || '?') }, detail: '' }
      if (code === 'invalid-json') return { key: 'error.invalidJson', params: {}, detail: '' }
      if (code === 'cancel') return { key: 'cancel.failed', params: {}, detail: asString(error && error.message) }
      return { key: 'error.network', params: {}, detail: asString(error && error.message) }
    }

    function normalizeStage(value) {
      var stage = asString(value).toLowerCase()
      if (stage === 'cancelled') return 'cancelled'
      return PROGRESS_STAGES.indexOf(stage) >= 0 ? stage : ''
    }

    function stagePercent(stage) {
      var normalized = normalizeStage(stage)
      var percents = { evidence: 15, attacker: 40, judge: 70, gate: 90, done: 100, cancelled: 100 }
      return percents[normalized] === undefined ? 0 : percents[normalized]
    }

    /** Normalized live/state progress for one round (or the cycle fallback). */
    function progressOf(round, cycle) {
      var raw = null
      if (isObject(round) && isObject(round.progress)) raw = round.progress
      else if (isObject(cycle) && isObject(cycle.progress)) raw = cycle.progress
      if (raw) {
        var stage = normalizeStage(raw.stage)
        var cancelled = stage === 'cancelled'
        return {
          stage: stage,
          updatedAt: firstNumber([raw.updatedAt]),
          detail: asString(raw.detail),
          derived: false,
          done: stage === 'done' || cancelled,
          cancelled: cancelled
        }
      }
      var status = asString(round && round.status)
      if (status === 'running') {
        return { stage: 'evidence', updatedAt: firstNumber([round.startedAt]), detail: asString(round.error), derived: true, done: false, cancelled: false }
      }
      if (status === 'completed') {
        return { stage: 'done', updatedAt: firstNumber([round.finishedAt]), detail: '', derived: true, done: true, cancelled: false }
      }
      if (status === 'failed') {
        return { stage: 'cancelled', updatedAt: firstNumber([round.finishedAt]), detail: asString(round.error), derived: true, done: true, cancelled: true }
      }
      return null
    }

    function progressLabelKey(progress) {
      if (isObject(progress) && progress.cancelled) return 'progress.cancelled'
      var stage = normalizeStage(progress && progress.stage)
      if (!stage) return 'progress.stage.unknown'
      return 'progress.stage.' + stage
    }

    /** Test-friendly label helper: inject the translate function. */
    function progressLabel(progress, translate) {
      var key = progressLabelKey(progress)
      return typeof translate === 'function' ? translate(key) : key
    }

    function isRoundRunning(round) {
      if (!isObject(round)) return false
      if (asString(round.status) === 'running') return true
      if (isObject(round.progress)) {
        var stage = normalizeStage(round.progress.stage)
        return stage !== '' && stage !== 'done' && stage !== 'cancelled'
      }
      return false
    }

    function cycleHasRunningRound(cycle) {
      var entries = sortRoundEntries(cycle && cycle.rounds)
      for (var i = 0; i < entries.length; i += 1) {
        if (isRoundRunning(entries[i].round)) return true
      }
      return false
    }

    function cyclesHaveRunningRound(cycles) {
      var list = asArray(cycles)
      for (var i = 0; i < list.length; i += 1) {
        if (isObject(list[i]) && cycleHasRunningRound(list[i])) return true
      }
      return false
    }

    function parseProgressPayload(payload) {
      var value = payload
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value)
        } catch (error) {
          return null
        }
      }
      if (!isObject(value)) return null
      if (value.ok === false) return null
      var cycleId = asString(value.cycleId)
      if (!cycleId) return null
      var stage = normalizeStage(value.stage)
      var done = value.done === true || stage === 'done' || stage === 'cancelled'
      return {
        cycleId: cycleId,
        round: firstNumber([value.round]),
        stage: stage || 'unknown',
        updatedAt: firstNumber([value.updatedAt]),
        detail: asString(value.detail),
        done: done,
        cancelled: stage === 'cancelled'
      }
    }

    /* ---- cycle / round rail badges ------------------------------------- */

    function profileOf(round, cycle) {
      if (isObject(round)) {
        var direct = asString(round.profile)
        if (direct) return direct
        var scored = isObject(round.score) ? asString(round.score.profile) : ''
        if (scored) return scored
      }
      if (isObject(cycle)) return asString(cycle.profile)
      return ''
    }

    function profileKey(profile) {
      var value = asString(profile).toLowerCase()
      return PROFILE_IDS.indexOf(value) >= 0 ? 'profile.' + value : ''
    }

    function statusBadge(cycle) {
      var entries = sortRoundEntries(cycle && cycle.rounds)
      var latest = latestRoundEntry(entries)
      var info = latest ? normalizeGate(cycle, latest.round) : null
      var status = asString(cycle && cycle.status) === 'passed' ? 'passed' : 'reviewing'
      return {
        status: status,
        labelKey: status === 'passed' ? 'cycles.status.passed' : 'cycles.status.reviewing',
        tone: status,
        rounds: entries.length,
        latestRound: latest ? latest.number : null,
        score: info ? info.score : null,
        gatePassed: info ? info.passed : null,
        running: latest ? isRoundRunning(latest.round) : false,
        profile: profileOf(latest ? latest.round : null, cycle),
        reopenCount: firstNumberOr([cycle && cycle.reopenCount], 0),
        reopenedFrom: firstNumber([cycle && cycle.reopenedFrom]),
        updatedAt: cycleUpdatedAt(cycle)
      }
    }

    /* ---- judge / session / disagreement -------------------------------- */

    function judgesOf(round) {
      var result = []
      var rawJudges = asArray(round && round.judges)
      for (var i = 0; i < rawJudges.length; i += 1) {
        var raw = rawJudges[i]
        if (!isObject(raw)) continue
        result.push({
          sessionId: asString(raw.sessionId),
          score: firstNumber([raw.score, raw.aggregateScore]),
          verdict: asString(raw.verdict)
        })
      }
      if (result.length === 0) {
        var ids = asArray(round && round.judgeSessionIds)
        for (var j = 0; j < ids.length; j += 1) {
          var id = asString(ids[j])
          if (id) result.push({ sessionId: id, score: null, verdict: '' })
        }
      }
      return result
    }

    function judgeSamplesOf(round) {
      var judges = judgesOf(round)
      if (judges.length > 0) return judges.length
      var cost = isObject(round && round.cost) ? round.cost : null
      return firstNumber([cost && cost.judgeSamples])
    }

    function disagreementOf(round) {
      var score = isObject(round && round.score) ? round.score : null
      var declared = null
      if (isObject(score && score.disagreement)) {
        declared = firstNumber([score.disagreement.scoreSpread, score.disagreement.spread, score.disagreement.value])
      } else {
        declared = firstNumber([score && score.disagreement])
      }
      if (declared !== null) return declared
      var judges = judgesOf(round)
      var scores = []
      for (var i = 0; i < judges.length; i += 1) {
        if (judges[i].score !== null) scores.push(judges[i].score)
      }
      if (scores.length < 2) return null
      var min = Math.min.apply(null, scores)
      var max = Math.max.apply(null, scores)
      return Math.round((max - min) * 10) / 10
    }

    function sessionIdsOf(round) {
      var attackerSessionId = asString(round && round.attackerSessionId)
      var judges = judgesOf(round)
      var judgeSessionIds = []
      for (var i = 0; i < judges.length; i += 1) {
        if (judges[i].sessionId) judgeSessionIds.push(judges[i].sessionId)
      }
      if (judgeSessionIds.length === 0) {
        judgeSessionIds = asArray(round && round.judgeSessionIds).map(asString).filter(Boolean)
      }
      return { attackerSessionId: attackerSessionId, judgeSessionIds: dedupeStrings(judgeSessionIds) }
    }

    /* ---- noise / cost / incremental ------------------------------------ */

    function noiseInfo(round) {
      var noise = isObject(round && round.noise) ? round.noise : null
      if (!noise) {
        return { hasData: false, rawFindings: null, dedupedFindings: null, suppressedCount: null, knownRepeats: null, suppressed: [] }
      }
      var suppressedRaw = asArray(noise.suppressed)
      var suppressed = []
      for (var i = 0; i < suppressedRaw.length; i += 1) {
        if (!isObject(suppressedRaw[i])) continue
        suppressed.push({
          title: asString(suppressedRaw[i].title) || asString(suppressedRaw[i].key) || '',
          reason: asString(suppressedRaw[i].reason)
        })
      }
      return {
        hasData: true,
        rawFindings: firstNumber([noise.rawFindings]),
        dedupedFindings: firstNumber([noise.dedupedFindings]),
        suppressedCount: firstNumberOr([noise.suppressedCount], suppressed.length),
        knownRepeats: firstNumber([noise.knownRepeats]),
        suppressed: suppressed
      }
    }

    function costInfo(round) {
      var cost = isObject(round && round.cost) ? round.cost : null
      var timings = isObject(round && round.timings) ? round.timings : null
      var evidenceMs = firstNumber([cost && cost.evidenceMs, timings && timings.evidenceMs, timings && timings.shotsMs])
      var attackMs = firstNumber([cost && cost.attackMs, timings && timings.attackMs])
      var judgeMs = firstNumber([cost && cost.judgeMs, timings && timings.judgeMs])
      var totalMs = firstNumber([cost && cost.totalMs])
      if (totalMs === null) {
        var parts = [evidenceMs, attackMs, judgeMs]
        var sum = 0
        var any = false
        for (var i = 0; i < parts.length; i += 1) {
          if (parts[i] !== null) {
            sum += parts[i]
            any = true
          }
        }
        if (any) totalMs = sum
      }
      var artifactCount = firstNumber([cost && cost.artifactCount])
      if (artifactCount === null) {
        var cards = evidenceCards(round)
        artifactCount = 0
        for (var j = 0; j < cards.length; j += 1) artifactCount += cards[j].artifactCount
      }
      return {
        hasData: cost !== null || timings !== null,
        totalMs: totalMs,
        evidenceMs: evidenceMs,
        attackMs: attackMs,
        judgeMs: judgeMs,
        promptChars: firstNumber([cost && cost.promptChars]),
        judgePromptChars: firstNumber([cost && cost.judgePromptChars]),
        judgeSamples: judgeSamplesOf(round),
        artifactCount: artifactCount
      }
    }

    function incrementalModeKey(value) {
      var mode = asString(value).toLowerCase()
      if (mode === 'incremental') return 'overview.incremental.modeValue.incremental'
      if (mode === 'reopen') return 'overview.incremental.modeValue.reopen'
      if (mode === 'full') return 'overview.incremental.modeValue.full'
      return ''
    }

    function incrementalInfo(round, cycle) {
      var raw = null
      if (isObject(round) && isObject(round.incremental)) raw = round.incremental
      else if (isObject(cycle) && isObject(cycle.incremental)) raw = cycle.incremental
      if (!raw) {
        return {
          hasData: false,
          mode: '',
          modeKey: '',
          baseRound: null,
          baseCycleId: '',
          unchangedCount: null,
          changedFiles: [],
          addedFiles: [],
          removedFiles: [],
          truncated: false,
          fullReview: false
        }
      }
      var mode = asString(raw.mode)
      return {
        hasData: true,
        mode: mode,
        modeKey: incrementalModeKey(mode),
        baseRound: firstNumber([raw.baseRound]),
        baseCycleId: asString(raw.baseCycleId),
        unchangedCount: firstNumber([raw.unchangedCount]),
        changedFiles: cleanStringList(raw.changedFiles),
        addedFiles: cleanStringList(raw.addedFiles),
        removedFiles: cleanStringList(raw.removedFiles),
        truncated: raw.truncated === true,
        fullReview: raw.fullReview === true
      }
    }

    /* ---- evidence / artifacts ------------------------------------------ */

    function safeFileName(value) {
      var text = asString(value)
      if (!text) return ''
      var normalized = text.replace(/\\/g, '/')
      var parts = normalized.split('/')
      var name = parts[parts.length - 1] || ''
      name = name.replace(/[<>:"|?*\u0000-\u001f]/g, '_')
      if (name === '.' || name === '..') return ''
      return name.slice(0, 120)
    }

    function shortSha(value) {
      var sha = asString(value)
      if (!sha) return ''
      return sha.length > 10 ? sha.slice(0, 10) + '...' : sha
    }

    function artifactKindKey(value) {
      var kind = asString(value).toLowerCase()
      if (EVIDENCE_KINDS.indexOf(kind) >= 0) return 'evidence.kind.' + kind
      if (kind === 'text' || kind === 'log' || kind === 'json' || kind === 'console' || kind === 'network' || kind === 'metrics') {
        return 'evidence.type.' + kind
      }
      return 'evidence.type.file'
    }

    function artifactLabel(artifact) {
      if (!isObject(artifact)) return ''
      var step = asString(artifact.stepName)
      if (step) return step
      var file = safeFileName(artifact.file)
      if (file) return file
      return asString(artifact.kind)
    }

    function normalizeArtifact(raw) {
      if (!isObject(raw)) return null
      var file = safeFileName(raw.file)
      if (!file) return null
      return {
        file: file,
        width: firstNumberOr([raw.width], 0),
        height: firstNumberOr([raw.height], 0),
        kind: asString(raw.kind),
        stepName: asString(raw.stepName),
        sha256: asString(raw.sha256),
        bytes: firstNumberOr([raw.bytes], 0)
      }
    }

    function evidenceKind(value) {
      var kind = asString(value).toLowerCase()
      return EVIDENCE_KINDS.indexOf(kind) >= 0 ? kind : 'screenshot'
    }

    function evidenceKindKey(value) {
      return 'evidence.kind.' + evidenceKind(value)
    }

    function isImageArtifact(artifact) {
      if (!isObject(artifact)) return false
      var kind = asString(artifact.kind).toLowerCase()
      if (kind === 'screenshot' || kind === 'image' || kind === 'png' || kind === 'jpeg' || kind === 'webp') return true
      return /\.(png|jpe?g|webp|gif|bmp)$/i.test(asString(artifact.file))
    }

    function isTextArtifact(artifact) {
      if (!isObject(artifact) || isImageArtifact(artifact)) return false
      var kind = asString(artifact.kind).toLowerCase()
      if (kind === 'text' || kind === 'log' || kind === 'json' || kind === 'console' || kind === 'network' || kind === 'metrics') return true
      return /\.(txt|log|json|jsonl|md|csv)$/i.test(asString(artifact.file))
    }

    /** One card per evidence item; legacy rounds fall back to their four shots. */
    function evidenceCards(round) {
      var rawCards = asArray(round && round.evidence)
      var cards = []
      for (var i = 0; i < rawCards.length; i += 1) {
        var card = rawCards[i]
        if (!isObject(card)) continue
        var artifacts = []
        var rawArtifacts = asArray(card.artifacts)
        for (var j = 0; j < rawArtifacts.length; j += 1) {
          var artifact = normalizeArtifact(rawArtifacts[j])
          if (artifact !== null) artifacts.push(artifact)
        }
        cards.push({
          index: firstNumberOr([card.index], i),
          name: asString(card.name),
          kind: evidenceKind(card.kind),
          artifactCount: firstNumberOr([card.artifactCount], artifacts.length),
          consoleErrors: firstNumberOr([card.consoleErrors], 0),
          networkFailures: firstNumberOr([card.networkFailures], 0),
          perfFps: firstNumber([card.perfFps]),
          artifacts: artifacts
        })
      }
      if (cards.length > 0) return cards
      var shots = asArray(round && round.shots)
      for (var k = 0; k < shots.length; k += 1) {
        if (!isObject(shots[k])) continue
        var file = safeFileName(shots[k].file)
        if (!file) continue
        cards.push({
          index: k,
          name: file,
          kind: 'screenshot',
          artifactCount: 1,
          consoleErrors: 0,
          networkFailures: 0,
          perfFps: null,
          artifacts: [{
            file: file,
            width: firstNumberOr([shots[k].width], 0),
            height: firstNumberOr([shots[k].height], 0),
            kind: 'screenshot',
            stepName: '',
            sha256: asString(shots[k].sha256),
            bytes: firstNumberOr([shots[k].bytes], 0)
          }]
        })
      }
      return cards
    }

    function evidenceKindCounts(round) {
      var cards = evidenceCards(round)
      var order = []
      var counts = {}
      for (var i = 0; i < cards.length; i += 1) {
        var kind = cards[i].kind
        if (counts[kind] === undefined) {
          counts[kind] = 0
          order.push(kind)
        }
        counts[kind] += 1
      }
      var result = []
      for (var j = 0; j < order.length; j += 1) result.push({ kind: order[j], count: counts[order[j]] })
      return result
    }

    function extraArtifactsOf(card) {
      return asArray(card && card.artifacts).slice(1)
    }

    /* ---- URL builders --------------------------------------------------- */

    function shotUrl(cycleId, file) {
      return SHOT_URL + '?cycleId=' + encodeURIComponent(asString(cycleId)) + '&file=' + encodeURIComponent(safeFileName(file))
    }

    function artifactUrl(cycleId, file) {
      return ARTIFACT_URL + '?cycleId=' + encodeURIComponent(asString(cycleId)) + '&file=' + encodeURIComponent(safeFileName(file))
    }

    function diffUrl(cycleId) {
      return DIFF_URL + '?cycleId=' + encodeURIComponent(asString(cycleId))
    }

    function progressUrl(cycleId) {
      return PROGRESS_URL + '?cycleId=' + encodeURIComponent(asString(cycleId))
    }

    function cancelUrl(cycleId) {
      return CANCEL_URL + '?cycleId=' + encodeURIComponent(asString(cycleId))
    }

    function exportUrl(cycleId, format) {
      var kind = asString(format).toLowerCase() === 'json' ? 'json' : 'md'
      return EXPORT_URL + '?cycleId=' + encodeURIComponent(asString(cycleId)) + '&format=' + kind
    }

    /** Prefer the legacy shot route when the artifact is one of the four shots. */
    function artifactPreviewUrl(cycleId, file, shotFiles) {
      var name = safeFileName(file)
      var list = asArray(shotFiles)
      for (var i = 0; i < list.length; i += 1) {
        if (safeFileName(list[i]) === name) return shotUrl(cycleId, name)
      }
      if (/^r\d{1,4}-s\d{1,4}-[A-Za-z0-9._-]*\.png$/i.test(name)) return shotUrl(cycleId, name)
      return artifactUrl(cycleId, name)
    }

    function buildShotSrc(cycle, shot) {
      return shotUrl(asString(cycle && cycle.id), asString(shot && shot.file))
    }

    /* ---- round diff ----------------------------------------------------- */

    function normalizeDiffStatus(value) {
      var status = asString(value).toLowerCase()
      return DIFF_STATUSES.indexOf(status) >= 0 ? status : ''
    }

    function normalizeDiff(payload) {
      if (!isObject(payload)) return null
      var rawRounds = asArray(payload.rounds)
      var rounds = []
      for (var i = 0; i < rawRounds.length; i += 1) {
        if (!isObject(rawRounds[i])) continue
        rounds.push({
          n: roundNumberOf(rawRounds[i], i),
          score: firstNumber([rawRounds[i].score]),
          passed: rawRounds[i].passed === true
        })
      }
      var rawChanges = asArray(payload.changes)
      var changes = []
      for (var j = 0; j < rawChanges.length; j += 1) {
        var raw = rawChanges[j]
        if (!isObject(raw)) continue
        changes.push({
          key: asString(raw.key) || ('change-' + j),
          title: asString(raw.title),
          severity: normalizeSeverity(raw.severity),
          status: normalizeDiffStatus(raw.status),
          firstRound: firstNumber([raw.firstRound]),
          lastRound: firstNumber([raw.lastRound])
        })
      }
      return {
        ok: payload.ok !== false,
        cycleId: asString(payload.cycleId),
        rounds: rounds,
        changes: changes
      }
    }

    function diffBadge(change) {
      var status = normalizeDiffStatus(isObject(change) ? change.status : change)
      if (!status) return null
      var keys = {
        'new': 'diff.status.new',
        'repeat': 'diff.status.repeat',
        'fixed': 'diff.status.fixed',
        'severity-changed': 'diff.status.severityChanged'
      }
      return { status: status, labelKey: keys[status], tone: status === 'severity-changed' ? 'changed' : status }
    }

    function diffChangeMap(diff) {
      var map = {}
      var changes = asArray(diff && diff.changes)
      for (var i = 0; i < changes.length; i += 1) {
        var change = changes[i]
        if (!isObject(change)) continue
        var key = normalizeTitle(change.title)
        if (!key) continue
        if (map[key] === undefined || (change.lastRound !== null && (map[key].lastRound === null || change.lastRound >= map[key].lastRound))) {
          map[key] = change
        }
      }
      return map
    }

    /** Per-round badge counts derived from the cycle diff payload. */
    function diffSummaryForRound(diff, roundNumber) {
      var summary = { new: 0, repeat: 0, fixed: 0, severityChanged: 0, total: 0, hasData: isObject(diff) }
      if (!isObject(diff)) return summary
      var changes = asArray(diff.changes)
      for (var i = 0; i < changes.length; i += 1) {
        var change = changes[i]
        if (!isObject(change)) continue
        var status = normalizeDiffStatus(change.status)
        if (!status) continue
        var firstRound = firstNumber([change.firstRound])
        var lastRound = firstNumber([change.lastRound])
        if (status === 'fixed') {
          if (lastRound === null || roundNumber > lastRound) summary.fixed += 1
        } else if (lastRound === null ? (firstRound === null || roundNumber >= firstRound) : lastRound === roundNumber) {
          if (status === 'new') summary.new += 1
          else if (status === 'repeat') summary.repeat += 1
          else summary.severityChanged += 1
        }
      }
      summary.total = summary.new + summary.repeat + summary.fixed + summary.severityChanged
      return summary
    }

    /* ---- findings filters ----------------------------------------------- */

    function filterFindings(findings, query, severity) {
      var list = asArray(findings).filter(isObject)
      var text = normalizeTitle(query)
      var wanted = asString(severity).toUpperCase()
      var result = []
      for (var i = 0; i < list.length; i += 1) {
        var finding = list[i]
        if (wanted && wanted !== 'ALL' && normalizeSeverity(finding.severity) !== wanted) continue
        if (text) {
          var haystack = normalizeTitle([finding.title, finding.evidence, finding.attack, finding.impact, finding.fix].map(asString).join(' '))
          if (haystack.indexOf(text) < 0) continue
        }
        result.push(finding)
      }
      return result
    }

    function groupFindings(findings) {
      var groups = { BLOCKER: [], MAJOR: [], MINOR: [] }
      var list = asArray(findings)
      for (var i = 0; i < list.length; i += 1) {
        if (!isObject(list[i])) continue
        groups[normalizeSeverity(list[i].severity)].push(list[i])
      }
      return groups
    }
    /* PURE-END */

    // Locale-bound wrappers over the pure formatters, keys and labels above.
    function dash() {
      return t('common.dash')
    }

    function formatScore(value) {
      return formatScoreText(value, t('common.dash'))
    }

    function formatCount(value) {
      return formatCountText(value, t('common.dash'))
    }

    function formatDurationLabel(value) {
      var text = formatDuration(value)
      return text || t('common.dash')
    }

    function formatBytes(value) {
      var number = toFiniteNumber(value)
      if (number === null || number < 0) return ''
      if (number < 1024) return t('shots.bytes', { bytes: String(Math.round(number)) })
      return t('shots.kilobytes', { value: (number / 1024).toFixed(1) })
    }

    var timestampFormatter = null
    try {
      if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
        timestampFormatter = new Intl.DateTimeFormat(undefined, {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        })
      }
    } catch (error) {
      timestampFormatter = null
    }

    function formatTimestamp(value) {
      var number = toFiniteNumber(value)
      if (number === null || number <= 0) return t('meta.unknown')
      var date = new Date(number)
      if (isNaN(date.getTime())) return t('meta.unknown')
      if (timestampFormatter) {
        try {
          return timestampFormatter.format(date)
        } catch (error) {
          /* fall through to the built-in formatter */
        }
      }
      try {
        return date.toLocaleString()
      } catch (error) {
        return t('meta.unknown')
      }
    }

    function verdictLabel(verdict) {
      var key = verdictKey(verdict)
      if (key) return t(key)
      return asString(verdict) || t('common.dash')
    }

    function profileLabel(profile) {
      var key = profileKey(profile)
      if (key) return t(key)
      return asString(profile) || t('common.dash')
    }

    function progressLabelFor(progress) {
      return t(progressLabelKey(progress))
    }

    // ---------------------------------------------------------------------
    // Styles: one tag, class prefix .rtc-, theme alias variables only.
    // ---------------------------------------------------------------------
    var CSS = `
.rtc-root{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;height:100%;min-height:0;overflow-y:auto;padding:18px 20px 24px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;font-family:var(--dsw-font-family,inherit)}
.rtc-root *,.rtc-root *::before,.rtc-root *::after{box-sizing:border-box}
.rtc-root button{font-family:inherit}
.rtc-header{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap}
.rtc-heading{display:flex;flex-direction:column;gap:4px;flex:1 1 340px;min-width:0}
.rtc-title{margin:0;font-size:18px;font-weight:700;line-height:1.35;overflow-wrap:anywhere}
.rtc-subtitle{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rtc-headerTools{display:flex;align-items:center;gap:8px;flex:none}
.rtc-status{display:inline-flex;align-items:center;gap:8px;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}
.rtc-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-secondary)}
.rtc-dot[data-state=online]{background:var(--dsw-alias-state-success-primary)}
.rtc-dot[data-state=offline]{background:var(--dsw-alias-state-error-primary)}
.rtc-dot[data-state=loading]{background:var(--dsw-alias-state-warn-primary)}
.rtc-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer;transition:background-color .12s,border-color .12s}
.rtc-btn:hover{background:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-border-l1)}
.rtc-btn:focus-visible,.rtc-roundChip:focus-visible,.rtc-cycleBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.rtc-alert{display:flex;align-items:flex-start;gap:12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:12px;background:var(--dsw-alias-bg-layer-2);padding:12px 14px}
.rtc-alertMain{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}
.rtc-alertTitle{margin:0;font-size:13px;font-weight:700;color:var(--dsw-alias-state-error-primary)}
.rtc-alertText{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rtc-alertDetail{margin:0;font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rtc-layout{display:grid;grid-template-columns:minmax(200px,260px) minmax(0,1fr);gap:14px;align-items:start}
.rtc-main{display:flex;flex-direction:column;gap:14px;min-width:0}
.rtc-card{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);padding:14px;min-width:0}
.rtc-sectionTitle{margin:0;font-size:13.5px;font-weight:700;line-height:1.4;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.rtc-cycles{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:10px}
.rtc-cycleList{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.rtc-cycleBtn{appearance:none;display:flex;flex-direction:column;gap:2px;width:100%;padding:8px 10px;border:1px solid transparent;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer}
.rtc-cycleBtn:hover{background:var(--dsw-alias-bg-layer-3)}
.rtc-cycleBtn[aria-current=true]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-3)}
.rtc-cycleTitle{margin:0;font-size:13px;font-weight:600;overflow-wrap:anywhere}
.rtc-cycleMeta{margin:0;font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rtc-cycleStatus{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.rtc-cycleStatus[data-state=passed]{color:var(--dsw-alias-state-success-primary)}
.rtc-cycleStatus[data-state=reviewing]{color:var(--dsw-alias-state-warn-primary)}
.rtc-gate[data-passed=true]{border-color:var(--dsw-alias-state-success-primary)}
.rtc-gate[data-passed=false]{border-color:var(--dsw-alias-state-error-primary)}
.rtc-gateTop{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.rtc-gateScoreBox{display:flex;flex-direction:column;gap:4px;min-width:0}
.rtc-gateScore{display:flex;align-items:baseline;gap:8px}
.rtc-gateNumber{font-size:38px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums}
.rtc-gateMax{font-size:15px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.rtc-gateRequired{font-size:12px;color:var(--dsw-alias-label-secondary)}
.rtc-gateChecks{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:flex-end}
.rtc-check{display:inline-flex;flex-direction:column;gap:1px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);padding:4px 10px;min-width:0}
.rtc-check[data-ok=true]{border-color:var(--dsw-alias-state-success-primary)}
.rtc-check[data-ok=false]{border-color:var(--dsw-alias-state-error-primary)}
.rtc-checkLabel{font-size:11px;color:var(--dsw-alias-label-secondary)}
.rtc-checkValue{font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.rtc-checkHint{font-size:11px;color:var(--dsw-alias-label-secondary)}
.rtc-progress{position:relative;height:12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-3)}
.rtc-progressFill{position:absolute;top:0;bottom:0;left:0;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .2s}
.rtc-gate[data-passed=true] .rtc-progressFill{background:var(--dsw-alias-state-success-primary)}
.rtc-gate[data-passed=false] .rtc-progressFill{background:var(--dsw-alias-state-warn-primary)}
.rtc-progressMark{position:absolute;top:-5px;bottom:-5px;width:2px;border-radius:2px;background:var(--dsw-alias-state-error-primary)}
.rtc-progressLegend{display:flex;justify-content:space-between;gap:12px;font-size:11px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
.rtc-gateBanner{display:flex;flex-direction:column;gap:4px;border:1px solid;border-radius:12px;padding:10px 12px;background:var(--dsw-alias-bg-layer-3)}
.rtc-gateBanner[data-passed=true]{border-color:var(--dsw-alias-state-success-primary)}
.rtc-gateBanner[data-passed=false]{border-color:var(--dsw-alias-state-error-primary)}
.rtc-gateBannerTitle{margin:0;font-size:15px;font-weight:700;line-height:1.4;overflow-wrap:anywhere}
.rtc-gateBanner[data-passed=true] .rtc-gateBannerTitle{color:var(--dsw-alias-state-success-primary)}
.rtc-gateBanner[data-passed=false] .rtc-gateBannerTitle{color:var(--dsw-alias-state-error-primary)}
.rtc-gateBannerText{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rtc-subBlock{display:flex;flex-direction:column;gap:6px;min-width:0}
.rtc-subTitle{margin:0;font-size:12px;font-weight:700;color:var(--dsw-alias-label-secondary)}
.rtc-list{display:flex;flex-direction:column;gap:4px;margin:0;padding-left:18px;overflow-wrap:anywhere}
.rtc-list li{overflow-wrap:anywhere}
.rtc-reasons{color:var(--dsw-alias-state-error-primary)}
.rtc-timeline .rtc-rounds{display:flex;align-items:center;gap:8px;overflow-x:auto;padding-bottom:2px}
.rtc-roundChip{appearance:none;display:inline-flex;align-items:center;gap:6px;flex:none;height:30px;padding:0 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:600;cursor:pointer;font-variant-numeric:tabular-nums}
.rtc-roundChip:hover{background:var(--dsw-alias-bg-layer-3)}
.rtc-roundChip[aria-current=true]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-3)}
.rtc-roundChip[data-tone=passed]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.rtc-roundChip[data-tone=held]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.rtc-roundChip[data-tone=running]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.rtc-roundChip[data-tone=failed]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.rtc-roundScore{font-weight:700}
.rtc-group{display:flex;flex-direction:column;gap:8px}
.rtc-groupHeader{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rtc-sev{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:12px;border:1px solid;font-size:11px;font-weight:700}
.rtc-sev[data-sev=BLOCKER]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.rtc-sev[data-sev=MAJOR]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.rtc-sev[data-sev=MINOR]{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.rtc-count{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.rtc-finding{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px;min-width:0}
.rtc-findingHeader{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap}
.rtc-findingTitle{margin:0;font-size:13.5px;font-weight:700;line-height:1.4;overflow-wrap:anywhere;flex:1 1 200px;min-width:0}
.rtc-badges{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}
.rtc-chip{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rtc-chip[data-judge=true]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.rtc-chip[data-judge=false]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.rtc-fields{display:flex;flex-direction:column;gap:6px}
.rtc-field{display:flex;flex-direction:column;gap:1px}
.rtc-fieldLabel{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.rtc-fieldValue{margin:0;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.rtc-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
.rtc-break{overflow-wrap:anywhere;word-break:break-word}
.rtc-tableWrap{overflow-x:auto}
.rtc-table{width:100%;border-collapse:collapse;font-size:12.5px}
.rtc-table th,.rtc-table td{border-bottom:1px solid var(--dsw-alias-border-l1);padding:7px 8px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
.rtc-table th{font-size:11px;font-weight:700;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rtc-table td[data-num=true]{font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--dsw-alias-state-error-primary);font-weight:700}
.rtc-table tr:last-child td{border-bottom:none}
.rtc-judgeHead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.rtc-judgeScore{font-size:30px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums}
.rtc-judgeMeta{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0;overflow-wrap:anywhere}
.rtc-verdict{display:inline-flex;align-items:center;height:22px;padding:0 10px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:700}
.rtc-verdict[data-tone=pass]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.rtc-verdict[data-tone=hold]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.rtc-verdict[data-tone=block]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.rtc-shots{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.rtc-shot{display:flex;flex-direction:column;margin:0;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;min-width:0}
.rtc-shotImg{display:block;width:100%;height:auto;background:var(--dsw-alias-bg-layer-3)}
.rtc-shotFallback{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:150px;padding:16px;text-align:center;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.rtc-shotFallbackTitle{font-size:12.5px;font-weight:700;overflow-wrap:anywhere}
.rtc-shotFallbackMeta,.rtc-shotFallbackHint{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rtc-shotMeta{display:flex;flex-wrap:wrap;gap:2px 12px;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11.5px;min-width:0}
.rtc-stability{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.rtc-stabilityCard{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px;min-width:0}
.rtc-unverifiedList{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.rtc-unverifiedItem{display:flex;flex-direction:column;gap:2px;border-left:2px solid var(--dsw-alias-state-warn-primary);padding-left:8px;overflow-wrap:anywhere}
.rtc-unverifiedItemTitle{font-size:12.5px;font-weight:600;overflow-wrap:anywhere}
.rtc-unverifiedItemNeeds{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rtc-footer{display:flex;flex-wrap:wrap;gap:4px 20px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.rtc-footerItem{display:inline-flex;align-items:baseline;gap:6px;min-width:0;overflow-wrap:anywhere}
.rtc-footerLabel{color:var(--dsw-alias-label-secondary)}
.rtc-footerValue{color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.rtc-empty{display:flex;flex-direction:column;gap:12px;align-items:flex-start;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:24px}
.rtc-emptyTitle{margin:0;font-size:16px;font-weight:700;overflow-wrap:anywhere}
.rtc-emptyText{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;max-width:70ch}
.rtc-steps{display:flex;flex-direction:column;gap:6px;margin:0;padding-left:20px;font-size:12.5px;color:var(--dsw-alias-label-primary)}
.rtc-steps li{overflow-wrap:anywhere}
.rtc-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:56px 16px;color:var(--dsw-alias-label-secondary)}
.rtc-spinner{width:24px;height:24px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:rtc-spin .9s linear infinite;flex:none}
.rtc-loadingText{margin:0;font-size:13px;overflow-wrap:anywhere}
.rtc-loadingHint{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rtc-srOnly{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
/* v1.3 read-only ops board */
.rtc-layout{grid-template-columns:minmax(240px,300px) minmax(0,1fr)}
.rtc-rowBetween{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap;min-width:0}
.rtc-cyclesHeader{display:flex;flex-direction:column;gap:8px;min-width:0}
.rtc-searchWrap{position:relative;display:flex;align-items:center;min-width:0}
.rtc-input{box-sizing:border-box;width:100%;height:30px;padding:0 30px 0 10px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px}
.rtc-input::placeholder{color:var(--dsw-alias-label-secondary)}
.rtc-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.rtc-searchClear{position:absolute;right:4px;top:50%;transform:translateY(-50%);appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;width:24px;height:24px;border-radius:12px;font-size:14px;line-height:1;padding:0}
.rtc-searchClear:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.rtc-searchClear:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.rtc-segmented{display:inline-flex;flex-wrap:wrap;gap:4px}
.rtc-segment{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:12px;height:26px;padding:0 10px;font-family:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}
.rtc-segment[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3)}
.rtc-segment:hover{background:var(--dsw-alias-bg-layer-3)}
.rtc-segment:focus-visible,.rtc-select:focus-visible,.rtc-linkBtn:focus-visible,.rtc-tab:focus-visible,.rtc-artifactLink:focus-visible,.rtc-copyBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.rtc-selectLabel{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);min-width:0}
.rtc-select{height:26px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;padding:0 6px;max-width:100%}
.rtc-cycleBadges{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}
.rtc-miniBadge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rtc-miniBadge[data-tone=passed]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.rtc-miniBadge[data-tone=held]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.rtc-miniBadge[data-tone=running]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.rtc-miniBadge[data-tone=score]{color:var(--dsw-alias-label-primary);font-weight:700}
.rtc-cycleUpdated{font-size:10.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rtc-tabBar{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:6px}
.rtc-tab{appearance:none;border:1px solid transparent;border-radius:12px;background:transparent;color:var(--dsw-alias-label-secondary);height:30px;padding:0 12px;font-family:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap}
.rtc-tab:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.rtc-tab[aria-selected=true]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}
.rtc-tabPanel{display:flex;flex-direction:column;gap:14px;min-width:0}
.rtc-tabStack{display:flex;flex-direction:column;gap:14px;min-width:0}
.rtc-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.rtc-toolbar>.rtc-searchWrap{flex:1 1 220px;min-width:0}
.rtc-metricGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;min-width:0}
.rtc-metric{display:flex;flex-direction:column;gap:1px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:8px 10px;min-width:0}
.rtc-metricLabel{font-size:10.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rtc-metricValue{font-size:13px;font-weight:700;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.rtc-metric[data-tone=passed] .rtc-metricValue{color:var(--dsw-alias-state-success-primary)}
.rtc-metric[data-tone=held] .rtc-metricValue{color:var(--dsw-alias-state-error-primary)}
.rtc-metric[data-tone=running] .rtc-metricValue{color:var(--dsw-alias-state-warn-primary)}
.rtc-metricGrid--compact{grid-template-columns:repeat(auto-fill,minmax(110px,1fr))}
.rtc-note{font-size:11.5px}
.rtc-chips{display:flex;flex-wrap:wrap;gap:6px}
.rtc-stageBar{position:relative;height:12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-3);overflow:hidden}
.rtc-stageFill{position:absolute;top:0;bottom:0;left:0;background:var(--dsw-alias-brand-primary);border-radius:999px;transition:width .2s}
.rtc-stageFill[data-stage=done]{background:var(--dsw-alias-state-success-primary)}
.rtc-stageFill[data-stage=cancelled]{background:var(--dsw-alias-state-warn-primary)}
.rtc-stageMarkers{position:absolute;top:0;bottom:0;left:0;right:0;display:flex;justify-content:space-between;padding:0 2px;pointer-events:none}
.rtc-stageMarker{width:1px;background:var(--dsw-alias-border-l2)}
.rtc-stageLabels{display:flex;justify-content:space-between;gap:4px;font-size:10px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
.rtc-stageLabel{flex:1 1 auto;text-align:center;min-width:0;overflow-wrap:anywhere}
.rtc-progressState{display:flex;flex-wrap:wrap;gap:2px 10px;margin:0;font-size:12px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.rtc-cancelState{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rtc-cancelState[data-error=true]{color:var(--dsw-alias-state-error-primary)}
.rtc-btnDanger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.rtc-btnDanger:hover{background:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-state-error-primary)}
.rtc-btn:disabled{opacity:.55;cursor:default}
.rtc-linkBtn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;cursor:pointer;padding:2px 4px;border-radius:8px;text-decoration:underline;white-space:nowrap}
.rtc-linkBtn[aria-current=true]{font-weight:700}
.rtc-num{font-variant-numeric:tabular-nums;white-space:nowrap}
.rtc-statusTag{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rtc-statusTag[data-tone=passed]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.rtc-statusTag[data-tone=held]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.rtc-statusTag[data-tone=running]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.rtc-statusTag[data-tone=failed]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.rtc-table tr[data-selected=true] td{background:var(--dsw-alias-bg-layer-3)}
.rtc-roundPicker{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.rtc-roundPicker .rtc-roundChip{height:26px;padding:0 10px;font-size:11.5px}
.rtc-evidenceGrid{display:flex;flex-direction:column;gap:12px;min-width:0}
.rtc-evidenceCard{gap:10px}
.rtc-evidenceStats{display:flex;flex-wrap:wrap;gap:6px}
.rtc-artifactList{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;min-width:0}
.rtc-artifactLink{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);text-decoration:none;min-width:0}
.rtc-artifactLink:hover{background:var(--dsw-alias-bg-layer-3)}
.rtc-artifactMeta{display:flex;flex-wrap:wrap;gap:2px 10px;font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rtc-artifactName{font-size:12px;font-weight:600;overflow-wrap:anywhere}
.rtc-artifactPreview{display:block;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-3);min-width:0}
.rtc-artifactPreview img{display:block;width:100%;height:auto;max-height:320px;object-fit:contain;background:var(--dsw-alias-bg-layer-3)}
.rtc-artifactPreviewFallback{display:flex;flex-direction:column;gap:4px;padding:16px;color:var(--dsw-alias-state-error-primary);font-size:12px;overflow-wrap:anywhere}
.rtc-sessionValue{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.rtc-copyBtn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);border-radius:12px;height:22px;padding:0 8px;font:inherit;font-size:10.5px;cursor:pointer;white-space:nowrap}
.rtc-copyBtn:hover{color:var(--dsw-alias-label-primary)}
.rtc-copyState{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.rtc-copyState[data-error=true]{color:var(--dsw-alias-state-error-primary)}
.rtc-exportLinks{display:flex;flex-wrap:wrap;gap:8px}
.rtc-exportLinks .rtc-btn{text-decoration:none}
.rtc-diffBadges{display:flex;flex-wrap:wrap;gap:4px}
.rtc-diffBadge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:12px;border:1px solid;font-size:10.5px;white-space:nowrap}
.rtc-diffBadge[data-tone=new]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.rtc-diffBadge[data-tone=repeat]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.rtc-diffBadge[data-tone=fixed]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.rtc-diffBadge[data-tone=changed]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.rtc-sectionStack{display:flex;flex-direction:column;gap:14px;min-width:0}
.rtc-titleSmall{font-size:16px}
.rtc-cycleHeader{gap:8px}
@keyframes rtc-spin{to{transform:rotate(360deg)}}
@media (max-width:900px){.rtc-layout{grid-template-columns:minmax(0,1fr)}}
@media (max-width:640px){.rtc-root{padding:12px 12px 18px}.rtc-shots{grid-template-columns:minmax(0,1fr)}.rtc-stability{grid-template-columns:minmax(0,1fr)}.rtc-gateNumber{font-size:32px}}
@media (prefers-reduced-motion:reduce){.rtc-spinner{animation:none}.rtc-progressFill{transition:none}}
`

    // The styles seat exists on hosts that inject it; everywhere else fall back
    // to one owned head tag (removed again on dispose). Guarded so a host
    // without document cannot break plugin activation.
    function insertCss(css) {
      try {
        if (typeof styles !== 'undefined' && styles && typeof styles.insert === 'function') {
          return styles.insert(css)
        }
      } catch (error) {
        /* fall through to the document fallback */
      }
      if (typeof document === 'undefined') return function noop() {}
      var attribute = 'data-plugin-css'
      var owner = '@local/dsh-redteam-console'
      try {
        var existing = document.querySelector('style[' + attribute + '="' + owner + '"]')
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
      } catch (error) {
        /* a missing head is handled by the createElement path below */
      }
      var tag = document.createElement('style')
      tag.setAttribute(attribute, owner)
      tag.textContent = css
      document.head.appendChild(tag)
      return function disposeCss() {
        if (tag.parentNode) tag.parentNode.removeChild(tag)
      }
    }

    // ---------------------------------------------------------------------
    // Small presentational helpers.
    // ---------------------------------------------------------------------
    function PanelIcon(props) {
      var size = 16
      if (props && typeof props.size === 'number' && isFinite(props.size) && props.size > 0) size = props.size
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false'
      },
        h('path', { d: 'M12 2.6 4.6 5.5v5.9c0 4.7 3.1 8.7 7.4 10.6 4.3-1.9 7.4-5.9 7.4-10.6V5.5L12 2.6Z' }),
        h('path', { d: 'M4.6 5.5 12 8.5l7.4-3' }),
        h('circle', { cx: 10.9, cy: 11, r: 2.4 }),
        h('path', { d: 'm12.8 12.9 2.9 2.9' })
      )
    }

    function fieldNode(labelKey, value, mono) {
      if (!value) return null
      return h('div', { className: 'rtc-field', key: 'field-' + labelKey },
        h('span', { className: 'rtc-fieldLabel' }, t(labelKey)),
        h('p', { className: 'rtc-fieldValue' + (mono ? ' rtc-mono' : '') }, value))
    }

    function CheckPill(props) {
      return h('span', { className: 'rtc-check', 'data-ok': props.ok ? 'true' : 'false' },
        h('span', { className: 'rtc-checkLabel' }, props.label),
        h('span', { className: 'rtc-checkValue' }, props.value),
        props.hint ? h('span', { className: 'rtc-checkHint' }, props.hint) : null)
    }

    function ErrorBar(props) {
      var error = isObject(props.error) ? props.error : null
      return h('div', { className: 'rtc-alert', role: 'alert' },
        h('div', { className: 'rtc-alertMain' },
          h('p', { className: 'rtc-alertTitle' }, t('error.title')),
          error && error.key ? h('p', { className: 'rtc-alertText' }, t(error.key, error.params || {})) : null,
          error && error.detail ? h('p', { className: 'rtc-alertDetail' }, t('error.detail') + error.detail) : null),
        h('button', { type: 'button', className: 'rtc-btn', onClick: props.onRetry, 'aria-label': t('status.retryAria') }, t('status.retry')))
    }

    function LoadingState() {
      return h('div', { className: 'rtc-loading', role: 'status', 'aria-live': 'polite' },
        h('div', { className: 'rtc-spinner', 'aria-hidden': 'true' }),
        h('p', { className: 'rtc-loadingText' }, t('loading.title')),
        h('p', { className: 'rtc-loadingHint' }, t('loading.hint')))
    }

    function EmptyState() {
      return h('section', { className: 'rtc-empty', 'aria-labelledby': 'rtc-empty-title' },
        h('h2', { id: 'rtc-empty-title', className: 'rtc-emptyTitle' }, t('empty.title')),
        h('p', { className: 'rtc-emptyText' }, t('empty.desc')),
        h('p', { className: 'rtc-emptyText' }, t('empty.reasonTitle')),
        h('ol', { className: 'rtc-steps' },
          h('li', null, t('empty.step1', { tool: 'adversarial_review_round' })),
          h('li', null, t('empty.step2')),
          h('li', null, t('empty.step3'))),
        h('p', { className: 'rtc-emptyText' }, t('empty.hint')))
    }

    function GateBanner(props) {
      var cycle = props.cycle
      var round = props.round
      var info = normalizeGate(cycle, round)
      var scoreText = info.score === null ? t('gate.missingScore') : formatScore(info.score)
      var fillPercent = info.score === null ? 0 : clamp(info.score, 0, 100)
      var markerPercent = clamp(info.requiredScore, 0, 100)
      var findingsOk = info.findings >= info.requiredFindings
      var shotsOk = info.shots >= info.requiredShots
      var hasRound = isObject(round)
      var running = info.status === 'running'

      if (!hasRound) {
        return h('section', { className: 'rtc-card rtc-gate', 'data-passed': 'false', 'aria-labelledby': 'rtc-gate-title' },
          h('h2', { id: 'rtc-gate-title', className: 'rtc-sectionTitle' }, t('gate.title')),
          h('p', { className: 'rtc-emptyText' }, t('gate.noRound')))
      }

      return h('section', { className: 'rtc-card rtc-gate', 'data-passed': info.passed ? 'true' : 'false', 'aria-labelledby': 'rtc-gate-title' },
        h('div', { className: 'rtc-gateTop' },
          h('div', { className: 'rtc-gateScoreBox' },
            h('h2', { id: 'rtc-gate-title', className: 'rtc-sectionTitle' }, t('gate.title')),
            h('div', {
              className: 'rtc-gateScore',
              'aria-label': t('gate.scoreAria', { score: scoreText, required: formatScore(info.requiredScore) })
            },
              h('span', { className: 'rtc-gateNumber' }, scoreText),
              h('span', { className: 'rtc-gateMax' }, t('gate.scoreOfTen'))),
            h('span', { className: 'rtc-gateRequired' }, t('gate.required', { score: formatScore(info.requiredScore) }))),
          h('div', { className: 'rtc-gateChecks' },
            h(CheckPill, {
              ok: findingsOk,
              label: t('gate.findings'),
              value: t('gate.findingsValue', { count: formatCount(info.findings), required: formatCount(info.requiredFindings) }),
              hint: info.supported > 0 ? t('gate.findingsSupported', { count: formatCount(info.supported) }) : ''
            }),
            h(CheckPill, {
              ok: shotsOk,
              label: t('gate.shots'),
              value: t('gate.shotsValue', { count: formatCount(info.shots), required: formatCount(info.requiredShots) }),
              hint: ''
            }),
            h(CheckPill, {
              ok: info.passed,
              label: t('gate.verdict'),
              value: info.verdict ? verdictLabel(info.verdict) : t('common.dash'),
              hint: ''
            }))),
        h('div', {
          className: 'rtc-progress',
          role: 'progressbar',
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': info.score === null ? 0 : clamp(info.score, 0, 100),
          'aria-valuetext': scoreText,
          'aria-label': t('gate.scoreAria', { score: scoreText, required: formatScore(info.requiredScore) })
        },
          h('div', { className: 'rtc-progressFill', style: { width: fillPercent + '%' } }),
          h('div', { className: 'rtc-progressMark', style: { left: markerPercent + '%' }, title: t('gate.markerAria', { score: formatScore(info.requiredScore) }), 'aria-hidden': 'true' })),
        h('div', { className: 'rtc-progressLegend' },
          h('span', null, t('rounds.title')),
          h('span', null, t('gate.required', { score: formatScore(info.requiredScore) }))),
        running
          ? h('div', { className: 'rtc-gateBanner', 'data-passed': 'false' },
              h('p', { className: 'rtc-gateBannerTitle' }, t('gate.failed')),
              h('p', { className: 'rtc-gateBannerText' }, t('gate.roundRunning', { round: formatCount(roundNumberOf(round, 0)) })))
          : (info.passed
              ? h('div', { className: 'rtc-gateBanner', 'data-passed': 'true' },
                  h('p', { className: 'rtc-gateBannerTitle' }, t('gate.passed')),
                  h('p', { className: 'rtc-gateBannerText' }, t('gate.passedHint')))
              : h('div', { className: 'rtc-gateBanner', 'data-passed': 'false' },
                  h('p', { className: 'rtc-gateBannerTitle' }, t('gate.failed')),
                  info.failReasons.length
                    ? h('div', { className: 'rtc-subBlock' },
                        h('h3', { className: 'rtc-subTitle' }, t('gate.failReasons')),
                        h('ul', { className: 'rtc-list rtc-reasons' }, info.failReasons.map(function renderReason(reason, index) {
                          return h('li', { key: 'reason-' + index }, reason)
                        })))
                    : null,
                  info.mustFix.length
                    ? h('div', { className: 'rtc-subBlock' },
                        h('h3', { className: 'rtc-subTitle' }, t('gate.mustFix')),
                        h('ul', { className: 'rtc-list rtc-reasons' }, info.mustFix.map(function renderMustFix(item, index) {
                          return h('li', { key: 'mustfix-' + index }, item)
                        })))
                    : null)))
    }

    function RoundTimeline(props) {
      if (props.entries.length === 0) return null
      return h('section', { className: 'rtc-card rtc-timeline', 'aria-labelledby': 'rtc-rounds-title' },
        h('h2', { id: 'rtc-rounds-title', className: 'rtc-sectionTitle' }, t('rounds.title')),
        h('div', { className: 'rtc-rounds' },
          props.entries.map(function renderRound(entry) {
            var info = normalizeGate(props.cycle, entry.round)
            var tone = roundTone(info)
            var scoreText = formatScore(info.score)
            var isActive = entry.number === props.activeNumber
            return h('button', {
              key: 'round-' + entry.number,
              type: 'button',
              className: 'rtc-roundChip',
              'data-tone': tone,
              'aria-current': isActive ? 'true' : undefined,
              'aria-label': t('rounds.chipAria', { n: formatCount(entry.number), score: scoreText, status: t(roundStatusKey(info)) }),
              onClick: function onRoundClick() { props.onSelect(entry.number) }
            },
              h('span', null, t('rounds.chip', { n: formatCount(entry.number) })),
              h('span', { className: 'rtc-roundScore' }, scoreText))
          })))
    }

    function JudgeSection(props) {
      var round = props.round
      var score = isObject(round.score) ? round.score : null
      if (!score) {
        return h('section', { className: 'rtc-card', 'aria-labelledby': 'rtc-judge-title' },
          h('h2', { id: 'rtc-judge-title', className: 'rtc-sectionTitle' }, t('judge.title')),
          h('p', { className: 'rtc-emptyText' }, t('judge.missing')))
      }
      var deductions = asArray(score.deductions).filter(isObject)
      var mustFix = cleanStringList(score.mustFix)
      var verdict = asString(score.verdict)
      var screenshots = isObject(score.screenshots) ? score.screenshots : null
      var quality = asString(screenshots && screenshots.quality).toLowerCase()
      var qualityKey = ['good', 'partial', 'bad'].indexOf(quality) >= 0 ? quality : 'unknown'
      var screenshotCount = firstNumber([screenshots && screenshots.count])
      var screenshotNote = asString(screenshots && screenshots.note)
      var rationale = asString(score.rationale)
      return h('section', { className: 'rtc-card', 'aria-labelledby': 'rtc-judge-title' },
        h('h2', { id: 'rtc-judge-title', className: 'rtc-sectionTitle' }, t('judge.title')),
        h('div', { className: 'rtc-judgeHead' },
          h('span', { className: 'rtc-judgeScore', 'aria-label': t('judge.title') }, formatScore(score.score)),
          verdict ? h('span', { className: 'rtc-verdict', 'data-tone': verdictTone(verdict) }, verdictLabel(verdict)) : null,
          h('div', { className: 'rtc-judgeMeta' },
            h('span', null, t('judge.findingsCountValue', { count: formatCount(score.findingsCount) })),
            h('span', null, t('judge.screenshotsLine', {
              quality: t('judge.quality.' + qualityKey),
              count: screenshotCount === null ? t('common.dash') : formatCount(screenshotCount)
            })))),
        screenshotNote ? h('p', { className: 'rtc-fieldValue' }, screenshotNote) : null,
        rationale
          ? h('div', { className: 'rtc-subBlock' },
              h('h3', { className: 'rtc-subTitle' }, t('judge.rationaleTitle')),
              h('p', { className: 'rtc-fieldValue' }, rationale))
          : null,
        h('div', { className: 'rtc-subBlock' },
          h('h3', { className: 'rtc-subTitle' }, t('judge.deductionsTitle')),
          deductions.length === 0
            ? h('p', { className: 'rtc-emptyText' }, t('judge.deductionsEmpty'))
            : h('div', { className: 'rtc-tableWrap' },
                h('table', { className: 'rtc-table' },
                  h('thead', null,
                    h('tr', null,
                      h('th', { scope: 'col' }, t('judge.points')),
                      h('th', { scope: 'col' }, t('judge.reason')),
                      h('th', { scope: 'col' }, t('judge.fix')))),
                  h('tbody', null, deductions.map(function renderDeduction(deduction, index) {
                    return h('tr', { key: 'deduction-' + index },
                      h('td', { 'data-num': 'true' }, '-' + formatScore(deduction.points)),
                      h('td', null, asString(deduction.reason) || t('common.dash')),
                      h('td', null, asString(deduction.fix) || t('common.dash')))
                  }))))),
        h('div', { className: 'rtc-subBlock' },
          h('h3', { className: 'rtc-subTitle' }, t('judge.mustFixTitle')),
          mustFix.length === 0
            ? h('p', { className: 'rtc-emptyText' }, t('judge.mustFixEmpty'))
            : h('ul', { className: 'rtc-list rtc-reasons' }, mustFix.map(function renderMustFix(item, index) {
                return h('li', { key: 'judge-mustfix-' + index }, item)
              }))))
    }

    function ShotCard(props) {
      var shot = props.shot
      var pair = React.useState(false)
      var broken = pair[0]
      var setBroken = pair[1]
      var file = asString(shot.file) || asString(shot.name) || t('common.unknown')
      var width = toFiniteNumber(shot.width)
      var height = toFiniteNumber(shot.height)
      var sizeText = width !== null && height !== null
        ? t('shots.pixelSize', { width: formatCount(width), height: formatCount(height) })
        : t('common.unknown')
      var bytesText = formatBytes(shot.bytes)
      var alt = t('shots.alt', { file: file })
      var media = broken
        ? h('div', { className: 'rtc-shotFallback', 'aria-label': alt },
            h('span', { className: 'rtc-shotFallbackTitle' }, t('shots.failed', { file: file })),
            h('span', { className: 'rtc-shotFallbackMeta' }, sizeText),
            h('span', { className: 'rtc-shotFallbackHint' }, t('shots.failedHint')))
        : h('img', {
            className: 'rtc-shotImg',
            src: props.src,
            alt: alt,
            loading: 'lazy',
            decoding: 'async',
            onError: function onShotError() { setBroken(true) }
          })
      return h('figure', { className: 'rtc-shot' },
        media,
        h('figcaption', { className: 'rtc-shotMeta' },
          h('span', { className: 'rtc-mono rtc-break' }, file),
          h('span', null, sizeText),
          bytesText ? h('span', null, bytesText) : null))
    }

    function StabilitySection(props) {
      var attack = isObject(props.round.attack) ? props.round.attack : null
      var solid = cleanStringList(attack && attack.solid)
      var unverified = asArray(attack && attack.unverified).filter(isObject)
      return h('section', { className: 'rtc-card', 'aria-labelledby': 'rtc-stability-title' },
        h('h2', { id: 'rtc-stability-title', className: 'rtc-sectionTitle' }, t('stability.title')),
        h('div', { className: 'rtc-stability' },
          h('div', { className: 'rtc-stabilityCard' },
            h('h3', { className: 'rtc-subTitle' }, t('attack.solidTitle')),
            solid.length
              ? h('ul', { className: 'rtc-list' }, solid.map(function renderSolid(item, index) {
                  return h('li', { key: 'solid-' + index }, item)
                }))
              : h('p', { className: 'rtc-emptyText' }, t('attack.solidEmpty'))),
          h('div', { className: 'rtc-stabilityCard' },
            h('h3', { className: 'rtc-subTitle' }, t('attack.unverifiedTitle')),
            unverified.length
              ? h('ul', { className: 'rtc-unverifiedList' }, unverified.map(function renderOpen(item, index) {
                  var label = asString(item.item) || t('common.unknown')
                  var needs = asString(item.needs)
                  return h('li', { key: 'unverified-' + index, className: 'rtc-unverifiedItem' },
                    h('span', { className: 'rtc-unverifiedItemTitle' }, label),
                    needs ? h('span', { className: 'rtc-unverifiedItemNeeds' }, t('attack.needsLabel', { needs: needs })) : null)
                }))
              : h('p', { className: 'rtc-emptyText' }, t('attack.unverifiedEmpty')))))
    }

    function footerItem(labelKey, value) {
      return h('span', { className: 'rtc-footerItem', key: 'footer-' + labelKey },
        h('span', { className: 'rtc-footerLabel' }, t(labelKey)),
        h('span', { className: 'rtc-footerValue' }, value))
    }

    function FooterMeta(props) {
      var data = props.data || {}
      var cycle = props.cycle
      var items = []
      items.push(footerItem('meta.updated', formatTimestamp(data.generatedAt)))
      items.push(footerItem('meta.roundCount', formatCount(asArray(cycle && cycle.rounds).length)))
      var target = asString(cycle && cycle.target)
      if (target) {
        items.push(h('span', { className: 'rtc-footerItem', key: 'footer-target' },
          h('span', { className: 'rtc-footerLabel' }, t('meta.target')),
          h('span', { className: 'rtc-footerValue rtc-mono rtc-break' }, target)))
      }
      var version = toFiniteNumber(data.version)
      if (version !== null) items.push(footerItem('meta.version', formatCount(version)))
      return h('footer', { className: 'rtc-footer' }, items)
    }

    // ---------------------------------------------------------------------
    // v1.3 read-only operations board components. Everything renders from the
    // public state/diff/progress payloads; the only mutating control is the
    // explicit cancel button, which posts to the host endpoint.
    // ---------------------------------------------------------------------
    function SearchField(props) {
      return h('div', { className: 'rtc-searchWrap' },
        h('input', {
          type: 'search',
          className: 'rtc-input',
          value: props.value,
          placeholder: props.placeholder,
          'aria-label': props.ariaLabel,
          onChange: function onSearchInput(event) {
            props.onChange(event && event.target ? event.target.value : '')
          }
        }),
        props.value
          ? h('button', {
              type: 'button',
              className: 'rtc-searchClear',
              'aria-label': t('search.clearAria'),
              onClick: function clearSearch() { props.onChange('') }
            }, '×')
          : null)
    }

    function Segmented(props) {
      return h('div', { className: 'rtc-segmented', role: 'group', 'aria-label': props.label },
        props.options.map(function renderOption(option) {
          var pressed = option.value === props.value
          return h('button', {
            key: option.value,
            type: 'button',
            className: 'rtc-segment',
            'aria-pressed': pressed ? 'true' : 'false',
            onClick: function selectOption() { props.onChange(option.value) }
          }, option.label)
        }))
    }

    function TabBar(props) {
      return h('div', { className: 'rtc-tabBar', role: 'tablist', 'aria-label': t('tabs.ariaLabel') },
        props.tabs.map(function renderTab(tab) {
          var selected = tab.id === props.active
          return h('button', {
            key: tab.id,
            id: 'rtc-tab-' + tab.id,
            type: 'button',
            role: 'tab',
            className: 'rtc-tab',
            'aria-selected': selected ? 'true' : 'false',
            'aria-controls': 'rtc-panel-' + tab.id,
            tabIndex: selected ? 0 : -1,
            onClick: function selectTab() { props.onChange(tab.id) },
            onKeyDown: function handleTabKey(event) { props.onKeyDown(event, tab.id) }
          }, tab.label)
        }))
    }

    function metricCard(label, value, tone) {
      return h('div', { className: 'rtc-metric', 'data-tone': tone || undefined },
        h('span', { className: 'rtc-metricLabel' }, label),
        h('span', { className: 'rtc-metricValue' }, value))
    }

    function DiffBadges(props) {
      var summary = props.summary
      if (!summary || !summary.hasData || summary.total === 0) return null
      var entries = [
        { key: 'new', count: summary.new },
        { key: 'repeat', count: summary.repeat },
        { key: 'fixed', count: summary.fixed },
        { key: 'severityChanged', count: summary.severityChanged }
      ]
      return h('span', {
        className: 'rtc-diffBadges',
        'aria-label': t('diff.summaryAria', {
          newCount: formatCount(summary.new),
          repeat: formatCount(summary.repeat),
          fixed: formatCount(summary.fixed),
          changed: formatCount(summary.severityChanged)
        })
      },
        entries.map(function renderBadge(entry) {
          if (entry.count === 0) return null
          var status = entry.key === 'severityChanged' ? 'severity-changed' : entry.key
          var badge = diffBadge({ status: status })
          return h('span', { key: entry.key, className: 'rtc-diffBadge', 'data-tone': badge ? badge.tone : '' }, t('diff.status.' + entry.key) + ' ' + formatCount(entry.count))
        }))
    }

    function RoundPicker(props) {
      if (!props.entries || props.entries.length === 0) return null
      return h('div', { className: 'rtc-roundPicker', role: 'group', 'aria-label': t('rounds.selectGroup') },
        props.entries.map(function renderPickerRound(entry) {
          var info = normalizeGate(props.cycle, entry.round)
          var isSelected = entry.number === props.selectedNumber
          var scoreText = formatScore(info.score)
          return h('button', {
            key: 'picker-' + entry.number,
            type: 'button',
            className: 'rtc-roundChip',
            'data-tone': roundTone(info),
            'aria-current': isSelected ? 'true' : undefined,
            'aria-label': t('rounds.chipAria', { n: formatCount(entry.number), score: scoreText, status: t(roundStatusKey(info)) }),
            onClick: function selectPickerRound() { props.onSelect(entry.number) }
          },
            h('span', null, t('rounds.chip', { n: formatCount(entry.number) })),
            h('span', { className: 'rtc-roundScore' }, scoreText))
        }))
    }

    function NoiseSummary(props) {
      var noise = props.noise
      if (!noise || !noise.hasData) return h('p', { className: 'rtc-emptyText' }, t('noise.empty'))
      var suppressed = asArray(noise.suppressed)
      return h('div', { className: 'rtc-subBlock' },
        h('div', { className: 'rtc-metricGrid rtc-metricGrid--compact' },
          metricCard(t('noise.raw'), formatCount(noise.rawFindings)),
          metricCard(t('noise.deduped'), formatCount(noise.dedupedFindings)),
          metricCard(t('noise.suppressed'), formatCount(noise.suppressedCount)),
          metricCard(t('noise.knownRepeats'), formatCount(noise.knownRepeats))),
        suppressed.length > 0
          ? h('ul', { className: 'rtc-list' }, suppressed.map(function renderSuppressed(entry, index) {
              return h('li', { key: 'suppressed-' + index }, t('noise.suppressedItem', {
                title: asString(entry.title) || t('common.unknown'),
                reason: asString(entry.reason) || t('common.dash')
              }))
            }))
          : null)
    }

    function IncrementalNote(props) {
      var inc = props.incremental
      if (!inc || !inc.hasData) return null
      var modeValue = inc.modeKey ? t(inc.modeKey) : (inc.mode ? inc.mode : t('common.unknown'))
      return h('div', { className: 'rtc-subBlock' },
        h('h3', { className: 'rtc-subTitle' }, t('overview.incrementalTitle')),
        h('div', { className: 'rtc-chips' },
          h('span', { className: 'rtc-chip', key: 'mode' }, t('overview.incremental.mode', { mode: modeValue })),
          inc.baseRound !== null ? h('span', { className: 'rtc-chip', key: 'base' }, t('overview.incremental.base', { round: formatCount(inc.baseRound) })) : null,
          h('span', { className: 'rtc-chip', key: 'changed' }, t('overview.incremental.changed', { count: formatCount(inc.changedFiles.length) })),
          inc.addedFiles.length > 0 ? h('span', { className: 'rtc-chip', key: 'added' }, t('overview.incremental.added', { count: formatCount(inc.addedFiles.length) })) : null,
          inc.removedFiles.length > 0 ? h('span', { className: 'rtc-chip', key: 'removed' }, t('overview.incremental.removed', { count: formatCount(inc.removedFiles.length) })) : null,
          inc.unchangedCount !== null ? h('span', { className: 'rtc-chip', key: 'unchanged' }, t('overview.incremental.unchanged', { count: formatCount(inc.unchangedCount) })) : null,
          inc.truncated ? h('span', { className: 'rtc-chip', key: 'truncated' }, t('overview.incremental.truncated')) : null,
          inc.fullReview ? h('span', { className: 'rtc-chip', key: 'full' }, t('overview.incremental.full')) : null))
    }

    function ProgressPanel(props) {
      var round = props.round
      var progress = props.progress
      var running = isRoundRunning(round) || (progress !== null && progress.derived === false && progress.done !== true)
      var stage = progress ? progress.stage : ''
      var percent = stagePercent(stage)
      var stageLabel = progress ? progressLabelFor(progress) : t('progress.waiting')
      var roundNo = round ? roundNumberOf(round, 0) : 0
      var cancel = props.cancel || null
      var cancelBusy = cancel !== null && cancel.busy === true
      return h('section', { className: 'rtc-card', 'aria-labelledby': 'rtc-progress-title' },
        h('div', { className: 'rtc-rowBetween' },
          h('h2', { id: 'rtc-progress-title', className: 'rtc-sectionTitle' }, t('progress.title')),
          running && props.onCancel
            ? h('button', {
                type: 'button',
                className: 'rtc-btn rtc-btnDanger',
                disabled: cancelBusy,
                'aria-busy': cancelBusy ? 'true' : 'false',
                'aria-label': t('cancel.aria', { round: formatCount(roundNo) }),
                onClick: function requestCancelClick() { props.onCancel(roundNo) }
              }, cancelBusy ? t('cancel.busy') : t('cancel.button'))
            : null),
        h('div', {
          className: 'rtc-stageBar',
          role: 'progressbar',
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': percent,
          'aria-valuetext': stageLabel,
          'aria-label': t('progress.aria', { round: formatCount(roundNo), stage: stageLabel, percent: formatCount(percent) })
        },
          h('div', { className: 'rtc-stageFill', 'data-stage': stage || 'unknown', style: { width: percent + '%' } }),
          h('div', { className: 'rtc-stageMarkers', 'aria-hidden': 'true' }, PROGRESS_STAGES.map(function renderMarker(item) {
            return h('span', { key: 'marker-' + item, className: 'rtc-stageMarker' })
          }))),
        h('div', { className: 'rtc-stageLabels', 'aria-hidden': 'true' }, PROGRESS_STAGES.map(function renderStageLabel(item) {
          return h('span', { key: 'stage-' + item, className: 'rtc-stageLabel' }, t('progress.stage.' + item))
        })),
        h('p', { className: 'rtc-progressState', role: 'status', 'aria-live': 'polite' },
          h('span', { key: 'state' }, running ? t('progress.running') : t('progress.doneHint')),
          progress && progress.updatedAt !== null ? h('span', { key: 'updated' }, t('progress.updated', { time: formatTimestamp(progress.updatedAt) })) : null,
          progress && progress.detail ? h('span', { key: 'detail' }, t('progress.detail', { detail: progress.detail })) : null),
        !progress && running ? h('p', { className: 'rtc-emptyText' }, t('progress.fallback')) : null,
        cancel && cancel.result && running ? h('p', { className: 'rtc-cancelState', role: 'status', 'aria-live': 'polite' }, t(cancel.result.key, cancel.result.params || {})) : null,
        cancel && cancel.error && running ? h('p', { className: 'rtc-cancelState', 'data-error': 'true', role: 'alert' }, t(cancel.error.key, cancel.error.params || {})) : null)
    }

    function LatestSummary(props) {
      var round = props.round
      var cycle = props.cycle
      if (!round) return null
      var info = normalizeGate(cycle, round)
      var badge = props.badge || null
      var cost = props.cost || costInfo(round)
      var roundNo = roundNumberOf(round, 0)
      return h('section', { className: 'rtc-card', 'aria-labelledby': 'rtc-latest-title' },
        h('h2', { id: 'rtc-latest-title', className: 'rtc-sectionTitle' }, t('overview.latestTitle')),
        h('div', { className: 'rtc-metricGrid' },
          metricCard(t('overview.latestRound'), t('rounds.chip', { n: formatCount(roundNo) })),
          metricCard(t('gate.title'), info.passed ? t('gate.passedShort') : t('gate.failedShort'), info.passed ? 'passed' : 'held'),
          metricCard(t('gate.findings'), t('gate.findingsValue', { count: formatCount(info.findings), required: formatCount(info.requiredFindings) })),
          metricCard(t('gate.shots'), t('gate.shotsValue', { count: formatCount(info.shots), required: formatCount(info.requiredShots) })),
          metricCard(t('cost.total'), formatDurationLabel(cost.totalMs)),
          metricCard(t('cost.judgeSamples'), cost.judgeSamples === null ? dash() : formatCount(cost.judgeSamples)),
          badge && badge.profile ? metricCard(t('cost.profile'), profileLabel(badge.profile)) : null,
          badge && badge.running ? metricCard(t('progress.title'), t('progress.running'), 'running') : null),
        props.incremental ? h(IncrementalNote, { incremental: props.incremental }) : null,
        badge && badge.reopenCount > 0
          ? h('p', { className: 'rtc-emptyText' },
              t('overview.reopen', {
                round: formatCount(badge.reopenedFrom === null ? 0 : badge.reopenedFrom),
                count: formatCount(badge.reopenCount)
              }))
          : null)
    }

    function CycleList(props) {
      var statusOptions = [
        { value: 'all', label: t('cycles.filter.all') },
        { value: 'reviewing', label: t('cycles.filter.reviewing') },
        { value: 'passed', label: t('cycles.filter.passed') }
      ]
      var sortOptions = [
        { value: 'updated-desc', label: t('cycles.sort.updatedDesc') },
        { value: 'updated-asc', label: t('cycles.sort.updatedAsc') },
        { value: 'score-desc', label: t('cycles.sort.scoreDesc') }
      ]
      return h('aside', { className: 'rtc-cycles', 'aria-label': t('cycles.label') },
        h('div', { className: 'rtc-cyclesHeader' },
          h('div', { className: 'rtc-rowBetween' },
            h('h2', { className: 'rtc-sectionTitle' }, t('cycles.label')),
            h('span', { className: 'rtc-count' }, t('cycles.countLabel', {
              visible: formatCount(props.visibleCount),
              total: formatCount(props.totalCount)
            }))),
          h(SearchField, {
            value: props.query,
            placeholder: t('cycles.search'),
            ariaLabel: t('cycles.searchAria'),
            onChange: props.onQuery
          }),
          h(Segmented, {
            label: t('cycles.filterLabel'),
            options: statusOptions,
            value: props.statusFilter,
            onChange: props.onStatus
          }),
          h('label', { className: 'rtc-selectLabel' },
            h('span', null, t('cycles.sortLabel')),
            h('select', {
              className: 'rtc-select',
              value: props.sortMode,
              'aria-label': t('cycles.sortLabel'),
              onChange: function onSortChange(event) {
                props.onSort(event && event.target ? event.target.value : 'updated-desc')
              }
            }, sortOptions.map(function renderSortOption(option) {
              return h('option', { key: option.value, value: option.value }, option.label)
            })))),
        props.entries.length === 0
          ? h('p', { className: 'rtc-emptyText' }, t('cycles.emptyFiltered'))
          : h('ul', { className: 'rtc-cycleList' }, props.entries.map(function renderCycleEntry(entry) {
              var cycle = entry.cycle
              var badge = statusBadge(cycle)
              var target = asString(cycle.target)
              var title = asString(cycle.title) || target || t('common.unknown')
              return h('li', { key: 'cycle-' + entry.key },
                h('button', {
                  type: 'button',
                  className: 'rtc-cycleBtn',
                  'aria-current': entry.key === props.activeKey ? 'true' : undefined,
                  'aria-label': title,
                  onClick: function onCycleClick() { props.onSelect(entry.key) }
                },
                  h('span', { className: 'rtc-cycleTitle' }, title),
                  target ? h('span', { className: 'rtc-cycleMeta rtc-break' }, target) : null,
                  h('span', { className: 'rtc-cycleBadges' },
                    badge.score !== null ? h('span', { key: 'score', className: 'rtc-miniBadge', 'data-tone': 'score' }, formatScore(badge.score)) : null,
                    badge.gatePassed !== null ? h('span', { key: 'gate', className: 'rtc-miniBadge', 'data-tone': badge.gatePassed ? 'passed' : 'held' }, t(badge.gatePassed ? 'gate.passedShort' : 'gate.failedShort')) : null,
                    h('span', { key: 'status', className: 'rtc-miniBadge', 'data-tone': badge.status === 'passed' ? 'passed' : 'running' }, t(badge.labelKey)),
                    h('span', { key: 'rounds', className: 'rtc-miniBadge' }, t('cycles.badge.rounds', { count: formatCount(badge.rounds) })),
                    badge.profile ? h('span', { key: 'profile', className: 'rtc-miniBadge' }, profileLabel(badge.profile)) : null,
                    badge.reopenCount > 0 ? h('span', { key: 'reopen', className: 'rtc-miniBadge' }, t('cycles.badge.reopen', { count: formatCount(badge.reopenCount) })) : null,
                    badge.running ? h('span', { key: 'running', className: 'rtc-miniBadge', 'data-tone': 'running' }, t('progress.running')) : null),
                  h('span', { className: 'rtc-cycleUpdated' }, t('cycles.updatedAt', { time: formatTimestamp(badge.updatedAt) }))))
            })))
    }

    function RoundsTab(props) {
      var cycle = props.cycle
      var entries = props.entries || []
      if (entries.length === 0) return h('p', { className: 'rtc-emptyText' }, t('gate.noRound'))
      return h('section', { className: 'rtc-card', 'aria-labelledby': 'rtc-rounds-table-title' },
        h('div', { className: 'rtc-rowBetween' },
          h('h2', { id: 'rtc-rounds-table-title', className: 'rtc-sectionTitle' }, t('rounds.tableTitle')),
          props.diffError ? h('span', { className: 'rtc-count' }, t('diff.fetchError')) : null),
        h('div', { className: 'rtc-tableWrap' },
          h('table', { className: 'rtc-table' },
            h('thead', null, h('tr', null,
              h('th', { scope: 'col' }, t('rounds.col.n')),
              h('th', { scope: 'col' }, t('rounds.col.status')),
              h('th', { scope: 'col' }, t('rounds.col.score')),
              h('th', { scope: 'col' }, t('rounds.col.verdict')),
              h('th', { scope: 'col' }, t('rounds.col.judges')),
              h('th', { scope: 'col' }, t('rounds.col.disagreement')),
              h('th', { scope: 'col' }, t('rounds.col.findings')),
              h('th', { scope: 'col' }, t('rounds.col.evidence')),
              h('th', { scope: 'col' }, t('rounds.col.cost')),
              h('th', { scope: 'col' }, t('rounds.col.diff')))),
            h('tbody', null, entries.map(function renderRoundRow(entry) {
              var round = entry.round
              var number = entry.number
              var info = normalizeGate(cycle, round)
              var isSelected = number === props.selectedNumber
              var judges = judgesOf(round)
              var judgeTotal = judges.length > 0 ? judges.length : judgeSamplesOf(round)
              var disagreement = disagreementOf(round)
              var kindCounts = evidenceKindCounts(round)
              var kindsText = ''
              for (var i = 0; i < kindCounts.length; i += 1) {
                var kindLabel = t(evidenceKindKey(kindCounts[i].kind))
                kindsText = kindsText === '' ? kindLabel : kindsText + ', ' + kindLabel
              }
              var cost = costInfo(round)
              var summary = diffSummaryForRound(props.diff, number)
              return h('tr', { key: 'round-row-' + number, 'data-selected': isSelected ? 'true' : 'false' },
                h('td', null, h('button', {
                  type: 'button',
                  className: 'rtc-linkBtn',
                  'aria-current': isSelected ? 'true' : undefined,
                  'aria-label': t('rounds.selectAria', { n: formatCount(number) }),
                  onClick: function selectRoundRow() { props.onSelect(number) }
                }, t('rounds.chip', { n: formatCount(number) }))),
                h('td', null, h('span', { className: 'rtc-statusTag', 'data-tone': roundTone(info) }, t(roundStatusKey(info)))),
                h('td', { className: 'rtc-num' }, formatScore(info.score)),
                h('td', null, info.verdict ? h('span', { className: 'rtc-verdict', 'data-tone': verdictTone(info.verdict) }, verdictLabel(info.verdict)) : dash()),
                h('td', null, judgeTotal !== null ? t('rounds.judgesValue', { count: formatCount(judgeTotal) }) : dash()),
                h('td', null, disagreement === null ? dash() : t('rounds.disagreementValue', { value: formatScore(disagreement) })),
                h('td', null, t('rounds.findingsValue', { count: formatCount(info.findings), supported: formatCount(info.supported) })),
                h('td', null, kindCounts.length > 0 ? t('rounds.evidenceValue', { kinds: kindsText, count: formatCount(cost.artifactCount) }) : dash()),
                h('td', { className: 'rtc-num' }, formatDurationLabel(cost.totalMs)),
                h('td', null, h(DiffBadges, { summary: summary })))
            })))))
    }

    function FindingCard(props) {
      var finding = props.finding
      var severity = normalizeSeverity(finding.severity)
      var confidence = asString(finding.confidence).toLowerCase()
      var confidenceKey = CONFIDENCE_ORDER.indexOf(confidence) >= 0 ? confidence : 'unknown'
      var judge = judgeVerdictForTitle(props.validFindings, finding.title)
      var verified = finding.verified === true
      var hasVerifiedFlag = typeof finding.verified === 'boolean'
      var changeBadge = diffBadge(props.diffChange)
      return h('article', { className: 'rtc-finding' },
        h('div', { className: 'rtc-findingHeader' },
          h('h3', { className: 'rtc-findingTitle' }, asString(finding.title) || t('findings.untitled')),
          h('span', { className: 'rtc-badges' },
            h('span', { className: 'rtc-sev', 'data-sev': severity }, t('findings.severity.' + severity)),
            changeBadge ? h('span', { className: 'rtc-diffBadge', 'data-tone': changeBadge.tone, key: 'diff' }, t(changeBadge.labelKey)) : null,
            h('span', { className: 'rtc-chip', key: 'confidence' }, t('findings.confidenceValue', { value: t('findings.confidence.' + confidenceKey) })),
            judge
              ? h('span', { className: 'rtc-chip', 'data-judge': judge.supported ? 'true' : 'false', key: 'judge' }, t(judge.supported ? 'findings.judgeSupported' : 'findings.judgeUnsupported'))
              : null,
            hasVerifiedFlag
              ? h('span', { className: 'rtc-chip', key: 'verified' }, t(verified ? 'findings.verified' : 'findings.unverified'))
              : null)),
        h('div', { className: 'rtc-fields' },
          fieldNode('findings.evidence', asString(finding.evidence), true),
          fieldNode('findings.attack', asString(finding.attack), false),
          fieldNode('findings.impact', asString(finding.impact), false),
          fieldNode('findings.fix', asString(finding.fix), false),
          judge && judge.note ? fieldNode('findings.judgeNote', judge.note, false) : null))
    }

    function FindingsTab(props) {
      var round = props.round
      var cycle = props.cycle
      if (!round) return h('p', { className: 'rtc-emptyText' }, t('gate.noRound'))
      var score = isObject(round.score) ? round.score : null
      var attack = isObject(round.attack) ? round.attack : null
      var findings = asArray(attack && attack.findings).filter(isObject)
      var visible = filterFindings(findings, props.query, props.severity)
      var groups = groupFindings(visible)
      var validFindings = asArray(score && score.validFindings)
      var mustFix = dedupeStrings(cleanStringList(score && score.mustFix))
      var diffMap = diffChangeMap(props.diff)
      var severityOptions = [
        { value: 'all', label: t('findings.filter.all') },
        { value: 'BLOCKER', label: t('findings.severity.BLOCKER') },
        { value: 'MAJOR', label: t('findings.severity.MAJOR') },
        { value: 'MINOR', label: t('findings.severity.MINOR') }
      ]
      return h('div', { className: 'rtc-tabStack' },
        h(RoundPicker, { cycle: cycle, entries: props.entries, selectedNumber: props.selectedNumber, onSelect: props.onSelect }),
        h('section', { className: 'rtc-card', 'aria-labelledby': 'rtc-findings-title' },
          h('h2', { id: 'rtc-findings-title', className: 'rtc-sectionTitle' }, t('findings.title')),
          h('div', { className: 'rtc-toolbar' },
            h(SearchField, {
              value: props.query,
              placeholder: t('findings.search'),
              ariaLabel: t('findings.searchAria'),
              onChange: props.onQuery
            }),
            h(Segmented, {
              label: t('findings.filterLabel'),
              options: severityOptions,
              value: props.severity,
              onChange: props.onSeverity
            })),
          h('div', { className: 'rtc-subBlock' },
            h('h3', { className: 'rtc-subTitle' }, t('noise.title')),
            h(NoiseSummary, { noise: props.noise })),
          visible.length === 0
            ? h('p', { className: 'rtc-emptyText' }, t('findings.filterEmpty'))
            : severityOrder().map(function renderSeverityGroup(severity) {
                var items = groups[severity]
                if (items.length === 0) return null
                return h('div', { className: 'rtc-group', key: 'group-' + severity },
                  h('div', { className: 'rtc-groupHeader' },
                    h('span', { className: 'rtc-sev', 'data-sev': severity }, t('findings.severity.' + severity)),
                    h('span', { className: 'rtc-count' }, t('findings.groupCount', { count: formatCount(items.length) }))),
                  items.map(function renderFinding(finding, index) {
                    return h(FindingCard, {
                      key: 'finding-' + severity + '-' + index,
                      finding: finding,
                      validFindings: validFindings,
                      diffChange: diffMap[normalizeTitle(finding.title)]
                    })
                  }))
              }),
          h('div', { className: 'rtc-subBlock' },
            h('h3', { className: 'rtc-subTitle' }, t('findings.mustFixTitle')),
            mustFix.length === 0
              ? h('p', { className: 'rtc-emptyText' }, t('judge.mustFixEmpty'))
              : h('ul', { className: 'rtc-list rtc-reasons' }, mustFix.map(function renderMustFix(item, index) {
                  return h('li', { key: 'findings-mustfix-' + index }, item)
                })))))
    }

    function ArtifactPreview(props) {
      var pair = React.useState(false)
      var broken = pair[0]
      var setBroken = pair[1]
      var artifact = props.artifact
      var label = artifactLabel(artifact)
      var alt = t('evidence.openImage', { file: label })
      var media = broken
        ? h('span', { className: 'rtc-artifactPreviewFallback' },
            h('span', null, t('shots.failed', { file: label })),
            h('span', null, t('evidence.dims', { width: formatCount(artifact.width), height: formatCount(artifact.height) })))
        : h('img', {
            src: props.src,
            alt: alt,
            loading: 'lazy',
            decoding: 'async',
            onError: function onArtifactError() { setBroken(true) }
          })
      return h('a', { className: 'rtc-artifactPreview', href: props.src, target: '_blank', rel: 'noopener noreferrer', 'aria-label': alt },
        media,
        h('span', { className: 'rtc-artifactMeta' },
          h('span', { key: 'file', className: 'rtc-mono rtc-break' }, label),
          h('span', { key: 'dims' }, t('evidence.dims', { width: formatCount(artifact.width), height: formatCount(artifact.height) })),
          artifact.sha256 ? h('span', { key: 'sha', className: 'rtc-mono' }, t('evidence.sha', { value: shortSha(artifact.sha256) })) : null))
    }

    function ArtifactRow(props) {
      var artifact = props.artifact
      var src = artifactPreviewUrl(props.cycleId, artifact.file, props.shotFiles)
      var file = artifactLabel(artifact)
      var isImage = isImageArtifact(artifact)
      var meta = []
      if (isImage) meta.push(h('span', { key: 'dims' }, t('evidence.dims', { width: formatCount(artifact.width), height: formatCount(artifact.height) })))
      if (artifact.kind) meta.push(h('span', { key: 'kind' }, t(artifactKindKey(artifact.kind))))
      if (artifact.sha256) meta.push(h('span', { key: 'sha', className: 'rtc-mono' }, t('evidence.sha', { value: shortSha(artifact.sha256) })))
      return h('a', {
        className: 'rtc-artifactLink',
        href: src,
        target: isImage ? '_blank' : undefined,
        rel: isImage ? 'noopener noreferrer' : undefined,
        download: isImage ? undefined : safeFileName(artifact.file),
        'aria-label': isImage ? t('evidence.openImage', { file: file }) : t('evidence.download', { file: file })
      },
        h('span', { className: 'rtc-artifactName' }, file),
        meta.length > 0 ? h('span', { className: 'rtc-artifactMeta' }, meta) : null)
    }

    function EvidenceCard(props) {
      var card = props.card
      var kindLabel = t(evidenceKindKey(card.kind))
      var representative = card.artifacts.length > 0 ? card.artifacts[0] : null
      var extras = extraArtifactsOf(card)
      var textArtifact = null
      for (var i = 0; i < card.artifacts.length; i += 1) {
        if (isTextArtifact(card.artifacts[i])) {
          textArtifact = card.artifacts[i]
          break
        }
      }
      return h('section', { className: 'rtc-card rtc-evidenceCard', 'data-kind': card.kind },
        h('div', { className: 'rtc-rowBetween' },
          h('h3', { className: 'rtc-subTitle' }, t('evidence.card', { index: formatCount(card.index + 1) })),
          h('span', { className: 'rtc-count rtc-break' }, card.name ? kindLabel + ' · ' + card.name : kindLabel)),
        h('div', { className: 'rtc-evidenceStats' },
          h('span', { className: 'rtc-chip' }, t('evidence.artifacts', { count: formatCount(card.artifactCount) })),
          h('span', { className: 'rtc-chip' }, t('evidence.consoleErrors', { count: formatCount(card.consoleErrors) })),
          h('span', { className: 'rtc-chip' }, t('evidence.networkFailures', { count: formatCount(card.networkFailures) })),
          card.perfFps !== null ? h('span', { className: 'rtc-chip' }, t('evidence.fps', { value: formatCount(card.perfFps) })) : null),
        representative
          ? h('div', { className: 'rtc-subBlock' },
              h('h4', { className: 'rtc-subTitle' }, t('evidence.representative')),
              h(ArtifactPreview, {
                artifact: representative,
                src: artifactPreviewUrl(props.cycleId, representative.file, props.shotFiles)
              }))
          : null,
        card.kind === 'pdf-text' && textArtifact
          ? h('div', { className: 'rtc-subBlock' },
              h('h4', { className: 'rtc-subTitle' }, t('evidence.pdfText')),
              h(ArtifactRow, { cycleId: props.cycleId, artifact: textArtifact, shotFiles: props.shotFiles }))
          : null,
        h('div', { className: 'rtc-subBlock' },
          h('h4', { className: 'rtc-subTitle' }, t('evidence.extra')),
          extras.length === 0
            ? h('p', { className: 'rtc-emptyText' }, t('evidence.noArtifacts'))
            : h('ul', { className: 'rtc-artifactList' }, extras.map(function renderArtifact(artifact, index) {
                return h('li', { key: 'artifact-' + index }, h(ArtifactRow, {
                  cycleId: props.cycleId,
                  artifact: artifact,
                  shotFiles: props.shotFiles
                }))
              }))))
    }

    function EvidenceTab(props) {
      var round = props.round
      var cycle = props.cycle
      if (!round) return h('p', { className: 'rtc-emptyText' }, t('gate.noRound'))
      var shots = asArray(round.shots).filter(isObject)
      var shotFiles = []
      for (var i = 0; i < shots.length; i += 1) shotFiles.push(asString(shots[i].file))
      var cards = evidenceCards(round)
      var cycleId = asString(cycle && cycle.id)
      return h('div', { className: 'rtc-tabStack' },
        h(RoundPicker, { cycle: cycle, entries: props.entries, selectedNumber: props.selectedNumber, onSelect: props.onSelect }),
        h('section', { className: 'rtc-card', 'aria-labelledby': 'rtc-shots-title' },
          h('h2', { id: 'rtc-shots-title', className: 'rtc-sectionTitle' }, t('shots.title')),
          h('p', { className: 'rtc-emptyText rtc-note' }, t('evidence.representativeHint')),
          shots.length === 0
            ? h('p', { className: 'rtc-emptyText' }, t('shots.empty'))
            : h('div', { className: 'rtc-shots' }, shots.map(function renderShot(shot, index) {
                var src = buildShotSrc(cycle, shot)
                return h(ShotCard, { key: 'shot-' + index + '-' + src, shot: shot, src: src })
              }))),
        h('section', { className: 'rtc-card', 'aria-labelledby': 'rtc-evidence-title' },
          h('h2', { id: 'rtc-evidence-title', className: 'rtc-sectionTitle' }, t('evidence.title')),
          cards.length === 0
            ? h('p', { className: 'rtc-emptyText' }, t('evidence.empty'))
            : h('div', { className: 'rtc-evidenceGrid' }, cards.map(function renderCard(card) {
                return h(EvidenceCard, { key: 'card-' + card.index, card: card, cycleId: cycleId, shotFiles: shotFiles })
              }))))
    }

    function CostTab(props) {
      var round = props.round
      if (!round) return h('p', { className: 'rtc-emptyText' }, t('gate.noRound'))
      var cost = costInfo(round)
      var kindCounts = evidenceKindCounts(round)
      var profile = profileOf(round, props.cycle)
      return h('div', { className: 'rtc-tabStack' },
        h(RoundPicker, { cycle: props.cycle, entries: props.entries, selectedNumber: props.selectedNumber, onSelect: props.onSelect }),
        h('section', { className: 'rtc-card', 'aria-labelledby': 'rtc-cost-title' },
          h('h2', { id: 'rtc-cost-title', className: 'rtc-sectionTitle' }, t('cost.title')),
          h('p', { className: 'rtc-emptyText rtc-note' }, t('cost.note')),
          h('div', { className: 'rtc-metricGrid' },
            metricCard(t('cost.total'), formatDurationLabel(cost.totalMs)),
            metricCard(t('cost.evidence'), formatDurationLabel(cost.evidenceMs)),
            metricCard(t('cost.attack'), formatDurationLabel(cost.attackMs)),
            metricCard(t('cost.judge'), formatDurationLabel(cost.judgeMs)),
            metricCard(t('cost.promptChars'), formatCount(cost.promptChars)),
            metricCard(t('cost.judgePromptChars'), formatCount(cost.judgePromptChars)),
            metricCard(t('cost.judgeSamples'), cost.judgeSamples === null ? dash() : formatCount(cost.judgeSamples)),
            metricCard(t('cost.artifactCount'), formatCount(cost.artifactCount)),
            profile ? metricCard(t('cost.profile'), profileLabel(profile)) : null),
          kindCounts.length > 0
            ? h('div', { className: 'rtc-chips' }, kindCounts.map(function renderKindChip(entry) {
                return h('span', { className: 'rtc-chip', key: 'kind-' + entry.kind }, t('evidence.kindCount', {
                  kind: t(evidenceKindKey(entry.kind)),
                  count: formatCount(entry.count)
                }))
              }))
            : null,
          !cost.hasData ? h('p', { className: 'rtc-emptyText' }, t('cost.empty')) : null))
    }

    function SessionIdCell(props) {
      var pair = React.useState('')
      var copyState = pair[0]
      var setCopyState = pair[1]
      var value = asString(props.value)
      if (!value) return h('span', { className: 'rtc-count' }, t('export.noSession'))
      function copyValue() {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(value).then(function onCopied() {
              setCopyState('copied')
            }, function onCopyFailed() {
              setCopyState('failed')
            })
            return
          }
        } catch (error) {
          /* fall through to the failure notice */
        }
        setCopyState('failed')
      }
      return h('span', { className: 'rtc-sessionValue' },
        h('span', { className: 'rtc-mono rtc-break' }, value),
        h('button', {
          type: 'button',
          className: 'rtc-copyBtn',
          'aria-label': t('export.copyAria', { label: props.label || t('export.sessionTitle') }),
          onClick: copyValue
        }, t('export.copy')),
        copyState
          ? h('span', {
              className: 'rtc-copyState',
              'data-error': copyState === 'failed' ? 'true' : 'false',
              role: 'status',
              'aria-live': 'polite'
            }, copyState === 'failed' ? t('export.copyFailed') : t('export.copied'))
          : null)
    }

    function ExportTab(props) {
      var cycle = props.cycle
      var entries = props.entries || []
      var title = asString(cycle.title) || asString(cycle.target) || asString(cycle.id)
      var fileName = safeFileName(title) || 'review'
      return h('div', { className: 'rtc-tabStack' },
        h('section', { className: 'rtc-card', 'aria-labelledby': 'rtc-export-title' },
          h('h2', { id: 'rtc-export-title', className: 'rtc-sectionTitle' }, t('export.title')),
          h('p', { className: 'rtc-emptyText rtc-note' }, t('export.note')),
          h('div', { className: 'rtc-exportLinks' },
            h('a', { className: 'rtc-btn', href: exportUrl(cycle.id, 'md'), download: fileName + '-review.md' }, t('export.markdown')),
            h('a', { className: 'rtc-btn', href: exportUrl(cycle.id, 'json'), download: fileName + '-review.json' }, t('export.json')))),
        h('section', { className: 'rtc-card', 'aria-labelledby': 'rtc-sessions-title' },
          h('h2', { id: 'rtc-sessions-title', className: 'rtc-sectionTitle' }, t('export.sessionTitle')),
          entries.length === 0
            ? h('p', { className: 'rtc-emptyText' }, t('gate.noRound'))
            : h('div', { className: 'rtc-tableWrap' },
                h('table', { className: 'rtc-table' },
                  h('thead', null, h('tr', null,
                    h('th', { scope: 'col' }, t('rounds.col.n')),
                    h('th', { scope: 'col' }, t('export.attackerSession')),
                    h('th', { scope: 'col' }, t('export.judgeSessions')),
                    h('th', { scope: 'col' }, t('export.rubricVersion')))),
                  h('tbody', null, entries.map(function renderSessionRow(entry) {
                    var round = entry.round
                    var ids = sessionIdsOf(round)
                    return h('tr', { key: 'session-row-' + entry.number },
                      h('td', { className: 'rtc-num' }, t('rounds.chip', { n: formatCount(entry.number) })),
                      h('td', null, h(SessionIdCell, { value: ids.attackerSessionId, label: t('export.attackerSession') })),
                      h('td', null, ids.judgeSessionIds.length === 0
                        ? h('span', { className: 'rtc-count' }, t('export.noSession'))
                        : h('span', { className: 'rtc-sessionValue' }, ids.judgeSessionIds.map(function renderJudgeId(sessionId) {
                            return h(SessionIdCell, { key: 'judge-' + sessionId, value: sessionId, label: t('export.judgeSessions') })
                          }))),
                      h('td', { className: 'rtc-mono rtc-break' }, asString(round.rubricVersion) || dash()))
                  }))))))
    }

    function OverviewTab(props) {
      var cycle = props.cycle
      var entries = props.entries || []
      var latest = latestRoundEntry(entries)
      var round = latest ? latest.round : null
      var badge = statusBadge(cycle)
      return h('div', { className: 'rtc-tabStack' },
        h(GateBanner, { cycle: cycle, round: round }),
        h(ProgressPanel, {
          round: round,
          progress: props.progress,
          cancel: props.cancel,
          onCancel: props.onCancel
        }),
        entries.length > 0
          ? h(RoundTimeline, {
              cycle: cycle,
              entries: entries,
              activeNumber: props.selectedNumber,
              onSelect: props.onSelectRound
            })
          : null,
        h(LatestSummary, {
          cycle: cycle,
          round: round,
          badge: badge,
          cost: round ? costInfo(round) : null,
          incremental: round ? incrementalInfo(round, cycle) : null
        }),
        round ? h(JudgeSection, { round: round }) : null,
        round ? h(StabilitySection, { round: round }) : null)
    }
    // ---------------------------------------------------------------------
    // Data hooks. One polling loop per mounted page: 5 s cadence, paused while
    // the document is hidden, and fully cleaned up on unmount.
    // ---------------------------------------------------------------------
    // ---------------------------------------------------------------------
    // Data hooks. One polling loop per mounted page: 2 s while any round is
    // running, 5 s when idle, paused while the document is hidden, and fully
    // cleaned up on unmount. Progress streams ride on top for the active cycle.
    // ---------------------------------------------------------------------
    function useProgressStream(cycleId, active, onDone) {
      var progressPair = React.useState(null)
      var progress = progressPair[0]
      var setProgress = progressPair[1]
      var onDoneRef = React.useRef(null)
      onDoneRef.current = typeof onDone === 'function' ? onDone : null
      React.useEffect(function subscribeProgress() {
        if (!active || !cycleId || typeof EventSource !== 'function') return function noop() {}
        var source = null
        var closed = false
        function closeStream() {
          if (closed) return
          closed = true
          try {
            if (source) source.close()
          } catch (error) {
            /* already closed */
          }
        }
        try {
          source = new EventSource(progressUrl(cycleId))
        } catch (error) {
          return function noop() {}
        }
        source.onmessage = function handleProgressMessage(event) {
          var parsed = parseProgressPayload(event && event.data)
          if (!parsed || parsed.cycleId !== asString(cycleId)) return
          setProgress(parsed)
          if (parsed.done) {
            closeStream()
            if (onDoneRef.current !== null) onDoneRef.current()
          }
        }
        source.onerror = function handleProgressError() {
          // Fall back to the adaptive state poll; a remount reopens the stream.
          closeStream()
        }
        return function stopProgressStream() {
          closeStream()
        }
      }, [cycleId, active])
      return progress
    }

    function useCycleDiff(cycleId, enabled, signature) {
      var diffPair = React.useState({ data: null, error: null, loading: false })
      var diffState = diffPair[0]
      var setDiffState = diffPair[1]
      React.useEffect(function loadDiff() {
        if (!enabled || !cycleId) return function noop() {}
        var alive = true
        var controller = null
        try {
          if (typeof AbortController === 'function') controller = new AbortController()
        } catch (error) {
          controller = null
        }
        var options = { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store' }
        if (controller !== null) options.signal = controller.signal
        setDiffState({ data: null, error: null, loading: true })
        fetch(diffUrl(cycleId), options).then(function readDiffResponse(response) {
          return response.text().then(function parseDiffBody(raw) {
            if (!response.ok) {
              var httpError = new Error('HTTP ' + response.status)
              httpError.rtcCode = 'http'
              httpError.rtcStatus = response.status
              throw httpError
            }
            try {
              return JSON.parse(raw)
            } catch (parseError) {
              var jsonError = new Error('Invalid JSON payload')
              jsonError.rtcCode = 'invalid-json'
              throw jsonError
            }
          })
        }).then(function applyDiffPayload(payload) {
          if (!alive) return
          setDiffState({ data: normalizeDiff(payload), error: null, loading: false })
        }).catch(function handleDiffFailure(error) {
          if (!alive) return
          if (controller !== null && controller.signal.aborted) return
          setDiffState({ data: null, error: { key: 'diff.fetchError', params: {}, detail: asString(error && error.message) }, loading: false })
        })
        return function cleanupDiff() {
          alive = false
          if (controller !== null) {
            try { controller.abort() } catch (error) { /* already settled */ }
          }
        }
      }, [cycleId, enabled, signature])
      return diffState
    }

    function useCancelRound(cycleId, onDone) {
      var cancelPair = React.useState({ busy: false, error: null, result: null })
      var cancelState = cancelPair[0]
      var setCancelState = cancelPair[1]
      var onDoneRef = React.useRef(null)
      onDoneRef.current = typeof onDone === 'function' ? onDone : null
      var requestCancel = React.useCallback(function cancelRound() {
        var id = asString(cycleId)
        if (!id) return
        setCancelState({ busy: true, error: null, result: null })
        var options = {
          method: 'POST',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          credentials: 'same-origin'
        }
        fetch(cancelUrl(id), options).then(function readCancelResponse(response) {
          return response.text().then(function parseCancelBody(raw) {
            if (!response.ok) {
              var httpError = new Error('HTTP ' + response.status)
              httpError.rtcCode = 'http'
              httpError.rtcStatus = response.status
              throw httpError
            }
            var payload = null
            try {
              payload = JSON.parse(raw)
            } catch (parseError) {
              payload = null
            }
            if (!isObject(payload)) {
              var shapeError = new Error('Unexpected cancel payload')
              shapeError.rtcCode = 'cancel'
              throw shapeError
            }
            return payload
          })
        }).then(function applyCancelResult(payload) {
          if (payload.ok === false || payload.cancelled === false) {
            setCancelState({
              busy: false,
              error: { key: 'cancel.declined', params: { reason: asString(payload.reason) || t('common.unknown') }, detail: '' },
              result: null
            })
            return
          }
          setCancelState({ busy: false, error: null, result: { key: 'cancel.done', params: {} } })
          if (onDoneRef.current !== null) onDoneRef.current()
        }).catch(function handleCancelFailure(error) {
          setCancelState({ busy: false, error: describeError(error), result: null })
        })
      }, [cycleId])
      return { state: cancelState, requestCancel: requestCancel }
    }

    function useReviewState() {
      var statePair = React.useState({ status: 'loading', data: null, error: null, lastOkAt: 0 })
      var state = statePair[0]
      var setState = statePair[1]
      var retryPair = React.useState(0)
      var retryNonce = retryPair[0]
      var setRetryNonce = retryPair[1]
      var refreshRef = React.useRef(null)
      var refresh = React.useCallback(function refreshNow() {
        if (refreshRef.current !== null) refreshRef.current()
        else setRetryNonce(function bumpRetry(value) { return value + 1 })
      }, [])

      React.useEffect(function startPolling() {
        var alive = true
        var pendingTimer = null
        var controller = null
        var lastCycles = null

        function clearPendingTimer() {
          if (pendingTimer !== null) {
            clearTimeout(pendingTimer)
            pendingTimer = null
          }
        }

        function pageHidden() {
          try {
            return typeof document !== 'undefined' && document.visibilityState !== 'visible'
          } catch (error) {
            return false
          }
        }

        function scheduleNext() {
          if (!alive) return
          clearPendingTimer()
          if (pageHidden()) return
          var delay = cyclesHaveRunningRound(lastCycles) ? POLL_ACTIVE_MS : POLL_IDLE_MS
          pendingTimer = setTimeout(function onPollTimer() {
            pendingTimer = null
            load()
          }, delay)
        }

        function load() {
          if (!alive) return
          if (pageHidden()) {
            scheduleNext()
            return
          }
          if (controller !== null) {
            try { controller.abort() } catch (error) { /* already settled */ }
          }
          controller = null
          try {
            if (typeof AbortController === 'function') controller = new AbortController()
          } catch (error) {
            controller = null
          }
          var requestController = controller
          var options = { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store' }
          if (requestController !== null) options.signal = requestController.signal
          fetch(STATE_URL, options).then(function readResponse(response) {
            return response.text().then(function parseBody(raw) {
              if (!response.ok) {
                var httpError = new Error('HTTP ' + response.status)
                httpError.rtcCode = 'http'
                httpError.rtcStatus = response.status
                throw httpError
              }
              try {
                return JSON.parse(raw)
              } catch (parseError) {
                var jsonError = new Error('Invalid JSON payload')
                jsonError.rtcCode = 'invalid-json'
                throw jsonError
              }
            })
          }).then(function applyPayload(payload) {
            if (!alive) return
            if (requestController !== null && requestController.signal.aborted) return
            var normalized = normalizeState(payload)
            if (!normalized.ok) {
              setState(function keepData(previous) {
                return {
                  status: 'offline',
                  data: previous.data,
                  error: { key: 'error.payload', params: {}, detail: normalized.error || '' },
                  lastOkAt: previous.lastOkAt
                }
              })
              return
            }
            lastCycles = normalized.cycles
            setState({ status: 'online', data: normalized, error: null, lastOkAt: Date.now() })
          }).catch(function handleFailure(error) {
            if (!alive) return
            if (requestController !== null && requestController.signal.aborted) return
            setState(function keepData(previous) {
              return { status: 'offline', data: previous.data, error: describeError(error), lastOkAt: previous.lastOkAt }
            })
          }).then(function scheduleAfterRequest() {
            if (requestController !== null) requestController = null
            scheduleNext()
          })
        }

        function handleVisibilityChange() {
          if (!alive) return
          if (pageHidden()) clearPendingTimer()
          else load()
        }

        refreshRef.current = load
        try {
          document.addEventListener('visibilitychange', handleVisibilityChange)
        } catch (error) {
          /* a host without document simply polls from the timer only */
        }
        load()
        return function stopPolling() {
          alive = false
          refreshRef.current = null
          clearPendingTimer()
          try {
            document.removeEventListener('visibilitychange', handleVisibilityChange)
          } catch (error) {
            /* event target already gone */
          }
          if (controller !== null) {
            try { controller.abort() } catch (error) { /* already settled */ }
            controller = null
          }
        }
      }, [retryNonce])

      return { state: state, refresh: refresh }
    }

    function useLanguageRevision() {
      var pair = React.useState(0)
      var revision = pair[0]
      var setRevision = pair[1]
      React.useEffect(function watchLanguage() {
        function bump() {
          setRevision(function incrementRevision(value) { return value + 1 })
        }
        var unsubscribe = subscribeLanguage(bump)
        var observer = null
        try {
          if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.documentElement) {
            observer = new MutationObserver(bump)
            observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
          }
        } catch (error) {
          observer = null
        }
        return function stopWatching() {
          unsubscribe()
          if (observer) {
            try { observer.disconnect() } catch (error) { /* already disconnected */ }
          }
        }
      }, [])
      return revision
    }

    // ---------------------------------------------------------------------
    // Page. The error boundary keeps a render bug from blanking the host panel.
    // ---------------------------------------------------------------------
    function ConsoleInner() {
      useLanguageRevision()
      var polled = useReviewState()
      var state = polled.state
      var data = state.data

      var searchPair = React.useState('')
      var cycleQuery = searchPair[0]
      var setCycleQuery = searchPair[1]
      var statusPair = React.useState('all')
      var cycleStatus = statusPair[0]
      var setCycleStatus = statusPair[1]
      var sortPair = React.useState('updated-desc')
      var cycleSort = sortPair[0]
      var setCycleSort = sortPair[1]
      var selectionPair = React.useState('')
      var selectedCycleKey = selectionPair[0]
      var setSelectedCycleKey = selectionPair[1]
      var roundPair = React.useState(0)
      var selectedRoundNumber = roundPair[0]
      var setSelectedRoundNumber = roundPair[1]
      var tabPair = React.useState('overview')
      var activeTab = tabPair[0]
      var setActiveTab = tabPair[1]
      var findingsQueryPair = React.useState('')
      var findingsQuery = findingsQueryPair[0]
      var setFindingsQuery = findingsQueryPair[1]
      var findingsSeverityPair = React.useState('all')
      var findingsSeverity = findingsSeverityPair[0]
      var setFindingsSeverity = findingsSeverityPair[1]

      var allCycles = asArray(data && data.cycles).filter(isObject)
      var visibleCycles = sortCycles(filterCycles(allCycles, cycleQuery, cycleStatus), cycleSort)
      var cycleEntries = cycleEntriesFrom(visibleCycles)
      var allEntries = cycleEntriesFrom(allCycles)
      var activeEntry = findCycleEntry(allEntries, selectedCycleKey)
      if (activeEntry === null) activeEntry = allEntries.length > 0 ? allEntries[0] : null
      var activeCycle = activeEntry ? activeEntry.cycle : null
      var activeCycleId = asString(activeCycle && activeCycle.id)
      var roundEntries = sortRoundEntries(activeCycle && activeCycle.rounds)
      var activeRoundEntry = findRoundEntry(roundEntries, selectedRoundNumber)
      var activeRound = activeRoundEntry ? activeRoundEntry.round : null
      var latestEntry = latestRoundEntry(roundEntries)
      var latestRound = latestEntry ? latestEntry.round : null
      var activeBadge = activeCycle ? statusBadge(activeCycle) : null
      var runningRound = activeCycle && cycleHasRunningRound(activeCycle) ? latestRound : null
      var liveProgress = useProgressStream(activeCycleId, activeCycle !== null && runningRound !== null, polled.refresh)
      var mergedProgress = liveProgress !== null && activeCycle !== null && liveProgress.cycleId === activeCycleId
        ? liveProgress
        : progressOf(runningRound || latestRound, activeCycle)
      var diffEnabled = activeTab === 'rounds' || activeTab === 'findings'
      var diffSignature = activeCycle
        ? formatCount(roundEntries.length) + ':' + asString(activeCycle.status)
        : ''
      var diffResult = useCycleDiff(activeCycleId, diffEnabled, diffSignature)
      var cancelResult = useCancelRound(activeCycleId, polled.refresh)

      var statusKey = state.status === 'online' || state.status === 'offline' ? state.status : 'loading'
      var pollingRunning = cyclesHaveRunningRound(allCycles)
      var tabs = [
        { id: 'overview', label: t('tabs.overview') },
        { id: 'rounds', label: t('tabs.rounds') },
        { id: 'findings', label: t('tabs.findings') },
        { id: 'evidence', label: t('tabs.evidence') },
        { id: 'cost', label: t('tabs.cost') },
        { id: 'export', label: t('tabs.export') }
      ]

      function selectCycle(key) {
        setSelectedCycleKey(key)
        setSelectedRoundNumber(0)
      }

      function selectRound(number) {
        setSelectedRoundNumber(number)
      }

      function switchTab(id) {
        setActiveTab(TABS.indexOf(id) >= 0 ? id : 'overview')
      }

      function handleTabKeyDown(event, tabId) {
        if (!event || typeof event.key !== 'string') return
        var index = TABS.indexOf(tabId)
        var next = null
        if (event.key === 'ArrowRight') next = TABS[(index + 1) % TABS.length]
        else if (event.key === 'ArrowLeft') next = TABS[(index - 1 + TABS.length) % TABS.length]
        else if (event.key === 'Home') next = TABS[0]
        else if (event.key === 'End') next = TABS[TABS.length - 1]
        if (next === null) return
        event.preventDefault()
        switchTab(next)
        try {
          var node = document.getElementById('rtc-tab-' + next)
          if (node && typeof node.focus === 'function') node.focus()
        } catch (error) {
          /* focus is a nicety; tab switching already happened */
        }
      }

      var selectedNumber = activeRoundEntry ? activeRoundEntry.number : 0
      var panel = null
      if (activeCycle !== null) {
        var commonTabProps = {
          cycle: activeCycle,
          entries: roundEntries,
          selectedNumber: selectedNumber,
          onSelect: selectRound,
          diff: diffResult.data,
          diffError: diffResult.error
        }
        if (activeTab === 'rounds') {
          panel = h(RoundsTab, commonTabProps)
        } else if (activeTab === 'findings') {
          panel = h(FindingsTab, {
            cycle: activeCycle,
            entries: roundEntries,
            selectedNumber: selectedNumber,
            onSelect: selectRound,
            round: activeRound,
            noise: noiseInfo(activeRound),
            query: findingsQuery,
            severity: findingsSeverity,
            onQuery: setFindingsQuery,
            onSeverity: setFindingsSeverity,
            diff: diffResult.data
          })
        } else if (activeTab === 'evidence') {
          panel = h(EvidenceTab, {
            cycle: activeCycle,
            entries: roundEntries,
            selectedNumber: selectedNumber,
            onSelect: selectRound,
            round: activeRound
          })
        } else if (activeTab === 'cost') {
          panel = h(CostTab, {
            cycle: activeCycle,
            entries: roundEntries,
            selectedNumber: selectedNumber,
            onSelect: selectRound,
            round: activeRound
          })
        } else if (activeTab === 'export') {
          panel = h(ExportTab, { cycle: activeCycle, entries: roundEntries })
        } else {
          panel = h(OverviewTab, {
            cycle: activeCycle,
            entries: roundEntries,
            selectedNumber: selectedNumber,
            onSelectRound: selectRound,
            progress: mergedProgress,
            cancel: cancelResult.state,
            onCancel: function requestCancelForCycle() { cancelResult.requestCancel() }
          })
        }
        panel = h('div', {
          id: 'rtc-panel-' + activeTab,
          className: 'rtc-tabPanel',
          role: 'tabpanel',
          'aria-labelledby': 'rtc-tab-' + activeTab
        }, panel)
      }

      var content = null
      if (allCycles.length > 0 && activeCycle !== null) {
        var cycleChips = []
        cycleChips.push(h('span', { className: 'rtc-chip', key: 'rounds' }, t('cycles.badge.rounds', { count: formatCount(roundEntries.length) })))
        if (activeBadge && activeBadge.profile) cycleChips.push(h('span', { className: 'rtc-chip', key: 'profile' }, profileLabel(activeBadge.profile)))
        if (activeBadge && activeBadge.reopenCount > 0) cycleChips.push(h('span', { className: 'rtc-chip', key: 'reopen' }, t('cycles.badge.reopen', { count: formatCount(activeBadge.reopenCount) })))
        cycleChips.push(h('span', { className: 'rtc-chip rtc-mono', key: 'created' }, t('overview.createdLabel') + ' ' + formatTimestamp(activeCycle.createdAt)))
        cycleChips.push(h('span', { className: 'rtc-chip rtc-mono', key: 'updated' }, t('overview.updatedLabel') + ' ' + formatTimestamp(activeCycle.updatedAt)))
        if (asString(activeCycle.id)) cycleChips.push(h('span', { className: 'rtc-chip rtc-mono rtc-break', key: 'id' }, asString(activeCycle.id)))
        content = h('div', { className: 'rtc-layout' },
          h(CycleList, {
            entries: cycleEntries,
            activeKey: activeEntry.key,
            onSelect: selectCycle,
            query: cycleQuery,
            onQuery: setCycleQuery,
            statusFilter: cycleStatus,
            onStatus: setCycleStatus,
            sortMode: cycleSort,
            onSort: setCycleSort,
            visibleCount: cycleEntries.length,
            totalCount: allCycles.length
          }),
          h('main', { className: 'rtc-main' },
            h('section', { className: 'rtc-card rtc-cycleHeader' },
              h('div', { className: 'rtc-rowBetween' },
                h('div', { className: 'rtc-heading' },
                  h('h2', { className: 'rtc-title rtc-titleSmall' }, asString(activeCycle.title) || asString(activeCycle.target) || asString(activeCycle.id) || t('common.unknown')),
                  h('p', { className: 'rtc-subtitle rtc-mono rtc-break' }, t('cycles.target', { path: asString(activeCycle.target) || t('common.unknown') }))),
                h('span', { className: 'rtc-statusTag', 'data-tone': activeBadge.status }, t(activeBadge.labelKey))),
              h('div', { className: 'rtc-chips' }, cycleChips)),
            h(TabBar, { tabs: tabs, active: activeTab, onChange: switchTab, onKeyDown: handleTabKeyDown }),
            panel,
            h(FooterMeta, { data: data, cycle: activeCycle })))
      } else if (state.status === 'loading') {
        content = h(LoadingState)
      } else {
        content = h(EmptyState)
      }

      return h('div', { className: 'rtc-root', 'data-rtc-root': 'true' },
        h('header', { className: 'rtc-header' },
          h('div', { className: 'rtc-heading' },
            h('h1', { className: 'rtc-title' }, t('app.title')),
            h('p', { className: 'rtc-subtitle' }, t('app.subtitle'))),
          h('div', { className: 'rtc-headerTools' },
            h('span', {
              className: 'rtc-status',
              role: 'status',
              'aria-live': 'polite',
              'aria-label': t('status.aria', { state: t('status.' + statusKey) })
            },
              h('span', { className: 'rtc-dot', 'data-state': statusKey, 'aria-hidden': 'true' }),
              h('span', null, t('status.' + statusKey)),
              h('span', { className: 'rtc-count' }, t('status.autoRefresh', { seconds: formatCount(pollingRunning ? POLL_ACTIVE_MS / 1000 : POLL_IDLE_MS / 1000) }))),
            h('button', {
              type: 'button',
              className: 'rtc-btn',
              onClick: polled.refresh,
              'aria-label': t('status.refreshAria')
            }, t('status.refresh')))),
        state.error ? h(ErrorBar, { error: state.error, onRetry: polled.refresh }) : null,
        content)
    }
    class ConsoleBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
        this.handleRetry = this.handleRetry.bind(this)
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        try {
          console.error('[adversarial-review] console render failed', error)
        } catch (loggingError) {
          /* console unavailable */
        }
      }

      handleRetry() {
        this.setState({ failed: false })
      }

      render() {
        if (!this.state.failed) return this.props.children
        return h('div', { className: 'rtc-root' },
          h('section', { className: 'rtc-empty' },
            h('h2', { className: 'rtc-emptyTitle' }, t('error.boundaryTitle')),
            h('p', { className: 'rtc-emptyText' }, t('error.boundaryHint')),
            h('button', { type: 'button', className: 'rtc-btn', onClick: this.handleRetry, 'aria-label': t('status.retryAria') }, t('status.retry'))))
      }
    }

    function ConsolePage() {
      return h(ConsoleBoundary, null, h(ConsoleInner))
    }

    // ---------------------------------------------------------------------
    // Plugin wiring: optional locale dictionaries, one stylesheet, two slots.
    // ---------------------------------------------------------------------
    function applyLocale(locale, scope) {
      if (!locale) return
      currentLocale = locale
      try {
        if (typeof locale.register === 'function') {
          var register = function registerDictionaries() {
            return locale.register(NS, { zh: TEXT.zh, en: TEXT.en })
          }
          if (scope && typeof scope.effect === 'function') scope.effect(register, 'adversarial-review: dictionaries')
          else register()
        }
      } catch (error) {
        console.error('[adversarial-review] dictionary registration failed', error)
      }
      try {
        if (typeof locale.subscribe === 'function') {
          var subscribe = function subscribeLanguageChanges() {
            return locale.subscribe(notifyLanguageChange)
          }
          if (scope && typeof scope.effect === 'function') scope.effect(subscribe, 'adversarial-review: language changes')
          else subscribe()
        }
      } catch (error) {
        console.error('[adversarial-review] language subscription failed', error)
      }
      notifyLanguageChange()
    }

    function bindLocale(ctx) {
      var locale = null
      try {
        locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : null
      } catch (error) {
        locale = null
      }
      if (locale) {
        applyLocale(locale, ctx)
        return
      }
      try {
        if (ctx && typeof ctx.inject === 'function') {
          ctx.inject(['locale'], function onLocaleReady(scope) {
            try {
              applyLocale(scope && scope.locale, scope)
            } catch (error) {
              console.error('[adversarial-review] late locale wiring failed', error)
            }
          })
        }
      } catch (error) {
        /* the locale service is optional; the embedded dictionaries still work */
      }
    }

    function registerConsole(ctx) {
      return function runRegistration() {
        var cleanups = []
        var cssDispose = null
        try {
          cssDispose = insertCss(CSS)
        } catch (error) {
          console.error('[adversarial-review] stylesheet injection failed', error)
        }
        if (typeof cssDispose === 'function') cleanups.push(cssDispose)

        bindLocale(ctx)

        try {
          var slots = ctx && ctx.slots
          if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
            cleanups.push(slots.inject('sidebar.panellist', function registerSidebarRow() {
              return slots.register({
                name: 'sidebar.panellist',
                id: 'adversarial-review',
                order: 30,
                label: function sidebarRowLabel() { return t('entry.label') }
              }, PanelIcon)
            }))
            cleanups.push(slots.inject('main', function registerMainPage() {
              return slots.register({ name: 'main', key: 'adversarial-review' }, ConsolePage)
            }))
          } else {
            console.error('[adversarial-review] slots service unavailable; console page not registered')
          }
        } catch (error) {
          console.error('[adversarial-review] slot registration failed', error)
        }

        return function disposeRegistration() {
          for (var i = cleanups.length - 1; i >= 0; i -= 1) {
            try { cleanups[i]() } catch (error) { /* disposer already ran */ }
          }
          cleanups.length = 0
          currentLocale = null
          notifyLanguageChange()
        }
      }
    }

    function apply(ctx) {
      var effectBody = registerConsole(ctx)
      try {
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(effectBody, 'adversarial-review: console registration')
          return
        }
      } catch (error) {
        console.error('[adversarial-review] ctx.effect unavailable', error)
      }
      effectBody()
    }

    return {
      inject: ['slots'],
      apply: apply
    }
  }
})
