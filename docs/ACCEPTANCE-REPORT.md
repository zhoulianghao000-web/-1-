# 红队评审台验收报告（ACCEPTANCE REPORT）

> 依据 [UPGRADE-PLAN.md](UPGRADE-PLAN.md) 的分阶段计划执行；每阶段通过门禁后在此追加记录。
> 当前版本：**2.0.0**（评分口径 2026-10-v2，rubricVersion v2-100）；基线版本：1.0.0（10 分制）。

## 验收环境

- Harness profile：`desktop`（DSH_PROFILE=desktop）
- 工作区：`C:\Users\zl\Documents\deepseek-harness\default-workspace`
- 平台：Windows；无头浏览器：`chrome-headless-shell`（完整 Chrome/Edge 在 Host 会话挂起）
- 状态目录：`$DSH_HOME/adversarial-review`（本机 `C:\Users\zl\.dsh\adversarial-review`；v1.1 已从 workspace 迁移，旧副本归档在 `.backup/`）
- 备份：`.backup/phase0-<timestamp>/`（state + shots + 插件源码）、迁移者 TEMP 备份
- 测试命令：
  - `node test/run-all.mjs`
  - `node --test --experimental-test-isolation=none <test/*.test.mjs>`
  - `node --check`（全部 JS/MJS）

---

## Phase 0：基线冻结与 100 分制上线验收

状态：**PASS（待用户 H1 刷新 GUI 目视确认）**

| 检查项 | 结果 | 证据 |
|---|---|---|
| 工作区备份（state/shots/插件源码） | ✅ | `.backup/phase0-20261018-151236/`（原始 v1 state 保留：schemaVersion=1，scores=6/8.5/8.5/8.5/9.5） |
| 100 分制代码迁移 | ✅ | 18 文件；`STATE_SCHEMA_VERSION=2`；`RUBRIC_VERSION='v2-100'`；`LEGACY_RUBRIC_VERSION='legacy-10'` |
| Host 单测 | ✅ 86/86 | `node test/run-all.mjs`：`# tests 86 / # pass 86 / # fail 0` |
| 含客户端契约全量测试 | ✅ 95/95 | `node --test --experimental-test-isolation=none ...`：`# pass 95 / # fail 0` |
| `node --check` | ✅ 0 failures | 全部 14 个改动 JS + 测试文件 |
| 零依赖扫描 | ✅ | `dependencies/devDependencies/peerDependencies = {}`；host 仅 import 相对模块与 `node:` 内置 |
| secret 扫描 | ✅ | 唯一命中为 `client-logic.test.mjs:84` 的静态禁用词正则本身，非凭据 |
| 文档同步 | ✅ | README/CONTRACT/UPGRADE-PLAN 改 100/95、schema v2、历史迁移说明；`docs/ACCEPTANCE-REPORT.md` 建立 |
| 版本号 | ✅ 1.1.0 | `package.json`（安装结果 `version: 1.1.0`, `application: applied`） |
| 插件重装 | ✅ | `remove_bundle` → `install_bundle`，`application: applied`；两个 preset 行存在；Client `sidebar.panellist` occupant `adversarial-review` active |
| live state v1→v2 迁移 | ✅ | 磁盘 `schemaVersion=2`；5 轮 = **60 / 85 / 85 / 85 / 95**；`required.score=95`；`rubricVersion=legacy-10`；R5 `gate.passed=true`；R1–R4 按新门控失败（含 supported 阻断项原因） |
| 100 分制实跑一轮 | ✅ | cycle `c-mvdhqft6-5qzz1y`（target=`demo-tarot-app-r100`）：4 张截图 1440×900×3 + 390×844；红队 5 条 MINOR；判官输出 **92.5 / 100**；`gate.requiredScore=95`；`mustFix=[]`；failReasons=["评分 92.5 < 要求 95"]；证明 0–100 与 95 线真实生效（5 MINOR × 2.5 封顶 7.5 → 92.5 < 95） |
| GUI 刷新目视确认 | ⏳ 待用户 H1 | 面板侧栏入口已注册；新 Client Bundle 需刷新页面加载 100 分制文案 |

### 门禁 G0

