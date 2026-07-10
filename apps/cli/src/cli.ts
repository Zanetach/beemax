#!/usr/bin/env node
/**
 * beemax - BeeMax Agent CLI.
 *
 * Usage:
 *   beemax gateway    Start the Feishu gateway (long-running)
 *   beemax chat       Local interactive chat on stdout (no Feishu)
 *   beemax model      Show / set the configured model
 */

import { buildSubagentSystemPrompt, executeSubagentTask, runGateway } from "./gateway.ts";
import { beemaxRoot, loadConfig } from "./config.ts";
import { runDoctor } from "./doctor.ts";
import {
	configureFeishuChannel,
	configureModel,
	createProfile,
	deleteProfile,
	listProfiles,
	migrateProfile,
	removeFeishuChannel,
	setActiveProfile,
	testFeishuCredentials,
} from "./profile-config.ts";
import { activeProfile, resolveProfileLocation } from "./profile-home.ts";
import { installSystemdService, runServiceAction, type ServiceAction } from "./service-manager.ts";
import { runSetup, type SetupOptions } from "./setup.ts";

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2));
	applyRuntimePaths(parsed);
	const cmd = parsed.positionals[0] ?? "help";
	const profile = parsed.profile ?? activeProfile();
	const getConfig = () => loadConfig(parsed.configPath, profile);

	switch (cmd) {
		case "setup":
			if (parsed.configPath) throw new Error("beemax setup does not support --config; select a Profile with --profile");
			if (parsed.options["api-key"]) throw new Error("Do not pass model secrets in argv; set BEEMAX_API_KEY or use the interactive prompt");
			if (!(await runSetup(setupOptions(parsed, false)))) process.exitCode = 1;
			break;
		case "init":
			await runInit(parsed);
			break;
		case "agent":
			await runAgentCommand(parsed);
			break;
		case "channel":
			await runChannelCommand(parsed);
			break;
		case "gateway":
			if (parsed.positionals[1] === "setup") {
				if (parsed.configPath) throw new Error("beemax gateway setup does not support --config; select a Profile with --profile");
				if (parsed.options["api-key"]) throw new Error("Do not pass model secrets in argv; set BEEMAX_API_KEY or use the interactive prompt");
				if (!(await runSetup(setupOptions(parsed, true)))) process.exitCode = 1;
			} else if (parsed.positionals[1] === "install") {
				await installSystemdService(beemaxRoot(), parsed.options.system === true ? "system" : "user");
				console.log(`BeeMax Gateway service installed for Profile '${gatewayProfile(parsed)}'.`);
			} else if (parsed.positionals[1] === "list") {
				console.log((await listProfiles()).map((name) => `${name}  beemax@${name}.service`).join("\n") || "No Agent Profiles configured.");
			} else if (["start", "stop", "restart", "status", "logs"].includes(parsed.positionals[1] ?? "")) {
				runServiceAction(parsed.positionals[1] as ServiceAction, gatewayProfile(parsed), undefined, process.platform, parsed.options.system === true ? "system" : "user");
			} else if (!parsed.positionals[1] || parsed.positionals[1] === "run") {
				await runGateway(loadConfig(parsed.configPath, gatewayProfile(parsed)));
			} else throw new Error(`Unknown gateway action: ${parsed.positionals[1]}`);
			break;
		case "chat":
			await runChat(getConfig());
			break;
		case "model":
			await runModelCommand(parsed);
			break;
		case "doctor":
			if (!(await runDoctor(getConfig()))) process.exitCode = 1;
			break;
		case "profile":
			await runProfileCommand(parsed);
			break;
		case "auth":
			if (parsed.positionals[1] !== "codex") throw new Error("Usage: beemax auth codex --profile <name>");
			await runCodexAuth(getConfig());
			break;
		case "service":
			if (parsed.positionals[1] !== "install") throw new Error("Usage: beemax service install");
			await installSystemdService(beemaxRoot(), parsed.options.system === true ? "system" : "user");
			console.log("BeeMax systemd service installed. Start an agent with: beemax start <name>");
			break;
		case "start":
		case "stop":
		case "restart":
		case "status":
		case "logs":
			runServiceAction(cmd, serviceProfile(parsed), undefined, process.platform, parsed.options.system === true ? "system" : "user");
			break;
		case "help":
		default:
			console.log(`beemax - persistent personal agent (Pi + Feishu)

Commands:
  setup      Configure one Agent Profile, model, identity, and Gateway
  init       Create the first Agent profile
  agent      create | list | delete
  channel    add | list | remove | test
  gateway    run | setup | install | start | stop | restart | status | logs | list
  chat       Local interactive chat for one profile
  model      show | set <provider> <model>
  doctor     Check profile readiness
  profile    create | list | show | path | use | migrate | delete
  auth       codex (stores OAuth only inside the selected profile)
  service    install (Linux systemd)
  start      Start a profile systemd service
  stop       Stop a profile systemd service
  restart    Restart a profile systemd service
  status     Show profile systemd status
  logs       Follow profile systemd logs

Options:
  --profile <name>         Select an isolated Profile (defaults to the active Profile)
  --config <path>          Use an explicit YAML config file
  --home <path>            Override BEEMAX_HOME for this invocation
  --root <path>            Override the BeeMax installation root for this invocation
  --yes                    Confirm destructive configuration changes

Environment:
  BEEMAX_HOME             Profile home root (default: ~/.beemax)
  BEEMAX_PROFILE          Profile name (same as --profile; overrides active Profile)
  FEISHU_APP_ID           Feishu self-built app id
  FEISHU_APP_SECRET       Feishu self-built app secret
  FEISHU_ALLOWED_USERS    Authorized IDs, comma-separated (default: deny all)
  BEEMAX_PROVIDER         Model provider
  BEEMAX_MODEL            Model id
  BEEMAX_API_KEY          Provider API key
  BEEMAX_DB_PATH          Memory + automation SQLite path
  BEEMAX_MCP_CONFIG       MCP JSON config path
  BEEMAX_TIMEZONE         Schedule and heartbeat timezone

Profiles: ~/.beemax/profiles/<name>/ (legacy config/profiles/*.yaml remains readable)`);
			break;
	}
}

