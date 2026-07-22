import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileAgentRuntime, createProfileRuntime } from "../dist/runtime-composition.js";
import { attestAgentFactorySecurity } from "../dist/agent-factory.js";
import { DeterministicWorkContractBuilder } from "@thruvera/core";
import { MemoryStore } from "@thruvera/memory";

test("Profile Agent composition rejects missing Work Contract cognition before starting resources", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-profile-runtime-admission-"));
	const events = [];
	try {
		await assert.rejects(createProfileAgentRuntime({
			profileId: "personal",
			agentDir: root,
			policy: {},
			runtime: { createAgent: async () => { throw new Error("unused"); } },
			resources: [{ name: "memory", start: () => { events.push("start:memory"); }, dispose: () => { events.push("dispose:memory"); } }],
		}), /Work Contract Builder is required/i);
		assert.deepEqual(events, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Profile Agent composition gives every surface the same durable interaction and session wiring", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-profile-runtime-"));
	const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
	const profile = await createProfileAgentRuntime({
		profileId: "personal",
		agentDir: root,
		policy: { maxSessions: 2 },
		runtime: {
			workContractBuilder: new DeterministicWorkContractBuilder(),
			createAgent: async () => ({
				agent: { state: { model: { id: "test" }, messages: [] } },
				subscribe: () => () => undefined,
				prompt: async () => undefined,
				abort: async () => undefined,
				dispose: () => undefined,
			}),
		},
	});
	try {
		await profile.interaction.dispatch({ type: "message.send", source, text: "hello", input: { timeoutMs: 1_000 } });
		const events = await readFile(join(root, "interaction-events.jsonl"), "utf8");
		const sessions = await readFile(join(root, "sessions", "beemax-session-index.json"), "utf8");
		assert.match(events, /"profileId":"personal"/);
		assert.match(sessions, /"owner":"cli:local:local"/);
	} finally {
		await profile.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test("Profile Runtime rolls back partial startup and disposes owned resources in reverse order", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-profile-lifecycle-"));
	const events = [];
	const resource = (name, fail = false) => ({
		name,
		start: async () => { events.push(`start:${name}`); if (fail) throw new Error(`failed:${name}`); },
		dispose: async () => { events.push(`dispose:${name}`); },
	});
	const options = {
		profileId: "personal",
		agentDir: root,
		policy: {},
		runtime: { workContractBuilder: new DeterministicWorkContractBuilder(), createAgent: async () => { throw new Error("unused"); } },
	};
	try {
		await assert.rejects(createProfileAgentRuntime({ ...options, resources: [resource("memory"), resource("effects"), resource("recovery", true)] }), /failed:recovery/);
		assert.deepEqual(events, ["start:memory", "start:effects", "start:recovery", "dispose:effects", "dispose:memory"]);
		events.length = 0;
		const profile = await createProfileAgentRuntime({ ...options, resources: [resource("memory"), resource("effects"), resource("recovery")] });
		await profile.dispose();
		await profile.dispose();
		assert.deepEqual(events, ["start:memory", "start:effects", "start:recovery", "dispose:recovery", "dispose:effects", "dispose:memory"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Profile Runtime attempts every owned resource disposal before reporting shutdown failures", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-profile-disposal-failure-"));
	const events = [];
	const profile = await createProfileAgentRuntime({
		profileId: "personal",
		agentDir: root,
		policy: {},
		runtime: { workContractBuilder: new DeterministicWorkContractBuilder(), createAgent: async () => { throw new Error("unused"); } },
		resources: [
			{ name: "memory", dispose: () => { events.push("dispose:memory"); } },
			{ name: "effects", dispose: () => { events.push("dispose:effects"); throw new Error("effects close failed"); } },
			{ name: "recovery", dispose: () => { events.push("dispose:recovery"); } },
		],
	});
	try {
		await assert.rejects(profile.dispose(), (error) => error instanceof AggregateError && error.errors.some((item) => /effects close failed/.test(String(item.cause ?? item))));
		assert.deepEqual(events, ["dispose:recovery", "dispose:effects", "dispose:memory"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Profile Runtime composes the durable work graph and Pi graph through one seam", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-unified-profile-runtime-"));
	const memory = new MemoryStore(join(root, "memory.db"), "personal");
	let composed = false;
	const profile = await createProfileRuntime({
		work: {
			agentDir: root, ledger: memory, maxConcurrent: 2, maxSubagents: 2, taskTimeoutMs: 1_000, subagentsEnabled: false,
			executeTask: async () => ({ output: "done" }), verifyTaskCandidate: async () => ({ accepted: true }),
			deliverObjective: async () => ({ result: "done" }), executeSubagent: async () => "done",
		},
		resources: [{ name: "memory", dispose: () => memory.close() }],
		compose: (work) => {
			composed = true;
			return {
				profileId: "personal", agentDir: root, policy: {},
				runtime: { workContractBuilder: new DeterministicWorkContractBuilder(), planningPolicy: work.planningPolicy, planningBudgets: work.planningBudgets, taskLedger: memory, createAgent: attestAgentFactorySecurity(async () => ({ agent: { state: { model: { id: "test" }, messages: [] } }, subscribe: () => () => undefined, prompt: async () => undefined, abort: async () => undefined, dispose: () => undefined }), work.toolEffects) },
			};
		},
	});
	try {
		assert.equal(composed, true);
		assert.equal(profile.work.taskScheduler.snapshot().maxConcurrent, 2);
		assert.equal(typeof profile.runtime.run, "function");
	} finally {
		await profile.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test("channel composition cannot start a main Agent without the shared Governance and Effect binding", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-profile-security-contract-"));
	const memory = new MemoryStore(join(root, "memory.db"), "personal");
	try {
		await assert.rejects(createProfileRuntime({
			work: {
				agentDir: root, ledger: memory, maxConcurrent: 1, maxSubagents: 1, taskTimeoutMs: 1_000, subagentsEnabled: false,
				executeTask: async () => ({}), verifyTaskCandidate: async () => ({ accepted: true }), deliverObjective: async () => ({ result: "done" }), executeSubagent: async () => "done",
			},
			resources: [{ name: "memory", dispose: () => memory.close() }],
			compose: () => ({ profileId: "personal", agentDir: root, policy: {}, runtime: { workContractBuilder: new DeterministicWorkContractBuilder(), createAgent: async () => ({}) } }),
		}), /Governance.*Effect Authority/i);
	} finally {
		try { memory.close(); } catch { /* disposed by failed composition */ }
		await rm(root, { recursive: true, force: true });
	}
});

test("unified Profile Runtime releases external and work resources when channel composition fails", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-profile-compose-failure-"));
	const memory = new MemoryStore(join(root, "memory.db"), "personal");
	let memoryDisposed = false;
	try {
		await assert.rejects(createProfileRuntime({
			work: {
				agentDir: root, ledger: memory, maxConcurrent: 1, maxSubagents: 1, taskTimeoutMs: 1_000, subagentsEnabled: false,
				executeTask: async () => ({}), verifyTaskCandidate: async () => ({ accepted: true }), deliverObjective: async () => ({ result: "done" }), executeSubagent: async () => "done",
			},
			resources: [{ name: "memory", dispose: () => { memoryDisposed = true; memory.close(); } }],
			compose: () => { throw new Error("channel composition failed"); },
		}), /channel composition failed/);
		assert.equal(memoryDisposed, true);
	} finally {
		if (!memoryDisposed) memory.close();
		await rm(root, { recursive: true, force: true });
	}
});
