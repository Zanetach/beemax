import assert from "node:assert/strict";
import test from "node:test";
import { prepareQuickstart } from "../dist/quickstart.js";

test("quickstart configures a new Profile and returns a ready local chat launch", async () => {
	const calls = [];
	const result = await prepareQuickstart({
		profile: "personal",
		setup: { profile: "personal", provider: "openrouter", model: "openai/gpt-5.2" },
	}, {
		listProfiles: async () => [],
		setup: async (options) => { calls.push(["setup", options.profile]); return true; },
		doctor: async () => { calls.push(["doctor"]); return true; },
		loadConfig: () => assert.fail("a missing Profile must be configured before loading"),
		syncSkills: async () => { calls.push(["sync"]); },
	});

	assert.deepEqual(result, { profile: "personal", ready: true, setupPerformed: true });
	assert.deepEqual(calls, [["setup", "personal"]]);
});

test("quickstart reuses an existing healthy Profile without repeating setup", async () => {
	const calls = [];
	const config = { profile: "personal", model: { apiKey: "configured" } };
	const result = await prepareQuickstart({ profile: "personal", setup: { profile: "personal" } }, {
		listProfiles: async () => ["personal"],
		setup: async () => { calls.push(["setup"]); return true; },
		doctor: async (candidate, options) => { calls.push(["doctor", candidate.profile, options.requireGateway]); return true; },
		loadConfig: (_path, profile) => { calls.push(["load", profile]); return config; },
		syncSkills: async (profile) => { calls.push(["sync", profile]); },
	});

	assert.deepEqual(result, { profile: "personal", ready: true, setupPerformed: false });
	assert.deepEqual(calls, [["sync", "personal"], ["load", "personal"], ["doctor", "personal", false]]);
});

test("quickstart repairs an incomplete existing Profile through setup", async () => {
	const calls = [];
	const result = await prepareQuickstart({
		profile: "personal",
		setup: { profile: "personal", nonInteractive: false },
	}, {
		listProfiles: async () => ["personal"],
		setup: async () => { calls.push(["setup"]); return true; },
		doctor: async () => assert.fail("an unconfigured model must enter setup before doctor"),
		loadConfig: () => ({ profile: "personal", model: { apiKey: "" } }),
		syncSkills: async () => undefined,
	});

	assert.deepEqual(result, { profile: "personal", ready: true, setupPerformed: true });
	assert.deepEqual(calls, [["setup"]]);
});

test("quickstart does not launch when setup or readiness fails", async () => {
	const result = await prepareQuickstart({ profile: "personal", setup: { profile: "personal" } }, {
		listProfiles: async () => [],
		setup: async () => false,
		doctor: async () => true,
		loadConfig: () => assert.fail("failed setup must not load a Profile"),
		syncSkills: async () => undefined,
	});
	assert.deepEqual(result, { profile: "personal", ready: false, setupPerformed: true });
});