interface ParsedArgs {
	positionals: string[];
	profile?: string;
	configPath?: string;
	options: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
	const parsed: ParsedArgs = { positionals: [], options: {} };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--profile" || arg === "--config") {
			const value = args[++index];
			if (!value) throw new Error(`${arg} requires a value`);
			if (arg === "--profile") parsed.profile = value;
			else parsed.configPath = value;
		} else if (arg.startsWith("--profile=")) parsed.profile = arg.slice(10);
		else if (arg.startsWith("--config=")) parsed.configPath = arg.slice(9);
		else if (arg.startsWith("--")) {
			const equals = arg.indexOf("=");
			const key = arg.slice(2, equals > 0 ? equals : undefined);
			if (!key) throw new Error(`Invalid option: ${arg}`);
			if (equals > 0) parsed.options[key] = arg.slice(equals + 1);
			else if (BOOLEAN_OPTIONS.has(key)) parsed.options[key] = true;
			else {
				const value = args[++index];
				if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
				parsed.options[key] = value;
			}
		}
		else parsed.positionals.push(arg);
	}
	return parsed;
}

const BOOLEAN_OPTIONS = new Set(["yes", "require-mention", "no-require-mention", "non-interactive", "system", "all"]);

async function runInit(parsed: ParsedArgs): Promise<void> {
	const profile = parsed.profile ?? parsed.positionals[1] ?? "personal";
	const paths = await createProfile(profile);
	console.log(`Created BeeMax Agent '${profile}' at ${paths.configPath}`);
	console.log(`Next: beemax model set anthropic claude-sonnet-4-5 --profile ${profile}`);
	console.log(`Then: beemax channel add feishu --profile ${profile}`);
}

async function runAgentCommand(parsed: ParsedArgs): Promise<void> {
	const action = parsed.positionals[1] ?? "list";
	if (action === "list") {
		const profiles = await listProfiles();
		console.log(profiles.join("\n") || "No Agent profiles configured.");
		return;
	}
	const profile = parsed.positionals[2] ?? parsed.profile;
	if (!profile) throw new Error(`agent ${action} requires a profile name`);
	if (action === "create") {
		const paths = await createProfile(profile);
		console.log(`Created Agent '${profile}' at ${paths.configPath}`);
		return;
	}
	if (action === "delete") {
		if (parsed.options.yes !== true) throw new Error("Agent deletion requires --yes; runtime data is preserved");
		const paths = await deleteProfile(profile);
		console.log(`Deleted Agent configuration '${profile}'. Runtime data was preserved at ${paths.dataPath}`);
		return;
	}
	throw new Error(`Unknown agent action: ${action}`);
}

