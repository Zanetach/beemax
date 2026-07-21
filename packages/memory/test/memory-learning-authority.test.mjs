import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { AutonomyRolloutController, ConversationContext, DefaultMemoryLearningKernel, DeterministicLearningExtractor, ModelBackedLearningExtractor, createArtifactManifest, createExecutionEnvelope, createSituation } from "@beemax/core";
import { MemoryStore, memoryPersistencePorts } from "../dist/index.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const rolloutEvidence = {
	situationPrecision: 1, correctionRetention: 1, unauthorizedRetrievals: 0, verifiedCompletionRate: 1,
	memoryPromotionPrecision: 1, scopedRecallAt5: 0.95, memoryAttributionAccuracy: 0.95, memoryDowngradePrecision: 0.96,
	memoryFalseDowngradeRate: 0.01, memoryNegativeTransferRate: 0.01, memoryProvenanceCoverage: 1,
	initiativePrecision: 0.8, initiativeAverageExpectedValue: 0.8, duplicateInitiatives: 0, initiativeInterruptionRate: 0.02,
	readOnlyPrecision: 0.8, readOnlyAdoptionRate: 0.7, readOnlyInterruptionRate: 0.03, duplicateReadOnlyObjectives: 0,
	proactivePolicyScopeCoverage: 1, emergencyStopBlockRate: 1, compensationSuccessRate: 1, duplicateCompensations: 0,
	highRiskAutonomousActions: 0, irreversibleAutonomousActions: 0,
};

