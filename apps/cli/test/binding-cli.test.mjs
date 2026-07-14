import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const cli = resolve("apps/cli/dist/cli.js");

test("CLI validates and explains deterministic Profile Binding routes", () => {
	const home = mkdtempSync(join(tmpdir(), "beemax-binding-cli-"));
	const profileDir = join(home, "profiles", "operations");
	const run = (...args) => execFileSync(process.execPath, [cli, ...args, "--profile", "operations"], {
		encoding: "utf8", env: { ...process.env, BEEMAX_HOME: home },
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
