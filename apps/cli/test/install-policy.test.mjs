import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("default build is offline-stable and model catalog refresh is explicit", async () => {
	const pkg = JSON.parse(await readFile("package.json", "utf8"));
	assert.doesNotMatch(pkg.scripts.build, /generate-models|generate-image-models/);
	assert.match(pkg.scripts["models:update"], /generate-models/);
	assert.match(pkg.scripts["models:update"], /generate-image-models/);
});

test("source installer keeps native dependency scripts and pins CLI commands to the install root", async () => {
	const installer = await readFile("scripts/install.sh", "utf8");
	assert.match(installer, /npm ci\n/);
	assert.doesNotMatch(installer, /npm ci --ignore-scripts/);
	assert.match(installer, /export BEEMAX_ROOT/);
	assert.match(installer, /apps\/cli\/dist\/cli\.js/);
});
