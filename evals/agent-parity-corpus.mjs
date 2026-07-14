function scenario({ id, category, prompt, requiredCapabilities = [], requiredEvidenceKinds = [], facets = [], outputContract }) {
	return Object.freeze({
		id, category, prompt,
		requiredCapabilities: Object.freeze(requiredCapabilities),
		requiredEvidenceKinds: Object.freeze(requiredEvidenceKinds),
		facets: Object.freeze(facets),
		...(outputContract ? { outputContract: Object.freeze({
			requiredAnyGroups: Object.freeze((outputContract.requiredAnyGroups ?? []).map((group) => Object.freeze(group))),
			forbidden: Object.freeze(outputContract.forbidden ?? []),
			minPublicSources: outputContract.minPublicSources ?? 0,
			requiredAuthorityIds: Object.freeze(outputContract.requiredAuthorityIds ?? []),
			requiredFacts: Object.freeze(outputContract.requiredFacts ?? {}),
			minimumFacts: Object.freeze(outputContract.minimumFacts ?? {}),
		}) } : {}),
	});
}

const scenarios = [
	scenario({ id: "conversation-short", category: "conversation", prompt: "用两句话解释 Agent 的 Capability Routing，并给出一个简短例子。", facets: ["short_task"], outputContract: { requiredAnyGroups: [["capability", "能力"], ["routing", "路由"], ["例如", "比如", "example", "例子"]] } }),
	scenario({ id: "constraint-negation-zh", category: "semantics", prompt: "当前目标是完成一份 Capability Routing 报告。不要取消，继续完成报告；不要改目标。", facets: ["continuation", "negation"], outputContract: { requiredAnyGroups: [["报告", "report"], ["继续", "完成", "continue", "complete"]], forbidden: ["已取消", "cancelled"] } }),
	scenario({ id: "constraint-negation-en", category: "semantics", prompt: "Draft text: Capability routing selects an authorized implementation. Do not publish it; save the draft only as draft.md in the evaluation workspace.", requiredCapabilities: ["document_write"], requiredEvidenceKinds: ["artifact"], facets: ["negation", "local_effect"], outputContract: { requiredFacts: { draftExists: true }, forbidden: ["published successfully"] } }),
	scenario({ id: "current-research", category: "realtime_research", prompt: "截至今天，研究公开发布的 AI Agent 工具调用趋势，至少实时核验两个不同注册域的来源并保留来源。", requiredCapabilities: ["web_search"], requiredEvidenceKinds: ["source"], facets: ["current", "external_fact"], outputContract: { minPublicSources: 2 } }),
	scenario({ id: "explicit-skill", category: "skill", prompt: "通过 agent_parity activate_skill Tool 加载 evaluation-research，再按该 Skill 调用两个 Source Tool 核验 Source A 与 Source B，并输出结论。", requiredCapabilities: ["research_skill", "source_read_a", "source_read_b"], requiredEvidenceKinds: ["skill", "source"], facets: ["skill"], outputContract: { requiredAnyGroups: [["SOURCE-A-ROUTING"], ["SOURCE-B-VERIFY"]], requiredAuthorityIds: ["SKILL-evaluation-research-v1", "SOURCE-A-ROUTING", "SOURCE-B-VERIFY"] } }),
	scenario({ id: "missing-provider", category: "provider", prompt: "获取当前公开信息；本地搜索 Provider 未配置时找到可用实现。", requiredCapabilities: ["web_search"], requiredEvidenceKinds: ["source"], facets: ["provider_acquisition"], outputContract: { minPublicSources: 1 } }),
	scenario({ id: "mcp-tool", category: "mcp", prompt: "通过已配置的 agent_parity MCP 查询 fixture 系统状态，返回 fixture ID。", requiredCapabilities: ["status_mcp"], requiredEvidenceKinds: ["source"], facets: ["mcp"], outputContract: { requiredAnyGroups: [["MCP-STATUS-READY"]], requiredAuthorityIds: ["MCP-STATUS-READY"] } }),
	scenario({ id: "file-artifact", category: "file", prompt: "读取 source-a.md 和 source-b.md，生成 report.md，并再次读取 report.md 验证文件存在且包含两个来源标识。", requiredCapabilities: ["document_write", "file_read"], requiredEvidenceKinds: ["artifact", "filesystem"], facets: ["file", "local_effect"], outputContract: { requiredFacts: { reportContainsBothSources: true } } }),
	scenario({ id: "image-understanding", category: "multimodal", prompt: "识别 image-fixture.svg 中的形状、颜色和验证码；主模型不支持视觉时使用已配置的 auxiliary image Tool，并保留识别证据。", requiredCapabilities: ["image_understand"], requiredEvidenceKinds: ["artifact"], facets: ["image", "ocr"], outputContract: { requiredAnyGroups: [["hexagon", "六边形"], ["blue", "蓝"], ["VISION-42"]] } }),
	scenario({ id: "long-plan", category: "long_task", prompt: "完成三个独立研究分支：工具路由、证据验证、失败恢复；每个分支使用公开来源，保存检查点后汇总结论。", requiredCapabilities: ["task_plan", "web_search"], requiredEvidenceKinds: ["source", "checkpoint"], facets: ["long_running", "parallel"], outputContract: { minPublicSources: 2, requiredAnyGroups: [["路由", "routing"], ["验证", "verification"], ["恢复", "recovery"]] } }),
	scenario({ id: "provider-failure-recovery", category: "recovery", prompt: "调用 fixture recovery Tool；Provider 首次失败并保存检查点后，使用同一 recovery ID 继续，不重复已完成步骤。", requiredCapabilities: ["task_recover"], requiredEvidenceKinds: ["checkpoint"], facets: ["recovery"], outputContract: { requiredAuthorityIds: ["RECOVERY-CHECKPOINT-1"], requiredAnyGroups: [["recovered", "恢复"]] } }),
	scenario({ id: "unknown-effect", category: "recovery", prompt: "使用 fixture idempotency key fixture-effect-1 发起发送；操作超时且结果未知时必须调用 Effect 状态 Tool 对账，确认已提交后不得重试发送。", requiredCapabilities: ["effect_reconcile"], requiredEvidenceKinds: ["effect"], facets: ["recovery", "external_effect"], outputContract: { requiredAuthorityIds: ["EFFECT-COMMITTED-1"], requiredFacts: { effectCommitCount: 1 }, minimumFacts: { effectAttemptCount: 1, effectReconcileCount: 1 }, requiredAnyGroups: [["committed", "已提交"]] } }),
	scenario({ id: "gateway-direct", category: "gateway", prompt: "通过 fixture Delivery Tool 把后台完成结果投递到 original-private，并保留 Delivery Receipt。", requiredCapabilities: ["message_deliver"], requiredEvidenceKinds: ["delivery"], facets: ["gateway", "external_effect"], outputContract: { requiredAuthorityIds: ["DELIVERY-original-private"] } }),
	scenario({ id: "gateway-group", category: "gateway", prompt: "这是 fixture-group-thread 中的有效 @。通过 fixture Delivery Tool 回到同一群聊线程，并保留 Delivery Receipt。", requiredCapabilities: ["message_deliver"], requiredEvidenceKinds: ["delivery"], facets: ["gateway", "group"], outputContract: { requiredAuthorityIds: ["DELIVERY-fixture-group-thread"] } }),
	scenario({ id: "profile-isolation", category: "isolation", prompt: "调用 agent_parity memory_recall Tool 且 profile 必须为 target，检查权威 fixture 是否阻止返回 foreign Profile 记录，并报告 Profile 是否隔离。", requiredCapabilities: ["memory_recall"], requiredEvidenceKinds: ["scope"], facets: ["profile", "isolation"], outputContract: { requiredAnyGroups: [["隔离", "isolation", "泄漏", "leak"], ["profile"]], requiredAuthorityIds: ["PROFILE-TARGET-ISOLATED"], requiredFacts: { profileIsolationVerified: true } } }),
	scenario({ id: "scheduled-work", category: "automation", prompt: "通过 fixture Schedule Tool 运行 fixture-schedule-1，投递到 original-private，并保留 Checkpoint 与 Delivery Receipt。", requiredCapabilities: ["schedule_run"], requiredEvidenceKinds: ["checkpoint", "delivery"], facets: ["automation", "recovery"], outputContract: { requiredAuthorityIds: ["SCHEDULE-CHECKPOINT-1", "SCHEDULE-DELIVERY-1"] } }),
	scenario({ id: "tool-arguments", category: "routing", prompt: "调用 fixture structured lookup Tool：entityId 必须为 fixture-42，fields 必须包含 status 与 owner。", requiredCapabilities: ["structured_tool"], requiredEvidenceKinds: ["tool"], facets: ["tool_arguments"], outputContract: { requiredAnyGroups: [["fixture-42"], ["status"], ["owner"]] } }),
	scenario({ id: "parallel-read", category: "routing", prompt: "并行调用两个 fixture Source Tool 读取 Source A 与 Source B，并汇总它们一致与冲突的内容。", requiredCapabilities: ["source_read_a", "source_read_b"], requiredEvidenceKinds: ["source"], facets: ["parallel"], outputContract: { requiredAnyGroups: [["SOURCE-A-ROUTING"], ["SOURCE-B-VERIFY"]] } }),
];

export const agentParityCorpus = Object.freeze({
	version: 1,
	seed: "beemax-agent-parity-v1",
	cases: Object.freeze(scenarios),
});
