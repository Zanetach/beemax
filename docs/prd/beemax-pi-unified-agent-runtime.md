# BeeMax Pi-native 组织智能 Runtime PRD

| 项目 | 内容 |
| --- | --- |
| 状态 | **唯一权威规格（Canonical）** |
| 重要性 | 高 |
| 紧迫性 | 高 |
| 需求方 | BeeMax 产品与 Runtime 团队 |
| PRD 编写人 | Codex（基于产品负责人确认的方向） |
| 初始日期 | 2026-07-13 |
| 当前版本 | v2.2 |
| 实施任务 | [`tickets.md`](../../tickets.md) |

## 修改记录

| 版本 | 日期 | 内容 |
| --- | --- | --- |
| v1.0 | 2026-07-13 | 定义统一 Task、Policy、Effect、Capability、Context、Memory 与 Pi Runtime 改造 |
| v2.0 | 2026-07-13 | 合并 intelligence-first 设计；明确 Pi 是唯一执行内核；分离 Situation 与 Access Scope；加入 Organization Memory、Initiative、组织学习与自适应自治方向 |
| v2.1 | 2026-07-13 | 落地统一 Media Understanding seam；支持原生视觉、辅助视觉与 Ubuntu 本地 OCR，不新增 Agent Loop |
| v2.2 | 2026-07-14 | 落地 Registry-based ChannelHost；一个 Profile Runtime 同时承载飞书/Lark 与 Telegram adapter，保持 Gateway/Core 分权 |

---

## 1. 产品定义

### 1.1 产品定位

BeeMax 是一个以 Pi 为智能执行内核的组织智能 Runtime。它进入未知企业后，能够从语言、历史、工具结果、企业知识与可信系统引用中理解当前 Situation，接受 durable responsibility，通过 Pi 持续执行，验证真实结果，并从工作 Episode 中逐渐理解组织惯例。

BeeMax 的近期产品形态是可靠、主动、可恢复、可学习的企业 Agent Runtime；中期是能够长期承担组织责任的数字员工平台；长期可以演进为连接企业信息、目标、人员与行动的组织智能系统。

### 1.2 产品公理

> BeeMax 修复执行完整性，不定义客户业务本体。

客户的行业、实体、关系、惯例、例外和权责结构无法由 Runtime 预先枚举。Core 不得内置客户、订单、工单、项目、合同、工作流阶段等业务概念或分支。Agent 动态理解业务意义；Runtime 负责身份隔离、权限、预算、长期责任、副作用、恢复和验证。

产品关系是：

```text
用户提供方向、价值、更正和关键决策。
Agent 负责理解、规划、执行、验证和跟进。
企业提供可信身份、数据、正式 Policy 和必要授权。
```

### 1.3 核心结果

BeeMax 必须形成完整闭环：

```text
理解组织
→ 形成责任
→ Pi 执行
→ 验证结果
→ 学习组织
→ 更好地处理下一次工作
```

它不是聊天回答器、固定规则工作流、多个 Agent Loop 的编排器，也不是 Pi 外围的 Prompt 包装器。

---

## 2. 当前状态与核心问题

### 2.1 已有可靠基础

当前代码已经具备：

- Pi 模型、Agent Loop、Session、Tool、Streaming、Steering、Follow-up、Retry、Compaction 和资源加载；
- durable Task、Task Run、Task Plan、Checkpoint、Lease、Recovery 与 Verification；
- Memory Claim、Candidate、Evidence、Conflict 与作用域隔离；
- Tool Policy、Approval、Credential Vault、Skill Runtime 与 Interaction Runtime；
- CLI、Gateway 和飞书入口；
- P6 Memory 与 P7 Task recovery 的验收测试基础。

这些能力继续作为目标架构的地基，不推倒重写。

### 2.2 尚未收敛的问题

1. `businessContext` 同时承担业务语义、Memory 选择器和类似权限范围的职责，Situation 与 Access Scope 被混用。
2. 用户文本能够产生 `subject/object`，随后进入 Memory 硬过滤和 durable Objective；不可信推断与可信引用没有结构化区分。
3. Pi Tool Effect authority 与 Task Receipt JSON 是两套事实表达，普通 Tool mutation 未自动贯穿 Task recovery。
4. Interactive、direct、planned Task、Automation 与 Recovery 存在不同完成语义；未来 Initiative 可能成为新的执行路径。
5. `agent_end` 在部分路径被当作 Objective 成功，但 Pi 停止只代表当前执行静止，不代表业务结果已验证。
6. CLI 与 Gateway 重复装配 Memory、Pi、Capability、Task、Effect、Recovery、Verification 和 Credential。
7. TurnUnderstanding 与 planning 主要由关键词和正则驱动，只能作为低成本 fallback。
8. Heartbeat 仍是 timer、固定 Prompt 与通知过滤，不是 durable Initiative。
9. Memory 能保存对话、Claim 和 Task，但尚未形成 Episode、Correction、Exception、Convention 等 Organization Memory。
10. 原 P0、P1、P3、P4、P9、P10 仍缺真实评测或生产闭环。

---

## 3. 目标与非目标

### 3.1 目标

1. 以一个 Pi Runtime 执行用户任务、自动化、主动工作与恢复任务。
2. 在不了解客户业务模型时仍能安全开始工作，并通过证据逐步理解。
3. 将开放业务语义与可信身份授权彻底分离。
4. 所有长期责任进入 durable Objective 和 Task Ledger。
5. 所有 mutation 进入唯一 Effect authority，并支持幂等、unknown 与 reconcile。
6. 所有完成声明经过 Verification，未验证结果不得满足依赖。
7. 将 meaningful outcome、Correction、Conflict 和 Exception 沉淀为 Organization Memory。
8. 让 Agent 发现有价值的工作，优先调查和解决，不要求用户规定每个步骤。
9. 通过 Enterprise Policy adapter 适应不同企业边界，不在 Core 固定企业规则。
10. 保持可评测、可解释、可暂停、可回滚和渐进开放的自主性。

### 3.2 非目标

1. 定义行业本体或通用企业流程模型。
2. 要求企业在首次使用前配置全部规则。
3. 让一次行为、批准或纠正自动成为永久规则。
4. 允许模型置信度授予数据访问或伪造权威事实。
5. 新增第二套 Agent Loop、Memory authority、Task Queue、Scheduler、Capability Router 或 Policy 状态机。
6. 用 experimental `pi-orchestrator` 替代 Task Ledger；它未来只能作为执行 adapter。
7. 自动发布 Enterprise Policy 或直接修改生产 Skill。
8. 在本阶段开放高风险、不可逆的全自主执行。
9. 为目录或架构纯粹而大规模重写 Pi。

---

## 4. 统一术语

### 4.1 Situation

Agent 对当前发生什么、为何重要、有哪些目标、约束、证据、冲突和未知项的开放、可更正理解。Situation 可以包含任意企业词汇，但不能产生授权事实。

### 4.2 Access Scope

由可信 identity、membership、enterprise system 或授权 adapter 提供的信息与能力使用范围。Access Scope 是硬约束，不描述客户业务意义，也不能从用户文本或模型推断中生成。

### 4.3 Objective、Task 与 Task Run

