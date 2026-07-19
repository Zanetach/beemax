import assert from "node:assert/strict";
import test from "node:test";
import { ArtifactRuntime, CapabilityRuntime, LexicalCapabilityRanker, capabilityDescriptor, capabilityVersionOf, createArtifactTools, createExecutionTools, createWebTools, TurnUnderstandingEngine, selectTurnTools } from "../dist/index.js";

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

test("Turn Understanding does not treat a negated lifecycle clarification as a correction", () => {
	const result = new TurnUnderstandingEngine().understand("这是新的修正验收，不是继续、恢复或修正任何活动 Objective；检查现有文件");
	assert.equal(result.action, "create");
});

test("Turn Understanding does not confuse independent verification with parallel Sub-Agent work", () => {
	const result = new TurnUnderstandingEngine().understand("新建一个独立验收目标，不启用子任务。读取现有报告并做独立验证，必要时修正文件");
	assert.equal(result.executionMode, "direct");
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

test("Turn tool prefetch activates Exa for Chinese live-web research", () => {
	const tools = createWebTools({ agentReachAvailable: true });
	const selected = selectTurnTools("收集截至今天可验证的公开趋势，用 agent-reach 网络检索真实可溯源来源", tools);
	assert.ok(selected.includes("exa_web_search"));
	assert.deepEqual(selectTurnTools("截至今天，研究公开发布的 AI Agent 工具调用趋势，至少实时核验两个不同注册域的来源", tools), ["exa_web_search"]);
});

test("Turn tool prefetch maps independent source cross-checking to Exa", () => {
	const tools = createWebTools({ agentReachAvailable: true });
	assert.equal(selectTurnTools("至少使用两个相互独立、公开可访问的真实来源交叉验证", tools, 3)[0], "exa_web_search");
});

test("bounded deterministic repair covers every gold-report capability obligation with exact metadata", async () => {
	const digest = "a".repeat(64);
	const artifactRuntime = new ArtifactRuntime({
		providers: [{
			descriptor: { id: "chrome", version: "1", operations: [{ operation: "render", inputMediaTypes: ["text/html"], outputMediaTypes: ["application/pdf"] }] },
			async produce(request) { return { locator: request.output, mediaType: request.outputMediaType }; },
		}],
		verifiers: [{
			descriptor: { id: "independent", version: "1", mediaTypes: ["text/html", "application/pdf"], dimensions: ["existence", "integrity", "semantic", "render", "consistency"] },
			async verify(request) { return { observed: { locator: request.locator, mediaType: request.mediaType, byteLength: 100, sha256: digest }, checks: request.dimensions.map((dimension) => ({ dimension, status: "accepted", evidenceRefs: [] })) }; },
		}],
	});
	const executionTools = createExecutionTools({ platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, "/workspace", { execute: async () => ({ stdout: "", stderr: "", exitCode: 0 }), readFile: async () => "", writeFile: async () => undefined });
	const tools = [...createWebTools({ agentReachAvailable: false }), ...executionTools, ...createArtifactTools({ platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, "/workspace", artifactRuntime)]
		.filter((tool) => ["web_search", "exa_web_search", "write", "artifact_render", "artifact_inspect"].includes(tool.name));
	const inventory = tools.map((tool) => capabilityDescriptor({
		kind: "tool", name: tool.name, description: tool.description, aliases: tool.aliases, triggers: tool.triggers, exclude: tool.exclude,
		version: capabilityVersionOf({ name: tool.name, description: tool.description, parameters: tool.parameters }), activeTools: [tool.name],
		signals: { ...(tool.beemaxToolSpec?.ranking ?? {}), health: tool.providers?.length ? "unknown" : tool.beemaxToolSpec?.health ?? "unverified" },
	}));
	const requirements = [
		{ id: "req:research", text: "自主调研截至 2026-07-17 的过去一周 XAU/USD 现货黄金走势" },
		{ id: "req:sources", text: "至少使用两个相互独立、公开可访问的实时来源，所有关键事实附来源 URL" },
		{ id: "req:html", text: "在 Profile workspace 中交付 gold-weekly-report.html" },
		{ id: "req:pdf", text: "交付 gold-weekly-report.pdf" },
		{ id: "req:verify", text: "真实检查 HTML 内容与渲染、PDF 存在性完整性可解析性页面渲染，以及两份文件关键数字和来源一致" },
		{ id: "req:consistency", text: "两份文件关键数字和来源一致性" },
		{ id: "req:url-count", text: "实际提取 HTML 中的 href 去重并确认正好 6 个外部 URL" },
	];
	const selection = await new CapabilityRuntime({ ranker: new LexicalCapabilityRanker() }).discover({
		query: requirements.map(({ text }) => text).join("\n"), inventory, requirements, cognitionId: "cap:gold-report-routing",
	});
	const selectedByRequirement = Object.fromEntries(selection.candidates.map((candidate) => [candidate.requirementId, candidate.name]));
	assert.ok(["web_search", "exa_web_search"].includes(selectedByRequirement["req:research"]));
	assert.ok(["web_search", "exa_web_search"].includes(selectedByRequirement["req:sources"]));
	assert.equal(selectedByRequirement["req:html"], "write");
	assert.equal(selectedByRequirement["req:pdf"], "artifact_render");
	assert.equal(selectedByRequirement["req:verify"], "artifact_inspect");
	assert.equal(selectedByRequirement["req:consistency"], "artifact_render");
	assert.equal(selectedByRequirement["req:url-count"], "artifact_inspect");
	assert.deepEqual(new Set(selection.activatedTools), new Set(Object.values(selectedByRequirement)));
});

test("Turn tool prefetch routes generic draft persistence and readback through file Tool metadata", () => {
	const tools = createExecutionTools({ platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, "/workspace", { execute: async () => ({ stdout: "", stderr: "", exitCode: 0 }), readFile: async () => "", writeFile: async () => undefined });
	assert.deepEqual(selectTurnTools("Save the draft only as draft.md", tools), ["write"]);
	assert.deepEqual(selectTurnTools("保存到本地文件，然后再次读取确认", tools), ["read", "write"]);
	assert.deepEqual(selectTurnTools("读取该 HTML 并在必要时修正", tools).sort(), ["read", "write"]);
	assert.deepEqual(selectTurnTools("read and edit the existing HTML file", tools).sort(), ["read", "write"]);
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
