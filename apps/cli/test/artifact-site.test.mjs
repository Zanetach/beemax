import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createArtifactManifest } from "@beemax/core";
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

test("Caddy Artifact Site publishes immutable verified HTML, PDF, and Word outputs", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-artifact-site-"));
	const workspace = join(root, "workspace");
	const storageRoot = join(root, "public");
	await mkdir(workspace, { recursive: true });
	try {
		const site = new CaddyArtifactSite({
			workspace,
			storageRoot,
			runtimeRoot: join(root, "runtime"),
			publicBaseUrl: "http://127.0.0.1:8788/artifacts",
			command: "/opt/homebrew/bin/caddy",
			listen: "127.0.0.1:8788",
		});
		const cases = [
			["报告.html", "text/html", Buffer.from("<h1>真实报告</h1>"), "inline"],
			["report.pdf", "application/pdf", Buffer.from("%PDF-test"), "inline"],
			["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.from("PK-test-docx"), "attachment"],
		];
		for (const [name, mediaType, bytes, disposition] of cases) {
			await writeFile(join(workspace, name), bytes);
			const { artifact, manifest } = fileArtifact(name, mediaType, bytes);
			const published = await site.publish(artifact, { path: join(workspace, name), mimeType: mediaType, name });
			assert.deepEqual(published, {
				url: `http://127.0.0.1:8788/artifacts/${manifest.sha256}/${encodeURIComponent(name)}`,
				name,
				mediaType,
				disposition,
			});
			assert.deepEqual(await readFile(join(storageRoot, manifest.sha256, name)), bytes);
		}

		const html = cases[0];
		await writeFile(join(workspace, html[0]), "changed after publication");
		const originalDigest = createHash("sha256").update(html[2]).digest("hex");
		assert.deepEqual(await readFile(join(storageRoot, originalDigest, html[0])), html[2]);
		} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Caddy Artifact Site rejects unsupported or manifest-mismatched files", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-artifact-site-reject-"));
	const workspace = join(root, "workspace");
	await mkdir(workspace, { recursive: true });
	try {
		const site = new CaddyArtifactSite({
			workspace,
			storageRoot: join(root, "public"),
			runtimeRoot: join(root, "runtime"),
			publicBaseUrl: "http://127.0.0.1:8788/artifacts",
			command: "caddy",
			listen: "127.0.0.1:8788",
		});
		const secret = Buffer.from("SECRET=value");
		await writeFile(join(workspace, ".env"), secret);
		const unsupported = fileArtifact(".env", "text/plain", secret).artifact;
		await assert.rejects(site.publish(unsupported, { path: join(workspace, ".env"), mimeType: "text/plain", name: ".env" }), /unsupported document type/i);

		const expected = Buffer.from("expected");
		await writeFile(join(workspace, "report.pdf"), "tampered");
		const mismatched = fileArtifact("report.pdf", "application/pdf", expected).artifact;
		await assert.rejects(site.publish(mismatched, { path: join(workspace, "report.pdf"), mimeType: "application/pdf", name: "report.pdf" }), /integrity/i);

		await writeFile(join(workspace, "named.pdf"), expected);
		const renamed = fileArtifact("named.pdf", "application/pdf", expected).artifact;
		await assert.rejects(site.publish(renamed, { path: join(workspace, "named.pdf"), mimeType: "application/pdf", name: "other.pdf" }), /name/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Caddy Artifact Site owns a Profile-scoped Caddy lifecycle and probes readiness", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-artifact-site-lifecycle-"));
	const child = new FakeChildProcess();
	const spawns = [];
	const probes = [];
	try {
		const site = new CaddyArtifactSite({
			workspace: join(root, "workspace"),
			storageRoot: join(root, "published files"),
			runtimeRoot: join(root, "runtime"),
			publicBaseUrl: "https://reports.example.test/artifacts",
			command: "/opt/homebrew/bin/caddy",
			listen: "127.0.0.1:8788",
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
		assert.equal(spawns[0].options.env.XDG_DATA_HOME, join(root, "runtime", "data"));
		assert.equal(spawns[0].options.env.XDG_CONFIG_HOME, join(root, "runtime", "config"));

		const caddyfile = await readFile(join(root, "runtime", "Caddyfile"), "utf8");
		assert.match(caddyfile, /admin off/u);
		assert.match(caddyfile, /respond \/healthz "ok" 200/u);
		assert.match(caddyfile, /handle_path \/artifacts\/\*/u);
		assert.match(caddyfile, /root \* ".*published files"/u);
		assert.match(caddyfile, /Content-Security-Policy/u);
		assert.match(caddyfile, /Content-Disposition inline/u);
		assert.match(caddyfile, /Content-Disposition attachment/u);
		assert.doesNotMatch(caddyfile, /\bbrowse\b/u);

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
			workspace,
			storageRoot,
			runtimeRoot: join(root, "runtime"),
			publicBaseUrl: "http://127.0.0.1:8788/artifacts",
			command: "caddy",
			listen: "127.0.0.1:8788",
		});
		await assert.rejects(site.publish(artifact, { path: join(workspace, "report.pdf"), mimeType: "application/pdf", name: "report.pdf" }), /regular file|symbolic link/i);
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
