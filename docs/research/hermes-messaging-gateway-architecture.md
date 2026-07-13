# Hermes Agent Messaging Gateway 架构研究

> 研究日期：2026-07-14  
> 研究对象：NousResearch `hermes-agent` 官方仓库 `main`，固定到提交 [`7f7a403`](https://github.com/NousResearch/hermes-agent/tree/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a)。本文只使用官方源码与官方文档。

## 结论

Hermes 的 Gateway 架构值得 BeeMax 借鉴，但应借鉴其“多平台适配层 + 共享交互运行时”，而不是原样复制整个进程职责。

Hermes 的合理之处是：一个 Gateway 同时装载多个 Adapter；所有入站消息转换成统一事件；平台身份被组合成稳定的会话键；出站由统一路由器选择 Adapter；Gateway 统一管理连接、重连、并发、打断、授权和流式呈现。这些都比“一个渠道启动一套 Agent Runtime”更适合作为 BeeMax 的目标结构。

但 Hermes 当前并不是一个只做协议转换的薄网关。它还承载 Agent turn 调度、会话运行状态、cron ticker、cron Agent 执行和部分恢复逻辑。因此“Gateway 负责连接和投递，Core/Automation 负责持久任务语义与执行”的 BeeMax 边界仍应保留。

## 1. 总体结构

Hermes 官方文档称同一 Gateway 可同时运行多个平台 Adapter；当前支持 Telegram、Discord、Slack、WhatsApp、Signal、Matrix、飞书、钉钉、企微等平台。消息先经过授权和平台规则，再进入会话查找与正常 Hermes Agent 执行，最后返回原平台。[官方 Messaging Gateway 文档](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/website/docs/user-guide/messaging/index.md)；[Discord Gateway Model](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/website/docs/user-guide/messaging/discord.md#discord-gateway-model)

```text
Telegram / Discord / Slack / Feishu / ...
                    ↓
          Platform Adapter Registry
                    ↓
        BasePlatformAdapter + MessageEvent
                    ↓
       GatewayRunner / Session Runtime
                    ↓
               Hermes Agent
                    ↓
              DeliveryRouter
                    ↓
             Platform Adapter.send
```

这说明 Hermes 的 Gateway 实际上是“渠道宿主 + 交互运行时”，而非无状态反向代理。

## 2. Adapter 注册与多平台配置

Hermes 有中央 `PlatformRegistry`。插件通过 `PlatformEntry` 注册平台名、工厂、依赖检查、配置校验、授权环境变量、消息长度、隐私属性、配置桥接、cron home target 和独立发送器。Registry 支持延迟加载，只有 Gateway 启动、状态查询或投递真正需要某个平台时才导入重型 SDK。[`gateway/platform_registry.py`](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/gateway/platform_registry.py#L1-L182)

Gateway 启动时遍历 `GatewayConfig.platforms`，为每个启用的平台创建 Adapter、安装消息/致命错误/会话/授权回调，然后连接并保存到 `self.adapters`。创建时优先查插件 Registry，旧的内置平台仍保留硬编码 fallback，因此当前实现是“注册表优先、遗留分支兜底”的混合架构，并非完全插件化。[启动连接流程](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/gateway/run.py#L7071-L7141)；[Adapter 创建流程](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/gateway/run.py#L8702-L8757)

配置模型用 `GatewayConfig.platforms: Dict[Platform, PlatformConfig]` 表示多个平台，并统一保存会话、授权、流式和投递策略。配置优先级为环境变量、`~/.hermes/config.yaml`、遗留 `gateway.json`、默认值。[`GatewayConfig`](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/gateway/config.py#L654-L732)；[`load_gateway_config`](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/gateway/config.py#L976-L1019)

对 BeeMax 的启示：采用可注册 Adapter ID 和工厂是正确方向；不要延续固定的 `feishu | cli` 联合类型。但应从第一天就做到 Registry-only，避免再形成 Hermes 当前的双轨创建路径。

## 3. 凭证与非敏感配置

Hermes 官方约定：Bot Token、OAuth Secret、API Key 等秘密放在 `~/.hermes/.env`，非敏感行为设置放在 `config.yaml`；环境变量覆盖 YAML。`hermes config set` 会按敏感性写入对应文件。[官方环境变量参考](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/website/docs/reference/environment-variables.md#L1-L12)

源码还支持 profile-scoped secret lookup，使 multiplex profile 启动时优先读取当前 profile 的 secret scope，而非无条件读全局进程环境变量。[`gateway/config.py` secret scope](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/gateway/config.py#L149-L168)

对 BeeMax 的启示：配置与秘密分离应保留，但 BeeMax 更适合在配置中只保存 `credentialRef`，秘密由 Profile Credential Vault 注入。直接把大量平台秘密平铺进 `.env`，在多租户、轮换、审计场景下不够强。

## 4. 连接生命周期与故障治理

所有 Adapter 继承 `BasePlatformAdapter`，至少实现 `connect(is_reconnect=False)`、`disconnect()` 和 `send(...)`。`is_reconnect=True` 明确告诉 Adapter 保留服务端积压队列，避免断线期间消息被丢弃。[Adapter 生命周期契约](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/gateway/platforms/base.py#L2886-L2931)

Gateway 对连接设置超时；失败后防御性调用 `disconnect()`，要求其幂等并容忍部分初始化。可重试故障进入重连队列，使用 30、60、120、240、300 秒指数退避；非重试错误退出队列；平台还可由操作员暂停和恢复。[连接清理](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/gateway/run.py#L7108-L7159)；[重连治理](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/gateway/run.py#L7878-L8018)

对 BeeMax 的启示：`ChannelHost` 应直接吸收这套生命周期模型，包括连接超时、错误分类、幂等清理、指数退避、暂停/恢复和单 Adapter 故障隔离。

## 5. 标准化消息、身份与会话

Adapter 将平台事件转换为统一 `MessageEvent`，字段包括文本、消息类型、`SessionSource`、原始消息、消息 ID、媒体路径/类型、回复上下文、线程/频道扩展上下文和平台元数据。[`MessageEvent`](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/gateway/platforms/base.py#L1717-L1803)

`SessionSource` 保存 platform、chat ID/type、user ID/name、thread ID、scope、message ID、profile 和备用身份字段。会话键由 profile namespace、platform、DM/group/thread、chat/thread/user 等字段组合产生。[`SessionSource`](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/gateway/session.py#L204-L293)；[`build_session_key`](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/gateway/session.py#L871-L970)

默认 `group_sessions_per_user=true`，共享群/频道中每位用户拥有隔离会话；DM 不共享；线程是否按用户隔离由独立策略控制。[会话隔离策略](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/gateway/config.py#L695-L709)；[Discord 会话说明](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/website/docs/user-guide/messaging/discord.md#session-model-in-discord)

Adapter 基类还按 `session_key` 管理活动 Agent、待处理消息和任务，实现同一会话的打断、排队及 `/stop` 等旁路命令。[会话并发状态](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/gateway/platforms/base.py#L2362-L2399)；[入站调度](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/gateway/platforms/base.py#L4608-L4689)

对 BeeMax 的启示：Hermes 的 conversation identity 设计可以直接借鉴；但跨平台责任身份不能仅靠 `user_id_alt` 或显示名推断，应继续采用 BeeMax 的可信企业身份映射。

## 6. 出站投递

`DeliveryRouter` 接收语义化 `DeliveryTarget`，解析 `origin`、home channel 或显式的 `platform:chat:thread`，再从 `adapters` 映射中选择 Adapter 投递；Adapter 负责平台格式、回复、编辑、媒体等差异。[`DeliveryRouter`](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/gateway/delivery.py#L222-L260)

Registry 允许平台声明 `standalone_sender_fn`，使 cron 与 Gateway 不在同一进程时也能临时连接并发送。这表明 Hermes 已意识到“执行”和“在线 Adapter”不能强绑定，但它仍把这一能力放进平台注册契约中。[独立发送契约](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/gateway/platform_registry.py#L138-L159)

对 BeeMax 的启示：应保留统一 `DeliveryRouter/DeliveryPort`，并进一步用 durable outbox 作为 Core 与 Gateway 的边界。投递重试不得重新执行 Agent Task。

## 7. Cron、heartbeat 与 Agent 的职责边界

Hermes 的 cron 模块明确说明：Gateway daemon 每 60 秒 tick scheduler；到期任务在隔离会话中创建 `AIAgent` 执行，完成后由 cron scheduler 调用统一投递路径发往 origin 或指定平台。[cron 模块说明](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/cron/__init__.py#L1-L15)；[cron scheduler](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/cron/scheduler.py#L2485-L2616)；[cron 结果投递](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/cron/scheduler.py#L1405-L1429)

“Heartbeat”在 Hermes 中至少有三类，不能混为一个职责：

- 平台协议 heartbeat（例如 WebSocket 保活）属于 Adapter。
- 长 Agent turn 的“still working”提示属于 Gateway 呈现层。[官方展示配置](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/website/docs/user-guide/messaging/index.md#long-running-tasks)
- cron ticker/run-claim heartbeat 属于调度器存活与租约治理，而非 IM Gateway 协议。

因此 Hermes 的进程部署很实用：一个常驻 daemon 同时让渠道连接和 cron 自动运行；但职责边界偏宽。BeeMax 可让同一 Supervisor 共置 ChannelHost 与 Automation Worker，却应保持逻辑分层：

```text
Automation owns Schedule + Task execution
Core owns Agent/Memory/Effect/Verification
Outbox owns durable delivery intent
Gateway owns channel connection + normalization + presentation + send retry
```

## 8. 对 BeeMax 的最终判断

“BeeMax 的 Gateway 应采用 Hermes 风格”这个方向是对的，但准确表述应是：

1. 采用一个 Profile Runtime 挂载多个 Channel Adapter。
2. 采用 Registry、统一消息事件、会话键、DeliveryRouter 和 ChannelHost 生命周期治理。
3. 不把平台枚举写死在 Core，也不为每个平台复制 Agent Runtime。
4. 不照搬 Hermes 将 cron Agent 执行、会话调度和渠道连接全部塞进 Gateway 的逻辑边界。
5. 运行时可以共进程部署，领域职责必须分层，并以 durable outbox 隔开任务执行和渠道投递。

换言之：Hermes 的“多渠道宿主形态”更合理；BeeMax 的“Core/Automation/Effect 与 Gateway 分权”更适合长期可靠性。最好的目标不是复刻 Hermes，而是采用 Hermes 的 Channel Host，并保留 BeeMax 更严格的责任边界。
