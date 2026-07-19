import assert from "node:assert/strict";
import test from "node:test";
import { ModelBackedWorkContractBuilder, PiWorkContractBuilder, SEMANTIC_INVENTORY_SYSTEM_PROMPT, WORK_CONTRACT_SYSTEM_PROMPT, WorkContractCognitionError, adjudicateWorkContract, decodeSemanticInventory, hasSemanticWorkContractAdjudication, resolveSemanticOccurrence, validateWorkContract } from "../dist/index.js";

test("model cognition prompts make lifecycle and negative-role classification unambiguous", () => {
	for (const prompt of [WORK_CONTRACT_SYSTEM_PROMPT, SEMANTIC_INVENTORY_SYSTEM_PROMPT]) {
		assert.match(prompt, /affirmative material command/i);
		assert.match(prompt, /negative preservation instructions.*prohibitions.*never constraints/i);
		assert.match(prompt, /revise.*active Objective.*correct/i);
		assert.match(prompt, /language.*format.*modifiers.*constraints/i);
		assert.match(prompt, /freshness.*source.scope.*observable outcome.*capability requirement/i);
		assert.match(prompt, /confidence.*semantic extraction.*not.*execution feasibility/i);
		assert.match(prompt, /only.*requested outcome.*not.*constraint/i);
		assert.match(prompt, /intrinsic.*retrieval.*online.*联网/i);
		assert.match(prompt, /below 0\.6 only.*unresolved semantic ambiguity/i);
		assert.match(prompt, /negated operation|governed by do not/i);
		assert.match(prompt, /stored memory.*prior decisions.*create.*never query/i);
		assert.match(prompt, /summariz.*already supplied|already supplied.*summariz/i);
		assert.match(prompt, /capability requirement.*not.*synonym.*acceptance criterion/i);
		assert.match(prompt, /dates.*prices.*highs.*lows.*drivers.*risks.*not.*separate capability/i);
		assert.match(prompt, /quality.*consistency.*repair.*not.*separate capability/i);
		assert.match(prompt, /source artifact.*derived artifact.*separate capability/i);
		assert.match(prompt, /create.*\.html.*\.pdf.*write.*render/i);
		assert.match(prompt, /resumeObjective.*continue.*never create a duplicate/i);
		assert.match(prompt, /concrete.*dates.*names.*file paths.*quantities.*resolved parameters.*never uncertainties/i);
	}
});

test("an exact active Objective replay is deterministically bound to continue instead of duplicate create", () => {
	const rawRequest = "生成并验证黄金周报";
	const fallback = { action: "continue", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], uncertainties: [], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 1 };
	const resumeObjective = { id: "objective:existing", title: rawRequest };
	const trustedContext = { fallback, activeObjectives: [resumeObjective], activeObjective: resumeObjective, resumeObjective };
	assert.throws(() => validateWorkContract(contract(rawRequest, { action: "create", objectiveText: rawRequest, acceptanceTexts: [rawRequest] }), rawRequest, { trustedContext }), /resume Objective.*continue/i);
	const continued = validateWorkContract(contract(rawRequest, { action: "continue", targetObjectiveId: resumeObjective.id, objectiveText: rawRequest, acceptanceTexts: [rawRequest] }), rawRequest, { trustedContext, enforceFallbackUnderstanding: false });
	assert.equal(continued.action, "continue");
	assert.equal(continued.targetObjective.id, resumeObjective.id);
});

test("a conversational query cannot carry an execution Capability obligation", () => {
	const rawRequest = "explain the architecture";
	assert.throws(() => validateWorkContract(contract(rawRequest, { action: "query", objectiveText: rawRequest, acceptanceTexts: [rawRequest], capabilityTexts: [rawRequest] }), rawRequest), /query cannot require.*Capability/i);
});

const activeObjectives = [{ id: "market", title: "市场分析" }, { id: "report", title: "周报" }];

test("semantic adjudication blocks an Objective that swallows a distinct prohibition", () => {
	const rawRequest = "不要取消市场分析，取消周报";
	const inventory = decode(rawRequest, {
		action: "cancel", targetObjectiveId: "report", confidence: 0.98,
		segments: [
			{ text: "不要取消市场分析", occurrence: 0, roles: ["prohibition"] },
			{ text: "取消周报", occurrence: 0, roles: ["objective"] },
		],
	});
	const result = adjudicateWorkContract({ contract: contract(rawRequest, { action: "cancel", targetObjectiveId: "report", objectiveText: rawRequest }), inventory, minimumConfidence: 0.6 });
	assert.equal(result.kind, "blocked");
	assert.equal(result.code, "ROLE_COVERAGE_INCOMPLETE");
	assert.deepEqual(result.missing.map(({ role, text }) => ({ role, text })), [{ role: "prohibition", text: "不要取消市场分析" }]);
});

test("semantic adjudication accepts one comma-bearing list Objective", () => {
	const rawRequest = "整理客户、供应商和合作伙伴名单";
	const inventory = decode(rawRequest, {
		action: "create", confidence: 0.97,
		segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion"] }],
	}, []);
	const result = adjudicateWorkContract({ contract: contract(rawRequest, { objectiveText: rawRequest, acceptanceTexts: [rawRequest] }), inventory, minimumConfidence: 0.6 });
	assert.deepEqual(result, { kind: "accepted" });
});

test("semantic adjudication removes a primary uncertainty that independent exact-span inventory does not confirm", () => {
	const rawRequest = "自主调研截至 2026-07-17 的过去一周黄金走势";
	const explicitDate = "截至 2026-07-17";
	const inventory = decode(rawRequest, {
		action: "create", confidence: 0.99,
		segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] }],
	}, []);
	const result = adjudicateWorkContract({ contract: contract(rawRequest, {
		objectiveText: rawRequest,
		acceptanceTexts: [rawRequest],
		capabilityTexts: [rawRequest],
		uncertaintyTexts: [explicitDate],
	}), inventory });
	assert.deepEqual(result, { kind: "accepted", normalizedUncertainties: [] });
});

test("semantic adjudication does not turn an operational if-then instruction into a blocking uncertainty", () => {
	const rawRequest = "生成报告；若一次 write 会超过模型输出限制，请使用分块协议";
	const condition = "若一次 write 会超过模型输出限制，";
	const inventory = decode(rawRequest, {
		action: "create", confidence: 0.99,
		segments: [
			{ text: "生成报告", occurrence: 0, roles: ["objective", "acceptance_criterion"] },
			{ text: condition, occurrence: 0, roles: ["uncertainty"] },
			{ text: "请使用分块协议", occurrence: 0, roles: ["constraint"] },
		],
	}, []);
	const result = adjudicateWorkContract({ contract: contract(rawRequest, {
		objectiveText: "生成报告",
		acceptanceTexts: ["生成报告"],
		constraintTexts: ["请使用分块协议"],
		uncertaintyTexts: [condition],
	}), inventory });
	assert.deepEqual(result, { kind: "accepted", normalizedUncertainties: [] });
});

test("Pi Work Contract publishes only independently confirmed uncertainties", async () => {
	const rawRequest = "自主调研截至 2026-07-17 的过去一周黄金走势";
	const explicitDate = "截至 2026-07-17";
	const complete = async (_candidate, context) => response(context.systemPrompt.includes("Independently inventory") ? {
		schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.99,
		segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] }],
	} : {
		action: "create", objective: { text: rawRequest }, constraints: [], prohibitions: [],
		acceptanceCriteria: [{ text: rawRequest }], capabilityRequirements: [{ text: rawRequest }],
		uncertainties: [{ text: explicitDate }], executionMode: "direct", confidence: 0.99,
	});
	const result = await new PiWorkContractBuilder({ models: [{ model: model("uncertainty-normalization") }], complete }).build({
		rawRequest,
		fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], uncertainties: [], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 0.99 },
	});
	assert.deepEqual(result.contract.uncertainties, []);
});

test("semantic adjudication blocks action and target disagreement", () => {
	const rawRequest = "继续周报";
	const inventory = decode(rawRequest, { action: "continue", targetObjectiveId: "report", confidence: 0.9, segments: [{ text: rawRequest, occurrence: 0, roles: ["objective"] }] });
	assert.equal(adjudicateWorkContract({ contract: contract(rawRequest, { action: "correct", targetObjectiveId: "report" }), inventory }).code, "ACTION_DISAGREEMENT");
	assert.equal(adjudicateWorkContract({ contract: contract(rawRequest, { action: "continue", targetObjectiveId: "market" }), inventory }).code, "TARGET_DISAGREEMENT");
});

