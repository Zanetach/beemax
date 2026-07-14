import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { GatewayIngressController, ProfileHost } from "@beemax/gateway";
import { renderSystemdService } from "../dist/service-manager.js";

test("Profile failure and capacity remain isolated behind independent production units", async () => {
	const unit = renderSystemdService("/opt/beemax", "/usr/bin/node", "system", "beemax", "/srv/beemax");
	assert.match(unit, /Description=BeeMax Agent profile %i/);
	assert.match(unit, /Environment=BEEMAX_PROFILE=%i/);
	assert.match(unit, /profiles\/%i\/\.env/);
	assert.match(unit, /gateway --profile %i/);
	assert.match(unit, /Restart=on-failure/);
	assert.match(unit, /MemoryMax=2G/);
	assert.match(unit, /CPUQuota=200%/);
	assert.match(unit, /TasksMax=512/);

	const failed = new ProfileHost(new GatewayIngressController({ maxActive: 1, maxActivePerConversation: 1 }));
	const survivor = new ProfileHost(new GatewayIngressController({ maxActive: 1, maxActivePerConversation: 1 }));
	failed.start({ status: "ready" });
	survivor.start({ status: "ready" });
	const saturated = failed.tryAcquire("feishu:incident");
	assert.equal(typeof saturated, "function");
	assert.equal(failed.tryAcquire("feishu:overflow"), undefined);
	failed.fail(new Error("simulated Profile authority failure"));
	assert.equal(failed.tryAcquire("feishu:new"), undefined);

	const releaseSurvivor = survivor.tryAcquire("telegram:operations");
	assert.equal(typeof releaseSurvivor, "function");
	assert.equal(survivor.snapshot().state, "healthy");
	assert.equal(survivor.snapshot().ingress.active, 1);
	releaseSurvivor();
	saturated();

	const moduleUrl = new URL("../../../packages/gateway/dist/index.js", import.meta.url).href;
	const program = `
		import { GatewayIngressController, ProfileHost } from ${JSON.stringify(moduleUrl)};
		const host = new ProfileHost(new GatewayIngressController({ maxActive: 1, maxActivePerConversation: 1 }));
		host.start({ status: "ready" });
		process.stdout.write("READY\\n");
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (command) => {
			if (!command.includes("admit")) return;
			const release = host.tryAcquire("telegram:operations");
			process.stdout.write(release ? "ADMITTED\\n" : "REJECTED\\n");
			release?.();
		});
	`;
	const victim = spawn(process.execPath, ["--input-type=module", "--eval", program], { stdio: ["pipe", "pipe", "pipe"] });
	const live = spawn(process.execPath, ["--input-type=module", "--eval", program], { stdio: ["pipe", "pipe", "pipe"] });
	try {
		await Promise.all([waitForLine(victim, "READY"), waitForLine(live, "READY")]);
		victim.kill("SIGKILL");
		const [code, signal] = await new Promise((resolve) => victim.once("exit", (...args) => resolve(args)));
		assert.equal(code, null);
		assert.equal(signal, "SIGKILL");
		live.stdin.write("admit\n");
		assert.equal(await waitForLine(live, "ADMITTED"), "ADMITTED");
	} finally {
		if (!victim.killed) victim.kill("SIGKILL");
		live.kill("SIGKILL");
	}
});

function waitForLine(child, expected) {
	return new Promise((resolve, reject) => {
		let buffer = "";
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}; stderr=${buffer}`)), 5_000);
		const onData = (chunk) => {
			buffer += chunk;
			const line = buffer.split(/\r?\n/).find((entry) => entry === expected);
			if (!line) return;
			clearTimeout(timer);
			child.stdout.off("data", onData);
			resolve(line);
		};
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", onData);
		child.once("error", reject);
	});
}
