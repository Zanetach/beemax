# BeeMax 统一交互运行时与终端工作台 PRD

| 项目属性 | 企业自研 × Agent 平台基础服务 |
| --- | --- |
| 重要性 | 高 |
| 紧迫性 | 高 |
| 需求方 | BeeMax 产品与工程团队 |
| PRD 编写人 | BeeMax |
| 提交日期 | 2026-07-11 |

## PRD 修改记录

| 变更时间 | 变更内容 | 修改人 | 版本 |
| --- | --- | --- | --- |
| 2026-07-11 | 初始长期架构设计 | BeeMax | v1.0 |
| 2026-07-11 | R1 完成；R2 已交付共享命令、实时状态、结构化审批、活动详情、Picker 与 queue/steer 降级 | BeeMax | v1.1 |
| 2026-07-11 | N1 打通 Pi 原生 steer/follow-up；旧 Runtime 保留确定性队列回退 | BeeMax | v1.2 |
| 2026-07-11 | N2 将模型自动回退收敛到 Core，并增加副作用护栏与统一可见事件 | BeeMax | v1.3 |
| 2026-07-11 | N3 建立 Tool Policy Registry 与统一执行治理第一阶段 | BeeMax | v1.4 |
| 2026-07-12 | N4 自主规划质量闸门拒绝无并行收益的伪 DAG | BeeMax | v1.5 |
| 2026-07-21 | 移除 Tool 审批事件、动作、Broker 与全部 Presenter UI；Tool 通过其余治理边界后直接执行 | BeeMax | v1.6 |

> v1.6 为当前契约。v1.5 及更早版本中的 Approval 实体、`awaiting_approval` 状态、`approval.*` 事件/动作、审批指标与 UI 均已退役，不得由新渠道或客户端继续实现。

---

## 1、项目背景

BeeMax 已具备 CLI、Gateway、会话、工具、子代理和结构化记忆闭环，但交互状态仍分散在 CLI/Gateway 的渲染逻辑与底层 Pi 事件之间。随着 Full Workbench、远程 Gateway、Web 控制台和移动端进入路线，继续复制命令与状态将造成行为分叉。

当前优先问题：

1. 工具、子代理和会话状态缺少统一、可复用的交互事件模型。
2. `beemax chat` 需要同时覆盖 SSH/文本流与状态化工作台，不能要求用户在两个产品入口之间选择。
3. 未来 `beemax chat` Full 模式、Gateway、Web 若各自解释 Runtime 状态，会产生权限、记忆 scope 与取消行为不一致。

解决方向：在 `@beemax/core` 建立一个深模块 `InteractionRuntime`，将交互语义收敛为小接口的状态快照、事件流和动作；`beemax chat` 的 Full/Compact/Plain、Gateway、Web 仅作为 Adapter。当前 I1 实现命名为 `InteractionEventAdapter`，只承担运行时事件转换与取消；完整的订阅、队列和跨端协调留在后续里程碑。

## 2、需求基本情况

| 要素 | 内容 |
| --- | --- |
| 需求提出人 | BeeMax 产品负责人 |
| 功能使用人 | 本地开发者、远程运维者、Agent 用户 |
| 受影响人 | Gateway/渠道接入、能力 Adapter、后续 Web/移动端团队 |
| 核心痛点 | 同一 Agent 在不同交互界面中缺少一致的状态和会话体验 |
| 使用频率 | 每个交互式 Agent 回合 |
| 需求价值 | 以单一 `beemax chat` 入口按环境自适应呈现，且不复制 Agent 逻辑 |

**主场景：本地长时间 Agent 工作台**

用户启动 BeeMax，在同一会话中查看模型、上下文、工具和子代理活动；Tool 在治理边界通过后直接执行；用户可取消、排队或引导运行中的任务，并在中断后恢复同一会话。

## 3、业务分析与系统调研

| 调研对象 | 可借鉴点 | 不直接复制的部分 |
| --- | --- | --- |
| OpenClaw | Gateway/local 连接到统一 TUI；持久 Footer；工具卡和会话选择器 | 不将 BeeMax 绑定到其 Gateway 协议或策略格式 |
| Hermes Agent | Classic CLI 与 TUI 共用 Runtime；busy input、详情分区 | 不复制其 Python/Node 双运行时实现，也不复制 modal 审批 |
| BeeMax 当前架构 | Core/Gateway 职责边界、Profile 隔离、Tool Governance 和记忆 policy 已在 Core 收敛 | 不允许 TUI/CLI 绕开 Core 做 prompt、记忆或授权决策 |