test("semantic adjudication keeps constraints strict while capability obligations remain independently restorable", () => {
	const rawRequest = "生成报告，使用中文，保存草稿";
	const inventory = decode(rawRequest, {
		action: "create", confidence: 0.9,
		segments: [
			{ text: "生成报告", occurrence: 0, roles: ["objective"] },
			{ text: "使用中文", occurrence: 0, roles: ["constraint"] },
			{ text: "保存草稿", occurrence: 0, roles: ["acceptance_criterion", "capability_requirement"] },
		],
	}, []);
	const weak = contract(rawRequest, { objectiveText: rawRequest, acceptanceTexts: ["保存草稿"] });
	const result = adjudicateWorkContract({ contract: weak, inventory });
	assert.equal(result.code, "ROLE_COVERAGE_INCOMPLETE");
	assert.deepEqual(result.missing.map(({ role }) => role), ["constraint"]);
});

test("a fused output phrase preserves an embedded format constraint through the exact Objective and criterion", () => {
	const rawRequest = "生成一份中文专业报告";
	const inventory = decode(rawRequest, {
		action: "create", confidence: 0.9,
		segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "constraint", "acceptance_criterion"] }],
	}, []);
	const result = adjudicateWorkContract({ contract: contract(rawRequest, { objectiveText: rawRequest, acceptanceTexts: [rawRequest] }), inventory });
	assert.deepEqual(result, { kind: "accepted" });
});

test("semantic adjudication atomizes one compound Capability clause from independently inventoried outcomes", () => {
	const rawRequest = "查询当前来源并归档结果";
	const inventory = decode(rawRequest, {
		action: "create", confidence: 0.99,
		segments: [
			{ text: "查询当前来源", occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] },
			{ text: "并", occurrence: 0, roles: ["context"] },
			{ text: "归档结果", occurrence: 0, roles: ["acceptance_criterion", "capability_requirement"] },
		],
	}, []);
	const result = adjudicateWorkContract({ contract: contract(rawRequest, {
		objectiveText: rawRequest,
		acceptanceTexts: [rawRequest],
		capabilityTexts: [rawRequest],
	}), inventory });
	assert.deepEqual(result, { kind: "accepted", normalizedCapabilityRequirements: [
		{ text: "查询当前来源", source: { kind: "raw_request", start: 0, end: 6 } },
		{ text: "归档结果", source: { kind: "raw_request", start: 7, end: 11 } },
	] });
});

test("semantic adjudication atomizes coordinated retrieval and structured-analysis boundaries even when the inventory fused them", () => {
	const rawRequest = "检索最新公开来源，并分析其中的结构化指标异常";
	const inventory = decode(rawRequest, {
		action: "create", confidence: 0.99,
		segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] }],
	}, []);
	const result = adjudicateWorkContract({ contract: contract(rawRequest, {
		objectiveText: rawRequest,
		acceptanceTexts: [rawRequest],
		capabilityTexts: [rawRequest],
	}), inventory });
	assert.deepEqual(result, { kind: "accepted", normalizedCapabilityRequirements: [
		{ text: "检索最新公开来源", source: { kind: "raw_request", start: 0, end: 8 } },
		{ text: "分析其中的结构化指标异常", source: { kind: "raw_request", start: 10, end: rawRequest.length } },
	] });
});

test("semantic adjudication restores coordinated retrieval and structured-analysis boundaries omitted from inventory roles", () => {
	const rawRequest = "检索最新公开来源，并分析其中的结构化指标异常";
	const inventory = decode(rawRequest, {
		action: "create", confidence: 0.99,
		segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion"] }],
	}, []);
	const result = adjudicateWorkContract({ contract: contract(rawRequest, {
		objectiveText: rawRequest,
		acceptanceTexts: [rawRequest],
	}), inventory });
	assert.deepEqual(result, { kind: "accepted", normalizedCapabilityRequirements: [
		{ text: "检索最新公开来源", source: { kind: "raw_request", start: 0, end: 8 } },
		{ text: "分析其中的结构化指标异常", source: { kind: "raw_request", start: 10, end: rawRequest.length } },
	] });
});

test("semantic adjudication removes a coordination prefix from an independently segmented data-analysis boundary", () => {
	const rawRequest = "检索最新公开来源，并分析其中的结构化指标异常";
	const inventory = decode(rawRequest, {
		action: "create", confidence: 0.99,
		segments: [
			{ text: "检索最新公开来源", occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] },
			{ text: "，", occurrence: 0, roles: ["context"] },
			{ text: "并分析其中的结构化指标异常", occurrence: 0, roles: ["acceptance_criterion", "capability_requirement"] },
		],
	}, []);
	const result = adjudicateWorkContract({ contract: contract(rawRequest, {
		objectiveText: rawRequest,
		acceptanceTexts: [rawRequest],
		capabilityTexts: [rawRequest],
	}), inventory });
	assert.deepEqual(result, { kind: "accepted", normalizedCapabilityRequirements: [
		{ text: "检索最新公开来源", source: { kind: "raw_request", start: 0, end: 8 } },
		{ text: "分析其中的结构化指标异常", source: { kind: "raw_request", start: 10, end: rawRequest.length } },
	] });
});

test("semantic adjudication restores an omitted Capability requirement from exact independent inventory spans", () => {
	const rawRequest = "联网检索最新公开证据";
	const inventory = decode(rawRequest, {
		action: "create", confidence: 0.99,
		segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] }],
	}, []);
	const result = adjudicateWorkContract({ contract: contract(rawRequest, {
		objectiveText: rawRequest,
		acceptanceTexts: [rawRequest],
	}), inventory });
	assert.deepEqual(result, { kind: "accepted", normalizedCapabilityRequirements: [
		{ text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } },
	] });
});

test("semantic adjudication removes non-boundary content and recovery rules while attaching a delivery prefix to its source artifact", () => {
	const rawRequest = "生成中文专业报告，为关键事实附来源 URL，并在 Profile workspace 中交付 report.html 与 report.pdf，以及两份文件关键数字和来源一致性；如果来源失败，自动换用等价来源继续。";
	const inventory = decode(rawRequest, {
		action: "create", confidence: 0.99,
		segments: [
			{ text: "生成中文专业报告", occurrence: 0, roles: ["objective", "constraint", "acceptance_criterion", "capability_requirement"] },
			{ text: "为关键事实附来源 URL", occurrence: 0, roles: ["acceptance_criterion", "capability_requirement"] },
			{ text: "并在 Profile workspace 中交付 ", occurrence: 0, roles: ["capability_requirement"] },
			{ text: "report.html", occurrence: 0, roles: ["acceptance_criterion", "capability_requirement"] },
			{ text: "与", occurrence: 0, roles: ["context"] },
			{ text: "report.pdf", occurrence: 0, roles: ["acceptance_criterion", "capability_requirement"] },
			{ text: "以及两份文件关键数字和来源一致性", occurrence: 0, roles: ["acceptance_criterion", "capability_requirement"] },
			{ text: "如果来源失败，自动换用等价来源继续", occurrence: 0, roles: ["constraint", "capability_requirement"] },
		],
	}, []);
	const result = adjudicateWorkContract({ contract: contract(rawRequest, {
		objectiveText: "生成中文专业报告",
		constraintTexts: ["生成中文专业报告", "如果来源失败，自动换用等价来源继续"],
		acceptanceTexts: ["生成中文专业报告", "为关键事实附来源 URL", "report.html", "report.pdf", "以及两份文件关键数字和来源一致性"],
		capabilityTexts: [rawRequest],
	}), inventory });
	const html = "并在 Profile workspace 中交付 report.html";
	const pdf = "report.pdf";
	assert.deepEqual(result, { kind: "accepted", normalizedCapabilityRequirements: [
		{ text: html, source: { kind: "raw_request", start: rawRequest.indexOf(html), end: rawRequest.indexOf(html) + html.length } },
		{ text: pdf, source: { kind: "raw_request", start: rawRequest.indexOf(pdf), end: rawRequest.indexOf(pdf) + pdf.length } },
	] });
});

test("semantic adjudication treats generic progressive Skill and Tool loading as an execution constraint, not an outcome Capability", () => {
	const rawRequest = "请以任务目标为核心，动态、渐进式加载所需 Skill 和 Tool，必须调用 market_series 获取真实结构化行情";
	const workflow = "请以任务目标为核心，动态、渐进式加载所需 Skill 和 Tool";
	const market = "必须调用 market_series 获取真实结构化行情";
	const inventory = decode(rawRequest, {
		action: "create", confidence: 0.99,
		segments: [
			{ text: workflow, occurrence: 0, roles: ["objective", "constraint", "acceptance_criterion", "capability_requirement"] },
			{ text: market, occurrence: 0, roles: ["acceptance_criterion", "capability_requirement"] },
		],
	}, []);
	const result = adjudicateWorkContract({ contract: contract(rawRequest, {
		objectiveText: workflow,
		constraintTexts: [workflow],
		acceptanceTexts: [workflow, market],
		capabilityTexts: [workflow, market],
	}), inventory });
	assert.deepEqual(result, { kind: "accepted", normalizedCapabilityRequirements: [
		{ text: market, source: { kind: "raw_request", start: rawRequest.indexOf(market), end: rawRequest.indexOf(market) + market.length } },
	] });
});

