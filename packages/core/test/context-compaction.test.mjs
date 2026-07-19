import assert from "node:assert/strict";
import test from "node:test";
import {
	assessCompactionPreservation,
	buildTaskPreservationEnvelope,
	evaluateCompactionQuality,
	planContextCompaction,
	recoverCompactionPreservation,
	taskIdsFromCompactionPreservation,
} from "../dist/index.js";

test("context compaction reserves model-proportional headroom without starving small windows", () => {
	assert.deepEqual(planContextCompaction({ contextWindow: 32_000 }), {
		enabled: true,
		reserveTokens: 4_800,
		keepRecentTokens: 8_000,
		triggerAtTokens: 27_200,
	});
	assert.deepEqual(planContextCompaction({ contextWindow: 1_000_000 }), {
		enabled: true,
		reserveTokens: 65_536,
		keepRecentTokens: 65_536,
		triggerAtTokens: 934_464,
	});
});

test("compaction quality distinguishes durable identity loss from degraded continuation semantics", () => {
	const preservation = buildTaskPreservationEnvelope([{
		id: "objective-quarterly-report",
		ownerKey: "owner",
		kind: "objective",
		title: "生成季度经营报告",
		acceptanceCriteria: "输出PDF并发送给财务负责人",
		checkpoint: "下一步先核对数据来源，然后生成PDF",
		status: "running",
		createdAt: 1,
	}]);
	assert.ok(preservation);

	const good = evaluateCompactionQuality({
		summary: "继续 objective-quarterly-report：生成季度经营报告。下一步先核对数据来源，然后生成PDF并发送给财务负责人。",
		preservation,
	});
	assert.equal(good.status, "good");
	assert.equal(good.identityCoverage, 1);
	assert.ok(good.semanticCoverage >= 0.75);

	const degraded = evaluateCompactionQuality({ summary: "继续 objective-quarterly-report。", preservation });
	assert.equal(degraded.status, "degraded");
	assert.equal(degraded.identityCoverage, 1);
	assert.equal(degraded.semanticCoverage, 0);
	assert.ok(degraded.missingSemanticAnchors.length >= 2);

	const critical = evaluateCompactionQuality({ summary: "继续完成报告。", preservation });
	assert.equal(critical.status, "critical");
	assert.deepEqual(critical.missingTaskIds, ["objective-quarterly-report"]);
});

test("durable Task identities are discovered from the authoritative envelope only", () => {
	assert.deepEqual(taskIdsFromCompactionPreservation([
		'<task-preservation-envelope schema="beemax.task-preservation.v2">',
		'[{"authoritative":{"id":"objective-alpha","status":"running"}},{"display":{"id":"not-authoritative"}},{"authoritative":{"id":"task-beta","status":"pending"}},{"authoritative":{"id":"objective-alpha","status":"running"}}]',
		'</task-preservation-envelope>',
	].join("\n")), ["objective-alpha", "task-beta"]);
});

test("bounded Task preservation keeps every active responsibility identity when full details do not fit", () => {
	const tasks = Array.from({ length: 30 }, (_value, index) => ({
		id: `objective-${String(index).padStart(2, "0")}`,
		ownerKey: "owner",
		kind: "objective",
		title: `Objective ${index}`,
		description: `detail-${index}-${"x".repeat(2_000)}`,
		status: "running",
		createdAt: index,
	}));
	const preservation = buildTaskPreservationEnvelope(tasks, 4_000);
	assert.ok(preservation);
	assert.ok(Buffer.byteLength(preservation) <= 4_000);
	assert.deepEqual(taskIdsFromCompactionPreservation(preservation), tasks.map((task) => task.id));
});

test("missing durable Task identities produce a non-triggering recovery context", () => {
	assert.deepEqual(recoverCompactionPreservation({
		summary: "Continue task-a.",
		preservation: "<task-preservation-envelope>task-a task-b</task-preservation-envelope>",
		expectedTaskIds: ["task-a", "task-b"],
	}), {
		complete: false,
		missingTaskIds: ["task-b"],
		recoveryContext: "<task-preservation-envelope>task-a task-b</task-preservation-envelope>",
	});
});

test("semantic loss after compaction restores the authoritative Task contract even when identity survives", () => {
	const preservation = buildTaskPreservationEnvelope([{
		id: "objective-verified-research",
		ownerKey: "owner",
		kind: "objective",
		title: "研究实时行业趋势",
		acceptanceCriteria: "必须通过公共网络复核至少两个真实来源；不得用 evergreen 内容替代",
		status: "running",
		createdAt: 1,
	}]);
	const recovered = recoverCompactionPreservation({
		summary: "继续 objective-verified-research。",
		preservation,
		expectedTaskIds: ["objective-verified-research"],
	});
	assert.equal(recovered.complete, true);
	assert.deepEqual(recovered.missingTaskIds, []);
	assert.equal(recovered.recoveryContext, preservation);
});

