import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "../dist/index.js";
import Database from "better-sqlite3";
import { BeeMaxAgentRuntime, createAccessScopeRef, createAdmittedWorkContractPlanningInput, createDurableContractAdmissionReceipt, createSituation, createTaskCheckpoint, DeterministicWorkContractBuilder, interactionCompletionDeliveryKey, MUTATING_TOOL_POLICY, ObjectiveCompletionDeliveryService, ObjectiveRuntime, TaskGraph, TaskPlanNoticeDeliveryService, TaskPlanRuntime, TaskRecoveryRunner, TaskRecoveryService, WORK_CONTRACT_ADJUDICATION_SCHEMA_VERSION } from "@beemax/core";

const claimWorker = fileURLToPath(new URL("./fixtures/task-plan-claim-worker.mjs", import.meta.url));

function runClaimWorker(request, expectedCode = 0) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [claimWorker, JSON.stringify(request)], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", reject);
		child.once("exit", (code, signal) => code === expectedCode && !signal
			? resolve(stdout.trim())
			: reject(new Error(`claim worker exited code=${code} signal=${signal}: ${stderr}`)));
	});
}

function recordSucceededObjectiveRun(store, objectiveId, output, id = `run:${objectiveId}`) {
	const now = Date.now();
	store.recordRun({ id, taskId: objectiveId, executor: "agent", status: "running", startedAt: now, leaseExpiresAt: now + 60_000 });
	assert.equal(store.transitionRun(id, { status: "succeeded", finishedAt: now + 1, output }), true);
	return id;
}

test("natural-language recall is safe and stays inside the requesting conversation", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-test-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const memoryId = store.remember({
			platform: "feishu",
			chatId: "chat-a",
			userId: "user-1",
			role: "memory",
			content: "User prefers concise weekly reports",
		});
		const records = store.recall('prefers "concise" OR', {
			platform: "feishu",
			chatId: "chat-b",
			userId: "user-1",
			limit: 5,
		});
		assert.equal(records.length, 0);
		assert.equal(store.list({ platform: "feishu", userId: "user-1" }).length, 1);
		assert.equal(store.forget(memoryId, { platform: "feishu", userId: "user-1" }), true);
		assert.equal(store.list({ platform: "feishu", userId: "user-1" }).length, 0);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("conversation candidates stay pending until explicitly promoted or rejected", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-candidates-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "feishu", chatId: "chat-a", userId: "user-1" };
		const candidate = store.recordCandidate({ ...scope, role: "user", content: "User prefers monthly strategy reviews" });
		assert.equal(store.list(scope).length, 0);
		assert.equal(store.recall("monthly strategy", scope).length, 0);
		assert.equal(store.listCandidates(scope).length, 1);
		assert.equal(store.promoteCandidate(candidate, scope), true);
		assert.equal(store.list(scope).length, 1);
		assert.deepEqual(store.stats(scope), { curated: 1, pending: 0, promoted: 1, rejected: 0 });
		const rejected = store.recordCandidate({ ...scope, role: "assistant", content: "Transient draft response" });
		assert.equal(store.rejectCandidate(rejected, scope), true);
		assert.equal(store.stats(scope).rejected, 1);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("multilingual recall finds Chinese, English morphology, and mixed-language business terms", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-multilingual-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "feishu", chatId: "sales", threadId: "customer-a", userId: "seller" };
		store.remember({ ...scope, role: "memory", content: "客户要求交付日期为七月二十五日，并提供 delivery report" });
		assert.equal(store.recall("交付日期", scope)[0]?.content, "客户要求交付日期为七月二十五日，并提供 delivery report");
		assert.equal(store.recall("deliver reports", scope)[0]?.content, "客户要求交付日期为七月二十五日，并提供 delivery report");
		assert.equal(store.recall("客户 delivery", scope)[0]?.content, "客户要求交付日期为七月二十五日，并提供 delivery report");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("pending candidates are opt-in low-confidence evidence and remain isolated by conversation", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-candidate-recall-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const customerA = { platform: "feishu", chatId: "sales", threadId: "customer-a", userId: "seller" };
		const customerB = { platform: "feishu", chatId: "sales", threadId: "customer-b", userId: "seller" };
		store.recordCandidate({ ...customerA, role: "user", content: "A客户要求使用蓝色封面" });
		assert.equal(store.recall("蓝色封面", customerA).length, 0);
		assert.deepEqual(store.recall("蓝色封面", { ...customerA, includeCandidates: true }).map(({ content, memoryType, confidence }) => ({ content, memoryType, confidence })), [
			{ content: "A客户要求使用蓝色封面", memoryType: "candidate", confidence: 0.35 },
		]);
		assert.equal(store.recall("蓝色封面", { ...customerB, includeCandidates: true }).length, 0);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("business-object filters prevent a similar customer requirement from crossing orders", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-object-scope-"));
	const store = new MemoryStore(join(root, "memory.db"), "sales-profile");
	try {
		const scope = { profileId: "sales-profile", platform: "feishu", chatId: "sales", threadId: "orders", userId: "seller", projectId: "sales-team" };
		const expected = store.upsertClaim({ ...scope, kind: "fact", statement: "交付日期为七月二十五日", subject: { type: "customer", id: "customer-a" }, object: { type: "order", id: "PO-1" }, visibility: "team" });
		store.upsertClaim({ ...scope, kind: "fact", statement: "交付日期为七月二十八日", subject: { type: "customer", id: "customer-b" }, object: { type: "order", id: "PO-2" }, visibility: "team" });
		assert.deepEqual(store.recallBrief("交付日期", { ...scope, subject: { type: "customer", id: "customer-a" }, object: { type: "order", id: "PO-1" } }).claims.map((claim) => claim.id), [expected.id]);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("business-object recall excludes legacy memories and candidates without entity ownership", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-object-fail-closed-"));
	const store = new MemoryStore(join(root, "memory.db"), "sales-profile");
	try {
		const scope = { profileId: "sales-profile", platform: "feishu", chatId: "sales", threadId: "orders", userId: "seller", projectId: "sales-team" };
		const businessScope = { ...scope, subject: { type: "customer", id: "customer-b" }, object: { type: "order", id: "PO-2" }, includeCandidates: true };
		store.remember({ ...scope, role: "memory", content: "PO-2交付日期需要确认" });
		store.recordCandidate({ ...scope, role: "user", content: "PO-2交付日期可能是周五" });
		const expected = store.upsertClaim({ ...scope, kind: "fact", statement: "PO-2交付日期为周一", subject: businessScope.subject, object: businessScope.object, visibility: "team" });
		assert.deepEqual(store.recallRanked("PO-2交付日期", businessScope).map((hit) => hit.id), [expected.id]);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("business-object recall admits only candidates with matching entity ownership", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-object-candidates-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "feishu", chatId: "sales", threadId: "orders", userId: "seller" };
		const customerA = { subject: { type: "customer", id: "customer-a" }, object: { type: "order", id: "PO-1" } };
		const customerB = { subject: { type: "customer", id: "customer-b" }, object: { type: "order", id: "PO-2" } };
		const expected = store.recordCandidate({ ...scope, ...customerA, role: "user", content: "交付日期为周五" });
		store.recordCandidate({ ...scope, ...customerB, role: "user", content: "交付日期为周一" });
		assert.deepEqual(store.recallRanked("交付日期", { ...scope, ...customerA, includeCandidates: true }).map((hit) => hit.id), [expected]);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("promoting a business-object candidate preserves its entity ownership as a Claim", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-promote-object-candidate-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "feishu", chatId: "sales", threadId: "orders", userId: "seller" };
		const businessContext = { subject: { type: "customer", id: "customer-a" }, object: { type: "order", id: "PO-1" } };
		const candidate = store.recordCandidate({ ...scope, ...businessContext, role: "user", content: "PO-1交付日期为周五" });
		assert.equal(store.promoteCandidate(candidate, { ...scope, ...businessContext }), true);
		const hits = store.recallRanked("PO-1交付日期", { ...scope, ...businessContext, includeCandidates: true });
		assert.equal(hits.length, 1);
		assert.equal(hits[0].memoryType, "claim");
		assert.deepEqual({ subject: hits[0].subject, object: hits[0].object }, businessContext);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("unbound recall excludes entity-owned Claims and Candidates", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-unbound-entity-filter-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "feishu", chatId: "sales", threadId: "orders", userId: "seller" };
		const entity = { subject: { type: "customer", id: "customer-a" }, object: { type: "order", id: "PO-1" } };
		const entityClaim = store.upsertClaim({ ...scope, ...entity, kind: "fact", statement: "客户专属交付安排为周五", stability: "high", visibility: "conversation" });
		const generalClaim = store.upsertClaim({ ...scope, kind: "fact", statement: "通用交付流程需要复核", stability: "high", visibility: "conversation" });
		const entityCandidate = store.recordCandidate({ ...scope, ...entity, role: "user", content: "客户专属交付包装为蓝色" });
		const generalCandidate = store.recordCandidate({ ...scope, role: "user", content: "通用交付模板需要更新" });
		const ids = store.recallRanked("交付", { ...scope, includeCandidates: true, limit: 10 }).map((hit) => hit.id);
		assert.equal(ids.includes(entityClaim.id), false);
		assert.equal(ids.includes(entityCandidate), false);
		assert.ok(ids.includes(generalClaim.id));
		assert.ok(ids.includes(generalCandidate));
		const candidateIds = store.listCandidates(scope).map((candidate) => candidate.id);
		assert.equal(candidateIds.includes(entityCandidate), false);
		assert.ok(candidateIds.includes(generalCandidate));
		const snapshot = store.compileLongTermMemory({ ...scope, maxChars: 1000 });
		assert.doesNotMatch(snapshot, /客户专属交付安排/);
		assert.match(snapshot, /通用交付流程需要复核/);
		assert.equal(store.promoteCandidate(entityCandidate, scope), false);
		assert.equal(store.rejectCandidate(entityCandidate, scope), false);
		assert.equal(store.promoteCandidate(entityCandidate, { ...scope, ...entity }), true);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("ranked recall explains one ordering across claims, curated memory, and pending evidence", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-ranked-recall-"));
	const store = new MemoryStore(join(root, "memory.db"), "sales-profile");
	try {
		const scope = { profileId: "sales-profile", platform: "feishu", chatId: "sales", threadId: "order", userId: "seller", projectId: "team" };
		const claim = store.upsertClaim({ ...scope, kind: "fact", statement: "PO-1交付日期为七月二十五日", confidence: 0.95, stability: "high", visibility: "team" });
		store.remember({ ...scope, role: "memory", content: "交付日期需要再次确认" });
		store.recordCandidate({ ...scope, role: "user", content: "有人提到交付日期可能变化" });
		const hits = store.recallRanked("PO-1交付日期", { ...scope, includeCandidates: true, limit: 5 });
		assert.equal(hits[0].id, claim.id);
		assert.equal(hits[0].memoryType, "claim");
		assert.equal(hits[0].status, "active");
		assert.ok(hits[0].score > hits.at(-1).score);
		assert.deepEqual(new Set(hits.map((hit) => hit.memoryType)), new Set(["claim", "curated", "candidate"]));
		assert.ok(hits.every((hit) => Number.isFinite(hit.score) && hit.matchReasons.length > 0));
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("memory evaluation reports Recall@K and forbidden cross-customer retrievals", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-evaluation-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const a = { platform: "feishu", chatId: "sales", threadId: "customer-a", userId: "seller" };
		const b = { platform: "feishu", chatId: "sales", threadId: "customer-b", userId: "seller" };
		const expectedId = store.remember({ ...a, role: "memory", content: "A客户要求周五交付蓝色PDF" });
		const forbiddenId = store.remember({ ...b, role: "memory", content: "B客户要求周一交付红色PDF" });
		assert.deepEqual(store.evaluateRecall([{ query: "蓝色PDF交付", options: a, expectedIds: [expectedId], forbiddenIds: [forbiddenId] }], 5), {
			cases: 1, hitCases: 1, hitRateAtK: 1, expected: 1, expectedRetrieved: 1, recallAtK: 1, forbiddenRetrieved: 0, forbiddenRetrievalRate: 0,
		});
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("task ledger stores verifiable profile-scoped task facts independently from chat memory", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-ledger-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.upsertTask({
			id: "anthropic-protocol",
			title: "Support Anthropic Messages protocol",
			status: "done",
			evidence: "tag:v0.1.0-preview.15", completedAt: 1_700_000_000_000,
		});
		assert.deepEqual(store.listTasks(), [{
			id: "anthropic-protocol",
			title: "Support Anthropic Messages protocol",
			status: "done",
			evidence: "tag:v0.1.0-preview.15",
			completedAt: 1_700_000_000_000,
			updatedAt: store.listTasks()[0].updatedAt,
		}]);
		store.upsertTask({ id: "anthropic-protocol", title: "Support Anthropic Messages protocol", status: "open" });
		assert.equal(store.listTasks()[0].status, "open");
		assert.equal(store.listTasks()[0].evidence, undefined);
		assert.equal(store.listTasks()[0].completedAt, undefined);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("runtime Task ledger persists delegated lifecycle independently from memory facts", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-runtime-task-ledger-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const leaseExpiresAt = Date.now() + 10_000;
		store.record({ id: "child-1", ownerKey: "cli:local:local", kind: "delegated", title: "Research", acceptanceCriteria: "Includes a source", verificationStatus: "pending", correctiveAttempts: 0, status: "pending", createdAt: 100 });
		store.transition("child-1", { status: "running", startedAt: 110 });
		store.recordRun({ id: "run-1", taskId: "child-1", executor: "subagent", status: "running", startedAt: 110, leaseExpiresAt });
		store.transition("child-1", { status: "succeeded", finishedAt: 120, result: "done", evidence: "ACCEPT: source checked", verificationStatus: "accepted", correctiveAttempts: 1 });
		store.transitionRun("run-1", { status: "succeeded", finishedAt: 120, output: "done" });
		assert.deepEqual(store.queryTasks({ ownerKeys: ["cli:local:local"] }), [{
			id: "child-1", ownerKey: "cli:local:local", kind: "delegated", title: "Research", acceptanceCriteria: "Includes a source",
			status: "succeeded", evidence: "ACCEPT: source checked", verificationStatus: "accepted", correctiveAttempts: 1, createdAt: 100, startedAt: 110, finishedAt: 120, result: "done",
		}]);
		assert.deepEqual(store.taskRuns("child-1"), [{ id: "run-1", taskId: "child-1", executor: "subagent", status: "succeeded", startedAt: 110, leaseExpiresAt, finishedAt: 120, output: "done" }]);
		assert.equal(store.listTasks().length, 0);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Task Ledger reads legacy business context from pre-migration rows across store restarts", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-business-context-"));
	const path = join(root, "memory.db");
	try {
		let store = new MemoryStore(path);
		store.record({ id: "objective-context", ownerKey: "owner", kind: "objective", title: "Order delivery", status: "running", createdAt: 1 });
		store.close();
		const raw = new Database(path);
		raw.prepare("UPDATE tasks SET business_context = ? WHERE id = ?").run(JSON.stringify({ subject: { type: "customer", id: "A" }, object: { type: "order", id: "PO-1" } }), "objective-context");
		raw.close();
		store = new MemoryStore(path);
		assert.deepEqual(store.queryTasks({ ownerKeys: ["owner"], id: "objective-context" })[0].businessContext, { subject: { type: "customer", id: "A" }, object: { type: "order", id: "PO-1" } });
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Task Ledger persists Situation and trusted Access Scope provenance separately across restarts", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-situation-scope-"));
	const path = join(root, "memory.db");
	const situation = createSituation({
		summary: "量子灯塔需要在霜降窗口前完成校准",
		goals: ["完成校准"],
		constraints: ["霜降窗口前完成"],
		observations: [{ statement: "灯塔出现漂移", source: { kind: "enterprise_system", reference: "sensor:17" }, evidenceRef: "reading:42", confidence: 0.96, trust: "verified" }],
		confidence: 0.9,
	});
	const accessScopeRef = createAccessScopeRef({ id: "scope:operations", authority: { kind: "membership_registry", reference: "membership:42" }, evidenceRef: "grant:9", issuedAt: 10 });
	try {
		let store = new MemoryStore(path);
		store.record({ id: "objective-open-domain", ownerKey: "owner", kind: "objective", title: "校准任务", status: "running", createdAt: 11, situation, accessScopeRef });
		store.close();
		store = new MemoryStore(path);
		const restored = store.queryTasks({ ownerKeys: ["owner"], id: "objective-open-domain" })[0];
		assert.deepEqual(restored.situation, situation);
		assert.deepEqual(restored.accessScopeRef, accessScopeRef);
		assert.equal(restored.businessContext, undefined);
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Task Ledger persists structured Sub-Agent artifacts and unresolved issues across restarts", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-structured-result-"));
	const path = join(root, "memory.db");
	try {
		let store = new MemoryStore(path);
		store.record({ id: "structured-task", ownerKey: "owner", kind: "delegated", title: "Research", status: "running", createdAt: 1 });
		store.transition("structured-task", {
			status: "succeeded", finishedAt: 2, result: "Friday", evidence: "ERP checked",
			artifacts: [{ type: "file", uri: "/tmp/report.pdf", label: "Delivery report" }],
			unresolvedIssues: ["Awaiting warehouse sign-off"],
		});
		store.close();
		store = new MemoryStore(path);
		const task = store.queryTasks({ ownerKeys: ["owner"], id: "structured-task" })[0];
		assert.deepEqual(task.artifacts, [{ type: "file", uri: "/tmp/report.pdf", label: "Delivery report" }]);
		assert.deepEqual(task.unresolvedIssues, ["Awaiting warehouse sign-off"]);
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Task Ledger persists the validated Work Contract across restart", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-work-contract-"));
	const path = join(root, "memory.db");
	const rawRequest = "生成报告；不要发布；只保存草稿";
	const workContract = {
		schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create",
		objective: { text: "生成报告", source: { kind: "raw_request", start: 0, end: 4 } },
		constraints: [], prohibitions: [{ text: "不要发布", source: { kind: "raw_request", start: 5, end: 9 } }],
		acceptanceCriteria: [{ text: "只保存草稿", source: { kind: "raw_request", start: 10, end: 15 } }],
		capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.95,
	};
	try {
		let store = new MemoryStore(path);
		store.record({ id: "contract-task", ownerKey: "owner", kind: "objective", title: "生成报告", status: "running", createdAt: 1, workContract });
		store.close();
		store = new MemoryStore(path);
		assert.deepEqual(store.queryTasks({ ownerKeys: ["owner"], id: "contract-task" })[0].workContract, workContract);
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Task Ledger persists a strict durable Contract admission receipt across restart and rejects corrupt storage", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-contract-admission-"));
	const path = join(root, "memory.db");
	const rawRequest = "生成黄金报告";
	const workContract = {
		schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create",
		objective: { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } },
		constraints: [], prohibitions: [], acceptanceCriteria: [{ text: "黄金报告", source: { kind: "raw_request", start: 2, end: 6 } }],
		capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.97,
	};
	const cognitionUsage = { inputTokens: 12, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, modelIdentities: ["primary/model", "reviewer/model"] };
	const built = {
		contract: workContract,
		source: "model",
		cognitionUsage,
		cognitionBudgetChargeTokens: 20,
		semanticAdjudication: {
			schemaVersion: WORK_CONTRACT_ADJUDICATION_SCHEMA_VERSION,
			inventorySchemaVersion: "beemax.semantic-inventory.v1",
			primaryModelIdentity: "primary/model",
			reviewerModelIdentity: "reviewer/model",
			reviewMode: "different_models",
			independentSamples: true,
			cognitionUsage,
			cognitionBudgetChargeTokens: 20,
		},
	};
	const contractAdmission = createDurableContractAdmissionReceipt({ admission: createAdmittedWorkContractPlanningInput(built), admittedAt: 100, ttlMs: 10_000 });
	let store = new MemoryStore(path);
	try {
		store.record({ id: "admitted-contract-task", ownerKey: "owner", kind: "objective", title: "生成黄金报告", status: "running", createdAt: 100, workContract, contractAdmission });
		store.close();
		store = new MemoryStore(path);
		assert.deepEqual(store.queryTasks({ ownerKeys: ["owner"], id: "admitted-contract-task" })[0].contractAdmission, contractAdmission);
		store.close();
		const raw = new Database(path);
		raw.prepare("UPDATE tasks SET contract_admission = ? WHERE id = ?").run('{"schemaVersion":"tampered"}', "admitted-contract-task");
		raw.close();
		store = new MemoryStore(path);
		assert.throws(() => store.queryTasks({ ownerKeys: ["owner"], id: "admitted-contract-task" }), /Contract admission/i);
	} finally { try { store.close(); } catch {} rmSync(root, { recursive: true, force: true }); }
});

test("Task Ledger atomically revises an owner-scoped Objective idempotently across restart", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-work-contract-corrections-"));
	const path = join(root, "memory.db");
	const correctionRequest = "不要取消，continue；不要改目标";
	const correction = {
		schemaVersion: "beemax.work-contract.v1", rawRequest: correctionRequest, action: "correct",
		targetObjective: { kind: "active_objective", id: "corrected-contract-task" },
		objective: { text: "continue", source: { kind: "raw_request", start: 5, end: 13 } },
		constraints: [{ text: "不要改目标", source: { kind: "raw_request", start: 14, end: 19 } }],
		prohibitions: [{ text: "不要取消", source: { kind: "raw_request", start: 0, end: 4 } }],
		acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.98,
	};
	const situation = { summary: "继续原目标并改用新参数", goals: ["完成原目标"], constraints: ["不要改目标"], uncertainties: [], observations: [], possibleActions: [], relevantMemoryIds: [], relevantTaskIds: [], confidence: 0.98 };
	try {
		let store = new MemoryStore(path);
		store.record({ id: "corrected-contract-task", ownerKey: "owner", kind: "objective", title: "生成报告", status: "running", createdAt: 1 });
		assert.equal(store.reviseObjective("wrong-owner", "corrected-contract-task", { workContract: correction, situation }, 2), undefined);
		assert.equal(store.reviseObjective("owner", "corrected-contract-task", { workContract: { ...correction, targetObjective: { kind: "active_objective", id: "other-task" } }, situation }, 2), undefined);
		const firstRevision = store.reviseObjective("owner", "corrected-contract-task", { workContract: correction, situation }, 2);
		assert.equal(firstRevision.revision.id, "corrected-contract-task:revision:1");
		assert.equal(store.reviseObjective("owner", "corrected-contract-task", { workContract: correction, situation }, 3).revision.id, firstRevision.revision.id);
		assert.deepEqual(store.queryTasks({ ownerKeys: ["owner"], id: "corrected-contract-task" })[0].objectiveRevisions.map((revision) => revision.workContract), [correction]);
		assert.deepEqual(store.queryTasks({ ownerKeys: ["owner"], id: "corrected-contract-task" })[0].situation, situation);
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: "corrected-contract-task" })[0].workContract.rawRequest, "生成报告");
		store.close();
		store = new MemoryStore(path);
		assert.deepEqual(store.queryTasks({ ownerKeys: ["owner"], id: "corrected-contract-task" })[0].objectiveRevisions.map((revision) => revision.workContract), [correction]);
		assert.deepEqual(store.queryTasks({ ownerKeys: ["owner"], id: "corrected-contract-task" })[0].situation, situation);
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy correction revisions without a target recover with their owning Objective identity", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-legacy-objective-revision-target-"));
	const path = join(root, "memory.db");
	const taskId = "legacy-correction";
	const situation = { summary: "保留旧修正", goals: ["继续原目标"], constraints: [], uncertainties: [], observations: [], possibleActions: [], relevantMemoryIds: [], relevantTaskIds: [], confidence: 0.9 };
	const rawRequest = "改成中文";
	const legacyContract = { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "correct", objective: { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } }, constraints: [], prohibitions: [], acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.9 };
	let store = new MemoryStore(path);
	try {
		store.record({ id: taskId, ownerKey: "owner", kind: "objective", title: "报告", status: "running", createdAt: 1 });
		store.close();
		const raw = new Database(path);
		raw.prepare("UPDATE tasks SET objective_revisions = ? WHERE id = ?").run(JSON.stringify([{ id: `${taskId}:revision:1`, workContract: legacyContract, situation, createdAt: 2 }]), taskId);
		raw.close();
		store = new MemoryStore(path);
		const restored = store.queryTasks({ ownerKeys: ["owner"], id: taskId })[0];
		assert.deepEqual(restored.objectiveRevisions[0].workContract.targetObjective, { kind: "active_objective", id: taskId });
		const nextRaw = "保留目标，改成英文";
		const next = { schemaVersion: "beemax.work-contract.v1", rawRequest: nextRaw, action: "correct", targetObjective: { kind: "active_objective", id: taskId }, objective: { text: nextRaw, source: { kind: "raw_request", start: 0, end: nextRaw.length } }, constraints: [], prohibitions: [], acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.95 };
		assert.equal(store.reviseObjective("owner", taskId, { workContract: next, situation }, 3).revisions.length, 2);
		store.close();
		const normalizedDb = new Database(path, { readonly: true });
		const persisted = JSON.parse(normalizedDb.prepare("SELECT objective_revisions FROM tasks WHERE id = ?").get(taskId).objective_revisions);
		normalizedDb.close();
		assert.deepEqual(persisted[0].workContract.targetObjective, { kind: "active_objective", id: taskId }, "the next durable write must migrate the legacy revision to its canonical target-bound shape");
		store = new MemoryStore(path);
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: taskId })[0].objectiveRevisions.length, 2);
	} finally { try { store.close(); } catch {} rmSync(root, { recursive: true, force: true }); }
});

