# OpenClaw 与 Hermes Agent：Chat 运行与回复呈现设计

核查日期：2026-07-11。范围仅限 OpenClaw 与 Nous Research/Hermes Agent 的官方文档、官方仓库源码；下文“已核实”均附一手来源。“建议/推断”是针对 BeeMax 的产品设计判断，不是上游已有功能的宣称。

## 结论

两者的共同原则是：**对话正文、工具生命周期、推理可见性、持久化记录是不同层**。用户应获得干净的最终回复和可理解的执行状态；富客户端通过带类型的事件渲染工具卡片/进度，不能把调试文本或模型推理混进 assistant 正文。推理强度、推理是否展示、推理是否因协议需要保存，也应是三个独立开关。

BeeMax 已把通用 Interaction 事件与平台呈现分离：Gateway 只通过 `InteractionPresenter` 驱动呈现，飞书 Adapter 独立拥有单卡流式更新、工具时间线和最终 footer，纯文本渠道使用通用降级 Presenter。原始 `thinking_delta` 默认不展示，只有受信任诊断配置显式选择 `raw` 时才进入飞书时间线；后续仍可继续深化统一的持久化 `RunRecord`。

## 已核实：OpenClaw

### 会话与输入路由

- ACP 桥将一个 ACP session 映射到一个 Gateway session key；默认 key 形如 `acp:<uuid>`。恢复时它只重放已存的 user/assistant 文本，不重放历史 tool/system 记录。这样恢复的是用户可见对话，而不是把内部运行记录重新塞回聊天界面。[官方 ACP 文档/源码](https://github.com/openclaw/openclaw/blob/main/docs.acp.md#L240-L300)
- 上下文裁剪会从**本次模型 prompt**中移除旧工具结果，但不会删除磁盘 transcript；跨会话召回还会清除 thinking tag、工具调用脚手架与控制 token。[官方 context 文档](https://docs.openclaw.ai/concepts/context) [官方 multi-agent 文档](https://docs.openclaw.ai/multi-agent)

### 流式回复、工具进度与格式

- `/verbose on|full|off` 默认 `off`。在 `on` 时，工具调用以独立的 metadata 气泡呈现（工具开始时显示 emoji、工具名和参数摘要），不是混入回答 token 的流；`full` 才增加截断后的完成输出/原始错误细节。[官方工具与 thinking 文档](https://docs.openclaw.ai/tools/thinking#verbose-directives-verbose-or-v)
- Control UI 接收流式 tool call 与 live tool-output card；ACP 也把 `tool_call` / `tool_call_update` 与文本输出分开，且不发送 thought/plan stream。这说明“富界面可显示结构化进度”不等于“向用户展示模型内部思考”。[官方 Control UI 文档](https://docs.openclaw.ai/web/control-ui) [官方 ACP 文档](https://github.com/openclaw/openclaw/blob/main/docs.acp.md#L261-L265)

### 思考 / reasoning

- `/think` 调节模型的 thinking effort；`/reasoning on|off|stream` 调节**可见性**，两者分离。可见性默认解析为 `off`；`on` 发独立 `Thinking` 消息，`stream` 只在生成时预览 reasoning，最后回复不包含它。畸形 thinking tag 在普通回复中也会被隐藏。[官方 thinking 文档](https://docs.openclaw.ai/thinking)
- 指令在送入模型前被剥离；独立指令可保存为 session setting，而行内指令只影响当前消息。[官方 slash command 文档](https://docs.openclaw.ai/slash-commands)
- 某些 provider 的后续 tool 调用要求重放 `reasoning_content`；DeepSeek 文档明确区分这一协议连续性需求与用户可见性，禁用时会从出站 history 移除它。因此，“必要时保留 provider reasoning”不蕴含“默认展示/长期记忆 reasoning”。[官方 DeepSeek provider 文档](https://docs.openclaw.ai/providers/deepseek)

## 已核实：Hermes Agent

### 会话与输入路由

- `~/.hermes/state.db`（SQLite）是 session 元数据、system-prompt snapshot、完整 role/content history、工具调用/结果、token 和时间戳的 canonical store；每轮实际送模型的是选定 system prompt、当前 context window 和显式注入，而不是不加筛选地回放全部存储内容。[官方 sessions 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md#L250-L279)
- 会话恢复会恢复完整对话、tool call 与回复，CLI 以 `--continue` / `--resume` 路由到指定或最近 session。[官方 CLI 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/cli.md)

### 流式回复、工具进度与格式

- Hermes 的 host/event 协议定义 `message.delta`、`message.complete`、`tool.start`、`tool.progress`、`tool.complete`，以及 approval、clarify、sudo、secret、lifecycle、error 等独立事件。ACP 将工具输出映射为 ToolCall/Diff block，而不是回答文本。[官方 programmatic integration 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/programmatic-integration.md#L269-L302)
- API 的普通文本走 chat-completion SSE；工具开始事件走自定义 `event: hermes.tool.progress`，官方说明其目的就是避免污染持久化 assistant text。Responses API 则使用原生 `function_call` / `function_call_output` item。[官方 API server 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/api-server.md#L286-L357)
- 工具进度可配 `off|new|all|verbose`，按平台能力决定是否显示；`interim_assistant_messages` 是与工具进度独立的、已完成的中间自然语言更新。最终消息可选附加 model/tools/duration/cost footer，interim 消息保持干净。[官方 configuration 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md#L1249-L1264) [interim/footer 配置](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md#L1301-L1328)

### 思考 / reasoning

- `show_reasoning` 默认 `false`，streaming 默认也为 `false`。这与 OpenClaw 一致：显示思考是显式展示策略，而不是流式回答的默认组成部分。[官方 configuration 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md#L1249-L1264)

## BeeMax 当前实现（仓库核查）

| 项目 | 当前行为 | 结论 |
| --- | --- | --- |
| 会话路由 | Core 以可信 Profile、Channel Instance、Conversation 和 Thread 构造 session key；群聊共享 Conversation 与 Actor 权限保持分离。 | 路由语义由通用 Runtime 持有，不属于任何平台 Adapter。[session-coordinator.ts](/Users/zane/Documents/Github/BeeMax-Agent/packages/core/src/session-coordinator.ts:8) [agent-scope.ts](/Users/zane/Documents/Github/BeeMax-Agent/packages/core/src/agent-scope.ts:18) |
| 流式交付 | Dispatcher 只调用 `InteractionPresenter`；飞书 Adapter 的 Presenter 独立管理 `CardSession`、单卡更新和 FlushController，其他渠道可使用纯文本降级。 | 与两者的“结构化事件→平台能力呈现”方向一致，Gateway 不拥有飞书卡片实现。[dispatcher.ts](/Users/zane/Documents/Github/BeeMax-Agent/packages/gateway/src/core/dispatcher.ts:210) [presenter.ts](/Users/zane/Documents/Github/BeeMax-Agent/packages/channel-feishu/src/presentation/presenter.ts:18) |
| 工具进度 | 通用 Interaction 事件跨 Presenter seam 传递；飞书 `CardSession` 将 `tool.updated` 聚合为有界工具状态和 timeline。 | 平台细节保持在 Adapter 内，工具状态不会混入最终 answer。[session.ts](/Users/zane/Documents/Github/BeeMax-Agent/packages/channel-feishu/src/presentation/session.ts:52) |
| reasoning | `thinking.delta` 可保留为运行事件，但 Feishu renderer 默认过滤 reasoning；只有受信任诊断 Profile 显式选择 `reasoningDisplay: raw` 时展示，且单项最多 1200 字。 | 已与 OpenClaw、Hermes 的默认隐藏策略一致。[render.ts](/Users/zane/Documents/Github/BeeMax-Agent/packages/channel-feishu/src/presentation/render.ts:25) |
| 最终格式 | 飞书 Adapter 渲染主 Markdown、默认不含 raw reasoning 的执行时间线和可选 footer；无富呈现能力时 Gateway 发送最终纯文本。 | 最终正文与执行状态分层，平台能力不足时仍有确定降级路径。[render.ts](/Users/zane/Documents/Github/BeeMax-Agent/packages/channel-feishu/src/presentation/render.ts:29) [text-presentation.ts](/Users/zane/Documents/Github/BeeMax-Agent/packages/gateway/src/core/text-presentation.ts:11) |

## 对 BeeMax 的建议（设计推断）

### 1. 建立统一的运行事件与记录

在 core 定义 append-only `RunEvent`，由每个渠道 adapter 只负责渲染：

```ts
type RunEvent =
  | { type: "run.started"; runId: string; at: string }
  | { type: "assistant.delta"; text: string }
  | { type: "assistant.interim"; text: string }
  | { type: "tool.started"; callId: string; name: string; summary?: string }
  | { type: "tool.progress"; callId: string; summary: string }
  | { type: "tool.finished"; callId: string; outcome: "ok" | "error"; summary?: string }
  | { type: "governance.blocked"; callId: string; reasonCode: string }
  | { type: "reasoning.delta"; text: string; providerRequired?: boolean }
  | { type: "run.finished"; answer: string; usage?: Usage };
```

`RunRecord`（event、时间、run/session ID、工具 canonical input/output、治理结果、错误）独立于 `ConversationTranscript`（仅 user、assistant final/interim、必要 tool protocol item）。这直接吸收 Hermes 的“工具进度不能污染 assistant text”与 OpenClaw 的“恢复时不把内部记录直接回放”为原则。BeeMax 不把上游的审批事件复制成 Tool 等待协议。

### 2. 把三种“思考”拆开

| 概念 | 默认 | 是否进给模型的历史 | 是否给用户 |
| --- | --- | --- | --- |
| `reasoning_effort`（模型预算） | provider/model 默认 | provider 决定 | 否 |
| `reasoning_protocol`（provider 为工具续接必须重放的字段） | 仅需要时密封保存 | 仅回传同 provider adapter | 否 |
| `reasoning_display`（调试/透明度） | `off` | 不应当作为 memory/普通聊天历史 | 仅显式开启、独立可折叠视图 |

推荐配置：`chat.reasoningDisplay = off | summary | raw`，默认 `off`；`summary` 只能显示运行时生成的短状态（如“正在检索资料并核对来源”），不能直接复用 raw chain-of-thought；`raw` 仅限本地开发者控制台/受信任管理员、明确提醒敏感性，且默认不落入检索记忆。

### 3. 默认回复卡片与状态机

```text
收到消息 → “处理中”/typing
          → 工具开始：执行详情（工具名 + 脱敏摘要 + running）
          → 工具结束：更新为完成/失败（简短结果）
          → 可选：一句用户可见的阶段性进展
          → 最终：回答 Markdown + 默认折叠“执行详情” + 可选 footer
```

- 主区只放可直接阅读的 answer；不要在无 answer 时回退显示 raw `thinkingText`。
- 工具默认展示 `new`：开始与最终状态；`all/verbose` 仅由用户或 profile 开启。参数、工具输出和错误要按工具 schema 脱敏并限长；失败给可行动的摘要，原始错误仅诊断模式显示。
- 平台不支持 message edit/card 时，降级为：typing → 有节流的 `正在执行：<工具>` 文本 → 最终单条 Markdown，不发送 token 级碎片。
- footer 只在最终消息加，默认 `耗时 · 模型`；token/context/cost 设置为可选诊断字段，避免给普通用户制造噪声。

### 4. 会话恢复与事实边界

恢复 session 只恢复对话可见内容与协议需要的 tool item；不要把 progress、raw reasoning、旧状态提示当用户事实。用户问“当前版本/是否完成”时，先调用已有 runtime-facts/任务账本，再把证据和采集时间写到 final answer；这与上述上游的会话/运行记录分层一致。

## 建议的验收标准

1. 默认飞书卡片、CLI 及 API 都不会显示或持久化 raw reasoning 为 assistant 正文。
2. 任何工具调用都有稳定 `callId`，在多次进度更新后仍只显示一个工具条目；用户可在授权范围内查看简短结果。
3. `--verbose`/配置切换只改变 renderer，不改变 canonical transcript 与最终答案。
4. session resume 后只出现一次最终回复历史；旧 tool-progress/thinking 不会重复发送。
5. 需要 provider reasoning 续接的模型仍可正常 tool-call；该字段无法通过 memory search、导出聊天或默认飞书卡片读到。
6. 同一 run 在飞书卡片、CLI 与 API 的最终 answer 一致，差异只在平台 capability renderer。
