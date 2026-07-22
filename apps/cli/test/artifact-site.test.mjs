import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createArtifactManifest } from "@thruvera/core";
import { CaddyArtifactSite } from "../dist/artifact-site.js";

function fileArtifact(name, mediaType, bytes) {
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const manifest = createArtifactManifest({
		locator: { kind: "workspace", uri: `workspace:${name}` },
		mediaType,
		byteLength: bytes.byteLength,
		sha256,
		producer: { providerId: "beemax.write", providerVersion: "1", operation: "write" },
		sourceRefs: ["source-receipt:test"],
		createdAt: 1_721_000_000_000,
	});
	return { artifact: { type: "file", uri: manifest.locator.uri, label: name, manifest }, manifest };
}

async function createDeliverySnapshot(root, id = "test") {
	const snapshotRoot = join(root, "state", "artifact-delivery");
	const deliveryDirectory = join(snapshotRoot, `delivery-${id}`);
	await mkdir(deliveryDirectory, { recursive: true, mode: 0o700 });
	return { snapshotRoot, deliveryDirectory };
}

test("Caddy Artifact Site publishes immutable integrity-checked HTML, PDF, and Word outputs", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-artifact-site-"));
	const workspace = join(root, "workspace");
	const storageRoot = join(root, "public");
	await mkdir(workspace, { recursive: true });
	const { snapshotRoot, deliveryDirectory } = await createDeliverySnapshot(root, "document-types");
	try {
		const site = new CaddyArtifactSite({
			agentDir: root,
			workspace,
			snapshotRoot,
			storageRoot,
			runtimeRoot: join(root, "runtime"),
			publicBaseUrl: "http://127.0.0.1:8788/artifacts",
			command: "/opt/homebrew/bin/caddy",
			listen: "127.0.0.1:8788",
			hostEnvironment: {},
		});
		const cases = [
			["报告.html", "text/html", Buffer.from("<h1>真实报告</h1>"), "inline"],
			["report.pdf", "application/pdf", Buffer.from("%PDF-test"), "inline"],
			["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.from("PK-test-docx"), "attachment"],
		];
		for (const [name, mediaType, bytes, disposition] of cases) {
			const source = join(deliveryDirectory, name);
			await writeFile(source, bytes, { mode: 0o400 });
			await chmod(source, 0o400);
			const { artifact, manifest } = fileArtifact(name, mediaType, bytes);
			const published = await site.publish(artifact, { path: source, mimeType: mediaType, name });
			assert.deepEqual(published, {
				url: `http://127.0.0.1:8788/artifacts/${manifest.sha256}/${encodeURIComponent(name)}`,
				name,
				mediaType,
				disposition,
			});
			assert.deepEqual(await readFile(join(storageRoot, manifest.sha256, name)), bytes);
		}

		const html = cases[0];
		await chmod(join(deliveryDirectory, html[0]), 0o600);
		await writeFile(join(deliveryDirectory, html[0]), "changed after publication");
		const originalDigest = createHash("sha256").update(html[2]).digest("hex");
		assert.deepEqual(await readFile(join(storageRoot, originalDigest, html[0])), html[2]);
		} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Caddy Artifact Site publishes only from the configured Profile-private delivery snapshot root", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-artifact-site-snapshot-root-"));
	const workspace = join(root, "workspace");
	const snapshotRoot = join(root, "state", "artifact-delivery");
	const deliveryDirectory = join(snapshotRoot, "delivery-integration");
	const storageRoot = join(root, "public");
	await mkdir(workspace, { recursive: true, mode: 0o700 });
	await mkdir(deliveryDirectory, { recursive: true, mode: 0o700 });
	try {
		const site = new CaddyArtifactSite({
			agentDir: root,
			workspace,
			snapshotRoot,
			storageRoot,
			runtimeRoot: join(root, "runtime"),
			publicBaseUrl: "http://127.0.0.1:8788/artifacts",
			command: "/opt/homebrew/bin/caddy",
			listen: "127.0.0.1:8788",
			hostEnvironment: {},
		});
		const cases = [
			["报告.html", "text/html", Buffer.from("<h1>可信快照</h1>")],
			["report.pdf", "application/pdf", Buffer.from("%PDF-trusted-snapshot")],
			["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.from("PK-trusted-docx")],
		];
		for (const [name, mediaType, bytes] of cases) {
			const source = join(deliveryDirectory, name);
			await writeFile(source, bytes, { mode: 0o400 });
			await chmod(source, 0o400);
			const { artifact, manifest } = fileArtifact(name, mediaType, bytes);
			const published = await site.publish(artifact, { path: source, mimeType: mediaType, name });
			assert.equal(published.url, `http://127.0.0.1:8788/artifacts/${manifest.sha256}/${encodeURIComponent(name)}`);
			assert.deepEqual(await readFile(join(storageRoot, manifest.sha256, name)), bytes);
		}

		const directBytes = Buffer.from("%PDF-workspace-direct");
		const directPath = join(workspace, "direct.pdf");
		await writeFile(directPath, directBytes, { mode: 0o400 });
		await chmod(directPath, 0o400);
		const direct = fileArtifact("direct.pdf", "application/pdf", directBytes).artifact;
		await assert.rejects(
			site.publish(direct, { path: directPath, mimeType: "application/pdf", name: "direct.pdf" }),
			/trusted Profile artifact snapshot root/i,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Caddy Artifact Site rejects unsupported or manifest-mismatched files", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-artifact-site-reject-"));
	const workspace = join(root, "workspace");
	await mkdir(workspace, { recursive: true });
	const { snapshotRoot, deliveryDirectory } = await createDeliverySnapshot(root, "reject");
	try {
		const site = new CaddyArtifactSite({
			agentDir: root,
			workspace,
			snapshotRoot,
			storageRoot: join(root, "public"),
			runtimeRoot: join(root, "runtime"),
			publicBaseUrl: "http://127.0.0.1:8788/artifacts",
			command: "caddy",
			listen: "127.0.0.1:8788",
			hostEnvironment: {},
		});
		const secret = Buffer.from("SECRET=value");
		await writeFile(join(deliveryDirectory, ".env"), secret, { mode: 0o400 });
		const unsupported = fileArtifact(".env", "text/plain", secret).artifact;
		await assert.rejects(site.publish(unsupported, { path: join(deliveryDirectory, ".env"), mimeType: "text/plain", name: ".env" }), /unsupported document type/i);

		const expected = Buffer.from("expected");
		await writeFile(join(deliveryDirectory, "report.pdf"), "tampered", { mode: 0o400 });
		const mismatchedFixture = fileArtifact("report.pdf", "application/pdf", expected);
		const mismatched = mismatchedFixture.artifact;
		await assert.rejects(site.publish(mismatched, { path: join(deliveryDirectory, "report.pdf"), mimeType: "application/pdf", name: "report.pdf" }), /integrity/i);
		const failedDirectory = join(root, "public", mismatchedFixture.manifest.sha256);
		assert.deepEqual((await readdir(failedDirectory)).filter((name) => name.startsWith(".publish-") || name.endsWith(".tmp")), []);

		await writeFile(join(deliveryDirectory, "named.pdf"), expected, { mode: 0o400 });
		const renamed = fileArtifact("named.pdf", "application/pdf", expected).artifact;
		await assert.rejects(site.publish(renamed, { path: join(deliveryDirectory, "named.pdf"), mimeType: "application/pdf", name: "other.pdf" }), /name/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Caddy Artifact Site owns a Profile-scoped Caddy lifecycle and probes readiness", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-artifact-site-lifecycle-"));
	const child = new FakeChildProcess();
	const spawns = [];
	const probes = [];
	const hostEnvironment = Object.freeze({
		PATH: "/trusted/host/bin",
		PATHEXT: ".EXE;.CMD",
		SystemRoot: "C:\\Windows",
		WINDIR: "C:\\Windows",
		COMSPEC: "C:\\Windows\\System32\\cmd.exe",
		TMP: "/host/tmp-must-be-replaced",
		DISPLAY: ":99",
		LANG: "zh_CN.UTF-8",
		LC_CTYPE: "zh_CN.UTF-8",
		TZ: "Asia/Shanghai",
		THRUVERA_API_KEY: "must-not-reach-caddy",
		FEISHU_APP_SECRET: "must-not-reach-caddy",
	});
	try {
		const site = new CaddyArtifactSite({
			agentDir: root,
			workspace: join(root, "workspace"),
			storageRoot: join(root, "published files"),
			runtimeRoot: join(root, "runtime"),
			publicBaseUrl: "https://reports.example.test/artifacts",
			command: "/opt/homebrew/bin/caddy",
			listen: "127.0.0.1:8788",
			hostEnvironment,
		}, {
			spawn: (command, args, options) => {
				spawns.push({ command, args, options });
				return child;
			},
			fetch: async (url) => {
				probes.push(url);
				return { ok: true, status: 200 };
			},
			delay: async () => {},
		});

		assert.doesNotMatch(JSON.stringify(site.options), /must-not-reach-caddy/u);
		await site.start();
		assert.equal(site.isRunning, true);
		assert.deepEqual(probes, ["http://127.0.0.1:8788/healthz", "http://127.0.0.1:8788/healthz"]);
		assert.equal(spawns.length, 1);
		assert.equal(spawns[0].command, "/opt/homebrew/bin/caddy");
		assert.deepEqual(spawns[0].args, [
			"run",
			"--config", join(root, "runtime", "Caddyfile"),
			"--adapter", "caddyfile",
			"--pidfile", join(root, "runtime", "caddy.pid"),
		]);
		assert.equal(spawns[0].options.shell, false);
		assert.deepEqual(spawns[0].options.env, {
			PATH: "/trusted/host/bin",
			PATHEXT: ".EXE;.CMD",
			SystemRoot: "C:\\Windows",
			WINDIR: "C:\\Windows",
			COMSPEC: "C:\\Windows\\System32\\cmd.exe",
			DISPLAY: ":99",
			LANG: "zh_CN.UTF-8",
			LC_CTYPE: "zh_CN.UTF-8",
			TZ: "Asia/Shanghai",
			HOME: join(root, "runtime"),
			USERPROFILE: join(root, "runtime"),
			XDG_CONFIG_HOME: join(root, "runtime", "config"),
			XDG_DATA_HOME: join(root, "runtime", "data"),
			XDG_CACHE_HOME: join(root, "runtime", "cache"),
			TMPDIR: join(root, "runtime", "tmp"),
			TMP: join(root, "runtime", "tmp"),
			TEMP: join(root, "runtime", "tmp"),
		});

		const caddyfile = await readFile(join(root, "runtime", "Caddyfile"), "utf8");
		assert.match(caddyfile, /admin off/u);
		assert.match(caddyfile, /respond \/healthz "ok" 200/u);
		assert.match(caddyfile, /handle_path \/artifacts\/\*/u);
		assert.match(caddyfile, /root \* ".*published files"/u);
		assert.match(caddyfile, /Content-Security-Policy/u);
		assert.match(caddyfile, /form-action 'none'/u);
		assert.match(caddyfile, /sandbox allow-scripts/u);
		assert.doesNotMatch(caddyfile, /script-src 'self'/u);
		assert.match(caddyfile, /Content-Disposition inline/u);
		assert.match(caddyfile, /Content-Disposition attachment/u);
		assert.doesNotMatch(caddyfile, /\bbrowse\b/u);
		const caddyfileInfo = await lstat(join(root, "runtime", "Caddyfile"));
		assert.equal(caddyfileInfo.isFile(), true);
		assert.equal(caddyfileInfo.mode & 0o777, 0o600);
		assert.deepEqual((await readdir(join(root, "runtime"))).filter((name) => name.includes("Caddyfile") && name !== "Caddyfile"), []);

		await site.stop();
		assert.equal(site.isRunning, false);
		assert.deepEqual(child.kills, ["SIGTERM"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Caddy Artifact Site rejects pre-existing symlinks in the publication store", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-artifact-site-symlink-"));
	const workspace = join(root, "workspace");
	const storageRoot = join(root, "public");
	const bytes = Buffer.from("%PDF-symlink-target");
	try {
		await mkdir(workspace, { recursive: true });
		await writeFile(join(workspace, "report.pdf"), bytes);
		const { artifact, manifest } = fileArtifact("report.pdf", "application/pdf", bytes);
		const directory = join(storageRoot, manifest.sha256);
		await mkdir(directory, { recursive: true });
		const outside = join(root, "outside.pdf");
		await writeFile(outside, bytes);
		await symlink(outside, join(directory, "report.pdf"));
		const site = new CaddyArtifactSite({
			agentDir: root,
			workspace,
			storageRoot,
			runtimeRoot: join(root, "runtime"),
			publicBaseUrl: "http://127.0.0.1:8788/artifacts",
			command: "caddy",
			listen: "127.0.0.1:8788",
			hostEnvironment: {},
		});
		await assert.rejects(site.publish(artifact, { path: join(workspace, "report.pdf"), mimeType: "application/pdf", name: "report.pdf" }), /invalid.*quarantined/i);
		assert.deepEqual(await readFile(outside), bytes);
		await assert.rejects(lstat(join(directory, "report.pdf")), /ENOENT|no such file/i);
		assert.equal((await readdir(join(root, "runtime", "quarantine"))).length, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Caddy Artifact Site rejects roots outside the agent directory and symlinked runtime segments", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-artifact-site-boundary-"));
	const outside = await mkdtemp(join(tmpdir(), "beemax-artifact-site-outside-"));
	try {
		assert.throws(() => new CaddyArtifactSite({
			agentDir: root,
			workspace: join(root, "workspace"),
			storageRoot: outside,
			runtimeRoot: join(root, "runtime"),
			publicBaseUrl: "http://127.0.0.1:8788/artifacts",
			command: "caddy",
			listen: "127.0.0.1:8788",
			hostEnvironment: {},
		}), /publication root.*inside the agent directory/i);

		await mkdir(join(root, "artifact-site"), { recursive: true });
		await symlink(outside, join(root, "artifact-site", "runtime"));
		let spawnCount = 0;
		const site = new CaddyArtifactSite({
			agentDir: root,
			workspace: join(root, "workspace"),
			storageRoot: join(root, "artifact-site", "public"),
			runtimeRoot: join(root, "artifact-site", "runtime"),
			publicBaseUrl: "http://127.0.0.1:8788/artifacts",
			command: "caddy",
			listen: "127.0.0.1:8788",
			hostEnvironment: {},
		}, {
			spawn: () => { spawnCount += 1; return new FakeChildProcess(); },
		});
		await assert.rejects(site.start(), /runtime root.*symbolic link/i);
		assert.equal(spawnCount, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("Caddy Artifact Site refuses a symlinked Caddyfile without touching its target", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-artifact-site-caddyfile-"));
	const runtimeRoot = join(root, "runtime");
	const outside = join(root, "outside.conf");
	let spawnCount = 0;
	try {
		await mkdir(runtimeRoot, { recursive: true });
		await writeFile(outside, "outside-must-not-change");
		await symlink(outside, join(runtimeRoot, "Caddyfile"));
		const site = new CaddyArtifactSite({
			agentDir: root,
			workspace: join(root, "workspace"),
			storageRoot: join(root, "public"),
			runtimeRoot,
			publicBaseUrl: "http://127.0.0.1:8788/artifacts",
			command: "caddy",
			listen: "127.0.0.1:8788",
			hostEnvironment: {},
		}, {
			spawn: () => { spawnCount += 1; return new FakeChildProcess(); },
		});
		await assert.rejects(site.start(), /Caddyfile.*symbolic link/i);
		assert.equal(spawnCount, 0);
		assert.equal(await readFile(outside, "utf8"), "outside-must-not-change");
		assert.equal((await lstat(join(runtimeRoot, "Caddyfile"))).isSymbolicLink(), true);
		assert.deepEqual((await readdir(runtimeRoot)).filter((name) => name.includes("Caddyfile") && name !== "Caddyfile"), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Caddy Artifact Site pins the source descriptor across a path replacement race", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-artifact-site-source-race-"));
	const workspace = join(root, "workspace");
	const source = join(workspace, "report.pdf");
	const original = Buffer.from("%PDF-original-pinned-content");
	const replacement = Buffer.from("%PDF-attacker-replacement!!");
	try {
		await mkdir(workspace, { recursive: true });
		await writeFile(source, original);
		const { artifact, manifest } = fileArtifact("report.pdf", "application/pdf", original);
		let hookCount = 0;
		const site = new CaddyArtifactSite({
			agentDir: root,
			workspace,
			storageRoot: join(root, "public"),
			runtimeRoot: join(root, "runtime"),
			publicBaseUrl: "http://127.0.0.1:8788/artifacts",
			command: "caddy",
			listen: "127.0.0.1:8788",
			hostEnvironment: {},
		}, {
			afterSourcePinned: async (pinnedPath) => {
				hookCount += 1;
				await rename(pinnedPath, `${pinnedPath}.pinned`);
				await writeFile(pinnedPath, replacement);
			},
		});
		await site.publish(artifact, { path: source, mimeType: "application/pdf", name: "report.pdf" });
		assert.equal(hookCount, 1);
		assert.deepEqual(await readFile(join(root, "public", manifest.sha256, "report.pdf")), original);
		assert.deepEqual(await readFile(source), replacement);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Caddy Artifact Site quarantines a corrupt immutable destination instead of replacing or serving it", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-artifact-site-corrupt-"));
	const workspace = join(root, "workspace");
	const bytes = Buffer.from("%PDF-original-publication");
	try {
		await mkdir(workspace, { recursive: true });
		const source = join(workspace, "report.pdf");
		await writeFile(source, bytes);
		const { artifact, manifest } = fileArtifact("report.pdf", "application/pdf", bytes);
		const site = new CaddyArtifactSite({
			agentDir: root,
			workspace,
			storageRoot: join(root, "public"),
			runtimeRoot: join(root, "runtime"),
			publicBaseUrl: "http://127.0.0.1:8788/artifacts",
			command: "caddy",
			listen: "127.0.0.1:8788",
			hostEnvironment: {},
		});
		await site.publish(artifact, { path: source, mimeType: "application/pdf", name: "report.pdf" });
		const destination = join(root, "public", manifest.sha256, "report.pdf");
		await chmod(destination, 0o644);
		await writeFile(destination, Buffer.from("%PDF-corrupt-publication"));
		await chmod(destination, 0o444);

		await assert.rejects(site.publish(artifact, { path: source, mimeType: "application/pdf", name: "report.pdf" }), /invalid.*quarantined/i);
		await assert.rejects(lstat(destination), /ENOENT|no such file/i);
		const quarantine = await readdir(join(root, "runtime", "quarantine"));
		assert.equal(quarantine.length, 1);
		assert.deepEqual(await readFile(join(root, "runtime", "quarantine", quarantine[0])), Buffer.from("%PDF-corrupt-publication"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Caddy Artifact Site rejects a symlinked digest directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-artifact-site-directory-symlink-"));
	const workspace = join(root, "workspace");
	const storageRoot = join(root, "public");
	const bytes = Buffer.from("%PDF-directory-symlink");
	try {
		await mkdir(workspace, { recursive: true });
		await writeFile(join(workspace, "report.pdf"), bytes);
		const { artifact, manifest } = fileArtifact("report.pdf", "application/pdf", bytes);
		await mkdir(storageRoot, { recursive: true });
		const outside = join(root, "outside");
		await mkdir(outside);
		await symlink(outside, join(storageRoot, manifest.sha256));
		const site = new CaddyArtifactSite({
			agentDir: root,
			workspace,
			storageRoot,
			runtimeRoot: join(root, "runtime"),
			publicBaseUrl: "http://127.0.0.1:8788/artifacts",
			command: "caddy",
			listen: "127.0.0.1:8788",
			hostEnvironment: {},
		});
		await assert.rejects(site.publish(artifact, { path: join(workspace, "report.pdf"), mimeType: "application/pdf", name: "report.pdf" }), /publication directory|symbolic link/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a managed Artifact Site refuses links after its Caddy child exits", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-artifact-site-exit-"));
	const child = new FakeChildProcess();
	try {
		const site = new CaddyArtifactSite({
			agentDir: root,
			workspace: join(root, "workspace"),
			storageRoot: join(root, "public"),
			runtimeRoot: join(root, "runtime"),
			publicBaseUrl: "http://127.0.0.1:8788/artifacts",
			command: "caddy",
			listen: "127.0.0.1:8788",
			hostEnvironment: {},
		}, {
			spawn: () => child,
			fetch: async () => ({ ok: true, status: 200 }),
			delay: async () => {},
		});
		await site.start();
		child.exitCode = 1;
		child.emit("exit", 1, null);
		await assert.rejects(site.publish({}, {}), /not running/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

class FakeChildProcess extends EventEmitter {
	exitCode = null;
	signalCode = null;
	stderr = new PassThrough();
	kills = [];

	kill(signal) {
		this.kills.push(signal);
		this.signalCode = signal;
		this.emit("exit", null, signal);
		return true;
	}
}