test("semantic inventory cannot hide research and freshness scope as context", () => {
	const rawRequest = "自主调研截至 2026-07-17 的过去一周 XAU/USD 现货黄金走势";
	assert.throws(() => decode(rawRequest, {
		action: "create", confidence: 0.99,
		segments: [
			{ text: "自主调研截至 2026-07-17 的过去一周 ", occurrence: 0, roles: ["context"] },
			{ text: "XAU/USD 现货黄金走势", occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] },
		],
	}, []), /material operation or freshness scope.*context/i);
});

test("semantic inventory treats operation names inside a balanced Artifact manifest as context data", () => {
	const manifest = `{"schemaVersion":"beemax.artifact-manifest.v1","id":"artifact:sha256:${"a".repeat(64)}","locator":{"kind":"workspace","uri":"workspace:report.pdf"},"mediaType":"application/pdf","byteLength":1234,"sha256":"${"a".repeat(64)}","producer":{"providerId":"beemax.chrome-pdf","providerVersion":"1","operation":"render"},"sourceRefs":["workspace:report.html"],"createdAt":1234}`;
	const rawRequest = `使用 artifact_verify 只读复验 manifest=${manifest}`;
	assert.doesNotThrow(() => decode(rawRequest, {
		action: "create", confidence: 0.99,
		segments: [
			{ text: "使用 artifact_verify 只读复验", occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] },
			{ text: `manifest=${manifest}`, occurrence: 0, roles: ["context"] },
		],
	}, []));
});

test("semantic inventory cannot hide an operation inside arbitrary JSON context", () => {
	const payload = '{"instruction":"render"}';
	const rawRequest = `生成结果，payload=${payload}`;
	assert.throws(() => decode(rawRequest, {
		action: "create", confidence: 0.99,
		segments: [
			{ text: "生成结果", occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] },
			{ text: `payload=${payload}`, occurrence: 0, roles: ["context"] },
		],
	}, []), /material operation or freshness scope.*context/i);
});

test("semantic adjudication atomizes fused HTML delivery, PDF rendering, and artifact inspection while dropping a pure report-format capability", () => {
	const rawRequest = "生成中文专业报告，并在 Profile workspace 中交付 report.html 与 report.pdf。你必须真实检查 HTML 内容与渲染、PDF 存在性、完整性、可解析性和页面渲染，以及两份文件关键数字和来源一致性。";
	const delivery = "并在 Profile workspace 中交付 report.html 与 report.pdf";
	const inspection = "你必须真实检查 HTML 内容与渲染、PDF 存在性、完整性、可解析性和页面渲染，以及两份文件关键数字和来源一致性";
	const inventory = decode(rawRequest, {
		action: "create", confidence: 0.99,
		segments: [
			{ text: "生成中文专业报告", occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] },
			{ text: delivery, occurrence: 0, roles: ["acceptance_criterion", "capability_requirement"] },
			{ text: inspection, occurrence: 0, roles: ["acceptance_criterion", "capability_requirement"] },
		],
	}, []);
	const result = adjudicateWorkContract({ contract: contract(rawRequest, {
		objectiveText: "生成中文专业报告",
		acceptanceTexts: ["生成中文专业报告", delivery, inspection],
		capabilityTexts: [delivery, inspection],
	}), inventory });
	const expected = [
		"并在 Profile workspace 中交付 report.html",
		"report.pdf",
		"你必须真实检查 HTML 内容与渲染",
		"PDF 存在性、完整性、可解析性和页面渲染",
		"两份文件关键数字和来源一致性",
	];
	assert.deepEqual(result, { kind: "accepted", normalizedCapabilityRequirements: expected.map((text) => ({
		text,
		source: { kind: "raw_request", start: rawRequest.indexOf(text), end: rawRequest.indexOf(text) + text.length },
	})) });
});

test("semantic adjudication canonicalizes multi-part Objective and acceptance outcomes from the independent exact-span inventory", () => {
	const rawRequest = "调研黄金并生成报告";
	const inventory = decode(rawRequest, {
		action: "create", confidence: 0.99,
		segments: [
			{ text: "调研黄金", occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] },
			{ text: "并", occurrence: 0, roles: ["context"] },
			{ text: "生成报告", occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] },
		],
	}, []);
	const result = adjudicateWorkContract({ contract: contract(rawRequest, {
		objectiveText: "调研黄金",
		acceptanceTexts: ["调研黄金"],
		capabilityTexts: ["调研黄金"],
	}), inventory });
	assert.deepEqual(result, { kind: "accepted",
		normalizedObjective: { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } },
		normalizedAcceptanceCriteria: [
			{ text: "调研黄金", source: { kind: "raw_request", start: 0, end: 4 } },
			{ text: "生成报告", source: { kind: "raw_request", start: 5, end: 9 } },
		],
		normalizedCapabilityRequirements: [
			{ text: "调研黄金", source: { kind: "raw_request", start: 0, end: 4 } },
			{ text: "生成报告", source: { kind: "raw_request", start: 5, end: 9 } },
		],
	});
});

test("semantic adjudication retains one primary Capability nested in an independent observable outcome", () => {
	const rawRequest = "安排明天下午三点的会议";
	const inventory = decode(rawRequest, { action: "create", confidence: 0.9, segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion"] }] }, []);
	assert.deepEqual(adjudicateWorkContract({ contract: contract(rawRequest, { objectiveText: rawRequest, acceptanceTexts: [rawRequest], capabilityTexts: [rawRequest] }), inventory }), { kind: "accepted" });
});

test("semantic adjudication rejects multiple primary Capabilities when the independent inventory found no atomic obligations", () => {
	const rawRequest = "读取并保存报告";
	const inventory = decode(rawRequest, { action: "create", confidence: 0.9, segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion"] }] }, []);
	const result = adjudicateWorkContract({ contract: contract(rawRequest, { objectiveText: rawRequest, acceptanceTexts: [rawRequest], capabilityTexts: ["读取", "保存"] }), inventory });
	assert.equal(result.code, "CAPABILITY_REQUIREMENTS_NOT_ATOMIC");
});

test("semantic adjudication replaces fragmented modifier clauses with one independently inventoried atomic outcome", () => {
	const rawRequest = "联网检索最新公开证据";
	const inventory = decode(rawRequest, {
		action: "create", confidence: 0.99,
		segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] }],
	}, []);
	const result = adjudicateWorkContract({ contract: contract(rawRequest, {
		objectiveText: rawRequest,
		acceptanceTexts: [rawRequest],
		capabilityTexts: ["联网", "最新"],
	}), inventory });
	assert.deepEqual(result, { kind: "accepted", normalizedCapabilityRequirements: [
		{ text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } },
	] });
});

test("Pi Work Contract issues normalized atomic Capability requirements before routing", async () => {
	const rawRequest = "查询当前来源并归档结果";
	const complete = async (_candidate, context) => response(context.systemPrompt.includes("Independently inventory") ? {
		schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.99,
		segments: [
			{ text: "查询当前来源", occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] },
			{ text: "并", occurrence: 0, roles: ["context"] },
			{ text: "归档结果", occurrence: 0, roles: ["acceptance_criterion", "capability_requirement"] },
		],
	} : {
		action: "create", objective: { text: rawRequest }, constraints: [], prohibitions: [],
		acceptanceCriteria: [{ text: rawRequest }], capabilityRequirements: [{ text: rawRequest }],
		uncertainties: [], executionMode: "direct", confidence: 0.99,
	});
	const result = await new PiWorkContractBuilder({ models: [{ model: model("atomic") }], complete }).build({
		rawRequest,
		fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 0.9 },
	});
	assert.deepEqual(result.contract.capabilityRequirements.map(({ text }) => text), ["查询当前来源", "归档结果"]);
});

test("Pi Work Contract removes a prohibition misclassified as acceptance after independent exact-span review", async () => {
	const rawRequest = "生成报告，不要编造缺失数据";
	const complete = async (_candidate, context) => response(context.systemPrompt.includes("Independently inventory") ? {
		schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.99,
		segments: [
			{ text: "生成报告", occurrence: 0, roles: ["objective", "acceptance_criterion"] },
			{ text: "不要编造缺失数据", occurrence: 0, roles: ["prohibition"] },
		],
	} : {
		action: "create", objective: { text: "生成报告" }, constraints: [], prohibitions: [{ text: "不要编造缺失数据" }],
		acceptanceCriteria: [{ text: "生成报告" }, { text: "不要编造缺失数据" }], capabilityRequirements: [],
		uncertainties: [], executionMode: "direct", confidence: 0.99,
	});
	const result = await new PiWorkContractBuilder({ models: [{ model: model("negative-normalization") }], complete }).build({
		rawRequest,
		fallback: { action: "create", goal: "生成报告", constraints: ["不要编造缺失数据"], acceptanceCriteria: ["生成报告"], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 0.9 },
	});
	assert.deepEqual(result.contract.acceptanceCriteria.map(({ text }) => text), ["生成报告"]);
	assert.deepEqual(result.contract.prohibitions.map(({ text }) => text), ["不要编造缺失数据"]);
});

