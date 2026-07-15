import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionTools, createWebTools, TurnUnderstandingEngine, selectTurnTools } from "../dist/index.js";

test("Turn Understanding distinguishes create, continue, and correction paths across Chinese and English", () => {
	const engine = new TurnUnderstandingEngine();
	assert.equal(engine.understand("帮我为华东客户制作周报").action, "create");
	const continuation = engine.understand("继续完成刚才的周报", { activeObjective: "制作华东客户周报" });
	assert.equal(continuation.action, "continue");
	assert.match(continuation.memoryQuery, /制作华东客户周报/);
	assert.match(continuation.capabilityQuery, /制作华东客户周报/);
	assert.equal(engine.understand("不是华东客户，改成华南客户", { activeObjective: "制作华东客户周报" }).action, "correct");
	assert.equal(engine.understand("continue the previous report", { activeObjective: "Prepare report" }).action, "continue");
	assert.equal(engine.understand("解释 Agent 的 Capability Routing，并给出一个例子").action, "query");
	assert.equal(engine.understand("用两句话解释 Agent 的 Capability Routing，并给出一个例子").action, "query");
	assert.equal(engine.understand("Explain capability routing with one example").action, "query");
	assert.equal(engine.understand("生成一份解释 Capability Routing 的报告").action, "create");
});

test("Capability Router preselects high-confidence tools without forcing weak matches", () => {
	const tools = [
		{ name: "calendar_find", description: "Find calendar availability" },
		{ name: "document_create", description: "Create a document" },
		{ name: "weather_read", description: "Read current weather" },
	];
	assert.deepEqual(selectTurnTools("use calendar_find to check availability", tools), ["calendar_find"]);
	assert.deepEqual(selectTurnTools("帮我处理一下", tools), []);
});

test("Turn tool prefetch uses the shared capability trigger, alias, exclusion, and safety contract", () => {
	const tools = [
		{ name: "calendar_find", description: "Find available time", aliases: ["查日程"], triggers: ["安排会议"] },
		{ name: "calendar_delete", description: "Delete calendar events", aliases: ["删除日程"], exclude: ["查询", "查"] },
		{ name: "BASH", description: "Run shell commands", triggers: ["安排会议"] },
		{ name: "Capability_Discover", description: "Discover tools", triggers: ["安排会议"] },
		{ name: "weak_match", description: "帮我查日程并安排会议" },
	];
	assert.deepEqual(selectTurnTools("帮我查日程并安排会议", tools), ["calendar_find"]);
});

test("Turn tool prefetch activates Agent-Reach for Chinese live-web research", () => {
	const tools = createWebTools();
	const selected = selectTurnTools("收集截至今天可验证的公开趋势，用 agent-reach 网络检索真实可溯源来源", tools);
	assert.ok(selected.includes("agent_reach_search"));
	assert.deepEqual(selectTurnTools("截至今天，研究公开发布的 AI Agent 工具调用趋势，至少实时核验两个不同注册域的来源", tools), ["agent_reach_search"]);
});

test("Turn tool prefetch routes generic draft persistence and readback through file Tool metadata", () => {
	const tools = createExecutionTools({ platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, "/workspace", { execute: async () => ({ stdout: "", stderr: "", exitCode: 0 }), readFile: async () => "", writeFile: async () => undefined });
	assert.deepEqual(selectTurnTools("Save the draft only as draft.md", tools), ["write"]);
	assert.deepEqual(selectTurnTools("保存到本地文件，然后再次读取确认", tools), ["read", "write"]);
});

test("Turn Understanding preserves explicit constraints and acceptance criteria in one Work Context", () => {
	const result = new TurnUnderstandingEngine().understand("给客户生成PDF报告，必须使用中文，不要包含报价，完成后发给王总");
	assert.equal(result.goal, "给客户生成PDF报告，必须使用中文，不要包含报价，完成后发给王总");
	assert.ok(result.constraints.some((item) => item.includes("必须使用中文")));
	assert.ok(result.constraints.some((item) => item.includes("不要包含报价")));
	assert.ok(result.acceptanceCriteria.some((item) => item.includes("发给王总")));
	assert.equal(result.executionMode, "direct");
	assert.ok(result.confidence > 0.5);
});

test("Turn Understanding treats bilingual negation as a constraint instead of reversing the requested action", () => {
	const engine = new TurnUnderstandingEngine();
	const activeObjective = "研究 BeeMax Provider 架构";
	for (const text of [
		"不要取消任务，继续分析并保留来源",
		"Do not stop the task; continue the analysis and keep citations.",
		"Don't change the goal; continue with the previous task.",
		"继续，but do not publish externally",
	]) {
		const result = engine.understand(text, { activeObjective });
		assert.equal(result.action, "continue", text);
		assert.equal(result.goal, activeObjective, text);
		assert.ok(result.constraints.length >= 1, text);
	}
});

test("Turn Understanding excludes forbidden delivery actions from observable Acceptance Criteria", () => {
	const engine = new TurnUnderstandingEngine();
	const chinese = engine.understand("无需发布，只需要把最终草稿保存到本地文件");
	assert.ok(chinese.constraints.some((item) => item.includes("无需发布")));
	assert.equal(chinese.acceptanceCriteria.some((item) => item.includes("无需发布")), false);
	assert.ok(chinese.acceptanceCriteria.some((item) => item.includes("保存")));
	const english = engine.understand("Do not upload or publish externally; save the final draft locally.");
	assert.equal(english.acceptanceCriteria.some((item) => /upload|publish/i.test(item)), false);
	assert.ok(english.acceptanceCriteria.some((item) => /save/i.test(item)));
});

test("Turn Understanding treats typed identity-looking text as correctable open meaning", () => {
	const result = new TurnUnderstandingEngine().understand("不是之前的，改成主体 account:B、对象 purchase:PO-2", { activeObjective: "处理采购记录" });
	assert.equal(result.action, "correct");
	assert.match(result.goal, /account:B/);
	assert.match(result.memoryQuery, /purchase:PO-2/);
	assert.equal("businessContext" in result, false);
});

test("Turn Understanding keeps randomized unknown-domain identity syntax as open semantics", () => {
	const engine = new TurnUnderstandingEngine();
	const domains = ["nebula", "tide", "lattice", "aurora", "quartz", "harbor", "echo", "prism"];
	for (let index = 0; index < 32; index++) {
		const domain = domains[index % domains.length];
		const text = `校准主体 ${domain}:realm-${index} 下的对象 phase:node-${index}，保留回滚点`;
		const result = engine.understand(text);
		assert.equal(result.businessContext, undefined);
		assert.match(result.goal, new RegExp(domain));
		assert.match(result.memoryQuery, new RegExp(`node-${index}`));
	}
});