- **Objective**：Agent 接受的 durable desired outcome。
- **Task**：为交付 Objective 而承担的 durable outcome。
- **Task Run**：一次执行尝试；重试创建新 Run，不复制 Task。
- **Schedule**：在未来时间或周期发出 Trigger 的规则，不是 Task；Trigger 可以导致通知、准入 durable responsibility，或不产生工作。
- **Initiative**：Agent 发现 meaningful work 并创建或更新 Objective 的行为，不是通知。

### 4.4 Candidate Outcome 与 Verification

Pi 执行产生 Candidate Outcome。Verification 独立判断其是否满足 Acceptance Criteria。Pi `agent_end` 或 `run_settled` 只表示当前执行静止；只有 Verification `accepted` 才能完成 Task 或满足依赖。

运行时以两个正交事实表达这一区别：Pi 对应的 Task Run 可以在 Candidate Outcome 持久化后成功结算，而 durable Task 继续保持 active 并记录 `verification=unavailable`；Verification 接受后 Task 才进入 `succeeded`。Objective 仅聚合全部已接受的子 Task，未验证结果不会进入交付或 Memory 发布。

### 4.5 Organization Memory

从 Episode、结果、目标、纠正、冲突、惯例、例外和权威证据中积累的组织理解。它不是 Chat History、Task Ledger 或固定业务本体。

### 4.6 Legacy Work Context

现有 `businessContext` 与 `subject/object` 在迁移期保持可读，但只作为 legacy evidence reference。目标模型使用 Situation 与 Access Scope，不再用固定两槽表示未知企业业务。

---

## 5. Pi 与 BeeMax 的分工

### 5.1 Pi 是唯一智能执行内核

Pi 负责智能执行过程：

- Provider、模型、流式响应与 Tool Call 协议；
- Turn、模型与 Tool 循环；
- Tool 参数验证、串行或并行执行、取消与增量结果；
- Session transcript、active tools 与当前执行状态；
- Steering、Follow-up、Abort 与 Retry；
- Context transform、Compaction 与模型窗口；
- Runtime lifecycle events。

Pi 管理“当前智能执行如何发生”。

### 5.2 BeeMax 管理组织责任与长期事实

BeeMax 负责：

- Situation 与可信 Access Scope；
- durable Objective、Task、Task Run、Dependency 和 Recovery；
- Organization Memory；
- Initiative；
- Capability selection 与 Enterprise Policy；
- Execution Grant；
- Effect authority；
- Checkpoint 与 Verification；
- Episode、Convention Candidate 与组织学习；
- Delivery、Outbox 与渠道 adapter。

BeeMax 管理“为什么做、为谁负责、是否允许、是否真正完成、组织学到了什么”。

### 5.3 融合原则

融合的是执行生命周期、状态身份和可靠性协议，不是把企业业务和持久化实现塞进 Pi。

```text
BeeMax Organizational Runtime
└── Pi Execution Kernel
    ├── pi-ai
    ├── pi-agent
    └── AgentSession
```

允许对 Pi 做有证据的通用定点深化，例如结构化 Execution Envelope、生命周期 identity、settlement、Checkpoint contribution 与 Compaction preservation。禁止将 Memory SQL、Task SQL、企业 Policy、渠道 Delivery 或客户业务本体写入 Pi 内核。

---

## 6. 目标架构

```text
Messages / Timers / Enterprise Events / Task Transitions
                         |
                         v
                  Trigger Adapters
                         |
                         v
                Unified Work Admission
                         |
              +----------+----------+
              |                     |
              v                     v
         Access Scope            Situation
              |                     |
              +----------+----------+
                         v
               Organization Memory
                         |
                         v
              Initiative / Goal Decision
                         |
                         v
                 Durable Objective
                         |
                         v
              Pi-native Execution Lifecycle
       Context -> Reasoning -> Capability -> Tool
          ^                              |
          |                         Effect/Receipt
      Steering                           |
      Compaction                    Checkpoint
          ^                              |
          +---------- Task Progress -----+
                         |
                         v
                    Verification
                         |
              +----------+----------+
              |                     |
              v                     v
        Task Transition          Episode
                                      |
                                      v
           Correction / Exception / Convention Candidate
                                      |
                                      v
                         Organization Memory
```

Interaction、Automation、Initiative、Schedule、enterprise event 与 Recovery 都是 Trigger adapter；它们不能拥有独立 Agent Loop 或不同完成语义。

### 6.1 ChannelHost

Gateway 使用 `AdapterRegistry + ChannelHost + GatewayDeliveryPort` 作为唯一消息接入形态。一个 Profile 只创建一次 Core/Pi Runtime，可挂载多个不同平台 adapter；adapter 只负责可信 ingress、媒体临时生命周期、呈现能力和 delivery。渠道连接失败彼此隔离，但不能复制 Runtime、Task Ledger、Memory、Policy、Effect、Verification 或 Scheduler。

渠道声明使用开放的 adapter ID 与 `gateway.channels[]`，Core 不枚举平台。Secret 由 `credentialRef` 指向 Profile 受保护来源，不能写入普通 settings。没有卡片能力的平台自动降级为最终文本；这种降级只改变呈现，不改变执行、审批、完成或恢复语义。

### 6.2 Media Understanding

聊天图片、后续 steer 和 follow-up 在进入 Pi prompt 前统一经过 Media Understanding deep module：

```text
Inbound Media
  -> native image input when the active Pi model declares it
  -> otherwise ranked Media Understanding adapters
       -> configured auxiliary Pi vision model
       -> locally discovered OCR on Ubuntu/macOS
  -> provenance-bearing untrusted evidence
  -> the same Pi-native Execution Lifecycle
```

该 module 只承担感知，不拥有规划、Tool、Task、Memory 或完成判断。其 interface 接收 `text + images + primaryModel`，返回原生图片或结构化 Receipt；内部隐藏能力排名、低置信度升级、失败切换、输入摘要、输出限制和二进制脱敏。没有可用能力时必须显式失败，禁止让纯文本模型假装看过图片。

企业可以配置是否启用远程辅助视觉、本地 OCR 命令、语言和超时；配置表达能力与部署约束，不包含客户、订单、工单、发票等业务本体。

---

## 7. 五个 Runtime 状态权威

| Authority | 唯一负责 | 不负责 |
| --- | --- | --- |
| Pi Execution State | 当前消息、模型、Tool、Streaming、Steering、执行队列 | 长期责任、业务完成 |
| Task Ledger | Objective、Task、Run、Dependency、Checkpoint、Recovery、Verification 状态 | 对话全文、企业知识 |
| Effect Authority | planned/executing/committed/failed/unknown、幂等与 reconcile | Task 成功判断 |
| Organization Memory | Episode、理解、纠正、冲突、惯例、例外与证据 | 当前执行 lease、正式授权 |
| Governance Decision Ledger | Access Scope reference、Policy version、Grant、Approval 与行动决策证据 | 模型推断、客户业务本体 |

企业 identity、membership 与正式 Policy 系统是 Governance 的可信上游；Runtime 保存引用和决策记录，不复制成为新的企业事实 authority。

任何 projection、索引、JSONL 或分析仓库必须可从权威状态重建，不能成为第二个写入事实源。

---

## 8. Execution Envelope 与单一执行链

每次 Pi 执行必须携带结构化 Execution Envelope，至少表达：

