# 红队评审台（Red-Team Review Console）

给 DeepSeek Harness 的一个持久插件（bundle），把「对抗式挑刺 → 独立打分 → 修复 → 复评」做成可复用闭环：

```
建设者 AI 做项目（任意工作区）
   │
   ├─ adversarial_review_round（Host 工具）
   │    1. Host 用无头 Chrome 渲染恰好 4 张被评审 UI 的证据截图
   │    2. 启动「红队」子智能体（fresh 会话、只读、只证伪）挑刺
   │    3. 启动「判官」子智能体（另一个 fresh 会话，只拿红队报告）打分 0–100
   │    4. 返回 gate：总分 ≥95 + 有效发现 ≥3 + 截图 =4 + mustFix 为空 才 passed
   │
   ├─ 未通过：按判官 mustFix/扣分项修复项目，再次调用工具
   └─ 通过：允许交付/停止
```

## 交付物

| 文件 | 作用 |
|---|---|
| `cordis.patch.yml` | Host 插件行 + 单一统一 Agent 预设（`redteam-console`：主会话可读写/执行；被评审台作为子代理时由 guard 强制只读；红队/判官角色由每轮任务提示区分） |
| `index.js` + `lib/` | Host：子智能体编排、4 张截图渲染、状态持久化、门控 guard、HTTP 数据接口 |
| `client.js` | Web GUI 原生面板：侧栏「红队评审台」+ 整页看板（门控横幅 / 轮次时间线 / 发现 / 评分明细 / 4 张截图） |
| `locale/`、`icon.svg` | 插件元数据与图标（中/英） |
| `CONTRACT.md` | 实现契约（接口、状态模型、门控规则） |
| `docs/UPGRADE-PLAN.md` | 问题清单（S/B/E/G/M/P 六类、带严重度）+ v1.1→v2.0 升级实施计划 |
| `test/` | 纯逻辑单测（`node --test`） |

演示对象是 `../demo-tarot-app/`（一个刻意埋了缺陷的静态站），用来真实跑完整闭环。

## 安装

在 Harness 会话中由具备权限的 Agent 执行：

```
plugin_manager install_bundle, target = C:\Users\zl\Documents\deepseek-harness\default-workspace\redteam-console
```

安装后：

- 侧栏出现「红队评审台」入口，点开是整页看板；
- 新会话的 Agent 预设选择器出现「对抗审查（红队）」「独立评分（判官）」两个独立预设；
- 所有 Agent 的工具列表出现 `adversarial_review_round` / `adversarial_review_status`；评审子智能体另有专属只读工具 `review_probe`（其他 Agent 调用会被拒绝）。

> 本地目录安装是 link 方式：改完代码需要重新 `install_bundle` 才会加载新的 Host 代码；Client 代码刷新页面生效。已有会话保持旧组合。

## 使用（任意项目）

对一个做完的项目执行一轮：

```json
{
  "target": "C:\\path\\to\\your\\project",
  "title": "项目名（可选）",
  "claims": ["README 里宣称做到的事 1", "宣称 2"],
  "focus": ["正确性", "前端密钥", "可访问性"],
  "environment": "可运行已有测试，无需联网",
  "timeBudget": "20 分钟或 40 次工具调用",
  "shots": [
    { "path": "index.html", "width": 1440, "height": 900, "name": "home-desktop" },
    { "path": "shop.html", "width": 1440, "height": 900, "name": "shop" },
    { "path": "reading.html", "width": 1440, "height": 900, "name": "reading" },
    { "path": "index.html", "width": 390, "height": 844, "name": "home-mobile" }
  ]
}
```