test("Pi Work Contract separates source HTML creation from derived PDF rendering", async () => {
	const rawRequest = "生成中文专业报告，并在 Profile workspace 中交付 gold-weekly-report.html 与 gold-weekly-report.pdf";
	const complete = async (_candidate, context) => response(context.systemPrompt.includes("Independently inventory") ? {
		schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.99,
		segments: [
			{ text: "生成中文专业报告", occurrence: 0, roles: ["objective", "constraint", "acceptance_criterion"] },
			{ text: "并在 Profile workspace 中", occurrence: 0, roles: ["constraint"] },
			{ text: "交付 gold-weekly-report.html", occurrence: 0, roles: ["acceptance_criterion", "capability_requirement"] },
			{ text: "与", occurrence: 0, roles: ["context"] },
			{ text: "gold-weekly-report.pdf", occurrence: 0, roles: ["acceptance_criterion", "capability_requirement"] },
		],
	} : {
		action: "create", objective: { text: rawRequest }, constraints: [{ text: "中文专业" }, { text: "Profile workspace" }], prohibitions: [],
		acceptanceCriteria: [{ text: rawRequest }], capabilityRequirements: [{ text: "交付 gold-weekly-report.html 与 gold-weekly-report.pdf" }],
		uncertainties: [], executionMode: "direct", confidence: 0.99,
	});
	const result = await new PiWorkContractBuilder({ models: [{ model: model("html-pdf-atomic") }], complete }).build({
		rawRequest,
		fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 0.9 },
	});
	assert.deepEqual(result.contract.capabilityRequirements.map(({ text }) => text), [
		"交付 gold-weekly-report.html",
		"gold-weekly-report.pdf",
	]);
});

test("Pi Work Contract source-binds exact string clause shorthand from a Provider", async () => {
	const rawRequest = "联网检索最新公开证据";
	const complete = async (_candidate, context) => response(context.systemPrompt.includes("Independently inventory")
		? { schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.9, segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] }] }
		: { action: "create", objective: [rawRequest], constraints: [], prohibitions: [], acceptanceCriteria: [rawRequest], capabilityRequirements: [rawRequest], uncertainties: [], executionMode: "direct", confidence: 0.9 });
	const result = await new PiWorkContractBuilder({ models: [{ model: model("string-clause") }], complete }).build({ rawRequest, fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 0.9 } });
	assert.equal(result.contract.objective.text, rawRequest);
	assert.deepEqual(result.contract.objective.source, { kind: "raw_request", start: 0, end: rawRequest.length });
});

test("Pi Work Contract retries one invalid exact-quote proposal when only one model is configured", async () => {
	const rawRequest = "生成中文专业报告";
	let contractSamples = 0;
	const complete = async (_candidate, context) => {
		if (context.systemPrompt.includes("Independently inventory")) return response({
			schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.9,
			segments: [
				{ text: "中文专业", occurrence: 0, roles: ["constraint"] },
				{ text: "生成", occurrence: 0, roles: ["objective", "acceptance_criterion"] },
				{ text: "报告", occurrence: 0, roles: ["objective", "acceptance_criterion"] },
			],
		});
		contractSamples++;
		return response({
			action: "create", objective: { text: "生成" },
			constraints: [{ text: contractSamples === 1 ? "专业中文" : "中文专业" }], prohibitions: [],
			acceptanceCriteria: [{ text: "生成" }, { text: "报告" }], capabilityRequirements: [], uncertainties: [],
			executionMode: "direct", confidence: 0.9,
		});
	};
	const result = await new PiWorkContractBuilder({ models: [{ model: model("single-invalid-quote") }], complete }).build({
		rawRequest,
		fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 0.9 },
	});
	assert.equal(contractSamples, 2);
	assert.deepEqual(result.contract.constraints.map(({ text }) => text), ["中文专业"]);
});

test("Pi Work Contract discards an invented clause shorthand and restores only independent exact-span capability evidence", async () => {
	const rawRequest = "联网检索并生成报告";
	let contractSamples = 0;
	const complete = async (_candidate, context) => {
		if (context.systemPrompt.includes("Independently inventory")) return response({
			schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.9,
			segments: [
				{ text: "联网检索", occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] },
				{ text: "并生成报告", occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] },
			],
		});
		contractSamples++;
		return response({
			action: "create", objective: { text: rawRequest }, constraints: [], prohibitions: [],
			acceptanceCriteria: [{ text: rawRequest }], capabilityRequirements: [{ text: "调用外部搜索" }], uncertainties: [],
			executionMode: "direct", confidence: 0.9,
		});
	};
	const result = await new PiWorkContractBuilder({ models: [{ model: model("single-invented-capability") }], complete }).build({
		rawRequest,
		fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 0.9 },
	});
	assert.equal(contractSamples, 1);
	assert.deepEqual(result.contract.capabilityRequirements.map(({ text, source }) => ({ text, source })), [
		{ text: "联网检索", source: { kind: "raw_request", start: 0, end: 4 } },
		{ text: "并生成报告", source: { kind: "raw_request", start: 4, end: rawRequest.length } },
	]);
});

test("Pi Work Contract lets independent occurrence evidence repair an ambiguous exact shorthand while an unreviewed builder rejects it", async () => {
	const rawRequest = "检查 PDF 并交付 PDF";
	const primary = { action: "create", objective: { text: rawRequest }, constraints: [], prohibitions: [], acceptanceCriteria: [{ text: rawRequest }], capabilityRequirements: [{ text: "PDF" }], uncertainties: [], executionMode: "direct", confidence: 0.9 };
	const complete = async (_candidate, context) => response(context.systemPrompt.includes("Independently inventory")
		? { schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.9, segments: [
			{ text: "检查 PDF", occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] },
			{ text: "并交付 PDF", occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] },
		] }
		: primary);
	const fallback = { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 0.9 };
	const result = await new PiWorkContractBuilder({ models: [{ model: model("ambiguous-reviewed") }], complete }).build({ rawRequest, fallback });
	assert.deepEqual(result.contract.capabilityRequirements.map(({ text, source }) => ({ text, source })), [
		{ text: "检查 PDF", source: { kind: "raw_request", start: 0, end: 6 } },
		{ text: "并交付 PDF", source: { kind: "raw_request", start: 7, end: rawRequest.length } },
	]);
	const unreviewed = new ModelBackedWorkContractBuilder(async () => primary);
	await assert.rejects(() => unreviewed.build({ rawRequest, fallback }), /ambiguous/i);
});