- [x] 重装后 `application: applied`，工具/预设/Client 面板存在
- [x] live state `schemaVersion=2`，5 轮 = 60/85/85/85/95，R5 passed，`rubricVersion` 正确
- [x] 实跑轮分数/门控使用 0–100、95 线（92.5 fail）
- [x] 全部测试绿 + 零依赖 + secret 扫描通过
- [ ] **用户刷新 GUI 确认显示 100 分制**（H1，唯一未完成项）

### 备注

- 实跑副本 `demo-tarot-app-r100/` 保留作为 Phase 0 验收证据；其 5 条 MINOR 未修（无需修，仅用于验证评分链路）。
- live state 现有 2 个 cycle：原 demo（已通过，历史迁移）与 100 分制验收副本（92.5，未通过）。
- HTTP `GET /adversarial-review/state` 的顶层 `version:1` 是公共 API 版本，不是 state schemaVersion；state schema 以磁盘文件 `schemaVersion=2` 为准。

---

## v1.1 可信与防作弊地基

状态：**PASS（G1 通过；Stage 1–3 完成，测试 175/175、184/184；唯一遗留为用户 GUI 目视确认 H1）**

| 任务 | 状态 | 证据 |
|---|---|---|
| 1.1 审计记录（promptHashes/modelRoute/rawScore/judgeRaw/judges[]/judgeSessionIds） | ✅ | state round 新增字段；旧 v2 round 兼容回退；host 测试 103/103 |
| 1.2 双判官（judgeSamples 1–3、独立会话、保守聚合、disagreement） | ✅ | `aggregateJudgeScores`：中位/偶数取低、mustFix 并集、supported 最小值、blockingFindings 并集、disagreement 标记；完整测试 112/112 |
| 1.2 实跑验证 | ✅ | `demo-tarot-app-r100` 第 2 轮：judges=2（均 92.5）、聚合 92.5、disagreement=false、promptHashes/rawScore/judgeRaw 落库、judgeMs=366s（≈2×） |
| 1.3 快照 + 交付绑定 + guard 重写 + 并发锁 | ✅ | `lib/snapshot.js` 异步/同步同哈希；每轮记录 `snapshot`；`present` 项目级跨会话 + 通过后快照一致性；每交付根并发锁；guard 矩阵 6 类用例 |
| 1.4 防篡改（state 外置/哈希链/secret 脱敏/URL 白名单） | ✅ | stateDir 默认 `$DSH_HOME`；顶层 sha256 哈希链（篡改→quarantine）；截图 sha256；`lib/redact.js` 入库脱敏；`shots.url` loopback/`allowedOrigins`；live state 已迁到 `C:\Users\zl\.dsh\adversarial-review`（29 文件）并补封 |
| 1.3/1.4 实跑验证 | ✅ | r4：4 张截图带 sha256、snapshot=17 文件、integrity 有值、双判官 85/82.5→聚合 82.5、disagreement.mustFixMismatch=true；`present` r100 文件被拒 |
| 1.5 评审者硬只读 + `review_probe` | ✅ | 两套 preset 已移除 `tool-pwsh/tool-bash/tool-web`；`review-registry` 登记评审 child；guard 拒绝危险工具、fs 读取限制 target+本轮 evidenceDir；`review_probe` 非评审调用被拒（实测 Lead 调用返回「仅限评审子智能体使用」）；run-tests 在只读临时副本（实测 Windows npm.cmd 回退 cmd.exe，2948ms，副本清理） |
| 1.6 注入防护 + 校准集 v0 | ✅ | `<UNTRUSTED_EVIDENCE>/<UNTRUSTED_CONTEXT>` 围栏 + 转义闭合标签；判官证据权威性规则；`benchmarks/injection-web` + `known-bugs-web` + labels + `runner.mjs`（gate 预期 ✓） |
| 1.5/1.6 live 注入验收 | ✅ | `injection-web` 第 1 轮（修证据读取前）：红队识别注入并拒绝执行、判官独立支持、60/100 BLOCK；第 2 轮（修证据读取后）：红队能逐张引用 4 张截图（含 sha256/加载中状态），双判官 60/40 → 聚合 40、disagreement=true、gate fail；`review_probe` 被红队实际用于 check-syntax/run-tests |
| 证据读取缺口修复 | ✅ | Stage 3 首版 guard 只允许读 target，导致评审者看不到 stateDir 里的 4 张证据图。已加 `evidenceDir`（本轮 cycle shots 目录）白名单：可读本轮截图，仍拒绝 stateDir 其他部分/其他 cycle/其他项目；新增单测；重装后 live 注入轮验证红队成功引用截图（测试 175/175、184/184） |
| 证据链事故记录 | ℹ️ | 迁移后 workspace 残留旧 `.adversarial-review` 副本，曾导致 r3 误读旧截图（50 分）。已归档 `.backup/legacy-workspace-state-20261018-163423/`；r4 重跑恢复 82.5；该教训已固化进 1.6 的「证据 manifest 权威性」提示词 |

