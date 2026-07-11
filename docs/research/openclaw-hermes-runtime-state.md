# OpenClaw 与 Hermes Agent：运行时状态处理（官方资料核查）

核查日期：2026-07-11。本文只引用 OpenClaw 和 Nous Research/Hermes Agent 的官方文档或其官方仓库；不修改 BeeMax 生产代码。

## 结论

两者的共同做法是把“可续接的聊天上下文”与“当前运行事实”分开：前者持久化以恢复对话，后者通过 Gateway、版本检查、健康检查和日志来核验。因此，旧会话里保留的待办不能被视为当前版本或当前服务的真相；产品需要在启动/恢复时显式取得并展示该真相。

OpenClaw 在这方面更完整：Gateway 是会话和任务账本的唯一事实源，并在升级时检查新旧二进制冲突、重启后验证版本与可达性。Hermes 的 Profile 将会话、SQLite 状态、日志和 Gateway 状态隔离；它提供重置/恢复、`/status`、`hermes update`、`doctor` 与 Gateway 生命周期命令，但官方资料没有表明它会自动纠正聊天中已过期的任务陈述。

## 1. 会话与上下文恢复

| 产品 | 官方机制 | 对“旧回答仍说任务未完成”的意义 |
| --- | --- | --- |
| OpenClaw | Gateway 拥有会话状态。每个 Agent 有一个可变 `sessions.json`（会话键、当前 session id、活动时间和计数等）以及追加式 JSONL transcript（对话、工具调用、压缩摘要）；后者用于以后重建模型上下文。它还提供 `sessions.list`、`sessions.describe`、`sessions.send`、`sessions.steer`、`sessions.abort` 等 Gateway RPC。 | 恢复的是历史上下文，不是发布状态。恢复/继续前应从 Gateway 的运行时状态查询，而不是让模型把 transcript 中的待办当事实。[会话存储与压缩](https://github.com/openclaw/openclaw/blob/main/docs/reference/session-management-compaction.md) [Gateway 协议](https://github.com/openclaw/openclaw/blob/main/docs/gateway/protocol.md) |
| Hermes | Gateway 会话以确定性的消息来源键路由。`~/.hermes/state.db` 是会话元数据和全部消息的 canonical store，SQLite/WAL 支持并发读和单写；`~/.hermes/sessions/sessions.json` 仅作路由索引。`/resume` 可恢复已命名会话，`/status` 显示当前 session 信息。 | Hermes 也保留历史上下文；应在恢复后用一个受控的“当前状态”读取步骤刷新，而不是寄望旧会话自行失效。[会话文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md) [Messaging Gateway](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/index.md) |

两者都有上下文清理而非无限累积：OpenClaw 维护 session store、transcript 和 checkpoint，并支持 compact/cleanup；Hermes 可以按 idle/daily/both/none 重置，重置前给予 Agent 一次保存重要 memory/skills 的机会，且有活跃 background process 的会话不会自动重置。[会话存储与压缩](https://github.com/openclaw/openclaw/blob/main/docs/reference/session-management-compaction.md) [Hermes 会话文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md)

## 2. 持久任务状态

OpenClaw 把任务列为 Gateway 的独立可查询事实：`tasks.list`、`tasks.get`、`tasks.cancel` 暴露 Gateway task ledger，而 artifacts 可按 `sessionKey`、`runId` 或 `taskId` 追溯。也就是说，任务状态不是仅存在于一段自然语言总结里。[网关协议](https://github.com/openclaw/openclaw/blob/main/docs/gateway/protocol.md)

Hermes 官方资料明确持久化会话、消息、memory、cron、logs 和 Gateway state；background 工作运行在独立 background session，且活跃 background process 会阻止会话自动 reset。就本次核查到的官方文档而言，未找到与 OpenClaw `task ledger` 对等、可作为全局“待办是否完成”事实源的公开接口。因此，若要避免“聊天说仍待办”，应把可验证任务状态存为独立记录（含状态、证据、完成版本/commit），而不要只写进聊天 transcript。[个人资料与 Profile 状态](https://github.com/NousResearch/hermes-agent/blob/main/CONTRIBUTING.md) [Hermes 会话文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md)

## 3. 启动新鲜度与版本核验

OpenClaw 的升级路径最接近所需的防呆机制：

- 配置写入带有 `meta.lastTouchedVersion`。低版本二进制可以只读检查新配置，但拒绝 start/stop/restart/install 等破坏性服务操作，避免旧 CLI 控制新配置或新服务；排查顺序是 `which openclaw`、`openclaw --version`、`openclaw gateway status --deep` 和读取该版本戳。[排障文档](https://docs.openclaw.ai/gateway/troubleshooting)
- `openclaw update` 在受管服务场景采用脱离运行中 Gateway 的 handoff：停止服务、替换包、刷新服务元数据、重启，并验证 Gateway 的**运行版本和可达性**；启动时还会提示更新。[更新文档](https://docs.openclaw.ai/install/updating)
- Gateway 配置热加载有 schema gate：无效外部编辑被拒绝，推荐 `openclaw config validate` 与 `openclaw doctor --fix` 诊断/修复。[网关配置](https://github.com/openclaw/openclaw/blob/main/docs/gateway/configuration.md)

Hermes 提供 `hermes version` 显示安装版本，`hermes update` 拉取最新代码并重装依赖，`hermes doctor` 检查安装/配置；Messaging Gateway 还提供聊天内 `/update`。代码或配置变更需要重启 CLI/Gateway 才生效。对于 Docker，官方要求 pull 新镜像并重建/重启容器，而不是在容器内执行更新。[命令参考](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md) [Messaging Gateway](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/index.md) [Docker 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/docker.md)

## 4. 后台服务与日志诊断

OpenClaw 将“存储会话”与“活着的频道连接”明确区分：`openclaw sessions` 只显示持久会话，不能证明 Channel 存活；应使用 `openclaw channels status --probe`、`openclaw status --deep` 或 `openclaw health --verbose`。Gateway 同时有控制台输出和 JSONL 文件日志；启动时记录解析出的默认模型和新会话相关默认项。fatal exit、超时关停和重启失败可持久化脱敏 stability snapshot，供 `openclaw gateway stability --bundle latest` 读取。[会话 CLI](https://docs.openclaw.ai/cli/sessions) [Gateway 日志](https://docs.openclaw.ai/gateway/logging) [Gateway CLI](https://github.com/openclaw/openclaw/blob/main/docs/cli/gateway.md)

Hermes 把 Profile 的 logs 和 Gateway state 与该 Profile 一起保存。官方服务路径是 `hermes gateway install` 后 `hermes gateway start`，用 `hermes gateway status` 和 `hermes logs -f` 验证；排障文档也给出 Gateway 日志 `~/.hermes/logs/gateway.log`、`hermes doctor` 以及 systemd 的 `reset-failed`。因此，尚未启动过某 Profile 的 Gateway 时，缺少该 Gateway 日志应被解释为“未产生服务日志”，而非聊天运行时出错。[多 Profile Gateway](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/multi-profile-gateways.md) [Hermes 部署排障](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/skills/bundled/autonomous-ai-agents/autonomous-ai-agents-hermes-agent.md)

## 对 BeeMax 的直接启示（设计原则，非实现结论）

1. 将“对话恢复”和“事实刷新”分成两个动作：恢复 session 后，在首轮或问及版本/进度时读取本地安装版本、Git revision/tag、服务 PID/启动时间、Gateway health 与任务账本；输出应标明这些值的采集时间与来源。
2. 持久化结构化任务账本：至少包含任务 ID、状态、证据（PR/commit/tag）、完成时间和适用 Profile。聊天摘要只能是账本的投影，不能反向成为状态源。
3. 服务命令应区分三种结果：服务未安装/未启动（无日志属正常）、服务运行但不健康、服务健康且运行版本与 CLI/配置版本一致。不要把 `logs` 不存在笼统说成 Gateway 故障。
4. 升级或重启完成后再写“已更新”：重启后实际查询运行版本与健康检查；若 CLI、服务二进制和配置最后写入版本不一致，阻断或至少醒目警告。
5. 给用户的状态回答需带边界：例如“这是恢复会话中的历史待办；当前安装版本/服务状态尚未核验”，直到读到上述实时证据。