- `shots` 必须恰好 4 条（每轮固定 4 张证据截图）；留空则自动探测 `index.html` 等入口并用 4 个视口渲染；完全找不到 Web UI 时，先渲染 4 张中性占位报告页供评审引用，评分结束后用完整本轮结果重新渲染同一批 4 张。
- **`evidence`（v1.2，与 `shots` 二选一）**：恰好 4 张证据卡，`kind` 支持 `"screenshot" | "interaction" | "image" | "pdf-text"`。`interaction` 卡可写 `path`/`url` + `width`/`height` + `steps`（`goto` / `wait` / `click` / `key` / `screenshot`，最多 20 步）+ `collect:{console,network,perf}`，Host 用零依赖 CDP runner 真实操作页面，产出多帧截图与 console/network/perf 摘要；`image` 把项目内 PNG 图表拷入证据目录并校验尺寸/sha256；`pdf-text` 零依赖抽取论文 PDF 指定页文本，渲染成证据页并附 `.txt` 全文。每卡至少 1 张图，门控仍要求 4 张代表图。
- `profile` 支持 `code`（默认）/`web`/`game`/`modeling`，可按轮传参覆盖；`game` 注入游戏 rubric，`modeling` 注入建模 rubric（可复现性/数据泄漏/指标口径/基线/图表一致性等）。建模项目可在根目录放 `modeling-run.json`（声明复现命令 + metricsFile），评审者用 `review_probe run-metrics` 在只读临时副本真实执行并对比指标。
- **生命周期模式（v1.3）**：已通过 cycle 不会就地重审；再次评审用 `mode:"reopen"`（新 cycle、轮数重置）或 `mode:"incremental"`（基于上一通过轮快照只强制检查变更文件 + 回归抽样；无基线文件清单时自动降级全量并 warning）。`adversarial_review_batch` 可一次顺序评审 2–`maxBatchTargets` 个 target，单 target 失败不中断。
- **只读运维看板（v1.3）**：搜索/状态筛选/排序；概览、轮次、发现（降噪 suppressed/mustFix 去重）、证据（代表图 + 额外帧 + PDF 文本 artifact）、成本、导出（MD/JSON）页签；SSE 阶段进度与取消按钮；轮次 diff（new/repeat/fixed/severity-changed）；不提供 accept/reject/waive 人工处置。
- **v2.0 可信评分体系**：`judgeModels` 多模型判官路由（≤3，逐样本审计）、`scoreStats`（mean/median/stdev/CI95 bootstrap）、20 项目校准语料（`benchmarks/`，4 种子 + 16 corpus 微基准，82 条 path:line 标签，`corpus/generate.mjs --check` 可确定性重建）、校准脚本 `node benchmarks/calibrate.mjs`、漂移脚本 `node benchmarks/drift.mjs --baseline benchmarks/baseline.json`；评分口径见 [docs/SCORING-RUBRIC.md](docs/SCORING-RUBRIC.md)，最终验收见 [docs/ACCEPTANCE-REPORT.md](docs/ACCEPTANCE-REPORT.md)。live 校准 5 fixture：recall 100% / precision 92% / gate 一致 5/5，mean 47.8、CI95 [40.6,55]。
- 例：`{"target":"...", "profile":"game", "evidence":[{"kind":"interaction","path":"index.html","steps":[{"action":"goto"},{"action":"click","selector":"#start"},{"action":"screenshot","name":"playing"}],"collect":{"console":true,"perf":true}}, {"kind":"screenshot","path":"index.html","name":"desktop"}, ...]}`。
- 工具返回 `gate`：`passed=false` 时按 `score.mustFix` / `score.deductions[].fix` 修复后再次调用；`passed=true` 才能停。
- 判官独立评分（**默认 2 个独立判官**）：红队看不到判官、判官看不到红队推理、判官之间互不可见、都看不到建设者的上下文；聚合规则是保守的——分数取中位数（偶数取较低值），`mustFix` 取并集，有效发现数取「所有判官都 supported 的交集 ∪ 任一判官 supported 的 BLOCKER/MAJOR 阻断并集」去重后的数量，任一判官认定 supported 的 BLOCKER/MAJOR 都会阻断门控；判官分歧（分差 >5、mustFix/verdict 不一致）记入 `disagreement` 供审计，不改变门控。模型调用全部发生在 Host 侧，**前端不接触任何 API key**。
- 每轮记录审计字段：`rubricVersion`、攻击者/判官 prompt 的 sha256、请求的模型路由（未配置则记录继承）、判官原始分 `rawScore`、判官原始输出摘要、每个判官的独立结果 `judges[]`、`judgeSessionIds[]`。

