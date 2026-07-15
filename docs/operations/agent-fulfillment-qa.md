# BeeMax Agent Fulfillment QA

## 用户契约

用户只需要表达目标、约束和必要的业务信息。BeeMax 负责理解当前 Situation，召回可信上下文，选择并加载已安装 Skill，解析 Skill 资源和 Tool/MCP 依赖，规划并执行工作，保存长任务进度，并以独立 Verification 判定 Business Completion。

BeeMax 可以切换等价实现或 Provider，但不得在未经用户明确同意时降低目标、证据标准、质量标准或强制约束。必要能力在发现和安全替代后仍不可用时，Objective 保持 incomplete，并返回具体 blocker、已尝试的修复和需要的权限或配置。

## 能力解析顺序

1. 读取当前 Turn、活动 Objective、Situation、可信 Access Scope 和相关 Memory。
2. 搜索 Profile、项目和全局范围内已经安装的 Tool、MCP 和 Skill 元数据。
3. 激活最佳匹配能力；Skill 必须完成 discover → activate → route → resource read → complete。
4. 解析 Skill 声明的 Tool、reference、script、template 和其他只读资源依赖。
5. 对缺失的公开信息使用已配置网络搜索、网页提取或浏览器寻找权威来源和等价 Provider。
6. 对缺失的可执行能力只允许经过隔离候选、静态检查、真实试运行、Verification 和授权的安装路径；不得静默安装第三方可执行代码或索取未授权 Credential Secret。
7. 无法满足必要依赖时保存 Task 状态并明确报告 blocker，不生成较弱替代结果。

## 系统测试矩阵

| 轴 | 必须证明的行为 | 主要可执行证据 |
|---|---|---|
| Turn 理解 | 保留目标、约束、修正、继续和验收条件 | `turn-understanding.test.mjs` |
| Objective 契约 | 原始需求、强制约束和可观察验收条件共同进入完成门禁 | `autonomous-planning.test.mjs` |
| Conversation | DM、群聊、Thread 和 Actor 身份正确隔离 | `runtime-boundary.test.mjs`, `group-visibility.test.mjs` |
| Memory 召回 | 相关事实可召回；候选、冲突和更正状态不被混为事实 | `runtime-boundary.test.mjs`, `organization-knowledge-recall.test.mjs` |
| 上下文预算 | 当前请求不丢失，低优先级证据有界释放 | `runtime-boundary.test.mjs` |
| 上下文压缩 | Task ID、目标、约束、Acceptance Criteria 和 Checkpoint 语义丢失时自动恢复 | `context-compaction.test.mjs` |
| Skill 发现 | 只加载匹配 Skill，支持中英文 metadata，不注入完整目录 | `skill-runtime.test.mjs`, `capability-runtime.test.mjs` |
| Skill 资源 | manifest 路由和标准 `SKILL.md` 引用资源均可受限读取并锁定哈希 | `skill-runtime.test.mjs` |
| Tool/MCP 激活 | 已安装但未激活的能力不能被误判为不存在 | `autonomous-planning.test.mjs`, `turn-understanding.test.mjs` |
| 外部研究 | 执行 Agent 获取真实来源，Verifier 独立重新抓取 | `task-execution-context.test.mjs` 与 Profile E2E |
| 短任务 | 不创建不必要的 Task/DAG，直接返回 | `autonomous-planning.test.mjs` |
| 长任务 | Task Ledger、lease、Checkpoint 和恢复不重复已完成 Effect | `store.test.mjs`, `p7-task-recovery-acceptance.test.mjs` |
| 复杂任务 | 小型 DAG 显式依赖、并发受限、父 Agent 只综合已验证结果 | `task-graph.test.mjs`, `task-plan-quality.test.mjs` |
| Verification | Candidate Outcome 不等于完成；unavailable 只重试验证，rejected 才可有界纠正 | `task-graph.test.mjs`, `store.test.mjs` |
| Effect/Receipt | mutation 以 Effect Authority 和 Receipt 为准，未知结果禁止重放 | `tool-effect.test.mjs` |
| 自动化 | Schedule 只产生 Trigger；任务仍走同一执行和 Verification 路径 | `automation.test.mjs`, `autonomous-planning.test.mjs` |
| 媒体 | 视觉/OCR 路由产生 Receipt，无法可靠理解时明确失败 | `media-understanding.test.mjs`, `local-media-understanding.test.mjs` |
| 故障恢复 | Pi crash、超时、重启、重复实例、投递失败和 Verification unavailable 可观察、可恢复 | `runtime-fault-catalog.test.mjs`, reliability release gate |
| 安全 | Capability 发现不扩大 Access Scope；高风险 mutation、Credential 和第三方代码 fail closed | security release gate |
| 效率与稳定性 | Tool/Token/并发/上下文有界，长运行无无界队列和内存增长 | runtime/performance/memory/resource evaluations |

