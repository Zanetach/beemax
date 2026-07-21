import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareArtifactSnapshotRoot } from "../dist/index.js";

test("prepareArtifactSnapshotRoot creates a private Profile-owned root outside the workspace", async () => {
	const profile = await mkdtemp(join(tmpdir(), "beemax-artifact-snapshot-root-"));
	const workspace = join(profile, "workspace");
	const snapshotRoot = join(profile, "state", "artifact-delivery");
	try {
		await mkdir(workspace, { mode: 0o700 });
		const prepared = await prepareArtifactSnapshotRoot({ agentDir: profile, workspace, snapshotRoot });
		assert.equal(prepared, await realpath(snapshotRoot));
		assert.equal((await lstat(snapshotRoot)).mode & 0o777, 0o700);
		assert.equal((await lstat(join(profile, "state"))).mode & 0o777, 0o700);
	} finally {
		await rm(profile, { recursive: true, force: true });
	}
});

test("prepareArtifactSnapshotRoot rejects a root inside the Agent workspace", async () => {
	const profile = await mkdtemp(join(tmpdir(), "beemax-artifact-snapshot-overlap-"));
	const workspace = join(profile, "workspace");
	try {
		await mkdir(workspace, { mode: 0o700 });
		await assert.rejects(prepareArtifactSnapshotRoot({
			agentDir: profile,
			workspace,
			snapshotRoot: join(workspace, "artifact-delivery"),
		}), /must not overlap the Agent workspace/i);
	} finally {
		await rm(profile, { recursive: true, force: true });
	}
});

test("prepareArtifactSnapshotRoot rejects a symlinked parent segment", async () => {
	const profile = await mkdtemp(join(tmpdir(), "beemax-artifact-snapshot-symlink-"));
	const outside = await mkdtemp(join(tmpdir(), "beemax-artifact-snapshot-outside-"));
	const workspace = join(profile, "workspace");
	try {
		await mkdir(workspace, { mode: 0o700 });
		await symlink(outside, join(profile, "state"));
		await assert.rejects(prepareArtifactSnapshotRoot({
			agentDir: profile,
			workspace,
			snapshotRoot: join(profile, "state", "artifact-delivery"),
		}), /real directory|symbolic link/i);
	} finally {
		await rm(profile, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});
