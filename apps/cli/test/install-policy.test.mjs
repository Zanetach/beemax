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

test("bootstrap installer downloads a verified single release archive and preserves Profile data on uninstall", async () => {
	const installer = await readFile("scripts/bootstrap-install.sh", "utf8");
	assert.match(installer, /BEEMAX_VERSION:-v0\.1\.0-preview\.8/);
	assert.match(installer, /releases\/download/);
	assert.match(installer, /checksum verification failed/);
	assert.doesNotMatch(installer, /git clone/);
	assert.match(installer, /Node\.js 22\.19\+/);
	assert.match(installer, /command -v shasum[\s\S]*command -v sha256sum/);
	assert.match(installer, /Profiles and data under/);
	assert.match(installer, /BEEMAX_BIN_DIR/);
});

test("source installer declares Git only when it must initialize the bundled Pi source", async () => {
	const installer = await readFile("scripts/install.sh", "utf8");
	assert.match(installer, /Pi source is missing and git is required/);
	assert.match(installer, /command -v git/);
});

test("release archive includes Pi and excludes git metadata and dependencies", async () => {
	const packager = await readFile("scripts/create-release-archive.sh", "utf8");
	assert.match(packager, /Pi submodule is missing/);
	assert.match(packager, /--exclude='\.\/pi\/.git'/);
	assert.match(packager, /--exclude='\.\/node_modules'/);
	assert.match(packager, /--exclude='\.\/\*\*\/\*\.tsbuildinfo'/);
	assert.match(packager, /--exclude='\.\/docs'/);
	assert.match(packager, /--exclude='\.\/data'/);
	assert.match(packager, /shasum -a 256/);
});