## 本轮发现

### 已修复

1. 委派任务跳过认知理解时没有从 Task Prompt 预取 Tool，导致已安装 Agent-Reach 不可见。
2. 中文研究意图无法命中英文网络能力 metadata。
3. Verification 不能使用公共网络工具独立复核外部证据。
4. Verification 只接受裸 `ACCEPT`，错误拒绝 `ACCEPT: reason`。
5. Objective 可能只保存“发送/保存”等局部验收条件，丢失原始目标和强制约束。
6. 上下文压缩保留 Task ID、但丢失目标和约束时只记录 degraded，没有注入权威恢复上下文。
7. 标准 `SKILL.md` 在没有 BeeMax manifest 时无法读取其明确引用的相对资源。
8. 主 Agent 和 Sub-Agent 现在明确禁止未经授权的语义或质量替代，并要求先发现现有能力、再寻找安全等价路径。
9. 自然语言任务现在会在模型执行前确定性预检已安装 Skill metadata；命中后必须激活 Skill，弱模型跳过时会被纠正，仍不激活则任务失败而不是绕过 Skill。
10. 新 Turn 没有产生 assistant 消息时，Runtime 曾回读上一轮答案；现在所有 Candidate、failure 和最终答案读取都限定在当前 Turn 消息范围。
11. Memory 召回内容、Work Context 和执行策略曾长期留在 Session user history；现在回合结束后只保留原始用户请求，回合级执行指导被释放并在需要时重新从权威状态构建。
12. Task Plan 质量门曾把“已安装的 Skill”和“来源发布方/发布或更新日期”误判成安装或发布动作；已移除基于业务自然语言关键词猜测 Effect 权限的逻辑。副作用权限只由 Tool Policy、Execution Grant 和 Effect Authority 决定，隔离 Sub-Agent 仍无法获得写权限。
13. 隔离 Sub-Agent 的初始 Tool 预取漏召回时没有 `capability_discover` 自救入口，造成执行器声称无网络、但 Verifier 可以联网；现在所有只读执行/验证 Agent 都保留只读 discovery bridge，可激活 Profile 中已经安装的等价 Provider，不扩大写权限。
14. Task DAG key 的 32 字符限制会拒绝模型生成的正常语义 key；现在 key/dependency 引用上限为 64 字符，Task ID 总长仍在持久化边界内。
15. 真实 E2E 已证明：未配置 `web_search` Provider 时，执行 Sub-Agent 会调用 `capability_discover`，切换当时名为 `agent_reach_search` 的 Exa 工具（现为 `exa_web_search`，保留旧名作为别名），再用 `web_extract` 抓取；两个并行 Task 均经独立 Verification 后完成，Completion Delivery 最终返回核验报告，没有使用 evergreen 降级。
16. Direct Objective 的 Verification unavailable 现在进入 durable backoff 队列，即使没有 Task Plan 也会自动重试 Candidate Verification，且不重放原执行；最终 accepted/rejected 结果会以幂等键投递回原会话，投递失败则保留 Candidate 继续重试。
17. 查询型请求只要包含研究、验证、约束或验收要求，也会建立轻量 Objective Completion Contract；普通闲聊和简单事实问答仍保持直接路径。
18. Skill preflight 与显式 `capability_discover` 现在共用同一 Capability Selection authority，并只绑定首选 Skill；`skill_complete` 必须在同一 Skill 身份下且所有声明 reference 已读取。
19. 只读 Tool 失败只能被同一 Tool 的成功重试或 `capability_discover` 的等价能力选择消除，读取无关本地内容不再掩盖网络能力失败。
20. Verifier 使用结构化 verdict、criterion-to-evidence assertions 与 Tool receipt；Candidate 中每个引用的外部 URL 都必须出现对应成功 `web_extract` 调用，invalid/unavailable verdict 不得被当作 rejection 或 acceptance。
21. “当前最合适的 Skill”不再被误判为实时外部研究；时效性识别区分检索动作、实时信息需求和普通上下文修饰语，避免把本地文件/Skill 工作错误委派给网络研究流程。
22. 未解决的只读 Tool 执行失败现在只能换到语义选中、同为只读且输入/输出模态、时效与证据等级均不弱于原 Contract 的候选；候选必须已健康，或经可信 Provider health recovery / 授权安装后验证健康。实际替代 Tool 成功才写入 `capability.rerouted` trace；无法证明等价时 Objective 明确阻断，不返回较弱答案。同一只读 Tool 在当前 Turn 后续成功时不触发多余换路。

