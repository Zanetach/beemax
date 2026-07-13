# BeeMax Runtime 故障恢复手册

本文只定义 BeeMax Runtime 的通用故障协议，不定义客户业务规则。订单、工单、合同、项目或任何企业实体都不进入恢复判断；是否可重放只由 durable Task、Recovery Policy、幂等身份、Effect Authority、Checkpoint 与 Verification 证据决定。

## 处理原则

1. 先查 Task、Task Run、Checkpoint、Effect 和 Execution Trace，不从聊天文本猜测执行结果。
2. `committed` mutation 永不重放；`unknown` Effect 在对账前阻止恢复。
3. 只有同时声明 `safe_retry`、幂等键和执行作用域的 Task 才能自动恢复；其他中断 Task 明确失败。
4. 外部系统的实际状态由操作员或可信 provider proof 确认，模型陈述不是提交凭证。
5. Verification unavailable 只重试验证，不重新执行 Task。

## 快速检查

```text
beemax gateway status --profile <profile>
beemax gateway logs --profile <profile>
beemax status --deep --profile <profile>
beemax effect list --status unknown --profile <profile>
beemax trace show <execution-id> --profile <profile>
```

在会话中使用 `/status`、`/tasks plans` 和 `/tasks show <plan-id>` 检查责任与恢复状态。

## 故障矩阵

| 故障 | 可观察事实 | 自动行为 | 操作员恢复 |
| --- | --- | --- | --- |
| Pi crash | Task Run lease、Checkpoint、Trace | lease 到期后仅恢复安全幂等 Task | 查 `/tasks show` 与 Trace；确认 Effect 后再 `/tasks retry` |
| Tool timeout | `unknown` Effect、trace event | 阻止重放 | 查外部系统；将 Effect reconcile 为 `committed` 或 `failed` |
| Process exit / restart | durable Task、Effect、outbox、recovery status | 重开 authority，回收过期 lease | 查 Gateway 状态和日志；处理 unknown Effect 或失败 Task |
| Multi-instance claim | claim owner、lease、authority transition | 原子 claim，只允许一个实例执行 | 停止非预期重复实例，等待 lease 到期后恢复 |
| Unknown Effect | Effect scope、Tool、idempotency key、status | fail closed | `beemax effect reconcile <id> --status committed --operation <observed>`，或明确标记 `failed` |
| Verification unavailable | Candidate Outcome、Verification status、backoff | 有界重试 Verification，不重放执行 | verifier 恢复后运行 `/tasks verify <plan-id>` |
| Delivery failure | outbox attempts、last error、delivery lease | 有界重试并回收 lease | 修复渠道 adapter；从 `/tasks show` 读取结果，不重复执行 Objective |
| Compaction | preservation envelope、Checkpoint、Trace | 从 Task Ledger 重建未完成责任 | 查 `/tasks show`；会话变化时使用 `/resume <session-id>` |
| Steering | interaction journal、queued input、Trace | 串行应用或持久排队 | 确认 queued input 缺失后才重发 |
| Correction | Verification feedback、attempt count、Memory evidence | 仅对安全 Task 做有界纠正 | 修正证据或 Policy 后显式 `/tasks retry` |

## Unknown Effect 对账

```text
beemax effect list --status unknown --profile <profile>
beemax effect reconcile <effect-id> --status committed --operation <observed-operation> --external-ref <reference> --profile <profile>
beemax effect reconcile <effect-id> --status failed --profile <profile>
```

只有在外部系统已观察到 mutation 成功时才使用 `committed`，并填写实际 operation。若确认 mutation 未发生，使用 `failed`；之后 Runtime 才可能按完整恢复策略允许新的显式尝试。命令拒绝 Credential Secret，且只能结算当前为 `unknown` 的 Effect。

## 发布门禁

发布前必须通过：

```text
npm run build
npm test
npm run eval:runtime
```

`runtime-fault-catalog` 检查所有故障均有 observable state、operator recovery 和 release evidence；`reliability-fault-release-gate` 真实注入跨实例重复 mutation、中断 Task 与 unknown Effect，验证重复提交为零、安全工作恢复、非安全工作明确失败。
