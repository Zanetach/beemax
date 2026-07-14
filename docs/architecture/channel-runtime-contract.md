# BeeMax Channel Runtime Contract

CLI、Feishu/Lark、Telegram 和未来渠道只能是同一个 Profile Runtime 的输入、呈现与投递 adapter。渠道不得拥有自己的 Task、Effect、Memory、Policy、Verification、Recovery 或 Agent Loop。

## Gateway 1.2 运行形态

一个 Profile Gateway 由 `AdapterRegistry + ChannelHost + GatewayDeliveryPort` 构成。Registry 只按配置声明创建 adapter；ChannelHost 统一管理启用渠道的启动、失败隔离、暂停、恢复与关闭；DeliveryPort 按 `DeliveryTarget.platform` 选择已连接 adapter。所有 Dispatcher 共享同一个由 `createProfileRuntime` 产生的 Runtime、Interaction adapter 和 durable work graph。

非敏感声明使用 `gateway.channels[]`，Credential Secret 不得出现在 adapter settings。`credentialRef` 只指向 Profile 受保护的 Secret 来源；当前内置 adapter 使用 `profile-env:feishu` 和 `profile-env:telegram`。未知 adapter ID、重复活动平台、无启用渠道、Credential/配置错误均 fail closed。已正确配置的渠道如果只因临时网络或平台故障在启动瞬间全部离线，Profile Runtime 可以保持运行：ChannelHost 继续监督重连，Scheduler 继续产生 durable work，Delivery Outbox 等渠道恢复后再投递。离线 adapter 不得被报告为 connected，也不能接收入站流量。

原生卡片是渠道能力，不是 Runtime 要求。Feishu/Lark 使用流式交互卡；Telegram 等无卡片渠道降级为 typing + 最终文本，并继续使用完全相同的 Task、Policy、Effect、Verification 和恢复语义。

## 三种身份不能混用

| 身份 | 用途 | 是否跨渠道 |
| --- | --- | --- |
| Conversation / Session identity | Pi session、stream、steering、follow-up、聊天历史 | 否；保留 platform、chat、thread |
| Responsibility identity | Objective、Task、Task Plan、Sub-Agent、Effect、cancel、retry、recovery | 仅当 adapter 提供可信 `userIdAlt` 时跨渠道 |
| Memory / Access Scope | 对话证据隔离、组织成员关系、Enterprise Policy scope | 由可信 scope 决定，不能因责任共享而扩大 |

`responsibilityOwnerKey` 优先使用 adapter 提供的跨应用身份 `user:<userIdAlt>`；没有该身份时退回当前 channel conversation owner。`responsibilityOwnerKeys` 同时保留旧 channel key 作为 additive migration read，因此升级不会让同一渠道的旧 Task 消失。

`userIdAlt` 必须来自平台身份 API、管理员映射或其他可信 identity provider，不能直接采用用户消息中的自报名称。两个没有可信映射的人不能因为显示名相同而共享责任。

## Adapter 可以做什么

- 将已认证的 inbound message、media 与 trusted identity 映射为 Runtime Source；
- 调用共享 Interaction adapter 处理 send、queue、steer、cancel、session control；
- 将 channel-neutral progress、approval、answer、media 与 delivery outcome 呈现为平台格式；
- 提供渠道能力和 Delivery Port，但仍经过统一 Tool Policy、Action Governance 与 Effect Authority。

## Adapter 不能做什么

- 自行创建或结算 Task、Task Run、Effect、Verification 或 Recovery；
- 从消息文本推断跨渠道 identity、Access Scope 或企业权限；
- 用渠道成功响应代替 Effect proof 或 Verification；
- 创建第二套 Agent Loop、retry queue、Task store 或 Memory store；
- 在主 Agent factory 中漏掉 Action Governance 或 Profile Effect Authority。

Profile composition 会验证主 Agent factory 的安全绑定。未通过 `buildAgentFactory` 进入 Core Governance hook，或未绑定当前 `work.toolEffects` 的渠道在启动时直接失败。该检查防止未来 adapter 因复制装配代码而静默绕过副作用记录。

## 一次编写的 Contract Gate

`channel-runtime-equivalence.test.mjs` 使用同一个 Profile Runtime，依次以 CLI、Feishu 和一个未知未来渠道访问同一可信 responsibility identity，并验证：

- Task 与 Task Plan 在渠道切换后仍可发现；
- committed mutation 的 idempotency 在所有渠道共享，不能重复提交；
- cancel、candidate re-verification 和 safe retry 使用相同 owner scope 与状态机；
- 对话 Memory 仍按 channel scope 隔离，不因责任共享而越权；
- 未绑定 Governance/Effect 的 channel composition 无法启动。

未来渠道只需把自己的 source 加入同一 contract harness；不得复制一套渠道专属生命周期测试。