## 4、项目收益目标

| 目标类型 | 衡量指标 | 目标值 | 时限 |
| --- | --- | --- | --- |
| 一致性 | Chat Full/Compact/Plain、Gateway 共享交互动作与状态 | P0 命令 100% 同语义 | I3 前 |
| 可靠性 | 运行中取消成功率 | 100%，无死锁 | I2 |
| 可观测性 | 每个运行中回合可见状态 | 模型、session、耗时、token、工具 | I2 |
| 体验 | 会话恢复与工具详情获取步骤 | 不超过 2 次操作 | I3 |

验收标准：同一 Session 在 Chat Full/Compact/Plain 与 Gateway 间切换时，用户看到的模型、会话、工具、记忆 scope 和取消结果一致；任一 Presenter 都不得显示 Tool 审批 UI。

## 5、项目方案概述

| 模块 | 说明 | 优先级 |
| --- | --- | --- |
| Interaction Runtime | 状态机、事件流、动作处理和订阅 | P0 |
| Direct Tool Experience | Tool 状态、取消与治理拒绝原因显示；不含审批交互 | P0 |
| Chat Presenter | Full/Compact/Plain 三种渲染模式、状态、草稿与详情恢复 | P0 |
| Workbench 能力 | alternate screen、卡片、overlay、picker；由 `beemax chat` 自动选择 | P1 |
| Remote Control | Gateway/Web 接入统一协议 | P1 |
| Cross-device | Web、移动节点、语音与 Canvas | P2 |

MVP 先覆盖 `InteractionEventAdapter + 自适应 beemax chat`；不包含移动节点、语音、Canvas 和复杂多人协作。

## 6、项目范围

| 系统 | 关系 | 本期影响 |
| --- | --- | --- |
| `@beemax/core` | 主体 | 新增交互运行时与状态机 |
| `apps/cli` | Adapter | `beemax chat` 的 Full/Compact/Plain 渲染与输入适配 |
| `packages/gateway` | Adapter | 将渠道输入转为统一 Action，消费事件 |
| `packages/memory` | 能力 | 提供 memory scope 与记忆变更事件 |
| Pi Runtime | 内部实现 | 仅由 Core 适配，不能泄漏到 Presenter |

本期不包含：独立 Web 产品、语音 I/O、移动节点、跨 Profile 共享会话、原始推理展示、渠道侧重写 Agent 逻辑。

## 7、项目风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 直接暴露 Pi 事件 | UI 与底层耦合，未来替换困难 | Core 转换为 BeeMax 语义事件 |
| Chat 各模式命令分叉 | 用户行为与测试不一致 | Command registry 只在 Core 定义一次 |
| 全屏工作台覆盖 SSH 场景 | 运维可用性下降 | 同一 `beemax chat` 自动降级 Plain Presenter，支持 `--plain` |
| Presenter 自建 Tool 授权 | 安全与审计失效 | Core 唯一决策，Presenter 不提交 Tool 授权 action |
| 用户级记忆泄漏 | 隐私事故 | 所有 snapshot/recall 在 Core 校验 scope |

## 8、术语和缩略语

| 术语 | 定义 |
| --- | --- |
| Interaction Runtime | BeeMax 的交互状态机、事件流和动作入口 |
| Presenter | 将交互事件渲染为 Chat Full/Compact/Plain、卡片或 Web 的 Adapter |
| Action | 用户或 UI 对 Core 发出的语义操作 |
| Snapshot | 可恢复、可渲染的当前交互状态 |
| Scope | Profile、平台、chat、用户和 session 组成的权限/记忆范围 |

### 8.1 一等能力原则

搜索、浏览器、记忆、文件、日历、邮件、渠道、媒体与自动化均为 BeeMax 的一等能力。每项能力必须拥有：稳定输入/输出 schema、明确风险等级、可关联 Profile/Scope/Turn 的审计事件，以及由 Core 执行的 Tool Governance。Presenter、Skill 与渠道不得以脚本拼接替代这些契约。

**N3/v1.6 实施状态：** Core 提供强类型 `ToolPolicy`（风险、副作用、可逆性、超时、重试次数、结果上限、影响说明）与 `ToolPolicyRegistry`。自定义一等 Tool 在进入 Pi 前统一包装：强制超时、仅无副作用工具允许有限重试、文本结果有界，并发布 allowed/blocked/started/completed/failed 审计生命周期。Tool Policy 不包含 approval 字段；浏览器、记忆、自动化、Skill、子代理、媒体、Feishu 与 MCP 均在源码声明 Policy。Tool 在 Profile scope、Enterprise Policy、Active Tools、预算、硬边界和 Effect 对账全部通过后直接执行，Presenter 不参与授权。