test("semantic adjudication relies on exact independent agreement rather than uncalibrated self-ratings", () => {
	const rawRequest = "生成报告";
	const inventory = decode(rawRequest, { action: "create", confidence: 0.59, segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion"] }] }, []);
	assert.equal(adjudicateWorkContract({ contract: contract(rawRequest, { confidence: 0.9 }), inventory, minimumConfidence: 0.6 }).kind, "accepted");
	assert.equal(adjudicateWorkContract({ contract: contract(rawRequest, { confidence: 0.59 }), inventory: { ...inventory, confidence: 0.9 }, minimumConfidence: 0.6 }).kind, "accepted");
	assert.equal(adjudicateWorkContract({ contract: contract(rawRequest, { confidence: 0.1 }), inventory: { ...inventory, confidence: 0.1 }, minimumConfidence: 0.6 }).kind, "accepted");
});

test("occurrence resolution distinguishes repeated phrases and rejects a missing occurrence", () => {
	assert.deepEqual(resolveSemanticOccurrence("保存草稿，然后再次保存草稿", "保存草稿", 1), { start: 9, end: 13 });
	assert.throws(() => resolveSemanticOccurrence("保存草稿", "保存草稿", 1), /occurrence/i);
});

test("Semantic Inventory decoding repairs a wrong occurrence only for a unique exact quote", () => {
	const unique = decode("生成报告", { action: "create", confidence: 1, segments: [{ text: "生成报告", occurrence: 1, roles: ["objective", "acceptance_criterion"] }] }, []);
	assert.deepEqual(unique.segments.map(({ text, occurrence, start, end }) => ({ text, occurrence, start, end })), [
		{ text: "生成报告", occurrence: 0, start: 0, end: 4 },
	]);
	assert.throws(() => decode("保存草稿，然后再次保存草稿", { action: "create", confidence: 1, segments: [{ text: "保存草稿", occurrence: 2, roles: ["objective", "acceptance_criterion"] }] }, []), /occurrence/i);
});

test("semantic inventory decoder source-orders and atomizes compatible exact segments while rejecting contradictory roles", () => {
	const ordered = decode("甲乙", { action: "create", confidence: 1, segments: [{ text: "乙", occurrence: 0, roles: ["context"] }, { text: "甲", occurrence: 0, roles: ["objective", "acceptance_criterion"] }] }, []);
	assert.deepEqual(ordered.segments.map(({ text }) => text), ["甲", "乙"]);
	const atomized = decode("甲乙", { action: "create", confidence: 1, segments: [{ text: "甲乙", occurrence: 0, roles: ["objective", "acceptance_criterion"] }, { text: "乙", occurrence: 0, roles: ["context"] }] }, []);
	assert.deepEqual(atomized.segments.map(({ text, roles }) => ({ text, roles })), [
		{ text: "甲", roles: ["objective", "acceptance_criterion"] },
		{ text: "乙", roles: ["objective", "acceptance_criterion", "context"] },
	]);
	assert.throws(() => decode("不要发布", { action: "create", confidence: 1, segments: [{ text: "不要发布", occurrence: 0, roles: ["objective", "prohibition"] }, { text: "发布", occurrence: 0, roles: ["acceptance_criterion", "capability_requirement"] }] }, []), /prohibition.*capability/i);
	assert.throws(() => decode("继续", { action: "continue", targetObjectiveId: "missing", confidence: 1, segments: [{ text: "继续", occurrence: 0, roles: ["objective"] }] }), /active Objective/i);
	assert.throws(() => decode("生成", { action: "create", confidence: 1, segments: [{ text: "生成", occurrence: 0, roles: [] }] }, []), /roles/i);
	assert.throws(() => decode("生成", { action: "create", confidence: 2, segments: [{ text: "生成", occurrence: 0, roles: ["objective"] }] }, []), /confidence/i);
	assert.deepEqual(decode("不要回忆", { action: "query", confidence: 1, segments: [{ text: "不要回忆", occurrence: 0, roles: ["objective", "prohibition", "capability_requirement"] }] }, []).segments[0].roles, ["objective", "prohibition"]);
});

test("semantic inventory normalizes an explicit negative rule that the model also labeled as acceptance", () => {
	const text = "任何 401、403、空正文或漏抓均拒绝";
	const inventory = decode(text, { action: "query", confidence: 1, segments: [{ text, occurrence: 0, roles: ["objective", "prohibition", "acceptance_criterion"] }] }, []);
	assert.deepEqual(inventory.segments[0].roles, ["objective", "prohibition"]);
});

test("semantic inventory uses the trusted create fallback when a model targets a nonexistent lifecycle", () => {
	const text = "这是新任务，不是继续任何活动 Objective";
	const inventory = decodeSemanticInventory({
		schemaVersion: "beemax.semantic-inventory.v1",
		action: "correct",
		confidence: 1,
		segments: [{ text, occurrence: 0, roles: ["objective", "acceptance_criterion"] }],
	}, { rawRequest: text, activeObjectives: [], fallbackAction: "create" });
	assert.equal(inventory.action, "create");
});

test("semantic inventory decoder rejects uncovered meaningful Raw Request spans and invented text", () => {
	assert.throws(() => decode("生成报告，不要发布", { action: "create", confidence: 1, segments: [{ text: "生成报告", occurrence: 0, roles: ["objective"] }] }, []), /coverage/i);
	assert.throws(() => decode("生成报告", { action: "create", confidence: 1, segments: [{ text: "删除报告", occurrence: 0, roles: ["objective"] }] }, []), /occurrence/i);
});

test("semantic inventory cannot make adjudication vacuous by classifying the whole request as context", () => {
	assert.throws(() => decode("不要取消市场分析，取消周报", {
		action: "cancel", targetObjectiveId: "report", confidence: 0.99,
		segments: [{ text: "不要取消市场分析，取消周报", occurrence: 0, roles: ["context"] }],
	}), /material Objective/i);
	assert.throws(() => decode("生成报告", {
		action: "create", confidence: 0.99,
		segments: [{ text: "生成报告", occurrence: 0, roles: ["objective"] }],
	}, []), /acceptance criterion/i);
});

test("Pi Work Contract cognition falls back on invalid schema while retaining an independent reviewer", async () => {
	const rawRequest = "不要取消市场分析，取消周报";
	const models = [model("a"), model("b")];
	const calls = [];
	const complete = async (candidate, context) => {
		const inventory = context.systemPrompt.includes("Independently inventory");
		calls.push(`${candidate.id}:${inventory ? "inventory" : "contract"}`);
		if (!inventory && candidate.id === "a") return response({ invalid: true });
		return response(inventory ? {
			schemaVersion: "beemax.semantic-inventory.v1", action: "cancel", targetObjectiveId: "report", confidence: 0.99,
			segments: [{ text: "不要取消市场分析", occurrence: 0, roles: ["prohibition"] }, { text: "取消周报", occurrence: 0, roles: ["objective"] }],
		} : {
			action: "cancel", targetObjectiveId: "report", objective: { text: "取消周报" }, constraints: [], prohibitions: [{ text: "不要取消市场分析" }],
			acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99,
		});
	};
	const result = await new PiWorkContractBuilder({ models: models.map((candidate) => ({ model: candidate })), complete }).build({
		rawRequest, fallback: { action: "query", goal: rawRequest, constraints: [], acceptanceCriteria: [], memoryQuery: rawRequest, capabilityQuery: "", executionMode: "direct", confidence: 0.5 },
		activeObjectives,
	});
	assert.equal(result.contract.action, "cancel");
	assert.equal(result.cognitionUsage.inputTokens, 4);
	assert.equal(result.cognitionUsage.outputTokens, 4);
	assert.equal(result.cognitionUsage.modelIdentities.length, 4);
	assert.ok(calls.includes("a:contract") && calls.includes("b:contract"), "invalid primary schema must use the next Provider");
	assert.ok(calls.includes("a:inventory") && calls.includes("b:inventory"), "same-model convergence must trigger an independent reviewer");
});

test("Pi Work Contract retries one truncated JSON sample at the Provider's full structured-output allowance", async () => {
	const rawRequest = "调研最近五个交易日黄金走势并生成 HTML 和 PDF";
	const calls = [];
	const contractMaxTokens = [];
	let contractAttempts = 0;
	const complete = async (_candidate, context, options) => {
		const inventory = context.systemPrompt.includes("Independently inventory");
		calls.push(inventory ? "inventory" : "contract");
		if (!inventory) contractMaxTokens.push(options.maxTokens);
		if (!inventory && contractAttempts++ === 0) return rawResponse('{"action":"create","objective":{"text":"调研最近五个交易日黄金走势并生成 HTML', "stop");
		return response(inventory ? {
			schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.99,
			segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] }],
		} : {
			action: "create", objective: { text: rawRequest }, constraints: [], prohibitions: [], acceptanceCriteria: [{ text: rawRequest }],
			capabilityRequirements: [{ text: rawRequest }], uncertainties: [], executionMode: "direct", confidence: 0.99,
		});
	};
	const result = await new PiWorkContractBuilder({ models: [{ model: { ...model("single"), maxTokens: 32_768 } }], maxTokens: 32_768, complete }).build({
		rawRequest,
		fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 0.9 },
	});
	assert.equal(result.contract.objective.text, rawRequest);
	assert.deepEqual(calls, ["contract", "inventory", "contract"]);
	assert.deepEqual(contractMaxTokens, [32_768, 32_768], "admission must use the Provider's available structured-output allowance from the first sample");
});

test("Pi Work Contract labels a repeatedly truncated lane and fails closed", async () => {
	const rawRequest = "调研黄金并生成报告";
	const complete = async (_candidate, context) => context.systemPrompt.includes("Independently inventory")
		? response({ schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.99, segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] }] })
		: rawResponse('{"action":"create","objective":{"text":"调研黄金', "stop");
	await assert.rejects(new PiWorkContractBuilder({ models: [{ model: { ...model("single"), maxTokens: 32_768 } }], maxTokens: 32_768, complete }).build({
		rawRequest,
		fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 0.9 },
	}), /Work Contract model returned JSON truncated at EOF.*32768-token/iu);
});

test("Pi Work Contract cognition combines independently corroborated confidence", async () => {
	const rawRequest = "联网检索最新公开证据";
	const models = [model("low"), model("high")];
	const calls = [];
	const prompts = [];
	const complete = async (candidate, context) => {
		const inventory = context.systemPrompt.includes("Independently inventory");
		calls.push(`${candidate.id}:${inventory ? "inventory" : "contract"}`);
		if (!inventory) prompts.push(context.systemPrompt);
		if (inventory) return response({ schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.55, segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] }] });
		return response({ action: "create", objective: { text: rawRequest }, constraints: [], prohibitions: [], acceptanceCriteria: [{ text: rawRequest }], capabilityRequirements: [{ text: rawRequest }], uncertainties: [], executionMode: "direct", confidence: candidate.id === "low" ? 0.55 : 0.95 });
	};
	const result = await new PiWorkContractBuilder({ models: models.map((candidate) => ({ model: candidate })), complete }).build({
		rawRequest, fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 0.9 },
	});
	assert.equal(result.contract.confidence, 0.6);
	assert.ok(calls.includes("low:contract") && !calls.includes("high:contract"));
	assert.equal(prompts.length, 1);
});

