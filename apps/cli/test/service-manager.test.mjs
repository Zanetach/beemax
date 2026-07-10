import assert from "node:assert/strict";
import test from "node:test";
import { renderSystemdService, runServiceAction } from "../dist/service-manager.js";

test("systemd service binds the installed CLI, profile env, and safe runtime defaults", () => {
	const unit = renderSystemdService("/opt/beemax", "/usr/bin/node");
	assert.match(unit, /WorkingDirectory="\/opt\/beemax"/);
	assert.match(unit, /EnvironmentFile=-"\/opt\/beemax\/config\/profiles\/%i\.env"/);
	assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/opt\/beemax\/apps\/cli\/dist\/cli\.js" gateway --profile %i/);
	assert.match(unit, /NoNewPrivileges=true/);
	assert.match(unit, /UMask=0077/);
});

test("service actions map profiles to systemctl and journalctl units", () => {
	const calls = [];
	const runner = (command, args) => {
		calls.push([command, args]);
		return { status: 0 };
	};
	runServiceAction("start", "personal", runner, "linux");
	runServiceAction("logs", "personal", runner, "linux");
	assert.deepEqual(calls, [
		["systemctl", ["--user", "start", "beemax@personal.service"]],
		["journalctl", ["--user", "-u", "beemax@personal.service", "-f"]],
	]);
});

test("service actions explain the foreground fallback outside Linux", () => {
	assert.throws(() => runServiceAction("start", "personal", () => ({ status: 0 }), "darwin"), /gateway --profile personal/);
});