`bash` 仅作为开发者显式请求的通用终端逃生舱，不承载产品级浏览、邮件、日历、记忆或渠道能力；新增产品能力必须先实现独立 Tool/Capability，再考虑是否提供 shell 兼容路径。

密码、Token 与其他凭据不得进入 `MEMORY.md`、普通记忆库或 Tool 审计内容。当 Agent 需要创建并长期操作账号时，记忆只保存账号用途与不透明 `credential_ref`，真实秘密由 Profile 级 Credential Vault 加密保存，并由一等 Tool 直接注入浏览器或外部服务。敏感信息过滤必须遵循“允许任务内使用，禁止无意扩散”，不得作为全局上下文或 Tool 调用拦截器。

**Credential Vault 第七阶段（2026-07-12）：** Core 已提供 owner-scoped 的加密 Vault 与不透明 Credential Ref；公开接口只允许列出非秘密元数据，错误密钥、错误 owner 与删除后的引用均 fail closed。Profile 生命周期在受保护的 `state/credential-vault.key` 生成或安全补齐独立主密钥，使备份与删除归档不会把密文和密钥拆散；`beemax credentials` 提供不经 argv 的添加、列表、原 Ref 轮换和删除入口，轮换立即替换旧秘密但保持记忆、任务和自动化引用稳定。Profile backup 会用备份目录自己的主密钥重新打开密文并验证 Credential Ref，同时排除写入租约和临时密文；密钥/Vault 不匹配时整个备份失败并清理半成品。doctor 校验密钥与密文，内容无关访问事件写入权限受限的有界审计。一等 `browser_fill_credential` 只接收 selector 与 Credential Ref；`browser_generate_credential` 在 Core 本地生成高熵密码、存入 Vault 并直接填入网页，只返回 Ref，填充失败则删除新建凭据。Gateway 与 CLI 的 Vault 写入由短生命周期、token-fenced 的跨进程写入租约串行化；活跃租约 fail closed，进程崩溃留下的陈旧租约可回收，避免密文最后写入覆盖。Tool 结果、详情与普通审计均不含秘密。邮件等后续 Capability 复用同一注入边界；始终不提供会向模型返回明文的通用 `credential_get` Tool。

## 9、参考文献和引用文档

| 文档 | 位置 | 说明 |
| --- | --- | --- |
| BeeMax Core/Gateway 边界 | `docs/architecture/core-gateway-boundaries.md` | 当前架构约束 |
| OpenClaw TUI | OpenClaw 官方文档 | 本地/远程统一控制台参考 |
| Hermes CLI/TUI | Hermes 官方文档 | Classic CLI/TUI 双 Presenter 参考 |

## 10、功能需求

### 10.1 产品框架概述

```mermaid
graph TB
  subgraph 用户层
    CHAT[beemax chat<br/>单一终端入口]
    GW[Gateway/Feishu<br/>渠道卡片]
    WEB[未来 Web/Mobile]
  end
  subgraph 接入层
    INPUT[Input Adapter<br/>文本/按键/按钮]
    PRESENT[Presenter<br/>Full/Compact/Plain/Card/Web]
  end
  subgraph 业务服务层
    IR[Interaction Runtime<br/>状态机+事件+动作]
    AR[Agent Runtime<br/>模型/工具/会话]
    GP[Tool Governance/Policy]
    MR[Memory Scope/Recall]
    SA[Subagent Manager]
  end
  subgraph 数据层
    SESSION[(Session Catalog)]
    MEMORY[(Memory Ledger)]
    AUDIT[(Tool/Run Audit)]
  end
  CHAT --> INPUT --> IR
  GW --> INPUT
  WEB --> INPUT
  IR --> PRESENT
  IR --> AR & GP & MR & SA
  AR --> SESSION
  MR --> MEMORY
  GP --> AUDIT
```

**核心数据模型**