### 门禁 G1

- [x] 1.1 审计字段落库（promptHashes/modelRoute/rawScore/judgeRaw/judges[]）
- [x] 1.2 双判官 + 保守聚合 + disagreement 标记（单测 + live）
- [x] 1.3 快照/交付绑定/项目级 guard/并发锁（单测矩阵 + live guard 拒绝）
- [x] 1.4 state 哈希链/截图 sha256/脱敏/URL 白名单（单测 + live integrity）
- [x] 1.5 评审者无 shell/网络、review_probe 白名单、证据可读、越界拒绝（单测 + live）
- [x] 1.6 注入防护 + 校准集 v0（单测 + live 注入轮不通过、未执行注入）
- [x] 全量测试 175/175（Host）+ 184/184（含客户端契约）；`node --check` 0 失败；零依赖不变
- [ ] 用户刷新 GUI 目视确认（H1，与 Phase 0 合并检查）

> 已知风险：双判官串行使判官阶段约 2×（默认 judgeSamples=2，可设 1）；工具超时 3600s 覆盖最坏 1 attacker + 3 judges × 900s（45min < 60min）；模型路由仅传 id；`review_probe run-tests/run-metrics` 依赖项目自带命令，在临时副本用白名单 env 执行（逻辑沙箱非 OS 级，恶意项目脚本仍可能读写本地文件）；评审者 fs 路径已做 realpath 校验，快照拒绝符号链接项目；哈希链无密钥，有写权限者可重算整链（后续 HMAC 阶段）。

---

## v1.2 运行证据与领域包（先游戏后建模）

状态：**PASS（G2a 游戏 + G2b 建模均通过；测试 252/252、261/261）**