## 门控规则

`gate.passed === true` 当且仅当：

1. 评分 ≥ `requiredScore`（默认 **95**，满分 100，**只向下取整到 0.5 档**：94.5 → 94.5，永远不会因为取整变成 95）；
2. 有效发现（判官 supported）≥ `requiredFindings`（默认 3）；**例外（v2.0 clean-pass）**：**每个**判官样本都明确报告 0 条 supported、无阻断项、`mustFix` 为空且评分 ≥ `requiredScore` 时，视为项目干净，可通过（避免「3 条 MINOR 必然 92.5」与 95 线的数学矛盾；任一样本有 1–2 条发现不适用，避免一个干净判官抹掉另一个判官的发现）；
3. 本轮截图数 = `requiredShots`（默认 4，且是真实可解析 PNG）；
4. 判官 `mustFix` 为空——**mustFix 只包含 BLOCKER/MAJOR 级阻断项**；
5. 判官没有任何 `supported` 的 **BLOCKER 或 MAJOR** 阻断项（评分再高也不能放行）。

评分口径：**95/100** 表示「没有阻断项（无 BLOCKER/MAJOR 残留）且证据充分」，允许保留少量已披露的 MINOR 并小幅扣分（每条 **2.5**，合计 ≤**7.5**）。因此 95 分线最多容忍 2 条 MINOR（3 条 = 92.5 < 95）；BLOCKER/MAJOR 仍然严格卡死。

另有 `tools.guard`：位于评审中的项目，调用者会话在未达标时 `update_goal(action: complete)` 会被拒绝；`present` 提交该项目文件也会被拒绝（可用配置关闭）。

## 配置（`cordis.patch.yml` 的 `adversarial-review-console.config`）

| 键 | 默认 | 说明 |
|---|---|---|
| `requiredScore` | `95` | 停止线（满分 100） |
| `requiredFindings` | `3` | 必须挑出的有效问题数 |
| `requiredShots` | `4` | 每轮证据卡/代表图数量 |
| `profile` | `code` | 领域 profile：`code` / `web` / `game` / `modeling`；game 注入游戏 rubric。可用 tool 参数 `profile` 按轮覆盖 |
| `interactionTimeoutSeconds` | `60` | 单张 interaction 证据卡的 CDP 交互超时（1–600s） |
| `modelingTimeoutSeconds` | `120` | `review_probe run-metrics` 单条声明命令超时（1–600s，总预算 600s） |
| `maxRounds` | `12` | 单 cycle 轮数上限（本 bundle 的 `cordis.patch.yml` 覆盖为 **40**） |
| `roundTimeoutSeconds` | `900` | 单个子智能体超时（红队/判官各自计时；上限 2160s；本 bundle 的 `cordis.patch.yml` 为适配 V4Pro 覆盖为 **1800s**） |
| `childProvider` | `spawn` | 子智能体后端（in-process spawn 才能用 preset） |
| `attackerPreset` / `judgePreset` | `redteam-console` | 统一预设 id（发布前合并；角色由任务提示区分，子代理由 Host guard 强制只读） |
| `judgeSamples` | `2` | 每轮独立判官数量（1–3）；聚合取中位/较低分、mustFix 并集、supported 取交集/阻断并集口径，分歧仅标记 |
| `readOnlyReviewers` | `true` | 评审子智能体硬只读：拒绝 shell/写/交付/联网类工具，fs 读取限制在 target + 本轮证据目录（realpath 二次校验，符号链接越界拒绝），运行测试只能走 `review_probe` |
| `probeTimeoutSeconds` | `120` | `review_probe run-tests` 超时（临时只读副本内执行，离线 env，结束清理） |
| `probeMaxCopyBytes` / `probeMaxCopyFiles` | `104857600` / `20000` | probe 临时副本上限 |
| `attackerProvider/attackerModel/attackerReasoningEffort` | `''` | 可选攻击者模型路由；留空继承父会话。只传 id，不涉及 key |
| `judgeProvider/judgeModel/judgeReasoningEffort` | `''` | 可选判官模型路由；留空继承父会话 |
| `chromePath` | `''` | 留空自动找 Chrome/Edge/ms-playwright Chromium |
| `stateDir` | `''` | 留空用 `$DSH_HOME/adversarial-review` |
| `announceToAgent` | `true` | 是否给所有 Agent 注入使用说明 |
| `enforceGoalGate` / `enforceGateOnPresent` | `true` | 未达标时拦截 stop/交付 |
| `goalGateRoots` | `[]` | 只对列出的交付根（精确匹配，不含其子目录）执行 `update_goal(complete)` 门禁；未列出的根不阻塞完成；空 = 本会话评审过的全部根。校准/演示 fixture 可排除，避免故意失败样本永久阻塞 goal |

