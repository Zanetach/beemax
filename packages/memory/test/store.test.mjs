import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "../dist/index.js";
import Database from "better-sqlite3";
import { createAccessScopeRef, createSituation, createTaskCheckpoint, TaskGraph, TaskPlanRuntime, TaskRecoveryRunner, TaskRecoveryService } from "@beemax/core";

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
		store.record({ id: "child-1", ownerKey: "cli:local:local", kind: "delegated", title: "Research", acceptanceCriteria: "Includes a source", verificationStatus: "pending", correctiveAttempts: 0, status: "pending", createdAt: 100 });
		store.transition("child-1", { status: "running", startedAt: 110 });
		store.transition("child-1", { status: "succeeded", finishedAt: 120, result: "done", evidence: "ACCEPT: source checked", verificationStatus: "accepted", correctiveAttempts: 1 });
		store.recordRun({ id: "run-1", taskId: "child-1", executor: "subagent", status: "running", startedAt: 110 });
		store.transitionRun("run-1", { status: "succeeded", finishedAt: 120, output: "done" });
		assert.deepEqual(store.queryTasks({ ownerKeys: ["cli:local:local"] }), [{
			id: "child-1", ownerKey: "cli:local:local", kind: "delegated", title: "Research", acceptanceCriteria: "Includes a source",
			status: "succeeded", evidence: "ACCEPT: source checked", verificationStatus: "accepted", correctiveAttempts: 1, createdAt: 100, startedAt: 110, finishedAt: 120, result: "done",
		}]);
		assert.deepEqual(store.taskRuns("child-1"), [{ id: "run-1", taskId: "child-1", executor: "subagent", status: "succeeded", startedAt: 110, finishedAt: 120, output: "done" }]);
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
		assert.equal(store.deferCandidateVerification(["cli:local:local"], "direct-objective", 10), true);
		assert.deepEqual(store.verificationCandidates(10 + 24 * 60 * 60_000, 10, ["already-attempted-plan"]).map((task) => task.id), ["direct-objective"]);
		let executions = 0; const notices = [];
		const runner = new TaskRecoveryRunner(store, async () => { executions++; return { output: "replayed" }; }, undefined, async (_task, result) => ({ accepted: result.output === "direct candidate", evidence: "direct candidate checked later" }), undefined, async (task, resolution) => { notices.push({ id: task.id, resolution }); });
		assert.deepEqual(await runner.reverifyDue(10 + 24 * 60 * 60_000), { attempted: 1, accepted: 1, rejected: 0, unavailable: 0 });
		assert.equal(executions, 0);
		assert.deepEqual(notices, [{ id: "direct-objective", resolution: { accepted: true, evidence: "direct candidate checked later" } }]);
		const objective = store.queryTasks({ ownerKeys: ["cli:local:local"], id: "direct-objective" })[0];
		assert.deepEqual({ status: objective.status, verificationStatus: objective.verificationStatus, result: objective.result }, { status: "succeeded", verificationStatus: "accepted", result: "direct candidate" });
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
		assert.equal(first.queryTasks({ ownerKeys: ["owner"], id: "direct-claimed" })[0].status, "succeeded");
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
		assert.deepEqual(result, { attempted: 1, accepted: 1, rejected: 0, unavailable: 0 });
		assert.equal(executions, 0);
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

test("reconciliation closes the Task-success Run-running terminal commit window", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-terminal-window-crash-"));
	const path = join(root, "memory.db"); const executionLog = join(root, "executions.jsonl");
	let store = new MemoryStore(path);
	try {
		new TaskGraph(store).createPlan({ id: "terminal-window-plan", ownerKey: "owner", tasks: [{ id: "terminal-window-task", title: "Task", recoveryPolicy: "safe_retry", idempotencyKey: "terminal-window-plan:task", executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } }] });
		store.close(); await runClaimWorker({ databasePath: path, executionLog, mode: "crash-after-terminal-task-write" }, 20);
		store = new MemoryStore(path);
		assert.equal(store.queryTasks({ ownerKeys: ["owner"], id: "terminal-window-task" })[0].status, "succeeded");
		const run = store.taskRuns("terminal-window-task")[0];
		assert.equal(run.status, "running");
		assert.equal(store.queryTaskPlans({ ownerKeys: ["owner"], id: "terminal-window-plan" })[0].status, "running");
		assert.deepEqual(store.reconcileExpiredTaskRuns(run.leaseExpiresAt), { retried: 0, failed: 0, affectedPlans: [{ ownerKey: "owner", planId: "terminal-window-plan" }] });
		assert.equal(store.taskRuns("terminal-window-task")[0].status, "failed");
		assert.equal(store.queryTaskPlans({ ownerKeys: ["owner"], id: "terminal-window-plan" })[0].status, "succeeded");
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
