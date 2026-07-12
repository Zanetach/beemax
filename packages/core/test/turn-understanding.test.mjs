import assert from "node:assert/strict";
import test from "node:test";
import { TurnUnderstandingEngine, selectTurnTools } from "../dist/index.js";

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

test("Turn Understanding preserves explicit constraints and acceptance criteria in one Work Context", () => {
	const result = new TurnUnderstandingEngine().understand("给客户生成PDF报告，必须使用中文，不要包含报价，完成后发给王总");
	assert.equal(result.goal, "给客户生成PDF报告，必须使用中文，不要包含报价，完成后发给王总");
	assert.ok(result.constraints.some((item) => item.includes("必须使用中文")));
	assert.ok(result.constraints.some((item) => item.includes("不要包含报价")));
	assert.ok(result.acceptanceCriteria.some((item) => item.includes("发给王总")));
	assert.equal(result.executionMode, "direct");
	assert.ok(result.confidence > 0.5);
});
