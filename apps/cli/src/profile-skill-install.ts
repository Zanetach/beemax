import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { inspectProfileSkillTree } from "./profile-skill-integrity.ts";

export interface LocalSkillInspection {
	name: string;
	sha256: string;
	fileCount: number;
	totalBytes: number;
}

/** Inspect a bounded local Skill tree and return its canonical complete-tree digest. */
export async function inspectLocalSkill(source: string): Promise<LocalSkillInspection> {
	if (!isAbsolute(source)) throw new Error("Skill source must be an absolute local directory path");
	const sourcePath = resolve(source);
	const name = basename(sourcePath);
	const boundary = dirname(sourcePath);
	const result = await inspectProfileSkillTree(boundary, name);
	if (result.state !== "present") throw new Error(`Local Skill '${name}' failed integrity validation: ${result.reason}`);
	return { name, sha256: result.sha256, fileCount: result.fileCount, totalBytes: result.totalBytes };
}

/** Install one digest-pinned local Skill into exactly one Profile without overwriting an existing Skill. */
export async function installLocalSkill(input: {
	profileHome: string;
	agentDir: string;
	source: string;
	expectedSha256: string;
}): Promise<LocalSkillInspection & { destination: string }> {
	const expectedSha256 = input.expectedSha256.trim().toLowerCase();
	if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("Skill installation requires --sha256 with a 64-character canonical tree digest");
	const source = await inspectLocalSkill(input.source);
	if (source.sha256 !== expectedSha256) throw new Error(`Local Skill digest mismatch: expected ${expectedSha256}, observed ${source.sha256}`);

	const profileHome = resolve(input.profileHome);
	const agentDir = resolve(input.agentDir);
	await assertRealDirectoryInside(profileHome, agentDir, "Profile Agent directory");
	const skillsRoot = join(agentDir, "skills");
	await assertRealDirectoryInside(profileHome, skillsRoot, "Profile Skills directory");
	const destination = join(skillsRoot, source.name);
	if (await exists(destination)) throw new Error(`Profile Skill '${source.name}' already exists; remove or rename it explicitly before installing another revision`);

	const stagingRoot = join(skillsRoot, `.skill-install-${randomUUID()}`);
	const stagedSkill = join(stagingRoot, source.name);
	await mkdir(stagingRoot, { mode: 0o700 });
	try {
		await cp(resolve(input.source), stagedSkill, { recursive: true, force: false, errorOnExist: true, dereference: false });
		const staged = await inspectProfileSkillTree(stagingRoot, source.name);
		if (staged.state !== "present" || staged.sha256 !== expectedSha256) {
			throw new Error(`Copied Skill failed integrity verification${staged.state === "present" ? `: observed ${staged.sha256}` : `: ${staged.reason}`}`);
		}
		if (await exists(destination)) throw new Error(`Profile Skill '${source.name}' appeared during installation`);
		await rename(stagedSkill, destination);
		const installed = await inspectProfileSkillTree(skillsRoot, source.name);
		if (installed.state !== "present" || installed.sha256 !== expectedSha256) throw new Error(`Published Skill '${source.name}' failed final integrity verification`);
		return { ...source, destination };
	} finally {
		await rm(stagingRoot, { recursive: true, force: true });
	}
}

async function assertRealDirectoryInside(boundary: string, candidate: string, label: string): Promise<void> {
	const [boundaryInfo, candidateInfo] = await Promise.all([lstat(boundary), lstat(candidate)]);
	if (boundaryInfo.isSymbolicLink() || !boundaryInfo.isDirectory()) throw new Error(`Profile Home must be a real directory: ${boundary}`);
	if (candidateInfo.isSymbolicLink() || !candidateInfo.isDirectory()) throw new Error(`${label} must be a real directory: ${candidate}`);
	const [realBoundary, realCandidate] = await Promise.all([realpath(boundary), realpath(candidate)]);
	const path = relative(realBoundary, realCandidate);
	if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) throw new Error(`${label} must stay inside its Profile Home: ${candidate}`);
}

async function exists(path: string): Promise<boolean> {
	try { await lstat(path); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
