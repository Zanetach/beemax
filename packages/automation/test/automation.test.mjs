import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
	AutomationStore,
	computeNextRun,
	parseDuration,
} from "../dist/index.js";
import { AutomationDeliveryWorker, AutomationScheduler, HeartbeatRunner, filterHeartbeatAnswer, isWithinActiveHours } from "@beemax/core";

function withStore(run) {
	const root = mkdtempSync(join(tmpdir(), "beemax-automation-test-"));
	const store = new AutomationStore(join(root, "state.db"));
	return Promise.resolve(run(store)).finally(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
}

test("v1.1 Schedule storage migrates additively without losing existing definitions", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-automation-migration-"));
	const path = join(root, "state.db");
	const legacy = new Database(path);
	legacy.exec(`CREATE TABLE automation_jobs (
		id TEXT PRIMARY KEY, platform TEXT NOT NULL, chat_id TEXT NOT NULL, user_id TEXT,
		name TEXT NOT NULL, kind TEXT NOT NULL, schedule_kind TEXT NOT NULL, schedule_value TEXT NOT NULL,
		timezone TEXT, payload_text TEXT NOT NULL, enabled INTEGER NOT NULL, delete_after_run INTEGER NOT NULL,
		next_run_at INTEGER NOT NULL, last_run_at INTEGER, last_status TEXT,
		consecutive_errors INTEGER NOT NULL DEFAULT 0, locked_until INTEGER, claim_token TEXT,
		created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
	)`);
	legacy.prepare(`INSERT INTO automation_jobs (id,platform,chat_id,user_id,name,kind,schedule_kind,schedule_value,payload_text,enabled,delete_after_run,next_run_at,created_at,updated_at)
		VALUES ('legacy','feishu','chat','user','Digest','agent','every','1h','Summarize',1,0,2000,1000,1000)`).run();
	legacy.close();
	const store = new AutomationStore(path);
	try {
		const migrated = store.get("legacy", { platform:"feishu",chatId:"chat",userId:"user" });
		assert.equal(migrated.name, "Digest");
		assert.equal(migrated.maxAttempts, 3);
		assert.equal(migrated.misfirePolicy, "run_once");
		assert.deepEqual(store.occurrences("legacy", { platform:"feishu",chatId:"chat",userId:"user" }), []);
	} finally { store.close(); rmSync(root, { recursive:true,force:true }); }
});