test("SQLite Memory Learning authority recalls only accessible Claims and preserves Context Pack receipts across restart", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-"));
	const database = join(root, "memory.db");
	try {
		const first = new MemoryStore(database, "profile-a");
		first.upsertClaim({ profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", kind: "preference", statement: "Gold reports should be delivered in Chinese", confidence: 0.95, stability: "high", visibility: "private", evidence: { excerpt: "The user explicitly requested Chinese reports", sourceRef: "message:1" } });
		first.upsertClaim({ profileId: "profile-a", platform: "cli", chatId: "chat-b", userId: "user-b", kind: "preference", statement: "Gold reports should expose confidential desk notes", confidence: 0.95, stability: "high", visibility: "private", evidence: { excerpt: "A different user requested desk notes", sourceRef: "message:2" } });
		const authority = memoryPersistencePorts(first).memoryLearningAuthority;
		assert.ok(authority);
		const kernel = new DefaultMemoryLearningKernel({ authority, now: () => 1_700_000_000_000 });
		const pack = await kernel.prepare({
			envelope: createExecutionEnvelope({ executionId: "execution:gold-report", trigger: { kind: "interaction" } }),
			scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" },
			situation: createSituation({ summary: "Research the current gold trend and deliver a report", goals: ["Deliver HTML and PDF in Chinese"], confidence: 0.9 }),
			query: "gold report Chinese",
			queryDigest: digest("gold report Chinese"),
			requiredItems: [],
			maxOptionalChars: 4_000,
			policyVersion: "l4.v1",
		});
		assert.equal(pack.optionalItems.length, 1);
		assert.match(pack.safePrefix, /delivered in Chinese/);
		assert.doesNotMatch(pack.safePrefix, /confidential desk notes/);
		first.close();

		const reopened = new MemoryStore(database, "profile-a");
		const persisted = memoryPersistencePorts(reopened).memoryLearningAuthority.readContextPack({ profileId: "profile-a", packId: pack.packId, executionId: "execution:gold-report" });
		assert.equal(persisted?.pack.packId, pack.packId);
		assert.equal(persisted?.pack.queryDigest, digest("gold report Chinese"));
		assert.equal(persisted?.receipts.length, 1);
		assert.equal(persisted?.receipts[0].component.kind, "claim");
		assert.doesNotMatch(JSON.stringify(persisted), /delivered in Chinese/);
		reopened.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("repeated prepare for the same execution and query returns one durable Context Pack", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-idempotent-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		store.upsertClaim({ profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", kind: "preference", statement: "Use concise gold report headings", confidence: 0.9, visibility: "private" });
		const kernel = new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority, now: () => 1_700_000_000_000 });
		const input = {
			envelope: createExecutionEnvelope({ executionId: "execution:idempotent", trigger: { kind: "interaction" } }),
			scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" },
			situation: createSituation({ summary: "Prepare a gold report", confidence: 0.9 }),
			query: "gold report headings",
			queryDigest: digest("gold report headings"),
			requiredItems: [],
			maxOptionalChars: 2_000,
			policyVersion: "l4.v1",
		};
		const first = await kernel.prepare(input);
		const repeated = await kernel.prepare(input);
		assert.equal(repeated.packId, first.packId);
		assert.equal(repeated.optionalItems.length, 1);
		assert.equal(repeated.receipts[0].receiptId, first.receipts[0].receiptId);
		assert.equal(repeated.omitted.persistence_unavailable, 0);
		store.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("duplicate observations create one durable learning signal", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-observe-"));
	try {
		const now = Date.now();
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const kernel = new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority, now: () => now });
		const observation = { type: "evidence", scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" }, evidenceKind: "feedback", content: "The report was accepted", evidenceDigest: digest("The report was accepted"), sourceRef: "verification:1", occurredAt: now };
		const first = kernel.observe(observation);
		const duplicate = kernel.observe(observation);
		assert.equal(first.reasonCode, "recorded");
		assert.equal(duplicate.reasonCode, "duplicate");
		assert.equal(duplicate.observationId, first.observationId);
		assert.equal(duplicate.learningSignalId, first.learningSignalId);
		const maintenance = await kernel.maintain({ profileId: "profile-a", trigger: "signal", maxItems: 10, maxModelCalls: 0, leaseMs: 30_000, now: Date.now() + 1 });
		assert.equal(maintenance.claimed, 1);
		assert.equal(maintenance.completed, 1);
		assert.equal(maintenance.deferred, 0);
		store.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("conversation evidence retained by reference remains available to asynchronous extraction", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-referenced-evidence-"));
	try {
		const now = Date.now();
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const authority = memoryPersistencePorts(store).memoryLearningAuthority;
		const kernel = new DefaultMemoryLearningKernel({ authority, now: () => now });
		const context = new ConversationContext(store, { memoryScope: { profileId: "profile-a" }, memoryLearningKernel: kernel });
		const content = "Prefer concise reports with compact source tables";
		context.assemble({ platform: "cli", chatId: "chat-a", chatType: "dm", userId: "user-a" }, content);
		const claims = authority.claimLearningExtractions({ profileId: "profile-a", maxItems: 1, leaseMs: 30_000, now: Date.now() + 1 });
		assert.equal(claims.length, 1);
		assert.equal(claims[0].content, content);
		assert.equal(claims[0].evidenceDigest, digest(content));
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("bounded deterministic extraction admits an explicit preference with exact evidence lineage", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-extraction-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const persistence = memoryPersistencePorts(store);
		const rollout = new AutonomyRolloutController({ store: persistence.autonomyRollout, evidence: () => rolloutEvidence });
		for (const [index, level] of ["situation_context", "episode_publication", "adaptive_learning"].entries()) rollout.promote(level, { actor: "operator", evidenceRef: "evaluation:extraction" }, 100 + index);
		const kernel = new DefaultMemoryLearningKernel({ authority: persistence.memoryLearningAuthority, extractor: new DeterministicLearningExtractor() });
		const scope = { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" };
		const content = "Prefer concise reports with compact source tables";
		const observed = kernel.observe({ type: "evidence", scope, evidenceKind: "feedback", content, evidenceDigest: digest(content), sourceRef: "message:preference", occurredAt: Date.now() });
		assert.equal(observed.accepted, true);
		const maintained = await kernel.maintain({ profileId: "profile-a", trigger: "signal", maxItems: 10, maxModelCalls: 1, leaseMs: 30_000, now: observed.recordedAt + 1 });
		assert.equal(maintained.claimed, 1);
		assert.equal(maintained.completed, 1);
		assert.equal(maintained.deferred, 0);
		assert.ok(maintained.transitions.some((transition) => transition.includes("extraction:preference:admitted")));
		const claims = store.listClaims({ profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", status: "active" });
		assert.equal(claims.length, 1);
		assert.equal(claims[0].statement, content);
		assert.equal(claims[0].source.ref, observed.observationId);
		const recalled = await kernel.prepare({ envelope: createExecutionEnvelope({ executionId: "execution:preference-recall", trigger: { kind: "interaction" } }), scope, situation: createSituation({ summary: "Create a concise report", confidence: 1 }), query: "concise reports compact source tables", queryDigest: digest("concise reports compact source tables"), requiredItems: [], maxOptionalChars: 4_000, policyVersion: "l4.v1" });
		assert.ok(recalled.optionalItems.some((item) => item.text.includes(content)));
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Learning extraction renews its SQLite lease until the extractor returns", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-extraction-lease-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const persistence = memoryPersistencePorts(store);
		const rollout = new AutonomyRolloutController({ store: persistence.autonomyRollout, evidence: () => rolloutEvidence });
		for (const [index, level] of ["situation_context", "episode_publication", "adaptive_learning"].entries()) rollout.promote(level, { actor: "operator", evidenceRef: "evaluation:extraction-lease" }, 100 + index);
		const deterministic = new DeterministicLearningExtractor();
		let extractions = 0;
		let extractionStarted;
		const started = new Promise((resolve) => { extractionStarted = resolve; });
		let releaseExtraction;
		const released = new Promise((resolve) => { releaseExtraction = resolve; });
		let logicalNow = 0;
		const kernel = new DefaultMemoryLearningKernel({
			authority: persistence.memoryLearningAuthority,
			now: () => logicalNow,
			extractor: { extract: async (claim) => {
				extractions++;
				extractionStarted();
				await released;
				return deterministic.extract(claim);
			} },
		});
		const content = "Prefer concise reports with compact source tables";
		const observed = kernel.observe({ type: "evidence", scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" }, evidenceKind: "feedback", content, evidenceDigest: digest(content), occurredAt: Date.now() });
		const claimNow = observed.recordedAt + 1;
		logicalNow = claimNow + 50;
		const maintenance = kernel.maintain({ profileId: "profile-a", trigger: "signal", maxItems: 10, maxModelCalls: 1, leaseMs: 60, now: claimNow });
		await started;
		const claimableBeforeFirstHeartbeat = persistence.memoryLearningAuthority.claimLearningExtractions({ profileId: "profile-a", maxItems: 1, leaseMs: 60, now: claimNow + 61 });
		logicalNow = claimNow + 80;
		await new Promise((resolve) => setTimeout(resolve, 25));
		const claimableWhileExtractorRuns = persistence.memoryLearningAuthority.claimLearningExtractions({ profileId: "profile-a", maxItems: 1, leaseMs: 60, now: claimNow + 111 });
		releaseExtraction();
		const maintained = await maintenance;
		assert.equal(claimableBeforeFirstHeartbeat.length, 0);
		assert.equal(claimableWhileExtractorRuns.length, 0);
		assert.equal(maintained.failed, 0);
		assert.equal(maintained.deferred, 0);
		assert.equal(maintained.completed, 1);
		assert.equal(extractions, 1);
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("malformed model extraction is deferred and cannot write memory authority", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-malformed-extraction-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const persistence = memoryPersistencePorts(store);
		const content = "A concise report was useful this time";
		const extractor = new ModelBackedLearningExtractor(async ({ observationId }) => ({
			proposals: [{
				kind: "preference",
				statement: "Always make reports concise",
				confidence: 0.99,
				evidenceRefs: [observationId],
				sourceSpans: [{ start: 0, end: 7, quote: "forged!" }],
			}],
		}));
		const kernel = new DefaultMemoryLearningKernel({ authority: persistence.memoryLearningAuthority, extractor });
		const observed = kernel.observe({
			type: "evidence",
			scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" },
			evidenceKind: "feedback",
			content,
			evidenceDigest: digest(content),
			sourceRef: "message:one-off-feedback",
			occurredAt: Date.now(),
		});
		const maintained = await kernel.maintain({ profileId: "profile-a", trigger: "signal", maxItems: 10, maxModelCalls: 1, leaseMs: 30_000, now: observed.recordedAt + 1 });
		assert.equal(maintained.claimed, 1);
		assert.equal(maintained.completed, 0);
		assert.equal(maintained.deferred, 1);
		assert.equal(maintained.failed, 0);
		assert.deepEqual(store.listClaims({ profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", status: "active" }), []);
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("an exact capability gap becomes one durable Learning Objective through the admitted Objective port", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-objective-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const persistence = memoryPersistencePorts(store);
		const rollout = new AutonomyRolloutController({ store: persistence.autonomyRollout, evidence: () => rolloutEvidence });
		for (const [index, level] of ["situation_context", "episode_publication", "adaptive_learning"].entries()) rollout.promote(level, { actor: "operator", evidenceRef: "evaluation:learning-objective" }, 100 + index);
		const admitted = [];
		const kernel = new DefaultMemoryLearningKernel({
			authority: persistence.memoryLearningAuthority,
			extractor: new DeterministicLearningExtractor(),
			learningObjectiveAdmission: {
				admit: async (candidate) => {
					admitted.push(candidate);
					return { status: "admitted", objectiveId: `objective:learning:${candidate.proposalId.slice(-16)}` };
				},
			},
		});
		const scope = { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" };
		const content = "Missing tool capability for current gold source verification";
		const observed = kernel.observe({ type: "evidence", scope, evidenceKind: "feedback", content, evidenceDigest: digest(content), sourceRef: "message:capability-gap", occurredAt: Date.now() });
		const maintained = await kernel.maintain({ profileId: "profile-a", trigger: "signal", maxItems: 10, maxModelCalls: 1, leaseMs: 30_000, now: observed.recordedAt + 1 });
		assert.equal(maintained.claimed, 2);
		assert.equal(maintained.completed, 2);
		assert.equal(maintained.deferred, 0);
		assert.equal(admitted.length, 1);
		assert.equal(admitted[0].statement, content);
		assert.equal(admitted[0].scope.chatId, scope.chatId);
		assert.deepEqual(admitted[0].evidenceRefs, [observed.observationId, `evidence:${digest(content)}`]);
		assert.deepEqual(maintained.createdObjectiveIds, [`objective:learning:${admitted[0].proposalId.slice(-16)}`]);
		assert.ok(maintained.transitions.some((transition) => transition.includes("learning_objective:admitted")));
		const repeated = await kernel.maintain({ profileId: "profile-a", trigger: "scheduled", maxItems: 10, maxModelCalls: 1, leaseMs: 30_000, now: observed.recordedAt + 2 });
		assert.equal(repeated.claimed, 0);
		assert.equal(admitted.length, 1);
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Learning Objective admission renews its SQLite lease until the governed runtime returns", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-objective-lease-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const persistence = memoryPersistencePorts(store);
		const rollout = new AutonomyRolloutController({ store: persistence.autonomyRollout, evidence: () => rolloutEvidence });
		for (const [index, level] of ["situation_context", "episode_publication", "adaptive_learning"].entries()) rollout.promote(level, { actor: "operator", evidenceRef: "evaluation:learning-objective-lease" }, 100 + index);
		let admissionStarted;
		const started = new Promise((resolve) => { admissionStarted = resolve; });
		let releaseAdmission;
		const released = new Promise((resolve) => { releaseAdmission = resolve; });
		let logicalNow = 0;
		const kernel = new DefaultMemoryLearningKernel({
			authority: persistence.memoryLearningAuthority,
			now: () => logicalNow,
			extractor: new DeterministicLearningExtractor(),
			learningObjectiveAdmission: { admit: async (candidate) => {
				admissionStarted();
				await released;
				return { status: "admitted", objectiveId: `objective:learning:${candidate.proposalId.slice(-16)}` };
			} },
		});
		const content = "Missing provider capability for source-backed verification";
		const observed = kernel.observe({ type: "evidence", scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" }, evidenceKind: "feedback", content, evidenceDigest: digest(content), occurredAt: Date.now() });
		const claimNow = observed.recordedAt + 1;
		logicalNow = claimNow + 50;
		const maintenance = kernel.maintain({ profileId: "profile-a", trigger: "signal", maxItems: 10, maxModelCalls: 1, leaseMs: 60, now: claimNow });
		await started;
		const claimableBeforeFirstHeartbeat = persistence.memoryLearningAuthority.claimLearningObjectives({ profileId: "profile-a", maxItems: 1, leaseMs: 60, now: claimNow + 61 });
		logicalNow = claimNow + 80;
		await new Promise((resolve) => setTimeout(resolve, 25));
		const claimableWhileAdmissionRuns = persistence.memoryLearningAuthority.claimLearningObjectives({ profileId: "profile-a", maxItems: 1, leaseMs: 60, now: claimNow + 111 });
		releaseAdmission();
		const maintained = await maintenance;
		assert.equal(claimableBeforeFirstHeartbeat.length, 0);
		assert.equal(claimableWhileAdmissionRuns.length, 0);
		assert.equal(maintained.failed, 0);
		assert.equal(maintained.deferred, 0);
		assert.equal(maintained.createdObjectiveIds.length, 1);
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("credential-bearing evidence is rejected before it can create learning work", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-secret-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const kernel = new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority, now: () => 1_700_000_000_000 });
		const receipt = kernel.observe({ type: "evidence", scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" }, evidenceKind: "source", content: "Authorization: Bearer sk-secret-value-123456789", evidenceDigest: digest("secret"), sourceRef: "source:unsafe" });
		assert.equal(receipt.accepted, false);
		assert.equal(receipt.reasonCode, "credential_rejected");
		const maintenance = await kernel.maintain({ profileId: "profile-a", trigger: "signal", maxItems: 10, maxModelCalls: 0, leaseMs: 30_000, now: 1_700_000_000_000 });
		assert.equal(maintenance.claimed, 0);
		store.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("unavailable Verification settles idempotently without applying assessment changes", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-settle-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const kernel = new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority });
		const input = {
			envelope: createExecutionEnvelope({ executionId: "execution:verification-unavailable", trigger: { kind: "task_transition" }, taskId: "task:report", taskRunId: "run:1" }),
			scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" },
			subject: { kind: "task", id: "task:report", revision: 1 },
			verificationRevision: 1,
			verificationDigest: digest("verification unavailable"),
			criteria: [{ criterionId: "C1", status: "unavailable", evidenceRefs: ["verifier:offline"] }],
			deliveryReceiptRefs: [],
			artifactReceiptRefs: [],
			policyVersion: "l4.v1",
		};
		const first = await kernel.settle(input);
		const duplicate = await kernel.settle(input);
		assert.equal(first.status, "settled");
		assert.equal(first.outcome, "unavailable");
		assert.equal(first.attributionStatus, "unknown");
		assert.deepEqual(first.appliedAssessmentEvents, []);
		assert.deepEqual(first.reasonCodes, ["verification_unavailable"]);
		assert.equal(duplicate.status, "duplicate");
		assert.equal(duplicate.settlementId, first.settlementId);
		store.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("accepted Task and Task Run settlement atomically creates one learning signal", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-task-signal-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		store.record({ id: "objective:learning", ownerKey: "owner", kind: "objective", title: "Report", status: "running", createdAt: 1 });
		store.record({ id: "task:learning", ownerKey: "owner", kind: "delegated", title: "Create report", parentId: "objective:learning", status: "running", createdAt: 2 });
		store.recordRun({ id: "run:learning", taskId: "task:learning", executor: "subagent", status: "running", startedAt: 3, leaseExpiresAt: 100 });
		assert.equal(store.settleTaskRunAndTask({ ownerKey: "owner", taskId: "task:learning", taskRunId: "run:learning", task: { status: "succeeded", finishedAt: 10, result: "accepted report" }, run: { status: "succeeded", finishedAt: 10, output: "accepted report" } }, 10), true);
		assert.equal(store.settleTaskRunAndTask({ ownerKey: "owner", taskId: "task:learning", taskRunId: "run:learning", task: { status: "succeeded", finishedAt: 10, result: "accepted report" }, run: { status: "succeeded", finishedAt: 10, output: "accepted report" } }, 10), false);
		const maintenance = await new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority }).maintain({ profileId: "profile-a", trigger: "signal", maxItems: 10, maxModelCalls: 0, leaseMs: 30_000, now: 11 });
		assert.equal(maintenance.claimed, 1);
		assert.equal(maintenance.completed, 1);
		assert.equal(maintenance.deferred, 0);
		const repeated = await new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority }).maintain({ profileId: "profile-a", trigger: "signal", maxItems: 10, maxModelCalls: 0, leaseMs: 30_000, now: 12 });
		assert.equal(repeated.claimed, 0);
		store.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("automatic Task learning settlement carries the exact persisted Artifact identity", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-task-artifact-"));
	const database = join(root, "memory.db");
	try {
		const store = new MemoryStore(database, "profile-a");
		const scope = { profileId: "profile-a", platform: "cli", chatId: "chat-a", chatType: "dm", userId: "user-a" };
		store.record({ id: "objective:artifact-learning", ownerKey: "owner", kind: "objective", title: "Report", status: "running", createdAt: 1 });
		store.record({ id: "task:artifact-learning", ownerKey: "owner", kind: "delegated", title: "Create report", parentId: "objective:artifact-learning", status: "running", executionScope: scope, acceptanceCriteria: "C1: report artifact exists", createdAt: 2 });
		store.recordRun({ id: "run:artifact-learning", taskId: "task:artifact-learning", executor: "subagent", status: "running", startedAt: 3, leaseExpiresAt: 100 });
		const manifest = createArtifactManifest({
			locator: { kind: "workspace", uri: "report.html" }, mediaType: "text/html", byteLength: 17, sha256: digest("verified report"),
			producer: { providerId: "test", providerVersion: "1", operation: "write" }, sourceRefs: ["source:test"], createdAt: 4,
		});
		assert.equal(store.settleTaskRunAndTask({
			ownerKey: "owner", taskId: "task:artifact-learning", taskRunId: "run:artifact-learning",
			task: { status: "succeeded", finishedAt: 10, result: "accepted report", verificationStatus: "accepted", criterionVerifications: [{ criterionId: "C1", criterion: "report artifact exists", status: "accepted", evidenceRefs: [manifest.id] }], artifacts: [{ type: "file", uri: "report.html", manifest }] },
			run: { status: "succeeded", finishedAt: 10, output: "accepted report" },
		}, 10), true);
		const maintained = await new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority })
			.maintain({ profileId: "profile-a", trigger: "signal", maxItems: 10, maxModelCalls: 0, leaseMs: 30_000, now: 11 });
		assert.equal(maintained.completed, 1);
		store.close();
		const raw = new Database(database, { readonly: true });
		assert.deepEqual(raw.prepare("SELECT ref_kind, evidence_ref FROM memory_settlement_evidence_refs").all(), [{ ref_kind: "artifact", evidence_ref: manifest.id }]);
		raw.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("verified Episode publication rolls back when the same Objective revision changes identity", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-objective-signal-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const base = {
			profileId: "profile-a", platform: "cli", chatId: "chat-a", chatType: "dm", userId: "user-a", objectiveId: "objective:report", sourceRevision: 1,
			situation: createSituation({ summary: "Deliver a verified gold report", confidence: 1 }), action: "Create report", evidence: "verification:accepted", status: "verified",
		};
		store.upsertVerifiedEpisodeAndSignal({ ...base, outcome: "Gold report version one" });
		assert.throws(
			() => store.upsertVerifiedEpisodeAndSignal({ ...base, outcome: "Different result under the same revision" }),
			/learning signal identity conflicts/i,
		);
		assert.equal(store.episodeForObjective("objective:report", { profileId: "profile-a" })?.outcome, "Gold report version one");
		const maintenance = await new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority })
			.maintain({ profileId: "profile-a", trigger: "signal", maxItems: 10, maxModelCalls: 0, leaseMs: 30_000, now: Date.now() + 1 });
		assert.equal(maintenance.claimed, 1);
		assert.equal(maintenance.completed, 1);
		const projectionPack = await new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority }).prepare({
			envelope: createExecutionEnvelope({ executionId: "execution:projection-recall", trigger: { kind: "interaction" } }),
			scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" },
			situation: createSituation({ summary: "Recall the previous gold report outcome", confidence: 1 }), query: "Gold report version one", queryDigest: digest("Gold report version one"), requiredItems: [], maxOptionalChars: 4_000, policyVersion: "l4.v1",
		});
		assert.ok(projectionPack.optionalItems.some((item) => item.component?.kind === "projection"));
		store.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("verified Episode publication rejects an older Objective revision without replacing newer knowledge", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-objective-revision-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const base = {
			profileId: "profile-a", platform: "cli", chatId: "chat-a", chatType: "dm", userId: "user-a", objectiveId: "objective:revision-fence",
			situation: createSituation({ summary: "Deliver a revision-fenced report", confidence: 1 }), action: "Create report", evidence: "verification:accepted", status: "verified",
		};
		store.upsertVerifiedEpisodeAndSignal({ ...base, sourceRevision: 2, outcome: "Gold report revision two" });
		assert.throws(
			() => store.upsertVerifiedEpisodeAndSignal({ ...base, sourceRevision: 1, outcome: "Stale gold report revision one" }),
			/stale|revision/i,
		);
		const episode = store.episodeForObjective("objective:revision-fence", { profileId: "profile-a" });
		assert.equal(episode?.outcome, "Gold report revision two");
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("accepted Verification correlates exposed Memory without changing semantic truth", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-positive-attribution-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const claim = store.upsertClaim({ profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", kind: "preference", statement: "Gold reports use Chinese headings", confidence: 0.91, stability: "high", visibility: "private" });
		const kernel = new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority, now: () => 1_700_000_000_000 });
		const envelope = createExecutionEnvelope({ executionId: "execution:positive-attribution", trigger: { kind: "task_transition" }, taskId: "task:positive", taskRunId: "run:positive" });
		await kernel.prepare({ envelope, scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" }, situation: createSituation({ summary: "Create a gold report with Chinese headings", confidence: 1 }), query: "gold report Chinese headings", queryDigest: digest("gold report Chinese headings"), requiredItems: [], maxOptionalChars: 2_000, policyVersion: "l4.v1" });
		const settlement = await kernel.settle({
			envelope, scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" },
			subject: { kind: "task", id: "task:positive", revision: 1 }, verificationRevision: 1, verificationDigest: digest("accepted:positive"),
			criteria: [{ criterionId: "C1", status: "accepted", evidenceRefs: ["verification:C1"] }], deliveryReceiptRefs: [], artifactReceiptRefs: [], policyVersion: "l4.v1",
		});
		assert.equal(settlement.status, "settled");
		assert.equal(settlement.attributionStatus, "partial");
		assert.equal(settlement.appliedAssessmentEvents.length, 2);
		const duplicate = await kernel.settle({
			envelope, scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" },
			subject: { kind: "task", id: "task:positive", revision: 1 }, verificationRevision: 1, verificationDigest: digest("accepted:positive"),
			criteria: [{ criterionId: "C1", status: "accepted", evidenceRefs: ["verification:C1"] }], deliveryReceiptRefs: [], artifactReceiptRefs: [], policyVersion: "l4.v1",
		});
		assert.equal(duplicate.status, "duplicate");
		assert.deepEqual(duplicate.appliedAssessmentEvents, settlement.appliedAssessmentEvents);
		assert.equal(store.listClaims({ profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a" }).find((item) => item.id === claim.id)?.confidence, 0.91);
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Learning Settlement durably retains content-free Artifact and Delivery receipt references", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-settlement-receipts-"));
	const database = join(root, "memory.db");
	try {
		const store = new MemoryStore(database, "profile-a");
		const kernel = new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority });
		const envelope = createExecutionEnvelope({ executionId: "execution:settlement-receipts", trigger: { kind: "task_transition" }, taskId: "task:settlement-receipts", taskRunId: "run:settlement-receipts" });
		const deliveryRef = `delivery-receipt:sha256:${digest("delivery receipt")}`;
		const artifactRef = `artifact-verification:sha256:${digest("artifact receipt")}`;
		const settled = await kernel.settle({
			envelope, scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" },
			subject: { kind: "task", id: "task:settlement-receipts", revision: 1 }, verificationRevision: 1, verificationDigest: digest("accepted:settlement-receipts"),
			criteria: [{ criterionId: "C1", status: "accepted", evidenceRefs: [artifactRef] }], deliveryReceiptRefs: [deliveryRef], artifactReceiptRefs: [artifactRef], policyVersion: "l4.v1",
		});
		assert.equal(settled.status, "settled");
		await assert.rejects(() => kernel.settle({
			envelope, scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" },
			subject: { kind: "task", id: "task:settlement-receipts", revision: 1 }, verificationRevision: 1, verificationDigest: digest("accepted:settlement-receipts"),
			criteria: [{ criterionId: "C1", status: "accepted", evidenceRefs: [artifactRef] }], deliveryReceiptRefs: [deliveryRef], artifactReceiptRefs: [`artifact-verification:sha256:${digest("different artifact")}`], policyVersion: "l4.v1",
		}), /identity conflicts/i);
		store.close();
		const raw = new Database(database, { readonly: true });
		const refs = raw.prepare("SELECT ref_kind, evidence_ref FROM memory_settlement_evidence_refs ORDER BY ref_kind, evidence_ref").all();
		assert.deepEqual(refs, [
			{ ref_kind: "artifact", evidence_ref: artifactRef },
			{ ref_kind: "delivery", evidence_ref: deliveryRef },
		]);
		raw.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejected Verification with ambiguous cause remains unknown and applies no penalty", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-unknown-attribution-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		store.upsertClaim({ profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", kind: "fact", statement: "Gold report source policy is documented", confidence: 0.9, visibility: "private" });
		const kernel = new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority });
		const envelope = createExecutionEnvelope({ executionId: "execution:unknown-attribution", trigger: { kind: "task_transition" }, taskId: "task:unknown", taskRunId: "run:unknown" });
		await kernel.prepare({ envelope, scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" }, situation: createSituation({ summary: "Check a gold report", confidence: 1 }), query: "gold report source policy", queryDigest: digest("gold report source policy"), requiredItems: [], maxOptionalChars: 2_000, policyVersion: "l4.v1" });
		const settlement = await kernel.settle({ envelope, scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" }, subject: { kind: "task", id: "task:unknown", revision: 1 }, verificationRevision: 1, verificationDigest: digest("rejected:unknown"), criteria: [{ criterionId: "C1", status: "rejected", evidenceRefs: ["verification:C1"] }], deliveryReceiptRefs: [], artifactReceiptRefs: [], policyVersion: "l4.v1" });
		assert.equal(settlement.outcome, "rejected");
		assert.equal(settlement.attributionStatus, "unknown");
		assert.deepEqual(settlement.appliedAssessmentEvents, []);
		assert.deepEqual(settlement.proposedTransitions, []);
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed Tool unrelated to the rejected criterion remains unknown and is not penalized", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-unrelated-failure-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const kernel = new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority });
		const envelope = createExecutionEnvelope({ executionId: "execution:unrelated-failure", trigger: { kind: "task_transition" }, taskId: "task:unrelated-failure", taskRunId: "run:unrelated-failure" });
		kernel.observe({
			type: "execution", scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" }, envelope,
			eventType: "tool.settled", status: "failed", traceRef: "execution:execution:unrelated-failure:tool-call:call-unrelated",
			component: { kind: "tool", id: "market_series", version: "1", digest: digest("market_series@1") }, occurredAt: Date.now() - 1,
		});
		const settlement = await kernel.settle({
			envelope, scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" },
			subject: { kind: "task", id: "task:unrelated-failure", revision: 1 }, verificationRevision: 1, verificationDigest: digest("rejected:unrelated"),
			criteria: [{ criterionId: "C1", status: "rejected", evidenceRefs: ["verification:criterion-C1"] }], deliveryReceiptRefs: [], artifactReceiptRefs: [], policyVersion: "l4.v1",
		});
		assert.equal(settlement.attributionStatus, "unknown");
		assert.deepEqual(settlement.appliedAssessmentEvents, []);
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("directly observed Tool failures are isolated and cross cautious then suppressed hysteresis", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-failure-attribution-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const kernel = new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority, now: () => 1_700_000_000_000 });
		const transitions = [];
		for (let attempt = 1; attempt <= 3; attempt++) {
			const envelope = createExecutionEnvelope({ executionId: `execution:tool-failure:${attempt}`, trigger: { kind: "task_transition" }, taskId: `task:tool-failure:${attempt}`, taskRunId: `run:tool-failure:${attempt}` });
			const traceRef = `execution:${envelope.executionId}:tool-call:market-series-${attempt}`;
			kernel.observe({ type: "execution", scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" }, envelope, eventType: "tool.settled", status: "failed", traceRef, component: { kind: "tool", id: "market_series", version: "1", digest: digest("market_series@1") } });
			const settlement = await kernel.settle({ envelope, scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" }, subject: { kind: "task", id: `task:tool-failure:${attempt}`, revision: 1 }, verificationRevision: 1, verificationDigest: digest(`rejected:tool:${attempt}`), criteria: [{ criterionId: "C1", status: "rejected", evidenceRefs: [traceRef] }], deliveryReceiptRefs: [], artifactReceiptRefs: [], policyVersion: "l4.v1" });
			assert.equal(settlement.attributionStatus, "supported");
			assert.equal(settlement.appliedAssessmentEvents.length, 1);
			transitions.push(...settlement.proposedTransitions);
		}
		assert.ok(transitions.some((item) => item.includes("eligible->cautious")));
		assert.ok(transitions.some((item) => item.includes("cautious->suppressed")));
		const rollout = new AutonomyRolloutController({ store: memoryPersistencePorts(store).autonomyRollout, evidence: () => rolloutEvidence });
		for (const [index, level] of ["situation_context", "episode_publication", "adaptive_learning"].entries()) rollout.promote(level, { actor: "operator", evidenceRef: "evaluation:routing" }, 100 + index);
		const routed = await kernel.prepare({
			envelope: createExecutionEnvelope({ executionId: "execution:tool-routing-after-failure", trigger: { kind: "interaction" } }),
			scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" },
			situation: createSituation({ summary: "Prepare a current market report", confidence: 1 }),
			query: "current market report", queryDigest: digest("current market report"), requiredItems: [], maxOptionalChars: 2_000, policyVersion: "l4.v1",
		});
		const directive = routed.routingDirectives.find((item) => item.component.kind === "tool" && item.component.id === "market_series" && item.component.version === "1");
		assert.equal(directive?.applicability, "suppressed");
		assert.match(directive?.receiptDigest ?? "", /^[a-f0-9]{64}$/);
		assert.doesNotMatch(routed.safePrefix, /market_series|suppressed/);
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("expired maintenance lease is reclaimed and the signal completes exactly once after restart", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-lease-recovery-"));
	const database = join(root, "memory.db");
	try {
		const first = new MemoryStore(database, "profile-a");
		first.upsertVerifiedEpisodeAndSignal({ profileId: "profile-a", platform: "cli", chatId: "chat-a", chatType: "dm", userId: "user-a", objectiveId: "objective:lease", sourceRevision: 1, situation: createSituation({ summary: "Recover projection maintenance", confidence: 1 }), action: "Create outcome", outcome: "Recovered outcome", status: "verified" });
		first.close();
		const raw = new Database(database);
		raw.prepare("UPDATE memory_learning_signals SET status = 'leased', lease_holder = 'crashed-worker', lease_token = 'stale-token', leased_at = 1, lease_expires_at = 5 WHERE profile_id = 'profile-a'").run();
		raw.close();
		const reopened = new MemoryStore(database, "profile-a");
		const kernel = new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(reopened).memoryLearningAuthority });
		const recovered = await kernel.maintain({ profileId: "profile-a", trigger: "recovery", maxItems: 10, maxModelCalls: 0, leaseMs: 30_000, now: 10 });
		assert.equal(recovered.claimed, 1);
		assert.equal(recovered.completed, 1);
		assert.equal(recovered.deferred, 0);
		assert.ok(recovered.transitions.some((item) => item.includes("projection:recent_outcomes")));
		assert.equal((await kernel.maintain({ profileId: "profile-a", trigger: "recovery", maxItems: 10, maxModelCalls: 0, leaseMs: 30_000, now: 11 })).claimed, 0);
		reopened.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("an existing Profile database is integrity-backed up before pending L4 migrations", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-migration-backup-"));
	const database = join(root, "memory.db");
	try {
		const legacy = new Database(database);
		legacy.exec("CREATE TABLE legacy_memory_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO legacy_memory_probe VALUES ('before-l4', 'retained');");
		legacy.close();
		const store = new MemoryStore(database, "profile-a");
		store.close();
		const backupName = readdirSync(root).find((name) => name.includes("pre-l4-v11-from-v0") && name.endsWith(".sqlite"));
		assert.ok(backupName);
		const backup = new Database(join(root, backupName), { readonly: true });
		assert.deepEqual(backup.prepare("SELECT * FROM legacy_memory_probe").get(), { id: "before-l4", value: "retained" });
		assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'memory_learning_settlements'").get().count, 0);
		assert.equal(backup.pragma("integrity_check", { simple: true }), "ok");
		backup.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("explicit scoped correction is deterministically admitted and invalidates the old Claim", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-correction-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const original = store.upsertClaim({ profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", kind: "preference", statement: "Gold reports use English headings", confidence: 0.9, stability: "high", visibility: "private" });
		const kernel = new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority, now: () => 1_700_000_000_000 });
		const receipt = kernel.observe({ type: "evidence", scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" }, evidenceKind: "correction", content: "Gold reports use Chinese headings", evidenceDigest: digest("Gold reports use Chinese headings"), sourceRef: `claim:${original.id}` });
		assert.equal(receipt.accepted, true);
		const maintained = await kernel.maintain({ profileId: "profile-a", trigger: "signal", maxItems: 10, maxModelCalls: 0, leaseMs: 30_000, now: Date.now() + 1 });
		assert.equal(maintained.completed, 1);
		assert.ok(maintained.transitions.some((item) => item.includes(`claim:${original.id}`) && item.includes("corrected")));
		assert.equal(store.listClaims({ profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", status: "active" })[0]?.statement, "Gold reports use Chinese headings");
		assert.equal(store.listClaims({ profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", status: "superseded" })[0]?.id, original.id);
		const projection = await kernel.prepare({ envelope: createExecutionEnvelope({ executionId: "execution:corrected-preference", trigger: { kind: "interaction" } }), scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" }, situation: createSituation({ summary: "Prepare another gold report", confidence: 1 }), query: "Gold reports Chinese headings", queryDigest: digest("Gold reports Chinese headings"), requiredItems: [], maxOptionalChars: 4_000, policyVersion: "l4.v1" });
		assert.ok(projection.optionalItems.some((item) => item.component?.kind === "projection" && item.text.includes("Chinese headings")));
		assert.equal((await kernel.maintain({ profileId: "profile-a", trigger: "signal", maxItems: 10, maxModelCalls: 0, leaseMs: 30_000, now: Date.now() + 2 })).claimed, 0);
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a corrected Claim cannot revive an invalidated Context Pack on an idempotent retry", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-pack-revision-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const original = store.upsertClaim({ profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", kind: "preference", statement: "Gold reports use English headings", confidence: 0.9, visibility: "private" });
		const kernel = new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority, now: () => 1_700_000_000_000 });
		const input = {
			envelope: createExecutionEnvelope({ executionId: "execution:corrected-retry", trigger: { kind: "interaction" } }),
			scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" },
			situation: createSituation({ summary: "Prepare a gold report", confidence: 1 }),
			query: "Gold report headings", queryDigest: digest("Gold report headings"), requiredItems: [], maxOptionalChars: 4_000, policyVersion: "l4.v1",
		};
		const first = await kernel.prepare(input);
		assert.ok(first.optionalItems.some((item) => item.text.includes("English headings")));
		kernel.observe({ type: "evidence", scope: input.scope, evidenceKind: "correction", content: "Gold reports use Chinese headings", evidenceDigest: digest("Gold reports use Chinese headings"), sourceRef: `claim:${original.id}` });
		await kernel.maintain({ profileId: "profile-a", trigger: "signal", maxItems: 10, maxModelCalls: 0, leaseMs: 30_000, now: Date.now() + 1 });

		const retried = await kernel.prepare(input);
		assert.notEqual(retried.packId, first.packId);
		assert.equal(retried.omitted.persistence_unavailable, 0);
		assert.ok(retried.optionalItems.some((item) => item.text.includes("Chinese headings")));
		assert.ok(retried.optionalItems.every((item) => !item.text.includes("English headings")));
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("correction cannot target a Claim outside its trusted scope", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-correction-scope-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const inaccessible = store.upsertClaim({ profileId: "profile-a", platform: "cli", chatId: "chat-b", userId: "user-b", kind: "preference", statement: "Private desk preference", confidence: 0.9, visibility: "private" });
		const kernel = new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority, now: () => 1_700_000_000_000 });
		kernel.observe({ type: "evidence", scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" }, evidenceKind: "correction", content: "Overwrite inaccessible preference", evidenceDigest: digest("Overwrite inaccessible preference"), sourceRef: `claim:${inaccessible.id}` });
		const maintained = await kernel.maintain({ profileId: "profile-a", trigger: "signal", maxItems: 10, maxModelCalls: 0, leaseMs: 30_000, now: Date.now() + 1 });
		assert.equal(maintained.completed, 0);
		assert.equal(maintained.failed, 1);
		assert.equal(store.listClaims({ profileId: "profile-a", platform: "cli", chatId: "chat-b", userId: "user-b" })[0]?.statement, "Private desk preference");
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("scheduled maintenance rebuilds a user preference projection from existing authoritative Claims", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-preference-projection-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		store.upsertClaim({ profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", kind: "preference", statement: "Use compact source tables in gold reports", confidence: 0.95, stability: "high", visibility: "private", source: { type: "message", ref: "message:preference" } });
		const kernel = new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority });
		const maintained = await kernel.maintain({ profileId: "profile-a", trigger: "scheduled", maxItems: 10, maxModelCalls: 0, leaseMs: 30_000, now: Date.now() + 1 });
		assert.equal(maintained.claimed, 1);
		assert.equal(maintained.completed, 1);
		assert.ok(maintained.transitions.some((item) => item.includes("projection:user_preferences")));
		const pack = await kernel.prepare({ envelope: createExecutionEnvelope({ executionId: "execution:existing-preference", trigger: { kind: "interaction" } }), scope: { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" }, situation: createSituation({ summary: "Prepare another gold report", confidence: 1 }), query: "compact source tables gold reports", queryDigest: digest("compact source tables gold reports"), requiredItems: [], maxOptionalChars: 4_000, policyVersion: "l4.v1" });
		assert.ok(pack.optionalItems.some((item) => item.component?.kind === "projection" && item.text.includes("compact source tables")));
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("contextual utility influences recall only while adaptive learning and its dependencies are enabled", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-rollout-influence-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		store.upsertClaim({ profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", kind: "preference", statement: "Use Chinese headings for gold reports", confidence: 0.9, visibility: "private" });
		const kernel = new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority, now: () => 1_700_000_000_000 });
		const scope = { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" };
		const situation = createSituation({ summary: "Create a gold report with Chinese headings", confidence: 1 });
		const firstEnvelope = createExecutionEnvelope({ executionId: "execution:utility-training", trigger: { kind: "task_transition" }, taskId: "task:utility", taskRunId: "run:utility" });
		const baseline = await kernel.prepare({ envelope: firstEnvelope, scope, situation, query: "gold report Chinese headings", queryDigest: digest("gold report Chinese headings"), requiredItems: [], maxOptionalChars: 2_000, policyVersion: "l4.v1" });
		await kernel.settle({ envelope: firstEnvelope, scope, subject: { kind: "task", id: "task:utility", revision: 1 }, verificationRevision: 1, verificationDigest: digest("utility accepted"), criteria: [{ criterionId: "C1", status: "accepted", evidenceRefs: ["verification:utility"] }], deliveryReceiptRefs: [], artifactReceiptRefs: [], policyVersion: "l4.v1" });
		const rollout = new AutonomyRolloutController({ store: memoryPersistencePorts(store).autonomyRollout, evidence: () => rolloutEvidence });
		for (const [index, level] of ["situation_context", "episode_publication", "adaptive_learning"].entries()) assert.equal(rollout.promote(level, { actor: "operator", evidenceRef: "evaluation:l4" }, 100 + index).outcome, "promoted");
		const influenced = await kernel.prepare({ envelope: createExecutionEnvelope({ executionId: "execution:utility-enabled", trigger: { kind: "interaction" } }), scope, situation, query: "gold report Chinese headings", queryDigest: digest("gold report Chinese headings"), requiredItems: [], maxOptionalChars: 2_000, policyVersion: "l4.v1" });
		assert.ok(influenced.receipts[0].score > baseline.receipts[0].score);
		rollout.stop("situation_context", { actor: "operator", evidenceRef: "incident:stop" }, 200);
		const stopped = await kernel.prepare({ envelope: createExecutionEnvelope({ executionId: "execution:utility-stopped", trigger: { kind: "interaction" } }), scope, situation, query: "gold report Chinese headings", queryDigest: digest("gold report Chinese headings"), requiredItems: [], maxOptionalChars: 2_000, policyVersion: "l4.v1" });
		assert.equal(stopped.receipts[0].score, baseline.receipts[0].score);
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Episode and Projection retrieval filters project scope before ranking and limiting", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-project-scope-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const common = { profileId: "profile-a", platform: "cli", chatId: "shared-chat", chatType: "dm", userId: "user-a", organizationId: "org-a", visibility: "private", sourceRevision: 1, action: "Create gold report", status: "verified" };
		store.upsertVerifiedEpisodeAndSignal({ ...common, projectId: "project-a", objectiveId: "objective:project-a", situation: createSituation({ summary: "Project A gold report", confidence: 1 }), outcome: "Project A gold report uses an amber source table" });
		store.upsertVerifiedEpisodeAndSignal({ ...common, projectId: "project-b", objectiveId: "objective:project-b", situation: createSituation({ summary: "Project B gold report", confidence: 1 }), outcome: "Project B gold report contains PRIVATE-B-DISTRACTOR repeated repeated repeated" });
		const kernel = new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority });
		const maintenance = await kernel.maintain({ profileId: "profile-a", trigger: "signal", maxItems: 10, maxModelCalls: 0, leaseMs: 30_000, now: Date.now() + 1 });
		assert.equal(maintenance.completed, 2);
		const pack = await kernel.prepare({ envelope: createExecutionEnvelope({ executionId: "execution:project-a", trigger: { kind: "interaction" } }), scope: { profileId: "profile-a", platform: "cli", chatId: "shared-chat", chatType: "dm", userId: "user-a", projectId: "project-a", organizationId: "org-a" }, situation: createSituation({ summary: "Reuse the project gold report", confidence: 1 }), query: "project gold report", queryDigest: digest("project gold report"), requiredItems: [], maxOptionalChars: 5_000, policyVersion: "l4.v1" });
		assert.ok(pack.optionalItems.some((item) => item.text.includes("amber source table")));
		assert.doesNotMatch(pack.safePrefix, /PRIVATE-B-DISTRACTOR/);
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("project-visible Episode and Projection knowledge is reusable across conversations but not across projects or organizations", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-cross-conversation-project-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		store.upsertVerifiedEpisodeAndSignal({
			profileId: "profile-a", platform: "feishu", chatId: "chat-origin", chatType: "group", userId: "user-origin", projectId: "project-a", organizationId: "org-a", visibility: "project",
			objectiveId: "objective:project-shared", sourceRevision: 1, situation: createSituation({ summary: "Cross-session project gold report", confidence: 1 }),
			action: "Create project report", outcome: "Cross-session amber source table is approved", status: "verified",
		});
		const kernel = new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority });
		await kernel.maintain({ profileId: "profile-a", trigger: "signal", maxItems: 10, maxModelCalls: 0, leaseMs: 30_000, now: Date.now() + 1 });
		const prepare = (projectId, executionId, organizationId = "org-a") => kernel.prepare({
			envelope: createExecutionEnvelope({ executionId, trigger: { kind: "interaction" } }),
			scope: { profileId: "profile-a", platform: "feishu", chatId: "chat-new", chatType: "group", userId: "user-new", projectId, organizationId },
			situation: createSituation({ summary: "Reuse cross-session project outcome", confidence: 1 }), query: "cross session amber source table",
			queryDigest: digest(`cross session amber source table:${projectId}`), requiredItems: [], maxOptionalChars: 5_000, policyVersion: "l4.v1",
		});
		const sameProject = await prepare("project-a", "execution:cross-conversation-project-a");
		assert.ok(sameProject.optionalItems.some((item) => item.text.includes("amber source table")));
		assert.ok(sameProject.optionalItems.some((item) => item.component?.kind === "episode"));
		assert.ok(sameProject.optionalItems.some((item) => item.component?.kind === "projection"));
		const otherProject = await prepare("project-b", "execution:cross-conversation-project-b");
		assert.ok(otherProject.optionalItems.every((item) => !item.text.includes("amber source table")));
		const otherOrganization = await prepare("project-a", "execution:cross-organization-project-a", "org-b");
		assert.ok(otherOrganization.optionalItems.every((item) => !item.text.includes("amber source table")), JSON.stringify(otherOrganization.optionalItems));
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a later Verification revision compensates prior reinforcement without inventing a failure cause", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-learning-verification-supersession-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		store.upsertClaim({ profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", kind: "preference", statement: "Use Chinese headings for gold reports", confidence: 0.9, visibility: "private" });
		const kernel = new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(store).memoryLearningAuthority, now: () => 1_700_000_000_000 });
		const scope = { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" };
		const situation = createSituation({ summary: "Create a gold report with Chinese headings", confidence: 1 });
		const envelope = createExecutionEnvelope({ executionId: "execution:superseded-verification", trigger: { kind: "task_transition" }, taskId: "task:superseded", taskRunId: "run:superseded" });
		const baseline = await kernel.prepare({ envelope, scope, situation, query: "gold report Chinese headings", queryDigest: digest("gold report Chinese headings"), requiredItems: [], maxOptionalChars: 2_000, policyVersion: "l4.v1" });
		await kernel.settle({ envelope, scope, subject: { kind: "task", id: "task:superseded", revision: 1 }, verificationRevision: 1, verificationDigest: digest("accepted:first"), criteria: [{ criterionId: "C1", status: "accepted", evidenceRefs: ["verification:first"] }], deliveryReceiptRefs: [], artifactReceiptRefs: [], policyVersion: "l4.v1" });
		const corrected = await kernel.settle({ envelope, scope, subject: { kind: "task", id: "task:superseded", revision: 1 }, verificationRevision: 2, verificationDigest: digest("rejected:corrected"), criteria: [{ criterionId: "C1", status: "rejected", evidenceRefs: ["verification:corrected"] }], deliveryReceiptRefs: [], artifactReceiptRefs: [], policyVersion: "l4.v1" });
		assert.equal(corrected.attributionStatus, "unknown");
		assert.equal(corrected.appliedAssessmentEvents.length, 2);
		assert.deepEqual(corrected.proposedTransitions, []);
		const rollout = new AutonomyRolloutController({ store: memoryPersistencePorts(store).autonomyRollout, evidence: () => rolloutEvidence });
		for (const [index, level] of ["situation_context", "episode_publication", "adaptive_learning"].entries()) rollout.promote(level, { actor: "operator", evidenceRef: "evaluation:l4" }, 100 + index);
		const after = await kernel.prepare({ envelope: createExecutionEnvelope({ executionId: "execution:after-compensation", trigger: { kind: "interaction" } }), scope, situation, query: "gold report Chinese headings", queryDigest: digest("gold report Chinese headings"), requiredItems: [], maxOptionalChars: 2_000, policyVersion: "l4.v1" });
		assert.equal(after.receipts[0].score, baseline.receipts[0].score);
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("managed Skill versions retain stable and deterministic canary pointers with durable selection receipts", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-managed-skill-canary-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const authority = memoryPersistencePorts(store).managedSkillLearning;
		const base = { profileId: "profile-a", name: "source-check", riskTier: "low", policyVersion: "l4.v1", acceptedTrialIds: ["trial:1", "trial:2", "trial:3"] };
		const stable = authority.registerVersion({ ...base, versionSha256: digest("instructions:v1"), artifactSha256: digest("artifact:v1"), signedReceiptRef: "skill-version:source-check:v1", registeredAt: 100 });
		assert.equal(stable.stableVersionSha256, digest("instructions:v1"));
		assert.equal(stable.canaryVersionSha256, undefined);
		const staged = authority.registerVersion({ ...base, versionSha256: digest("instructions:v2"), artifactSha256: digest("artifact:v2"), signedReceiptRef: "skill-version:source-check:v2", registeredAt: 200 });
		assert.equal(staged.stableVersionSha256, digest("instructions:v1"));
		assert.equal(staged.canaryVersionSha256, digest("instructions:v2"));

		const rollout = new AutonomyRolloutController({ store: memoryPersistencePorts(store).autonomyRollout, evidence: () => rolloutEvidence });
		for (const [index, level] of ["situation_context", "episode_publication", "adaptive_learning"].entries()) rollout.promote(level, { actor: "operator", evidenceRef: "evaluation:skill-canary" }, 300 + index);
		let selected;
		for (let index = 0; index < 1_000; index++) {
			const candidate = authority.selectVersion({ profileId: "profile-a", name: "source-check", executionId: `execution:canary:${index}`, policyVersion: "l4.v1", selectedAt: 400 + index });
			if (candidate?.channel === "canary") { selected = candidate; break; }
		}
		assert.ok(selected);
		assert.equal(selected.versionSha256, digest("instructions:v2"));
		assert.equal(selected.artifactSha256, digest("artifact:v2"));
		assert.ok(selected.bucket >= 0 && selected.bucket < 10);
		const duplicate = authority.selectVersion({ profileId: "profile-a", name: "source-check", executionId: selected.executionId, policyVersion: "l4.v1", selectedAt: 999 });
		assert.equal(duplicate.receiptId, selected.receiptId);
		assert.equal(duplicate.receiptDigest, selected.receiptDigest);
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("managed Skill canary rolls back after supported repeated failures", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-managed-skill-rollback-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const persistence = memoryPersistencePorts(store);
		const managed = persistence.managedSkillLearning;
		const stableVersion = digest("rollback:instructions:v1");
		const stableArtifact = digest("rollback:artifact:v1");
		const canaryVersion = digest("rollback:instructions:v2");
		const canaryArtifact = digest("rollback:artifact:v2");
		const registration = { profileId: "profile-a", name: "source-check", riskTier: "low", policyVersion: "l4.v1", acceptedTrialIds: ["trial:1", "trial:2", "trial:3"] };
		managed.registerVersion({ ...registration, versionSha256: stableVersion, artifactSha256: stableArtifact, signedReceiptRef: "skill-version:rollback:v1", registeredAt: 100 });
		managed.registerVersion({ ...registration, versionSha256: canaryVersion, artifactSha256: canaryArtifact, signedReceiptRef: "skill-version:rollback:v2", registeredAt: 200 });
		const rollout = new AutonomyRolloutController({ store: persistence.autonomyRollout, evidence: () => rolloutEvidence });
		for (const [index, level] of ["situation_context", "episode_publication", "adaptive_learning"].entries()) rollout.promote(level, { actor: "operator", evidenceRef: "evaluation:skill-rollback" }, 300 + index);
		const kernel = new DefaultMemoryLearningKernel({ authority: persistence.memoryLearningAuthority });
		const scope = { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" };
		for (let attempt = 1; attempt <= 3; attempt++) {
			const envelope = createExecutionEnvelope({ executionId: `execution:skill-canary-failure:${attempt}`, trigger: { kind: "task_transition" }, taskId: `task:skill-canary-failure:${attempt}`, taskRunId: `run:skill-canary-failure:${attempt}` });
			const traceRef = `execution:${envelope.executionId}:tool-call:source-check-${attempt}`;
			kernel.observe({ type: "execution", scope, envelope, eventType: "tool.settled", status: "failed", traceRef, component: { kind: "skill", id: "source-check", version: `sha256:${canaryArtifact}`, digest: digest(`source-check:${canaryArtifact}`) } });
			await kernel.settle({ envelope, scope, subject: { kind: "task", id: `task:skill-canary-failure:${attempt}`, revision: 1 }, verificationRevision: 1, verificationDigest: digest(`skill-canary-rejected:${attempt}`), criteria: [{ criterionId: "C1", status: "rejected", evidenceRefs: [traceRef] }], deliveryReceiptRefs: [], artifactReceiptRefs: [], policyVersion: "l4.v1" });
		}
		const maintained = await kernel.maintain({ profileId: "profile-a", trigger: "scheduled", maxItems: 20, maxModelCalls: 0, leaseMs: 30_000, now: 1_000 });
		assert.ok(maintained.transitions.some((transition) => transition.includes("managed_skill:source-check:automatic_rollback")));
		const selected = managed.selectVersion({ profileId: "profile-a", name: "source-check", executionId: "execution:after-rollback", policyVersion: "l4.v1", selectedAt: 1_001 });
		assert.equal(selected.channel, "stable");
		assert.equal(selected.versionSha256, stableVersion);
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("managed Skill canary promotes only after sufficient accepted artifact evidence", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-managed-skill-promotion-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const persistence = memoryPersistencePorts(store);
		const managed = persistence.managedSkillLearning;
		const stableVersion = digest("promotion:instructions:v1");
		const canaryVersion = digest("promotion:instructions:v2");
		const canaryArtifact = digest("promotion:artifact:v2");
		const registration = { profileId: "profile-a", name: "source-check", riskTier: "low", policyVersion: "l4.v1", acceptedTrialIds: ["trial:1", "trial:2", "trial:3"] };
		managed.registerVersion({ ...registration, versionSha256: stableVersion, artifactSha256: digest("promotion:artifact:v1"), signedReceiptRef: "skill-version:promotion:v1", registeredAt: 100 });
		managed.registerVersion({ ...registration, versionSha256: canaryVersion, artifactSha256: canaryArtifact, signedReceiptRef: "skill-version:promotion:v2", registeredAt: 200 });
		const rollout = new AutonomyRolloutController({ store: persistence.autonomyRollout, evidence: () => rolloutEvidence });
		for (const [index, level] of ["situation_context", "episode_publication", "adaptive_learning"].entries()) rollout.promote(level, { actor: "operator", evidenceRef: "evaluation:skill-promotion" }, 300 + index);
		const kernel = new DefaultMemoryLearningKernel({ authority: persistence.memoryLearningAuthority });
		const scope = { profileId: "profile-a", platform: "cli", chatId: "chat-a", userId: "user-a", chatType: "dm" };
		for (let attempt = 1; attempt <= 16; attempt++) {
			const envelope = createExecutionEnvelope({ executionId: `execution:skill-canary-success:${attempt}`, trigger: { kind: "task_transition" }, taskId: `task:skill-canary-success:${attempt}`, taskRunId: `run:skill-canary-success:${attempt}` });
			const traceRef = `execution:${envelope.executionId}:tool-call:source-check-${attempt}`;
			kernel.observe({ type: "execution", scope, envelope, eventType: "tool.settled", status: "succeeded", traceRef, component: { kind: "skill", id: "source-check", version: `sha256:${canaryArtifact}`, digest: digest(`source-check:${canaryArtifact}`) } });
			await kernel.settle({ envelope, scope, subject: { kind: "task", id: `task:skill-canary-success:${attempt}`, revision: 1 }, verificationRevision: 1, verificationDigest: digest(`skill-canary-accepted:${attempt}`), criteria: [{ criterionId: "C1", status: "accepted", evidenceRefs: [traceRef] }], deliveryReceiptRefs: [], artifactReceiptRefs: [], policyVersion: "l4.v1" });
		}
		const maintained = await kernel.maintain({ profileId: "profile-a", trigger: "scheduled", maxItems: 40, maxModelCalls: 0, leaseMs: 30_000, now: 2_000 });
		assert.ok(maintained.transitions.some((transition) => transition.includes("managed_skill:source-check:canary_promoted")));
		const selected = managed.selectVersion({ profileId: "profile-a", name: "source-check", executionId: "execution:after-promotion", policyVersion: "l4.v1", selectedAt: 2_001 });
		assert.equal(selected.channel, "stable");
		assert.equal(selected.versionSha256, canaryVersion);
		assert.equal(selected.artifactSha256, canaryArtifact);
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});
