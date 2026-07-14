import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { codexSuccessfulToolSourceMaterial, parseCodexEvidence } from "../agent-parity-adapters.mjs";
import { collectFixtureEvidence, digestConfiguration, isolatedEvaluationWorkspace, parityPrompt, runSubprocess, startFixtureAuthorityServer, validatePublicSources } from "./subprocess.mjs";

export async function inspectAgentParityTarget({ options = {} }) {
	const captured = await runSubprocess(options.binary || "codex", ["--version"]);
	const match = captured.stdout.match(/codex-cli\s+(\d+\.\d+\.\d+)/i);
	if (captured.exitCode !== 0 || !match) throw new Error("Unable to verify Codex CLI version");
	return { version: match[1], configurationSha256: await digestConfiguration(options.ignoreUserConfig === true ? [] : [join(homedir(), ".codex", "config.toml")], { ignoreUserConfig: options.ignoreUserConfig === true, sandbox: options.sandbox ?? "workspace-write" }) };
}

export async function createAgentParityAdapter({ system, options = {} }) {
	const binary = options.binary || "codex";
	const mcpServerPath = resolve(options.mcpServerPath || `${options.fixtureRoot}/mcp-server.mjs`);
	return async (scenario, signal) => {
		const workspace = await isolatedEvaluationWorkspace(options.fixtureRoot, "beemax-parity-codex-");
		let authority;
		try {
			authority = await startFixtureAuthorityServer({ serverPath: mcpServerPath, workspace, signal });
			const args = ["exec", "--json", "--ephemeral", "--sandbox", options.sandbox || "workspace-write", "--skip-git-repo-check", "-C", workspace.cwd, "-m", system.model];
			args.push("-c", `mcp_servers.agent_parity.url=${JSON.stringify(authority.url)}`);
			if (options.ignoreUserConfig === true) args.push("--ignore-user-config");
			args.push(parityPrompt(scenario));
			const captured = await runSubprocess(binary, args, { cwd: workspace.cwd, signal });
			const fixtureEvidence = await collectFixtureEvidence(workspace.cwd, workspace.authorityDir, workspace.receiptKey);
			const validatedSourceRefs = await validatePublicSources(codexSuccessfulToolSourceMaterial(captured.stdout), scenario.outputContract.minPublicSources, signal);
			return parseCodexEvidence({ scenario, ...captured, fixtureEvidence, validatedSourceRefs });
		} finally {
			await authority?.dispose();
			await workspace.dispose();
		}
	};
}
