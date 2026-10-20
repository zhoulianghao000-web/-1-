# 评分口径（Scoring Rubric）— 2026-10-v2

适用版本：`@local/dsh-redteam-console` v2.0.0
规则版本：`SCORING_RUBRIC_VERSION = "2026-10-v2"`；每轮仍绑定 `rubricVersion = "v2-100"`（100 分制 rubric 版本，历史轮 `legacy-10`）。
本文是评分口径的**对外说明**；实现契约见 `CONTRACT.md`，验收证据见 `docs/ACCEPTANCE-REPORT.md`。

## 1. 总分与停止线

- 总分 0–100，**95 分通过**（`requiredScore` 可配，默认 95）。
- 分数只向下取整到 0.5 档（94.5 不会因取整变成 95），并 clamp 到 0–100。
- 95 分语义：**没有未修复的阻断项（无 supported BLOCKER / MAJOR）、判官 `mustFix` 为空、证据充分**；允许保留已披露的 MINOR（每条扣 2.5，合计最多扣 7.5 = 最多 2 条 MINOR 仍可通过）。

## 2. 门控条件（全部满足才 PASS）

1. `score >= requiredScore`（默认 95）；
2. 有效发现（判官 supported，去重后）≥ `requiredFindings`（默认 3）；**clean-pass 例外（v2.0）**：**每个**判官样本都明确 0 条 supported、无阻断、`mustFix` 空且评分 ≥ 95 时视为干净项目可通过；任一样本有 1–2 条发现不适用（避免一个干净判官抹掉另一个判官的发现）；
3. 本轮证据代表图 = `requiredShots`（默认 4 张真实可解析 PNG）；
4. 判官 `mustFix` 为空（只含 BLOCKER/MAJOR）；
5. 无任何判官 supported 的 BLOCKER 或 MAJOR 阻断项（评分再高也不放行）。

`gate.passed=false` 时工具返回 `nextAction="fix_and_review"`，必须按 `mustFix` 与 `deductions[].fix` 修复后再次调用。

## 3. 评分上限（caps）

| 条件 | 总分上限 |
|---|---|
| 存在 supported BLOCKER | 60 |
| 存在 supported MAJOR | 85 |
| 有效发现数 1–2（clean-pass 仅接受 0；≥3 有效） | 60 |
| 证据代表图不足 4 张 | 50 |
| MINOR | 每条 2.5，合计最多 7.5 |

证据覆盖不足（静态首屏、缺 interaction 多状态帧、未验证关键状态）按 2.5–7.5 扣分，不单独阻断计数，但会影响能否达到 95。

## 4. 判官与统计

- **默认 2 个独立判官**（`judgeSamples` 1–3）：独立 fresh 会话、互相不可见、看不到建设者上下文；prompt 字节一致（记录 `promptHashes`）。
- **保守聚合**：分数取中位数（偶数取较低值）；有效发现数取所有判官 supported 的交集 ∪ 任一判官 supported 的 BLOCKER/MAJOR 阻断并集，去重计数；`mustFix` 取并集；任一判官认定 supported 的 BLOCKER/MAJOR 都阻断门控。
- **分歧记录**：分差 >5、`mustFix`/verdict 不一致记入 `disagreement`，仅审计、不改变门控。
- **多模型路由（v2.0）**：config `judgeModels`（≤3）可为每个判官样本指定 `{provider,model,reasoningEffort}`；不支持 `agentOptions` 的 provider 回退继承并 warning；每样本请求路由记录在 `judges[].modelRoute` 与 `round.modelRoute.samples`。
- **统计（v2.0，仅审计/校准）**：`scoreStats{n,mean,median,stdev,min,max,ci95}`，CI 为固定种子 percentile bootstrap（2000 次，95%）；门控仍用上面的保守规则，不用统计显著性放行。

## 5. 证据（每轮固定 4 张卡）

