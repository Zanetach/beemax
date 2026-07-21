import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readEnvFile, readEnvFileSync, writeEnvFile } from "../dist/env-file.js";

const MAX_ENV_FILE_BYTES = 256 * 1024;

test("Profile environment reads reject a file that grows after its descriptor is opened", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-env-bounded-read-"));
	const path = join(root, ".env");
	await writeFile(path, "SAFE=value\n", { mode: 0o600 });
	const originalReadSync = fs.readSync;
	let injected = false;
	try {
		fs.readSync = function patchedReadSync(...args) {
			if (!injected) {
				injected = true;
				fs.appendFileSync(path, Buffer.alloc(MAX_ENV_FILE_BYTES + 1, 0x41));
			}
			return originalReadSync.apply(this, args);
		};
		syncBuiltinESMExports();
		assert.throws(() => readEnvFileSync(path), /changed|exceeds|invalid/u);
		assert.equal(injected, true, "the test must mutate the file after the bounded descriptor read starts");
	} finally {
		fs.readSync = originalReadSync;
		syncBuiltinESMExports();
		await rm(root, { recursive: true, force: true });
	}
});

test("Profile environment writes and async reads enforce the 256 KiB boundary", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-env-bounded-write-"));
	const path = join(root, ".env");
	try {
		await assert.rejects(
			writeEnvFile(path, { TOO_LARGE: "x".repeat(MAX_ENV_FILE_BYTES) }),
			/exceeds|256|262144/u,
		);
		await writeEnvFile(path, { SAFE: "value" });
		assert.deepEqual(await readEnvFile(path), { SAFE: "value" });
		assert.equal((await readFile(path, "utf8")).trim(), 'SAFE="value"');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
