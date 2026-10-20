# @local/dsh-redteam-console v2.0.0 — 发布包

- 打包时间：2026-10-20（Asia/Shanghai）
- 包名：`@local/dsh-redteam-console`，版本 **2.0.0**
- 形态：DSH Cordis 插件（Host `index.js` + Client `client.js` + bundle 配置 `cordis.patch.yml`），零运行时依赖
- 当前状态：**已安装并在本机运行**（profile `desktop`，插件 2.0.0）；最终自评审 **PASS**

## 发布产物

| 文件 | 大小 | SHA-256 |
|---|---|---|
| `local-dsh-redteam-console-2.0.0.tgz`（npm 包，35 files，npm pack 生成） | 282,901 B | `b981ec0add7b70e1862ff531574770cd62ff0083747b678df529404a50346b94` |
| `redteam-console-2.0.0-source.zip`（完整源码：代码/测试/benchmarks/docs，可复现） | 686,478 B | `d43dd02e589bc01b956ec5e4928340b6bbf66a86b47140aec689f0d3103fa177` |

> 校验：`Get-FileHash <file> -Algorithm SHA256`（Windows）或 `sha256sum <file>`。

## 本次发布变化：三个模式合并为一个

- 模式选择器中原有三个相关预设：`redteam`（旧 `@local/dsh-redteam-preset`）、`redteam-review`、`review-judge`。
- 现已合并为**单一**预设 `redteam-console`：**红队评审台 v2.0（对抗挑刺 + 独立评分）**。
  - 主会话：可读写项目、执行命令、调用 `adversarial_review_round` 组织评审。
  - 作为评审台子代理启动时：红队/判官角色由每轮任务提示区分，Host `tools.guard` 强制只读（拒绝 shell/写/交付/结束目标等）。
- 插件配置 `attackerPreset` / `judgePreset` 均指向 `redteam-console`。
- 旧 bundle `@local/dsh-redteam-preset` 已从 profile 移除（**未删除**你桌面上的源码目录，可随时重装）。
- 验证：插件 bundle 重装成功；预设注册表只剩 `preset-redteam-console`（外加内置 standard/ptc/minimal/cordis）；`/adversarial-review/state` 返回 200。

## 最终自评审门禁（闭环证据，模式合并前）

- cycle：`c-mvew6oz3-pvbwi3`，round **12**，rubricVersion `v2-100`
- **gate.passed = true**；总分 **95 / 100**
- 判官：2 个独立 V4Pro 判官（`deepseek-account/deepseek-v4-pro`），样本分 **97.5 / 95**（mean 96.3，median 96.3，stdev 1.8，CI95 [95, 97.5]）
- 有效发现 **0**；mustFix 空；证据代表图 **4 / 4**；无 supported BLOCKER/MAJOR；clean-pass 成立
- 4 张证据卡为 Host 生成的**中性占位报告页**（本项目无独立 Web UI，属合法 fallback）
- 评审记录可在 DSH Web GUI 侧栏「红队评审台」查看（H1 已由用户目视确认）

## 验证（打包时实际执行）

1. 模式合并前最后一次全量测试：`node test/run-all.mjs` → **366/366 通过**（Host 338 + 客户端契约 28）。按用户要求，模式合并后**未重跑**全量测试与新预设冒烟；合并仅改 bundle 配置/文档并重装验证。
2. 重打包 tarball：35 个文件；解包后全部 `.js` 通过 `node --check`；`import` 入口成功（导出 `apply/buildEffectiveConfig/inject`）。
3. 打包内容密钥扫描：无 `sk-*`/`AKIA*`/私钥形状字符串。
4. 包内容仅含 `files` 白名单：`index.js`、`lib/**/*.js`、`client.js`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`、`rubrics/**/*.md`、`README.md`、`CONTRACT.md`、`docs/**/*.md`（不含 tests/benchmarks/state）。

## 安装方式

### A. 本机 DSH（当前方式，已生效）
插件已通过 `plugin_manager` 以 bundle 方式安装到 profile `desktop`；源码目录：``。

### B. 从 npm tarball 安装（仅包，不含测试/benchmarks）
```powershell
npm install .\local-dsh-redteam-console-2.0.0.tgz
# 或让 DSH 安装：plugin_manager install_bundle target=<解包/源码目录>
```
注意：包名带 `@local` 作用域且 `private: true`，未发布到公共 npm registry；tarball 用于离线分发/安装。

### C. 从 GitHub 安装
仓库根目录即插件源码；clone 后执行：
```powershell
plugin_manager install_bundle target=<clone目录>
```

## 当前部署配置说明
- 包内 `cordis.patch.yml` 最终配置：统一预设 `redteam-console`、V4Pro attacker/judge、`judgeSamples: 2`、`roundTimeoutSeconds: 1800`、`maxRounds: 40`、`goalGateRoots: []`（默认对本会话全部交付根生效）。
- 本机 profile 覆盖层将 `goalGateRoots` 精确限定为本次目标项目 `redteam-console`，避免 benchmarks/演示 fixture 的故意失败轮阻塞 goal。
- 评分/门禁默认：100 分制、95 通过线、clean-pass（每个判官样本 0 supported + 无阻断 + mustFix 空 + ≥95）。

## 已知限制/未覆盖项
- 本项目为 Harness 插件，无独立 Web UI；4 张证据为 Host 中性占位报告页，不是交互截图（已在判官报告中披露且不扣分）。
- 真实项目输入与人工校准标签（H2/H3）用户明确不做；live 校准数据来自仓库内已提交的 5 fixture 报告（recall 100% / precision 92% / gate 5/5、mean 47.8、CI95 [40.6,55]），打包过程未重新跑模型调用。
- 多 provider/多模型路由机制已实现，但本环境只有 `deepseek-account/deepseek-v4-pro` 实际可用；腾讯混元在 DSH 中未发现已注册 provider，未纳入评测路由。
- `drift` 结论来自 `baseline.json` 与 `calibration-report.json` 数值一致；打包时未在终端重跑 `benchmarks/drift.mjs`（该脚本在测试套件中有覆盖）。
- benchmarks/ 仅存在于源码 zip 与仓库，不进入 npm 包。
- 模式合并后按用户要求未重跑全量测试与新预设冒烟；旧会话保持旧组合，新会话/新选择才使用新统一模式。

## 关键文档（包内）
- [README.md](README.md) — 使用/配置/架构
- [CONTRACT.md](CONTRACT.md) — Host/Client 契约与门禁规则
- [docs/ACCEPTANCE-REPORT.md](docs/ACCEPTANCE-REPORT.md) — 验收报告与自评审记录
- [docs/SCORING-RUBRIC.md](docs/SCORING-RUBRIC.md) — 100 分评分口径
- [docs/UPGRADE-PLAN.md](docs/UPGRADE-PLAN.md) — 分阶段实施计划与状态