async function runModelCommand(parsed: ParsedArgs): Promise<void> {
	const action = parsed.positionals[1] ?? "show";
	const profile = selectedProfile(parsed);
	if (action === "show") {
		const config = loadConfig(parsed.configPath, profile);
		console.log(`${config.model.provider}/${config.model.model}`);
		return;
	}
	if (action !== "set") throw new Error("Usage: beemax model [show | set <provider> <model>] --profile <name>");
	const provider = parsed.positionals[2];
	const model = parsed.positionals[3];
	if (!provider || !model) throw new Error("model set requires a provider and model ID");
	let apiKey = optionString(parsed, "api-key") ?? process.env.BEEMAX_API_KEY;
	if (!apiKey && parsed.options["non-interactive"] !== true && process.stdin.isTTY) {
		apiKey = await askOne("Model API Key (leave empty to configure later): ", true);
	}
	await configureModel(profile, { provider, model, apiKey, baseUrl: optionString(parsed, "base-url") });
	console.log(`Configured ${provider}/${model} for Agent '${profile}'.`);
}

async function runChannelCommand(parsed: ParsedArgs): Promise<void> {
	const action = parsed.positionals[1] ?? "list";
	const profile = selectedProfile(parsed);
	if (action === "list") {
		const config = loadConfig(parsed.configPath, profile);
		const state = config.feishu.appId && config.feishu.appSecret ? "configured" : "not configured";
		console.log(`feishu  ${state}  domain=${config.feishu.domain}  allowed_users=${config.feishu.allowedUsers.length}`);
		return;
	}
	if (action === "remove") {
		if (parsed.options.yes !== true) throw new Error("Channel removal requires --yes");
		await removeFeishuChannel(profile);
		console.log(`Removed Feishu credentials from Agent '${profile}'.`);
		return;
	}
	if (action === "test") {
		const config = loadConfig(parsed.configPath, profile);
		console.log(await testFeishuCredentials(config.feishu));
		return;
	}
	if (action !== "add" || parsed.positionals[2] !== "feishu") {
		throw new Error("Usage: beemax channel add feishu | list | remove | test");
	}
	const current = loadConfig(parsed.configPath, profile);
	const nonInteractive = parsed.options["non-interactive"] === true || !process.stdin.isTTY;
	let appId = optionString(parsed, "app-id") ?? process.env.FEISHU_APP_ID ?? current.feishu.appId;
	let appSecret = process.env.FEISHU_APP_SECRET ?? current.feishu.appSecret;
	let allowedUsers = splitList(optionString(parsed, "allowed-users") ?? process.env.FEISHU_ALLOWED_USERS)
		?? current.feishu.allowedUsers;
	if (!nonInteractive) {
		appId ||= await askOne("Feishu App ID: ");
		appSecret ||= await askOne("Feishu App Secret: ", true);
		if (allowedUsers.length === 0) allowedUsers = splitList(await askOne("Allowed Feishu user IDs (comma-separated): ")) ?? [];
	}
	if (!appId || !appSecret || allowedUsers.length === 0) {
		throw new Error("Missing Feishu configuration. Set FEISHU_APP_ID, FEISHU_APP_SECRET, and FEISHU_ALLOWED_USERS or run interactively.");
	}
	await configureFeishuChannel(profile, {
		appId,
		appSecret,
		allowedUsers,
		allowedChats: splitList(optionString(parsed, "allowed-chats")) ?? current.feishu.allowedChats,
		domain: channelDomain(parsed, current.feishu.domain),
		requireMention: parsed.options["no-require-mention"] === true
			? false
			: parsed.options["require-mention"] === true ? true : current.feishu.requireMention,
	});
	console.log(`Configured Feishu channel for Agent '${profile}'. Run: beemax channel test --profile ${profile}`);
}

function serviceProfile(parsed: ParsedArgs): string {
	return parsed.positionals[1] ?? selectedProfile(parsed);
}

function gatewayProfile(parsed: ParsedArgs): string {
	return parsed.positionals[2] ?? parsed.profile ?? activeProfile();
}

function selectedProfile(parsed: ParsedArgs): string {
	return parsed.profile ?? activeProfile();
}

function applyRuntimePaths(parsed: ParsedArgs): void {
	const home = optionString(parsed, "home");
	const root = optionString(parsed, "root");
	if (home) process.env.BEEMAX_HOME = home;
	if (root) process.env.BEEMAX_ROOT = root;
}

