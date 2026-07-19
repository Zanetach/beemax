# Capability Ranking：16 个评测场景

## 范围与读法

本文只整理仓库内的一手实现与运行证据，不引入外部资料。

- 场景、用户任务、期望能力、必需能力与禁止能力定义在 [`evals/capability-ranking-corpus.mjs`](../../evals/capability-ranking-corpus.mjs) 第 1–28 行。
- Live evaluator 直接加载该 corpus，并以 Top-1、Top-K、禁止激活、负例精度、必需能力召回、无关激活、下游完成率和 Pi 执行预算作为门禁，见 [`scripts/evaluate-live-capability-ranking.mjs`](../../scripts/evaluate-live-capability-ranking.mjs) 第 6、30–39、49–60 行。
- Evidence digest 把 corpus、确定性/Live harness、Pi loop、Tool Spec 和 verifier 一并纳入实现身份，见 [`scripts/capability-ranking-evidence.mjs`](../../scripts/capability-ranking-evidence.mjs) 第 5–37 行。
- 当前运行结果记录在 [`evals/baselines/capability-ranking-live.json`](../../evals/baselines/capability-ranking-live.json)：`observedRankings` 保存模型候选，`taskReceipts` 保存确定性执行证据，`piOutcome.receipts` 保存真实 Pi Tool 调用与验收证据。

表中的“实际工具”取自能力清单的 `activeTools` 与当前 baseline 的成功 Tool receipt。负例的期望是“不选择、不执行任何业务能力工具”；`capability_discover` 只是发现入口，不算被激活的目标能力。

## 16 个场景

| # | 场景 ID | 用户任务 | 期望能力 → 实际工具 | 该场景在测什么 |
|---:|---|---|---|---|
| 1 | `zh-web` | 联网检索最新公开证据 | `web_search` → `web_search` | 中文直接意图能否路由到实时公开检索，并避免误用 `memory_recall`。 |
| 2 | `en-web` | research current sources | `web_search` → `web_search` | 英文触发语能否路由到公开检索，并避免误用 `file_read`。 |
| 3 | `semantic-web-paraphrase` | find fresh live public evidence | `web_search` → `web_search` | 不复用清单原句的英文语义改写，能否仍由语义排序识别为实时公开检索；这是对纯关键词匹配的区分场景。 |
| 4 | `mixed-web` | 请 research current sources 验证一下 | `web_search` → `web_search` | 中英混合表达能否稳定映射到同一能力，并避免误用 `memory_recall`。 |
| 5 | `zh-meeting` | 安排会议讨论方案 | `meeting_schedule`（MCP）→ `mcp_meeting_schedule` | 中文外部动作意图能否选择会议 MCP，而不是仅因“方案”或一般信息需求调用 `web_search`。 |
| 6 | `en-meeting` | book time with the team | `meeting_schedule`（MCP）→ `mcp_meeting_schedule` | 英文会议安排别名能否选择外部 MCP，并避免误用 `data_analyze`。 |
| 7 | `zh-memory` | 回忆我们之前决定的方案 | `memory_recall` → `memory_recall` | “既有决定”能否路由到确认记忆召回，而不是把内部历史问题错误变成联网检索。 |
| 8 | `zh-file` | 读取文件里的附件内容，不要联网 | `file_read` → `read` | 文件读取意图与明确否定约束能否同时生效：应读文件，并禁止 `web_search`。 |
| 9 | `zh-data` | 分析数据并检查指标异常 | `data_analyze` → `data_analyze` | 结构化数据与异常分析意图能否选择分析工具，并避免误触发会议能力。 |
| 10 | `multi-research-data` | 检索最新公开来源，并分析其中的结构化指标异常 | 必需 `web_search` + `data_analyze` → 同名两个工具 | 单个任务包含两个必要能力时，Top-K 召回、Tool Spec 激活和下游执行能否完整覆盖两者，而不是只完成第一步；同时禁止 `meeting_schedule`。 |
| 11 | `unknown-registry` | 查询内部定义的 zeta-q7 标识，返回带证据的记录 | `opaque_registry_query`（MCP）→ `opaque_registry_query` | 面对未知、企业自定义且不带固定业务本体的标识，能否依据通用能力描述选择组织注册表查询，并避免把它猜成记忆问题。 |
| 12 | `unknown-procedure` | 按组织提供的 VEL-9 流程核验 qx-17 材料并保留证据 | `procedure-conformance-check`（Skill）→ `skill_read`，再 `skill_complete` | 面对未知组织流程，能否选择 Skill 而非硬编码业务规则，并完成“读取 Skill → 按 Skill 完成”的生命周期及能力 receipt；禁止会议能力。 |
| 13 | `negative-chat` | 你好，介绍一下你自己 | 无目标能力 → 无业务工具 | 普通对话是否保持 no-match，不为完成聊天而强行激活任一能力。 |
| 14 | `negative-weak-web` | explain how research methods work | 无目标能力 → 无业务工具 | 仅出现弱相关词 `research` 时，是否避免把知识解释误判成需要实时联网检索。 |
| 15 | `negative-weak-meeting` | summarize the meeting notes already supplied | 无目标能力 → 无业务工具 | 出现 `meeting` 但任务只是总结已有内容时，是否避免把名词重合误判成安排会议的外部动作。 |
| 16 | `negative-negated-memory` | do not recall anything; explain the architecture | 无目标能力 → 无业务工具 | 明确否定记忆召回时，是否尊重否定约束，不因出现 `recall` 关键词而激活 `memory_recall`。 |

## 当前 baseline 结论

当前 artifact 的 `report.cases` 为 16；`fallbackCases` 为空，`gate.passed` 为 `true`。`observedRankings` 对前 12 个正例给出了期望候选，对后 4 个负例给出空候选；`taskReceipts` 与 `piOutcome.receipts` 记录了相应工具执行和 accepted Verification。这里描述的是该 baseline 的当前证据，不把 frozen corpus 的标签当作任何具体模型的长期质量保证。
