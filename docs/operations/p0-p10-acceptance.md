# P0–P10 生产验收与回滚演练

这份手册把原始 P0–P10 从文字清单收敛为可重复的发布证据。它检查 BeeMax 平台 Runtime，不定义客户、订单、工单、项目或任何企业业务规则。

## 一键验收

```sh
npm run verify:release
```

`verify:release` 依次执行 build、typecheck、Runtime evaluation、当前受支持机器的严格 performance Profile、reliability、P0–P10 acceptance 和全量测试。`eval:acceptance` 校验 P0–P10 证据清单、原 PRD 的 TBD 处置，执行 P9 架构收缩门禁，并完成 P10 数据迁移/回滚演练。详细映射由 `evals/original-acceptance-program.json` 维护；增加或删除程序、指标或证据都必须经过代码审查。

CI 专用性能复现仍可单独运行 `npm run eval:performance:ci`；本地或发布审计应使用 `npm run eval:performance:release`，由机器事实选择已提交 Profile，未知机器直接失败。

## P0–P10 证据边界

| 程序 | 发布证据 |
| --- | --- |
| P0 | 单一 PRD、固定 seed 陌生业务 corpus、版本化 Runtime baseline |
| P1 | Access Scope、Enterprise Policy、Action Governance 的公开接口测试 |
| P2 | Execution Envelope 在 Pi/Task 生命周期中的结构化传播 |
| P3 | Effect 单一 authority、跨实例幂等、unknown reconcile 故障注入 |
| P4 | Capability Top-5、统一结果形状、mutation reroute fail-closed |
| P5 | Pi Turn/Task Run checkpoint、Compaction 与恢复责任保留 |
| P6 | Episode、Correction、Conflict、Exception 的作用域与可更正性 |
| P7 | interactive/planned/automation/recovery 统一 Objective-to-Pi 生命周期 |
| P8 | CLI、飞书与 future-channel contract；trigger 只作为 adapter |
| P9 | 无 Core 客户本体、无 legacy runtime consumer、单一 Profile composition、Persistence Port 边界 |
| P10 | 故障、性能、成本、跨渠道、数据迁移、备份完整性与回滚恢复 |

## 迁移与回滚演练

`npm run eval:migration` 每次创建隔离的旧版 Profile 和旧 `task_ledger` 数据，然后真实执行以下步骤：

1. 使用生产 `migrateProfile` 做 SQLite 在线备份式迁移，验证旧源未被删除或改写。
2. 用生产 `MemoryStore` 打开迁移库，执行 additive schema migration，并读取旧 durable responsibility。
3. 用生产 `backupSqliteDatabase` 生成升级前备份，运行 SQLite integrity check。
4. 在现行库写入一条备份后的责任，模拟升级后继续运行。
5. 从备份恢复到独立数据库并重新打开；升级前责任必须存在，备份后的写入必须不存在。

演练不会覆盖真实 Profile。生产回滚也必须恢复到新路径或停机后原子替换，禁止同时启动新旧 authority，禁止通过双写“回滚”，也不能删除源数据来伪造成功。

## 正式暂缓的生产指标

离线门禁可复现 Situation、Capability、scope isolation、Verification、Effect、Initiative 安全与 Runtime overhead，但不能诚实替代真实用户和 provider：

- 用户干预降低至少 30%：等待经同意的重复工作 cohort，至少形成 30 个前后可比的 verified Objectives。
- repeated-question rate：等待隐私审查后的生产会话 cohort，并按自治等级分层。
- provider latency、token、cache token 与 USD：等待声明 provider/model 的生产 Execution Trace。

这些项目是有退出条件的正式暂缓，不是通过项。它们在满足样本、隐私和机器/模型声明前，不得被宣传为生产 SLA，也不阻塞当前离线 Runtime 完整性发布门禁。

## 操作失败

- 架构门禁失败：先定位新增的 authority、composition caller 或 legacy consumer；不能更新期望值来绕过审查。
- 迁移演练失败：停止发布，保留原数据库和备份；不要反复打开或覆写疑似损坏文件。
- 性能机器不匹配：换到声明 Profile 的机器执行；不要把另一种硬件结果写入既有 baseline。
- unknown Effect：按故障恢复手册外部观察并 reconcile，禁止通过回滚数据库重放 mutation。

相关手册：[`fault-recovery.md`](./fault-recovery.md)、[`performance-and-cost.md`](./performance-and-cost.md)。
