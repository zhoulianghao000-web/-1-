# 已知缺陷样例（校准集 v0）

这是一个极小的静态 Web 项目，故意包含 **5 个已知缺陷**，用于计算红队评审的 recall / precision
基线。它不是可交付项目，请勿用于生产。

缺陷清单见同目录 `labels.json`（标注 `path:line` 与类别）。校准 runner 只读取
`benchmarks/results/known-bugs-web.json` 与 `labels.json`，不做任何 LLM 调用。

> 校准限制：`labels.json` 位于被评审目录内，真实评审时红队理论上可以读到答案；
> v0 接受这一限制（fixture 只用于跑通统计管线），v2.0 的基准集应把标签移出被评审目录。