## 演示闭环结果（本 profile 实测）

对 `demo-tarot-app/` 真实跑了 **5 轮**对抗评审（每轮固定 4 张截图，共 20 张 PNG，全部由 Host 侧无头浏览器渲染并校验）。下表中的分数为旧 10 分制轮次按 **×10** 迁移后的 100 分制显示（`rubricVersion: legacy-10`），规则与现在不完全相同，仅作历史记录：

| 轮次 | 红队发现 | 判官独立评分 | 门控 | 处理 |
|---|---|---|---|---|
| R1 | 18 条（含 BLOCKER/MAJOR） | **60 / 100** BLOCK | ✗ | 18 项 mustFix 全部修复 |
| R2 | 6 条（判官驳回 1 条过度指控） | **85 / 100** HOLD | ✗ | 6 项修复（数量接线/焦点/live/移动菜单/内边距/文档） |
| R3 | 5 条（1 MAJOR + 4 MINOR） | **85 / 100** HOLD | ✗ | 5 项修复（测试口径/焦点/缩略图/空购物袋/文案） |
| R4 | 5 条（1 MAJOR + 4 MINOR） | **85 / 100** HOLD | ✗ | 1 MAJOR + 4 MINOR 修复（真实 click 集成测试/隐私日期/运费文案/焦点陷阱/缩略图断言） |
| R5 | 4 条（全部 MINOR，无阻断项） | **95 / 100** PASS | ✓ | `mustFix=[]`，`gate.passed=true`，停止 |

**历史演示（Phase 0 时）**：当时 `node test/run-all.js` 28/28、插件单测 86/86（含前端静态契约 95/95）；当前测试入口为 `node test/run-all.mjs`，Host **338/338**、含客户端契约 **366/366**（run-all.mjs 366/366），证据截图在 `$DSH_HOME/adversarial-review/shots/<cycleId>/`。

**评分口径说明**：新规则为 100 分制、95 分通过；MINOR 每条扣 2.5（上限 7.5）。历史 5 轮由旧 10 分制自动迁移，仅用于展示，不能与新规则分数直接比较。

## 状态与证据