| 任务 | 状态 | 证据 |
|---|---|---|
| 2.1 Evidence 框架 | ✅ | `lib/evidence.js`：每轮恰好 4 张卡（screenshot/interaction），卡内多 artifact（PNG+JSON 摘要），全部 sha256；旧 `shots` 自动映射为 4 张 screenshot 卡；`round.shots` 保留 4 张代表图（门控/HTTP/旧 UI 不变），`round.evidence` 记录 artifacts/meta；上限 24 artifacts；清理仅删本轮 `r<N>-*` |
| 2.2 零依赖 CDP runner | ✅ | `lib/cdp.js` 以 `chrome-headless-shell --remote-debugging-pipe` 实现（Node 内置 pipe，无新依赖）：createTarget/attach、导航+rAF、click/key、captureScreenshot、console/network/perf+fps；每卡 60s 双层超时、kill 进程树、临时目录清理；真实 smoke 三阶段 PASS（单卡 2.7s / 4 卡混合 6.1s / 旧 shots 6.4s） |
| 2.3a 游戏 rubric | ✅ | `rubrics/game.md`（核心循环/状态机、数值经济与概率、存档、输入与可访问性、资源完整性、性能预算、多人网络、合规；乐趣类不进自动分）；`profile` 配置 + round 级覆盖（`profile:"game"`），写入 round 审计；prompt 注入可信 rubric 区 |
| 2.5 游戏靶子（Stage B） | ✅ | `benchmarks/game-seeded/`：离线可玩 DOM 游戏「月影竞技场」，8 个种子缺陷（重启软锁/HP 负数/掉率 50% vs 20%/存档丢字段/前端 key/坏图/键盘陷阱/perf jank），8 条 labels 按 path:line 校验命中；4 张 evidence 卡（2 interaction + 1 screenshot + 1 interaction），含 console/network/perf |
| 游戏 live 验收（G2a） | ✅ | live 轮：`profile=game`，4 卡真实渲染（代表图 4 张 + 额外帧，artifactCount=5；consoleErrors=7、networkFailures=8、E1 fps=60.31）；红队命中 **8/8 种子缺陷**（BLOCKER 软锁/前端 key + MAJOR 6 条），双判官 60/60 BLOCK、gate 60/100 fail（必须修）；`disagreement.mustFixMismatch=true` |
| 校准统计 | ✅ | `benchmarks/results/game-seeded.json` + runner：**recall 100%（8/8）、precision 100%、gate 符合预期 false**；injection-web 仍 gate false 符合预期 |
| 证据可读性修复 | ✅ | Host manifest 新增 reviewer-only `filePath`（本轮证据绝对路径，进 prompt 不进 compact/public；guard 仅放行本轮 evidenceDir）；G1 label 接受 164–166 行号范围；单测更新；live 建模轮已验证评审者能按 manifest 路径查看/引用证据 |
| 2.3b 建模 rubric + 证据扩展 | ✅ | `rubrics/modeling.md`（可复现性/数据泄漏/指标正确性/基线消融/tuning-on-test/PII/图表-表格一致性/notebook 顺序/计算预算；泄漏与造假=BLOCKER，新颖性不进自动分）；`profile:"modeling"` 注入；新增 evidence kinds：`image`（项目 PNG 原样入证据目录、实际尺寸+sha256）与 `pdf-text`（`lib/pdf.js` 零依赖经典 PDF 文本抽取 → 转义 HTML 渲染代表 PNG + `.txt` 全文，≤50 页/200KB） |
| 2.4 建模沙箱执行 | ✅ | `review_probe run-metrics`（`lib/sandbox.js`）：读取项目 `modeling-run.json` 声明命令，在**只读临时副本**中无 shell 顺序执行、离线 env、每命令 120s/总 600s 超时、kill 进程树、输出 4000 尾截断、读回 `metricsFile`（≤64KB），target 永不写、finally 清理；非 OS 级沙箱（env 断网+cwd 隔离），文档已标注 |
| 2.5 建模靶子（Stage D） | ✅ | `benchmarks/modeling-seeded/`：纯 stdlib 客户流失预测项目，8 个种子缺陷（M1 预处理泄漏、M2 时序泄漏、M3 指标 0.95 vs 0.85、M4 无 baseline、M5 无种子不可复现、M6 图表硬编码、M7 row_id 泄漏、M8 无显著性检验），8 条 labels、4 张 evidence 卡（image×2 + pdf-text + screenshot）、`modeling-run.json` |
| 建模 live 验收（G2b） | ✅ | live 轮 `profile=modeling`：4 卡真实渲染（metrics-chart 960x560、paper.pdf 抽取渲染 1200x1600 第 1/2 页、report 1440x1000、confusion 760x560；artifactCount=5）；红队两次调用 `run-metrics`（python 真实执行 exit 0，metrics 0.87/0.79 与仓库 0.85、宣称 0.95 不一致）并命中 **8/8 种子缺陷**；双判官 42.5/39 → 聚合 39 BLOCK、gate fail（BLOCKER 6/MAJOR 10 有效发现）、disagreement=true |
| 校准统计（三 fixture） | ✅ | runner：game-seeded **recall 100% / precision 100%**、modeling-seeded **100% / 100%**（M5 标签接受 19/22 行号后）、injection-web gate false；三 fixture `gatePassed` 全部符合预期 |

### 门禁 G2（游戏 + 建模）

