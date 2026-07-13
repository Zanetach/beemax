import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	AutomationStore,
	computeNextRun,
	parseDuration,
} from "../dist/index.js";
import { AutomationScheduler, HeartbeatRunner, filterHeartbeatAnswer, isWithinActiveHours } from "@beemax/core";

function withStore(run) {
	const root = mkdtempSync(join(tmpdir(), "beemax-automation-test-"));
	const store = new AutomationStore(join(root, "state.db"));
	return Promise.resolve(run(store)).finally(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
}

test("persistent one-shot reminders claim once and delete after success", () => withStore((store) => {
	const now = Date.parse("2026-01-01T00:00:00Z");
	const job = store.create({ platform:"feishu",chatId:"chat",userId:"user",name:"Tea",kind:"reminder",scheduleKind:"at",schedule:"10m",text:"Drink tea" }, now);
	assert.equal(job.nextRunAt, now + 600_000);
	assert.equal(store.claimDue(now + 599_999).length, 0);
	const claimed = store.claimDue(now + 600_000);
	assert.equal(claimed.length, 1);
	store.complete(claimed[0], { startedAt:now+600_000,finishedAt:now+600_100,status:"ok",output:"sent" }, now+600_100);
	assert.equal(store.get(job.id), undefined);
}));

test("recurring jobs persist next run, ownership, history, and retry state", () => withStore((store) => {
	const now = Date.parse("2026-01-01T00:00:00Z");
	const owner = { platform:"feishu",chatId:"chat-a",userId:"user" };
	const job = store.create({ ...owner,name:"Digest",kind:"agent",scheduleKind:"every",schedule:"1h",text:"Summarize" }, now);
	assert.equal(store.list({ ...owner, chatId:"chat-b" }).length, 1);
	const claimed = store.claimDue(now + 3_600_000)[0];
	store.complete(claimed, { startedAt:now+3_600_000,finishedAt:now+3_600_010,status:"error",error:"network" }, now+3_600_010);
	const failed = store.get(job.id);
	assert.equal(failed.consecutiveErrors, 1);
	assert.equal(failed.nextRunAt, now + 3_630_010);
	assert.equal(store.runs(job.id, owner).length, 1);
	assert.equal(store.remove(job.id, { platform:"feishu",chatId:"other",userId:"other" }), false);
}));

test("expired automation claims cannot commit after a replacement worker takes ownership", () => withStore((store) => {
	const now = Date.parse("2026-01-01T00:00:00Z");
	const job = store.create({ platform:"feishu",chatId:"chat",name:"Digest",kind:"agent",scheduleKind:"every",schedule:"1h",text:"run" }, now);
	const first = store.claimDue(now + 3_600_000, 1, 100)[0];
	const second = store.claimDue(now + 3_600_101, 1, 100)[0];
	assert.notEqual(first.claimToken, second.claimToken);
	assert.equal(store.complete(first, { startedAt:now,finishedAt:now+1,status:"ok" }, now + 3_600_102), false);
	assert.equal(store.complete(second, { startedAt:now,finishedAt:now+2,status:"ok" }, now + 3_600_103), true);
	assert.equal(store.runs(job.id, { platform:"feishu",chatId:"chat" }).length, 1);
}));

test("scheduler keeps a Schedule as a Trigger and leaves durable responsibility to its executor", async () => {
	const job = { id:"job",platform:"feishu",chatId:"chat",name:"Test",kind:"reminder",scheduleKind:"at",schedule:"1m",text:"test",enabled:true,deleteAfterRun:true,nextRunAt:0,consecutiveErrors:0,createdAt:0,updatedAt:0 };
	let claimed = false;
	let completed;
	let resolveComplete;
	const completion = new Promise((resolve) => { resolveComplete = resolve; });
	const store = {
		claimDue: () => claimed ? [] : (claimed = true, [job]),
		nextDueAt: () => undefined,
		complete: (_job, result) => { completed = result; resolveComplete(); },
	};
	const tasks = new Map();
	const runs = new Map();
	const ledger = {
		record: (task) => tasks.set(task.id, { ...task }),
		transition: (id, change) => tasks.set(id, { ...tasks.get(id), ...change }),
		recordRun: (run) => runs.set(run.id, { ...run }),
		transitionRun: (id, change) => runs.set(id, { ...runs.get(id), ...change }),
	};
	const scheduler = new AutomationScheduler(store, async () => ({ output:"sent" }), 1, ledger);
	scheduler.start();
	await completion;
	await scheduler.stop();
	assert.equal(completed.status, "ok");
	assert.equal(completed.output, "sent");
	assert.equal(tasks.size, 0);
	assert.equal(runs.size, 0);
});

test("duration, cron timezone, heartbeat ack, and overnight active hours", () => {
	assert.equal(parseDuration("2h"), 7_200_000);
	const now = Date.parse("2026-01-01T00:00:00Z");
	assert.equal(computeNextRun("cron", "0 9 * * *", "Asia/Shanghai", now), Date.parse("2026-01-01T01:00:00Z"));
	assert.deepEqual(filterHeartbeatAnswer("HEARTBEAT_OK", 300), { notify:false,text:"" });
	assert.equal(filterHeartbeatAnswer("Action needed", 300).notify, true);
	assert.equal(isWithinActiveHours({start:"22:00",end:"06:00",timezone:"UTC"}, Date.parse("2026-01-01T23:00:00Z")), true);
	assert.equal(isWithinActiveHours({start:"22:00",end:"06:00",timezone:"UTC"}, Date.parse("2026-01-01T12:00:00Z")), false);
});

test("heartbeat stays silent on OK and delivers actionable alerts", async () => withStore(async (store) => {
	const route = { platform:"feishu",chatId:"chat",userId:"user" };
	store.setLastRoute(route);
	const deliveries = [];
	let answer = "HEARTBEAT_OK";
	const runner = new HeartbeatRunner(store, {
		enabled:true,every:"1h",platform:"feishu",prompt:"check",ackMaxChars:300,timeoutMs:1000,
	}, async () => answer, { sendText: async (_route,text) => { deliveries.push(text); }, sendMedia: async () => undefined }, () => false);
	runner.start();
	await runner.wake();
	assert.equal(deliveries.length, 0);
	assert.equal(store.lastHeartbeat().status, "ok");
	answer = "Upcoming meeting needs preparation";
	await runner.wake();
	assert.deepEqual(deliveries, ["Upcoming meeting needs preparation"]);
	assert.equal(store.lastHeartbeat().status, "alert");
	await runner.stop();
}));

test("heartbeat delegates observe-only Initiative without executing the Agent or notifying", async () => withStore(async (store) => {
	const route = { platform:"feishu",chatId:"chat",userId:"user" };
	store.setLastRoute(route);
	const observations = [];
	const runner = new HeartbeatRunner(store, {
		enabled:true,every:"1h",platform:"feishu",prompt:"check",ackMaxChars:300,timeoutMs:1000,
	}, async () => { assert.fail("observe-only heartbeat must not execute the legacy Agent path"); },
	{ sendText: async () => { assert.fail("observe-only heartbeat must not notify"); }, sendMedia: async () => undefined },
	() => false,
	async (input) => { observations.push(input); return { kind: "observed" }; });
	runner.start();
	await runner.wake();
	assert.equal(observations.length, 1);
	assert.equal(observations[0].triggerId, "heartbeat:feishu:user");
	assert.equal(store.lastHeartbeat().status, "observed");
	await runner.stop();
}));

test("concurrent heartbeat wake is single-flight and stop aborts the retained run", async () => withStore(async (store) => {
	store.setLastRoute({ platform: "feishu", chatId: "chat", userId: "user" });
	let calls = 0;
	let observedSignal;
	const runner = new HeartbeatRunner(store, {
		enabled: true, every: "1h", platform: "feishu", prompt: "check", ackMaxChars: 300, timeoutMs: 1000,
	}, async (_input, signal) => {
		calls++;
		observedSignal = signal;
		return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
	}, { sendText: async () => undefined, sendMedia: async () => undefined }, () => false);
	runner.start();
	const first = runner.wake();
	await new Promise((resolve) => setImmediate(resolve));
	const second = runner.wake();
	await runner.stop();
	await Promise.all([first, second]);
	assert.equal(calls, 1);
	assert.equal(observedSignal.aborted, true);
}));

test("media deliveries persist across send failures and become claimable for retry", () => withStore((store) => {
	const delivery = store.enqueueMedia({ platform: "feishu", chatId: "chat", userId: "user" }, { path: "/tmp/generated.png", mimeType: "image/png" }, 1_000);
	const claimed = store.claimMediaDue(1_000);
	assert.equal(claimed.length, 1);
	assert.equal(claimed[0].id, delivery.id);
	store.failMedia(delivery.id, 1_000);
	assert.equal(store.claimMediaDue(30_999).length, 0);
	assert.equal(store.claimMediaDue(31_000).length, 1);
	store.completeMedia(delivery.id);
	assert.equal(store.claimMediaDue(1_000_000).length, 0);
}));

test("expired media delivery leases are reclaimed after a worker crash", () => withStore((store) => {
	const delivery = store.enqueueMedia({ platform: "feishu", chatId: "chat" }, { path: "/tmp/generated.png" }, 1_000);
	assert.equal(store.claimMediaDue(1_000, 1, 5_000)[0].id, delivery.id);
	assert.equal(store.claimMediaDue(5_999).length, 0);
	const reclaimed = store.claimMediaDue(6_000, 1, 5_000);
	assert.equal(reclaimed.length, 1);
	assert.equal(reclaimed[0].id, delivery.id);
	assert.equal(reclaimed[0].attempts, 1);
}));

test("media delivery poison work is abandoned after bounded attempts", () => withStore((store) => {
	const item = store.enqueueMedia({ platform:"feishu",chatId:"chat" }, { path:"/missing.png" }, 0);
	let now = 0;
	for (let attempt = 0; attempt < 10; attempt++) {
		const claimed = store.claimMediaDue(now, 1, 1)[0];
		assert.equal(claimed.id, item.id);
		store.failMedia(item.id, now);
		now += 60 * 60_000;
	}
	assert.equal(store.claimMediaDue(now, 1).length, 0);
}));
