import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const cli = resolve("apps/cli/dist/cli.js");

test("CLI validates and explains deterministic Profile Binding routes", () => {
	const home = mkdtempSync(join(tmpdir(), "beemax-binding-cli-"));
	const profileDir = join(home, "profiles", "operations");
	const run = (...args) => execFileSync(process.execPath, [cli, ...args, "--profile", "operations"], {
		encoding: "utf8", env: { ...process.env, THRUVERA_HOME: home },
	});
	try {
		run("init");
		writeFileSync(join(profileDir, "config.yaml"), `gateway:
  channels:
    - id: feishu-company
      adapter: custom
      enabled: true
      settings: {}
  bindings:
    - id: company-default
      profileId: operations
      channelInstanceId: feishu-company
    - id: incident-room
      profileId: operations
      channelInstanceId: feishu-company
      conversationId: group-incident
`);
		assert.match(run("binding", "validate"), /Profile Binding valid.*2 enabled bindings.*operations/i);
		assert.match(run("binding", "explain", "--channel-instance", "feishu-company", "--conversation", "group-incident"), /matched.*profile=operations.*binding=incident-room.*precedence=conversation/i);
		writeFileSync(join(profileDir, "config.yaml"), `gateway:
  channels:
    - id: feishu-company
      adapter: custom
      enabled: true
      settings: {}
  bindings:
    - id: first
      profileId: operations
      channelInstanceId: feishu-company
      conversationId: group-incident
    - id: second
      profileId: operations
      channelInstanceId: feishu-company
      conversationId: group-incident
`);
		assert.throws(() => run("binding", "validate"), /Profile Binding configuration has conflicts.*first.*second/i);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("CLI atomically activates and disables an existing Profile Binding", () => {
	const home = mkdtempSync(join(tmpdir(), "beemax-binding-cli-write-"));
	const profileDir = join(home, "profiles", "operations");
	const configPath = join(profileDir, "config.yaml");
	const run = (...args) => execFileSync(process.execPath, [cli, ...args, "--profile", "operations"], {
		encoding: "utf8", env: { ...process.env, THRUVERA_HOME: home },
	});
	try {
		run("init");
		writeFileSync(configPath, `identity: Operations Agent
gateway:
  channels:
    - id: feishu-company
      adapter: custom
      enabled: true
      settings: {}
  bindings:
    - id: company-default
      profileId: operations
      channelInstanceId: feishu-company
    - id: incident-room
      profileId: operations
      channelInstanceId: feishu-company
      conversationId: group-incident
      enabled: false
      futureSelector: keep-me
`);
		assert.match(run("binding", "activate", "incident-room"), /activated.*incident-room.*operations/i);
		assert.match(run("binding", "explain", "--channel-instance", "feishu-company", "--conversation", "group-incident"), /binding=incident-room.*precedence=conversation/i);
		assert.match(readFileSync(configPath, "utf8"), /identity: Operations Agent/);
		assert.match(readFileSync(configPath, "utf8"), /futureSelector: keep-me/);

		assert.match(run("binding", "disable", "incident-room"), /disabled.*incident-room.*operations/i);
		assert.match(
			run("binding", "explain", "--channel-instance", "feishu-company", "--conversation", "group-incident"),
			/binding=company-default.*precedence=instance/i,
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("CLI leaves Profile configuration unchanged when Binding activation conflicts", () => {
	const home = mkdtempSync(join(tmpdir(), "beemax-binding-cli-conflict-"));
	const profileDir = join(home, "profiles", "operations");
	const configPath = join(profileDir, "config.yaml");
	const run = (...args) => execFileSync(process.execPath, [cli, ...args, "--profile", "operations"], {
		encoding: "utf8", env: { ...process.env, THRUVERA_HOME: home },
	});
	try {
		run("init");
		writeFileSync(configPath, `gateway:
  channels:
    - id: feishu-company
      adapter: custom
      enabled: true
      settings: {}
  bindings:
    - id: first
      profileId: operations
      channelInstanceId: feishu-company
      conversationId: group-incident
    - id: second
      profileId: operations
      channelInstanceId: feishu-company
      conversationId: group-incident
      enabled: false
`);
		const before = readFileSync(configPath, "utf8");
		assert.throws(() => run("binding", "activate", "second"), /Profile Binding configuration has conflicts.*first.*second/i);
		assert.equal(readFileSync(configPath, "utf8"), before);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("CLI refuses to republish duplicate disabled Profile Binding identities", () => {
	const home = mkdtempSync(join(tmpdir(), "beemax-binding-cli-duplicate-"));
	const profileDir = join(home, "profiles", "operations");
	const configPath = join(profileDir, "config.yaml");
	const run = (...args) => execFileSync(process.execPath, [cli, ...args, "--profile", "operations"], {
		encoding: "utf8", env: { ...process.env, THRUVERA_HOME: home },
	});
	try {
		run("init");
		writeFileSync(configPath, `gateway:
  channels:
    - id: feishu-company
      adapter: custom
      enabled: true
      settings: {}
  bindings:
    - id: company-default
      profileId: operations
      channelInstanceId: feishu-company
    - id: duplicate
      profileId: operations
      channelInstanceId: feishu-company
      conversationId: group-incident
      enabled: false
    - id: duplicate
      profileId: operations
      channelInstanceId: feishu-company
      conversationId: group-secondary
      enabled: false
`);
		const before = readFileSync(configPath, "utf8");
		assert.throws(() => run("binding", "disable", "company-default"), /Duplicate Profile Binding id/i);
		assert.equal(readFileSync(configPath, "utf8"), before);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