test("successful one-shot reminders disappear from active schedules but retain their durable occurrence and run audit", () => withStore((store) => {
	const now = Date.parse("2026-01-01T00:00:00Z");
	const job = store.create({ platform:"feishu",chatId:"chat",userId:"user",name:"Tea",kind:"reminder",scheduleKind:"at",schedule:"10m",text:"Drink tea" }, now);
	assert.equal(job.nextRunAt, now + 600_000);
	assert.equal(store.claimDue(now + 599_999).length, 0);
	const claimed = store.claimDue(now + 600_000);
	assert.equal(claimed.length, 1);
	store.complete(claimed[0], { startedAt:now+600_000,finishedAt:now+600_100,status:"ok",output:"sent" }, now+600_100);
	assert.equal(store.get(job.id), undefined);
	assert.equal(store.runs(job.id, { platform:"feishu",chatId:"chat",userId:"user" }).length, 1);
	assert.deepEqual(store.occurrences(job.id, { platform:"feishu",chatId:"chat",userId:"user" }).map((occurrence) => ({
		status: occurrence.status,
		nominalDueAt: occurrence.nominalDueAt,
		output: occurrence.output,
	})), [{ status:"succeeded", nominalDueAt:now+600_000, output:"sent" }]);
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

test("one Schedule Occurrence retries with one identity and stops after its finite attempt budget", () => withStore((store) => {
	const now = Date.parse("2026-01-01T00:00:00Z");
	const owner = { platform:"feishu",chatId:"chat",userId:"user" };
	const job = store.create({ ...owner,name:"Digest",kind:"agent",scheduleKind:"every",schedule:"1h",text:"Summarize",maxAttempts:3 }, now);
	const first = store.claimDue(now + 3_600_000)[0];
	store.complete(first, { startedAt:now+3_600_000,finishedAt:now+3_600_010,status:"error",error:"provider" }, now+3_600_010);
	const second = store.claimDue(now + 3_630_010)[0];
	store.complete(second, { startedAt:now+3_630_010,finishedAt:now+3_630_020,status:"error",error:"provider" }, now+3_630_020);
	const third = store.claimDue(now + 3_690_020)[0];
	store.complete(third, { startedAt:now+3_690_020,finishedAt:now+3_690_030,status:"error",error:"provider" }, now+3_690_030);

	assert.equal(first.occurrenceId, second.occurrenceId);
	assert.equal(second.occurrenceId, third.occurrenceId);
	assert.equal(store.occurrences(job.id, owner)[0].status, "failed");
	assert.equal(store.occurrences(job.id, owner)[0].attempts, 3);
	assert.equal(store.runs(job.id, owner).length, 3);
	assert.equal(store.get(job.id).nextRunAt, now + 7_290_030);
}));

test("a Schedule with skip misfire policy records stale occurrences without executing them", () => withStore((store) => {
	const now = Date.parse("2026-01-01T00:00:00Z");
	const owner = { platform:"telegram",chatId:"chat",userId:"user" };
	const job = store.create({ ...owner,name:"Pulse",kind:"agent",scheduleKind:"every",schedule:"1h",text:"Inspect",misfirePolicy:"skip",misfireGraceMs:60_000 }, now);
	assert.deepEqual(store.claimDue(now + 3_900_000), []);
	assert.equal(store.occurrences(job.id, owner)[0].status, "skipped");
	assert.equal(store.occurrences(job.id, owner)[0].nominalDueAt, now + 3_600_000);
	assert.equal(store.get(job.id).nextRunAt, now + 7_500_000);
}));

test("verified Schedule execution is settled once while durable delivery retries independently", () => withStore((store) => {
	const now = Date.parse("2026-01-01T00:00:00Z");
	const owner = { platform:"telegram",chatId:"chat",userId:"user" };
	const job = store.create({ ...owner,name:"Digest",kind:"agent",scheduleKind:"at",schedule:"10m",text:"Summarize" }, now);
	const claim = store.claimDue(now + 600_000)[0];
	store.complete(claim, {
		startedAt:now+600_000,finishedAt:now+600_100,status:"ok",output:"Summary",
		objectiveId:"objective-1",taskRunId:"run-1",
		delivery:{ kind:"text",text:"🗓️ Digest\n\nSummary",idempotencyKey:`automation:${claim.occurrenceId}` },
	}, now+600_100);

	const firstDelivery = store.claimDeliveriesDue(now+600_100)[0];
	assert.equal(firstDelivery.text, "🗓️ Digest\n\nSummary");
	store.failDelivery(firstDelivery.id, firstDelivery.claimToken, "channel offline", now+600_101);
	assert.equal(store.occurrences(job.id, owner)[0].status, "succeeded");
	assert.equal(store.occurrences(job.id, owner)[0].objectiveId, "objective-1");
	assert.equal(store.occurrences(job.id, owner)[0].taskRunId, "run-1");
	assert.equal(store.runs(job.id, owner).length, 1);
	assert.equal(store.claimDue(now+700_000).length, 0);

	const retry = store.claimDeliveriesDue(now+630_101)[0];
	assert.equal(retry.id, firstDelivery.id);
	assert.equal(store.completeDelivery(retry.id, retry.claimToken, now+630_102), true);
	assert.equal(store.claimDeliveriesDue(now+700_000).length, 0);
}));

test("Schedule management can inspect, update, run now, and report scheduler health", () => withStore((store) => {
	const now = Date.parse("2026-01-01T00:00:00Z");
	const owner = { platform:"feishu",chatId:"chat",userId:"user" };
	const job = store.create({ ...owner,name:"Old",kind:"agent",scheduleKind:"every",schedule:"1h",text:"Old prompt" }, now);
	const updated = store.update(job.id, { name:"New",schedule:"2h",text:"New prompt",maxAttempts:5,misfirePolicy:"skip" }, owner, now+1_000);
	assert.equal(updated.name, "New");
	assert.equal(updated.nextRunAt, now+7_201_000);
	assert.equal(updated.maxAttempts, 5);
	assert.equal(updated.misfirePolicy, "skip");
	assert.equal(store.runNow(job.id, owner, now+2_000), true);
	assert.deepEqual(store.status(now+2_000), { enabled:1,due:1,claimed:0,retrying:0,deliveryQueued:0,deliveryAbandoned:0,occurrenceHistory:0,deliveryHistory:0,nextDueAt:now+2_000 });
}));

test("run now does not implicitly resume a paused Schedule", () => withStore((store) => {
	const now = Date.parse("2026-01-01T00:00:00Z");
	const owner = { platform:"feishu",chatId:"chat",userId:"user" };
	const job = store.create({ ...owner,name:"Paused",kind:"agent",scheduleKind:"every",schedule:"1h",text:"Inspect" }, now);
	assert.equal(store.setEnabled(job.id, false, owner, now+1), true);
	assert.equal(store.runNow(job.id, owner, now+2), false);
	assert.equal(store.get(job.id, owner).enabled, false);
}));

test("Schedule Occurrence history stays bounded during long-running recurring automation", () => withStore((store) => {
	let now = Date.parse("2026-01-01T00:00:00Z");
	const owner = { platform:"feishu",chatId:"chat",userId:"user" };
	store.create({ ...owner,name:"Pulse",kind:"agent",scheduleKind:"every",schedule:"1s",text:"Inspect" }, now);
	for (let index=0; index<105; index++) {
		now += 1_000;
		const claim = store.claimDue(now)[0];
		store.complete(claim, { startedAt:now,finishedAt:now,status:"ok",output:"ok",delivery:{kind:"text",text:"ok",idempotencyKey:`automation:${claim.occurrenceId}`} }, now);
		const delivery = store.claimDeliveriesDue(now)[0];
		store.completeDelivery(delivery.id, delivery.claimToken, now);
	}
	assert.equal(store.status(now).occurrenceHistory, 100);
	assert.equal(store.status(now).deliveryHistory, 100);
}));

test("AutomationDeliveryWorker retries channel failure without replaying the settled Schedule execution", () => withStore(async (store) => {
	const now = Date.parse("2026-01-01T00:00:00Z");
	const owner = { platform:"telegram",chatId:"chat",userId:"user" };
	const job = store.create({ ...owner,name:"Digest",kind:"agent",scheduleKind:"at",schedule:"10m",text:"Summarize" }, now);
	const claim = store.claimDue(now+600_000)[0];
	store.complete(claim, { startedAt:now+600_000,finishedAt:now+600_100,status:"ok",output:"done",delivery:{kind:"text",text:"done",idempotencyKey:`automation:${claim.occurrenceId}`} }, now+600_100);
	let attempts = 0;
	const worker = new AutomationDeliveryWorker(store, { sendText: async () => { attempts++; if (attempts === 1) throw new Error("offline"); }, sendMedia: async () => undefined });
	assert.deepEqual(await worker.runOnce(now+600_100), { claimed:1,delivered:0,failed:1 });
	assert.deepEqual(await worker.runOnce(now+630_100), { claimed:1,delivered:1,failed:0 });
	assert.equal(store.runs(job.id, owner).length, 1);
	assert.equal(attempts, 2);
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

test("an expired automation claim cannot commit before another worker takes ownership", () => withStore((store) => {
	const now = Date.parse("2026-01-01T00:00:00Z");
	const job = store.create({ platform:"feishu",chatId:"chat",name:"Digest",kind:"agent",scheduleKind:"every",schedule:"1h",text:"run" }, now);
	const claim = store.claimDue(now + 3_600_000, 1, 100)[0];
	assert.equal(store.complete(claim, { startedAt:now,finishedAt:now+1,status:"ok" }, now + 3_600_101), false);
	assert.equal(store.runs(job.id, { platform:"feishu",chatId:"chat" }).length, 0);
}));

test("renewing an automation claim extends both execution fencing records", () => withStore((store) => {
	const now = Date.parse("2026-01-01T00:00:00Z");
	store.create({ platform:"feishu",chatId:"chat",name:"Digest",kind:"agent",scheduleKind:"every",schedule:"1h",text:"run" }, now);
	const claim = store.claimDue(now + 3_600_000, 1, 100)[0];
	assert.equal(store.renewClaim(claim.id, claim.claimToken, now + 3_601_000), true);
	assert.deepEqual(store.claimDue(now + 3_600_101, 1, 100), []);
	assert.equal(store.complete(claim, { startedAt:now,finishedAt:now+1,status:"ok" }, now + 3_600_500), true);
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