- execution identity；
- trigger kind；
- Objective、Task 与 Task Run reference；
- trusted Access Scope reference；
- execution budget 与 deadline；
- recovery 或 verification mode。

Envelope 不包含固定客户业务 schema，也不包含 Credential Secret。

统一链路是：

```text
Trigger
→ Build Situation under trusted Access Scope
→ Create or update durable Objective
→ Create Task Run and Execution Envelope
→ Pi Context / Reasoning / Capability / Tool
→ Effect + Checkpoint
→ Pi run_settled
→ Candidate Outcome
→ Verification
→ Task transition
→ Episode publication
```

Durability is admitted from the responsibility expressed by the Turn, not from whether planning selected direct、single delegation 或 DAG。A responsibility-bearing direct Turn creates its Objective、Task Run and Execution Envelope before Pi starts, records native Turn checkpoints, and submits its Candidate Outcome to the same independent verifier. Single delegation is represented as a one-Task Plan and uses the same TaskGraph lifecycle as DAG nodes. TaskGraph remains a deterministic dependency、lease、retry and Verification scheduler; it never performs model reasoning or becomes another Agent Loop.

Steering、model fallback and Capability reroute continue inside the active Task Run because they advance the same execution attempt. Verification rejection preserves the Objective but creates a separately identified bounded Corrective Task Run and a `mode=correction` Execution Envelope.

Automation Scheduler 只负责 Schedule persistence、Occurrence materialization、due claim、lease、misfire、有限重试和运行历史；它不创建或结算 Task。需要 Pi 工作的 Schedule Occurrence 以稳定的 `schedule id + nominal due time` 形成 Automation Trigger，由统一 Runtime 构建 Situation、召回 Context、创建 Objective/Task Run、保存 Checkpoint 并执行 Verification。Occurrence 保存 Objective/Task Run 引用，但不复制 Task 状态。Reminder delivery 仍可作为通知 Trigger 直接交付，不伪造 Agent Task；Heartbeat 保留为 Initiative 的 trigger adapter，避免安静检查制造空 Objective。

Pi 的 verified Outcome 与渠道 Delivery 分开结算：执行成功先原子保存 Occurrence、Run 和 Delivery Outbox，再由独立 worker 通过 ChannelHost 投递。渠道失败只重试 Delivery，不得重新执行 Pi、Task 或已提交 Effect。所有渠道暂时离线时，Profile Runtime、Scheduler 和 Recovery 继续运行，ChannelHost 负责监督重连。

Recovery 先由 Effect Authority 判定旧 Task Run 是否允许 replay，再由 Task Recovery 从 durable Checkpoint 创建新的 recovery Task Run 和 `trigger=recovery` Execution Envelope。新执行收到旧进展、evidence、committed Effect references 与 next safe step，并继续通过同一 TaskGraph Verification 生命周期；Recovery 不拥有第二套模型循环。

### 8.1 Pi 生命周期融合点

| Pi 生命周期 | BeeMax 行为 |
| --- | --- |
| Prompt admission | 关联 Situation、Objective、Access Scope 与预算 |
| Context transform | 贡献 Task preservation、Organization Memory 与 Policy constraints |
| Active tools | Capability 排名、渐进激活与版本检查 |
| beforeToolCall | Governance、Execution Grant 与 planned Effect |
| afterToolCall | Effect terminalization、Task evidence 与 Checkpoint candidate |
| turn_end | 保存进展、预算与下一步状态 |
| prepareNextTurn | Steering、换路与 corrective execution |
| Compaction | 结构化保留未完成责任、unknown Effect 与 Acceptance Criteria |
| run_settled | 产生 Candidate Outcome 并触发 Verification |
| Abort / crash | 中断 Task Run，按 Effect 与 Recovery Policy 决定后续 |

### 8.2 Effect 单一权威

所有 mutation 在 `beforeToolCall` 进入 Effect Authority，并从当前 Execution Envelope 自动取得 Task 与 Task Run identity；执行器和模型不能向 Task Ledger 自行写入“已提交” receipt。`afterToolCall` 只能依据可信 provider proof 将外部 Effect 提交，否则保持 `unknown`。

Task 执行、恢复与运维只消费 Effect Authority 的 owner-scoped 只读 projection：`committed` 永不重放，`unknown` 必须先 reconcile，`failed` 才允许在完整幂等条件下重试。SQLite authority 是事实源；JSONL 与 Execution Trace 都是可损坏、可重建且无授权能力的 projection。旧 Task `effect_receipts` 列只用于迁移期读取，不再暴露写入口，也不进入 Pi compaction 或 Task preservation。

### 8.3 Task Checkpoint

Task Checkpoint 是绑定单个 Task Run 的结构化恢复快照，包含已完成进展、committed Effect references、evidence references、未解决问题和 next safe step。它不是聊天摘要、模型 scratchpad 或 Task Result。

Pi `turn_end` 在出现 Tool、Effect 或失败进展时自动保存 Checkpoint；Candidate Outcome 形成时，TaskGraph 再合并经过脱敏和限界的 evidence、artifact 与 unresolved issue。模型可以在生命周期无法理解语义里程碑时补充调用 `task_checkpoint_save`，但恢复正确性不得依赖模型自愿调用该 Tool。

Sub-Agent 的自动与手动 compaction 都从 Task Ledger 注入最新 Task preservation，其中包含结构化 Checkpoint。重启或换路执行收到同一份 durable snapshot，同时从 Effect Authority 获取 committed/unknown 状态，因此不得重复完成的 Tool 或已提交 mutation。

### 8.4 Capability Runtime

Capability Runtime 将 Tool、MCP 与 Skill 规范化为同一个 versioned descriptor，以一个 Top-K 预算返回 `kind/name/version/score/confidence/explanation`，并把选中结果仅转换为 Pi active Tool names。Capability Selection 不持有可执行函数、不授予权限、不执行 Tool；Pi active tools 仍是当前 Turn 唯一执行权威，Governance 与 Enterprise Policy 继续在 Tool 边界逐 action 判定。

默认 lexical ranker 与可注入 semantic ranker 服从同一输入输出 contract，因此企业可替换理解能力而无需新建 Router 或 Agent Loop。Tool/MCP descriptor 使用稳定内容 hash 或 adapter 提供的版本，Skill 使用内容 sha256；候选排序保持相关性顺序，Pi 激活则先注册直接 Tool，再注册渐进展开 Skill 的控制 Tool。

失败换路只在同一个 Task Run 内处理首次、无后续成功的只读 Tool 失败。`local`、`external` 或未知 side effect 一律 fail-closed；`planned`、`executing`、`committed`、`unknown` Effect 必须由 Effect Authority 结算或 reconcile，Capability Runtime 不能借换路绕过 Policy 或重放 mutation。固定 seed 的 unknown-business gate 当前对六类通用行动意图达到 Top-5 100%，且随机企业词与 Capability alias 正交，避免以复述业务词制造虚假命中。

### 8.5 Enterprise Policy Provider

企业规则通过可信 Composition Root 注册的 versioned provider 接入，不写入 Core 条件分支。Provider publication 固定 publisher、version、effective scope、effective time；每次 action evaluation 只返回 `allow / deny / require_approval / constrain / missing_evidence` 通用 directive 及 audit evidence references，Runtime 再以 publication 元数据盖章形成正式 Enterprise Policy Decision。