test("Task Ledger refuses a correction beyond its durable revision bound without discarding history", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-work-contract-revision-bound-"));
	const store = new MemoryStore(join(root, "memory.db"));
	const situation = { summary: "保留修正历史", goals: ["完成原目标"], constraints: [], uncertainties: [], observations: [], possibleActions: [], relevantMemoryIds: [], relevantTaskIds: [], confidence: 1 };
	const correction = (index) => {
		const rawRequest = `修正-${index}`;
		return { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "correct", targetObjective: { kind: "active_objective", id: "bounded-revisions" }, objective: { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } }, constraints: [], prohibitions: [], acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 1 };
	};
	try {
		store.record({ id: "bounded-revisions", ownerKey: "owner", kind: "objective", title: "原目标", status: "running", createdAt: 1 });
		for (let index = 0; index < 20; index++) assert.ok(store.reviseObjective("owner", "bounded-revisions", { workContract: correction(index), situation }, index + 2));
		assert.equal(store.reviseObjective("owner", "bounded-revisions", { workContract: correction(20), situation }, 22), undefined);
		const revisions = store.queryTasks({ ownerKeys: ["owner"], id: "bounded-revisions" })[0].objectiveRevisions;
		assert.equal(revisions.length, 20);
		assert.equal(revisions[0].workContract.rawRequest, "修正-0");
		assert.equal(revisions[19].workContract.rawRequest, "修正-19");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task Ledger persists capability-derived Verification requirements across restart", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-verification-requirements-"));
	const path = join(root, "memory.db");
	let store = new MemoryStore(path);
	try {
		store.record({ id: "requirement-task", ownerKey: "cli:local:local", kind: "delegated", title: "Resolve qx-17", status: "running", createdAt: 1 });
		assert.equal(store.updateVerificationRequirements("wrong-owner", "requirement-task", [{ capability: "temporal_evidence_feed", freshness: "realtime", evidence: "source_receipt" }]), false);
		assert.equal(store.updateVerificationRequirements("cli:local:local", "requirement-task", [{ capability: "temporal_evidence_feed", freshness: "realtime", evidence: "source_receipt" }]), true);
		store.close();
		store = new MemoryStore(path);
		assert.deepEqual(store.queryTasks({ ownerKeys: ["cli:local:local"], id: "requirement-task" })[0].verificationRequirements, [
			{ capability: "temporal_evidence_feed", freshness: "realtime", evidence: "source_receipt" },
		]);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task Ledger exposes legacy business context as read-only migration evidence", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-update-business-context-"));
	const path = join(root, "memory.db");
	const store = new MemoryStore(path);
	try {
		store.record({ id: "objective-context", ownerKey: "owner", kind: "objective", title: "Order", status: "running", createdAt: 1, businessContext: { subject: { type: "customer", id: "A" }, object: { type: "order", id: "PO-1" } } });
		assert.equal(store.updateBusinessContext, undefined);
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: "objective-context" })[0].businessContext, undefined);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task Ledger ignores malformed or structurally invalid business context during recovery", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-invalid-business-context-"));
	const path = join(root, "memory.db");
	try {
		let store = new MemoryStore(path);
		store.record({ id: "broken-json", ownerKey: "owner", kind: "objective", title: "Broken", status: "running", createdAt: 1 });
		store.record({ id: "invalid-shape", ownerKey: "owner", kind: "objective", title: "Invalid", status: "running", createdAt: 2 });
		store.close();
		const raw = new Database(path);
		raw.prepare("UPDATE tasks SET business_context = ? WHERE id = ?").run("{broken", "broken-json");
		raw.prepare("UPDATE tasks SET business_context = ? WHERE id = ?").run(JSON.stringify({ subject: { type: "customer", id: 7 }, admin: true }), "invalid-shape");
		raw.close();
		store = new MemoryStore(path);
		assert.deepEqual(store.queryTasks({ ownerKeys: ["owner"] }).map((task) => task.businessContext), [undefined, undefined]);
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed Objectives can be explicitly reopened for a safe retry", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-objective-retry-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.record({ id: "objective", ownerKey: "owner", kind: "objective", title: "Report", status: "pending", createdAt: 1 });
		store.transition("objective", { status: "running", startedAt: 2 });
		store.transition("objective", { status: "failed", finishedAt: 3, error: "temporary delivery failure" });
		assert.equal(store.retryObjective("owner", "objective", 4), true);
		const objective = store.queryTasks({ ownerKeys: ["owner"], id: "objective" })[0];
		assert.equal(objective.status, "running");
		assert.equal(objective.finishedAt, undefined);
		assert.equal(objective.error, undefined);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task Plan admission rejects Tasks spanning more than one Objective root", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-plan-objective-root-reject-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.record({ id: "objective-a", ownerKey: "owner", kind: "objective", title: "First Objective", status: "running", createdAt: 1 });
		store.record({ id: "objective-b", ownerKey: "owner", kind: "objective", title: "Second Objective", status: "running", createdAt: 2 });
		assert.throws(() => store.recordPlan([
			{ id: "task-a", ownerKey: "owner", kind: "delegated", title: "First work", status: "pending", parentId: "objective-a", planId: "cross-root-plan", createdAt: 3 },
			{ id: "task-b", ownerKey: "owner", kind: "delegated", title: "Second work", status: "pending", parentId: "objective-b", planId: "cross-root-plan", createdAt: 4 },
		], [], { id: "cross-root-plan", ownerKey: "owner", title: "Invalid cross-root Plan", status: "pending", taskCount: 2, succeeded: 0, failed: 0, cancelled: 0, verified: 0, correctiveAttempts: 0, createdAt: 3 }), /Objective roots?/i);
		assert.deepEqual(store.queryTasks({ ownerKeys: ["owner"], planIds: ["cross-root-plan"] }), []);
		assert.deepEqual(store.queryTaskPlans({ ownerKeys: ["owner"], id: "cross-root-plan" }), []);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task Plan admission accepts multiple Task generations under one Objective root", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-plan-objective-root-accept-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.record({ id: "objective", ownerKey: "owner", kind: "objective", title: "Objective", status: "running", createdAt: 1 });
		store.recordPlan([
			{ id: "child", ownerKey: "owner", kind: "delegated", title: "Child", status: "pending", parentId: "objective", planId: "nested-plan", createdAt: 2 },
			{ id: "grandchild", ownerKey: "owner", kind: "delegated", title: "Grandchild", status: "pending", parentId: "child", planId: "nested-plan", createdAt: 3 },
		], [], { id: "nested-plan", ownerKey: "owner", title: "Nested Plan", status: "pending", taskCount: 2, succeeded: 0, failed: 0, cancelled: 0, verified: 0, correctiveAttempts: 0, createdAt: 2 });
		assert.deepEqual(store.queryTasks({ ownerKeys: ["owner"], planIds: ["nested-plan"] }).map((task) => task.id).sort(), ["child", "grandchild"]);
		assert.equal(store.queryTaskPlans({ ownerKeys: ["owner"], id: "nested-plan" })[0].taskCount, 2);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task Plan admission rejects mixing Objective-rooted and rootless Tasks", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-plan-mixed-root-reject-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.record({ id: "objective", ownerKey: "owner", kind: "objective", title: "Objective", status: "running", createdAt: 1 });
		assert.throws(() => store.recordPlan([
			{ id: "rooted", ownerKey: "owner", kind: "delegated", title: "Rooted", status: "pending", parentId: "objective", planId: "mixed-plan", createdAt: 2 },
			{ id: "rootless", ownerKey: "owner", kind: "delegated", title: "Rootless", status: "pending", planId: "mixed-plan", createdAt: 2 },
		], [], { id: "mixed-plan", ownerKey: "owner", title: "Mixed Plan", status: "pending", taskCount: 2, succeeded: 0, failed: 0, cancelled: 0, verified: 0, correctiveAttempts: 0, createdAt: 2 }), /mix Objective-rooted and rootless/i);
		assert.deepEqual(store.queryTaskPlans({ ownerKeys: ["owner"], id: "mixed-plan" }), []);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task Plan admission cannot create new work below a terminal Objective", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-plan-terminal-objective-reject-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.record({ id: "objective", ownerKey: "owner", kind: "objective", title: "Objective", status: "cancelled", createdAt: 1, finishedAt: 2 });
		assert.throws(() => store.recordPlan([
			{ id: "late-task", ownerKey: "owner", kind: "delegated", title: "Late", status: "pending", parentId: "objective", planId: "late-plan", createdAt: 3 },
		], [], { id: "late-plan", ownerKey: "owner", title: "Late Plan", status: "pending", taskCount: 1, succeeded: 0, failed: 0, cancelled: 0, verified: 0, correctiveAttempts: 0, createdAt: 3 }), /terminal/i);
		assert.deepEqual(store.queryTasks({ ownerKeys: ["owner"], id: "late-task" }), []);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("targeted Objective cancellation is owner-scoped and atomically settles linked work", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-objective-target-cancel-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.record({ id: "objective-a", ownerKey: "owner", kind: "objective", title: "Keep", status: "running", createdAt: 1 });
		store.record({ id: "objective-b", ownerKey: "owner", kind: "objective", title: "Cancel", status: "running", createdAt: 2 });
		store.recordPlan([
			{ id: "child-b", ownerKey: "owner", kind: "delegated", title: "Child", status: "running", parentId: "objective-b", planId: "plan-b", createdAt: 3 },
			{ id: "grandchild-b", ownerKey: "owner", kind: "delegated", title: "Grandchild", status: "running", parentId: "child-b", planId: "plan-b", createdAt: 4 },
		], [], { id: "plan-b", ownerKey: "owner", title: "Plan", status: "running", taskCount: 2, succeeded: 0, failed: 0, cancelled: 0, verified: 0, correctiveAttempts: 0, createdAt: 3 });
		store.record({ id: "foreign-child", ownerKey: "other", kind: "delegated", title: "Foreign", status: "running", parentId: "objective-b", createdAt: 4 });
		store.recordRun({ id: "run-b", taskId: "child-b", executor: "agent", status: "running", startedAt: 4 });
		store.recordRun({ id: "grandchild-run-b", taskId: "grandchild-b", executor: "subagent", status: "running", startedAt: 5 });
		assert.equal(store.cancelObjective("other", "objective-b", 5), undefined);
		assert.deepEqual(store.cancelObjective("owner", "objective-b", 6), { ownerKey: "owner", objectiveId: "objective-b", taskIds: ["objective-b", "child-b", "grandchild-b"], planIds: ["plan-b"] });
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: "objective-a" })[0].status, "running");
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: "objective-b" })[0].status, "cancelled");
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: "child-b" })[0].status, "cancelled");
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: "grandchild-b" })[0].status, "cancelled");
		assert.equal(store.queryTasks({ ownerKeys: ["other"], id: "foreign-child" })[0].status, "running");
		assert.deepEqual({ status: store.taskRuns("child-b")[0].status, cancellationRequestedAt: store.taskRuns("child-b")[0].cancellationRequestedAt }, { status: "running", cancellationRequestedAt: 6 });
		assert.deepEqual({ status: store.taskRuns("grandchild-b")[0].status, cancellationRequestedAt: store.taskRuns("grandchild-b")[0].cancellationRequestedAt }, { status: "running", cancellationRequestedAt: 6 });
		assert.equal(store.queryTaskPlans({ ownerKeys: ["owner"], id: "plan-b" })[0].status, "cancelled");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Objective interruption claims fence competing Runtimes until durable holders converge", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-objective-interruption-claim-"));
	const path = join(root, "memory.db");
	const first = new MemoryStore(path);
	const second = new MemoryStore(path);
	try {
		const ownerKey = "owner";
		first.record({ id: "claimed-objective", ownerKey, kind: "objective", title: "Claimed", status: "running", createdAt: 1 });
		first.recordRun({ id: "objective-holder", taskId: "claimed-objective", executor: "agent", status: "running", startedAt: 2, leaseExpiresAt: 1_000 });
		assert.ok(first.cancelObjective(ownerKey, "claimed-objective", 10));
		assert.equal(first.objectiveInterruptionConvergence(ownerKey, "claimed-objective", 11).pendingExecutions, 1);
		const claimA = first.claimObjectiveInterruptions([ownerKey], "runtime-a", 100, 11)[0];
		assert.equal(claimA.objectiveId, "claimed-objective");
		assert.deepEqual(second.claimObjectiveInterruptions([ownerKey], "runtime-b", 100, 11), []);
		assert.equal(second.failObjectiveInterruption(ownerKey, "claimed-objective", "stale", 12, "runtime-b"), false);
		assert.equal(second.settleObjectiveInterruption(ownerKey, "claimed-objective", 12, "runtime-b"), false);
		const reclaimed = second.claimObjectiveInterruptions([ownerKey], "runtime-b", 200, 101)[0];
		assert.equal(reclaimed.objectiveId, "claimed-objective", "an expired claim lease must be reclaimable");
		assert.equal(first.failObjectiveInterruption(ownerKey, "claimed-objective", "stale holder", 102, "runtime-a", claimA.claimToken), false);
		assert.equal(second.failObjectiveInterruption(ownerKey, "claimed-objective", "holder still active", 102, "runtime-b", reclaimed.claimToken), true);
		const claimB = second.claimObjectiveInterruptions([ownerKey], "runtime-b", 200, 103)[0];
		assert.equal(claimB.objectiveId, "claimed-objective");
		const claimBNextGeneration = second.claimObjectiveInterruptions([ownerKey], "runtime-b", 210, 104)[0];
		assert.notEqual(claimBNextGeneration.claimToken, claimB.claimToken, "every claim must carry a unique generation token even for one Runtime");
		assert.equal(second.failObjectiveInterruption(ownerKey, "claimed-objective", "ABA stale generation", 105, "runtime-b", claimB.claimToken), false);
		assert.equal(second.settleObjectiveInterruption(ownerKey, "claimed-objective", 105, "runtime-b", claimBNextGeneration.claimToken), false);
		assert.equal(first.transitionRun("objective-holder", { status: "cancelled", finishedAt: 104, error: "cancelled at durable boundary" }), true);
		assert.equal(second.settleObjectiveInterruption(ownerKey, "claimed-objective", 106, "runtime-b", claimBNextGeneration.claimToken), true);
		assert.deepEqual(first.pendingObjectiveInterruptions([ownerKey]), []);
	} finally { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task Run admission, renewal, success, and interruption settlement share one durable cancellation fence", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-run-cancellation-fence-"));
	const path = join(root, "memory.db");
	const store = new MemoryStore(path);
	try {
		const ownerKey = "owner";
		store.record({ id: "fenced-objective", ownerKey, kind: "objective", title: "Objective", status: "running", createdAt: 1 });
		store.record({ id: "fenced-task", ownerKey, kind: "delegated", title: "Task", status: "running", parentId: "fenced-objective", createdAt: 2 });
		store.recordRun({ id: "fenced-run", taskId: "fenced-task", executor: "agent", status: "running", startedAt: 3, leaseExpiresAt: 1_000 });
		assert.ok(store.cancelObjective(ownerKey, "fenced-objective", 10));
		assert.throws(() => store.recordRun({ id: "late-run", taskId: "fenced-task", executor: "agent", status: "running", startedAt: 11, leaseExpiresAt: 1_000 }), /terminal/i);
		assert.equal(store.renewTaskRunLease("fenced-run", 2_000, 11), false, "a cancellation-requested holder cannot renew");
		assert.equal(store.transitionRun("fenced-run", { status: "succeeded", finishedAt: 12, output: "stale" }), false, "a stale executor cannot commit success");

		const raw = new Database(path);
		try { raw.prepare("UPDATE task_runs SET cancellation_requested_at = NULL WHERE id = ?").run("fenced-run"); }
		finally { raw.close(); }
		assert.equal(store.objectiveInterruptionConvergence(ownerKey, "fenced-objective", 13).pendingExecutions, 1, "all running descendants count even if a legacy row lacks the cancellation marker");
		const claim = store.claimObjectiveInterruptions([ownerKey], "runtime", 100, 13)[0];
		assert.equal(store.settleObjectiveInterruption(ownerKey, "fenced-objective", 14, "runtime", claim.claimToken), false);
		assert.equal(store.transitionRun("fenced-run", { status: "cancelled", finishedAt: 15, error: "fenced" }), true);
		assert.equal(store.settleObjectiveInterruption(ownerKey, "fenced-objective", 16, "runtime", claim.claimToken), true);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an expired Task Run lease cannot revive and a live lease only extends monotonically", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-run-lease-generation-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.record({ id: "lease-objective", ownerKey: "owner", kind: "objective", title: "Objective", status: "running", createdAt: 1 });
		store.recordRun({ id: "lease-run", taskId: "lease-objective", executor: "agent", status: "running", startedAt: 2, leaseExpiresAt: 100 });
		assert.equal(store.renewTaskRunLease("lease-run", 200, 100), false, "an expired lease must never regain authority");
		assert.equal(store.renewTaskRunLease("lease-run", 150, 50), true);
		assert.equal(store.renewTaskRunLease("lease-run", 140, 60), false, "a renewal cannot shorten or replay an older lease generation");
		assert.equal(store.taskRuns("lease-objective")[0].leaseExpiresAt, 150);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task and Task Run success settle atomically behind one active lease and Objective ancestry fence", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-atomic-task-run-settlement-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.record({ id: "atomic-objective", ownerKey: "owner", kind: "objective", title: "Objective", status: "running", createdAt: 1 });
		store.record({ id: "atomic-task", ownerKey: "owner", kind: "delegated", title: "Task", parentId: "atomic-objective", status: "running", createdAt: 2 });
		store.recordRun({ id: "atomic-run", taskId: "atomic-task", executor: "subagent", status: "running", startedAt: 3, leaseExpiresAt: 100 });
		assert.equal(store.settleTaskRunAndTask({ ownerKey: "owner", taskId: "atomic-task", taskRunId: "atomic-run", task: { status: "succeeded", finishedAt: 10, result: "done" }, run: { status: "succeeded", finishedAt: 10, output: "done" } }, 10), true);
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: "atomic-task" })[0].status, "succeeded");
		assert.equal(store.taskRuns("atomic-task")[0].status, "succeeded");

		store.record({ id: "expired-task", ownerKey: "owner", kind: "delegated", title: "Expired", parentId: "atomic-objective", status: "running", createdAt: 11 });
		store.recordRun({ id: "expired-run", taskId: "expired-task", executor: "subagent", status: "running", startedAt: 12, leaseExpiresAt: 20 });
		assert.equal(store.settleTaskRunAndTask({ ownerKey: "owner", taskId: "expired-task", taskRunId: "expired-run", task: { status: "succeeded", finishedAt: 21, result: "stale" }, run: { status: "succeeded", finishedAt: 21, output: "stale" } }, 21), false);
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: "expired-task" })[0].status, "running", "rejected settlement must not commit only the Task side");
		assert.equal(store.taskRuns("expired-task")[0].status, "running", "rejected settlement must not commit only the Run side");

		store.record({ id: "cancelled-objective", ownerKey: "owner", kind: "objective", title: "Cancelled Objective", status: "running", createdAt: 22 });
		store.record({ id: "cancelled-task", ownerKey: "owner", kind: "delegated", title: "Cancelled Task", parentId: "cancelled-objective", status: "running", createdAt: 23 });
		store.recordRun({ id: "cancelled-run", taskId: "cancelled-task", executor: "subagent", status: "running", startedAt: 24, leaseExpiresAt: 100 });
		assert.ok(store.cancelObjective("owner", "cancelled-objective", 25));
		assert.equal(store.settleTaskRunAndTask({ ownerKey: "owner", taskId: "cancelled-task", taskRunId: "cancelled-run", task: { status: "succeeded", finishedAt: 26, result: "stale" }, run: { status: "succeeded", finishedAt: 26, output: "stale" } }, 26), false);
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: "cancelled-task" })[0].status, "cancelled");
		assert.equal(store.taskRuns("cancelled-task")[0].status, "running");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("atomic Task and Task Run success rejects mismatched persisted outputs", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-run-output-lineage-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.record({ id: "lineage-task", ownerKey: "owner", kind: "delegated", title: "Lineage", status: "running", createdAt: 1 });
		store.recordRun({ id: "lineage-run", taskId: "lineage-task", executor: "subagent", status: "running", startedAt: 10, leaseExpiresAt: 200 });
		assert.equal(store.settleTaskRunAndTask({ ownerKey: "owner", taskId: "lineage-task", taskRunId: "lineage-run", task: { status: "succeeded", finishedAt: 100, result: "task-v1" }, run: { status: "succeeded", finishedAt: 100, output: "run-v2" } }, 100), false);
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: "lineage-task" })[0].status, "running");
		assert.equal(store.taskRuns("lineage-task")[0].status, "running");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("legacy NULL Task Run leases migrate to finite expiry and become reconcilable", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-run-null-lease-migration-"));
	const path = join(root, "memory.db");
	let store = new MemoryStore(path);
	try {
		store.record({ id: "legacy-objective", ownerKey: "owner", kind: "objective", title: "Legacy", status: "running", createdAt: 1 });
		store.recordRun({ id: "legacy-run", taskId: "legacy-objective", executor: "agent", status: "running", startedAt: 10, leaseExpiresAt: 20 });
		store.close();
		const raw = new Database(path);
		try { raw.prepare("UPDATE task_runs SET lease_expires_at = NULL WHERE id = ?").run("legacy-run"); }
		finally { raw.close(); }
		store = new MemoryStore(path);
		assert.equal(store.taskRuns("legacy-objective")[0].leaseExpiresAt, 30_010);
		assert.equal(store.reconcileExpiredTaskRuns(30_011).failed, 1);
		assert.equal(store.taskRuns("legacy-objective")[0].status, "failed");
	} finally { try { store.close(); } catch {} rmSync(root, { recursive: true, force: true }); }
});

