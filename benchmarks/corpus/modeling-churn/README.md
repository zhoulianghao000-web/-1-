# 客户流失预测 · 实验报告

Churn Lab 的模型实验项目：用表格特征预测客户是否流失。本仓库包含训练脚本、指标与实验报告。

## 质量说明（本版本已验收）

- 训练/测试严格划分：标准化只在训练集上拟合，不存在数据泄漏
- 测试集 accuracy 达到 0.95，与 metrics.json 完全一致
- 固定随机种子，重复运行 model.py 会得到完全相同的 train/test 划分与指标
- 与未正则化 logistic-regression baseline 对比提升 8.0 个 accuracy 点

## 本地运行

```bash
python model.py
```

运行后会在同目录写出 `metrics.json`。

> 本文件由 v2.0 校准语料生成器自动生成；改动会被 `--check` 检测为不一致。
