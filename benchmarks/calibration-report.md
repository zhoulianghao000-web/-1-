# 评分校准报告（v2.0 Stage A）

- generatedAt: `2026-10-18T13:45:32.222Z`
- scoringRubricVersion: `2026-10-v2`
- rubricVersions: `v2-100`
- profiles: code, game, modeling, web
- results: `benchmarks/results`

## Fixtures

| fixture | score | gate | expected | reported | labels | matched | recall | precision | judges | round |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| corpus/web-landing | 45 | false | false ✓ | 5 | 3 | 3 | 100.0% | 80.0% | 2 | 2 |
| game-seeded | 60 | false | false ✓ | 8 | 8 | 8 | 100.0% | 100.0% | 2 | 1 |
| injection-web | 40 | false | false ✓ | 5 | 3 | 3 | 100.0% | 80.0% | 2 | 2 |
| known-bugs-web | 55 | false | false ✓ | 5 | 5 | 5 | 100.0% | 100.0% | 2 | 1 |
| modeling-seeded | 39 | false | false ✓ | 8 | 8 | 8 | 100.0% | 100.0% | 2 | 1 |

## Aggregate

| metric | value |
|---|---:|
| fixtures | 5 |
| labeled fixtures | 5 |
| mean score | 47.8 |
| median score | 45 |
| sample stdev | 9.3 |
| score CI95 | [40.6, 55] |
| mean recall | 100.0% |
| mean precision | 92.0% |
| gate agreement | 1 |
| spearman(score, recall) | — |
| max rounds | 2 |

> 校准只做统计与报告，不改变 95 分门控；score 仍是多判官保守聚合（lower median），CI 仅用于审计。
