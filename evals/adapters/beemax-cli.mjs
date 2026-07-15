import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { parseBeeMaxEvidence } from "../agent-parity-adapters.mjs";
import { collectFixtureEvidence, digestConfiguration, isolatedEvaluationWorkspace, parityPrompt, runSubprocess, startFixtureAuthorityServer, validatePublicSources } from "./subprocess.mjs";

export async function inspectAgentParityTarget({ system, options = {} }) {
	const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
	const sourceProfile = String(options.profile || process.env.BEEMAX_PROFILE || "personal");
	const sourceHome = resolve(options.sourceHome || options.home || process.env.BEEMAX_HOME || join(homedir(), ".beemax"));
	const root = join(sourceHome, "profiles", sourceProfile);
	return { version: manifest.version, configurationSha256: await digestConfiguration([join(root, "config.yaml"), join(root, ".env"), join(root, "SOUL.md"), join(root, "USER.md")], { model: system.model, provider: options.provider ?? "profile" }) };
}

export async function createAgentParityAdapter({ system, options = {} }) {
	const cliPath = resolve(options.cliPath || "apps/cli/dist/cli.js");
	const sourceProfile = String(options.profile || process.env.BEEMAX_PROFILE || "personal");
	const sourceHome = resolve(options.sourceHome || options.home || process.env.BEEMAX_HOME || join(homedir(), ".beemax"));
	const mcpServerPath = resolve(options.mcpServerPath || `${options.fixtureRoot}/mcp-server.mjs`);
	return async (scenario, signal) => {
		const workspace = await isolatedEvaluationWorkspace(options.fixtureRoot, "beemax-parity-beemax-");
		const isolatedProfile = await createIsolatedProfile({ sourceHome, sourceProfile, workspace: workspace.cwd, system, provider: options.provider, fixtureRoot: options.fixtureRoot, workspaceWritePolicy: options.workspaceWritePolicy });
		const interactionPath = join(isolatedProfile.profileRoot, "interaction-events.jsonl");
		const tracePath = join(isolatedProfile.profileRoot, "logs", "execution-trace.jsonl");
		const memoryPath = join(isolatedProfile.profileRoot, "memory.db");
		const effectAuthorityPath = join(isolatedProfile.profileRoot, "tool-effects.jsonl.authority.sqlite");
		const startedAt = Date.now();
		let authority;
		const args = [cliPath, "--home", isolatedProfile.home, "--profile", isolatedProfile.profile, "chat", "--plain", "--once", parityPrompt(scenario)];
		try {
			authority = await startFixtureAuthorityServer({ serverPath: mcpServerPath, workspace, signal });
			const mcpConfigPath = join(isolatedProfile.profileRoot, "mcp.json");
			await writeFile(mcpConfigPath, JSON.stringify({ servers: { agent_parity: { type: "http", url: authority.url, required: true } } }));
			await appendProfileRouting(isolatedProfile.profileRoot, { BEEMAX_MODEL: system.model, BEEMAX_MCP_CONFIG: mcpConfigPath, BEEMAX_CWD: workspace.cwd, ...(options.provider ? { BEEMAX_PROVIDER: String(options.provider) } : {}) });
			const captured = await runSubprocess(process.execPath, args, { cwd: workspace.cwd, signal });
			const interactionEvents = filterInteraction(await readJsonLinesSince(interactionPath, 0), startedAt);
			const executionTrace = filterExecution(await readJsonLinesSince(tracePath, 0), startedAt);
			const objectiveId = executionTrace.find((event) => event.triggerKind === "interaction" && event.objectiveId)?.objectiveId;
			const authorities = objectiveId ? readAuthorities(memoryPath, effectAuthorityPath, objectiveId) : { tasks: [], effects: [] };
			const fixtureEvidence = await collectFixtureEvidence(workspace.cwd, workspace.authorityDir, workspace.receiptKey);
			const validatedSourceRefs = await validatePublicSources(authorities.tasks.map((task) => task.evidence ?? "").join("\n"), scenario.outputContract.minPublicSources, signal);
			return parseBeeMaxEvidence({ scenario, ...captured, interactionEvents, executionTrace, fixtureEvidence, validatedSourceRefs, ...authorities });
		} finally { await authority?.dispose(); await Promise.all([workspace.dispose(), isolatedProfile.dispose()]); }
	};
}

