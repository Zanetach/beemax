import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	AutomationScheduler,
	AutomationStore,
	HeartbeatRunner,
	computeNextRun,
	filterHeartbeatAnswer,
	isWithinActiveHours,
	parseDuration,
} from "../dist/index.js";

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

test("scheduler claims due work, records completion, and stops cleanly", async () => {
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
	const scheduler = new AutomationScheduler(store, async () => ({ output:"sent" }), 1);
	scheduler.start();
	await completion;
	await scheduler.stop();
	assert.equal(completed.status, "ok");
	assert.equal(completed.output, "sent");
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
	}, async () => answer, async (_route,text) => { deliveries.push(text); }, () => false);
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