test("two Runtimes sharing SQLite block a post-cancellation mutation until the durable holder converges", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-objective-cross-runtime-boundary-"));
	const path = join(root, "memory.db");
	const first = new MemoryStore(path);
	const second = new MemoryStore(path);
	const source = { platform: "cli", chatId: "cross-runtime", chatType: "dm", userId: "user" };
	const ownerKey = "cli:cross-runtime:user";
	const objectiveId = "cross-runtime-objective";
	let releaseSecond;
	const continueSecond = new Promise((resolve) => { releaseSecond = resolve; });
	let firstBoundaryResolve;
	const firstBoundary = new Promise((resolve) => { firstBoundaryResolve = resolve; });
	let secondBoundary;
	const mutation = { name: "mutate", label: "Mutate", description: "Mutate", parameters: {}, beemaxPolicy: MUTATING_TOOL_POLICY, execute: async () => ({ content: [], details: {} }) };
	const session = () => {
		let listener;
		const active = new Set([mutation.name]);
		const agent = { state: { model: { id: "test" }, messages: [], tools: [mutation] }, beforeToolCall: undefined };
		return {
			agent,
			subscribe: (next) => { listener = next; return () => undefined; },
			getAllTools: () => [mutation], getToolDefinition: () => mutation,
			getActiveToolNames: () => [...active], setActiveToolsByName: (names) => { active.clear(); for (const name of names) active.add(name); },
			prompt: async () => {
				const message = (id) => ({ type: "message_end", message: { role: "assistant", responseId: `response:${id}`, content: [{ type: "toolCall", id, name: mutation.name, arguments: {} }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
				listener(message("mutation-1"));
				listener({ type: "tool_execution_start", toolCallId: "mutation-1", toolName: mutation.name, args: {} });
				assert.equal(await agent.beforeToolCall({ assistantMessage: {}, toolCall: { id: "mutation-1", name: mutation.name, arguments: {} }, args: {}, context: {} }), undefined);
				firstBoundaryResolve();
				await continueSecond;
				listener(message("mutation-2"));
				listener({ type: "tool_execution_start", toolCallId: "mutation-2", toolName: mutation.name, args: {} });
				secondBoundary = await agent.beforeToolCall({ assistantMessage: {}, toolCall: { id: "mutation-2", name: mutation.name, arguments: {} }, args: {}, context: {} });
				agent.state.messages.push({ role: "assistant", content: [{ type: "text", text: "stopped" }], usage: { input: 1, output: 1 } });
			},
			abort: async () => undefined, dispose: () => undefined,
		};
	};
	let runtimeA; let runtimeB;
	try {
		first.record({ id: objectiveId, ownerKey, kind: "objective", title: "Cross Runtime", description: "continue durable work", status: "running", createdAt: 1 });
		runtimeA = new BeeMaxAgentRuntime({ profileId: "profile:test", taskLedger: first, workContractBuilder: new DeterministicWorkContractBuilder(), createAgent: async () => session() });
		runtimeB = new BeeMaxAgentRuntime({
			profileId: "profile:test", taskLedger: second, workContractBuilder: new DeterministicWorkContractBuilder(), objectiveInterruptionTimeoutMs: 500,
			interruptObjectiveWork: async (_runtimeSource, cancellation) => ({ interruptedEffects: 0, pendingExecutions: second.objectiveInterruptionConvergence(ownerKey, cancellation.objectiveId).pendingExecutions }),
			createAgent: async () => { const agent = { state: { model: { id: "test" }, messages: [] } }; return { agent, subscribe: () => () => undefined, prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined }; },
		});
		const running = runtimeA.run({ source, text: "继续这个任务", objectiveTaskId: objectiveId, allowedCapabilities: [mutation.name], timeoutMs: 5_000 });
		await firstBoundary;
		const cancelled = await runtimeB.run({ source, text: "取消这个任务", timeoutMs: 2_000 });
		assert.match(cancelled.answer, /requires reconciliation|await convergence/i);
		assert.equal(second.pendingObjectiveInterruptions([ownerKey]).length, 1);
		releaseSecond();
		await assert.rejects(running, /Durable Task Run execution authority was lost/i);
		assert.equal(secondBoundary?.block, true);
		assert.match(secondBoundary?.reason ?? "", /cancelled|holder.*no longer active|no active durable Execution Holder authority/i);
		assert.equal(second.pendingObjectiveInterruptions([ownerKey]).length, 1, "pending must remain until a claimed retry observes holder convergence");
		await runtimeB.run({ source, text: "现在几点", timeoutMs: 2_000 });
		assert.deepEqual(second.pendingObjectiveInterruptions([ownerKey]), []);
	} finally { runtimeA?.dispose(); runtimeB?.dispose(); first.close(); second.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Objective interruption remains durable until runtime settlement without replacing its cancelled Terminal Outcome", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-objective-interruption-durable-"));
	const path = join(root, "memory.db");
	const ownerKey = "owner";
	const expectedInterruption = {
		ownerKey,
		objectiveId: "interrupted-objective",
		taskIds: ["interrupted-objective", "interrupted-child"],
		planIds: ["interrupted-plan"],
		retry: true,
	};
	let store = new MemoryStore(path);
	try {
		store.record({ id: "interrupted-objective", ownerKey, kind: "objective", title: "Interrupted Objective", status: "running", createdAt: 1 });
		store.recordPlan([
			{ id: "interrupted-child", ownerKey, kind: "delegated", title: "Interrupted Child", status: "running", parentId: "interrupted-objective", planId: "interrupted-plan", createdAt: 2 },
		], [], { id: "interrupted-plan", ownerKey, title: "Interrupted Plan", status: "running", taskCount: 1, succeeded: 0, failed: 0, cancelled: 0, verified: 0, correctiveAttempts: 0, createdAt: 2 });

		assert.ok(store.cancelObjective(ownerKey, "interrupted-objective", 10));
		assert.deepEqual(store.pendingObjectiveInterruptions([ownerKey]), [expectedInterruption]);
		assert.equal(store.failObjectiveInterruption(ownerKey, "interrupted-objective", "Provider failed with Authorization: Bearer abcdefghijklmnopqrstuvwxyz", 11), true);

		store.close();
		store = new MemoryStore(path);
		assert.deepEqual(store.pendingObjectiveInterruptions([ownerKey]), [expectedInterruption]);
		assert.equal(store.queryTasks({ ownerKeys: [ownerKey], id: "interrupted-objective" })[0].error, "Cancelled by user; runtime interruption pending: [credential details redacted]");

		assert.equal(store.settleObjectiveInterruption(ownerKey, "interrupted-objective", 12), true);
		assert.deepEqual(store.pendingObjectiveInterruptions([ownerKey]), []);
		const settled = store.queryTasks({ ownerKeys: [ownerKey], id: "interrupted-objective" })[0];
		assert.deepEqual({ status: settled.status, error: settled.error }, { status: "cancelled", error: "Cancelled by user" });
	} finally { try { store.close(); } catch {} rmSync(root, { recursive: true, force: true }); }
});

test("active Objective Plan lookup is not truncated by newer terminal Task history", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-objective-plan-lookup-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.record({ id: "objective", ownerKey: "owner", kind: "objective", title: "Live", status: "pending", createdAt: 1 });
		store.recordPlan([{ id: "child", ownerKey: "owner", kind: "delegated", title: "Child", status: "pending", parentId: "objective", planId: "plan", createdAt: 2 }], [], { id: "plan", ownerKey: "owner", title: "Plan", status: "pending", taskCount: 1, succeeded: 0, failed: 0, cancelled: 0, verified: 0, correctiveAttempts: 0, createdAt: 2 });
		for (let index = 0; index < 120; index++) store.record({ id: `noise-${index}`, ownerKey: "owner", kind: "delegated", title: "Noise", status: "succeeded", createdAt: 100 + index, finishedAt: 100 + index });
		assert.deepEqual(store.activeObjectivePlanIds("owner"), ["plan"]);
		assert.equal(store.cancelObjectives("owner"), 1);
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: "objective" })[0].status, "cancelled");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Verification unavailable persists across Profile database restarts", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-verification-unavailable-"));
	const path = join(root, "memory.db");
	let store = new MemoryStore(path);
	try {
		const graph = new TaskGraph(store);
		graph.createPlan({ id: "verification-plan", ownerKey: "cli:local:local", tasks: [{ id: "verification-task", title: "Verify", acceptanceCriteria: "Passes an independent check" }] }, 10);
		await graph.run(["cli:local:local"], "verification-plan", async () => ({ output: "candidate" }), { verify: async () => { throw new Error("verifier offline"); } });
		store.close();
		store = new MemoryStore(path);
		const task = store.queryTasks({ ownerKeys: ["cli:local:local"], id: "verification-task" })[0];
		assert.equal(task.verificationStatus, "unavailable");
		assert.equal(task.result, undefined);
		assert.equal(task.candidateResult, "candidate");
		assert.deepEqual(task.criterionVerifications, [{
			criterionId: "C1", criterion: "Passes an independent check", status: "unavailable", evidence: "verifier offline", evidenceRefs: [],
		}]);
		assert.equal(store.taskRuns("verification-task")[0].output, "candidate");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Verification Retry promotes a Candidate Result without replaying Task execution", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-verification-retry-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const graph = new TaskGraph(store);
		graph.createPlan({ id: "retry-verification-plan", ownerKey: "cli:local:local", tasks: [{ id: "retry-verification-task", title: "Verify", acceptanceCriteria: "Passes an independent check" }] }, 10);
		await graph.run(["cli:local:local"], "retry-verification-plan", async () => ({ output: "candidate" }), { verify: async () => { throw new Error("verifier offline"); } });
		let executions = 0;
		const runner = new TaskRecoveryRunner(store, async () => { executions++; return { output: "replayed" }; }, undefined, async (_task, result) => ({
			accepted: result.output === "candidate", evidence: "candidate checked",
			criterionVerifications: [{ criterionId: "C1", criterion: "Passes an independent check", status: "accepted", evidence: "candidate checked", evidenceRefs: ["tool-call:retry-read"] }],
		}));
		assert.deepEqual(await runner.reverify(["cli:local:local"], "retry-verification-plan"), { attempted: 1, accepted: 1, rejected: 0, unavailable: 0 });
		assert.equal(executions, 0);
		const task = store.queryTasks({ ownerKeys: ["cli:local:local"], id: "retry-verification-task" })[0];
		assert.deepEqual({ status: task.status, verificationStatus: task.verificationStatus, result: task.result, candidateResult: task.candidateResult, evidence: task.evidence }, { status: "succeeded", verificationStatus: "accepted", result: "candidate", candidateResult: undefined, evidence: "candidate checked" });
		assert.deepEqual(task.criterionVerifications, [{ criterionId: "C1", criterion: "Passes an independent check", status: "accepted", evidence: "candidate checked", evidenceRefs: ["tool-call:retry-read"] }]);
		const plan = store.queryTaskPlans({ ownerKeys: ["cli:local:local"], id: "retry-verification-plan" })[0];
		assert.deepEqual({ status: plan.status, succeeded: plan.succeeded, verified: plan.verified }, { status: "succeeded", succeeded: 1, verified: 1 });
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("criterion-level rejection receipts survive restart for corrective execution", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-criterion-verification-"));
	const path = join(root, "memory.db");
	let store = new MemoryStore(path);
	try {
		const graph = new TaskGraph(store);
		graph.createPlan({ id: "criterion-plan", ownerKey: "cli:local:local", tasks: [{
			id: "criterion-task", title: "Prepare verified report", acceptanceCriteria: "Report file exists\nDelivery receipt identifies the destination",
		}] }, 10);
		await graph.run(["cli:local:local"], "criterion-plan", async () => ({ output: "candidate report" }), { verify: async () => ({
			accepted: false,
			feedback: "Delivery was not observed",
			criterionVerifications: [
				{ criterionId: "C1", criterion: "Report file exists", status: "accepted", evidence: "The report was read", evidenceRefs: ["tool-call:read-report"] },
				{ criterionId: "C2", criterion: "Delivery receipt identifies the destination", status: "rejected", evidence: "No delivery was observed", evidenceRefs: ["tool-call:inspect-delivery"] },
			],
		}) });
		store.close();
		store = new MemoryStore(path);
		const task = store.queryTasks({ ownerKeys: ["cli:local:local"], id: "criterion-task" })[0];
		assert.equal(task.verificationStatus, "rejected");
		assert.equal(task.candidateResult, "candidate report");
		assert.deepEqual(task.criterionVerifications, [
			{ criterionId: "C1", criterion: "Report file exists", status: "accepted", evidence: "The report was read", evidenceRefs: ["tool-call:read-report"] },
			{ criterionId: "C2", criterion: "Delivery receipt identifies the destination", status: "rejected", evidence: "No delivery was observed", evidenceRefs: ["tool-call:inspect-delivery"] },
		]);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Verification Retry distinguishes rejected and still-unavailable Candidate Results", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-verification-retry-outcomes-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const graph = new TaskGraph(store);
		graph.createPlan({ id: "retry-outcomes-plan", ownerKey: "cli:local:local", tasks: [
			{ id: "rejected-candidate", title: "Rejected", acceptanceCriteria: "Must be accepted" },
			{ id: "offline-candidate", title: "Offline", acceptanceCriteria: "Must be checked" },
		] }, 10);
		await graph.run(["cli:local:local"], "retry-outcomes-plan", async (task) => ({ output: task.id }), { maxConcurrent: 1, verify: async () => { throw new Error("verifier offline"); } });
		let executions = 0;
		const runner = new TaskRecoveryRunner(store, async () => { executions++; return { output: "replayed" }; }, undefined, async (task) => {
			if (task.id === "offline-candidate") throw new Error("still offline");
			return { accepted: false, feedback: "Candidate is incomplete", criterionVerifications: [{ criterionId: "C1", criterion: "Must be accepted", status: "rejected", evidence: "candidate is incomplete", evidenceRefs: ["tool-call:retry-inspect"] }] };
		});
		assert.deepEqual(await runner.reverify(["cli:local:local"], "retry-outcomes-plan"), { attempted: 2, accepted: 0, rejected: 1, unavailable: 1 });
		assert.equal(executions, 0);
		const tasks = new Map(store.queryTasks({ ownerKeys: ["cli:local:local"], planIds: ["retry-outcomes-plan"] }).map((task) => [task.id, task]));
		assert.deepEqual({ status: tasks.get("rejected-candidate").verificationStatus, candidate: tasks.get("rejected-candidate").candidateResult }, { status: "rejected", candidate: "rejected-candidate" });
		assert.deepEqual(tasks.get("rejected-candidate").criterionVerifications, [{ criterionId: "C1", criterion: "Must be accepted", status: "rejected", evidence: "candidate is incomplete", evidenceRefs: ["tool-call:retry-inspect"] }]);
		assert.deepEqual({ status: tasks.get("offline-candidate").verificationStatus, candidate: tasks.get("offline-candidate").candidateResult }, { status: "unavailable", candidate: "offline-candidate" });
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("ordinary Task Plan retry verifies unavailable Candidate Results before execution replay", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-smart-task-retry-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		const graph = new TaskGraph(store);
		graph.createPlan({ id: "smart-retry-plan", ownerKey: "cli:local:local", tasks: [{
			id: "smart-retry-task", title: "Verify first", acceptanceCriteria: "Passes an independent check",
			recoveryPolicy: "safe_retry", idempotencyKey: "smart-retry-plan:task", executionScope: scope,
		}] }, 10);
		await graph.run(["cli:local:local"], "smart-retry-plan", async () => ({ output: "candidate" }), { verify: async () => { throw new Error("verifier offline"); } });
		let executions = 0;
		const runner = new TaskRecoveryRunner(store, async () => { executions++; return { output: "replayed" }; }, undefined, async (_task, result) => ({ accepted: result.output === "candidate", evidence: "candidate checked" }));
		assert.deepEqual(await runner.retry(["cli:local:local"], "smart-retry-plan"), {
			verification: { attempted: 1, accepted: 1, rejected: 0, unavailable: 0 },
			prepared: 0, plans: 0, succeeded: 0, failed: 0, cancelled: 0, blocked: [],
		});
		assert.equal(executions, 0);
		const task = store.queryTasks({ ownerKeys: ["cli:local:local"], id: "smart-retry-task" })[0];
		assert.deepEqual({ status: task.status, verificationStatus: task.verificationStatus, result: task.result }, { status: "succeeded", verificationStatus: "accepted", result: "candidate" });
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("ordinary Task Plan retry never replays a Candidate Result while verification remains unavailable", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-unavailable-task-retry-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		const graph = new TaskGraph(store);
		graph.createPlan({ id: "unavailable-retry-plan", ownerKey: "cli:local:local", tasks: [{
			id: "unavailable-retry-task", title: "Wait for verifier", acceptanceCriteria: "Passes an independent check",
			recoveryPolicy: "safe_retry", idempotencyKey: "unavailable-retry-plan:task", executionScope: scope,
		}] }, 10);
		await graph.run(["cli:local:local"], "unavailable-retry-plan", async () => ({ output: "candidate" }), { verify: async () => { throw new Error("verifier offline"); } });
		let executions = 0;
		const runner = new TaskRecoveryRunner(store, async () => { executions++; return { output: "replayed" }; }, undefined, async () => { throw new Error("still offline"); });
		assert.deepEqual(await runner.retry(["cli:local:local"], "unavailable-retry-plan"), {
			verification: { attempted: 1, accepted: 0, rejected: 0, unavailable: 1 },
			prepared: 0, plans: 0, succeeded: 0, failed: 0, cancelled: 0, blocked: [],
		});
		assert.equal(executions, 0);
		const task = store.queryTasks({ ownerKeys: ["cli:local:local"], id: "unavailable-retry-task" })[0];
		assert.deepEqual({ status: task.status, verificationStatus: task.verificationStatus, candidateResult: task.candidateResult }, { status: "running", verificationStatus: "unavailable", candidateResult: "candidate" });
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("ordinary Task Plan retry replays execution after Candidate Result rejection", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-rejected-task-retry-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		const graph = new TaskGraph(store);
		graph.createPlan({ id: "rejected-retry-plan", ownerKey: "cli:local:local", tasks: [{
			id: "rejected-retry-task", title: "Correct rejected work", acceptanceCriteria: "Output is corrected",
			recoveryPolicy: "safe_retry", idempotencyKey: "rejected-retry-plan:task", executionScope: scope,
		}] }, 10);
		await graph.run(["cli:local:local"], "rejected-retry-plan", async () => ({ output: "candidate" }), { verify: async () => { throw new Error("verifier offline"); } });
		let executions = 0;
		const contexts = [];
		const correctionTasks = [];
		const runner = new TaskRecoveryRunner(store, async (task, _signal, context) => { executions++; correctionTasks.push(task); contexts.push(context); return { output: "corrected" }; }, undefined, async (_task, result) => result.output === "corrected"
			? { accepted: true, evidence: "corrected output checked", criterionVerifications: [{ criterionId: "C1", criterion: "Output is corrected", status: "accepted", evidence: "corrected output checked", evidenceRefs: ["tool-call:corrected-read"] }] }
			: { accepted: false, feedback: "candidate is incomplete", criterionVerifications: [{ criterionId: "C1", criterion: "Output is corrected", status: "rejected", evidence: "candidate is incomplete", evidenceRefs: ["tool-call:candidate-read"] }] });
		assert.deepEqual(await runner.retry(["cli:local:local"], "rejected-retry-plan"), {
			verification: { attempted: 1, accepted: 0, rejected: 1, unavailable: 0 },
			prepared: 1, plans: 1, succeeded: 1, failed: 0, cancelled: 0, blocked: [],
		});
		assert.equal(executions, 1);
		assert.equal(contexts[0].verificationFeedback, "candidate is incomplete");
		assert.equal(contexts[0].previousResult, "candidate");
		assert.deepEqual(correctionTasks[0].criterionVerifications, [{ criterionId: "C1", criterion: "Output is corrected", status: "rejected", evidence: "candidate is incomplete", evidenceRefs: ["tool-call:candidate-read"] }]);
		const task = store.queryTasks({ ownerKeys: ["cli:local:local"], id: "rejected-retry-task" })[0];
		assert.deepEqual({ status: task.status, verificationStatus: task.verificationStatus, verificationFeedback: task.verificationFeedback, result: task.result, candidateResult: task.candidateResult }, { status: "succeeded", verificationStatus: "accepted", verificationFeedback: undefined, result: "corrected", candidateResult: undefined });
		assert.deepEqual(task.criterionVerifications, [{ criterionId: "C1", criterion: "Output is corrected", status: "accepted", evidence: "corrected output checked", evidenceRefs: ["tool-call:corrected-read"] }]);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("due Verification Retry evaluates retained Candidate Results without replaying Task execution", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-due-verification-retry-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const graph = new TaskGraph(store);
		graph.createPlan({ id: "due-verification-plan", ownerKey: "cli:local:local", tasks: [{ id: "due-verification-task", title: "Verify later", acceptanceCriteria: "Passes an independent check", executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } }] }, 10);
		await graph.run(["cli:local:local"], "due-verification-plan", async () => ({ output: "candidate" }), { verify: async () => { throw new Error("verifier offline"); } });
		let executions = 0;
		const runner = new TaskRecoveryRunner(store, async () => { executions++; return { output: "replayed" }; }, undefined, async (_task, result) => ({ accepted: result.output === "candidate", evidence: "candidate checked later" }));
		assert.deepEqual(await runner.reverifyDue(Date.now() + 24 * 60 * 60_000), { attempted: 1, accepted: 1, rejected: 0, unavailable: 0 });
		assert.equal(executions, 0);
		assert.equal(store.queryTasks({ ownerKeys: ["cli:local:local"], id: "due-verification-task" })[0].result, "candidate");
		assert.deepEqual(store.claimTaskPlanCompletionNotices("cli", Date.now() + 24 * 60 * 60_000, 10).map((notice) => notice.planId), ["due-verification-plan"]);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("due Verification Retry also completes a direct Objective without a Task Plan", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-direct-objective-verification-retry-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.record({ id: "direct-objective", ownerKey: "cli:local:local", kind: "objective", title: "Direct verified work", acceptanceCriteria: "Candidate is independently checked", status: "running", createdAt: 1, startedAt: 2, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } });
		store.transition("direct-objective", { status: "running", verificationStatus: "unavailable", candidateResult: "direct candidate", error: "verifier offline" });
		recordSucceededObjectiveRun(store, "direct-objective", "direct candidate");
		assert.equal(store.deferCandidateVerification(["cli:local:local"], "direct-objective", 10), true);
		assert.deepEqual(store.verificationCandidates(10 + 24 * 60 * 60_000, 10, ["already-attempted-plan"]).map((task) => task.id), ["direct-objective"]);
		let executions = 0; const notices = [];
		const runner = new TaskRecoveryRunner(store, async () => { executions++; return { output: "replayed" }; }, undefined, async (_task, result) => ({ accepted: result.output === "direct candidate", evidence: "direct candidate checked later" }), undefined, async (task, resolution) => { notices.push({ id: task.id, resolution }); });
		assert.deepEqual(await runner.reverifyDue(10 + 24 * 60 * 60_000), { attempted: 1, accepted: 1, rejected: 0, unavailable: 0 });
		assert.equal(executions, 0);
		assert.deepEqual(notices, [{ id: "direct-objective", resolution: { accepted: true, evidence: "direct candidate checked later" } }]);
		const objective = store.queryTasks({ ownerKeys: ["cli:local:local"], id: "direct-objective" })[0];
		assert.deepEqual({ status: objective.status, verificationStatus: objective.verificationStatus, candidateResult: objective.candidateResult, result: objective.result }, { status: "running", verificationStatus: "accepted", candidateResult: "direct candidate", result: undefined });
		assert.deepEqual(store.claimObjectiveCompletions("cli", 10 + 24 * 60 * 60_000).map(({ objectiveId }) => objectiveId), ["direct-objective"]);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("two recovery instances cannot verify the same direct Objective responsibility concurrently", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-direct-verification-claim-"));
	const path = join(root, "memory.db");
	const first = new MemoryStore(path);
	const second = new MemoryStore(path);
	try {
		first.record({ id: "direct-claimed", ownerKey: "owner", kind: "objective", title: "Direct work", acceptanceCriteria: "Candidate is checked", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } });
		first.transition("direct-claimed", { status: "running", verificationStatus: "unavailable", candidateResult: "candidate", error: "verifier offline" });
		recordSucceededObjectiveRun(first, "direct-claimed", "candidate");
		assert.equal(first.deferCandidateVerification(["owner"], "direct-claimed", 10), true);
		let verificationCalls = 0;
		let releaseVerification;
		const verificationReleased = new Promise((resolve) => { releaseVerification = resolve; });
		let firstVerificationEntered;
		const entered = new Promise((resolve) => { firstVerificationEntered = resolve; });
		const verify = async () => {
			verificationCalls++;
			firstVerificationEntered();
			await verificationReleased;
			return { accepted: true, evidence: "checked once" };
		};
		const firstRun = new TaskRecoveryRunner(first, async () => ({ output: "unused" }), undefined, verify).reverifyDue(10 + 24 * 60 * 60_000);
		await entered;
		const secondRun = new TaskRecoveryRunner(second, async () => ({ output: "unused" }), undefined, verify).reverifyDue(10 + 24 * 60 * 60_000);
		await new Promise((resolve) => setImmediate(resolve));
		releaseVerification();
		const results = await Promise.all([firstRun, secondRun]);
		assert.equal(verificationCalls, 1);
		assert.equal(results.reduce((total, result) => total + result.attempted, 0), 1);
		assert.equal(results.reduce((total, result) => total + result.accepted, 0), 1);
		const retained = first.queryTasks({ ownerKeys: ["owner"], id: "direct-claimed" })[0];
		assert.deepEqual({ status: retained.status, verificationStatus: retained.verificationStatus, candidateResult: retained.candidateResult }, { status: "running", verificationStatus: "accepted", candidateResult: "candidate" });
		assert.deepEqual(first.claimObjectiveCompletions("cli", 10 + 24 * 60 * 60_000).map(({ objectiveId }) => objectiveId), ["direct-claimed"]);
	} finally { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); }
});

test("restart preserves a candidate checkpoint and correction budget when Verification is interrupted", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-verification-interruption-"));
	const path = join(root, "memory.db");
	let store = new MemoryStore(path);
	try {
		store.record({ id: "interrupted-verification", ownerKey: "owner", kind: "objective", title: "Direct work", acceptanceCriteria: "Candidate is checked", status: "running", createdAt: 1, startedAt: 2, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } });
		store.recordRun({ id: "run-before-restart", taskId: "interrupted-verification", executor: "agent", status: "running", startedAt: 2, leaseExpiresAt: 20 });
		store.transition("interrupted-verification", { status: "running", verificationStatus: "pending", candidateResult: "preserved candidate", correctiveAttempts: 1 });
		assert.equal(store.checkpointTask("owner", "interrupted-verification", createTaskCheckpoint({ taskRunId: "run-before-restart", source: "candidate_outcome", at: 5, completed: ["candidate-outcome"], committedEffectIds: ["effect:observed"], evidenceRefs: ["receipt:source"], unresolvedIssues: [], nextSafeStep: "Verify the retained candidate." }), 5), true);
		assert.deepEqual(store.verificationCandidates(10).map((task) => task.id), []);
		store.close();
		store = new MemoryStore(path);
		assert.deepEqual(store.reconcileExpiredTaskRuns(21), { retried: 1, failed: 0, affectedPlans: [] });
		const recovered = store.queryTasks({ ownerKeys: ["owner"], id: "interrupted-verification" })[0];
		assert.deepEqual({ status: recovered.status, verificationStatus: recovered.verificationStatus, candidateResult: recovered.candidateResult, correctiveAttempts: recovered.correctiveAttempts }, { status: "running", verificationStatus: "unavailable", candidateResult: "preserved candidate", correctiveAttempts: 1 });
		assert.deepEqual(recovered.checkpoint.committedEffectIds, ["effect:observed"]);
		assert.deepEqual(recovered.criterionVerifications.map(({ criterionId, status }) => ({ criterionId, status })), [{ criterionId: "C1", status: "unavailable" }]);
		assert.deepEqual(store.verificationCandidates(21).map((task) => task.id), ["interrupted-verification"]);
		let executions = 0;
		const result = await new TaskRecoveryRunner(store, async () => { executions++; return { output: "must not replay" }; }, undefined, async (_task, candidate) => ({ accepted: candidate.output === "preserved candidate", evidence: "checked after restart" })).reverifyDue(21);
		assert.deepEqual(result, { attempted: 1, accepted: 0, rejected: 0, unavailable: 1 }, "a reconciled failed Run cannot authorize recovered delivery");
		assert.equal(executions, 0);
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: "interrupted-verification" })[0].verificationStatus, "unavailable");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("unavailable Verification Retry persists exponential backoff across recovery cycles", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-verification-backoff-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const graph = new TaskGraph(store);
		graph.createPlan({ id: "backoff-plan", ownerKey: "cli:local:local", tasks: [{ id: "backoff-task", title: "Back off", acceptanceCriteria: "Verifier is online" }] }, 10);
		await graph.run(["cli:local:local"], "backoff-plan", async () => ({ output: "candidate" }), { verify: async () => { throw new Error("verifier offline"); } });
		const first = store.queryTasks({ ownerKeys: ["cli:local:local"], id: "backoff-task" })[0];
		assert.equal(first.verificationAttempts, 1);
		assert.equal(first.finishedAt, undefined);
		assert.ok(first.verificationRetryAt > first.startedAt);
		let executions = 0;
		const runner = new TaskRecoveryRunner(store, async () => { executions++; return { output: "replayed" }; }, undefined, async () => { throw new Error("still offline"); });
		assert.deepEqual(await runner.reverifyDue(first.verificationRetryAt - 1), { attempted: 0, accepted: 0, rejected: 0, unavailable: 0 });
		assert.deepEqual(await runner.reverifyDue(first.verificationRetryAt), { attempted: 1, accepted: 0, rejected: 0, unavailable: 1 });
		const second = store.queryTasks({ ownerKeys: ["cli:local:local"], id: "backoff-task" })[0];
		assert.equal(second.verificationAttempts, 2);
		assert.equal(second.verificationRetryAt, first.verificationRetryAt + 2 * 60_000);
		assert.deepEqual(await runner.reverifyDue(first.verificationRetryAt + 1), { attempted: 0, accepted: 0, rejected: 0, unavailable: 0 });
		assert.equal(executions, 0);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("due Verification Retry does not starve later Plans behind a claimed ledger batch", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-verification-fairness-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		for (let index = 0; index < 101; index++) {
			const planId = `verification-fairness-plan-${index}`;
			const taskId = `verification-fairness-task-${index}`;
			new TaskGraph(store).createPlan({ id: planId, ownerKey: "cli:local:local", tasks: [{ id: taskId, title: `Verify ${index}`, acceptanceCriteria: "Candidate is accepted" }] }, index + 1);
			store.transition(taskId, { status: "running", startedAt: index + 1, verificationStatus: "pending" });
			store.transition(taskId, { status: "failed", finishedAt: index + 2, verificationStatus: "unavailable", candidateResult: `candidate-${index}`, error: "verifier offline" });
			if (index < 100) assert.equal(store.claimTaskPlanExecution("cli:local:local", planId, `other-${index}`, Date.now() + 60_000), true);
		}
		let executions = 0;
		const runner = new TaskRecoveryRunner(store, async () => { executions++; return { output: "replayed" }; }, undefined, async () => ({ accepted: true, evidence: "checked" }));
		assert.deepEqual(await runner.reverifyDue(Date.now()), { attempted: 1, accepted: 1, rejected: 0, unavailable: 0 });
		assert.equal(executions, 0);
		assert.equal(store.queryTasks({ ownerKeys: ["cli:local:local"], id: "verification-fairness-task-100" })[0].status, "succeeded");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("one recovery cycle continues a DAG after automatic Verification accepts its upstream Candidate Result", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-verification-continuation-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		new TaskGraph(store).createPlan({
			id: "verification-continuation-plan", ownerKey: "cli:local:local",
			tasks: [
				{ id: "verified-upstream", title: "Research", acceptanceCriteria: "Research is verified", recoveryPolicy: "safe_retry", idempotencyKey: "continuation:upstream", executionScope: scope },
				{ id: "continued-downstream", title: "Write", recoveryPolicy: "safe_retry", idempotencyKey: "continuation:downstream", executionScope: scope },
			],
			dependencies: [{ taskId: "continued-downstream", dependsOn: "verified-upstream" }],
		}, 10);
		store.transition("verified-upstream", { status: "running", startedAt: 11, verificationStatus: "pending" });
		store.transition("verified-upstream", { status: "failed", finishedAt: 12, verificationStatus: "unavailable", candidateResult: "verified research", error: "verifier offline" });
		const executed = [];
		const runner = new TaskRecoveryRunner(store, async (task) => { executed.push(task.id); return { output: "final report" }; }, undefined, async () => ({ accepted: true, evidence: "independent check passed" }));
		const cycle = await new TaskRecoveryService(store, runner).runOnce({ maxConcurrent: 2 });
		assert.deepEqual(cycle, {
			reconciled: { retried: 0, failed: 0, affectedPlans: [] },
			verification: { attempted: 1, accepted: 1, rejected: 0, unavailable: 0 },
			recovery: { plans: 1, succeeded: 1, failed: 0, cancelled: 0, blocked: [] },
		});
		assert.deepEqual(executed, ["continued-downstream"]);
		assert.deepEqual(store.queryTasks({ ownerKeys: ["cli:local:local"], planIds: ["verification-continuation-plan"] }).map((task) => task.status), ["succeeded", "succeeded"]);
		assert.equal(store.queryTaskPlans({ ownerKeys: ["cli:local:local"], id: "verification-continuation-plan" })[0].status, "succeeded");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("one recovery cycle automatically corrects a rejected Candidate Result within its durable budget", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-automatic-correction-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		new TaskGraph(store).createPlan({ id: "automatic-correction-plan", ownerKey: "cli:local:local", tasks: [{
			id: "automatic-correction-task", title: "Correct candidate", acceptanceCriteria: "Includes a source",
			recoveryPolicy: "safe_retry", idempotencyKey: "automatic-correction:task", executionScope: scope,
		}] }, 10);
		store.transition("automatic-correction-task", { status: "running", startedAt: 11, verificationStatus: "pending" });
		store.transition("automatic-correction-task", { status: "failed", finishedAt: 12, verificationStatus: "unavailable", candidateResult: "", error: "verifier offline" });
		const contexts = [];
		const runner = new TaskRecoveryRunner(store, async (_task, _signal, context) => { contexts.push(context); return { output: "supported [source]" }; }, undefined, async (_task, result) => result.output?.includes("[source]")
			? { accepted: true, evidence: "source checked" }
			: { accepted: false, feedback: "Add a primary source" });
		assert.deepEqual(await new TaskRecoveryService(store, runner).runOnce({ maxCorrectiveAttempts: 1 }), {
			reconciled: { retried: 0, failed: 0, affectedPlans: [] },
			verification: { attempted: 1, accepted: 0, rejected: 1, unavailable: 0 },
			recovery: { plans: 1, succeeded: 1, failed: 0, cancelled: 0, blocked: [] },
		});
		assert.deepEqual(contexts.map(({ attempt, verificationFeedback, previousResult }) => ({ attempt, verificationFeedback, previousResult })), [{ attempt: 2, verificationFeedback: "Add a primary source", previousResult: "" }]);
		const task = store.queryTasks({ ownerKeys: ["cli:local:local"], id: "automatic-correction-task" })[0];
		assert.deepEqual({ status: task.status, result: task.result, correctiveAttempts: task.correctiveAttempts }, { status: "succeeded", result: "supported [source]", correctiveAttempts: 1 });
		const notices = store.claimTaskPlanCompletionNotices("cli", Date.now(), 10, 1_000);
		assert.deepEqual(notices.map(({ planId, planStatus, target }) => ({ planId, planStatus, target })), [{ planId: "automatic-correction-plan", planStatus: "succeeded", target: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } }]);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("automatic Corrective Attempts stop permanently when the durable budget is exhausted", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-correction-budget-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		new TaskGraph(store).createPlan({ id: "correction-budget-plan", ownerKey: "cli:local:local", tasks: [{
			id: "correction-budget-task", title: "Bound correction", acceptanceCriteria: "Must pass",
			recoveryPolicy: "safe_retry", idempotencyKey: "correction-budget:task", executionScope: scope,
		}] }, 10);
		store.transition("correction-budget-task", { status: "running", startedAt: 11, verificationStatus: "pending" });
		store.transition("correction-budget-task", { status: "failed", finishedAt: 12, verificationStatus: "unavailable", candidateResult: "first candidate", error: "verifier offline" });
		let executions = 0;
		const runner = new TaskRecoveryRunner(store, async () => { executions++; return { output: "still rejected" }; }, undefined, async () => ({ accepted: false, feedback: "Still incomplete" }));
		const service = new TaskRecoveryService(store, runner);
		const first = await service.runOnce({ maxCorrectiveAttempts: 1 });
		assert.deepEqual(first.recovery, { plans: 1, succeeded: 0, failed: 1, cancelled: 0, blocked: [] });
		assert.equal(executions, 1);
		const exhausted = store.queryTasks({ ownerKeys: ["cli:local:local"], id: "correction-budget-task" })[0];
		assert.deepEqual({ status: exhausted.status, verificationStatus: exhausted.verificationStatus, correctiveAttempts: exhausted.correctiveAttempts }, { status: "failed", verificationStatus: "rejected", correctiveAttempts: 1 });
		const second = await service.runOnce({ maxCorrectiveAttempts: 1 });
		assert.deepEqual(second.recovery, { plans: 0, succeeded: 0, failed: 0, cancelled: 0, blocked: [] });
		assert.equal(executions, 1);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("automatic correction never executes a rejected Task without complete safe-retry authority", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-unsafe-correction-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		new TaskGraph(store).createPlan({ id: "unsafe-correction-plan", ownerKey: "cli:local:local", tasks: [{ id: "unsafe-correction-task", title: "Unsafe correction", acceptanceCriteria: "Must pass" }] }, 10);
		store.transition("unsafe-correction-task", { status: "running", startedAt: 11, verificationStatus: "pending" });
		store.transition("unsafe-correction-task", { status: "failed", finishedAt: 12, verificationStatus: "unavailable", candidateResult: "candidate", error: "verifier offline" });
		let executions = 0;
		const runner = new TaskRecoveryRunner(store, async () => { executions++; return { output: "must not run" }; }, undefined, async () => ({ accepted: false, feedback: "Rejected" }));
		const cycle = await new TaskRecoveryService(store, runner).runOnce({ maxCorrectiveAttempts: 1 });
		assert.deepEqual(cycle.verification, { attempted: 1, accepted: 0, rejected: 1, unavailable: 0 });
		assert.deepEqual(cycle.recovery, { plans: 0, succeeded: 0, failed: 0, cancelled: 0, blocked: [] });
		assert.equal(executions, 0);
		assert.equal(store.queryTasks({ ownerKeys: ["cli:local:local"], id: "unsafe-correction-task" })[0].status, "failed");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task Plan Completion Notice Outbox is idempotent and reclaims an expired delivery lease", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-plan-notice-outbox-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "feishu", channelInstanceId: "company-a", chatId: "chat", chatType: "dm", userId: "user", threadId: "thread" };
		const graph = new TaskGraph(store);
		graph.createPlan({ id: "notice-plan", ownerKey: "feishu:chat:user", title: "Background report", tasks: [{ id: "notice-task", title: "Report", executionScope: scope }] }, 10);
		await graph.run(["feishu:chat:user"], "notice-plan", async () => ({ output: "private result" }));
		assert.equal(store.enqueueTaskPlanCompletionNotice("feishu:chat:user", "notice-plan", 100), true);
		assert.equal(store.enqueueTaskPlanCompletionNotice("feishu:chat:user", "notice-plan", 101), false);
		assert.deepEqual(store.claimTaskPlanCompletionNotices("cli", 100, 10, 50), []);
		const first = store.claimTaskPlanCompletionNotices("feishu", 100, 10, 50);
		assert.equal(first.length, 1);
		assert.deepEqual({ planId: first[0].planId, planStatus: first[0].planStatus, title: first[0].title, target: first[0].target, attempts: first[0].attempts }, {
			planId: "notice-plan", planStatus: "succeeded", title: "Background report", target: { platform: "feishu", channelInstanceId: "company-a", chatId: "chat", chatType: "dm", userId: "user", threadId: "thread" }, attempts: 1,
		});
		assert.equal(JSON.stringify(first[0]).includes("private result"), false);
		assert.deepEqual(store.claimTaskPlanCompletionNotices("feishu", 149, 10, 50), []);
		const reclaimed = store.claimTaskPlanCompletionNotices("feishu", 150, 10, 50);
		assert.equal(reclaimed.length, 1);
		assert.notEqual(reclaimed[0].claimToken, first[0].claimToken);
		assert.equal(store.failTaskPlanCompletionNotice(first[0].id, first[0].claimToken, 150), false);
		assert.equal(store.completeTaskPlanCompletionNotice(reclaimed[0].id, reclaimed[0].claimToken), true);
		assert.deepEqual(store.claimTaskPlanCompletionNotices("feishu", 1_000, 10, 50), []);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Objective Completion Outbox keeps accepted work nonterminal until one durable Delivery Receipt", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-objective-completion-outbox-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "feishu", channelInstanceId: "company-a", chatId: "chat", chatType: "thread", userId: "user", threadId: "thread", originMessageId: "om-event", replyToMessageId: "om-thread-root" };
		store.record({ id: "direct-objective", ownerKey: "feishu:chat:user", kind: "objective", title: "Verified report", status: "running", createdAt: 1, startedAt: 2, executionScope: scope });
		store.transition("direct-objective", { status: "running", candidateResult: "final report", evidence: "verification:1", verificationStatus: "accepted" });
		recordSucceededObjectiveRun(store, "direct-objective", "final report");

		assert.equal(store.enqueueObjectiveCompletion("feishu:chat:user", "direct-objective", 100), true);
		assert.equal(store.enqueueObjectiveCompletion("feishu:chat:user", "direct-objective", 101), true, "idempotent ensure does not create a second row");
		assert.equal(store.queryTasks({ ownerKeys: ["feishu:chat:user"], id: "direct-objective" })[0].status, "running");
		const [completion] = store.claimObjectiveCompletions("feishu", 100, 10, 50);
		assert.deepEqual({ objectiveId: completion.objectiveId, target: completion.target, result: completion.result, attempts: completion.attempts }, {
			objectiveId: "direct-objective", target: { platform: "feishu", channelInstanceId: "company-a", chatId: "chat", chatType: "thread", userId: "user", threadId: "thread", replyToMessageId: "om-thread-root" }, result: "final report", attempts: 1,
		});
		assert.equal(completion.deliveryIdempotencyKey, interactionCompletionDeliveryKey("default", scope, scope.originMessageId));
		assert.equal(store.completeObjectiveCompletion(completion.id, completion.claimToken, { idempotencyKey: completion.deliveryIdempotencyKey, deliveredAt: 120, providerMessageId: "om-42" }, 121), true);
		const delivered = store.getObjectiveCompletion(completion.id);
		assert.deepEqual({ status: delivered.status, claimToken: delivered.claimToken, receipt: delivered.receipt }, {
			status: "delivered",
			claimToken: undefined,
			receipt: { idempotencyKey: completion.deliveryIdempotencyKey, deliveredAt: 120, providerMessageId: "om-42" },
		});
		const settled = store.queryTasks({ ownerKeys: ["feishu:chat:user"], id: "direct-objective" })[0];
		assert.deepEqual({ status: settled.status, result: settled.result, finishedAt: settled.finishedAt }, { status: "succeeded", result: "final report", finishedAt: 121 });
		assert.deepEqual(store.claimObjectiveCompletions("feishu", 1_000), []);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Direct Objective acceptance atomically settles its leased Run before another process can claim Completion", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-direct-objective-atomic-completion-"));
	const path = join(root, "memory.db");
	const first = new MemoryStore(path);
	const second = new MemoryStore(path);
	try {
		const ownerKey = "cli:local:local";
		first.record({ id: "atomic-objective", ownerKey, kind: "objective", title: "Atomic completion", status: "running", createdAt: 1, startedAt: 2, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } });
		first.recordRun({ id: "atomic-run", taskId: "atomic-objective", executor: "agent", status: "running", startedAt: 10, leaseExpiresAt: 200 });
		assert.deepEqual(second.claimObjectiveCompletions("cli", 50), [], "an unverified running Run is not deliverable");
		assert.equal(first.settleDirectObjectiveCompletion({ ownerKey, objectiveId: "atomic-objective", taskRunId: "atomic-run", candidateResult: "verified result", evidence: "receipt:verified" }, 100), true);
		const [completion] = second.claimObjectiveCompletions("cli", 100);
		assert.equal(completion.taskRunId, "atomic-run");
		assert.equal(completion.result, "verified result");
		assert.deepEqual(first.taskRuns("atomic-objective").map(({ id, status, output }) => ({ id, status, output })), [{ id: "atomic-run", status: "succeeded", output: "verified result" }]);
		assert.deepEqual({ verificationStatus: first.queryTasks({ ownerKeys: [ownerKey], id: "atomic-objective" })[0].verificationStatus, candidateResult: first.queryTasks({ ownerKeys: [ownerKey], id: "atomic-objective" })[0].candidateResult }, { verificationStatus: "accepted", candidateResult: "verified result" });
	} finally { second.close(); first.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Direct Objective atomic acceptance fails closed when its Run lease has expired", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-direct-objective-expired-lease-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const ownerKey = "cli:local:local";
		store.record({ id: "expired-objective", ownerKey, kind: "objective", title: "Expired", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm" } });
		store.recordRun({ id: "expired-run", taskId: "expired-objective", executor: "agent", status: "running", startedAt: 10, leaseExpiresAt: 100 });
		assert.equal(store.settleDirectObjectiveCompletion({ ownerKey, objectiveId: "expired-objective", taskRunId: "expired-run", candidateResult: "must not publish" }, 100), false);
		const objective = store.queryTasks({ ownerKeys: [ownerKey], id: "expired-objective" })[0];
		assert.deepEqual({ status: objective.status, verificationStatus: objective.verificationStatus, candidateResult: objective.candidateResult }, { status: "running", verificationStatus: undefined, candidateResult: undefined });
		assert.equal(store.taskRuns("expired-objective")[0].status, "running");
		assert.deepEqual(store.claimObjectiveCompletions("cli", 101), []);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Completion claim rejects an Outbox row after the Objective Candidate changes", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-objective-stale-candidate-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const ownerKey = "cli:local:local";
		store.record({ id: "stale-objective", ownerKey, kind: "objective", title: "Stale candidate", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm" } });
		store.recordRun({ id: "stale-run", taskId: "stale-objective", executor: "agent", status: "running", startedAt: 10, leaseExpiresAt: 200 });
		assert.equal(store.settleDirectObjectiveCompletion({ ownerKey, objectiveId: "stale-objective", taskRunId: "stale-run", candidateResult: "candidate-v1" }, 100), true);
		assert.equal(store.transition("stale-objective", { status: "running", candidateResult: "candidate-v2", verificationStatus: "accepted" }), true);
		assert.deepEqual(store.claimObjectiveCompletions("cli", 100), []);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("stale Completion claim tokens cannot mutate or terminalize a newer Objective Candidate", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-objective-stale-token-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const ownerKey = "cli:local:local";
		store.record({ id: "stale-token-objective", ownerKey, kind: "objective", title: "Stale token", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm" } });
		store.recordRun({ id: "stale-token-run", taskId: "stale-token-objective", executor: "agent", status: "running", startedAt: 10, leaseExpiresAt: 200 });
		assert.equal(store.settleDirectObjectiveCompletion({ ownerKey, objectiveId: "stale-token-objective", taskRunId: "stale-token-run", candidateResult: "candidate-v1" }, 100), true);
		const [completion] = store.claimObjectiveCompletions("cli", 100, 1, 50);
		assert.equal(store.transition("stale-token-objective", { status: "running", candidateResult: "candidate-v2", verificationStatus: "accepted" }), true);
		const receipt = { idempotencyKey: completion.deliveryIdempotencyKey, deliveredAt: 101 };
		assert.equal(store.recordObjectiveCompletionReceipt(completion.id, receipt, 101), false);
		assert.equal(store.renewObjectiveCompletion(completion.id, completion.claimToken, 200, 101), false);
		assert.equal(store.deferObjectiveCompletion(completion.id, completion.claimToken, 200, 101), false);
		assert.equal(store.failObjectiveCompletion(completion.id, completion.claimToken, 101), false);
		assert.equal(store.blockObjectiveCompletion(completion.id, completion.claimToken, "stale", 101), false);
		assert.equal(store.completeObjectiveCompletion(completion.id, completion.claimToken, receipt, 102), false);
		assert.equal(store.acknowledgeObjectiveCompletion(completion.id, receipt, 102), false);
		const objective = store.queryTasks({ ownerKeys: [ownerKey], id: "stale-token-objective" })[0];
		assert.deepEqual({ status: objective.status, candidateResult: objective.candidateResult }, { status: "running", candidateResult: "candidate-v2" });
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Objective Completion lease renewal is live, monotonic, and lineage fenced", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-objective-completion-renewal-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const ownerKey = "cli:local:local";
		store.record({ id: "renew-objective", ownerKey, kind: "objective", title: "Renew", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm" } });
		store.recordRun({ id: "renew-run", taskId: "renew-objective", executor: "agent", status: "running", startedAt: 10, leaseExpiresAt: 200 });
		assert.equal(store.settleDirectObjectiveCompletion({ ownerKey, objectiveId: "renew-objective", taskRunId: "renew-run", candidateResult: "verified" }, 100), true);
		const [completion] = store.claimObjectiveCompletions("cli", 100, 1, 50);
		assert.equal(store.renewObjectiveCompletion(completion.id, completion.claimToken, 200, 120), true);
		assert.equal(store.renewObjectiveCompletion(completion.id, completion.claimToken, 180, 130), false, "a lease cannot be shortened");
		assert.equal(store.renewObjectiveCompletion(completion.id, completion.claimToken, 300, 200), false, "an expired lease cannot be revived");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("recovery binds only the latest succeeded Objective Run and rejects an older matching output", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-objective-latest-run-lineage-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const ownerKey = "cli:local:local";
		store.record({ id: "latest-run-objective", ownerKey, kind: "objective", title: "Latest Run", acceptanceCriteria: "checked", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm" } });
		store.transition("latest-run-objective", { status: "running", candidateResult: "candidate-v1", verificationStatus: "unavailable" });
		for (const [id, output, finishedAt] of [["older-run", "candidate-v1", 20], ["newer-run", "candidate-v2", 30]]) {
			store.recordRun({ id, taskId: "latest-run-objective", executor: "agent", status: "running", startedAt: finishedAt - 1, leaseExpiresAt: Date.now() + 60_000 });
			assert.equal(store.transitionRun(id, { status: "succeeded", finishedAt, output }), true);
		}
		assert.equal(store.resolveCandidateVerification([ownerKey], "latest-run-objective", { accepted: true, evidence: "checked" }, 100), false);
		assert.equal(store.queryTasks({ ownerKeys: [ownerKey], id: "latest-run-objective" })[0].verificationStatus, "unavailable");
		assert.deepEqual(store.claimObjectiveCompletions("cli", 100), []);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Direct Objective recovery cannot accept a Candidate without an authoritative succeeded Run", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-objective-recovery-no-run-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const ownerKey = "cli:local:local";
		store.record({ id: "unproven-recovery", ownerKey, kind: "objective", title: "Unproven", acceptanceCriteria: "Candidate is checked", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm" } });
		store.transition("unproven-recovery", { status: "running", verificationStatus: "unavailable", candidateResult: "candidate" });
		assert.equal(store.resolveCandidateVerification([ownerKey], "unproven-recovery", { accepted: true, evidence: "verification only" }, 100), false);
		assert.equal(store.queryTasks({ ownerKeys: [ownerKey], id: "unproven-recovery" })[0].verificationStatus, "unavailable");
		assert.deepEqual(store.claimObjectiveCompletions("cli", 100), []);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("legacy Completion Outbox rows backfill only when a matching succeeded Objective Run proves lineage", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-objective-outbox-lineage-migration-"));
	const path = join(root, "memory.db");
	const legacy = new Database(path);
	legacy.exec(`CREATE TABLE objective_completion_outbox (
		id TEXT PRIMARY KEY, objective_id TEXT NOT NULL UNIQUE, owner_key TEXT NOT NULL, plan_id TEXT,
		platform TEXT NOT NULL, channel_instance_id TEXT, chat_id TEXT NOT NULL, chat_type TEXT, user_id TEXT, thread_id TEXT, reply_to_message_id TEXT,
		title TEXT NOT NULL, result TEXT NOT NULL, evidence TEXT, delivery_idempotency_key TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('queued', 'delivering', 'delivered', 'blocked')), claim_token TEXT,
		attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
		receipt_idempotency_key TEXT, receipt_delivered_at INTEGER, receipt_provider_message_id TEXT,
		created_at INTEGER NOT NULL, blocked_at INTEGER, last_error TEXT
	)`);
	legacy.close();
	let store = new MemoryStore(path);
	try {
		const ownerKey = "cli:local:local";
		for (const id of ["legacy-proven", "legacy-unproven"]) {
			store.record({ id, ownerKey, kind: "objective", title: id, status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } });
			store.transition(id, { status: "running", candidateResult: `${id}-result`, verificationStatus: "accepted" });
		}
		const authoritativeRunId = recordSucceededObjectiveRun(store, "legacy-proven", "legacy-proven-result", "legacy-proven-run");
		store.close();
		const migrated = new Database(path);
		const insert = migrated.prepare(`INSERT INTO objective_completion_outbox
			(id, objective_id, owner_key, platform, chat_id, chat_type, user_id, title, result, delivery_idempotency_key, status, attempts, next_attempt_at, created_at)
			VALUES (?, ?, ?, 'cli', 'local', 'dm', 'local', ?, ?, ?, 'queued', 0, 10, 10)`);
		for (const id of ["legacy-proven", "legacy-unproven"]) insert.run(`objective-completion:${id}`, id, ownerKey, id, `${id}-result`, `objective-completion:${id}`);
		migrated.close();
		store = new MemoryStore(path);
		const claimed = store.claimObjectiveCompletions("cli", 100);
		assert.deepEqual(claimed.map(({ objectiveId, taskRunId }) => ({ objectiveId, taskRunId })), [{ objectiveId: "legacy-proven", taskRunId: authoritativeRunId }]);
		assert.equal(store.getObjectiveCompletion("objective-completion:legacy-unproven"), undefined);
	} finally { try { store.close(); } catch {} rmSync(root, { recursive: true, force: true }); }
});

test("Objective cancellation fences Completion delivery and retains a matching late Receipt", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-objective-completion-cancel-race-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const ownerKey = "feishu:chat:user";
		store.record({ id: "cancelled-delivery", ownerKey, kind: "objective", title: "Cancel delivery", status: "running", createdAt: 1, executionScope: { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" } });
		store.transition("cancelled-delivery", { status: "running", candidateResult: "verified result", verificationStatus: "accepted" });
		recordSucceededObjectiveRun(store, "cancelled-delivery", "verified result");
		assert.equal(store.enqueueObjectiveCompletion(ownerKey, "cancelled-delivery", 10), true);
		const [claimed] = store.claimObjectiveCompletions("feishu", 10, 1, 50);
		assert.ok(claimed.claimToken);
		assert.deepEqual(store.cancelObjective(ownerKey, "cancelled-delivery", 20), { ownerKey, objectiveId: "cancelled-delivery", taskIds: ["cancelled-delivery"], planIds: [] });
		assert.deepEqual(store.claimObjectiveCompletions("feishu", 1_000), []);
		assert.equal(store.completeObjectiveCompletion(claimed.id, claimed.claimToken, { idempotencyKey: "wrong", deliveredAt: 21 }, 22), false);
		assert.equal(store.completeObjectiveCompletion(claimed.id, claimed.claimToken, { idempotencyKey: claimed.deliveryIdempotencyKey, deliveredAt: 21, providerMessageId: "om-after-cancel" }, 22), true);
		const outbox = store.getObjectiveCompletion(claimed.id);
		assert.deepEqual({ status: outbox.status, receipt: outbox.receipt }, { status: "blocked", receipt: { idempotencyKey: claimed.deliveryIdempotencyKey, deliveredAt: 21, providerMessageId: "om-after-cancel" } });
		assert.equal(store.queryTasks({ ownerKeys: [ownerKey], id: "cancelled-delivery" })[0].status, "cancelled");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Objective Completion worker retains a provider Receipt when cancellation wins after send", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-objective-completion-worker-cancel-race-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const ownerKey = "feishu:chat:user";
		store.record({ id: "worker-cancelled-delivery", ownerKey, kind: "objective", title: "Worker race", status: "running", createdAt: 1, executionScope: { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" } });
		store.transition("worker-cancelled-delivery", { status: "running", candidateResult: "verified result", verificationStatus: "accepted" });
		recordSucceededObjectiveRun(store, "worker-cancelled-delivery", "verified result");
		assert.equal(store.enqueueObjectiveCompletion(ownerKey, "worker-cancelled-delivery", 10), true);
		let sends = 0;
		const worker = new ObjectiveCompletionDeliveryService(store, { sendText: async (_target, _text, options) => {
			sends++;
			assert.ok(store.cancelObjective(ownerKey, "worker-cancelled-delivery", 11));
			return { idempotencyKey: options.idempotencyKey, deliveredAt: 12, providerMessageId: "om-race" };
		} }, { platform: "feishu" });
		assert.deepEqual(await worker.runOnce(10), { claimed: 1, delivered: 1, failed: 0, deferred: 0, blocked: 0 });
		assert.equal(sends, 1);
		const outbox = store.getObjectiveCompletion("objective-completion:worker-cancelled-delivery");
		assert.deepEqual({ status: outbox.status, receipt: outbox.receipt }, { status: "blocked", receipt: { idempotencyKey: outbox.deliveryIdempotencyKey, deliveredAt: 12, providerMessageId: "om-race" } });
		assert.deepEqual(store.claimObjectiveCompletions("feishu", 1_000), []);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Objective Completion worker does not confuse a permanent channel block with cancellation", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-objective-completion-channel-block-race-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const ownerKey = "feishu:chat:user";
		const objectiveId = "channel-blocked-delivery";
		store.record({ id: objectiveId, ownerKey, kind: "objective", title: "Channel block", status: "running", createdAt: 1, executionScope: { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" } });
		store.transition(objectiveId, { status: "running", candidateResult: "verified result", verificationStatus: "accepted" });
		recordSucceededObjectiveRun(store, objectiveId, "verified result");
		assert.equal(store.enqueueObjectiveCompletion(ownerKey, objectiveId, 10), true);
		const completionId = `objective-completion:${objectiveId}`;
		const worker = new ObjectiveCompletionDeliveryService(store, { sendText: async (_target, _text, options) => {
			const delivering = store.getObjectiveCompletion(completionId);
			assert.ok(delivering.claimToken);
			assert.equal(store.blockObjectiveCompletion(completionId, delivering.claimToken, "channel removed", 11), true);
			return { idempotencyKey: options.idempotencyKey, deliveredAt: 12, providerMessageId: "om-channel-block" };
		} }, { platform: "feishu" });
		assert.deepEqual(await worker.runOnce(10), { claimed: 1, delivered: 0, failed: 1, deferred: 0, blocked: 0 });
		const outbox = store.getObjectiveCompletion(completionId);
		assert.deepEqual({ status: outbox.status, error: outbox.error, providerMessageId: outbox.receipt.providerMessageId }, { status: "blocked", error: "channel removed", providerMessageId: "om-channel-block" });
		assert.equal(store.queryTasks({ ownerKeys: [ownerKey], id: objectiveId })[0].status, "running");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("permanently blocked Objective delivery retains accepted nonterminal responsibility", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-objective-completion-blocked-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.record({ id: "blocked-objective", ownerKey: "cli:local:local", kind: "objective", title: "Blocked", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm" } });
		store.transition("blocked-objective", { status: "running", candidateResult: "verified", verificationStatus: "accepted" });
		recordSucceededObjectiveRun(store, "blocked-objective", "verified");
		assert.equal(store.enqueueObjectiveCompletion("cli:local:local", "blocked-objective", 10), true);
		const [completion] = store.claimObjectiveCompletions("cli", 10);
		assert.equal(store.blockObjectiveCompletion(completion.id, completion.claimToken, "channel removed", 20), true);
		const blocked = store.getObjectiveCompletion(completion.id);
		assert.deepEqual({ status: blocked.status, claimToken: blocked.claimToken, blockedAt: blocked.blockedAt, error: blocked.error }, {
			status: "blocked",
			claimToken: undefined,
			blockedAt: 20,
			error: "channel removed",
		});
		assert.deepEqual(store.claimObjectiveCompletions("cli", 100), []);
		const retained = store.queryTasks({ ownerKeys: ["cli:local:local"], id: "blocked-objective" })[0];
		assert.deepEqual({ status: retained.status, verificationStatus: retained.verificationStatus, candidateResult: retained.candidateResult }, { status: "running", verificationStatus: "accepted", candidateResult: "verified" });
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Completion Outbox repairs the accepted-candidate crash window without replaying Pi", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-objective-completion-repair-"));
	const path = join(root, "memory.db");
	let store = new MemoryStore(path);
	try {
		store.record({ id: "interrupted-objective", ownerKey: "cli:local:local", kind: "objective", title: "Interrupted", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm" } });
		store.transition("interrupted-objective", { status: "running", candidateResult: "already verified", verificationStatus: "accepted" });
		recordSucceededObjectiveRun(store, "interrupted-objective", "already verified");
		store.close();
		store = new MemoryStore(path);
		const [completion] = store.claimObjectiveCompletions("cli", 100);
		assert.equal(completion.objectiveId, "interrupted-objective");
		assert.equal(completion.result, "already verified");
		assert.equal(store.queryTasks({ ownerKeys: ["cli:local:local"], id: "interrupted-objective" })[0].status, "running");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("two processes cannot deliver the same Objective Completion lease concurrently", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-objective-completion-claim-"));
	const path = join(root, "memory.db");
	const first = new MemoryStore(path);
	const second = new MemoryStore(path);
	try {
		first.record({ id: "claimed-objective", ownerKey: "owner", kind: "objective", title: "Claimed", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm" } });
		first.transition("claimed-objective", { status: "running", candidateResult: "verified", verificationStatus: "accepted" });
		recordSucceededObjectiveRun(first, "claimed-objective", "verified");
		assert.equal(first.enqueueObjectiveCompletion("owner", "claimed-objective", 10), true);
		const [claimed] = first.claimObjectiveCompletions("cli", 10, 1, 50);
		assert.ok(claimed.claimToken);
		assert.deepEqual(second.claimObjectiveCompletions("cli", 59, 1, 50), []);
		const [reclaimed] = second.claimObjectiveCompletions("cli", 60, 1, 50);
		assert.notEqual(reclaimed.claimToken, claimed.claimToken);
		assert.equal(first.completeObjectiveCompletion(claimed.id, claimed.claimToken, { idempotencyKey: claimed.deliveryIdempotencyKey, deliveredAt: 61 }, 61), false);
	} finally { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); }
});

test("planned Objective retries only channel delivery and terminalizes from its retained Receipt", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-planned-objective-completion-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const ownerKey = "feishu:chat:user";
		const scope = { platform: "feishu", channelInstanceId: "company-a", chatId: "chat", chatType: "dm", userId: "user" };
		store.record({ id: "planned-objective", ownerKey, kind: "objective", title: "Plan report", status: "running", createdAt: 1, executionScope: scope });
		const graph = new TaskGraph(store);
		graph.createPlan({ id: "completion-plan", ownerKey, tasks: [{ id: "completion-child", title: "Research", parentId: "planned-objective", acceptanceCriteria: "Child is independently verified", executionScope: scope }] }, 2);
		let executions = 0;
		await graph.run([ownerKey], "completion-plan", async () => { executions++; return { output: "verified child" }; }, { verify: async () => ({ accepted: true, evidence: "child receipt" }) });
		assert.equal(store.enqueueTaskPlanCompletionNotice(ownerKey, "completion-plan", 10), true);
		let synthesis = 0;
		const objectiveRuntime = new ObjectiveRuntime(store, async () => { synthesis++; return { result: "final planned report", evidence: "verified children" }; });
		const planPreparation = new TaskPlanNoticeDeliveryService(store, { sendText: async () => { assert.fail("successful Plan must not bypass Objective Completion Outbox"); } }, { platform: "feishu", deliverObjective: (notice, signal) => objectiveRuntime.settlePlanIfLinked(notice.ownerKey, notice.planId, notice.planStatus, signal) });
		assert.deepEqual(await planPreparation.runOnce(10), { claimed: 1, delivered: 1, failed: 0, deferred: 0 });
		assert.equal(store.queryTasks({ ownerKeys: [ownerKey], id: "planned-objective" })[0].status, "running");

		const deliveryNow = Date.now() + 1;
		let deliveryAttempts = 0;
		const deliveries = new ObjectiveCompletionDeliveryService(store, { sendText: async (_target, _text, options) => {
			deliveryAttempts++;
			if (deliveryAttempts === 1) throw new Error("transient channel outage");
			return { idempotencyKey: options.idempotencyKey, deliveredAt: 31_000, providerMessageId: "om-plan" };
		} }, { platform: "feishu" });
		assert.deepEqual(await deliveries.runOnce(deliveryNow), { claimed: 1, delivered: 0, failed: 1, deferred: 0, blocked: 0 });
		assert.deepEqual(await deliveries.runOnce(deliveryNow + 30_000), { claimed: 1, delivered: 1, failed: 0, deferred: 0, blocked: 0 });
		const objective = store.queryTasks({ ownerKeys: [ownerKey], id: "planned-objective" })[0];
		assert.deepEqual({ status: objective.status, result: objective.result, verificationStatus: objective.verificationStatus }, { status: "succeeded", result: "final planned report", verificationStatus: "accepted" });
		assert.equal(executions, 1);
		assert.equal(synthesis, 1);
		assert.equal(deliveryAttempts, 2);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("legacy Verification Status migrates additively into Verification Outcome", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-verification-migration-"));
	const path = join(root, "memory.db");
	const legacy = new Database(path);
	legacy.exec(`CREATE TABLE tasks (
		id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, description TEXT, acceptance_criteria TEXT,
		recovery_policy TEXT NOT NULL DEFAULT 'never', idempotency_key TEXT, execution_scope TEXT, status TEXT NOT NULL, parent_id TEXT, plan_id TEXT,
		evidence TEXT, verification_status TEXT CHECK (verification_status IN ('pending', 'accepted', 'rejected')), corrective_attempts INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, result TEXT, error TEXT, updated_at INTEGER NOT NULL DEFAULT 0
	)`);
	legacy.prepare("INSERT INTO tasks (id, owner_key, kind, title, status, verification_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("legacy-verified", "cli:local:local", "delegated", "Legacy", "succeeded", "accepted", 1);
	legacy.close();
	const store = new MemoryStore(path);
	try { assert.equal(store.queryTasks({ ownerKeys: ["cli:local:local"], id: "legacy-verified" })[0].verificationStatus, "accepted"); }
	finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("expired Task Run leases recover only explicitly idempotent safe-retry Tasks", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-recovery-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.record({ id: "safe", ownerKey: "cli:local:local", kind: "delegated", title: "Safe research", status: "running", recoveryPolicy: "safe_retry", idempotencyKey: "plan:safe", createdAt: 10, startedAt: 20 });
		store.recordRun({ id: "safe-run", taskId: "safe", executor: "subagent", status: "running", startedAt: 20, leaseExpiresAt: 100 });
		store.record({ id: "unsafe", ownerKey: "cli:local:local", kind: "delegated", title: "Unknown effect", status: "running", recoveryPolicy: "never", createdAt: 10, startedAt: 20 });
		store.recordRun({ id: "unsafe-run", taskId: "unsafe", executor: "subagent", status: "running", startedAt: 20, leaseExpiresAt: 100 });
		store.record({ id: "live", ownerKey: "cli:local:local", kind: "delegated", title: "Still leased", status: "running", recoveryPolicy: "safe_retry", idempotencyKey: "plan:live", createdAt: 10, startedAt: 20 });
		store.recordRun({ id: "live-run", taskId: "live", executor: "subagent", status: "running", startedAt: 20, leaseExpiresAt: 300 });
		store.record({ id: "effectful", ownerKey: "cli:local:local", kind: "delegated", title: "Effect already committed", status: "running", recoveryPolicy: "safe_retry", idempotencyKey: "plan:effectful", createdAt: 10, startedAt: 20 });
		store.recordRun({ id: "effectful-run", taskId: "effectful", executor: "subagent", status: "running", startedAt: 20, leaseExpiresAt: 100 });
		store.record({ id: "corrupt-effects", ownerKey: "cli:local:local", kind: "delegated", title: "Unreadable effects", status: "running", recoveryPolicy: "safe_retry", idempotencyKey: "plan:corrupt", createdAt: 10, startedAt: 20 });
		store.recordRun({ id: "corrupt-run", taskId: "corrupt-effects", executor: "subagent", status: "running", startedAt: 20, leaseExpiresAt: 100 });
		const raw = new Database(join(root, "memory.db"));
		raw.prepare("UPDATE tasks SET effect_receipts = ? WHERE id = ?").run(JSON.stringify([{ id: "effect-1", tool: "send", operation: "send message", sideEffect: "mutation", status: "committed", externalRef: "message-1", occurredAt: 50 }]), "effectful");
		raw.prepare("UPDATE tasks SET effect_receipts = ? WHERE id = ?").run("{broken", "corrupt-effects"); raw.close();
		assert.deepEqual(store.reconcileExpiredTaskRuns(200), { retried: 1, failed: 3, affectedPlans: [] });
		const tasks = new Map(store.queryTasks({ ownerKeys: ["cli:local:local"] }).map((task) => [task.id, task]));
		assert.equal(tasks.get("safe").status, "pending");
		store.transition("safe", { status: "running", startedAt: 210 });
		assert.equal(store.queryTasks({ ownerKeys: ["cli:local:local"], id: "safe" })[0].error, undefined);
		assert.equal(tasks.get("unsafe").status, "failed");
		assert.equal(tasks.get("live").status, "running");
		assert.equal(tasks.get("effectful").status, "failed");
		assert.match(tasks.get("effectful").error, /effect receipt/i);
		assert.match(tasks.get("corrupt-effects").error, /unreadable/i);
		assert.equal(store.taskRuns("safe")[0].status, "failed");
		assert.match(store.taskRuns("safe")[0].error, /interrupted/i);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("recovery reconciliation notifies an owner when an unsafe interrupted Plan settles without replay", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-interruption-notice-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" };
		new TaskGraph(store).createPlan({ id: "interruption-notice-plan", ownerKey: "feishu:chat:user", title: "Unsafe background work", tasks: [{ id: "interruption-notice-task", title: "External mutation", recoveryPolicy: "never", executionScope: scope }] }, 10);
		store.transition("interruption-notice-task", { status: "running", startedAt: 20 });
		store.recordRun({ id: "interruption-notice-run", taskId: "interruption-notice-task", executor: "subagent", status: "running", startedAt: 20, leaseExpiresAt: 100 });
		const runner = new TaskRecoveryRunner(store, async () => { throw new Error("must not replay"); });
		const cycle = await new TaskRecoveryService(store, runner).runOnce({ maxConcurrent: 2 });
		assert.equal(cycle.reconciled.failed, 1);
		assert.deepEqual(store.claimTaskPlanCompletionNotices("feishu", Date.now(), 10).map(({ planId, planStatus }) => ({ planId, planStatus })), [{ planId: "interruption-notice-plan", planStatus: "failed" }]);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("recovery reconciliation does not notify while an affected Plan still has pending work", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-interruption-pending-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" };
		new TaskGraph(store).createPlan({ id: "mixed-plan", ownerKey: "feishu:chat:user", tasks: [
			{ id: "mixed-failed", title: "Unsafe mutation", recoveryPolicy: "never", executionScope: scope },
			{ id: "mixed-pending", title: "Later work", recoveryPolicy: "safe_retry", idempotencyKey: "mixed:pending", executionScope: scope },
		] }, 10);
		store.transition("mixed-failed", { status: "failed", finishedAt: 20, error: "interrupted" });
		store.transitionPlan("mixed-plan", { status: "failed", taskCount: 2, succeeded: 0, failed: 1, cancelled: 0, verified: 0, correctiveAttempts: 0, finishedAt: 20 });
		const enqueued = new TaskRecoveryRunner(store, async () => ({ output: "unused" }))
			.enqueueSettledCompletionNotices([{ ownerKey: "feishu:chat:user", planId: "mixed-plan" }]);
		assert.equal(enqueued, 0);
		assert.deepEqual(store.claimTaskPlanCompletionNotices("feishu", Date.now(), 10), []);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("expired Task Run reconciliation keeps Task Plan Outcomes consistent", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-plan-reconciliation-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const graph = new TaskGraph(store);
		graph.createPlan({ id: "safe-plan", ownerKey: "cli:local:local", tasks: [{ id: "safe-plan-task", title: "Safe", recoveryPolicy: "safe_retry", idempotencyKey: "safe-plan:task" }] }, 10);
		graph.createPlan({ id: "unsafe-plan", ownerKey: "cli:local:local", tasks: [{ id: "unsafe-plan-task", title: "Unsafe" }] }, 10);
		const counts = { taskCount: 1, succeeded: 0, failed: 0, cancelled: 0, verified: 0, correctiveAttempts: 0 };
		for (const [planId, taskId, runId] of [["safe-plan", "safe-plan-task", "safe-plan-run"], ["unsafe-plan", "unsafe-plan-task", "unsafe-plan-run"]]) {
			assert.equal(store.transitionPlan(planId, { ...counts, status: "running", startedAt: 20 }), true);
			assert.equal(store.transition(taskId, { status: "running", startedAt: 20 }), true);
			store.recordRun({ id: runId, taskId, executor: "subagent", status: "running", startedAt: 20, leaseExpiresAt: 100 });
		}
		assert.deepEqual(store.reconcileExpiredTaskRuns(200), { retried: 1, failed: 1, affectedPlans: [
			{ ownerKey: "cli:local:local", planId: "safe-plan" },
			{ ownerKey: "cli:local:local", planId: "unsafe-plan" },
		] });
		const safePlan = store.queryTaskPlans({ ownerKeys: ["cli:local:local"], id: "safe-plan" })[0];
		const unsafePlan = store.queryTaskPlans({ ownerKeys: ["cli:local:local"], id: "unsafe-plan" })[0];
		assert.deepEqual({ status: safePlan.status, failed: safePlan.failed }, { status: "pending", failed: 0 });
		assert.deepEqual({ status: unsafePlan.status, failed: unsafePlan.failed }, { status: "failed", failed: 1 });
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task recovery runner resumes only durable safe DAG candidates with an Execution Scope", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-resume-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local", threadId: "recovery" };
		store.recordPlan([
			{ id: "done", ownerKey: "cli:local#recovery:local", kind: "delegated", title: "Done", status: "succeeded", planId: "plan", createdAt: 1, finishedAt: 2 },
			{ id: "resume", ownerKey: "cli:local#recovery:local", kind: "delegated", title: "Resume", description: "finish research", status: "pending", planId: "plan", recoveryPolicy: "safe_retry", idempotencyKey: "plan:resume", executionScope: scope, createdAt: 1 },
			{ id: "unsafe", ownerKey: "cli:local#recovery:local", kind: "delegated", title: "Do not resume", status: "pending", planId: "plan", createdAt: 1 },
		], [{ taskId: "resume", dependsOn: "done" }]);
		const executed = [];
		const result = await new TaskRecoveryRunner(store, async (task) => { executed.push(task.description); return { output: "recovered" }; }).run();
		assert.deepEqual(result, { plans: 1, succeeded: 1, failed: 0, cancelled: 0, blocked: [] });
		assert.deepEqual(executed, ["finish research"]);
		assert.equal(store.queryTasks({ ownerKeys: ["cli:local#recovery:local"], id: "resume" })[0].result, "recovered");
		assert.equal(store.queryTasks({ ownerKeys: ["cli:local#recovery:local"], id: "unsafe" })[0].status, "pending");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a recovery runner skips a durable Task Plan claimed by another executor", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-recovery-claim-"));
	const path = join(root, "memory.db");
	const first = new MemoryStore(path);
	const second = new MemoryStore(path);
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		new TaskGraph(first).createPlan({ id: "claimed-recovery-plan", ownerKey: "cli:local:local", tasks: [{ id: "claimed", title: "Claimed", recoveryPolicy: "safe_retry", idempotencyKey: "claimed-recovery-plan:claimed", executionScope: scope }] }, 1);
		assert.equal(first.claimTaskPlanExecution("cli:local:local", "claimed-recovery-plan", "other-executor", Date.now() + 60_000), true);
		let executions = 0;
		assert.deepEqual(await new TaskRecoveryRunner(second, async () => { executions++; return { output: "duplicate" }; }).run(), { plans: 0, succeeded: 0, failed: 0, cancelled: 0, blocked: [] });
		assert.equal(executions, 0);
		assert.equal(second.queryTasks({ ownerKeys: ["cli:local:local"], id: "claimed" })[0].status, "pending");
	} finally { second.close(); first.close(); rmSync(root, { recursive: true, force: true }); }
});

test("startup recovery drains more Task Plans than one ledger batch", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-recovery-batches-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		const graph = new TaskGraph(store);
		for (let index = 0; index < 101; index++) graph.createPlan({
			id: `batch-plan-${index}`, ownerKey: "cli:local:local",
			tasks: [{ id: `batch-task-${index}`, title: `Task ${index}`, recoveryPolicy: "safe_retry", idempotencyKey: `batch:${index}`, executionScope: scope }],
		}, index + 1);
		const result = await new TaskRecoveryRunner(store, async () => ({ output: "recovered" })).run({ maxConcurrent: 20 });
		assert.deepEqual(result, { plans: 101, succeeded: 101, failed: 0, cancelled: 0, blocked: [] });
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("blocked Task Plans do not starve later startup recovery batches", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-recovery-blocked-batch-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		const graph = new TaskGraph(store);
		for (let index = 0; index < 100; index++) graph.createPlan({
			id: `blocked-plan-${index}`, ownerKey: "cli:local:local",
			tasks: [
				{ id: `unsafe-${index}`, title: "Unsafe prerequisite" },
				{ id: `blocked-${index}`, title: "Blocked recovery", recoveryPolicy: "safe_retry", idempotencyKey: `blocked:${index}`, executionScope: scope },
			], dependencies: [{ taskId: `blocked-${index}`, dependsOn: `unsafe-${index}` }],
		}, index + 1);
		graph.createPlan({ id: "later-plan", ownerKey: "cli:local:local", tasks: [{ id: "later-task", title: "Later", recoveryPolicy: "safe_retry", idempotencyKey: "later", executionScope: scope }] }, 101);
		const result = await new TaskRecoveryRunner(store, async () => ({ output: "recovered" })).run({ maxConcurrent: 20 });
		assert.equal(result.plans, 101);
		assert.equal(result.succeeded, 1);
		assert.equal(result.blocked.length, 100);
		assert.equal(store.queryTasks({ ownerKeys: ["cli:local:local"], id: "later-task" })[0].status, "succeeded");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task recovery terminalizes a pending Task whose dependency already failed", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-dependency-failure-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		store.recordPlan([
			{ id: "upstream", ownerKey: "cli:local:local", kind: "delegated", title: "Upstream", status: "failed", planId: "plan", recoveryPolicy: "safe_retry", idempotencyKey: "plan:upstream", executionScope: scope, createdAt: 1, finishedAt: 2, error: "failed" },
			{ id: "downstream", ownerKey: "cli:local:local", kind: "delegated", title: "Downstream", status: "pending", planId: "plan", recoveryPolicy: "safe_retry", idempotencyKey: "plan:downstream", executionScope: scope, createdAt: 1 },
		], [{ taskId: "downstream", dependsOn: "upstream" }]);
		let executions = 0;
		const result = await new TaskRecoveryRunner(store, async () => { executions++; return { output: "unused" }; }).run();
		assert.deepEqual(result, { plans: 1, succeeded: 0, failed: 1, cancelled: 0, blocked: [] });
		assert.equal(executions, 0);
		assert.match(store.queryTasks({ ownerKeys: ["cli:local:local"], id: "downstream" })[0].error, /Dependency Failure/);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("manual Task Plan retry is owner-scoped and requeues only recoverable failed nodes", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-manual-retry-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		store.record({ id: "failed", ownerKey: "cli:local:local", kind: "delegated", title: "Retry", description: "retry safely", status: "failed", planId: "retry-plan", recoveryPolicy: "safe_retry", idempotencyKey: "retry-plan:failed", executionScope: scope, createdAt: 1, finishedAt: 2, error: "model failed" });
		const runner = new TaskRecoveryRunner(store, async () => ({ output: "retried" }));
		assert.deepEqual(await runner.retry(["cli:other:local"], "retry-plan"), { verification: { attempted: 0, accepted: 0, rejected: 0, unavailable: 0 }, prepared: 0, plans: 0, succeeded: 0, failed: 0, cancelled: 0, blocked: [] });
		assert.deepEqual(await runner.retry(["cli:local:local"], "retry-plan"), { verification: { attempted: 0, accepted: 0, rejected: 0, unavailable: 0 }, prepared: 1, plans: 1, succeeded: 1, failed: 0, cancelled: 0, blocked: [] });
		assert.equal(store.queryTasks({ ownerKeys: ["cli:local:local"], id: "failed" })[0].result, "retried");
		assert.equal(store.queryTaskPlans({ ownerKeys: ["cli:local:local"], id: "retry-plan" })[0].status, "succeeded");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task Plan cancellation is owner-scoped and persists Tasks and active Runs atomically", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-plan-cancel-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.record({ id: "running", ownerKey: "cli:local:local", kind: "delegated", title: "Running", status: "running", planId: "cancel-plan", createdAt: 1, startedAt: 2 });
		store.recordRun({ id: "run", taskId: "running", executor: "subagent", status: "running", startedAt: 2, leaseExpiresAt: 1000 });
		store.record({ id: "pending", ownerKey: "cli:local:local", kind: "delegated", title: "Pending", status: "pending", planId: "cancel-plan", createdAt: 1 });
		const runner = new TaskRecoveryRunner(store, async () => ({ output: "unused" }));
		assert.deepEqual(runner.cancel(["cli:other:local"], "cancel-plan"), { active: 0, tasks: 0 });
		assert.deepEqual(runner.cancel(["cli:local:local"], "cancel-plan"), { active: 0, tasks: 2 });
		assert.deepEqual(store.queryTasks({ ownerKeys: ["cli:local:local"], planIds: ["cancel-plan"] }).map((task) => task.status), ["cancelled", "cancelled"]);
		assert.equal(store.taskRuns("running")[0].status, "cancelled");
		const plan = store.queryTaskPlans({ ownerKeys: ["cli:local:local"], id: "cancel-plan" })[0];
		assert.equal(plan.status, "cancelled");
		assert.equal(plan.taskCount, 2);
		assert.equal(plan.cancelled, 2);
		assert.ok(plan.finishedAt >= plan.startedAt);
		assert.deepEqual(await runner.retry(["cli:local:local"], "cancel-plan"), { verification: { attempted: 0, accepted: 0, rejected: 0, unavailable: 0 }, prepared: 0, plans: 0, succeeded: 0, failed: 0, cancelled: 0, blocked: [] });
		assert.equal(store.queryTaskPlans({ ownerKeys: ["cli:local:local"], id: "cancel-plan" })[0].status, "cancelled");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task Plan cancellation aborts a live recovery and leaves no running Task or Run", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-live-plan-cancel-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		store.record({ id: "live", ownerKey: "cli:local:local", kind: "delegated", title: "Live", status: "pending", planId: "live-plan", recoveryPolicy: "safe_retry", idempotencyKey: "live-plan:live", executionScope: scope, createdAt: 1 });
		const runner = new TaskRecoveryRunner(store, async (_task, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
		const running = runner.run();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(runner.cancel(["cli:local:local"], "live-plan"), { active: 1, tasks: 1 });
		assert.deepEqual(await running, { plans: 1, succeeded: 0, failed: 0, cancelled: 1, blocked: [] });
		assert.equal(store.queryTasks({ ownerKeys: ["cli:local:local"], id: "live" })[0].status, "cancelled");
		assert.equal(store.taskRuns("live")[0].status, "cancelled");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a cross-process cancellation remains the Terminal Outcome when a late executor exits", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-terminal-outcome-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const graph = new TaskGraph(store);
		graph.createPlan({ id: "race-plan", ownerKey: "cli:local:local", tasks: [{ id: "race", title: "Race" }] });
		const running = graph.run(["cli:local:local"], "race-plan", async (_task, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })), { leaseMs: 1_000, leaseHeartbeatMs: 5 });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(store.cancelTaskPlan(["cli:local:local"], "race-plan"), 1);
		assert.deepEqual(await running, { succeeded: 0, failed: 0, cancelled: 1, blocked: [] });
		assert.equal(store.queryTasks({ ownerKeys: ["cli:local:local"], id: "race" })[0].status, "cancelled");
		assert.equal(store.taskRuns("race")[0].status, "cancelled");
		assert.equal(store.queryTaskPlans({ ownerKeys: ["cli:local:local"], id: "race-plan" })[0].status, "cancelled");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("legacy task facts migrate once into objective Tasks", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-legacy-task-migration-"));
	const path = join(root, "memory.db");
	const legacy = new Database(path);
	legacy.exec("CREATE TABLE task_ledger (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, evidence TEXT, completed_at INTEGER, updated_at INTEGER NOT NULL)");
	legacy.prepare("INSERT INTO task_ledger VALUES (?, ?, ?, ?, ?, ?)").run("release", "Ship release", "done", "tag:v1", 120, 110);
	legacy.close();
	const store = new MemoryStore(path);
	try {
		assert.deepEqual(store.queryTasks({ ownerKeys: ["profile"] }), [{ id: "release", ownerKey: "profile", kind: "objective", title: "Ship release", status: "succeeded", evidence: "tag:v1", createdAt: 110, finishedAt: 120 }]);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task DAG dependencies persist with their Tasks", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-dag-"));
	const path = join(root, "memory.db");
	let store = new MemoryStore(path);
	new TaskGraph(store).createPlan({ id: "content-plan", ownerKey: "cli:local:local", title: "Create content", tasks: [{ id: "research", title: "Research" }, { id: "write", title: "Write" }], dependencies: [{ taskId: "write", dependsOn: "research" }] }, 100);
	store.close();
	store = new MemoryStore(path);
	try {
		assert.deepEqual(store.taskDependencies(["write"]), [{ taskId: "write", dependsOn: "research" }]);
		assert.deepEqual(store.queryTasks({ ownerKeys: ["cli:local:local"] }).map((task) => task.id).sort(), ["research", "write"]);
		assert.deepEqual(store.queryTaskPlans({ ownerKeys: ["cli:local:local"] }), [{
			id: "content-plan", ownerKey: "cli:local:local", title: "Create content", status: "pending", taskCount: 2,
			succeeded: 0, failed: 0, cancelled: 0, verified: 0, correctiveAttempts: 0, createdAt: 100,
		}]);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task Plan pause and checkpoints survive process restart and resume owner-scoped work", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-pause-"));
	const path = join(root, "memory.db");
	const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
	let store = new MemoryStore(path);
	new TaskGraph(store).createPlan({ id: "long-plan", ownerKey: "cli:local:local", tasks: [{ id: "long-task", title: "Long work", recoveryPolicy: "safe_retry", idempotencyKey: "long-plan:task", executionScope: scope, routes: ["primary", "fallback"] }] });
	store.transition("long-task", { status: "running", startedAt: 10 });
	assert.equal(store.checkpointTask("cli:local:local", "long-task", "page=42", 20), true);
	assert.equal(store.checkpointTask("cli:local:local", "long-task", "access_token=must-not-persist", 21), false);
	assert.equal(store.queryTasks({ ownerKeys: ["cli:local:local"], id: "long-task" })[0].checkpoint, "page=42");
	store.transition("long-task", { status: "pending" });
	assert.equal(store.pauseTaskPlan(["cli:local:local"], "long-plan", 30), true);
	store.close();
	store = new MemoryStore(path);
	try {
		assert.equal(store.queryTaskPlans({ ownerKeys: ["cli:local:local"], id: "long-plan" })[0].pausedAt, 30);
		assert.equal(store.queryTasks({ ownerKeys: ["cli:local:local"], id: "long-task" })[0].checkpoint, "page=42");
		assert.deepEqual(await new TaskRecoveryRunner(store, async () => ({ output: "must not run" })).run(), { plans: 0, succeeded: 0, failed: 0, cancelled: 0, blocked: [] });
		const runner = new TaskRecoveryRunner(store, async (_task, _signal, context) => ({ output: `resumed:${context.checkpoint}` }));
		assert.deepEqual(await runner.resume(["cli:local:local"], "long-plan"), { plans: 1, succeeded: 1, failed: 0, cancelled: 0, blocked: [] });
		assert.equal(store.queryTasks({ ownerKeys: ["cli:local:local"], id: "long-task" })[0].result, "resumed:page=42");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("structured Task Checkpoint survives restart as recovery state", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-structured-checkpoint-"));
	const path = join(root, "memory.db");
	let store = new MemoryStore(path);
	try {
		store.record({ id: "structured", ownerKey: "owner", kind: "delegated", title: "Structured recovery", status: "running", createdAt: 1 });
		const checkpoint = createTaskCheckpoint({ taskRunId: "run:structured", source: "pi_turn", at: 2, completed: ["read:call-1"], committedEffectIds: ["effect-1"], evidenceRefs: ["tool:call-1"], unresolvedIssues: ["Need another source"], nextSafeStep: "Read another source without repeating call-1." });
		assert.equal(store.checkpointTask("owner", "structured", checkpoint, 2), true);
		store.close(); store = new MemoryStore(path);
		assert.deepEqual(store.queryTasks({ ownerKeys: ["owner"], id: "structured" })[0].checkpoint, checkpoint);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a supervised background failure terminalizes its Task Plan instead of leaving running work", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-background-failure-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		new TaskGraph(store).createPlan({ id: "failed-background", ownerKey: "cli:local:local", tasks: [{ id: "failed-task", title: "Long work", recoveryPolicy: "safe_retry", idempotencyKey: "failed-background:task", executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } }] });
		const runtime = new TaskPlanRuntime();
		assert.equal(runtime.startClaimed(store, "cli:local:local", "failed-background", async () => { throw new Error("password=must-not-persist"); }, () => store.enqueueTaskPlanCompletionNotice("cli:local:local", "failed-background")), true);
		await new Promise((resolve) => setImmediate(resolve));
		await runtime.shutdown();
		const task = store.queryTasks({ ownerKeys: ["cli:local:local"], id: "failed-task" })[0];
		const plan = store.queryTaskPlans({ ownerKeys: ["cli:local:local"], id: "failed-background" })[0];
		assert.equal(task.status, "failed");
		assert.equal(task.error, "[credential details redacted]");
		assert.equal(plan.status, "failed");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a stale execution holder cannot terminalize a Plan after lease takeover", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-stale-failure-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		new TaskGraph(store).createPlan({ id: "takeover-plan", ownerKey: "owner", tasks: [{ id: "takeover-task", title: "Work" }] });
		assert.equal(store.claimTaskPlanExecution("owner", "takeover-plan", "old-holder", 100, 0), true);
		assert.equal(store.claimTaskPlanExecution("owner", "takeover-plan", "new-holder", 300, 101), true);
		assert.equal(store.failTaskPlan(["owner"], "takeover-plan", "old-holder", "late failure", 110), 0);
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: "takeover-task" })[0].status, "pending");
		assert.equal(store.failTaskPlan(["owner"], "takeover-plan", "new-holder", "current failure", 110), 1);
		assert.equal(store.queryTaskPlans({ ownerKeys: ["owner"], id: "takeover-plan" })[0].status, "failed");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a Task Plan Terminal Outcome rejects late lifecycle updates", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-plan-terminal-outcome-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		new TaskGraph(store).createPlan({ id: "terminal-plan", ownerKey: "cli:local:local", tasks: [{ id: "task", title: "Task" }] }, 100);
		const counts = { taskCount: 1, succeeded: 0, failed: 0, cancelled: 0, verified: 0, correctiveAttempts: 0 };
		assert.equal(store.transitionPlan("terminal-plan", { ...counts, status: "running", startedAt: 110 }), true);
		assert.equal(store.transitionPlan("terminal-plan", { ...counts, status: "cancelled", cancelled: 1, finishedAt: 120 }), true);
		assert.equal(store.transitionPlan("terminal-plan", { ...counts, status: "failed", failed: 1, finishedAt: 130 }), false);
		assert.equal(store.transitionPlan("terminal-plan", { ...counts, status: "running", startedAt: 130 }), false);
		assert.equal(store.queryTaskPlans({ ownerKeys: ["cli:local:local"], id: "terminal-plan" })[0].status, "cancelled");
		assert.equal(store.claimTaskPlanExecution("cli:local:local", "terminal-plan", "late-worker", 300, 200), false);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a Task Plan Execution Claim admits one holder and fences a stale holder after takeover", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-plan-execution-claim-"));
	const path = join(root, "memory.db");
	const first = new MemoryStore(path);
	const second = new MemoryStore(path);
	try {
		new TaskGraph(first).createPlan({ id: "claimed-plan", ownerKey: "cli:local:local", tasks: [{ id: "task", title: "Task" }] }, 100);
		assert.equal(first.claimTaskPlanExecution("cli:local:local", "claimed-plan", "worker-a", 200, 100), true);
		assert.equal(second.claimTaskPlanExecution("cli:local:local", "claimed-plan", "worker-b", 250, 150), false);
		assert.equal(second.claimTaskPlanExecution("cli:local:local", "claimed-plan", "worker-b", 350, 200), true);
		assert.equal(first.releaseTaskPlanExecution("cli:local:local", "claimed-plan", "worker-a"), false);
		assert.equal(second.renewTaskPlanExecution("cli:local:local", "claimed-plan", "worker-b", 400, 300), true);
		assert.equal(second.releaseTaskPlanExecution("cli:local:local", "claimed-plan", "worker-b"), true);
	} finally { second.close(); first.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a crashed Agent execution is reconciled and recovered by a new process", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-plan-claim-crash-"));
	const path = join(root, "memory.db");
	const executionLog = join(root, "executions.jsonl");
	let store = new MemoryStore(path);
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		new TaskGraph(store).createPlan({ id: "crash-plan", ownerKey: "owner", tasks: [{ id: "crash-task", title: "Task", recoveryPolicy: "safe_retry", idempotencyKey: "crash-plan:task", executionScope: scope }] });
		store.close();
		await runClaimWorker({ databasePath: path, executionLog, mode: "crash-during-execution" }, 17);
		store = new MemoryStore(path);
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: "crash-task" })[0].status, "running");
		const recoveryTime = Date.now() + 2 * 60 * 60_000;
		assert.deepEqual(store.reconcileExpiredTaskRuns(recoveryTime), { retried: 1, failed: 0, affectedPlans: [{ ownerKey: "owner", planId: "crash-plan" }] });
		assert.equal(store.claimTaskPlanExecution("owner", "crash-plan", "recovery-probe", recoveryTime + 60_000, recoveryTime), true);
		assert.equal(store.releaseTaskPlanExecution("owner", "crash-plan", "recovery-probe"), true);
		store.close();
		const recovered = JSON.parse(await runClaimWorker({ databasePath: path, executionLog, mode: "recover" }));
		assert.equal(recovered.executions, 1);
		store = new MemoryStore(path);
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: "crash-task" })[0].status, "succeeded");
		assert.equal(store.queryTaskPlans({ ownerKeys: ["owner"], id: "crash-plan" })[0].status, "succeeded");
		assert.equal(readFileSync(executionLog, "utf8").trim().split("\n").length, 2);
		assert.equal(store.claimTaskPlanCompletionNotices("cli", Date.now(), 10).length, 1);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("recovery resumes from a checkpoint persisted immediately before process failure", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-checkpoint-crash-"));
	const path = join(root, "memory.db"); const executionLog = join(root, "executions.jsonl");
	let store = new MemoryStore(path);
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		new TaskGraph(store).createPlan({ id: "checkpoint-plan", ownerKey: "owner", tasks: [{ id: "checkpoint-task", title: "Task", recoveryPolicy: "safe_retry", idempotencyKey: "checkpoint-plan:task", executionScope: scope }] });
		store.close(); await runClaimWorker({ databasePath: path, executionLog, mode: "crash-after-checkpoint" }, 18);
		store = new MemoryStore(path);
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: "checkpoint-task" })[0].checkpoint, "phase=checkpointed");
		const recoveryTime = Date.now() + 2 * 60 * 60_000;
		store.reconcileExpiredTaskRuns(recoveryTime);
		assert.equal(store.claimTaskPlanExecution("owner", "checkpoint-plan", "recovery-probe", recoveryTime + 60_000, recoveryTime), true);
		assert.equal(store.releaseTaskPlanExecution("owner", "checkpoint-plan", "recovery-probe"), true);
		store.close(); await runClaimWorker({ databasePath: path, executionLog, mode: "recover" });
		const attempts = readFileSync(executionLog, "utf8").trim().split("\n").map(JSON.parse);
		assert.equal(attempts.length, 2);
		assert.equal(attempts[1].checkpoint, "phase=checkpointed");
		store = new MemoryStore(path);
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: "checkpoint-task" })[0].status, "succeeded");
		assert.equal(store.queryTaskPlans({ ownerKeys: ["owner"], id: "checkpoint-plan" })[0].status, "succeeded");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a process failure after repeated lease heartbeats remains fenced until reconciliation", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-heartbeat-crash-"));
	const path = join(root, "memory.db"); const executionLog = join(root, "executions.jsonl");
	let store = new MemoryStore(path);
	try {
		new TaskGraph(store).createPlan({ id: "heartbeat-plan", ownerKey: "owner", tasks: [{ id: "heartbeat-task", title: "Task", recoveryPolicy: "safe_retry", idempotencyKey: "heartbeat-plan:task", executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } }] });
		store.close(); await runClaimWorker({ databasePath: path, executionLog, mode: "crash-after-heartbeats", ownerKey: "owner", planId: "heartbeat-plan" }, 19);
		store = new MemoryStore(path);
		const run = store.taskRuns("heartbeat-task")[0];
		assert.ok(run.leaseExpiresAt > run.startedAt + 1_100, `lease was not renewed: ${JSON.stringify(run)}`);
		assert.deepEqual(store.reconcileExpiredTaskRuns(run.leaseExpiresAt - 1), { retried: 0, failed: 0, affectedPlans: [] });
		assert.equal(store.reconcileExpiredTaskRuns(run.leaseExpiresAt).retried, 1);
		store.close(); await runClaimWorker({ databasePath: path, executionLog, mode: "recover" });
		store = new MemoryStore(path);
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: "heartbeat-task" })[0].status, "succeeded");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a process crash inside atomic success settlement leaves neither Task nor Run succeeded", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-terminal-window-crash-"));
	const path = join(root, "memory.db"); const executionLog = join(root, "executions.jsonl");
	let store = new MemoryStore(path);
	try {
		new TaskGraph(store).createPlan({ id: "terminal-window-plan", ownerKey: "owner", tasks: [{ id: "terminal-window-task", title: "Task", recoveryPolicy: "safe_retry", idempotencyKey: "terminal-window-plan:task", executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } }] });
		store.close(); await runClaimWorker({ databasePath: path, executionLog, mode: "crash-after-terminal-task-write" }, 20);
		store = new MemoryStore(path);
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: "terminal-window-task" })[0].status, "running");
		const run = store.taskRuns("terminal-window-task")[0];
		assert.equal(run.status, "running");
		assert.equal(store.queryTaskPlans({ ownerKeys: ["owner"], id: "terminal-window-plan" })[0].status, "running");
		assert.deepEqual(store.reconcileExpiredTaskRuns(run.leaseExpiresAt), { retried: 1, failed: 0, affectedPlans: [{ ownerKey: "owner", planId: "terminal-window-plan" }] });
		assert.equal(store.taskRuns("terminal-window-task")[0].status, "failed");
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: "terminal-window-task" })[0].status, "pending");
		assert.equal(store.queryTaskPlans({ ownerKeys: ["owner"], id: "terminal-window-plan" })[0].status, "pending");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("multiple Agent processes execute each durable Task Plan exactly once", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-plan-claim-process-race-"));
	const path = join(root, "memory.db");
	const executionLog = join(root, "executions.jsonl");
	let store = new MemoryStore(path);
	const planIds = Array.from({ length: 24 }, (_, index) => `race-plan-${index}`);
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		for (const [index, planId] of planIds.entries()) new TaskGraph(store).createPlan({ id: planId, ownerKey: "owner", tasks: [{ id: `task-${index}`, title: "Task", recoveryPolicy: "safe_retry", idempotencyKey: planId, executionScope: scope }] });
		store.close();
		const results = await Promise.all(Array.from({ length: 6 }, () => runClaimWorker({ databasePath: path, executionLog, mode: "recover", maxConcurrent: 4 }).then(JSON.parse)));
		assert.equal(results.reduce((total, result) => total + result.executions, 0), planIds.length);
		store = new MemoryStore(path);
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], statuses: ["succeeded"] }).length, planIds.length);
		assert.equal(store.queryTaskPlans({ ownerKeys: ["owner"], statuses: ["succeeded"] }).length, planIds.length);
		const executions = readFileSync(executionLog, "utf8").trim().split("\n").map(JSON.parse);
		assert.equal(executions.length, planIds.length);
		assert.equal(new Set(executions.map((entry) => entry.taskId)).size, planIds.length);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("structured understandings retain evidence, support correction, and compile a bounded long-term snapshot", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-understanding-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", userId: "zane" };
		const preference = store.upsertClaim({
			...scope, kind: "preference", statement: "用户默认使用中文，并希望先给结论再给依据。",
			confidence: 0.95, stability: "high", evidence: { kind: "conversation", excerpt: "默认中文，先给结论。" },
		});
		store.upsertClaim({
			...scope, kind: "project", statement: "BeeMax 正在建设可解释的长期记忆系统。",
			confidence: 0.9, stability: "medium", evidence: { excerpt: "按设计实施记忆系统。" },
		});
		assert.equal(store.recallBrief("用户默认使用中文", scope).claims[0].id, preference.id);
		assert.equal(store.recall("用户默认使用中文", scope)[0].id, preference.id);
		assert.equal(store.explainClaim(preference.id, scope).evidence[0].excerpt, "默认中文，先给结论。");
		const correctionEvent = store.recordEvent({ ...scope, kind: "feedback", content: "架构讨论时需要完整方案。" });
		const corrected = store.correctClaim(preference.id, { statement: "用户默认使用中文；架构讨论时需要完整方案。", evidence: { kind: "correction", eventId: correctionEvent, excerpt: "架构讨论时需要完整方案。" } }, scope);
		assert.ok(corrected);
		assert.equal(store.listClaims(scope).some((claim) => claim.id === preference.id), false);
		assert.equal(store.explainClaim(preference.id, scope).claim.supersededBy, corrected.id);
		assert.ok(store.explainClaim(corrected.id, scope).evidence[0].eventId);
		assert.match(store.compileLongTermMemory({ ...scope, maxChars: 1000 }), /架构讨论时需要完整方案/);
		assert.match(store.compileLongTermMemory({ ...scope, maxChars: 1000 }), /BeeMax 正在建设/);
		store.upsertClaim({ ...scope, userId: "another-user", kind: "fact", statement: "Other user's private fact", confidence: 1, stability: "high" });
		assert.doesNotMatch(store.compileLongTermMemory({ ...scope, maxChars: 1000 }), /Other user's private fact/);
		const foreignEvent = store.recordEvent({ ...scope, userId: "another-user", kind: "user", content: "Private source" });
		assert.throws(() => store.upsertClaim({ ...scope, kind: "fact", statement: "Must not cross scopes", evidence: { eventId: foreignEvent, excerpt: "Private source" } }), /outside this memory scope/);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("memory recall and evidence remain inside the exact conversation and thread scope", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-exact-scope-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const a = { platform: "feishu", chatId: "group-a", threadId: "thread-a", userId: "same-user" };
		const b = { platform: "feishu", chatId: "group-b", threadId: "thread-b", userId: "same-user" };
		store.remember({ ...a, role: "memory", content: "Project Alpha delivery is Friday" });
		store.remember({ ...b, role: "memory", content: "Project Beta delivery is Monday" });
		assert.deepEqual(store.recall("delivery", a).map((record) => record.content), ["Project Alpha delivery is Friday"]);
		assert.deepEqual(store.recall("delivery", { platform: "feishu", chatId: "group-a", userId: "same-user" }), []);
		const foreignEvent = store.recordEvent({ ...b, kind: "user", content: "Beta private source" });
		assert.throws(() => store.upsertClaim({ ...a, kind: "fact", statement: "Must stay in Alpha", evidence: { eventId: foreignEvent, excerpt: "Beta private source" } }), /outside this memory scope/);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("organizational claims retain entity identity, source, validity, visibility, and explicit conflicts", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-organizational-memory-"));
	const store = new MemoryStore(join(root, "memory.db"), "sales-profile");
	try {
		const scope = { profileId: "sales-profile", platform: "feishu", chatId: "sales", threadId: "order-thread", userId: "seller", projectId: "sales-team" };
		const first = store.upsertClaim({ ...scope, kind: "fact", statement: "交付日期为 7 月 25 日", subject: { type: "customer", id: "customer-1" }, object: { type: "order", id: "PO-1" }, source: { type: "message", ref: "om-1" }, validFrom: 100, validUntil: Date.now() + 60_000, visibility: "team" });
		const second = store.upsertClaim({ ...scope, kind: "fact", statement: "交付日期为 7 月 28 日", subject: { type: "customer", id: "customer-1" }, object: { type: "order", id: "PO-1" }, source: { type: "tool", ref: "erp-1" }, validFrom: 100, visibility: "team" });
		const businessScope = { subject: first.subject, object: first.object };
		assert.equal(store.markClaimsConflicted(first.id, second.id, scope), true);
		const explained = store.explainClaim(first.id, scope);
		assert.deepEqual(explained.claim.subject, { type: "customer", id: "customer-1" });
		assert.deepEqual(explained.claim.object, { type: "order", id: "PO-1" });
		assert.deepEqual(explained.claim.source, { type: "message", ref: "om-1" });
		assert.equal(explained.claim.visibility, "team");
		assert.deepEqual(explained.claim.conflictsWith, [second.id]);
		assert.equal(store.explainClaim(first.id, { profileId: "sales-profile", platform: "feishu", chatId: "sales", threadId: "order-thread", userId: "seller" }), undefined);
		assert.equal(store.explainClaim(first.id, { ...scope, profileId: "other-profile" }), undefined);
		assert.equal(store.listClaims({ ...scope, status: "conflicted" }).length, 2);
		assert.equal(store.recallBrief("交付日期", { ...scope, ...businessScope }).claims.length, 2);
		assert.equal(store.recallBrief("交付日期", { profileId: "sales-profile", platform: "feishu", chatId: "other-chat", userId: "teammate", projectId: "sales-team", ...businessScope }).claims.length, 2);
		const otherOrder = store.upsertClaim({ ...scope, kind: "fact", statement: "交付日期为 7 月 28 日", subject: { type: "customer", id: "customer-1" }, object: { type: "order", id: "PO-2" } });
		assert.notEqual(otherOrder.id, second.id);
		store.upsertClaim({ ...scope, kind: "fact", statement: "未来价格生效", validFrom: Date.now() + 60_000 });
		assert.equal(store.recallBrief("未来价格", scope).claims.length, 0);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Profile store ownership migrates legacy claims and rejects a different Profile", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-profile-memory-"));
	const path = join(root, "memory.db");
	let store = new MemoryStore(path);
	try {
		store.upsertClaim({ platform: "cli", chatId: "local", userId: "local", kind: "fact", statement: "Legacy durable fact" });
		store.close();
		const legacy = new Database(path);
		legacy.exec("DROP TABLE memory_store_identity");
		legacy.close();
		store = new MemoryStore(path, "personal");
		assert.equal(store.recallBrief("Legacy durable fact", { profileId: "personal", platform: "cli", chatId: "local", userId: "local" }).claims.length, 1);
		store.close();
		assert.throws(() => new MemoryStore(path, "other"), /belongs to Profile 'personal'/);
	} finally { try { store.close(); } catch {} rmSync(root, { recursive: true, force: true }); }
});
