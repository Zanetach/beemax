import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createEnterprisePolicyPublisher } from "../../core/dist/index.js";
import { MemoryStore, memoryPersistencePorts } from "../dist/index.js";

const publisher = createEnterprisePolicyPublisher({ id: "publisher:admin", authority: { kind: "administrator_grant", reference: "admin:1" }, evidenceRef: "admin:audit:1", issuedAt: 100 });

test("Emergency Stop and Compensation exercise evidence persist with multi-instance fencing", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-reversible-controls-"));
	const path = join(root, "memory.db");
	const first = new MemoryStore(path, "profile");
	const second = new MemoryStore(path, "profile");
	try {
		const controlsA = memoryPersistencePorts(first).reversibleActionControls;
		const controlsB = memoryPersistencePorts(second).reversibleActionControls;
		assert.deepEqual(controlsA.emergencyStop("scope:operations"), { scopeId: "scope:operations", status: "stopped", revision: 0, changedAt: 0 });
		assert.equal(controlsA.setEmergencyStop({ scopeId: "scope:operations", status: "running", expectedRevision: 0, publisher, evidenceRef: "change:1", changedAt: 200 }), true);
		assert.deepEqual(controlsB.emergencyStop("scope:operations"), { scopeId: "scope:operations", status: "running", revision: 1, changedAt: 200, publisherId: publisher.id, evidenceRef: "change:1" });
		assert.equal(controlsB.setEmergencyStop({ scopeId: "scope:operations", status: "stopped", expectedRevision: 0, publisher, evidenceRef: "stale", changedAt: 201 }), false);

		const proof = {
			id: "compensation:external_update:v1", capability: "external_restore",
			receiptProofProvider: "provider-a", exercisedAt: 210, validUntil: 1_000, evidenceRefs: ["drill:210"],
		};
		assert.equal(controlsA.recordCompensationExercise({ scopeId: "scope:operations", forwardCapability: "external_update", proof, publisher }), true);
		assert.deepEqual(controlsB.compensationProof("scope:operations", "external_update", 500), proof);
		assert.equal(controlsB.setEmergencyStop({ scopeId: "scope:operations", status: "stopped", expectedRevision: 1, publisher, evidenceRef: "incident:1", changedAt: 220 }), true);
		assert.equal(controlsA.emergencyStop("scope:operations").status, "stopped");
	} finally {
		second.close();
		first.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("legacy global Compensation identities migrate transactionally to Profile-scoped identities", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-reversible-controls-migration-"));
	const path = join(root, "memory.db");
	const legacy = new Database(path);
	legacy.exec(`CREATE TABLE compensation_exercises (
		id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, scope_id TEXT NOT NULL, forward_capability TEXT NOT NULL,
		compensation_capability TEXT NOT NULL, receipt_proof_provider TEXT, exercised_at INTEGER NOT NULL,
		valid_until INTEGER NOT NULL, evidence_refs TEXT NOT NULL, publisher_id TEXT NOT NULL, created_at INTEGER NOT NULL,
		UNIQUE(profile_id, scope_id, forward_capability, id));
		INSERT INTO compensation_exercises VALUES ('proof:legacy', 'profile', 'scope:operations', 'external_update', 'external_restore', 'provider-a', 210, 1000, '["drill:210"]', 'publisher:admin', 210);`);
	legacy.close();
	const store = new MemoryStore(path, "profile");
	try {
		assert.deepEqual(store.compensationProof("scope:operations", "external_update", 500), { id: "proof:legacy", capability: "external_restore", receiptProofProvider: "provider-a", exercisedAt: 210, validUntil: 1_000, evidenceRefs: ["drill:210"] });
		const migrated = new Database(path, { readonly: true });
		try {
			const primaryKey = migrated.prepare("PRAGMA table_info(compensation_exercises)").all().filter((column) => column.pk).sort((left, right) => left.pk - right.pk).map((column) => column.name);
			assert.deepEqual(primaryKey, ["profile_id", "id"]);
		} finally { migrated.close(); }
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