### 真实 Profile E2E 证据

- Profile：`e2e-feishu`
- Conversation：`local-a3b1c755-cf76-440d-b2fc-2a5f7c4d9395`
- Task Plan：`b34010e6-901f-4249-b218-572b0eeda2b6`
- 结果：2/2 Task succeeded，2/2 independently verified，0 corrective attempt。
- 路由证据：`web_search` 明确返回未配置 Provider；两个隔离 Sub-Agent 均调用 `capability_discover`，随后当时的 `agent_reach_search` 成功，再由 `web_extract` 核验官方 URL。当前实现将该工具规范名改为 `exa_web_search`，并保留旧名作为发现别名。
- 交付证据：Task Plan Completion Notice 触发 Objective Delivery，向原 Conversation 返回 Google、AWS、Microsoft、Restate、Temporal 与 Inngest 的已核验来源、日期、结论和未解决事项。

### 仍需完成的系统能力

1. Skill preflight 与显式 discovery 已共享 lexical/可选 semantic ranker；还需要扩大离线评测语料，持续证明同义表达不会产生不可接受的漏召回或误激活。
2. Tool/MCP Provider 已进入统一候选解析、健康检查、配置 blocker、安装授权和 acquisition receipt 接口；仍需扩展真实 Provider catalog adapter，并在 Ubuntu、断网和 Provider 超时矩阵持续验证自动获取与等价换路。
3. Completion Contract 目前依赖确定性 clause 提取和 Situation Builder；需要增加多语言、长指令、否定、例外和跨 Turn 修正的属性测试语料。权限判断不得重新下沉为自然语言业务关键词表。
4. 本矩阵已固化为独立 `eval:agent` release gate 并加入 `verify:release`；仍需在 Ubuntu、无网络、Provider 超时、低上下文和进程崩溃环境持续运行部署级矩阵。

## 发布判定

只有以下条件同时成立，Agent Fulfillment QA 才通过：

- 用户目标和强制约束没有被压缩、委派、修正或 Provider 切换改变。
- 必要 Skill、Tool、MCP 和资源存在可观察的 discovery/activation/receipt 证据。
- 长任务能从 Checkpoint 恢复且不重复 committed 或 unknown Effect。
- Candidate Outcome 通过独立 Verification 后才成为 Business Completion。
- 不能完成时报告 blocker，不返回或发布较弱替代物。
- 全量 typecheck、test、runtime、reliability、security、memory 和目标部署平台资源门禁通过。