```mermaid
erDiagram
  INTERACTION_SESSION ||--|{ TURN : contains
  TURN ||--|{ INTERACTION_EVENT : emits
  TURN ||--o{ TOOL_ACTIVITY : runs
  TURN ||--o{ SUBAGENT_ACTIVITY : delegates
  INTERACTION_SESSION ||--o{ QUEUED_INPUT : owns
  TOOL_ACTIVITY }o--|| AUDIT_RECORD : records
  INTERACTION_SESSION }o--|| MEMORY_SCOPE : uses
```

| 实体 | 关键字段 | 说明 |
| --- | --- | --- |
| InteractionSession | id, scope, model, status, preferences | 用户可见会话状态 |
| Turn | id, sessionId, state, startedAt, finishedAt | 一次 Agent 回合 |
| ToolActivity | callId, name, risk, state, summary | 工具卡数据 |
| QueuedInput | id, text, mode, createdAt | queue/steer 的输入记录 |

**核心动作流程**

```mermaid
flowchart TD
  U[用户输入] --> A{解析为 Action}
  A -->|message.send| R[Core 启动 Turn]
  A -->|turn.cancel| C[取消运行/队列/子代理]
  A -->|session.open| S[加载 Session Snapshot]
  R --> E[发布 InteractionEvent]
  C --> E
  E --> V[Chat/Gateway/Web Presenter]
```

**Turn 状态机**

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> running : message.send
  running --> queued : queue input exists
  queued --> running : current turn finished
  running --> completed : turn.finished
  running --> failed : turn.failed
  running --> cancelled : cancel
  completed --> idle
  failed --> idle
  cancelled --> idle