test("Pi Work Contract extraction and independent inventory disable extended Provider thinking", async () => {
	const rawRequest = "联网检索最新公开证据";
	const reasoning = [];
	const complete = async (_candidate, context, options) => {
		reasoning.push(options.reasoning);
		return response(context.systemPrompt.includes("Independently inventory") ? {
			schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.99,
			segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] }],
		} : {
			action: "create", objective: { text: rawRequest }, constraints: [], prohibitions: [], acceptanceCriteria: [{ text: rawRequest }],
			capabilityRequirements: [{ text: rawRequest }], uncertainties: [], executionMode: "direct", confidence: 0.99,
		});
	};
	await new PiWorkContractBuilder({ models: [{ model: model("reasoning-off") }], complete }).build({
		rawRequest, fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 0.9 },
	});
	assert.deepEqual(reasoning, [undefined, undefined]);
});

test("Pi Work Contract inventory compiler admits one complete model sample without a second model call", async () => {
	const rawRequest = "联网检索最新公开证据";
	let calls = 0;
	const result = await new PiWorkContractBuilder({
		models: [{ model: model("single-inventory") }],
		topology: "inventory_compiler",
		complete: async (_candidate, context, options) => {
			calls++;
			assert.match(context.systemPrompt, /Independently inventory/);
			assert.equal(options.reasoning, undefined);
			return response({
				schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.99,
				segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] }],
			});
		},
	}).build({
		rawRequest,
		fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 0.9 },
	});
	assert.equal(calls, 1);
	assert.equal(result.contract.objective.text, rawRequest);
	assert.deepEqual(result.contract.capabilityRequirements.map(({ text }) => text), [rawRequest]);
	assert.equal(result.semanticAdjudication.reviewMode, "inventory_with_deterministic_compiler");
	assert.equal(result.semanticAdjudication.independentSamples, false);
	assert.equal(result.semanticAdjudication.reviewerModelIdentity, "beemax/deterministic-semantic-inventory-compiler/v1");
	assert.equal(hasSemanticWorkContractAdjudication(result), true);
});

test("inventory compilation restores explicit source creation and derived render boundaries omitted by the model", async () => {
	const rawRequest = "生成专业中文 HTML 和由该 HTML 渲染的 PDF，分别保存为 report.html 和 report.pdf。";
	const result = await new PiWorkContractBuilder({
		models: [{ model: model("artifact-boundaries") }],
		topology: "inventory_compiler",
		complete: async () => response({
			schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.99,
			segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion"] }],
		}),
	}).build({
		rawRequest,
		fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 0.9 },
	});
	assert.deepEqual(result.contract.capabilityRequirements.map(({ text }) => text), ["由该 HTML 渲染的 PDF", "保存为 report.html"]);
});

test("inventory compilation restores a causative corrected-HTML to PDF render boundary omitted by the model", async () => {
	const rawRequest = "把修正后的 HTML 渲染为 report.pdf。";
	const result = await new PiWorkContractBuilder({
		models: [{ model: model("causative-artifact-boundary") }],
		topology: "inventory_compiler",
		complete: async () => response({
			schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.99,
			segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion"] }],
		}),
	}).build({
		rawRequest,
		fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 0.9 },
	});
	assert.deepEqual(result.contract.capabilityRequirements.map(({ text }) => text), ["把修正后的 HTML 渲染为 report.pdf"]);
});

test("inventory compilation deduplicates the model render boundary and its punctuation-trimmed deterministic restoration", async () => {
	const rawRequest = "把修正后的 HTML 渲染为 report.pdf。";
	const result = await new PiWorkContractBuilder({
		models: [{ model: model("deduplicated-render-boundary") }],
		topology: "inventory_compiler",
		complete: async () => response({
			schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.99,
			segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] }],
		}),
	}).build({
		rawRequest,
		fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 0.9 },
	});
	assert.deepEqual(result.contract.capabilityRequirements.map(({ text }) => text), ["把修正后的 HTML 渲染为 report.pdf"]);
});

test("inventory compilation restores an explicit public-source cross-check boundary misclassified as a constraint", async () => {
	const rawRequest = "研究黄金走势，并至少使用两个相互独立、公开可访问的真实来源交叉验证。";
	const result = await new PiWorkContractBuilder({
		models: [{ model: model("public-source-boundary") }],
		topology: "inventory_compiler",
		complete: async () => response({
			schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.99,
			segments: [
				{ text: "研究黄金走势", occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] },
				{ text: "，", occurrence: 0, roles: ["context"] },
				{ text: "并至少使用两个相互独立、公开可访问的真实来源交叉验证。", occurrence: 0, roles: ["constraint", "acceptance_criterion"] },
			],
		}),
	}).build({
		rawRequest,
		fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 0.9 },
	});
	assert.deepEqual(result.contract.capabilityRequirements.map(({ text }) => text), [
		"研究黄金走势",
		"使用两个相互独立、公开可访问的真实来源交叉验证",
	]);
});

test("Pi Work Contract performs one bounded contract repair from an independent semantic disagreement", async () => {
	const rawRequest = "使用中文生成报告";
	const calls = [];
	const complete = async (_candidate, context) => {
		const inventory = context.systemPrompt.includes("Independently inventory");
		const repair = context.systemPrompt.includes("Independent semantic review blocked");
		calls.push(inventory ? "inventory" : repair ? "repair" : "contract");
		if (inventory) return response({ schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.95, segments: [
			{ text: "使用中文", occurrence: 0, roles: ["constraint"] },
			{ text: "生成报告", occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] },
		] });
		return response({ action: "create", objective: { text: repair ? "生成报告" : rawRequest }, constraints: repair ? [{ text: "使用中文" }] : [], prohibitions: [], acceptanceCriteria: [{ text: repair ? "生成报告" : rawRequest }], capabilityRequirements: [{ text: "生成报告" }], uncertainties: [], executionMode: "direct", confidence: 0.95 });
	};
	const result = await new PiWorkContractBuilder({ models: [{ model: model("primary") }, { model: model("reviewer") }], complete }).build({
		rawRequest, fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 0.9 },
	});
	assert.deepEqual(result.contract.constraints.map(({ text }) => text), ["使用中文"]);
	assert.deepEqual(calls, ["contract", "inventory", "repair"]);
});

test("Pi Work Contract additively restores an exact prohibition when the bounded model repair still omits it", async () => {
	const rawRequest = "生成报告，不需要我中途参与";
	const prohibition = "不需要我中途参与";
	const calls = [];
	const complete = async (_candidate, context) => {
		const inventory = context.systemPrompt.includes("Independently inventory");
		const repair = context.systemPrompt.includes("Independent semantic review blocked");
		calls.push(inventory ? "inventory" : repair ? "repair" : "contract");
		if (inventory) return response({ schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.99, segments: [
			{ text: "生成报告", occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] },
			{ text: prohibition, occurrence: 0, roles: ["prohibition"] },
		] });
		return response({
			action: "create", objective: { text: "生成报告" }, constraints: [], prohibitions: [],
			acceptanceCriteria: [{ text: "生成报告" }], capabilityRequirements: [{ text: "生成报告" }],
			uncertainties: [], executionMode: "direct", confidence: 0.99,
		});
	};
	const result = await new PiWorkContractBuilder({ models: [{ model: model("primary") }], complete }).build({
		rawRequest,
		fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: ["生成报告"], memoryQuery: rawRequest, capabilityQuery: "生成报告", executionMode: "direct", confidence: 0.9 },
	});
	assert.deepEqual(result.contract.prohibitions, [{
		text: prohibition,
		source: { kind: "raw_request", start: rawRequest.indexOf(prohibition), end: rawRequest.length },
	}]);
	assert.deepEqual(calls, ["contract", "inventory", "repair"]);
});