- [x] 每轮恰好 4 张 evidence 卡；interaction 卡多状态帧 + console/network/perf；image/pdf-text 卡真实产物 + sha256
- [x] 零依赖 CDP runner 真实操作页面；PDF 零依赖文本抽取并渲染证据页
- [x] `run-metrics` 沙箱在临时副本真实执行声明命令、读回指标、target 不变
- [x] 游戏/建模 rubric 按 profile 注入，round.profile 审计可追溯
- [x] 两个种子靶子各 8 缺陷、live recall ≥80%（均 100%）、precision ≥80%（均 100%）、gate 均 BLOCK 符合预期
- [x] 旧 `shots`/旧 state/UI/门控兼容；测试 252/252 Host、261/261 含客户端契约；零依赖不变

---

## v1.3 工作流与运维（无人工裁决）

状态：**PASS（G3 通过；测试 291/291 Host、319/319 含客户端契约；UI 视觉需用户刷新 H1）**

| 任务 | 状态 | 证据 |
|---|---|---|
| 3.1 自动降噪 | ✅ | `lib/noise.js` findingKey（标题归一化+首个 path:line）、supported>severity>证据长度去重、mustFix 去重、上轮 known findings 注入红队/判官 prompt（untrusted 围栏）；attack/judge 去重后计数进 gate；round.noise 审计（raw/deduped/suppressed/knownRepeats）。live 复评轮：7 raw/7 deduped，gate findings=7（修复了首轮误归零回归） |
| 3.2 reopen / incremental | ✅ | `mode:"fresh"|"reopen"|"incremental"`；reopen/incremental 从最近 passed cycle 创建新 cycle（reopenedFrom/reopenCount/maxRounds 重置）；每轮写 snapshot 文件清单 `snapshots/<cycleId>/r<N>.json`，incremental 对比 changed/added/removed（cap 200，truncated/fullReview 降级）；live：cycle c-mvdqe9qw 由 passed c-mvd9l400 reopen（reopenCount=2），R1 mode=incremental/fullReview=true（旧轮无 filesFile 的降级路径），R2/R3 快照文件清单已落盘 |
| 3.3 只读 UI 运维 | ✅（代码） | client.js 188KB：cycle 搜索/状态筛选/排序、6 个 lazy tabs（概览/轮次/发现/证据/成本/导出）、SSE 进度 + 取消、round diff 徽标（new/repeat/fixed/severity-changed）、证据浏览（代表图 + 额外帧 + text/PDF 文本 artifact）、成本面板、MD/JSON 导出、session id 审计；无 accept/reject/waive；locale 中英 279 键一致；client 测试 28/28 |
| 3.4 并发 / 成本 / 批量 | ✅ | 每交付根锁保留；round.cost（total/evidence/attack/judge ms、prompt/response chars、judgeSamples、artifactCount）；`adversarial_review_batch`（2–10 target 顺序执行、失败继续、汇总）；guard 按 deliverableRoot 取最新 cycle |
| 运维 API（live 实测） | ✅ | `GET /diff`（cycle c-mvdqe9qw：3 rounds / 16 changes）；`GET /export?format=md|json`（attachment，12KB md，无绝对路径）；`GET /artifact`（text/plain artifact）；`GET /progress` SSE（done 事件，text/event-stream）；`POST /cancel`（空闲返回 cancelled:false）；旧 /state /shot 保持 GET-only |
| 状态 v3 迁移（live） | ✅ | 5 cycles v2→v3 additive 迁移 + `state.json.pre-v3-*` 备份 + re-seal；现 schema=3/integrity=true/7 cycles；旧轮新字段为 null；快照文件清单只写 stateDir，target 未写 |
| 回归修复（Lead live 集成） | ✅ | ① 自动探测截图相对路径未归一化 → file:// 指错目录（ERR_FILE_NOT_FOUND）；修复后 live R3 自动探测 4 视口全部渲染成功。② v1.3 去重把 supportedCount 误算为 validFindings.supported 纯计数，判官只把 MAJOR 放进 blockingFindings 时 gate 归零；修复为「supported validFindings ∪ blockingFindings」按 findingKey 去重计数，并加双判官回归测试；live R3 supported=7/findings=7。③ tool 输出 schema 不接受 null → compact result 省略 null 可选字段 |
| guard 最新 cycle | ✅ | 旧 passed cycle 存在时，present demo/index.html 被最新 reviewing cycle（80/95）拒绝；不再被旧 passed 覆盖 |