test("Task preservation retains the durable Work Contract, unresolved criteria, Artifact references, and bounded scope state", () => {
	const rawRequest = "生成报告；不要发布；只保存草稿";
	const preservation = buildTaskPreservationEnvelope([{
		id: "objective-contract",
		ownerKey: "owner",
		kind: "objective",
		title: "生成报告",
		status: "running",
		createdAt: 1,
		workContract: {
			schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create",
			objective: { text: "生成报告", source: { kind: "raw_request", start: 0, end: 4 } },
			constraints: [],
			prohibitions: [{ text: "不要发布", source: { kind: "raw_request", start: 5, end: 9 } }],
			acceptanceCriteria: [{ text: "只保存草稿", source: { kind: "raw_request", start: 10, end: 15 } }],
			capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.95,
		},
		criterionVerifications: [{ criterionId: "C1", criterion: "只保存草稿", status: "unavailable", evidenceRefs: [] }],
		unresolvedIssues: ["尚未确认草稿存在"],
		artifacts: [{ type: "reference", uri: "beemax-artifact:sha256:fixture", label: "draft evidence" }],
		accessScopeRef: { id: "scope:private", trust: "verified", authority: { kind: "enterprise_system", reference: "iam:private" }, issuedAt: 1 },
	}]);
	assert.match(preservation, /生成报告；不要发布；只保存草稿/u);
	assert.match(preservation, /不要发布/u);
	assert.match(preservation, /criterionId\\?"?:\\?"?C1/u);
	assert.match(preservation, /尚未确认草稿存在/u);
	assert.match(preservation, /beemax-artifact:sha256:fixture/u);
	assert.match(preservation, /accessScopeBound/u);
	assert.doesNotMatch(preservation, /scope:private|iam:private/u);
});

test("near-budget preservation keeps the original request fingerprint and latest revision instead of collapsing to Task identity", () => {
	const taskId = "objective-budget-pressure";
	const originalRawRequest = `原始请求${"x".repeat(10_000)}`;
	const original = { schemaVersion: "beemax.work-contract.v1", rawRequest: originalRawRequest, action: "create", objective: { text: "原始请求", source: { kind: "raw_request", start: 0, end: 4 } }, constraints: [], prohibitions: [], acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 1 };
	const objectiveRevisions = Array.from({ length: 20 }, (_value, index) => {
		const prohibitionTexts = [`禁止发布-${index}`, `不得外发-${index}`, `不要删除-${index}`, `never overwrite-${index}`];
		const rawRequest = `修正-${index}；${prohibitionTexts.join("；")}`;
		return {
			id: `${taskId}:revision:${index + 1}`, createdAt: index + 2,
			workContract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "correct", objective: { text: "原始请求", source: { kind: "active_objective", id: taskId } }, constraints: [], prohibitions: prohibitionTexts.map((text) => ({ text, source: { kind: "raw_request", start: rawRequest.indexOf(text), end: rawRequest.indexOf(text) + text.length } })), acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 1 },
			situation: { summary: `采用第 ${index} 次修正`, goals: ["完成原目标"], constraints: prohibitionTexts, uncertainties: [], relevantMemoryIds: [], relevantTaskIds: [], observations: [], possibleActions: [], confidence: 1 },
		};
	});
	const preservation = buildTaskPreservationEnvelope([{
		id: taskId, ownerKey: "owner", kind: "objective", title: "原始请求", status: "running", createdAt: 1, workContract: original, objectiveRevisions,
		criterionVerifications: Array.from({ length: 5 }, (_value, index) => ({ criterionId: `C${index + 1}`, criterion: `保留待验证约束-${index + 1}`, status: "unavailable", evidenceRefs: [] })),
		artifacts: Array.from({ length: 5 }, (_value, index) => ({ type: "reference", uri: `beemax-artifact:sha256:budget-${index + 1}`, label: `evidence-${index + 1}` })),
		accessScopeRef: { id: "scope:budget-secret", trust: "verified", authority: { kind: "enterprise_system", reference: "iam:budget-secret" }, issuedAt: 1 },
	}], 6_000);
	assert.ok(Buffer.byteLength(preservation) <= 6_000);
	assert.match(preservation, /objective-budget-pressure/u);
	assert.match(preservation, /rawRequestSha256/u);
	assert.match(preservation, /原始请求/u);
	assert.match(preservation, /修正-19/u);
	assert.match(preservation, /禁止发布-19/u);
	assert.match(preservation, /不得外发-19/u);
	assert.match(preservation, /不要删除-19/u);
	assert.match(preservation, /never overwrite-19/u);
	assert.match(preservation, /"total":20,"omitted":19/u);
	assert.match(preservation, /"unresolvedCriteria":\{"total":5,"retained":3,"omitted":2/u);
	assert.match(preservation, /"artifactRefs":\{"total":5,"retained":3,"omitted":2/u);
	assert.match(preservation, /requiresTaskLedgerReread/u);
	assert.match(preservation, /reread this Objective from Task Ledger/u);
	assert.match(preservation, /保留待验证约束-1/u);
	assert.match(preservation, /beemax-artifact:sha256:budget-1/u);
	assert.doesNotMatch(preservation, /scope:budget-secret|iam:budget-secret/u);
});

test("Profile compaction overrides are explicit and fail closed when they cannot fit", () => {
	assert.deepEqual(planContextCompaction({ contextWindow: 128_000, enabled: false, reserveTokens: 20_000, keepRecentTokens: 24_000 }), {
		enabled: false,
		reserveTokens: 20_000,
		keepRecentTokens: 24_000,
		triggerAtTokens: 108_000,
	});
	assert.throws(
		() => planContextCompaction({ contextWindow: 32_000, reserveTokens: 20_000, keepRecentTokens: 20_000 }),
		/leave at least 20% of the model context available/,
	);
});

test("compaction preservation assessment detects omitted durable Task identities", () => {
	assert.deepEqual(
		assessCompactionPreservation({ summary: "Continue objective task-a, then verify task-b.", expectedTaskIds: ["task-a", "task-b"] }),
		{ complete: true, missingTaskIds: [] },
	);
	assert.deepEqual(
		assessCompactionPreservation({ summary: "Continue objective task-a.", expectedTaskIds: ["task-a", "task-b"] }),
		{ complete: false, missingTaskIds: ["task-b"] },
	);
});