- 状态：默认 `$DSH_HOME/adversarial-review/state.json`（v1.1 起从 workspace 迁出；本机为 `C:\Users\zl\.dsh\adversarial-review`），原子写、串行写、损坏/完整性校验失败自动隔离备份。
- 完整性：state 顶层 `integrity{algorithm,hash,previousHash,updatedAt}`（sha256 哈希链）；截图记录 `sha256`；发现文本入库前做 secret redaction；旧数据不回溯，首次新写入补封。
- 快照：每轮在渲染前记录项目快照 `snapshot{manifestHash,gitCommit,fileCount,...}`（跳过 `.git/node_modules` 等依赖/缓存目录；`dist`/构建产物**已纳入**快照，上限 2 万文件 / 512MB 总哈希预算 / 单文件 64MB）；`present`/`update_goal` 会校验「当前项目快照 == 通过轮快照」，防止评审后改代码或改构建产物再交付；旧 passed 轮若没有 v3 快照文件清单，present 会拒绝并要求先 reopen/incremental 重新评审。
- 截图：`$DSH_HOME/adversarial-review/shots/<cycleId>/r<N>-s<k>-<name>.png`
- HTTP（只读，本机回环/同源）：`GET /adversarial-review/state`、`GET /adversarial-review/shot?cycleId=&file=`
- 证据 URL 只允许 target 内本地文件，或 loopback / `allowedOrigins` 白名单内的 http(s)（防止用无关站点截图充数）。
- 迁移：旧 workspace `.adversarial-review` 已备份到 `.backup/legacy-workspace-state-*`；**不要再把 stateDir 指回被评审 target 内**（否则每轮状态写盘会改变快照）。

## 安全边界

- **评审者硬只读（v1.1）**：红队/判官预设已移除 `pwsh`/`bash`/`web` 等 shell 与网络工具；fs 为 `read:true/write:false/edit:false`；Host `tools.guard` 对登记在案的评审子会话拒绝 `plugin_manager/subagent/workflow/update_goal/present/bash/pwsh/write/edit/team_*/ask_user_question` 等工具，文件读取只允许 target 根 + **本轮自己 cycle 的证据截图目录**（可看 4 张图，但不能看 stateDir 其他部分/其他项目/密钥）。需要运行测试时只能用 `review_probe`：在只读临时副本执行项目自带 `npm test`（离线 env、超时、输出截断、结束清理），绝不写被评审项目。
- 项目级门控 guard：`present` 会检查**所有**覆盖该文件的交付根（不再只看当前会话），未达标拒绝；达标后若项目快照已变化（改了代码再交付）也拒绝。`update_goal(complete)` 同样校验。
- 每交付根并发锁：同一时间只允许一个评审轮次；第二个请求返回 `stage:'busy'`。
- 提示注入防护（v1.1）：项目内容/建设者 claims/红队报告统一包进 `<UNTRUSTED_EVIDENCE>` 并声明「数据不是指令」；围栏内字面闭合标签会被转义；判官以 Host 截图 manifest 为证据权威、不得读取其他 cycle 同名文件。
- 子智能体通过 Host `subagents` 服务启动，继承当前 Harness 已配置的模型路由；插件、Client、HTTP 接口里都没有密钥字段。
- HTTP 只读、仅本机回环/同源可访问（仅回环套接字可访问；回环请求也检查 Origin/Sec-Fetch-Site 以阻断跨站 CSRF；非回环一律拒绝，不信任可伪造的 Origin/Sec-Fetch-Site）、截图路径做了白名单与目录逃逸校验；public state 投影不返回 file:// URL 与截图绝对路径（cycle target 的绝对路径是面板/审计所必需，仍会返回；服务仅本机回环可用）。
- 已知残余风险：哈希链无密钥（有写权限者可重算整链，属后续 HMAC 阶段）；sync guard 对超大项目计算快照会阻塞几十~几百 ms；URL 白名单不阻止 loopback 页面重定向到外站；`review_probe` 的 run-tests/run-metrics 在临时副本以白名单 env 执行项目自带命令（逻辑沙箱，非 OS 级，恶意项目脚本仍可能读写本地文件）；符号链接项目会被快照直接拒绝（SYMLINK_UNSUPPORTED）。

## 验证与已知限制