### 门禁 G3

- [x] 自动降噪（重复 finding/mustFix 抑制 + 上轮已知问题注入）有单测与 live 数据
- [x] reopen/incremental 生命周期、快照文件清单、变更 diff、fullReview 降级有单测与 live cycle
- [x] 只读 UI 运维（进度 SSE/取消/diff/证据/成本/导出/搜索筛选）实现且 client 测试 28/28
- [x] cost 审计、批量工具、最新-cycle guard 有单测
- [x] state v3 迁移 live 验证（备份 + integrity + 旧轮兼容）
- [x] 全量测试 **338/338** Host、**366/366** 含客户端；`node --check` 0 失败；零依赖不变
- [ ] 用户刷新 GUI 目视确认新 UI（H1）

---

## v2.0 可信评分体系与最终验收

状态：**实现/测试/校准 PASS（G4 基础项通过）；最终自评审 gate 未取得（见「自评审记录」），因此不宣布交付 PASS**

| 任务 | 状态 | 证据 |
|---|---|---|
| 4.1 基准集与校准 | ✅ | `benchmarks/` 共 **20 个项目**（4 种子 + 16 corpus 微基准）：web×7、game×4、modeling×3、injection×2 生成语料 + 既有 4 个；标签合计 **82 条** path:line；`corpus/generate.mjs` 确定性生成/`--check` 字节一致（聚合 SHA256 `75c18ea5…f801`）；`calibrate.mjs` 输出逐 fixture recall/precision/gate + 汇总 |
| 4.1 live 校准结果 | ✅ | 5 个真实跑过的 fixture（game-seeded / modeling-seeded / injection-web / known-bugs-web / corpus-web-landing）：**recall 100%、precision 92%、gate 符合预期 5/5**；meanScore 47.8、median 45、stdev 9.3、CI95 [40.6,55]；全部预期 gate=false（故意含缺陷），分数用于门控而非人类质量分 |
| 4.2 多判官/多模型统计 | ✅ | `judgeSamples` 1–3 + `judgeModels`（≤3，逐样本 provider/model/reasoningEffort，严格校验、回退继承）；`scoreStats`（mean/median/stdev/min/max/CI95，固定种子 bootstrap 2000 次）+ `ci95`；`judges[].modelRoute`/`round.modelRoute.samples` 审计；保守聚合与 95 门控不变（CI 不用于放行） |
| 4.3 漂移监控 | ✅ | `lib/drift.js` + `benchmarks/drift.mjs`：分数/recall/通过率阈值（5 / 0.1 / 0.1）、缺失 fixture 告警、drift exit 1；`benchmarks/baseline.json` 由 5 个 live fixture 生成，当前 drift 检查**无漂移**；`rubricVersion` 每轮绑定 + `SCORING_RUBRIC_VERSION=2026-10-v2` |
| 评分口径发布 | ✅ | `docs/SCORING-RUBRIC.md`：总分/95 线/门控/manual caps/判官聚合/多模型/证据/领域 profile/降噪/校准漂移/已知限制 |
| 版本与测试 | ✅ | v2.0.0；Host **338/338**、含客户端契约 **366/366**；`node --check` 0 失败；零依赖不变 |
| 最终验收残留 | ℹ️ | 真实项目未提供 → live 仅 5/20 fixture、无人工评分标签（Spearman 未达成）；单模型 provider → 多模型仅机制；labels 位于被评审目录（合成语料）；H1 UI 目视未确认；自评审 gate 未取得（基础设施失败，见下节） |

### 门禁 G4（最终）

- [x] 20 项目校准语料（含注入/对抗样本）可确定性重建 + 标签准确
- [x] 校准脚本输出 recall/precision/分数偏差/方差/CI/gate 一致率
- [x] 多判官（1–3）+ 多模型路由机制 + scoreStats/CI + disagreement
- [x] 漂移脚本 + baseline + 阈值告警 + rubricVersion 绑定
- [x] 评分口径文档发布
- [x] 版本 2.0.0、全量测试 338/338 + 366/366、零依赖
- [ ] 用户刷新 GUI 目视确认（H1）
- [ ] 真实项目/人工标注（H2/H3，用户未提供；无法由 Agent 自行完成）
- [ ] 自评审 gate.passed=true（9 轮发现均已修复；第 10–13 次复评在 attacker 阶段因 stopReason=error / 1500s 超时失败，未取得最终评分）

