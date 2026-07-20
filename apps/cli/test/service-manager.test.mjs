import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSystemdService, renderMacLaunchAgent, renderSystemdService, runServiceAction } from "../dist/service-manager.js";
import { resolveServiceLayout, serviceDisplayName } from "../dist/service-platform.js";

test("service layout hides platform paths and respects Linux XDG/config overrides", () => {
	const user = resolveServiceLayout({ platform: "linux", scope: "user", homeDir: "/home/ada", env: { XDG_CONFIG_HOME: "/srv/ada-config" } });
	assert.equal(user.unitDirectory, "/srv/ada-config/systemd/user");
	assert.equal(user.unitTemplatePath, "/srv/ada-config/systemd/user/beemax@.service");
	assert.equal(serviceDisplayName("research", "linux"), "beemax@research.service");

	const system = resolveServiceLayout({ platform: "linux", scope: "system", homeDir: "/root", env: { BEEMAX_SYSTEMD_SYSTEM_DIR: "/usr/local/lib/systemd/system", BEEMAX_SYSTEM_CONFIG_DIR: "/srv/beemax-config" } });
	assert.equal(system.unitDirectory, "/usr/local/lib/systemd/system");
	assert.equal(system.environmentDirectory, "/srv/beemax-config");
	assert.equal(serviceDisplayName("research", "darwin"), "com.beemax.agent.research");
});

test("systemd installation is testable through the service platform seam", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-systemd-"));
	const calls = [];
	try {
		await installSystemdService("/opt/beemax", "user", {
			platform: "linux",
			homeDir: "/home/ada",
			env: { XDG_CONFIG_HOME: root, BEEMAX_HOME: "/srv/ada-beemax" },
			nodePath: "/usr/bin/node",
			runner: (command, args) => { calls.push([command, args]); return { status: 0 }; },
		});
		const unit = await readFile(join(root, "systemd", "user", "beemax@.service"), "utf8");
		assert.match(unit, /ExecStart="\/usr\/bin\/node"/);
		assert.deepEqual(calls, [["systemctl", ["--user", "daemon-reload"]]]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("systemd service binds the installed CLI, profile env, and safe runtime defaults", () => {
	const unit = renderSystemdService("/opt/beemax", "/usr/bin/node", "user", undefined, "/home/beemax/.beemax");
	assert.match(unit, /WorkingDirectory="\/opt\/beemax"/);
	assert.match(unit, /EnvironmentFile=-"\/home\/beemax\/\.beemax\/profiles\/%i\/\.env"/);
	assert.match(unit, /EnvironmentFile=-"\/opt\/beemax\/config\/profiles\/%i\.env"/);
	assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/opt\/beemax\/apps\/cli\/dist\/cli\.js" gateway --profile %i --home "\/home\/beemax\/\.beemax" --root "\/opt\/beemax"/);
	assert.match(unit, /NoNewPrivileges=true/);
	assert.match(unit, /MemoryMax=2G/);
	assert.match(unit, /CPUQuota=200%/);
	assert.match(unit, /TasksMax=512/);
	assert.match(unit, /UMask=0077/);
	assert.match(unit, /WantedBy=default\.target/);
	assert.match(renderSystemdService("/opt/beemax", "/usr/bin/node", "system"), /WantedBy=multi-user\.target/);
	assert.match(renderSystemdService("/opt/beemax", "/usr/bin/node", "system", "beemax"), /User=beemax/);
});

test("systemd Profile resource limits are configurable without allowing directive injection", () => {
	const unit = renderSystemdService("/opt/beemax", "/usr/bin/node", "system", "beemax", "/srv/beemax", "/etc/beemax", {
		memoryMax: "4G", cpuQuota: "150%", tasksMax: 256,
	});
	assert.match(unit, /MemoryMax=4G/);
	assert.match(unit, /CPUQuota=150%/);
	assert.match(unit, /TasksMax=256/);
	assert.throws(() => renderSystemdService("/opt/beemax", "/usr/bin/node", "user", undefined, "/srv/beemax", "/etc/beemax", {
		memoryMax: "2G\nEnvironment=ATTACK=1",
	}), /memory limit/i);
});

test("service actions map profiles to systemctl and journalctl units", async () => {
	const calls = [];
	const runner = (command, args) => {
		calls.push([command, args]);
		return { status: 0 };
	};
	await runServiceAction("start", "personal", runner, "linux");
	await runServiceAction("stop", "personal", runner, "linux");
	await runServiceAction("restart", "personal", runner, "linux");
	await runServiceAction("status", "personal", runner, "linux");
	await runServiceAction("logs", "personal", runner, "linux");
	assert.deepEqual(calls, [
		["systemctl", ["--user", "enable", "--now", "beemax@personal.service"]],
		["systemctl", ["--user", "disable", "--now", "beemax@personal.service"]],
		["systemctl", ["--user", "restart", "beemax@personal.service"]],
		["systemctl", ["--user", "status", "beemax@personal.service"]],
		["journalctl", ["--user", "-u", "beemax@personal.service", "-f"]],
	]);
});

test("macOS LaunchAgent runs one isolated Gateway per Profile", async () => {
	const plist = renderMacLaunchAgent("personal", "/opt/beemax", "/Users/zane/.beemax", "/usr/local/bin/node");
	assert.match(plist, /com\.beemax\.agent\.personal/);
	assert.match(plist, /\/Users\/zane\/\.beemax\/profiles\/personal\/logs\/gateway\.log/);
	const calls = [];
	await runServiceAction("start", "personal", (command, args) => { calls.push([command, args]); return { status: 0 }; }, "darwin");
	assert.equal(calls[0][0], "launchctl");
	assert.equal(calls[0][1][0], "bootstrap");
});

test("macOS LaunchAgent restart retries bootstrap while launchd releases the previous job", async () => {
	const calls = [];
	const delays = [];
	let bootstrapAttempts = 0;
	await runServiceAction("restart", "personal", (command, args) => {
		calls.push([command, args]);
		if (args[0] === "bootstrap") {
			bootstrapAttempts += 1;
			return { status: bootstrapAttempts === 1 ? 5 : 0 };
		}
		return { status: 0 };
	}, "darwin", "user", async (milliseconds) => { delays.push(milliseconds); });

	assert.deepEqual(calls.map(([, args]) => args[0]), ["bootout", "bootstrap", "bootstrap"]);
	assert.deepEqual(delays, [100]);
});