test("Work Contract repair falls back to a separate reviewer sample after malformed alternate-model repair", async () => {
	const rawRequest = "使用中文生成报告";
	const calls = [];
	const complete = async (candidate, context) => {
		const inventory = context.systemPrompt.includes("Independently inventory");
		const repair = context.systemPrompt.includes("Independent semantic review blocked");
		calls.push(`${candidate.id}:${inventory ? "inventory" : repair ? "repair" : "contract"}`);
		if (inventory) return response({ schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.95, segments: [
			{ text: "使用中文", occurrence: 0, roles: ["constraint"] },
			{ text: "生成报告", occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] },
		] });
		if (repair && candidate.id === "primary") return response({ invalid: true });
		return response({ action: "create", objective: { text: "生成报告" }, constraints: repair ? [{ text: "使用中文" }] : [], prohibitions: [], acceptanceCriteria: [{ text: "生成报告" }], capabilityRequirements: [{ text: "生成报告" }], uncertainties: [], executionMode: "direct", confidence: 0.95 });
	};
	const result = await new PiWorkContractBuilder({ models: [{ model: model("primary") }, { model: model("reviewer") }], complete }).build({ rawRequest, fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 0.9 } });
	assert.deepEqual(result.contract.constraints.map(({ text }) => text), ["使用中文"]);
	assert.ok(calls.includes("primary:repair") && calls.includes("reviewer:repair"));
});

test("Pi Work Contract cognition aborts its sibling request when one lane fails closed", async () => {
	let reviewerAborted = false;
	const complete = async (_candidate, context, options) => {
		if (!context.systemPrompt.includes("Independently inventory")) return response({ invalid: true });
		return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => { reviewerAborted = true; reject(options.signal.reason); }, { once: true }));
	};
	const builder = new PiWorkContractBuilder({ models: [{ model: model("only") }], complete, timeoutMs: 1_000 });
	await assert.rejects(builder.build({ rawRequest: "生成报告", fallback: { action: "create", goal: "生成报告", constraints: [], acceptanceCriteria: ["生成报告"], memoryQuery: "生成报告", capabilityQuery: "", executionMode: "direct", confidence: 0.9 } }), /Work Contract/i);
	assert.equal(reviewerAborted, true);
});

test("Pi Work Contract cognition never propagates malformed Provider usage into execution budgets", async () => {
	const rawRequest = "生成报告";
	const complete = async (_candidate, context) => {
		const value = context.systemPrompt.includes("Independently inventory")
			? { schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.99, segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion"] }] }
			: { action: "create", objective: { text: rawRequest }, constraints: [], prohibitions: [], acceptanceCriteria: [{ text: rawRequest }], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99 };
		return { ...response(value), usage: { input: Number.NaN, output: Number.POSITIVE_INFINITY, cacheRead: -1, cacheWrite: Number.NaN, totalTokens: Number.NaN, cost: { total: Number.NaN } } };
	};
	const result = await new PiWorkContractBuilder({ models: [{ model: model("only") }], complete }).build({
		rawRequest, fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: "", executionMode: "direct", confidence: 0.9 },
	});
	assert.deepEqual(result.cognitionUsage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, modelIdentities: ["test/only/test", "test/only/test"] });
	assert.ok(result.cognitionBudgetChargeTokens >= 3_072, "the hard budget charge must retain at least both reserved completion allowances");
	assert.equal(result.semanticAdjudication.reviewMode, "same_model_independent_samples");
	assert.equal(result.semanticAdjudication.cognitionBudgetChargeTokens, result.cognitionBudgetChargeTokens);
	assert.equal(hasSemanticWorkContractAdjudication(result), true);
});

test("Pi Work Contract never invokes a Provider when dynamic Profile credentials are empty", async () => {
	const previous = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = "process-global-key-that-must-not-be-used";
	let completeCalls = 0;
	try {
		const openaiModel = (id) => ({ ...model(id), provider: "openai", api: "openai-responses" });
		const builder = new PiWorkContractBuilder({
			models: [
				{ model: openaiModel("undefined-credential"), getApiKey: async () => undefined },
				{ model: openaiModel("blank-credential"), getApiKey: async () => "  " },
			],
			complete: async () => { completeCalls++; return response({ invalid: true }); },
		});
		await assert.rejects(builder.build({
			rawRequest: "生成报告",
			fallback: { action: "create", goal: "生成报告", constraints: [], acceptanceCriteria: ["生成报告"], memoryQuery: "生成报告", capabilityQuery: "", executionMode: "direct", confidence: 0.9 },
		}), /credential.*unavailable/i);
		assert.equal(completeCalls, 0, "an absent Profile credential must not reach Pi's environment fallback");
	} finally {
		if (previous === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previous;
	}
});

test("Pi Work Contract resolves OAuth credentials for every Provider attempt", async () => {
	const rawRequest = "生成报告";
	let credentialReads = 0;
	const apiKeys = [];
	const complete = async (_candidate, context, options) => {
		apiKeys.push(options.apiKey);
		return response(context.systemPrompt.includes("Independently inventory")
			? { schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.99, segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion"] }] }
			: { action: "create", objective: { text: rawRequest }, constraints: [], prohibitions: [], acceptanceCriteria: [{ text: rawRequest }], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99 });
	};
	await new PiWorkContractBuilder({ models: [{ model: model("only"), getApiKey: async () => `oauth-${++credentialReads}` }], complete }).build({
		rawRequest, fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: "", executionMode: "direct", confidence: 0.9 },
	});
	assert.equal(credentialReads, 2);
	assert.deepEqual(apiKeys.sort(), ["oauth-1", "oauth-2"]);
});

test("Pi Work Contract prefers an explicit API key and does not resolve credentials after abort", async () => {
	let credentialReads = 0;
	const apiKeys = [];
	const complete = async (_candidate, context, options) => {
		apiKeys.push(options.apiKey);
		return response(context.systemPrompt.includes("Independently inventory")
		? { schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.99, segments: [{ text: "生成报告", occurrence: 0, roles: ["objective", "acceptance_criterion"] }] }
		: { action: "create", objective: { text: "生成报告" }, constraints: [], prohibitions: [], acceptanceCriteria: [{ text: "生成报告" }], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99 });
	};
	const fallback = { action: "create", goal: "生成报告", constraints: [], acceptanceCriteria: ["生成报告"], memoryQuery: "生成报告", capabilityQuery: "", executionMode: "direct", confidence: 0.9 };
	await new PiWorkContractBuilder({ models: [{ model: model("only"), apiKey: "static", getApiKey: async () => `oauth-${++credentialReads}` }], complete }).build({ rawRequest: "生成报告", fallback });
	assert.equal(credentialReads, 0);
	assert.deepEqual(apiKeys, ["static", "static"]);

	const controller = new AbortController();
	controller.abort(new Error("cancelled before cognition"));
	await assert.rejects(new PiWorkContractBuilder({ models: [{ model: model("only"), getApiKey: async () => `oauth-${++credentialReads}` }], complete }).build({ rawRequest: "生成报告", fallback, signal: controller.signal }), /cancelled before cognition/i);
	assert.equal(credentialReads, 0);
});

test("semantic adjudication evidence rejects contradictory identity topology and missing usage", () => {
	const rawRequest = "生成报告";
	const base = {
		source: "model", cognitionBudgetChargeTokens: 1, contract: contract(rawRequest, { objectiveText: rawRequest, acceptanceTexts: [rawRequest] }),
		semanticAdjudication: {
			schemaVersion: "beemax.work-contract-adjudication.v1", inventorySchemaVersion: "beemax.semantic-inventory.v1",
			primaryModelIdentity: "test/only/test", reviewerModelIdentity: "test/only/test", reviewMode: "different_models", independentSamples: true,
			cognitionUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, modelIdentities: ["test/only/test", "test/only/test"] }, cognitionBudgetChargeTokens: 1,
		},
	};
	assert.equal(hasSemanticWorkContractAdjudication(base), false);
	assert.equal(hasSemanticWorkContractAdjudication({ ...base, semanticAdjudication: { ...base.semanticAdjudication, reviewMode: "same_model_independent_samples", cognitionUsage: undefined } }), false);
});

test("Pi Work Contract deadline settles even when a Provider ignores AbortSignal", async () => {
	const never = new Promise(() => undefined);
	const complete = async (_candidate, context) => context.systemPrompt.includes("Independently inventory") ? never : response({ invalid: true });
	const builder = new PiWorkContractBuilder({ models: [{ model: model("only") }], complete, timeoutMs: 1_000 });
	const startedAt = Date.now();
	await assert.rejects(builder.build({ rawRequest: "生成报告", fallback: { action: "create", goal: "生成报告", constraints: [], acceptanceCriteria: ["生成报告"], memoryQuery: "生成报告", capabilityQuery: "", executionMode: "direct", confidence: 0.9 } }), /Work Contract/i);
	assert.ok(Date.now() - startedAt < 500, "a sibling Provider that ignores cancellation must not hold the Turn open");
});