Publisher 只接受 `enterprise_system` 或 `administrator_grant` authority，并由不可伪造的 provider factory brand 进入 Runtime。模型输出、Memory、Episode、Convention Candidate 与 Skill 都不能注册 provider 或自报 publisher/version 来发布正式 Policy。Access-scope Policy 仅在可信 Execution Envelope 引用完全匹配时生效；过期或未生效 Policy 不参与决策。

现有 Tool approval 是兼容 fallback：未配置或无适用 Enterprise Policy 时保持原审批行为；`require_approval` 与带审批约束的 `constrain` 复用同一个 approval broker。`deny`、`missing_evidence` 或不满足风险、副作用、可逆性约束的 action 在 Effect admission 前拦截。Core hard blocks 始终先执行，因此 Enterprise `allow` 不能越过工作区、Credential、Skill lifecycle 或破坏性 host command 防线。正式决策的 publisher、version、scope、effective/evaluated time 与 evidence references 进入内容受限的 durable Tool audit journal，理由文本只保留 `hasReason`，不复制客户内容。

### 8.6 Action Governance

Action Governance 是 `beforeToolCall` enforcement point 使用的纯 per-action 决策内核，不是新的 Agent Loop 或 Policy 状态机。每次调用独立输入 Tool risk、side effect、reversibility、适用 Enterprise Policy Decision、Effect status、测量可靠性、Approval 与当前 task-scoped Execution Grant，统一输出 `allow / deny / require_approval / missing_evidence`、reason code、解释和 content-free factors。

未知或高风险 mutation 即使旧 Tool metadata 误写 `approval=never`，仍提升到显式 authority；没有 approval handler 时 fail-closed。低风险只读 investigation 在没有企业 deny、未结 Effect 或其他硬约束时仍可执行，因此一个未知高风险 action 不会把整个 Agent 切到保守全局模式。可靠性是可注入的 `reliable/degraded/unknown` 测量信号；degraded mutation 提升审批，但不惩罚 read-only evidence gathering。

审批前和审批/Grant 返回后都调用同一个 Governance interface。Execution Grant 通过只读查询端口进入决策，不改变旧 approval response contract；它只覆盖列明 capability，不能越过 Enterprise deny、Core hard block 或 Effect reconcile。每个最终决策的 id、outcome、reason code、factors、Policy Decision reference 与 Grant reference 随 Tool audit durable 保存，使行为可解释、可测试、可追踪。

### 8.7 Channel Runtime Contract

CLI、Feishu 和未来渠道共享同一个 Profile Runtime composition。渠道只拥有 ingress、media、presentation、approval UI 与 delivery；Task、Task Run、Effect、Memory、Policy、Verification、Cancellation、Recovery、Interaction journal 与 Pi session lifecycle 都来自共享 Core/Work Runtime。

Session identity 与 durable responsibility identity 明确分离：Session 保留 platform/chat/thread，避免聊天历史跨渠道串线；Objective、Task、Plan、Sub-Agent 与 Effect 在 adapter 提供可信跨应用 `userIdAlt` 时使用 `user:<id>` 作为 responsibility owner，因此同一已认证人员换渠道后仍能发现、取消、验证、重试和恢复未完成责任。没有可信 identity mapping 时继续按 channel conversation 隔离，绝不从显示名或消息文本猜测同一人。Memory 与 Enterprise Access Scope 继续各自隔离；责任连续不等于扩大数据权限。

新写入使用 responsibility owner，读取同时接受旧 conversation/thread owner key，形成 additive migration compatibility。主 Agent factory 还必须携带由 `buildAgentFactory` 产生的安全 attestation，并绑定当前 Profile 的同一 Effect Authority；缺失 Governance hook、漏配或错配 Effect authority 时 channel composition 启动失败。统一 contract test 一次覆盖 CLI、Feishu 和未知 future adapter 的 Task/Plan 可见性、Effect 幂等、Memory 隔离、Verification、Cancellation 与 Recovery。详细约束见 [`docs/architecture/channel-runtime-contract.md`](../architecture/channel-runtime-contract.md)。

---

## 9. Situation、Memory 与组织学习

### 9.1 Situation Builder

Situation Builder 融合当前输入、active Objective、Task 状态、相关 Episode、Tool 或企业事件与可信 Access Scope，输出开放、带证据的理解：

- summary、goals 与 constraints；
- observations 与 provenance；
- conflicts、uncertainties 与 missing evidence；
- relevant Objective、Task 与 Memory references；
- candidate actions、expected outcome、reversibility 与 confidence。

Model-backed implementation 是主要语义路径；现有 TurnUnderstanding 是低成本 fallback 和降级路径。两者都不能生成可信 Access Scope。

Runtime 现在通过一个异步 `SituationBuilderPort` 消费认知结果。`ModelBackedSituationBuilder` 将 facts、goals、constraints、conflicts、unknowns、candidate actions、confidence 与 provenance 分离并做有界归一化；模型声明的 evidence reference 只有出现在调用方提供的证据集合中才会保留，而且模型生成的 fact 始终标为 `inferred`。无效输出或推断失败会进入 `DeterministicSituationBuilder`，继续保留未知业务词汇和旧 TurnUnderstanding 行为。Access Scope 从不进入模型输入或输出，Agent Runtime 仍从 trusted input / active Objective 单独绑定授权。

Situation-driven Organization Knowledge Recall 在同一 SQLite authority 内组合 active Claim、Correction predecessor、Conflict、Exception、verified/conflicted Episode 与 confirmed/candidate/rolled-back Convention。Access Scope 只决定合法可见集合，Situation relevance 再决定哪些证据进入上下文；带数字、命名空间或复合标识的陌生业务词作为高区分度锚点，避免通用词造成跨会话弱相关召回。排序同时考虑 evidence quality、recency、precedent、confidence 与 knowledge state，并输出 score/reasons 和延迟、纠正保留、冲突可见指标。

Conversation Context 将这些结果包装为 `organization-evidence executable="false"`，转义结构边界并明确禁止执行证据中的指令。Task preservation、runtime facts、conflict 和 correction 优先于普通 precedent；当前用户请求始终在预算之外完整保留。启用 richer recall 后不再重复注入扁平 Claim，只保留 curated chat memory 与 pending conversation evidence。

### 9.2 Organization Memory 记录

目标认知记录包括：

- `episode`：Situation、行动、Outcome 与证据；
- `understanding`：当前可更正理解；
- `goal` 与 `commitment`：durable desired outcome 和承诺；
- `correction`：替代或缩小旧理解的证据；
- `conflict` 与 `exception`：矛盾和适用例外；
- `convention_candidate`：重复 Episode 支持的候选惯例；
- `convention`：经确认或权威来源支持的惯例；
- `authority_hint`：某人或系统可能与一类决策相关的证据。

这些是认知类型，不是客户业务类型。客户词汇保存在内容、开放标签、证据与语义索引中。

Verified Objective publication now writes a first-class Episode into the existing Profile SQLite Memory authority. Episode identity is idempotent by `profile + objectiveId`; it retains the open Situation、action、outcome、evidence、conversation scope and explicit `candidate / verified / conflicted / superseded` status without requiring subject/object business slots. Reprocessing delivery updates the same Episode rather than duplicating organizational experience.