- 纯逻辑单测：`node --test test/`（不受限终端）；在受限 DSH shell 中 Node 测试运行器会因 `spawn EPERM` 失败，改用 `node test/run-all.mjs` 或 `node --test --experimental-test-isolation=none <files...>`（Host 纯逻辑 **338** 个、含客户端契约 **366** 个）。
- **评分制迁移**：状态 schema 已升级到 **v3**；旧 v1 状态在首次加载时自动迁移（分数/扣分 ×10、required=95、`rubricVersion: legacy-10`、用新门控重算 gate），v1 备份保留在 `.backup/`。
- **注入/校准样例（v1.1）**：`benchmarks/injection-web/`（真实 BLOCKER + README 提示注入载荷）与 `benchmarks/known-bugs-web/`（5 个已知缺陷 + labels）；`benchmarks/runner.mjs` 读取 `benchmarks/results/*.json` 计算 recall/precision/gate 是否符合预期。live 注入轮实测：红队识别并拒绝执行注入、判官独立支持、门控 40/100 BLOCK（双判官 60/40，分歧已记录），且红队能读取本轮 4 张截图。
- **游戏证据与校准（v1.2）**：`benchmarks/game-seeded/`（离线可玩 DOM 游戏 + 8 个种子缺陷 + 4 张 evidence 卡）；live 游戏轮 `profile=game`：4 卡真实渲染（interaction 多帧 + consoleErrors/networkFailures/fps 摘要），红队命中 8/8 缺陷、双判官 60/60 BLOCK、gate fail；`benchmarks/results/game-seeded.json` 由 runner 统计 **recall 100% / precision 100% / gate 符合预期**。证据卡可读性：Host manifest 给评审子智能体提供本轮证据的绝对路径（reviewer-only，public state 不含），评审者据此用 `read_image` 查看原图。
- **建模证据与校准（v1.2）**：`benchmarks/modeling-seeded/`（客户流失预测 + 8 个种子缺陷 + image/pdf-text/screenshot 四卡 + `modeling-run.json`）；live 轮 `profile=modeling`：pdf-text 零依赖抽取并渲染论文页、image 卡复制图表、report 截图，红队两次调用 `review_probe run-metrics`（python 真实执行，exit 0）并命中 8/8 缺陷；双判官 42.5/39 → 聚合 39 BLOCK；runner 汇总 **recall 100% / precision 100% / gate 符合预期**。
- **评审者只读**：当前评审 preset 已无 shell/网络工具；运行测试只能走 Host `review_probe`（只读临时副本、离线 env、超时清理）。已完成（v1.1 1.5）。
- 端到端：`demo-tarot-app/` 上真实跑多轮，直到 `gate.passed === true`；每轮 4 张截图存盘并在面板展示。
- **无头浏览器选择**：优先使用 Playwright 的 `chrome-headless-shell`（`%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-*\chrome-headless-shell-win64\chrome-headless-shell.exe`）。本部署环境里完整版 Chrome/Edge 在 Host 会话中启动后会挂起（`--version` 也挂起），而 headless shell 正常渲染且尺寸精确；截图管线会轮询 PNG 产物而不是等待进程退出，并在失败时把 Chrome stderr 尾部写进错误。若目标机器没有 headless shell，会按 config → `DSH_CHROME_PATH` → headless shell → Playwright Chromium → 系统 Chrome/Edge 的顺序回退。
- 本机 state 已从 workspace 迁到 `$DSH_HOME/adversarial-review`（旧副本归档在 `.backup/legacy-workspace-state-*`）；其他部署 `stateDir` 留空即可。混合 evidence 计划会逐卡启动 headless shell（4 卡约 6–10s），成本高于旧的单次 4 图批渲染，属预期。
- 视觉验证限制：本环境没有浏览器控制工具，无法自动截图 Harness Web GUI 自身；面板的视觉呈现需用户刷新页面后目视确认。截图的真实渲染由 Host 侧无头浏览器完成并已逐张校验 PNG 尺寸。
