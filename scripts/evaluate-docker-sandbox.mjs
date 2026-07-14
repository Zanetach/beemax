#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_DOCKER_SANDBOX_LIMITS, DockerExecutionPort } from "../packages/core/dist/index.js";

const args = process.argv.slice(2);
const profilePath = resolve(valueAfter(args, "--profile") ?? "evals/sandbox-profiles/ubuntu-docker-node22.json");
const profile = JSON.parse(readFileSync(profilePath, "utf8"));
const developmentHost = args.includes("--allow-docker-desktop");
assert.equal(profile.schemaVersion, 1, "Sandbox Profile schema is invalid");
assert.deepEqual(profile.limits, DEFAULT_DOCKER_SANDBOX_LIMITS, "Sandbox Profile limits drifted from production composition");
if (process.platform !== profile.hostPlatform && !developmentHost) throw new Error(`Docker Sandbox release evidence requires ${profile.hostPlatform}; current host is ${process.platform}`);
const hostOs = process.platform === "linux" ? osRelease() : undefined;
if (!developmentHost) {
	assert.equal(process.arch, profile.hostArchitecture, "Docker Sandbox host architecture is unsupported");
	assert.equal(hostOs?.ID, profile.hostOsId, "Docker Sandbox host OS is unsupported");
	assert.match(hostOs?.VERSION_ID ?? "", new RegExp(profile.hostOsVersionPattern), "Docker Sandbox host OS version is unsupported");
}
const docker = dockerFacts();
assert.equal(docker.osType, profile.dockerOsType, "Docker daemon is not using Linux containers");
if (!developmentHost) assert.equal(docker.architecture, profile.dockerArchitecture, "Docker Sandbox daemon architecture is unsupported");
execFileSync("docker", ["pull", profile.image], { stdio: "ignore", timeout: 120_000 });
const image = dockerImageFacts(profile.image);

const root = mkdtempSync(join(developmentHost ? process.cwd() : tmpdir(), ".beemax-docker-sandbox-"));
const source = { platform: "eval", chatId: "sandbox", chatType: "dm", userId: "sandbox" };
const profileId = `sandbox-eval-${process.pid}`;
const baseOptions = { profileId, image: profile.image, timeoutMs: 10_000, workspace: root };
const observations = {};
try {
	writeFileSync(join(root, "input.txt"), "sandbox evidence\n", "utf8");
	const none = new DockerExecutionPort({ ...baseOptions, workspaceAccess: "none" });
	const probe = await none.execute({ source, cwd: root, command: containerProbeCommand(), timeoutMs: 10_000 });
	assert.equal(probe.exitCode, 0, probe.stderr);
	Object.assign(observations, JSON.parse(probe.stdout.trim()));

	const readOnly = new DockerExecutionPort({ ...baseOptions, workspaceAccess: "ro" });
	assert.equal(await readOnly.readFile({ source, cwd: root, path: join(root, "input.txt") }), "sandbox evidence\n");
	await assert.rejects(readOnly.writeFile({ source, cwd: root, path: join(root, "blocked.txt") }, "blocked"), /requires read-write workspace access/);
	observations.readOnlyWorkspace = true;

	const readWrite = new DockerExecutionPort({ ...baseOptions, workspaceAccess: "rw" });
	await readWrite.writeFile({ source, cwd: root, path: join(root, "output.txt") }, "committed\n");
	assert.equal(readFileSync(join(root, "output.txt"), "utf8"), "committed\n");
	observations.readWriteWorkspace = true;

	const oversized = await none.execute({ source, cwd: root, command: `node -e 'process.stdout.write("x".repeat(${profile.limits.maxOutputBytes + 1024}))'`, timeoutMs: 10_000 });
	assert.notEqual(oversized.exitCode, 0, "Sandbox output exceeded the configured bound");
	observations.outputBounded = true;

	const timeoutStartedAt = Date.now();
	const shortTimeout = new DockerExecutionPort({ ...baseOptions, workspaceAccess: "none", timeoutMs: 500 });
	const timed = shortTimeout.execute({ source, cwd: root, command: "sleep 30", timeoutMs: 10_000 });
	await waitForContainer(profileId, true);
	const timedOut = await timed;
	assert.notEqual(timedOut.exitCode, 0);
	assert.ok(Date.now() - timeoutStartedAt < 2_000, "Sandbox timeout exceeded its cleanup budget");
	await waitForContainer(profileId, false);
	observations.timeoutCleanup = true;

	const controller = new AbortController();
	const startedAt = Date.now();
	const active = none.execute({ source, cwd: root, command: "sleep 30", timeoutMs: 10_000, signal: controller.signal });
	const containerId = await waitForContainer(profileId, true);
	const inspection = JSON.parse(execFileSync("docker", ["inspect", containerId], { encoding: "utf8", timeout: 5_000 }))[0];
	assert.equal(inspection.Config.Labels["com.beemax.sandbox"], "execution");
	assert.equal(inspection.Config.Labels["com.beemax.profile"], profileId);
	controller.abort(new Error("sandbox evaluation cancellation"));
	const cancelled = await active;
	assert.notEqual(cancelled.exitCode, 0);
	assert.ok(Date.now() - startedAt < 2_000, "Sandbox cancellation exceeded its cleanup budget");
	await waitForContainer(profileId, false);
	observations.cancellationCleanup = true;
	observations.profileLabels = true;

	assert.equal(observations.rootReadOnly, true);
	assert.equal(observations.networkBlocked, true);
	assert.equal(observations.workspaceAbsent, true);
	assert.equal(observations.capEff, "0000000000000000");
	assert.equal(observations.noNewPrivileges, 1);
	assert.equal(observations.memoryMax, profile.limits.memoryBytes);
	assert.equal(observations.cpuQuota, profile.limits.cpus);
	assert.equal(observations.pidsMax, profile.limits.pids);
	assert.ok(observations.tmpfsBytes <= profile.limits.tmpfsBytes && observations.tmpfsBytes > profile.limits.tmpfsBytes * 0.8);

	const report = { schemaVersion: 1, profile: { id: profile.id, description: profile.description }, host: { platform: process.platform, arch: process.arch, node: process.version, osId: hostOs?.ID, osVersion: hostOs?.VERSION_ID, formalEvidence: !developmentHost }, docker, image, limits: profile.limits, observations, gate: { passed: true, failures: [] } };
	const output = `${JSON.stringify(report, null, 2)}\n`;
	const writePath = valueAfter(args, "--write");
	if (writePath) writeFileSync(resolve(writePath), output, "utf8");
	process.stdout.write(output);
} finally {
	try { execFileSync("docker", ["rm", "-f", ...containerIds(profileId)], { stdio: "ignore", timeout: 5_000 }); } catch {}
	rmSync(root, { recursive: true, force: true });
}