Episode has its own bounded FTS/lexical recall interface, including a scope-constrained fallback for unfamiliar no-space vocabulary such as Chinese enterprise terms. It is not stored as a fake fact Claim: Episode is experience authority, while a Claim is a separately derived statement. Publication occurs before Objective terminalization so a Memory failure leaves the Objective retryable; idempotency makes that retry safe. Credential material in Situation、action、outcome or evidence is rejected at the Memory boundary. Episode recall is exposed now; the later Situation-recall phase will rank Episode、Claim、Convention and current evidence together rather than creating another Memory store.

Correction、Conflict、Exception 和 Revocation 现在保留为可解释链，而不是覆盖式写入。Correction 可替代 active 或 conflicted Claim，并在新旧两端保留 correction evidence；Conflict 在同一作用域的双方保存对称关系和 conflict evidence；Exception 是独立认知类型，必须具有 source 与 evidence，因此后续 Convention consolidation 不能把单次例外当成普遍惯例。Revocation 将 Claim 归档并保留撤回证据，Forget 才执行作用域受限的删除。所有关联 Event 都必须与 Claim 的 conversation/thread scope 完全一致。

### 9.3 学习晋升链

Convention consolidation 采用“异步语义推断 + 确定性 Memory authority”两层结构。推断器读取同作用域的 verified/conflicted Episode 与有效 Exception，提出开放词汇的 pattern；Memory authority 再验证证据身份和作用域，要求至少两个 verified Episode，并以 `profile + exact conversation scope + canonical statement` 跨重启幂等落库。Candidate 保存 supporting/contradictory Episode、Exception Claim、观察时间跨度、置信度、promotion block 与状态事件，不需要客户业务本体。

有 contradictory Episode 时，置信度按支持/反例比例降低并阻止 confirmation；已经 confirmed 的 Candidate 若后来出现反例，会自动进入 `rolled_back` 并保留反例引用。确认、拒绝、替代和回滚都要求 evidence event。Confirmed Convention 仍然只是组织理解，不会自动成为 Enterprise Policy、Execution Grant 或 Tool 权限。

Workflow Candidate derivation 继续采用相同的“异步语义推断 + 确定性 Memory authority”边界。推断器只能读取同一作用域内 confirmed Convention，并提出 conditions、exceptions、inputs、ordered instructions、expected outcomes 与 Verification；Memory authority 再核验来源状态与作用域、拒绝 Credential Secret，并把所有 supporting/contradictory Episode 作为 durable lineage 附着。相同作用域和 canonical title 跨重启幂等，重复派生不会覆盖人工编辑。

Workflow Candidate 只是 instruction-only review artifact：没有 Tool、代码、执行入口、Policy 或 Grant。人工可以带证据编辑、拒绝、以另一 Candidate 替代或归档；来源 Convention 后续出现反证时，新 contradictory Episode 会沿既有 lineage 附着到 Workflow，供后续 trial/promotion fail-closed 使用，但本阶段不会自动修改 active Skill 或生产行为。

Workflow→Skill trial 复用现有 quarantine lifecycle。Memory staging port 把 Workflow 的结构化内容渲染为 instruction-only Skill Candidate，并把 provenance 固定为 `Workflow ID + revision`；晋升前 production Composition Root 会重新读取同一可信 scope，要求 Workflow 仍为 candidate、来源 Convention 仍 confirmed、没有 contradictory Episode，并校验 Skill name 与 instruction SHA256 完全等于当前 Workflow 渲染结果。仅伪造合法 source 字符串不能借用 authority。

Skill Candidate 的真实 trial 保持隔离，失败只追加 rejection evidence，不触碰 active Skill；promotion 仍要求最近拒绝之后至少两个不同 trial identity 的连续成功、结构化 assertions、可观察 evidence，以及 Tool Governance 的高风险人工 approval。Workflow 来源还必须返回当前 promotion authority evidence，缺少 adapter、证据或内容身份时 fail-closed。晋升只作用于当前 Profile，作为最小 gray rollout 边界。

所有 managed Skill promotion、direct create/update 和 rollback 现在保留 integrity-sealed immutable Skill Version；active Skill 只是当前投影。`skill_versions` 只公开内容无关的 version/provenance/event metadata，`skill_rollback` 只能恢复已验证签名的历史 version，并产生新的 durable rollback event。候选或 trial 失败不能覆盖 active 文件，更新与回滚均使用原子替换，历史版本不被改写。

```text
Event
→ Episode
→ Pattern
→ Convention Candidate
→ Verified Convention
→ Workflow Candidate
→ Skill Candidate
→ Isolated Trial
→ Independent Verification
→ Gray Promotion
```

Candidate 不得自动成为 Enterprise Policy。失败试验不得污染 active Skill，所有晋升必须可追溯、可撤销和可回滚。

### 9.4 Memory Persistence Ports

Profile 仍只创建一个 `MemoryStore` 和一个 SQLite connection authority；schema migration、WAL、foreign key、transaction、backup 与 repair 全部留在实现内部。`memoryPersistencePorts()` 不创建 repository wrapper 或缓存，而是把同一个实例投影为 Organization Memory、Conversation Memory、Task Ledger、Recovery Queue 与 Completion Outbox 的类型化 capability views。

生产 Composition Root 分别把 `organizationMemory` 交给 verified Episode publisher、`taskLedger` 交给 Task/Objective graph、`recoveryQueue` 交给 RecoveryService、`completionOutbox` 交给 notice delivery；Agent Context 和 Memory Tools 继续消费已有窄接口。只有 CLI migration、backup、doctor 等 authority 管理入口可直接实例化完整 `MemoryStore`。接口测试与生产使用同一个 port factory，并验证所有视图严格指向同一 authority，防止未来悄悄引入第二套 Memory 数据源。

---

## 10. Initiative 与自适应自治

### 10.1 Initiative 不是通知

Initiative 是 Agent 发现 meaningful work、关联用户或组织目标，并创建或更新 durable Objective。Heartbeat 只是 Trigger adapter。

Initiative 决策包括：

- ignore noise；
- enrich an existing Objective；
- perform observe-only analysis；
- prepare a reversible draft；
- create a read-only investigation Objective；
- request one consequential decision；
- execute a Policy-covered reversible action。

去重依赖 active Objectives、recent Episodes 与 stable trigger identity。

首个 observe-only tracer bullet 已把 Heartbeat 收窄为 Trigger adapter。Heartbeat 只提交稳定 trigger identity、可信 conversation scope 与观察提示；Core `InitiativeRuntime` 构建 seed Situation、按该 scope 召回 Organization Knowledge、读取 active Objectives，并把最终 Situation 交给可替换的决策 port。没有 meaningful action 时保持静默且不写 work；有提案时只记录 action、expected value、risk、rationale、intended verification、evidence refs、confidence 与 active Objective 关系。

observe-only Runtime 的依赖在类型上只有 Task Ledger reader 和 Initiative Observation writer，没有 Task writer、Pi Runtime、Tool Runtime 或 DeliveryPort。Heartbeat 启用该模式后，旧的完整 Agent heartbeat execution 与通知过滤路径不再执行。提案通过 `Profile + trusted conversation scope + canonical action + related Objective` 形成稳定 dedupe key，同一 Memory SQLite authority 负责跨进程重启幂等；重复 trigger 只增加 repeat count。Observation feedback 为 accepted、rejected 或 unreviewed，可计算 proposal precision、平均预期价值、重复率与 interruption rate，而不把评估结果变成企业 Policy。