---

## 自评审记录（self-review，target = 本插件）

对插件自身连续执行 9 轮对抗评审（cycle `c-mvdu0rdq-7ke3nd`，入口 `r2..r9` 证据在 `$DSH_HOME/adversarial-review/shots/`）。每轮判官必须修复项已全部落地：

| 轮次 | gate | 主要发现（均已修复） |
|---|---|---|
| 1–2 | 85 / 60 HOLD | 报告页时序占位、dist 快照缺失、run-all 未含客户端测试、文档/测试计数漂移、校准 MD 过期、blockingFindings 未合并 |
| 3–4 | 77.5 / 57.5 BLOCK | 大文件快照 size+mtime 绕过、失败态仍保留 pass、supported 口径文档不一致、报告页重渲染时序、校准报告一致性、batch 默认值 |
| 5–6 | 60 / 55 BLOCK | reviewer 路径无 realpath（symlink 越权）、`.next` 跳目录绕过、legacy update_goal 放行、review_probe 继承宿主 env/输出未脱敏、metrics symlink |
| 7–8 | 55 / 77.5 BLOCK | reviewer 可调用 round/batch/status、public state 绝对路径文档、符号链接快照策略、deliverableRoots 快照根不一致、childId 缺失时 registry fail-open |
| 9 | 50 BLOCK | 未知工具默认放行（modlens/MCP）、clean-pass 与判官 60 分上限冲突、store 未加载 guard fail-open、文档计数/工具数 |
| 9 后修复 | — | **默认拒绝允许名单**（read/read_image/glob/grep/read_text/review_probe/skill，未知工具一律拒绝）；clean-pass 判官 prompt 例外 + 0 发现/100 分端到端测试；状态未加载 guard fail-closed；deliverableRoots=交付根快照；childId/注册 fail-closed；status 入口校验；文档计数/四工具/run-metrics/public shots 修正 |

第 10–13 次复评（含临时提高超时/单判官）均在 **attacker 子智能体阶段**失败（`stopReason=error` ×2、900s/1500s 超时 ×2），未产生红队报告与判官评分，因此**没有取得最终 gate.passed=true**。

为排除「目标过大」因素，又构建了核心发布快照 `.acceptance/self-review-release/`（104 文件 / ~1.9MB，包含 index/lib/test/client/docs 与 4 个种子 fixture；`node test/run-all.mjs` 在该快照内 **366/366** 通过）并对其发起自评审，attacker 仍返回 `stopReason=error`；随后用最小靶 `benchmarks/injection-web`（4 文件）做基础设施诊断，attacker 同样 `stopReason=error`。因此可判定这是**当前 DSH 子智能体执行环境的模型/进程级故障**（非目标规模、非本轮新发现的项目缺陷）。

按评审台规则，本报告不把自评审标为通过；最终交付 PASS 仍取决于一次成功的自评审（或由用户接受当前校准/验收结果）。失败轮保留在 state（cycles `c-mvdu0rdq-7ke3nd` r10–r13、`c-mve4m4o5-1hojnd` r1、`c-mvdlxmmj-v8gl16` r3）供审计。

## 残余风险与限制

- 完整版 Chrome/Edge 在 Host 会话挂起 → 使用 headless-shell；其他机器按回退链选择。
- 无浏览器控制工具，无法自动截取 Harness GUI 自身；视觉验收依赖用户刷新后目视确认。
- 历史 5 轮由旧 10 分制迁移，文本（rationale 等）保留旧口径，仅数值/门控为 100 制。
- 95 分线 + MINOR 每条 2.5 ⇒ 最多 2 条 MINOR 可通过（3 条 = 92.5 失败）；v2.0 已加 clean-pass（判官明确 0 条 supported + 无阻断 + mustFix 空 + 评分≥95 可通过），1–2 条发现仍失败，见用户决策 H6。