function dockerFacts() {
	const format = "{{json .}}";
	const value = JSON.parse(execFileSync("docker", ["info", "--format", format], { encoding: "utf8", timeout: 5_000 }));
	return { serverVersion: value.ServerVersion, osType: value.OSType, architecture: value.Architecture, rootless: value.SecurityOptions?.some((entry) => String(entry).includes("rootless")) ?? false };
}

function dockerImageFacts(name) {
	const value = JSON.parse(execFileSync("docker", ["image", "inspect", name], { encoding: "utf8", timeout: 5_000 }))[0];
	return { requested: name, id: value.Id, repoDigests: value.RepoDigests ?? [] };
}

function osRelease() {
	return Object.fromEntries(readFileSync("/etc/os-release", "utf8").split("\n").filter(Boolean).map((line) => line.split("=", 2)).map(([key, value]) => [key, value?.replace(/^"|"$/gu, "")]));
}

function containerProbeCommand() {
	return `node --input-type=module <<'NODE'
import fs from "node:fs";
const status = fs.readFileSync("/proc/self/status", "utf8");
const field = (name) => status.match(new RegExp("^" + name + ":\\\\s+([^\\\\s]+)", "m"))?.[1];
let rootReadOnly = false;
try { fs.writeFileSync("/beemax-root-probe", "blocked"); } catch { rootReadOnly = true; }
let networkBlocked = false;
try { await fetch("https://example.com", { signal: AbortSignal.timeout(2000) }); } catch { networkBlocked = true; }
const cpu = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\\s+/).map(Number);
const stat = fs.statfsSync("/tmp");
console.log(JSON.stringify({
  rootReadOnly,
  networkBlocked,
  workspaceAbsent: !fs.existsSync("/workspace"),
  capEff: field("CapEff"),
  noNewPrivileges: Number(field("NoNewPrivs")),
  memoryMax: Number(fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8")),
  cpuQuota: cpu[0] / cpu[1],
  pidsMax: Number(fs.readFileSync("/sys/fs/cgroup/pids.max", "utf8")),
  tmpfsBytes: stat.bsize * stat.blocks
}));
NODE`;
}

async function waitForContainer(profileId, expected) {
	const deadline = Date.now() + 5_000;
	do {
		const ids = containerIds(profileId);
		if (expected && ids[0]) return ids[0];
		if (!expected && ids.length === 0) return undefined;
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for Sandbox container presence=${expected}`);
}

function containerIds(profileId) {
	return execFileSync("docker", ["ps", "-aq", "--filter", `label=com.beemax.profile=${profileId}`], { encoding: "utf8", timeout: 5_000 }).trim().split("\n").filter(Boolean);
}

function valueAfter(values, flag) { const index = values.indexOf(flag); return index < 0 ? undefined : values[index + 1]; }