function setupOptions(parsed: ParsedArgs, gatewayOnly: boolean): SetupOptions {
	return {
		profile: selectedProfile(parsed),
		gatewayOnly,
		nonInteractive: parsed.options["non-interactive"] === true || !process.stdin.isTTY,
		provider: optionString(parsed, "provider") ?? process.env.BEEMAX_PROVIDER,
		model: optionString(parsed, "model") ?? process.env.BEEMAX_MODEL,
		apiKey: process.env.BEEMAX_API_KEY,
		soul: optionString(parsed, "soul") ?? process.env.BEEMAX_SOUL,
		appId: optionString(parsed, "app-id") ?? process.env.FEISHU_APP_ID,
		appSecret: process.env.FEISHU_APP_SECRET,
		allowedUsers: splitList(optionString(parsed, "allowed-users") ?? process.env.FEISHU_ALLOWED_USERS),
		allowedChats: splitList(optionString(parsed, "allowed-chats") ?? process.env.FEISHU_ALLOWED_CHATS),
		domain: optionString(parsed, "domain") ? channelDomain(parsed, "feishu") : undefined,
		requireMention: parsed.options["no-require-mention"] === true
			? false
			: parsed.options["require-mention"] === true ? true : undefined,
	};
}

function optionString(parsed: ParsedArgs, key: string): string | undefined {
	const value = parsed.options[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function splitList(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function channelDomain(parsed: ParsedArgs, fallback: "feishu" | "lark"): "feishu" | "lark" {
	const domain = optionString(parsed, "domain");
	if (!domain) return fallback;
	if (domain === "feishu" || domain === "lark") return domain;
	throw new Error("--domain must be feishu or lark");
}

async function askOne(prompt: string, secret = false): Promise<string> {
	const { createInterface } = await import("node:readline/promises");
	if (!secret) {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try { return (await rl.question(prompt)).trim(); } finally { rl.close(); }
	}
	const { Writable } = await import("node:stream");
	let muted = false;
	const output = new Writable({
		write(chunk, _encoding, callback) {
			if (!muted) process.stdout.write(chunk);
			callback();
		},
	});
	const rl = createInterface({ input: process.stdin, output, terminal: true });
	try {
		process.stdout.write(prompt);
		muted = true;
		const answer = await rl.question("");
		muted = false;
		process.stdout.write("\n");
		return answer.trim();
	} finally {
		rl.close();
	}
}

async function runProfileCommand(parsed: ParsedArgs): Promise<void> {
	const args = parsed.positionals.slice(1);
	const explicitConfig = parsed.configPath;
	const action = args[0] ?? "list";
	if (action === "list") {
		console.log((await listProfiles()).join("\n") || "No profiles configured.");
		return;
	}
	const name = args[1];
	if (!name) throw new Error(`profile ${action} requires a profile name`);
	if (action === "create") {
		const paths = await createProfile(name);
		console.log(`Created Agent '${name}' at ${paths.homePath}`);
		return;
	}
	if (action === "use") {
		await setActiveProfile(name);
		console.log(`BeeMax active Profile is now '${name}'.`);
		return;
	}
	if (action === "migrate") {
		const paths = await migrateProfile(name);
		console.log(`Migrated legacy Profile '${name}' to ${paths.homePath}. Source files were preserved.`);
		return;
	}
	if (action === "delete") {
		if (parsed.options.yes !== true) throw new Error("Profile deletion requires --yes; runtime data is preserved");
		const paths = await deleteProfile(name);
		console.log(`Deleted Agent configuration '${name}'. Runtime data was preserved at ${paths.dataPath}`);
		return;
	}
	if (!explicitConfig && !(await listProfiles()).includes(name)) throw new Error(`Agent profile ${name} does not exist`);
	const config = loadConfig(explicitConfig, name);
	if (action === "doctor") {
		if (!(await runDoctor(config))) process.exitCode = 1;
		return;
	}
	if (action === "start") {
		await runGateway(config);
		return;
	}
	if (action === "path" || action === "show") {
		const location = resolveProfileLocation(name, explicitConfig);
		console.log(JSON.stringify({
			profile: name,
			layout: location.isHome ? "home" : "legacy",
			home: location.homePath,
			config: location.configPath,
			env: location.envPath,
			soul: location.soulPath,
			memory: config.memory.dbPath,
			agentDir: config.paths.agentDir,
		}, null, 2));
		return;
	}
	throw new Error(`Unknown profile action: ${action}`);
}

async function runCodexAuth(config: ReturnType<typeof loadConfig>): Promise<void> {
	const { join } = await import("node:path");
	const { AuthStorage } = await import("@earendil-works/pi-coding-agent");
	const auth = AuthStorage.create(join(config.paths.agentDir, "auth.json"));
	console.log(`Authenticating Codex for profile ${config.profile}. Credentials stay in ${config.paths.agentDir}/auth.json`);
	await auth.login("openai-codex", {
		onAuth: (info) => {
			console.log(`\nOpen this URL in your browser:\n${info.url}`);
			if (info.instructions) console.log(info.instructions);
		},
		onDeviceCode: (info) => console.log(`Open ${info.verificationUri} and enter code ${info.userCode}`),
		onPrompt: async (prompt) => promptLine(`${prompt.message} `),
		onProgress: (message) => console.log(message),
		onManualCodeInput: async () => promptLine("Paste the final redirect URL here: "),
		onSelect: async (prompt) => {
			console.log(prompt.message);
			prompt.options.forEach((option, index) => console.log(`${index + 1}. ${option.label}`));
			const answer = Number(await promptLine("Select: ")) - 1;
			return prompt.options[answer]?.id;
		},
	});
	console.log(`Codex OAuth configured for profile ${config.profile}.`);
}

async function promptLine(message: string): Promise<string> {
	const { createInterface } = await import("node:readline/promises");
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try { return await rl.question(message); } finally { rl.close(); }
}

async function runChat(config: ReturnType<typeof loadConfig>): Promise<void> {
	const {
		buildAgentFactory,
		createSubagentTools,
		loadMcpConfig,
		McpManager,
		sessionIdForSource,
		SubagentManager,
	} = await import("@beemax/gateway");
	const { MemoryStore } = await import("@beemax/memory");
	const apiKey = config.model.apiKey ?? process.env[modelApiKeyEnv(config.model.provider)] ?? "";
	const memory = new MemoryStore(config.memory.dbPath);
	const mcp = new McpManager();
	await mcp.connectAll(loadMcpConfig(config.mcp.configPath));

	const source: import("@beemax/gateway").SessionSource = {
		platform: "cli",
		chatId: "local",
		chatType: "dm",
		userId: "local",
	};
	const mcpApproval = new Set(mcp.getApprovalTools());
	const readOnlyMcpTools = mcp.getTools().filter((tool) => !mcpApproval.has(tool.name));
	const createSubagentAgent = buildAgentFactory({
		provider: config.model.provider,
		model: config.model.model,
		baseUrl: config.model.baseUrl,
		cwd: config.paths.cwd,
		agentDir: config.paths.agentDir,
		getApiKey: () => apiKey,
		systemPrompt: buildSubagentSystemPrompt(config.agent.systemPrompt),
		memoryStore: memory,
		customTools: readOnlyMcpTools,
		tools: [
			"read", "grep", "find", "ls", "web_search", "web_extract", "memory_recall", "memory_list",
			...readOnlyMcpTools.map((tool) => tool.name),
		],
	});
	const subagents = config.subagents.enabled ? new SubagentManager({
		maxConcurrent: config.subagents.maxConcurrent,
		maxChildrenPerOwner: config.subagents.maxChildrenPerOwner,
		defaultTimeoutMs: config.subagents.timeoutMs,
		execute: (task, signal) => executeSubagentTask(createSubagentAgent, task, signal),
	}) : undefined;
	const createAgent = buildAgentFactory({
		provider: config.model.provider,
		model: config.model.model,
		baseUrl: config.model.baseUrl,
		cwd: config.paths.cwd,
		agentDir: config.paths.agentDir,
		getApiKey: () => apiKey,
		systemPrompt: config.agent.systemPrompt,
		memoryStore: memory,
		customTools: mcp.getTools(),
		approvalTools: mcp.getApprovalTools(),
		sessionTools: (sessionSource) => subagents ? createSubagentTools(subagents, sessionSource) : [],
	});
	const session = await createAgent(sessionIdForSource(source), source);

	session.subscribe((event) => {
		if (event.type === "message_update" && event.message.role === "assistant") {
			const text = (event.message.content as Array<{ type?: string; text?: string }>)
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("");
			if (text) process.stdout.write(`\r${text}`);
		}
	});

	try {
		process.stdout.write("beemax> ");
		for await (const line of consoleLines()) {
			const trimmed = line.trim();
			if (!trimmed) {
				process.stdout.write("beemax> ");
				continue;
			}
			if (trimmed === "/quit" || trimmed === "/exit") break;
			await session.prompt(trimmed);
			process.stdout.write("\nbeemax> ");
		}
	} finally {
		session.dispose();
		await subagents?.dispose();
		await mcp.close();
		memory.close();
	}
}

function modelApiKeyEnv(provider: string): string {
	const map: Record<string, string> = {
		anthropic: "ANTHROPIC_API_KEY",
		openai: "OPENAI_API_KEY",
		google: "GOOGLE_GENERATIVE_AI_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
	};
	return map[provider] ?? `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

async function* consoleLines(): AsyncGenerator<string> {
	const { createInterface } = await import("node:readline/promises");
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		for await (const line of rl) yield line;
	} finally {
		rl.close();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
