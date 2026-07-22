# Hermes Agent 能力机制参考与 Thruvera 差距

> 研究边界：本文只参考 Nous Research 官方仓库在固定提交
> [`007cd151329c20f9d3854b6338375f3188abc184`](https://github.com/NousResearch/hermes-agent/tree/007cd151329c20f9d3854b6338375f3188abc184)
> 中公开的设计。Thruvera 不引入该项目的运行时、代码、依赖、产品标识或代理名称；相关名称只出现在隔离的研究引用中。

## 结论

Thruvera 不需要复制参考项目的 runtime。Thruvera 现有的 Work Contract、不可变 Tool Spec Plan、Skill 生命周期与哈希锁、Provider 获取权限、任务回执及逐验收项独立核验，已经比参考实现更适合作为生产控制面。

最值得吸收的是三类设计：

1. 用轻量元数据索引发现大量工具和 Skill，只在命中任务需求时加载完整定义。
2. 为 Skill 声明 `requires_tools`、`fallback_for_tools` 等条件，使能力缺失时可以沿确定性的恢复阶梯选择替代方案。
3. 隔离子任务上下文、限制子任务工具集，并仅把结构化结果返回主任务。

Thruvera 当前的主要缺口不是“工具数量少”，而是四个闭环仍不完整：任务计划尚未完全由 Work Contract 的原子能力需求驱动；缺少统一且可信的外部 Provider/Skill 目录；缺少通用的能力缺口恢复状态机；HTML、PDF 等制品尚未形成“生成—格式专项验证—跨格式一致性验证—原子投递”的闭环。

“所有场景、全程无需用户参与”不能作为无条件承诺。更可靠的目标是：当凭证、权限、数据和不可逆决策边界已预置时零接触完成；缺少凭证、法定授权或关键业务选择时，必须给出精确 blocker，不能伪造能力、绕过权限或把未完成算作成功。

## 官方实现中的关键机制

### 1. 工具目录、工具集与渐进式 Tool Search

参考实现用中央工具表维护 web、终端、文件、Skill、浏览器、待办、记忆、委派等核心能力，并用 core、composite、platform toolset 组合不同执行面：[核心工具表](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/toolsets.py#L29-L81)、[核心工具集](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/toolsets.py#L96-L249)、[组合工具集](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/toolsets.py#L330-L369)。

Tool Search 是按上下文预算启用的 progressive disclosure：核心工具始终加载，MCP/插件等可延迟工具被替换为 `tool_search`、`tool_describe`、`tool_call` 三个桥接工具；具体 schema 仅在搜索或描述后进入上下文。官方文档说明了激活阈值、额外回合和 schema 缓存代价：[设计与桥接工具](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/website/docs/user-guide/features/tool-search.md#L8-L54)、[自动激活](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/website/docs/user-guide/features/tool-search.md#L56-L70)、[权衡](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/website/docs/user-guide/features/tool-search.md#L97-L129)。源码将工具分为 core/deferrable，估算 token 后决定是否启用，并使用 BM25 加名称子串回退进行搜索：[分类与阈值](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/tools/tool_search.py#L150-L258)、[索引与检索](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/tools/tool_search.py#L289-L418)、[桥接 schema 与装配](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/tools/tool_search.py#L426-L583)。实际调用时还会解包为底层工具，使审批、guardrail 和 hook 看到真实工具：[dispatch 解包与会话范围校验](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/model_tools.py#L1071-L1144)。

可借鉴：元数据目录、任务内搜索、完整 schema 按需加载、底层工具身份贯穿审计。

不可照搬：始终加载庞大的“核心工具”集合，也不能让 `tool_call` 成为绕过 Thruvera Tool Spec、Provider 身份、side-effect authority 或当前 turn admission 的通道。Thruvera 已有预算化的 direct/deferred/hidden 计划、只允许从既有 eligible 集合晋升、Provider 健康隐藏/恢复：[Tool Spec Plan](../../packages/core/src/tool-spec-plan.ts#L67-L190)。应扩展其索引与召回能力，而不是替换控制面。

### 2. Skill 的三级加载、条件激活与自学习

参考实现将 Skill 分为三级读取：先列元数据，再加载完整 `SKILL.md`，最后只读指定 reference；这是真正的按需渐进加载：[三级 progressive disclosure](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/website/docs/user-guide/features/skills.md#L130-L140)。Skill 可以声明 `fallback_for_toolsets`、`fallback_for_tools` 以及依赖条件，从而在原生工具不可用时激活替代工作流：[条件激活](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/website/docs/user-guide/features/skills.md#L225-L247)。`/learn` 使用现有工具收集资料，再把可复用过程写为 Skill：[学习流程](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/website/docs/user-guide/features/skills.md#L94-L128)。官方也明确区分 Skill 与原生 Tool：前者适合已有工具/CLI/API 上的说明和流程，后者适合认证、强类型精度、二进制、流式或实时能力：[Skill 与 Tool 的边界](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/website/docs/developer-guide/creating-skills.md#L9-L23)。

可借鉴：把 `requires_*`、`fallback_for_*`、能力标签、预期输出和验证方法纳入 Thruvera Skill manifest；将元数据检索与完整资源加载分开；只有成功执行且可复用的工作流才进入候选 Skill。

不可照搬：参考实现允许代理管理 Skill，并支持外部 Hub 安装和动态 shell；其文档也指出内联 shell 的主机执行风险：[代理管理与写入门禁](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/website/docs/user-guide/features/skills.md#L442-L509)、[安全扫描与信任级别](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/website/docs/user-guide/features/skills.md#L708-L750)、[动态 shell 风险](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/website/docs/developer-guide/creating-skills.md#L266-L321)。Thruvera 应保留现有的路径约束、SHA 锁、资源预算、禁止 bash 路由，以及候选隔离、独立试验、连续通过后才晋升的机制：[Skill Runtime](../../packages/core/src/skill-runtime.ts#L78-L236)、[候选试验与晋升](../../packages/core/src/skill-tools.ts#L204-L278)。

关键限制：Skill 只能编排已有能力，不能凭空创造新的认证/API 权限。缺工具时不能让模型“发明一个工具”。

### 3. 任务目标、代码执行与子任务隔离

参考实现的 Goal 定义包含 outcome、verification、constraints、boundaries 和 `stop_when`，并要求以证据判断完成：[完成契约](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/website/docs/user-guide/features/goals.md#L54-L68)。委派任务使用独立上下文、受限工具集和独立终端，父任务只接收最终摘要；默认批量并发有界，叶子任务不能继续委派、澄清、写记忆或调用代码执行：[隔离上下文](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/website/docs/user-guide/features/delegation.md#L9-L56)、[并发和恢复特性](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/website/docs/user-guide/features/delegation.md#L120-L145)、[最小工具集](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/website/docs/user-guide/features/delegation.md#L160-L177)。代码执行则通过 RPC 调用已有工具，只把打印结果带回上下文，并设置资源限制：[执行模型](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/website/docs/user-guide/features/code-execution.md#L9-L40)、[资源与安全边界](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/website/docs/user-guide/features/code-execution.md#L129-L220)。

可借鉴：按原子子目标隔离上下文、最小权限工具集、有界并发、显式接受标准、只返回结构化证据和结果摘要。

不可照搬：不能允许无硬上限的递归编排，也不能通过主机 Python/RPC 绕过 Tool Spec。Thruvera 当前的 DAG 已限制任务数和并发、子代理只读且由父任务执行写操作，并要求接受标准独立核验：[Thruvera Task Orchestration](../../packages/core/src/task-orchestration-tools.ts#L15-L76)。但当前自主规划仍主要由原始 prompt 的启发式规则准入：[Autonomous Planning](../../packages/core/src/autonomous-planning.ts#L39-L109)；计划质量检查也主要验证标题唯一和接受标准非空：[Task Plan Quality](../../packages/core/src/task-plan-quality.ts#L9-L26)。下一步应改为从 Work Contract 的原子 outcome、能力需求、依赖关系和不确定性生成并审计计划。

### 4. 制品投递不等于制品质量验证

参考实现的 Deliverable Mode 会从消息中提取绝对路径并按扩展名上传 PDF、HTML 等文件：[制品路径与类型](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/website/docs/user-guide/features/deliverable-mode.md#L9-L50)。但缺失文件可以被跳过，且该机制没有证明 PDF/HTML 内容、渲染、来源或跨格式一致性正确：[投递行为](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/website/docs/user-guide/features/deliverable-mode.md#L55-L97)。其停止前验证是政策提示，不直接运行检查；证据账本主要针对代码终端命令，并会在文件编辑后把旧验证标为过期：[停止前验证策略](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/agent/verification_stop.py#L1-L38)、[证据记录](https://github.com/NousResearch/hermes-agent/blob/007cd151329c20f9d3854b6338375f3188abc184/agent/verification_evidence.py#L430-L618)。因此不能把“成功上传文件”当作“高质量结果已验证”。

Thruvera 的逐接受标准、回执绑定和独立 verifier 更强，但当前 verifier 工具主要是读取和网络取证，尚无 PDF/HTML 专项渲染检查：[Gateway verifier](../../apps/cli/src/gateway.ts#L942-L1084)；目标完成投递仍以文本为主：[Objective Completion Delivery](../../packages/core/src/objective-completion-delivery.ts#L42-L122)。

应补齐：

- 显式 Artifact Manifest：artifact ID、目标/验收项 ID、MIME、大小、摘要、来源和生成时间，禁止从自然语言中猜路径。
- 按类型注册 verifier：HTML 检查 DOM、链接、引用和图表数据；PDF 检查可解析文本、逐页渲染、空白/裁切/字体；其他格式使用各自解析器。
- 跨格式一致性：同一报告的 HTML/PDF 必须核对数据、日期、结论和引用集合。
- 只有验收通过的制品才能进入 outbox；文本和附件应幂等、可重试并有投递回执。

## Thruvera 建议的通用能力闭环

```text
用户目标
  -> Work Contract（原子结果、约束、禁止项、验收标准、不确定性）
  -> Capability Requirement Graph
  -> 元数据检索（Tools / Providers / Skills）
  -> Tool Spec Plan + Skill 路由（按需加载完整定义）
  -> 有界 DAG 执行（最小权限、回执、可恢复状态）
  -> 逐标准独立验证 + 格式专项 Artifact 验证
  -> 仅投递已验证结果
```

能力缺失时应执行固定恢复阶梯：

1. 使用已安装且健康的精确 Tool/Skill。
2. 选择已登记的替代 Provider，并重新绑定身份和 side-effect authority。
3. 从可信目录获取 Provider；校验来源、签名/摘要、权限和健康状态。
4. 若只是工作流缺失，使用现有工具执行 fallback Skill。
5. 若执行过程被证明成功且可复用，生成 instruction-only Skill 候选，隔离试验后再晋升。
6. 若缺少真实 API、凭证、法律授权或安全边界，则返回可审计 blocker；不得伪造结果，也不得把 blocker 记为成功。

每一步都必须记录选择理由、候选集合、实际 Provider/Skill 版本、输入摘要、回执和验证证据。这样“动态调用”才是可复现的能力路由，而不是模型临场猜测。

## 优先改进项

1. **P0：Work Contract 驱动规划。** 用原子 outcome 和 capability requirements 替换 prompt 正则作为主要规划依据；增加计划覆盖率、依赖、权限和验证可达性的语义审计。
2. **P0：Artifact 闭环。** 建立 manifest、类型 verifier、跨格式一致性和附件 outbox，先覆盖 HTML/PDF。
3. **P0：能力恢复状态机。** 将 discover、alternate provider、acquire、fallback skill、candidate skill、blocked 变成显式状态，禁止隐式降级。
4. **P1：统一元数据索引。** 对 Tools、Providers、Skills 建立同构的能力标签、前置条件、风险、输出类型、成本、健康度、版本和验证策略；只在命中后加载完整 schema/Skill 资源。
5. **P1：零接触运行契约。** 在任务开始前确定可用凭证与授权范围；正常缺陷自动恢复，只有不可消除的授权/安全 blocker 才需要人。
6. **P1：真实评测。** 用真实模型、真实工具和真实文件执行端到端场景；分别报告任务成功率、事实准确率、制品验证通过率、重跑稳定率、自动恢复率和 blocker 识别准确率，禁止把 mock/harness 结果称为生产成功率。

最终方向不是宣称有限工具可以覆盖所有场景，而是让 Thruvera 在开放世界中做到：能发现、能按需加载、能恢复、能验证、能准确失败，并且任何成功都由可追溯证据支持。
