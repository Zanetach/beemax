import assert from "node:assert/strict";
import test from "node:test";
import { createWebTools, TurnUnderstandingEngine, selectTurnTools } from "../dist/index.js";

test("Turn Understanding distinguishes create, continue, and correction paths across Chinese and English", () => {
	const engine = new TurnUnderstandingEngine();
	assert.equal(engine.understand("帮我为华东客户制作周报").action, "create");
	const continuation = engine.understand("继续完成刚才的周报", { activeObjective: "制作华东客户周报" });
	assert.equal(continuation.action, "continue");
	assert.match(continuation.memoryQuery, /制作华东客户周报/);
	assert.match(continuation.capabilityQuery, /制作华东客户周报/);
	assert.equal(engine.understand("不是华东客户，改成华南客户", { activeObjective: "制作华东客户周报" }).action, "correct");
	assert.equal(engine.understand("continue the previous report", { activeObjective: "Prepare report" }).action, "continue");
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
