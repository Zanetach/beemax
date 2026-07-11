import assert from "node:assert/strict";
import test from "node:test";
import { renderMacLaunchAgent, renderSystemdService, runServiceAction } from "../dist/service-manager.js";

test("systemd service binds the installed CLI, profile env, and safe runtime defaults", () => {
	const unit = renderSystemdService("/opt/beemax", "/usr/bin/node", "user", undefined, "/home/beemax/.beemax");
	assert.match(unit, /WorkingDirectory="\/opt\/beemax"/);
	assert.match(unit, /EnvironmentFile=-"\/home\/beemax\/\.beemax\/profiles\/%i\/\.env"/);
	assert.match(unit, /EnvironmentFile=-"\/opt\/beemax\/config\/profiles\/%i\.env"/);
	assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/opt\/beemax\/apps\/cli\/dist\/cli\.js" gateway --profile %i --home "\/home\/beemax\/\.beemax" --root "\/opt\/beemax"/);
	assert.match(unit, /NoNewPrivileges=true/);
	assert.match(unit, /UMask=0077/);
	assert.match(unit, /WantedBy=default\.target/);
	assert.match(renderSystemdService("/opt/beemax", "/usr/bin/node", "system"), /WantedBy=multi-user\.target/);
	assert.match(renderSystemdService("/opt/beemax", "/usr/bin/node", "system", "beemax"), /User=beemax/);
});

test("service actions map profiles to systemctl and journalctl units", () => {
	const calls = [];
	const runner = (command, args) => {
		calls.push([command, args]);
		return { status: 0 };
	};
	runServiceAction("start", "personal", runner, "linux");
	runServiceAction("stop", "personal", runner, "linux");
	runServiceAction("restart", "personal", runner, "linux");
	runServiceAction("status", "personal", runner, "linux");
	runServiceAction("logs", "personal", runner, "linux");
	assert.deepEqual(calls, [
		["systemctl", ["--user", "enable", "--now", "beemax@personal.service"]],
		["systemctl", ["--user", "disable", "--now", "beemax@personal.service"]],
		["systemctl", ["--user", "restart", "beemax@personal.service"]],
		["systemctl", ["--user", "status", "beemax@personal.service"]],
		["journalctl", ["--user", "-u", "beemax@personal.service", "-f"]],
	]);
});

test("macOS LaunchAgent runs one isolated Gateway per Profile", () => {
	const plist = renderMacLaunchAgent("personal", "/opt/beemax", "/Users/zane/.beemax", "/usr/local/bin/node");
	assert.match(plist, /com\.beemax\.agent\.personal/);
	assert.match(plist, /\/Users\/zane\/\.beemax\/profiles\/personal\/logs\/gateway\.log/);
	const calls = [];
	runServiceAction("start", "personal", (command, args) => { calls.push([command, args]); return { status: 0 }; }, "darwin");
	assert.equal(calls[0][0], "launchctl");
	assert.equal(calls[0][1][0], "bootstrap");
});
