import { cp, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { hermesSuccessfulToolSourceMaterial, parseHermesEvidence } from "../agent-parity-adapters.mjs";
import { collectFixtureEvidence, digestConfiguration, isolatedEvaluationWorkspace, parityPrompt, runSubprocess, startFixtureAuthorityServer, validatePublicSources } from "./subprocess.mjs";

export async function inspectAgentParityTarget({ options = {} }) {
	const captured = await runSubprocess(options.binary || "hermes", ["--version"]);
	const match = captured.stdout.match(/Hermes Agent v(\d+\.\d+\.\d+)/i);
	if (captured.exitCode !== 0 || !match) throw new Error("Unable to verify Hermes Agent version");
	const sourceHome = resolve(options.sourceHome || options.home || join(homedir(), ".hermes"));
	const revision = await runSubprocess("git", ["-C", join(sourceHome, "hermes-agent"), "rev-parse", "HEAD"]);
	if (revision.exitCode !== 0 || !/^[a-f0-9]{40}$/i.test(revision.stdout.trim())) throw new Error("Unable to verify Hermes Agent source revision");
	return { version: match[1], revision: revision.stdout.trim(), configurationSha256: await digestConfiguration([join(sourceHome, "config.yaml"), join(sourceHome, "profile.yaml")], { provider: options.provider ?? "default", toolsets: options.toolsets ?? "default", ignoreRules: options.ignoreRules === true }) };
}

export async function createAgentParityAdapter({ system, options = {} }) {
	const binary = options.binary || "hermes";
	const sourceHome = resolve(options.sourceHome || options.home || join(homedir(), ".hermes"));
	const mcpServerPath = resolve(options.mcpServerPath || `${options.fixtureRoot}/mcp-server.mjs`);
	const execute = async (scenario, signal) => {
		const workspace = await isolatedEvaluationWorkspace(options.fixtureRoot, "beemax-parity-hermes-");
		const home = await mkdtemp(join(homedir(), ".hermes-parity-"));
		for (const name of [".env", "auth.json", "config.yaml", "profile.yaml"]) await copyIfPresent(join(sourceHome, name), join(home, name));
		const marker = `beemax-parity:${scenario.id}:${crypto.randomUUID()}`;
		let authority;
		const startedAt = Date.now() / 1_000;
		const args = ["-z", `${parityPrompt(scenario)}\n\nEvaluation marker: ${marker}`, "--model", system.model];
		if (options.provider) args.push("--provider", String(options.provider));
		if (options.toolsets) args.push("--toolsets", String(options.toolsets));
		if (options.ignoreRules === true) args.push("--ignore-rules");
		try {
			authority = await startFixtureAuthorityServer({ serverPath: mcpServerPath, workspace, signal });
			const configured = await runSubprocess(binary, ["mcp", "add", "agent_parity", "--url", authority.url], { signal, env: { HERMES_HOME: home } });
			if (configured.exitCode !== 0) throw new Error(`Unable to configure Hermes fixture MCP: ${configured.stderr || configured.stdout}`);
			const captured = await runSubprocess(binary, args, { cwd: workspace.cwd, signal, env: { HERMES_HOME: home } });
			let persisted;
			try { persisted = readHermesSession(join(home, "state.db"), marker, startedAt); }
			catch (error) { if (captured.exitCode === 0) throw error; persisted = { session: undefined, messages: [] }; }
			const fixtureEvidence = await collectFixtureEvidence(workspace.cwd, workspace.authorityDir, workspace.receiptKey);
			const validatedSourceRefs = await validatePublicSources(hermesSuccessfulToolSourceMaterial(persisted.messages), scenario.outputContract.minPublicSources, signal);
			return parseHermesEvidence({ scenario, ...captured, ...persisted, fixtureEvidence, validatedSourceRefs });
		} finally { await authority?.dispose(); await Promise.all([workspace.dispose(), rm(home, { recursive: true, force: true })]); }
	};
	execute.dispose = async () => {};
	return execute;
}

async function copyIfPresent(source, destination) { try { await cp(source, destination); } catch (error) { if (error?.code !== "ENOENT") throw error; } }

function readHermesSession(path, marker, startedAt) {
	const database = new Database(path, { readonly: true, fileMustExist: true });
	try {
		const session = database.prepare(`
			SELECT DISTINCT s.id, s.input_tokens, s.output_tokens, s.end_reason
			FROM sessions s JOIN messages m ON m.session_id = s.id
			WHERE s.started_at >= ? AND m.content LIKE ?
			ORDER BY s.started_at DESC LIMIT 1
		`).get(startedAt - 1, `%${marker}%`);
		if (!session) throw new Error(`Hermes did not persist the parity Session marker ${marker}`);
		const messages = database.prepare("SELECT role, content, tool_call_id, tool_calls, tool_name FROM messages WHERE session_id = ? ORDER BY timestamp, id").all(session.id);
		return {
			session: { id: session.id, inputTokens: session.input_tokens, outputTokens: session.output_tokens, endReason: session.end_reason },
			messages: messages.map((message) => ({ role: message.role, content: message.content, toolCallId: message.tool_call_id, toolCalls: message.tool_calls, toolName: message.tool_name })),
		};
	} finally { database.close(); }
}