当前 production fallback 对没有 Situation candidate action 的 Heartbeat 一律静默；它不会为了显得“主动”而从固定客户、订单、工单等业务词生成规则。未来模型推理只替换 Situation Builder/Initiative decision port，执行开放仍必须经过后续 read-only autonomy、Action Governance、Objective、Pi、Effect 与 Verification 链路。

Task transition 与 enterprise event 现在通过同一 `InitiativeTriggerInbox` 进入上述 Runtime。Adapter 只规范化稳定 Trigger identity、可信 scope、摘要、evidence reference、notification intent 与可选 Delivery Target，不解释客户业务类型。Inbox 位于同一 Profile Memory SQLite authority，使用 queued → processing → completed / awaiting_route / notification_queued 状态和 claim token、lease、holder fencing；两个 Gateway 实例不能对同一 Trigger 同时做 Initiative decision，崩溃后的过期 claim 可被接管，失败按 bounded backoff 重试。

Verified Objective outcome 是首个 production Task-transition producer。它先沉淀 verified Episode，再以 `objective id + verified` 稳定 identity 写入 Inbox；Gateway worker 调用同一个 `InitiativeRuntime`。缺少 Delivery Target 且确有 notification intent 时，Trigger 保持 `awaiting_route` 并保留 observation reference，后续可信 route attachment 将其推进为 `notification_queued`。当前 observe-only producer 不请求通知，因此不会借该队列绕过静默约束。

只读自治阶段已通过 `ProactiveInvestigationRuntime` 开放。它不理解客户、订单、工单等固定业务本体，只读取 Initiative Observation 的证据、价值、置信度、风险和验证目标；默认仅接纳 expected value ≥0.7、confidence ≥0.75、风险为 none/low 且全部 capability 明确标记 `sideEffect=none` 的候选。每个 capability 还必须逐一通过 Action Governance，未知或 mutation capability fail-closed。

接纳后以 Observation dedupe identity 创建 recoverable Objective，预算上限为 6 次 Tool call、8000 tokens、60 秒和 1 次纠正；可信 `executionScope` 随 durable Trigger 保存，没有该 scope 的事件继续停留在 observe-only。Dispatcher 将 Objective ID 与 Execution Envelope 传入现有 Automation Pi Runtime，所以 Task Run、Checkpoint、Verification、Recovery 均复用现有权威，不新增 Agent Loop。相同候选若已有 pending/running Objective，只更新 Situation；终态 Objective 不重复执行；并发写入由稳定 Objective ID 和 Ledger 唯一性收敛。

只有 Objective `succeeded + verification accepted` 才构成 material result 并允许一次幂等结果通知；无结果、验证失败或取消均保持安静。主动 Objective 的 verified outcome 不再反向产生同类 task-transition Trigger，防止自激循环。Gateway 写入不含业务内容的 admission/outcome/cost 指标，离线 release gate 要求调查 precision ≥60%、adoption ≥60%、无重复 Objective、无非实质打扰，且单次预算不超过 6 Tool calls / 8000 tokens。

可逆低风险自治的 Core 路径现已实现，但 production 默认仍为 fail-closed。`ProactiveReversibleActionRuntime` 只接纳当前 Enterprise Policy 明确允许、可信 Access Scope 一致、Tool 为 low-risk mutation、并有当前 Compensation drill 证据的候选；`reversible=true` 本身不构成证明。前向执行最多开放一个 capability，预算为 3 次 Tool call、4000 tokens、30 秒且不允许纠正性 mutation，并继续复用现有 Objective、Pi、Task Run、Checkpoint、Effect 与 Verification。

准入后，Execution Envelope 携带 Policy decision、scope、唯一 capability、forward capability、Compensation proof 与 Emergency Stop revision。Pi 的 `beforeToolCall` 会用实际 Tool 和实际重新求值的 Enterprise Policy 再核验这些引用，并从同一 Memory SQLite authority 读取最新 Stop 与 drill；调度后发生的暂停、Policy 变化、scope 漂移或 capability 替换都会 fail-closed。验证未通过但已产生 committed Effect 时，只能执行另一个独立 Policy 覆盖的 Compensation capability；它生成链接原 Effect 的新 Effect，不能篡改原记录，重复补偿被 Effect identity 拒绝。

这一阶段没有内置客户、订单、工单或行业规则，也没有自动生成 Policy。Gateway 在未配置企业 Policy provider、可信 scope resolver、Compensation adapter 与演练证据时不会启用 mutation admission。离线 release gate 要求 Policy/scope coverage、Emergency Stop block rate 与 Compensation success rate 均为 100%，duplicate Compensation、高风险自主行动和不可逆自主行动均为 0；达到代码门槛不等于自动打开生产灰度。

### 10.2 证据优先于提问

不确定时的默认顺序：

```text
recall precedent
→ query authoritative source
→ inspect current state
→ prepare reversible trial
→ locate a better authority
→ ask one focused question
```

### 10.3 自治决策

自主程度按行动评估，而不是单一全局开关：

```text
expected value
× evidence confidence
× reversibility
× trusted authority
× error cost
× time sensitivity
× measured historical reliability
```

开放顺序为 observe-only、只读调查、内部可逆操作、低风险外部 mutation。高风险或不可逆行动不在本阶段自动执行范围内。

### 10.4 Profile 自治发布控制面

生产发布不使用一个会把 Agent 整体切成“聪明”或“保守”的全局自治等级。`AutonomyRolloutController` 只定义五个通用平台能力边界：Situation context、Episode publication、Initiative observation、read-only investigation、reversible action。它不包含客户、订单、工单或任何行业流程；客户业务语义仍由 Situation、Memory、企业知识、Policy 与 Pi 在当前工作中解释。

每个 Profile 在同一 Memory SQLite authority 中持久化各层的 `disabled / enabled / stopped` 状态、revision、操作主体、证据引用、指标快照和原因。新 Profile 默认全部 fail-closed。Episode 写入、Initiative worker、Heartbeat observation 和 read-only admission 在真实生产路径上动态读取该 authority；停止某层不会改写更低层状态，但依赖它的更高层会立即 fail-closed。

晋级和恢复不是配置布尔值：只消费当前安装版本随 release 发布、schema 校验通过且以 SHA-256 绑定引用的 runtime evaluation baseline，并同时通过对应质量、安全、价值、重复率与 interruption thresholds；CLI 不能提交任意指标文件或自称 enterprise。Enterprise allow 不能绕过失败证据，可信 Enterprise Policy publisher 的 deny、stop、rollback 始终优先。恢复会重新评估，而不是盲目恢复旧开关。高风险和不可逆 autonomy 不存在于可晋级枚举中，若未来开放必须另立获批 effort。

操作步骤与门槛见 [`docs/operations/autonomy-rollout.md`](../operations/autonomy-rollout.md)。

---

## 11. Governance、Effect 与安全

### 11.1 平台固定协议

BeeMax 固定执行完整性，不固定企业业务规则：