```

| 当前状态 | 动作 | 目标状态 | 约束 |
| --- | --- | --- | --- |
| running | `turn.cancel` | cancelled | 优先级最高 |
| running | `turn.queue` | queued | 保留输入，不改变当前 Turn |
| running | `turn.steer` | running | 仅模型/运行时支持时可用，否则降级 queue |

### 10.2 产品需求详解

#### 10.2.1 Interaction Runtime

外部 Interface 保持小而稳定：

```ts
interface InteractionRuntime {
  snapshot(scope: InteractionScope): Promise<InteractionSnapshot>;
  dispatch(action: InteractionAction): Promise<ActionResult>;
  subscribe(scope: InteractionScope, sink: InteractionEventSink): Unsubscribe;
}
```

业务规则：

| 编号 | 类型 | 规则 |
| --- | --- | --- |
| IR-1 | 约束 | Presenter 不得直接调用模型、工具、记忆或实现 Tool 授权。 |
| IR-2 | 事实 | 每个 event 均带 sessionId、turnId、scope 与时间。 |
| IR-3 | 触发 | `turn.cancel` 必须同时取消 active turn、排队输入与归属子代理。 |
| IR-4 | 推论 | 不支持 steer 的运行时自动将 steer 降级为 queue，并发布 notice。 |

#### 10.2.2 Direct Tool Experience

Presenter 只显示工具名、脱敏摘要、运行状态和治理拒绝原因。不得显示审批按钮、解析数字审批回复、提交 `approval.decide`，也不得让 Tool 进入等待人工确认的状态。

#### 10.2.3 `beemax chat` 自适应 Presenter

| 功能 | 规则 |
| --- | --- |
| 状态行 | 显示 profile、model、session、turn state、耗时、context 与 queue 状态。 |
| 工具详情 | `hidden/collapsed/expanded` 必须为真实可恢复详情，不是仅隐藏开始日志。 |
| Tool 治理 | 仅显示运行或拒绝状态；无审批输入。 |
| 忙碌输入 | I2 保留草稿；I3 支持 queue；I4 支持 steer。 |

**启动与模式选择规则：**

| 触发条件 | 模式 | 行为 |
| --- | --- | --- |
| 交互式 TTY，具备 alternate-screen 能力 | Full | 工作台：状态栏、卡片、overlay、picker、多行 Composer。 |
| 交互式 TTY，但终端能力有限或用户指定 `--no-alt-screen` | Compact | 保留状态行与结构化文本卡，不占用 alternate screen。 |
| stdin/stdout 非 TTY，或用户指定 `--plain` | Plain | 纯文本流，适配 pipe、日志、脚本与故障恢复。 |
| `--gateway <url>` | 以上任一模式 | 仅改变 Runtime 连接位置，不改变命令与状态语义。 |

`beemax tui` 如保留，仅作为 `beemax chat --full` 的兼容别名；产品文档、帮助和 onboarding 只推荐 `beemax chat`。

#### 10.2.4 Full Workbench 呈现能力

| 页面/区域 | 行为 | 权限 |
| --- | --- | --- |
| Transcript | 回答、工具、思考摘要、通知 | 普通用户 |
| Footer | 常驻 session/usage/status | 普通用户 |
| Model/Session Picker | 搜索、选择、恢复、新建 | 当前 scope 用户 |
| Subagent Inspector | 树、状态、耗时、取消 | 当前 scope 用户 |

#### 10.2.5 Gateway 与未来 Web

Gateway 只把渠道消息归一化为 Action，并把 Event 降级渲染为卡片/文本；Web 与 `beemax chat` Full 模式可消费完整 Event。任何界面都不得自行改变模型、prompt、memory scope、Tool Governance 决定或工具 policy。

### 10.3 异常情况处理方案

| 场景 | 处理方案 |
| --- | --- |
| Presenter 断开 | Core 继续运行；可重连后按 event sequence 恢复 snapshot。 |
| 重复 Action | actionId 幂等；重复提交返回已有结果。 |
| Full 模式不支持能力 | 降级为 Compact/Plain 文本卡，不改变 action 语义。 |
| 远程 Gateway 断线 | 保留 session 与运行记录；重新连接后加载 snapshot。 |
| UI 崩溃 | 不影响 Core 会话；CLI 可作为恢复入口。 |

## 11、数据埋点

| 事件 | 参数 | 用途 |
| --- | --- | --- |
| `interaction.turn_started` | surface, model, session | 回合采用率与耗时 |
| `interaction.input_queued` | mode, waitMs | queue/steer 价值 |
| `interaction.presenter_reconnected` | surface, gapEvents | 断线恢复质量 |
| `interaction.session_resumed` | source, age | 会话恢复使用率 |

不得采集原始用户内容、原始推理、密钥或敏感参数；审计引用使用受控 ID。

## 12、角色和权限

| 角色 | 权限 |
| --- | --- |
| 普通用户 | 仅操作自身 scope 的会话、记忆和队列。 |
| Profile 管理员 | 配置模型、渠道、Enterprise Policy、Skills/MCP。 |
| 运维观察者 | 查看匿名化健康、审计和运行指标，不可执行 Agent Action。 |

| 操作 | 普通用户 | Profile 管理员 | 运维观察者 |
| --- | --- | --- | --- |
| 发送/取消当前回合 | ✓ | ✓ | — |
| 查看其他用户会话/记忆 | — | 仅经明确审计授权 | — |
| 查看健康与审计汇总 | — | ✓ | ✓ |

## 13、运营计划

| 阶段 | 范围 | 目标 | 回滚 |
| --- | --- | --- | --- |
| I1 协议试点 | Core + CLI | 事件/动作不改变现有语义 | 保留旧 presenter adapter |
| I2 自适应 Chat | 本地 Profile | 状态、取消、详情闭环；Plain 模式稳定 | `--plain` 文本模式 |
| I3 Full Workbench | 内部开发者 | `beemax chat` 的 picker、overlay、工具卡、恢复 | Compact/Plain 自动回退 |
| I4 远程控制 | Gateway/Web 试点 | 同 session 跨 surface 一致 | Gateway 保持卡片降级 |

培训与推广：发布交互行为对照表与快捷键指南；每两周复盘取消率、队列使用率和会话恢复成功率。

### 13.1 可执行提升路线

| 批次 | 周期 | 可交付物 | 验收门槛 | 对标维度提升 |
| --- | --- | --- | --- | --- |
| R1 统一语义层 | 第 1–2 周 | 有 scope/session/time/sequence 的事件信封；Gateway 消费 Core Event；Core 原子取消运行、队列、子代理 | CLI 与 Feishu 的 `/stop` 和工具事件可用同一契约断言 | 核心 Agent、权限、工程交付 |
| R2 终端控制台 | 第 3–5 周 | 常驻 Footer、工具卡、会话和模型 Picker、草稿、队列 | SSH/Plain 无 ANSI 回归；Full/Compact 的同一操作结果一致 | Chat / 终端体验 |
| R3 控制面与渠道 | 第 6–9 周 | 认证后的 Web 控制台；Telegram、Discord Adapter；远程恢复协议 | 新渠道不触碰 Agent/Tool Governance/记忆实现，只实现 Input/Presenter Adapter | 渠道、Web、运维 |
| R4 媒体与设备 | 第 10–14 周 | 附件/图片/音频管道、语音输入输出、Canvas/节点试点 | 媒体权限、大小、留存与失败回退均可观测 | 设备、语音、多模态 |
| R5 生产化 | 全程并行 | E2E、发布候选、兼容性矩阵、指标/告警、恢复演练 | 每个发布候选有真实渠道 smoke test、回滚包与迁移说明 | 工程交付成熟度 |

R1 先完成，未通过其验收不进入新增渠道或语音开发；这保证 BeeMax 不会以更多入口扩大不一致行为。

**实施状态（2026-07-21）：** R1 已完成事件信封、原子取消、会话 open/reset/compact 与有界 `actionId` 幂等；CLI 和 Gateway 的 Profile Control 走同一 Action 路径。v1.6 已从 Core、CLI、Gateway、Feishu 和 Full Workbench 删除 Tool 审批事件、动作、Broker、回复解析、卡片按钮、Overlay 与指标。N1 已将 `turn.steer` 和 `turn.queue` 分别接入 Pi 原生 steer/follow-up；旧 Runtime 或不可用会话保留队列回退。N2 已把模型自动回退收回 Core，并在出现可观察输出或 Tool 执行后禁止自动重放。Full 模式保留状态栏、转录区、活动卡、子代理卡、搜索 Picker 与可编辑 Composer。R3 已具备版本化控制协议、运行时 JSON 校验、精确 scope 校验、隐私受控事件恢复，以及默认仅 loopback 的 Bearer 认证 HTTP transport。R4 已打通飞书图片/音频/文件管道；R5 记录无内容的回合、队列和重连指标。

**N4 自主规划状态（2026-07-12）：** `task_plan_execute` 已由 Core 验证模型生成的 DAG、Acceptance Criteria、依赖关系和并发上限，并通过 Profile Task Scheduler 自动并行 Sub-Agent。新增拓扑宽度质量闸门：自动编排必须至少存在一个包含两个可同时运行 Task 的执行波次；完全串行的步骤清单在持久化前被拒绝，主 Agent 必须直接完成或重新拆成真正独立工作流。TaskGraph 内部仍允许显式串行 DAG，用于恢复和受控系统计划。

长任务创建与恢复采用受监督后台语义：工具在持久化 Plan 后立即返回 `planId`，`TaskPlanRuntime` 持有可取消执行，Task 状态与完成通知负责后续观察，不占用当前 Session turn。`/stop` 同时级联当前 turn、普通 Sub-Agent 与当前 scope 的活跃 Task Plan；已知 `planId` 也可单独取消。隔离 Sub-Agent 只获得绑定当前真实 Task ID 的 `task_checkpoint_save`，不能修改同 scope 的其他 Task；Turn ID 不得作为 Task ID。Checkpoint、自动 route fallback 与 Skill 候选/试验证据在持久化边界统一拒绝 Credential Material；真实秘密只能以 Credential Ref 存在。

## 14、待决事项

| 编号 | 待决事项 | 负责人 | 状态 |
| --- | --- | --- | --- |
| TBD-1 | Full Workbench 技术选型 | BeeMax | 已决策：复用 `@earendil-works/pi-tui`，Plain/Compact 保留独立降级 |
| TBD-2 | 远程 Interaction Protocol 与认证 | BeeMax | 已决策：v1 JSON/HTTP，Bearer 映射精确 Scope；事件按 sequence 恢复，后续可增加 WebSocket transport |
| TBD-3 | queue/steer 兼容性与上限 | BeeMax | 已决策：Pi Runtime 使用原生 steer/follow-up；旧 Runtime 保留单槽 queue，steer 不支持时明确降级并替换已有输入 |
| TBD-4 | Tool 直接执行治理 | BeeMax | 已决策：无人工审批；Enterprise `require_approval` fail-closed，其余 Tool 通过硬边界后直接执行 |
| TBD-5 | 多用户 Profile 管理边界 | BeeMax | 已决策：当前 Profile 为单所有者隔离单元；不提供管理员跨用户记忆/会话读取，未来多租户另立治理 PRD |

---

## 附：待完善清单

### 🔴 必须补充

当前阶段无未决阻塞项；公网部署、外部渠道凭证与真实渠道 smoke test 在具备对应账号后执行。

### 🟡 建议补充

1. 为公网控制面补充密钥轮换、速率限制和部署手册。
2. 在具备账号后补 Telegram/Discord 真实渠道兼容性矩阵。

### 🟢 可选完善

1. 后续为 Full Workbench 提供主题、鼠标与无障碍方案。
2. 在 Web 控制台加入可视化 session/subagent 时间线。