test("Pi Work Contract retries a stalled Provider attempt without imposing an aggregate cognition deadline", async () => {
	const rawRequest = "生成报告";
	let calls = 0;
	let abortedAttempts = 0;
	const complete = async (_candidate, _context, options) => {
		calls++;
		if (calls === 1) {
			return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => {
				abortedAttempts++;
				reject(options.signal.reason);
			}, { once: true }));
		}
		return response({
			schemaVersion: "beemax.semantic-inventory.v1",
			action: "create",
			confidence: 0.99,
			segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion"] }],
		});
	};
	const builder = new PiWorkContractBuilder({
		models: [{ model: model("only") }],
		complete,
		topology: "inventory_compiler",
		attemptTimeoutMs: 20,
	});
	const startedAt = Date.now();
	const result = await builder.build({
		rawRequest,
		fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: "", executionMode: "direct", confidence: 0.9 },
	});
	assert.equal(result.contract.objective.text, rawRequest);
	assert.equal(calls, 2);
	assert.equal(abortedAttempts, 1);
	assert.ok(Date.now() - startedAt < 500, "one stalled Provider attempt must be cancelled before retrying");
});

test("Pi Work Contract reserves the shared cognition budget before calling a Provider", async () => {
	let calls = 0;
	const builder = new PiWorkContractBuilder({ models: [{ model: model("only") }], complete: async () => { calls++; return response({ invalid: true }); } });
	await assert.rejects(builder.build({ rawRequest: "生成报告", maxCognitionTokens: 1, fallback: { action: "create", goal: "生成报告", constraints: [], acceptanceCriteria: ["生成报告"], memoryQuery: "生成报告", capabilityQuery: "", executionMode: "direct", confidence: 0.9 } }), /shared token budget/i);
	assert.equal(calls, 0);
});

test("Pi Work Contract reserves both mandatory lanes before starting either Provider", async () => {
	const calls = [];
	const rawRequest = "生成报告";
	const firstLaneBudget = Buffer.byteLength(WORK_CONTRACT_SYSTEM_PROMPT, "utf8")
		+ Buffer.byteLength(JSON.stringify({ rawRequest }), "utf8") + 160 + 1_536;
	const builder = new PiWorkContractBuilder({ models: [{ model: model("only") }], maxTokens: 1_536, complete: async (candidate, context) => { calls.push(`${candidate.id}:${context.systemPrompt.includes("Independently inventory") ? "inventory" : "contract"}`); return response({ invalid: true }); } });
	await assert.rejects(builder.build({ rawRequest, maxCognitionTokens: firstLaneBudget, fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: "", executionMode: "direct", confidence: 0.9 } }), /Semantic Inventory cognition would exceed/i);
	assert.deepEqual(calls, []);
});

test("Pi Work Contract reserves chat framing beyond raw UTF-8 content before calling a Provider", async () => {
	const rawRequest = "生成报告";
	const payload = JSON.stringify({ rawRequest });
	const outputTokensPerLane = 256;
	const rawContentOnlyBudget = Buffer.byteLength(WORK_CONTRACT_SYSTEM_PROMPT, "utf8") + Buffer.byteLength(payload, "utf8") + outputTokensPerLane
		+ Buffer.byteLength(SEMANTIC_INVENTORY_SYSTEM_PROMPT, "utf8") + Buffer.byteLength(payload, "utf8") + outputTokensPerLane;
	let calls = 0;
	const builder = new PiWorkContractBuilder({ models: [{ model: model("only") }], maxTokens: outputTokensPerLane, complete: async () => { calls++; return response({ invalid: true }); } });
	await assert.rejects(builder.build({ rawRequest, maxCognitionTokens: rawContentOnlyBudget, fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: "", executionMode: "direct", confidence: 0.9 } }), /cognition would exceed the shared token budget/i);
	assert.equal(calls, 0);
});

test("Pi Work Contract sends all one hundred long Objectives to both semantic lanes without an execution-envelope cognition cap", async () => {
	const targetIndex = 73;
	const targetMarker = "玄穹迁移计划第七十三阶段";
	const objectives = Array.from({ length: 100 }, (_, index) => ({
		id: `objective:${index}:${"ledger-identity-".repeat(3)}`,
		title: `${"跨区域多团队协同执行与持续验证".repeat(5)}${index === targetIndex ? targetMarker : `常规维护阶段${index}`}${"保留审计证据并等待最终确认".repeat(5)}`,
	}));
	for (const scenario of [
		{ action: "cancel", rawRequest: `取消${targetMarker}` },
		{ action: "correct", rawRequest: `将${targetMarker}修正为仅保留验证草稿` },
	]) {
		const calls = [];
		const complete = async (_candidate, context) => {
			const inventory = context.systemPrompt.includes("Independently inventory");
			const payload = JSON.parse(context.messages[0].content);
			const target = payload.activeObjectives.find(({ title }) => title.includes(targetMarker));
			assert.ok(target, "the explicitly referenced target must be present in the complete Objective catalog");
			assert.deepEqual(payload.activeObjectives, objectives);
			calls.push({ inventory, candidateCount: payload.activeObjectives.length });
			return response(inventory ? {
				schemaVersion: "beemax.semantic-inventory.v1", action: scenario.action, targetObjectiveId: target.id, confidence: 0.99,
				segments: [{ text: scenario.rawRequest, occurrence: 0, roles: scenario.action === "correct" ? ["objective", "acceptance_criterion"] : ["objective"] }],
			} : {
				action: scenario.action, targetObjectiveId: target.id, objective: { text: scenario.rawRequest }, constraints: [], prohibitions: [],
				acceptanceCriteria: scenario.action === "correct" ? [{ text: scenario.rawRequest }] : [], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99,
			});
		};
		const result = await new PiWorkContractBuilder({ models: [{ model: model("only") }], complete }).build({
			rawRequest: scenario.rawRequest,
			fallback: { action: scenario.action, goal: scenario.rawRequest, constraints: [], acceptanceCriteria: scenario.action === "correct" ? [scenario.rawRequest] : [], memoryQuery: scenario.rawRequest, capabilityQuery: "", executionMode: "direct", confidence: 0.9 },
			activeObjectives: objectives,
		});
		assert.equal(result.contract.targetObjective.id, objectives[targetIndex].id);
		assert.equal(calls.length, 2);
		assert.ok(calls.every(({ candidateCount }) => candidateCount === objectives.length));
	}
});

test("failed Work Contract cognition retains measured usage and cost evidence", async () => {
	const complete = async () => ({ ...response({ invalid: true }), usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14, cost: { total: 0.25 } } });
	const builder = new PiWorkContractBuilder({ models: [{ model: model("only") }], complete });
	const error = await builder.build({ rawRequest: "生成报告", fallback: { action: "create", goal: "生成报告", constraints: [], acceptanceCriteria: ["生成报告"], memoryQuery: "生成报告", capabilityQuery: "", executionMode: "direct", confidence: 0.9 } }).then(() => assert.fail("invalid cognition must fail"), (cause) => cause);
	assert.ok(error instanceof WorkContractCognitionError);
	assert.deepEqual(error.cognitionUsage, { inputTokens: 8, outputTokens: 12, cacheReadTokens: 16, cacheWriteTokens: 20, costUsd: 1, modelIdentities: ["test/only/test", "test/only/test", "test/only/test", "test/only/test"] });
	assert.ok(error.cognitionBudgetChargeTokens >= 3_072);
});

function decode(rawRequest, value, candidates = activeObjectives) {
	return decodeSemanticInventory({ schemaVersion: "beemax.semantic-inventory.v1", ...value }, { rawRequest, activeObjectives: candidates });
}

function contract(rawRequest, options = {}) {
	const action = options.action ?? "create";
	const objectiveText = options.objectiveText ?? rawRequest;
	return {
		schemaVersion: "beemax.work-contract.v1", rawRequest, action,
		...(options.targetObjectiveId ? { targetObjective: { kind: "active_objective", id: options.targetObjectiveId } } : {}),
		objective: clause(rawRequest, objectiveText),
		constraints: (options.constraintTexts ?? []).map((text) => clause(rawRequest, text)),
		prohibitions: (options.prohibitionTexts ?? []).map((text) => clause(rawRequest, text)),
		acceptanceCriteria: (options.acceptanceTexts ?? []).map((text) => clause(rawRequest, text)),
		capabilityRequirements: (options.capabilityTexts ?? []).map((text) => clause(rawRequest, text)),
		uncertainties: (options.uncertaintyTexts ?? []).map((text) => clause(rawRequest, text)),
		executionMode: "direct", confidence: options.confidence ?? 0.9,
	};
}

function clause(rawRequest, text) {
	const start = rawRequest.indexOf(text);
	return { text, source: { kind: "raw_request", start, end: start + text.length } };
}

function model(id) { return { id, provider: "test", api: "test", name: id, contextWindow: 16_000, maxTokens: 2_000 }; }
function response(value) {
	return { role: "assistant", content: [{ type: "text", text: JSON.stringify(value) }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
}
function rawResponse(text, stopReason = "length") {
	return { role: "assistant", content: [{ type: "text", text }], stopReason, usage: { input: 1, output: 2_000, cacheRead: 0, cacheWrite: 0, totalTokens: 2_001, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
}