export async function createIsolatedProfile({ sourceHome, sourceProfile, workspace, system, provider, fixtureRoot, workspaceWritePolicy }) {
	const home = await mkdtemp(join(tmpdir(), "beemax-parity-profile-"));
	const profile = "parity";
	const profileRoot = join(home, "profiles", profile);
	const sourceRoot = join(sourceHome, "profiles", sourceProfile);
	await Promise.all(["sessions", "skills", "cache", "state", "workspace", "logs"].map((name) => mkdir(join(profileRoot, name), { recursive: true, mode: 0o700 })));
	for (const name of ["config.yaml", ".env", "SOUL.md", "USER.md", "auth.json", "credentials.vault"]) await copyIfPresent(join(sourceRoot, name), join(profileRoot, name));
	await copyIfPresent(join(sourceRoot, "state", "credential-vault.key"), join(profileRoot, "state", "credential-vault.key"));
	if (fixtureRoot) await copyIfPresent(resolve(fixtureRoot, "evaluation-research"), join(profileRoot, "skills", "evaluation-research"));
	await appendProfileRouting(profileRoot, { BEEMAX_MODEL: system.model, BEEMAX_CWD: workspace, ...(provider ? { BEEMAX_PROVIDER: String(provider) } : {}), ...(workspaceWritePolicy ? { BEEMAX_WORKSPACE_WRITE_POLICY: String(workspaceWritePolicy) } : {}) });
	return { home, profile, profileRoot, dispose: () => rm(home, { recursive: true, force: true }) };
}

async function appendProfileRouting(profileRoot, values) {
	const path = join(profileRoot, ".env");
	const existing = await readFile(path, "utf8").catch((error) => { if (error?.code === "ENOENT") return ""; throw error; });
	const additions = Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join("\n");
	await writeFile(path, `${existing.trimEnd()}${existing.trim() ? "\n" : ""}${additions}\n`, { mode: 0o600 });
}

async function copyIfPresent(source, destination) {
	try { await cp(source, destination, { recursive: true }); }
	catch (error) { if (error?.code !== "ENOENT") throw error; }
}

function readAuthorities(memoryPath, effectAuthorityPath, objectiveId) {
	let memory;
	try { memory = new Database(memoryPath, { readonly: true, fileMustExist: true }); }
	catch { return { tasks: [], effects: [] }; }
	let tasks;
	try {
		tasks = memory.prepare(`WITH RECURSIVE graph(id) AS (
			SELECT id FROM tasks WHERE id = ?
			UNION ALL SELECT tasks.id FROM tasks JOIN graph ON tasks.parent_id = graph.id
		) SELECT id, parent_id AS parentId, status, evidence, artifacts, checkpoint,
			verification_outcome AS verificationOutcome, effect_receipts AS effectReceipts,
			access_scope_ref AS accessScopeRef, result, candidate_result AS candidateResult,
			error, verification_feedback AS verificationFeedback
			FROM tasks WHERE id IN graph`).all(objectiveId);
	} finally { memory.close(); }
	let effects = [];
	if (tasks.length) {
		let authority;
		try { authority = new Database(effectAuthorityPath, { readonly: true, fileMustExist: true }); }
		catch { return { tasks, effects }; }
		try {
			const placeholders = tasks.map(() => "?").join(",");
			effects = authority.prepare(`SELECT id, status, task_id AS taskId, task_run_id AS taskRunId, record_json AS recordJson FROM tool_effects WHERE task_id IN (${placeholders})`).all(...tasks.map((task) => task.id));
		} finally { authority.close(); }
	}
	return { tasks, effects };
}

async function readJsonLinesSince(path, offset) {
	try {
		const content = await readFile(path);
		return content.subarray(Math.min(offset, content.length)).toString("utf8").split(/\r?\n/).flatMap((line) => { try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; } });
	} catch { return []; }
}
function filterInteraction(events, startedAt) {
	const finished = [...events].reverse().find((event) => event.type === "turn.finished" && event.at >= startedAt && event.scope?.platform === "cli");
	return finished?.turnId ? events.filter((event) => event.turnId === finished.turnId) : events.filter((event) => event.at >= startedAt);
}
export function filterExecution(events, startedAt) {
	const started = events.find((event) => event.type === "execution.started" && event.at >= startedAt && event.triggerKind === "interaction");
	if (started?.objectiveId) return events.filter((event) => event.at >= startedAt && (event.objectiveId === started.objectiveId || event.taskId === started.objectiveId || event.executionId === started.executionId));
	return started?.executionId ? events.filter((event) => event.executionId === started.executionId) : events.filter((event) => event.at >= startedAt);
}