1. Access Scope 不得由模型伪造。
2. Credential Secret 不进入模型、Memory、Task、Effect 或普通日志。
3. mutation 必须在执行前创建 planned Effect。
4. committed Effect 不得重放；unknown 必须 reconcile。
5. Task 必须可恢复或明确不可安全恢复。
6. 未验证结果不得完成责任。
7. 高风险不可逆动作需要可信授权。
8. 学习结果必须可解释、可更正和可撤销。

### 11.2 企业 Policy adapter

企业可以返回：

- `allow`；
- `deny`；
- `require_approval`；
- `constrain`；
- `missing_evidence`。

每个决策保留 publisher、version、effective scope、time 与 audit reference。无企业 adapter 时，平台使用最小安全默认值，但不得因缺少完整配置阻止低风险、只读和可验证的有用工作。

---

## 12. 状态与失败语义

### 12.1 Task 与质量状态正交

Task lifecycle 使用 `pending/running/succeeded/failed/cancelled`。等待由未满足 Dependency、暂停或 durable waiting reason 表达；Verification 使用独立质量状态 `pending/accepted/rejected/unavailable`。不得再用同名状态表示不同事实。

### 12.2 关键失败规则

| 情况 | 行为 |
| --- | --- |
| Pi error 或模型失败 | 保留 Task Run 与 Checkpoint，按换路和 Recovery Policy 处理 |
| Tool mutation 结果不确定 | Effect 进入 unknown，禁止重放，先 reconcile |
| Verification rejected | 保留 Candidate Outcome，创建 bounded Corrective Attempt |
| Verification unavailable | 保留 Candidate Outcome，按 Verification Backoff 重试，不重新执行 Task |
| Execution Lease 过期 | 只证明中断；默认不重放，遵守 ADR-0002 |
| Compaction | 结构化保留 Objective、Acceptance Criteria、Checkpoint、unknown Effect 与 unresolved issues |
| 重复 Trigger | 使用 trigger identity、active Objective 与 recent Episode 去重 |
| 缺少 Delivery route | 不丢 Objective；延迟通知并使用 Outbox |
| Memory 冲突 | 暴露并调查，不静默选边 |
| 不理解客户语义 | 使用安全证据继续调查，不扩大 Access Scope |

---

## 13. 兼容、迁移与回滚

### 13.1 Expand–migrate–contract

1. **Expand**：新增 trust-aware Access Scope、开放 Situation 与 Execution Envelope；旧 `businessContext` 保持可读。
2. **Migrate interaction**：Memory recall 接受 trusted scope 与 semantic Situation，停止用文本推断做硬隔离。
3. **Migrate durable work**：Objective、Task、Recovery 保存新 references；旧记录继续读取。
4. **Unify Effect**：Effect authority 单写，Task 读取权威 projection；旧 receipt 只读兼容。
5. **Publish Episodes**：Verified Outcome 幂等形成 Episode。
6. **Contract**：所有调用方迁移后删除 legacy 核心依赖，保留版本化数据迁移器。

### 13.2 Rollout

| 阶段 | 发布方式 | 回滚原则 |
| --- | --- | --- |
| Spec / Eval | 无行为变化 | 删除评测配置即可 |
| Access / Situation | 双读、可信 scope 单决策 | 切回旧读取但不回滚数据迁移 |
| Execution Envelope | 单 Profile 灰度 | 保留兼容 run path 一个版本 |
| Effect authority | 新 authority 单写、旧 projection 可读 | 禁止恢复双写 authority |
| Unified Objective × Pi | Automation 和 recovery 先行 | feature flag 切回旧入口，不回滚 Task 数据 |
| Episode / Situation Builder | observe-only | 关闭 context contribution |
| Initiative | observe-only 后只读 | 独立暂停，不影响用户任务 |
| Reversible action | 企业逐 action 灰度 | Emergency stop、Policy deny 与 Effect rollback |

回滚不得重新引入第二个事实 authority。不可逆数据迁移必须先完成备份、恢复演练和兼容读取。

---

## 14. 评测与验收

### 14.1 可靠性门禁

- 跨 Access Scope 未授权召回和行动为 0。
- 已 committed mutation 重复执行为 0。
- unknown Effect 未 reconcile 前重放为 0。
- 未验证 Candidate Outcome 满足依赖为 0。
- P6 scope isolation 与 P7 recovery acceptance 无回归。
- CLI、Gateway、飞书共享相同 Task、Effect、Policy、Verification 和 recovery 语义。
- Pi crash、Tool timeout、进程退出、重启、多实例、Compaction、Steering 和 Delivery failure 通过故障演练。

当前 Runtime 已将 Pi crash、Tool timeout、process exit、restart、multi-instance claim、unknown Effect、Verification unavailable、delivery failure、Compaction、Steering 与 Correction 收敛为一份可执行故障目录。每项必须同时声明 observable state、automatic behavior、operator recovery 和 release evidence；目录缺项会 fail closed。发布测试会真实注入跨实例重复 mutation、中断 Task 与 unknown Effect，验证 committed mutation 重复数为 0，安全 Task 恢复、非安全 Task 明确失败，unknown Effect 只能经外部观察后人工 reconcile。运维步骤见 [`docs/operations/fault-recovery.md`](../operations/fault-recovery.md)。这套矩阵是平台安全协议，不包含任何客户业务本体或企业 Policy 规则。

### 14.2 智能质量门禁

使用不含固定 Runtime 业务分支的陌生企业语料测量：

- Situation factual precision 与 correction retention；
- Capability Top-5 命中率，目标仍为 ≥98%；
- precedent retrieval precision；
- verified task completion rate；
- user interventions per completed Objective；
- repeated-question rate；
- useful Initiative acceptance rate；
- duplicate or irrelevant Initiative rate；
- unauthorized retrieval and action rate。

**当前离线 baseline（2026-07-13）：** 固定 seed `beemax-unknown-business-v1` 生成 60 个不依赖客户、订单、工单或项目本体的陌生词场景，覆盖 correction、conflict、long-running work、crash 与 side effect。随机业务词与通用行动意图正交，Capability 预期由查证、文档、会议、数据、网页或 Memory 行为决定，不靠复用业务词命中。评测直接调用生产公开 interface，当前记录为 Situation action accuracy 100%、unknown vocabulary retention 100%、Capability Top-5 100%、forbidden scope retrieval 0、verified completion 100%、safe crash recovery 100%、committed/unknown side-effect replay blocked 5/5；成本观察为 input-token estimate 1333、Tool selections 60、planned Sub-Agent budget 15，当前 arm64/Darwin 离线耗时约 79ms。`npm run eval:runtime` 在 CI 与 release 中复跑同一 corpus，并同时检查绝对质量门槛和相对 baseline 回归。

该 baseline 是确定性离线质量 gate，不冒充真实 provider 端 token、模型质量或生产机器 SLA。性能门禁已另行按声明机器 Profile 和 fast/deep/background path 测量 Runtime overhead；外部 provider 延迟与真实 token/cache/USD cost 继续由 Execution Trace 逐次记录，二者不得混为一个指标。

Initiative 初始门禁为 accepted proposal ≥60%、重复主动 Objective 为 0、跨 scope 行动为 0，并以真实 baseline 验证重复工作中的用户干预至少降低 30%。这些是灰度门槛，不代表所有行业的永久承诺。

