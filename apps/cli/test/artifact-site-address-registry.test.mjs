import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reserveProfileArtifactSiteListen } from "../dist/artifact-site-address-registry.js";

test("Profile Artifact Site address registry resolves deterministic port collisions and remains stable", async () => {
	const home = await mkdtemp(join(tmpdir(), "beemax-artifact-site-addresses-"));
	try {
		const first = await reserveProfileArtifactSiteListen({ home, profile: "p59", preferredListen: "127.0.0.1:21512", automatic: true });
		const second = await reserveProfileArtifactSiteListen({ home, profile: "p60", preferredListen: "127.0.0.1:21512", automatic: true });
		assert.equal(first, "127.0.0.1:21512");
		assert.notEqual(second, first);
		assert.equal(await reserveProfileArtifactSiteListen({ home, profile: "p59", preferredListen: "127.0.0.1:9999", automatic: true }), first);
		assert.equal(await reserveProfileArtifactSiteListen({ home, profile: "p60", preferredListen: "127.0.0.1:9999", automatic: true }), second);
		const registry = JSON.parse(await readFile(join(home, "state", "artifact-site-addresses.json"), "utf8"));
		assert.deepEqual(Object.keys(registry.profiles).sort(), ["p59", "p60"]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Profile Artifact Site address registry rejects an explicit port owned by another Profile", async () => {
	const home = await mkdtemp(join(tmpdir(), "beemax-artifact-site-address-conflict-"));
	try {
		await reserveProfileArtifactSiteListen({ home, profile: "one", preferredListen: "127.0.0.1:18788", automatic: false });
		await assert.rejects(
			reserveProfileArtifactSiteListen({ home, profile: "two", preferredListen: "0.0.0.0:18788", automatic: false }),
			/already reserved.*one/i,
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Profile Artifact Site address registry serializes simultaneous Profile startup", async () => {
	const home = await mkdtemp(join(tmpdir(), "beemax-artifact-site-address-concurrent-"));
	try {
		const [first, second] = await Promise.all([
			reserveProfileArtifactSiteListen({ home, profile: "concurrent-one", preferredListen: "127.0.0.1:22000", automatic: true }),
			reserveProfileArtifactSiteListen({ home, profile: "concurrent-two", preferredListen: "127.0.0.1:22000", automatic: true }),
		]);
		assert.notEqual(first, second);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