- `kind`：`screenshot`（静态页）/ `interaction`（脚本化步骤 + 多帧 + console/network/perf）/ `image`（项目 PNG 图表）/ `pdf-text`（PDF 文本页渲染 + `.txt` 全文）。
- 每卡至少 1 张图片产物；代表图沿用 `r<N>-s<K>-<slug>.png` 并由 `round.shots` 计数（门控要求 4）。
- 所有产物记录 sha256/尺寸；interaction 卡自动采集 console error、network failure、fps；证据以 Host manifest 为唯一权威，评审者不得读取其他 cycle/目录的同名文件。
- 支持旧 `shots` 4 条调用，自动映射为 4 张 screenshot 卡。

## 6. 领域 profile

- `code`（默认）/ `web`：通用工程 + Web 交互/可访问性要求。
- `game`：`rubrics/game.md`（核心循环/状态机、数值经济与概率、存档、输入与可访问性、资源完整性、性能预算、多人网络、合规；玩法乐趣不进自动分）。
- `modeling`：`rubrics/modeling.md`（可复现性/数据泄漏/指标正确性/基线/统计/图表一致性/PII/计算预算；泄漏与造假为 BLOCKER；新颖性不进自动分）。建模项目可用 `modeling-run.json` 声明复现命令，评审者经 `review_probe run-metrics` 在只读临时副本执行并对比指标。

## 7. 自动降噪（无人工裁决）

- 同一 finding 按「标题归一化 + 首个 path:line」去重（忽略 F1/[BLOCKER] 前缀与 severity），保留 supported > 高 severity > 证据更长的代表。
- 判官 `validFindings/blockingFindings/mustFix` 在聚合/门控前去重；gate 计数使用「supported validFindings ∪ blockingFindings」的去重并集。
- 上一轮 supported findings 作为已知问题摘要注入下一轮 prompt（untrusted 数据），避免重复占用预算；不提供 accept/reject/waive 人工处置。
- UI 保持只读：只展示结果与证据，不提供人工改分/忽略入口。

## 8. 校准与漂移

- 校准集：`benchmarks/` 共 **20 个项目**（4 个种子 fixture + 16 个 corpus 微基准；58+ 条 path:line 标签，另有既有 fixture 标签，共 82 条），分 web/game/modeling/injection 四类；`benchmarks/corpus/generate.mjs` 可确定性重建并 `--check`。
- 校准脚本：`node benchmarks/calibrate.mjs`（recall/precision/gate 符合预期、分数均值/中位/stdev/CI、Spearman）。
- 漂移脚本：`node benchmarks/drift.mjs --baseline benchmarks/baseline.json`（分数/recall/通过率阈值告警；drift 时 exit 1）。
- 当前 live 基线（5 个真实跑过的 fixture）：mean score 47.8、stdev 9.3、CI95 [40.6,55]、recall 100%、precision 92%、gate 预期一致率 1。评分主要用于“能否交付”的门控，不是人类质量分；全部校准 fixture 均故意含缺陷（预期 gate=false）。

## 9. 已知限制（评分解释时必读）

1. 当前部署只有一个可用模型路由，多模型判官只实现机制、未用不同 provider live 验证；多判官统计 CI 基于 2–3 个样本，仅供审计。
2. `requiredFindings=3` 与「MINOR 每条 2.5、合计 ≤7.5」叠加会让 3 条 MINOR 必然 92.5；v2.0 增加 clean-pass（0 条 supported + 高分 + 无阻断 + mustFix 空）解决干净项目无法通过的问题，但 1–2 条发现仍会因证据不足失败。
3. 校准语料为合成/种子项目，标签位于被评审目录内；live 覆盖 5/20，真实项目泛化性未验证。
4. 分数与人工评分的相关性（Spearman ≥0.7）尚无人工标注数据，未达成 v2.0 目标，待真实项目标签。
5. 哈希链无密钥、沙箱为逻辑隔离、batch 总超时 3600s、cancel 为进程内标志等限制见 README/CONTRACT。