### 14.3 性能与成本

性能门禁现已区分 fast、deep 与 background 三条路径，每条使用 20 次 warmup 和 101 个正式样本，分别计算 P50/P95，并同时检查 Context、Token、Tool Call、Sub-Agent、Organization recall、Situation、Initiative、cache-write、concurrency 与 backpressure。Benchmark 直接调用生产公开 interface，不运行模型或外部 Tool，因此测量的是可归因的 Runtime overhead；真实 provider latency、token、cache token 与 USD cost 由 Execution Trace 记录。

当前声明两个机器 Profile：Apple M5 / 10 logical CPUs / 32 GiB / Darwin arm64 / Node 22 是已提交 baseline；GitHub-hosted Ubuntu x64 / ≥2 logical CPUs / ≥6 GiB / Node 22 是 CI/Release gate。机器在执行前必须匹配声明，不能把其他硬件结果写入同一 baseline。

Apple M5 的当前 101 样本记录为：fast P50/P95 约 0.010/0.012ms，deep 约 3.32/6.49ms，background 约 0.010/0.020ms；deep maximum recall 约 4.96ms、Context 2091 chars，三条路径 backpressure 均为 0。这些数字不代表模型首 token 或端到端用户 SLA。

CI 与 Release 除检查各自机器的绝对延迟预算外，还复用已提交的确定性成本 baseline。Context、Token、Tool、Sub-Agent、cache-write、concurrency 或 backpressure 只要增长就阻断发布，即使质量评测提高；baseline 只能在声明机器上显式更新并经代码审查，CI 不自动接受新成本。详细操作见 [`docs/operations/performance-and-cost.md`](../operations/performance-and-cost.md)。

### 14.4 原 P0–P10 证据闭环

原始程序现在由 [`evals/original-acceptance-program.json`](../../evals/original-acceptance-program.json) 逐项映射到公开测试、版本化 baseline、故障注入或操作手册。`npm run eval:acceptance` 会拒绝缺失的 P0–P10、证据文件、复现命令和未处置 TBD，并顺序运行架构收缩与数据迁移/回滚演练；CI 和 Release 都执行该命令。

P9 架构门禁当前要求 Core 客户业务本体为 0、legacy `businessContext` Runtime consumer 为 0、shared work composition 只有一个调用者、CLI/飞书均从同一个 Profile Runtime seam 进入，并禁止 Core/Gateway/Automation 直接依赖 Memory implementation。它检查平台 authority 与 composition，不限制客户的开放业务语义。

P10 演练真实创建旧版 Profile 与旧 Task Ledger，使用生产 migration/SQLite backup/MemoryStore 接口验证：源数据不被改写、旧责任可迁移、备份完整、升级前责任可恢复、备份后写入不混入回滚点、恢复库可再次打开。操作与失败处理见 [`docs/operations/p0-p10-acceptance.md`](../operations/p0-p10-acceptance.md)。

三个指标被正式暂缓而不是假定通过：真实重复工作中的用户干预下降至少 30%、生产 repeated-question rate、真实 provider latency/token/cache/USD。它们分别要求至少 30 个可比 verified Objectives、隐私审查后的生产会话 cohort，以及声明 provider/model 的 Execution Trace；满足退出条件前不得宣传为生产 SLA。

---

## 15. 实施程序

原 P0–P10 继续作为执行完整性闭环，新组织智能能力按依赖插入而不是另建平行项目：

| 程序 | 结果 |
| --- | --- |
| P0 Spec、Baseline 与 Eval | 单一规格、未知业务 corpus、当前指标 |
| P1 Access、Policy 与 Governance | Situation/Access 分离、企业 Policy adapter、逐 action 决策 |
| P2 Execution Envelope 与 Grant | durable identity 原生贯穿 Pi |
| P3 Effect authority | mutation 生命周期、幂等、unknown 与 reconcile 单一事实 |
| P4 Capability Runtime | Tool/Skill/MCP 统一选择、激活与 Top-5 gate |
| P5 Pi Context 与 Checkpoint | Situation、Memory、Task preservation 与 Compaction 深度融合 |
| P6 Organization Memory | Episode、Correction、Conflict、Exception 与 Convention Candidate |
| P7 Unified Objective × Pi | interactive、planned、automation、recovery 单一执行链 |
| P8 Interaction 与 Trigger | 渠道统一；heartbeat、event、Task transition 作为 adapter |
| P9 Architecture contraction | 删除重复 composition、legacy context 和双事实实现 |
| P10 Production acceptance | 故障、性能、成本、跨渠道、迁移与回滚 |
| I1 Situation Builder | model-backed understanding 与 deterministic fallback |
| I2 Initiative observe-only | 价值、风险、证据、去重与静默行为 |
| I3 Read-only autonomy | 可恢复、可验证的主动调查 |
| I4 Organizational apprenticeship | Convention、Workflow 与 isolated Skill Candidate |
| I5 Reversible bounded autonomy | Enterprise Policy 覆盖的低风险行动 |

具体 tracer-bullet、blocking edges 和 acceptance criteria 以 [`tickets.md`](../../tickets.md) 为实施地图。

---

## 16. 明确暂缓与架构禁区

### 16.1 等待真实证据后再设计

- 完整 Organizational World Model；
- 因果模拟与数字孪生；
- Commitment network；
- 大规模多 Agent 组织；
- Agent self-model 与经济价值优化；
- 隐私保护的跨部署学习。

### 16.2 只能生成候选，不能自动生效

- Enterprise Policy；
- production Skill；
- Workflow；
- 高风险执行授权。

### 16.3 不允许进入目标架构

- 第二个 Memory authority；
- 第二个 Agent Loop；
- Core 中固定客户业务本体；
- 用 experimental orchestrator 替代 Task Ledger；
- 无证据的大规模 Pi rewrite；
- 绕过 Task、Effect、Governance 或 Verification 的 Initiative。

---

## 17. 架构审查门禁

任何新实现必须回答：

1. 它深化哪个现有 module，为什么需要新的 seam？
2. 是否至少有两个真实 adapter 证明该 seam 存在？
3. 它写入什么状态，唯一 authority 是谁？
4. 是否新增或复制 Agent Loop、Registry、Loader、Queue、Scheduler、Retry、Context、Memory 或 Policy 状态机？
5. 崩溃后从哪里恢复？
6. 是否可能扩大 Access Scope？
7. mutation 如何产生 Effect、幂等和 reconcile？
8. 完成如何通过 Verification？
9. 新实现完成后删除或降级什么旧 implementation？
10. 真实 Eval 如何证明它更智能、更可靠或更高效？

目标是构建深 module：小 interface 隐藏大量正确行为，为调用方提供 leverage，让变化、知识和验证保持 locality。

---

## 18. 最终成功定义

BeeMax 在进入一个没有预定义业务模型的企业后，可以安全地开始工作；它能区分推断与授权，理解当前 Situation，承担 durable Objective，通过同一个 Pi Runtime 可靠执行，在副作用不确定时停止并对账，通过 Verification 判断真实完成，把结果沉淀为可更正的 Episode，并在长期协作中逐渐减少用户干预、提高主动价值和组织适应性。

当前建设不是终点，而是 BeeMax 从高级企业 Agent 演进为组织智能系统所需要的正确地基。
