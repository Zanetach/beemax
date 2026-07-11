#!/usr/bin/env node
/**
 * beemax - BeeMax Agent CLI.
 *
 * Usage:
 *   beemax gateway    Start the Feishu gateway (long-running)
 *   beemax chat       Local interactive chat on stdout (no Feishu)
 *   beemax model      Show / set the configured model
 */

import { buildSubagentSystemPrompt, executeSubagentTask, mainAgentTools, readOnlyAgentTools, runGateway } from "./gateway.ts";
import { beemaxHome, beemaxRoot, loadConfig } from "./config.ts";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { backupSqliteDatabase, verifySqliteDatabase } from "@beemax/memory";
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
	syncBuiltinSkills,
	testFeishuCredentials,
} from "./profile-config.ts";
import { activeProfile, resolveProfileLocation } from "./profile-home.ts";
import { installMacLaunchAgent, installSystemdService, runServiceAction, type ServiceAction } from "./service-manager.ts";
import { runSetup, type SetupOptions } from "./setup.ts";
import { renderConfiguredModels, renderModelProviderChoices, resolveProviderSelection } from "./model-catalog.ts";
import { configuredApiKey } from "./provider-resolver.ts";
import { executionPortFor, executionSafeTools } from "./execution-composition.ts";
import { createProfileRuntime } from "./runtime-composition.ts";
import { createProfileControlHandler } from "./profile-control.ts";
import { LocalActivityPresenter, LocalReasoningPresenter, type DetailsDisplay, localChatTextDelta, localChatThinkingDelta, parseChatCommand, parseReasoningCommand } from "./local-chat-renderer.ts";
import { renderTerminalMarkdown, StreamingTerminalMarkdown } from "./terminal-markdown.ts";
import { inspectGateway, readGatewayLogs } from "./gateway-observability.ts";
import { createTaskAwareConversationContext, ensureBuiltinTasks, installedVersion } from "./runtime-facts.ts";
import { AgentRunError, SessionCatalog, type BeeMaxAgentRuntime } from "@beemax/core";
import type { SessionSource, ToolApprovalDecision, ToolApprovalRequest } from "@beemax/gateway";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2));
	applyRuntimePaths(parsed);
	const cmd = parsed.options.help === true ? "help" : parsed.positionals[0] ?? "help";
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
				await installGatewayService(gatewayProfile(parsed), parsed.options.system === true ? "system" : "user");
				console.log(`BeeMax Gateway service installed for Profile '${gatewayProfile(parsed)}'.`);
			} else if (parsed.positionals[1] === "list") {
				console.log((await listProfiles()).map((name) => `${name}  beemax@${name}.service`).join("\n") || "No Agent Profiles configured.");
			} else if (["start", "stop", "restart", "status", "logs"].includes(parsed.positionals[1] ?? "")) {
				const profiles = parsed.options.all === true ? await listProfiles() : [gatewayProfile(parsed)];
				for (const name of profiles) runServiceAction(parsed.positionals[1] as ServiceAction, name, undefined, process.platform, parsed.options.system === true ? "system" : "user");
			} else if (parsed.positionals[1] === "health") {
				if (!(await runDoctor(loadConfig(parsed.configPath, gatewayProfile(parsed)), { json: parsed.options.json === true }))) process.exitCode = 1;
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
			if (!(await runDoctor(getConfig(), { json: parsed.options.json === true }))) process.exitCode = 1;
			break;
		case "update":
			await runUpdate(parsed);
			break;
		case "profile":
			await runProfileCommand(parsed);
			break;
		case "skills":
			await runSkillsCommand(parsed);
			break;
		case "mcp":
			await runMcpCommand(parsed, getConfig());
			break;
		case "memory":
			await runMemoryCommand(parsed, getConfig());
			break;
		case "task":
			await runTaskCommand(parsed, getConfig());
			break;
		case "auth":
			if (parsed.positionals[1] !== "codex") throw new Error("Usage: beemax auth codex --profile <name>");
			await runCodexAuth(getConfig());
			break;
		case "service":
			if (parsed.positionals[1] !== "install") throw new Error("Usage: beemax service install");
			await installGatewayService(serviceProfile(parsed), parsed.options.system === true ? "system" : "user");
			console.log("BeeMax Gateway service installed. Start an agent with: beemax start <name>");
			break;
		case "start":
		case "stop":
		case "restart":
			runServiceAction(cmd, serviceProfile(parsed), undefined, process.platform, parsed.options.system === true ? "system" : "user");
			break;
		case "status":
			if (parsed.options.deep === true) { runGatewayStatus(getConfig(), parsed.options.system === true ? "system" : "user"); break; }
			runServiceAction(cmd, serviceProfile(parsed), undefined, process.platform, parsed.options.system === true ? "system" : "user");
			break;
		case "logs":
			if (parsed.options.follow === true) runServiceAction(cmd, serviceProfile(parsed), undefined, process.platform, parsed.options.system === true ? "system" : "user");
			else console.log(readProfileLogs(serviceProfile(parsed), getConfig().paths.agentDir, Number(optionString(parsed, "tail")) || 200, parsed.options.system === true ? "system" : "user"));
			break;
		case "help":
		default:
			console.log(`beemax - persistent personal agent (Pi + Feishu)

Commands:
  setup      Configure one Agent Profile, model, identity, Skills, and local chat
  init       Create the first Agent profile
  agent      create | list | delete
  channel    add | list | remove | test
  gateway    run | setup | install | start | stop | restart | status | logs | list | health
  chat       Local interactive chat for one profile
  model      show | set <provider> <model>
  doctor     Check profile readiness
  update     Update the installed BeeMax release, preserving all Profiles
  profile    create | list | show | path | use | migrate | backup | delete
  skills     list | sync (prepackaged Profile Skills)
  mcp        status (probe configured MCP servers)
  memory     status | list | candidates | promote <id> | reject <id>
  task       list | set <id> <open|in_progress|done|cancelled> --title <title> [--evidence <ref>]
  auth       codex (stores OAuth only inside the selected profile)
  service    install (Linux systemd)
  start      Start a profile systemd service
  stop       Stop a profile systemd service
  restart    Restart a profile systemd service
  status     Show profile service status (use --deep for runtime facts)
  logs       Read profile Gateway logs (use --tail <n>)

Options:
  --profile <name>         Select an isolated Profile (defaults to the active Profile)
  --config <path>          Use an explicit YAML config file
  --home <path>            Override BEEMAX_HOME for this invocation
  --root <path>            Override the BeeMax installation root for this invocation
  --with-feishu            Include Feishu/Lark configuration in the initial setup wizard
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

const BOOLEAN_OPTIONS = new Set(["yes", "require-mention", "no-require-mention", "non-interactive", "system", "all", "open", "help", "deep", "follow"]);

function runGatewayStatus(config: ReturnType<typeof loadConfig>, scope: "user" | "system"): void {
	const snapshot = inspectGateway(config.profile, config.paths.agentDir, scope, installedVersion());
	console.log(`Profile: ${config.profile}`);
	console.log(`Service: ${snapshot.installation}`);
	console.log(`Service lifecycle: ${snapshot.service}`);
	console.log(`Gateway: ${snapshot.lifecycle}`);
	console.log(`Health: ${snapshot.health}`);
	console.log(`Runtime state: ${snapshot.state}`);
	console.log(`Logs: ${snapshot.logs}`);
	console.log(`Version: cli=${snapshot.cliVersion}; runtime=${snapshot.version}; matches=${snapshot.versionMatches ?? "unverified"}`);
	if (snapshot.pid) console.log(`PID: ${snapshot.pid}`);
	if (snapshot.startedAt) console.log(`Started: ${snapshot.startedAt}`);
	if (snapshot.lastError) console.log(`Last issue: ${snapshot.lastError}`);
	if (snapshot.logs === "absent") console.log(`Next: beemax start ${config.profile}`);
}

function readProfileLogs(profile: string, agentDir: string, tail: number, scope: "user" | "system"): string {
	if (process.platform !== "linux") return readGatewayLogs(agentDir, tail);
	const result = spawnSync("journalctl", [...(scope === "user" ? ["--user"] : []), "-u", `beemax@${profile}.service`, "-n", String(tail), "--no-pager"], { encoding: "utf8" });
	return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : readGatewayLogs(agentDir, tail);
}

async function runInit(parsed: ParsedArgs): Promise<void> {
	const profile = parsed.profile ?? parsed.positionals[1] ?? "personal";
	const paths = await createProfile(profile);
	console.log(`Created BeeMax Agent '${profile}' at ${paths.configPath}`);
	console.log(`Next: beemax model set anthropic claude-sonnet-4-5 --profile ${profile}`);
	console.log(`Then: beemax channel add feishu --profile ${profile}`);
}

async function installGatewayService(profile: string, scope: "user" | "system"): Promise<void> {
	if (process.platform === "darwin") {
		if (scope === "system") throw new Error("macOS system-wide Gateway services are not supported; use the user LaunchAgent");
		const plist = await installMacLaunchAgent(profile, beemaxRoot(), beemaxHome());
		console.log(`BeeMax LaunchAgent installed: ${plist}`);
		return;
	}
	await installSystemdService(beemaxRoot(), scope);
}

async function runUpdate(parsed: ParsedArgs): Promise<void> {
	const root = beemaxRoot();
	const installDir = resolve(process.env.BEEMAX_INSTALL_DIR?.trim() || join(beemaxHome(), "app"));
	if (resolve(root) !== installDir) {
		throw new Error("beemax update is available for release installations only; update a source checkout with Git instead");
	}
	const installer = join(root, "scripts", "bootstrap-install.sh");
	if (!existsSync(installer)) throw new Error("BeeMax installer is missing from this release; reinstall using the official installer");
	const version = optionString(parsed, "version") ?? "latest";
	const result = spawnSync("bash", [installer, "--version", version], {
		stdio: "inherit",
		env: { ...process.env, BEEMAX_INSTALL_DIR: installDir },
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`BeeMax update failed with exit code ${result.status ?? "unknown"}`);
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
	if (action === "list") {
		console.log(renderModelProviderChoices());
		return;
	}
	if (action !== "set") throw new Error("Usage: beemax model [show | list | set <provider> <model>] --profile <name>");
	if (parsed.options["api-key"] !== undefined) throw new Error("Do not pass model secrets in argv; set BEEMAX_API_KEY or use the interactive prompt");
	const provider = parsed.positionals[2] ? resolveProviderSelection(parsed.positionals[2]) : undefined;
	const model = parsed.positionals[3];
	if (!provider || !model) throw new Error("model set requires a provider and model ID");
	let apiKey = process.env.BEEMAX_API_KEY;
	if (!apiKey && parsed.options["non-interactive"] !== true && process.stdin.isTTY) {
		apiKey = await askOne("Model API Key (leave empty to configure later): ", true);
	}
	await configureModel(profile, { provider, model, apiKey, baseUrl: optionString(parsed, "base-url"), customProtocol: customProtocolOption(parsed) });
	console.log(`Configured ${provider}/${model} for Agent '${profile}'.`);
}

async function runChannelCommand(parsed: ParsedArgs): Promise<void> {
	const action = parsed.positionals[1] ?? "list";
	const profile = selectedProfile(parsed);
	if (action === "qr" || action === "create") {
		const url = "https://open.feishu.cn/app";
		console.log(`Open Feishu Developer Console to create/configure a self-built app:\n${url}`);
		console.log("After scanning/signing in, copy App ID and App Secret, then run: beemax setup --profile " + profile);
		if (parsed.options.open === true) {
			const { spawn } = await import("node:child_process");
			const [command, args] = process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
			const child = spawn(command, args, { detached: true, stdio: "ignore" });
			child.once("error", (error) => console.warn(`Could not open browser automatically: ${error.message}`));
			child.unref();
		}
		return;
	}
	if (action === "list") {
		const config = loadConfig(parsed.configPath, profile);
		const state = config.gateway.feishu.appId && config.gateway.feishu.appSecret ? "configured" : "not configured";
		console.log(`feishu  ${state}  mode=${config.gateway.feishu.connectionMode}  domain=${config.gateway.feishu.domain}  allowed_users=${config.gateway.feishu.allowedUsers.length}`);
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
		console.log(await testFeishuCredentials(config.gateway.feishu));
		return;
	}
	if (action !== "add" || parsed.positionals[2] !== "feishu") {
		throw new Error("Usage: beemax channel add feishu | list | remove | test");
	}
	const current = loadConfig(parsed.configPath, profile);
	const currentFeishu = current.gateway.feishu;
	const nonInteractive = parsed.options["non-interactive"] === true || !process.stdin.isTTY;
	let appId = optionString(parsed, "app-id") ?? process.env.FEISHU_APP_ID ?? currentFeishu.appId;
	let appSecret = process.env.FEISHU_APP_SECRET ?? currentFeishu.appSecret;
	let allowedUsers = splitList(optionString(parsed, "allowed-users") ?? process.env.FEISHU_ALLOWED_USERS)
		?? currentFeishu.allowedUsers;
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
		allowedChats: splitList(optionString(parsed, "allowed-chats")) ?? currentFeishu.allowedChats,
		domain: channelDomain(parsed, currentFeishu.domain),
		requireMention: parsed.options["no-require-mention"] === true
			? false
			: parsed.options["require-mention"] === true ? true : currentFeishu.requireMention,
		connectionMode: channelConnectionMode(parsed, currentFeishu.connectionMode),
		webhookHost: optionString(parsed, "webhook-host") ?? currentFeishu.webhookHost,
		webhookPort: webhookPort(parsed, currentFeishu.webhookPort),
		webhookPath: optionString(parsed, "webhook-path") ?? currentFeishu.webhookPath,
		webhookVerificationToken: process.env.FEISHU_WEBHOOK_VERIFICATION_TOKEN ?? currentFeishu.webhookVerificationToken,
		webhookEncryptKey: process.env.FEISHU_WEBHOOK_ENCRYPT_KEY ?? currentFeishu.webhookEncryptKey,
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
		configureGateway: parsed.options["with-feishu"] === true,
		nonInteractive: parsed.options["non-interactive"] === true || !process.stdin.isTTY,
		provider: optionString(parsed, "provider") ?? process.env.BEEMAX_PROVIDER,
		model: optionString(parsed, "model") ?? process.env.BEEMAX_MODEL,
		apiKey: process.env.BEEMAX_API_KEY,
		baseUrl: optionString(parsed, "base-url"),
		customProtocol: customProtocolOption(parsed),
		soul: optionString(parsed, "soul") ?? process.env.BEEMAX_SOUL,
		appId: optionString(parsed, "app-id") ?? process.env.FEISHU_APP_ID,
		appSecret: process.env.FEISHU_APP_SECRET,
		allowedUsers: splitList(optionString(parsed, "allowed-users") ?? process.env.FEISHU_ALLOWED_USERS),
		allowedChats: splitList(optionString(parsed, "allowed-chats") ?? process.env.FEISHU_ALLOWED_CHATS),
		domain: optionString(parsed, "domain") ? channelDomain(parsed, "feishu") : undefined,
		connectionMode: channelConnectionMode(parsed, undefined),
		webhookHost: optionString(parsed, "webhook-host"),
		webhookPort: webhookPort(parsed, undefined),
		webhookPath: optionString(parsed, "webhook-path"),
		webhookVerificationToken: process.env.FEISHU_WEBHOOK_VERIFICATION_TOKEN,
		webhookEncryptKey: process.env.FEISHU_WEBHOOK_ENCRYPT_KEY,
		requireMention: parsed.options["no-require-mention"] === true
			? false
			: parsed.options["require-mention"] === true ? true : undefined,
	};
}

function customProtocolOption(parsed: ParsedArgs): "openai-completions" | "openai-responses" | "anthropic-messages" | undefined {
	const value = optionString(parsed, "protocol");
	if (!value) return undefined;
	if (value === "openai-completions" || value === "openai-responses" || value === "anthropic-messages") return value;
	throw new Error("--protocol must be openai-completions, openai-responses, or anthropic-messages");
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

function channelConnectionMode(parsed: ParsedArgs, fallback: "websocket" | "webhook" | undefined): "websocket" | "webhook" | undefined {
	const mode = optionString(parsed, "connection-mode");
	if (mode === undefined) return fallback;
	if (mode !== "websocket" && mode !== "webhook") throw new Error("--connection-mode must be websocket or webhook");
	return mode;
}

function webhookPort(parsed: ParsedArgs, fallback: number | undefined): number | undefined {
	const value = optionString(parsed, "webhook-port");
	if (value === undefined) return fallback;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--webhook-port must be an integer between 1 and 65535");
	return port;
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
	if (action === "backup") {
		const destination = args[2];
		if (!destination) throw new Error("profile backup requires a destination directory");
		const { access, cp, mkdir, rm, stat } = await import("node:fs/promises");
		const source = resolveProfileLocation(name, explicitConfig).homePath;
		const target = join(destination, name);
		const sourceDb = loadConfig(explicitConfig, name).memory.dbPath;
		const dbRelativePath = relative(source, sourceDb);
		const targetDb = dbRelativePath && !dbRelativePath.startsWith("..") && !isAbsolute(dbRelativePath)
			? join(target, dbRelativePath)
			: join(target, "external-data", "memory.db");
		await mkdir(destination, { recursive: true });
		try {
			await access(target);
			throw new Error(`Backup destination already exists: ${target}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		try {
			await cp(source, target, {
				recursive: true,
				force: false,
				errorOnExist: true,
				filter: (path) => path !== sourceDb && path !== `${sourceDb}-wal` && path !== `${sourceDb}-shm`,
			});
			await stat(sourceDb);
			await mkdir(dirname(targetDb), { recursive: true });
			await backupSqliteDatabase(sourceDb, targetDb);
			verifySqliteDatabase(targetDb);
		} catch (error) {
			await rm(target, { recursive: true, force: true });
			throw new Error(`Profile backup database snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		console.log(`Backed up Agent '${name}' to ${target} (SQLite snapshot verified).`);
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
		if (!(await runDoctor(config, { json: parsed.options.json === true }))) process.exitCode = 1;
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

async function runSkillsCommand(parsed: ParsedArgs): Promise<void> {
	const action = parsed.positionals[1] ?? "list";
	const profile = selectedProfile(parsed);
	const { readdir, readFile } = await import("node:fs/promises");
	const paths = resolveProfileLocation(profile, parsed.configPath);
	if (action === "sync") {
		await syncBuiltinSkills(profile);
		console.log(`Synced bundled Skills into Agent '${profile}' without replacing existing skills.`);
		return;
	}
	if (action !== "list") throw new Error("Usage: beemax skills [list | sync] --profile <name>");
	const skills: Array<{ name: string; description: string; sha256: string }> = [];
	try {
		for (const entry of await readdir(join(paths.homePath, "skills"), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const content = await readFile(join(paths.homePath, "skills", entry.name, "SKILL.md"), "utf8").catch(() => "");
			const description = content.match(/^description:\s*(.+)$/m)?.[1]?.replaceAll('"', "").trim();
			if (description) skills.push({ name: entry.name, description, sha256: createHash("sha256").update(content).digest("hex") });
		}
	} catch { /* no Skills directory yet */ }
	if (parsed.options.json === true) { console.log(JSON.stringify({ profile, skills: skills.sort((a, b) => a.name.localeCompare(b.name)) })); return; }
	console.log(skills.sort((a, b) => a.name.localeCompare(b.name)).map((skill) => `${skill.name}  sha256=${skill.sha256.slice(0, 12)}  ${skill.description}`).join("\n") || "No Profile Skills installed. Run: beemax skills sync --profile " + profile);
}

async function runMcpCommand(parsed: ParsedArgs, config: ReturnType<typeof loadConfig>): Promise<void> {
	if ((parsed.positionals[1] ?? "status") !== "status") throw new Error("Usage: beemax mcp status --profile <name>");
	const { loadMcpConfig, McpManager } = await import("@beemax/mcp-capability");
	const mcp = new McpManager();
	try {
		const statuses = await mcp.connectAll(loadMcpConfig(config.mcp.configPath));
		if (parsed.options.json === true) {
			console.log(JSON.stringify({ profile: config.profile, servers: statuses }));
			if (statuses.some((status) => !status.connected)) process.exitCode = 1;
			return;
		}
		if (statuses.length === 0) {
			console.log(`No MCP servers configured (${config.mcp.configPath}).`);
			return;
		}
		for (const status of statuses) {
			console.log(`${status.connected ? "PASS" : "FAIL"}  ${status.name}  ${status.connected ? `${status.tools.length} tool(s), ${status.resources} resource(s), ${status.prompts} prompt(s)` : status.error ?? "unavailable"}`);
		}
		if (statuses.some((status) => !status.connected)) process.exitCode = 1;
	} finally {
		await mcp.close();
	}
}

async function runMemoryCommand(parsed: ParsedArgs, config: ReturnType<typeof loadConfig>): Promise<void> {
	const action = parsed.positionals[1] ?? "status";
	const { MemoryStore } = await import("@beemax/memory");
	const store = new MemoryStore(config.memory.dbPath);
	try {
		if (action === "status") {
			const stats = store.stats();
			console.log(`Profile ${config.profile}: curated=${stats.curated} pending=${stats.pending} promoted=${stats.promoted} rejected=${stats.rejected}`);
			return;
		}
		if (action === "list" || action === "candidates") {
			const records = action === "list" ? store.list({ limit: 50 }) : store.listCandidates({ limit: 50 });
			console.log(records.map((record) => `${record.id}  [${record.role}] ${record.content}`).join("\n") || `No ${action === "list" ? "curated memories" : "pending candidates"}.`);
			return;
		}
		const id = parsed.positionals[2];
		if ((action !== "promote" && action !== "reject") || !id) throw new Error("Usage: beemax memory [status | list | candidates | promote <id> | reject <id>] --profile <name>");
		if (parsed.options.yes !== true) throw new Error(`memory ${action} requires --yes`);
		const changed = action === "promote" ? store.promoteCandidate(id) : store.rejectCandidate(id);
		if (!changed) throw new Error(`Pending memory candidate ${id} was not found`);
		console.log(`${action === "promote" ? "Promoted" : "Rejected"} memory candidate ${id}.`);
	} finally {
		store.close();
	}
}

async function runTaskCommand(parsed: ParsedArgs, config: ReturnType<typeof loadConfig>): Promise<void> {
	const action = parsed.positionals[1] ?? "list";
	const { MemoryStore } = await import("@beemax/memory");
	const store = new MemoryStore(config.memory.dbPath);
	try {
		ensureBuiltinTasks(store);
		if (action === "list") {
			const tasks = store.listTasks();
			console.log(tasks.map((task) => `${task.id}  [${task.status}]  ${task.title}${task.evidence ? `  (${task.evidence})` : ""}${task.completedAt ? `  completed_at=${new Date(task.completedAt).toISOString()}` : ""}`).join("\n") || "No task records.");
			return;
		}
		const [id, status] = [parsed.positionals[2], parsed.positionals[3]];
		if (action !== "set" || !id || !isTaskStatus(status)) throw new Error("Usage: beemax task set <id> <open|in_progress|done|cancelled> --title <title> [--evidence <ref>] --profile <name>");
		const title = optionString(parsed, "title");
		if (!title) throw new Error("beemax task set requires --title <title>");
		store.upsertTask({ id, title, status, evidence: optionString(parsed, "evidence") });
		console.log(`Updated task '${id}' to ${status}.`);
	} finally {
		store.close();
	}
}

function isTaskStatus(value: string | undefined): value is "open" | "in_progress" | "done" | "cancelled" {
	return value === "open" || value === "in_progress" || value === "done" || value === "cancelled";
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
		createSubagentTools,
		SubagentManager,
	} = await import("@beemax/gateway");
	const { loadMcpConfig, McpManager } = await import("@beemax/mcp-capability");
	const { buildAgentFactory } = await import("./agent-factory.ts");
	const { MemoryStore } = await import("@beemax/memory");
	const apiKey = configuredApiKey(config.model.provider, config.model.apiKey) ?? "";
	const localApproval = new LocalApprovalBroker();
	const memory = new MemoryStore(config.memory.dbPath);
	const mcp = new McpManager();
	await mcp.connectAll(loadMcpConfig(config.mcp.configPath));

	let source: import("@beemax/gateway").SessionSource = {
		platform: "cli",
		chatId: "local",
		chatType: "dm",
		userId: "local",
	};
	const mcpApproval = new Set(mcp.getApprovalTools());
	const readOnlyMcpTools = mcp.getTools().filter((tool) => !mcpApproval.has(tool.name));
	const createSubagentAgent = buildAgentFactory({
		provider: () => config.model.provider,
		model: () => config.model.model,
		baseUrl: () => config.model.baseUrl,
		customProtocol: () => config.model.customProtocol,
		cwd: config.paths.cwd,
		agentDir: config.paths.agentDir,
		getApiKey: (provider: string) => config.model.apiKeys[provider] ?? (provider === config.model.provider ? apiKey : undefined),
		systemPrompt: buildSubagentSystemPrompt(config.agent.systemPrompt),
		memoryStore: memory,
		executionPortForSource: executionPortFor(config),
		customTools: readOnlyMcpTools,
		tools: executionSafeTools(config, readOnlyAgentTools(readOnlyMcpTools.map((tool) => tool.name))),
	});
	const subagents = config.subagents.enabled ? new SubagentManager({
		maxConcurrent: config.subagents.maxConcurrent,
		maxChildrenPerOwner: config.subagents.maxChildrenPerOwner,
		defaultTimeoutMs: config.subagents.timeoutMs,
		execute: (task, signal) => executeSubagentTask(createSubagentAgent, task, signal),
	}) : undefined;
	const createAgent = buildAgentFactory({
		provider: () => config.model.provider,
		model: () => config.model.model,
		baseUrl: () => config.model.baseUrl,
		customProtocol: () => config.model.customProtocol,
		cwd: config.paths.cwd,
		agentDir: config.paths.agentDir,
		getApiKey: (provider: string) => config.model.apiKeys[provider] ?? (provider === config.model.provider ? apiKey : undefined),
		systemPrompt: config.agent.systemPrompt,
		memoryStore: memory,
		executionPortForSource: executionPortFor(config),
		customTools: mcp.getTools(),
		tools: executionSafeTools(config, mainAgentTools(config.agent.toolset, mcp.getTools().map((tool) => tool.name))),
		approvalTools: mcp.getApprovalTools(),
		authorizeTool: (request, signal) => localApproval.authorize(request, signal),
		sessionTools: (sessionSource) => subagents ? createSubagentTools(subagents, sessionSource) : [],
	});
	let runtime: BeeMaxAgentRuntime<SessionSource>;
	runtime = createProfileRuntime(
		{ maxSessions: config.agent.maxSessions, sessionIdleMs: config.agent.sessionIdleMs },
		{
			createAgent,
			sessionCatalog: SessionCatalog.forAgentDir<SessionSource>(config.paths.agentDir),
			context: createTaskAwareConversationContext(memory, { runtimeSnapshot: () => ({ model: `${config.model.provider}/${config.model.model}`, profile: config.profile }) }),
			controlHandler: (input) => createProfileControlHandler(runtime, config)(input),
		},
	);

	try {
		let reasoningDisplay = config.agent.reasoningDisplay;
		let detailsDisplay: DetailsDisplay = "expanded";
		const reasoningDisplayOverridden = Boolean(process.env.BEEMAX_REASONING_DISPLAY?.trim());
		const applySessionPreferences = async () => {
			const preferences = await runtime.sessionPreferences(source);
			reasoningDisplay = reasoningDisplayOverridden ? config.agent.reasoningDisplay : preferences.reasoningDisplay ?? config.agent.reasoningDisplay;
			detailsDisplay = preferences.detailsDisplay ?? "expanded";
		};
		await applySessionPreferences();
		let active: Promise<void> | undefined;
		let retryText: string | undefined;
		let controlInProgress = false;
		let lastDurationMs: number | undefined;
		let closed = false;
		const { createInterface } = await import("node:readline/promises");
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		const prompt = () => `beemax [${config.model.provider}/${config.model.model}]> `;
		const writePrompt = () => { if (!closed) process.stdout.write(prompt()); };
		const usage = async () => {
			const current = await runtime.usage(source);
			if (!current) return "Usage: no live session. Resume or send a message to load one.";
			const context = current.contextWindow === null ? "unknown" : current.contextTokens === null ? `?/${current.contextWindow}` : `${current.contextTokens}/${current.contextWindow} (${Math.round(current.contextPercent ?? 0)}%)`;
			return `Usage: input=${current.inputTokens}; output=${current.outputTokens}; cache-read=${current.cacheReadTokens}; cache-write=${current.cacheWriteTokens}; context=${context}${lastDurationMs === undefined ? "" : `; last-turn=${Math.round(lastDurationMs / 1000)}s`}`;
		};
		const status = async () => `Profile: ${config.profile}\nModel: ${config.model.provider}/${config.model.model}\nSession: ${source.threadId ?? "default"}\nRun: ${runtime.isBusy() ? "running" : "idle"}\nReasoning: ${reasoningDisplay}\nDetails: ${detailsDisplay}\nToolset: ${config.agent.toolset}\n${await usage()}`;
		const toolsStatus = () => {
			const tools = mcp.getTools().map((tool) => `${tool.name}${mcpApproval.has(tool.name) ? " (approval required)" : ""}`);
			return `Toolset: ${config.agent.toolset}\nMCP: ${tools.length ? tools.join(", ") : "no MCP tools connected"}`;
		};
		const sessions = async () => {
			const live = new Map(runtime.listSessions(source).map((candidate) => [candidate.threadId ?? "default", candidate]));
			const saved = await runtime.listSavedSessions(source);
			return saved.length
				? saved.map((record) => {
					const id = record.threadId ?? "default";
					const current = live.get(id);
					return `${id}  ${current?.busy ? "running" : current ? "live" : "saved"}  ${new Date(current?.lastActiveAt ?? record.lastUsedAt).toLocaleString()}`;
				}).join("\n")
				: "No saved sessions. Start a conversation to create one.";
		};
		const history = async (limit?: number) => {
			const entries = await runtime.history(source, limit);
			return entries.length
				? entries.map((entry) => `[${entry.role}] ${entry.text.replaceAll("\n", " ")}`).join("\n")
				: "No live message history. Resume or send a message to load this session.";
		};
		const stop = async () => {
			const stopped = await runtime.cancel(source);
			const cancelled = subagents?.cancelOwner(source) ?? 0;
			process.stdout.write(`\n${stopped ? "Stopped the active Agent turn" : "No active Agent turn"}${cancelled ? `; cancelled ${cancelled} Sub-Agent task(s)` : ""}.\n`);
		};
		const runTurn = async (text: string, turnSource: import("@beemax/gateway").SessionSource) => {
			let streamed = "";
			const reasoning = new LocalReasoningPresenter(reasoningDisplay, process.stdout.isTTY === true);
			const activity = new LocalActivityPresenter(detailsDisplay, process.stdout.isTTY === true);
			let answerStreamStarted = false;
			const terminal = new StreamingTerminalMarkdown();
			const result = await runtime.run({ source: turnSource, text, timeoutMs: 10 * 60_000, mode: "interactive" }, (event) => {
				process.stdout.write(activity.event(event));
				const thinkingDelta = localChatThinkingDelta(event);
				if (thinkingDelta) process.stdout.write(reasoning.thinking(thinkingDelta));
				const delta = localChatTextDelta(event);
				if (delta) {
					if (!answerStreamStarted) process.stdout.write(reasoning.beforeAnswer());
					answerStreamStarted = true;
					streamed += delta;
					terminal.write(delta, (output) => process.stdout.write(output));
				}
			});
			if (streamed) terminal.finish((output) => process.stdout.write(output));
			else {
				process.stdout.write(reasoning.beforeAnswer());
				process.stdout.write(renderTerminalMarkdown(result.answer));
			}
			lastDurationMs = result.durationMs;
			process.stdout.write("\n");
		};
		const handleLine = async (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) { writePrompt(); return; }
			const command = parseChatCommand(trimmed);
			if (active) {
				if (await localApproval.handle(source, trimmed)) return;
				if (command?.kind === "stop") { await stop(); return; }
				if (command?.kind === "status") { process.stdout.write(`\n${await status()}\n`); return; }
				process.stdout.write("\nAgent is running. Use /stop (or Ctrl+C) before starting another turn.\n");
				return;
			}
			if (controlInProgress) {
				process.stdout.write("\nA control command is still being processed. Please wait.\n");
				return;
			}
			if (trimmed === "/quit" || trimmed === "/exit") { closed = true; rl.close(); return; }
			if (command?.kind === "help") {
				process.stdout.write("Commands: /help /status /new /reset /sessions /history [n] /resume <session-id> /usage /stop /compact /model /models /think [level] /tools /retry /reasoning /details [hidden|collapsed|expanded] /quit\n");
				writePrompt();
				return;
			}
			if (command?.kind === "status") { process.stdout.write(`${await status()}\n`); writePrompt(); return; }
			if (command?.kind === "usage") { process.stdout.write(`${await usage()}\n`); writePrompt(); return; }
			if (command?.kind === "new") {
				const threadId = `local-${crypto.randomUUID()}`;
				source = { ...source, threadId };
				await runtime.open(source);
				await applySessionPreferences();
				lastDurationMs = undefined;
				process.stdout.write(`Started new session: ${threadId}\n`);
				writePrompt();
				return;
			}
			if (command?.kind === "reset") {
				const reset = runtime.reset(source);
				const threadId = `local-${crypto.randomUUID()}`;
				source = { ...source, threadId };
				await runtime.open(source);
				await applySessionPreferences();
				lastDurationMs = undefined;
				process.stdout.write(`${reset ? "Discarded the live session and" : "Started"} a fresh session: ${threadId}\n`);
				writePrompt();
				return;
			}
			if (command?.kind === "sessions") { process.stdout.write(`${await sessions()}\n`); writePrompt(); return; }
			if (command?.kind === "models") { process.stdout.write(`${renderConfiguredModels(config)}\n`); writePrompt(); return; }
			if (command?.kind === "tools") { process.stdout.write(`${toolsStatus()}\n`); writePrompt(); return; }
			if (command?.kind === "retry") {
				if (!retryText) process.stdout.write("No recoverable failed turn to retry.\n");
				else { const text = retryText; retryText = undefined; active = runTurn(text, source); try { await active; } catch (error) { process.stdout.write(`Agent run failed: ${error instanceof Error ? error.message : String(error)}\n`); } finally { active = undefined; } }
				writePrompt(); return;
			}
			if (command?.kind === "history") { process.stdout.write(`${await history(command.limit)}\n`); writePrompt(); return; }
			if (command?.kind === "resume") {
				const resumeSource = command.sessionId === "default" ? { ...source, threadId: undefined } : { ...source, threadId: command.sessionId };
				if (!await runtime.hasSavedSession(resumeSource)) {
					process.stdout.write(`Unknown session '${command.sessionId}'. Run /sessions to choose a saved session.\n`);
					writePrompt();
					return;
				}
				source = resumeSource;
				lastDurationMs = undefined;
				await runtime.open(source);
				await applySessionPreferences();
				process.stdout.write(`Restored session: ${source.threadId ?? "default"}. Use /history to inspect it or send a message to continue.\n`);
				writePrompt();
				return;
			}
			if (command?.kind === "stop") { await stop(); writePrompt(); return; }
			if (command?.kind === "compact") {
				const compacted = await runtime.compact(source);
				process.stdout.write(`${compacted ? "Context compacted." : "No idle session is available to compact."}\n`);
				writePrompt();
				return;
			}
			if (command?.kind === "think") {
				const current = await runtime.modelStatus(source);
				if (!current) process.stdout.write("No live session. Resume or send a message first.\n");
				else if (!command.level) process.stdout.write(`Thinking: ${current.thinkingLevel}. Supported: ${current.supportedThinkingLevels.join(", ")}.\n`);
				else {
					const updated = await runtime.setThinkingLevel(source, command.level);
					if (!updated) process.stdout.write("The Agent is busy. Try again after the current turn.\n");
					else process.stdout.write(`Thinking set to ${updated.thinkingLevel}. Supported: ${updated.supportedThinkingLevels.join(", ")}.\n`);
				}
				writePrompt();
				return;
			}
			if (command?.kind === "details") {
				if (command.mode === "status") process.stdout.write(`Details: ${detailsDisplay}. Use /details hidden|collapsed|expanded.\n`);
				else { detailsDisplay = command.mode; await runtime.updateSessionPreferences(source, { detailsDisplay }); process.stdout.write(`Details display set to ${detailsDisplay}.\n`); }
				writePrompt();
				return;
			}
			const reasoningCommand = parseReasoningCommand(trimmed);
			if (reasoningCommand) {
				if (reasoningCommand.kind === "set") {
					reasoningDisplay = reasoningCommand.display;
					await runtime.updateSessionPreferences(source, { reasoningDisplay });
					const warning = reasoningDisplay === "raw" ? " Raw reasoning may contain sensitive intermediate content." : "";
					process.stdout.write(`Reasoning display set to ${reasoningDisplay}.${warning}\n`);
				} else if (reasoningCommand.kind === "status") process.stdout.write(`Reasoning display: ${reasoningDisplay}. Use /reasoning off|summary|raw.\n`);
				else process.stdout.write("Usage: /reasoning off|summary|raw.\n");
				writePrompt();
				return;
			}
			if (trimmed.toLowerCase().startsWith("/model")) {
				controlInProgress = true;
				try {
					const control = await runtime.handleControl({ source, text: trimmed });
					if (control?.handled) { process.stdout.write(`${control.message}\n`); writePrompt(); return; }
				} finally { controlInProgress = false; }
			}
			const turnSource = source;
			active = runTurn(trimmed, turnSource);
			try { await active; }
			catch (error) {
				if (error instanceof AgentRunError && error.recoverable) {
					const fallback = config.models.find((choice) => `${choice.provider}/${choice.model}` !== `${config.model.provider}/${config.model.model}`);
					if (fallback) {
						const switched = await runtime.handleControl({ source, text: `/model ${fallback.provider}/${fallback.model}` });
						if (switched?.handled && switched.message.startsWith("Switched this conversation")) { retryText = trimmed; process.stdout.write(`Agent run failed: ${error.message}\nSwitched to fallback ${fallback.provider}/${fallback.model}. Use /retry to retry explicitly.\n`); return; }
					}
				}
				process.stdout.write(`Agent run failed: ${error instanceof Error ? error.message : String(error)}\n`);
			}
			finally { active = undefined; writePrompt(); }
		};
		writePrompt();
		rl.on("line", (line) => { void handleLine(line); });
		rl.on("SIGINT", () => { if (active) void stop(); else rl.close(); });
		await new Promise<void>((resolve) => rl.once("close", resolve));
	} finally {
		runtime.dispose();
		await subagents?.dispose();
		await mcp.close();
		memory.close();
	}
}

/** Terminal equivalent of the Gateway's text approval broker. */
class LocalApprovalBroker {
	private pending?: { sourceKey: string; toolName: string; resolve: (decision: ToolApprovalDecision) => void; abortCleanup?: () => void };
	private readonly grants = new Set<string>();

	async authorize(request: ToolApprovalRequest, signal?: AbortSignal): Promise<ToolApprovalDecision> {
		const sourceKey = localApprovalSourceKey(request.source);
		const grantKey = `${sourceKey}:${request.toolName}`;
		if (this.grants.has(grantKey)) return { allowed: true };
		if (this.pending) return { allowed: false, reason: "Another tool approval is already pending" };
		process.stdout.write(`\n⚠️ Tool '${request.toolName}' requires approval. Reply 1 (allow once), 2 (allow this session), or 3 (deny).\n`);
		return new Promise<ToolApprovalDecision>((resolve) => {
			const pending: NonNullable<LocalApprovalBroker["pending"]> = { sourceKey, toolName: request.toolName, resolve };
			if (signal) {
				const abort = () => this.finish({ allowed: false, reason: "Tool approval cancelled" });
				signal.addEventListener("abort", abort, { once: true });
				pending.abortCleanup = () => signal.removeEventListener("abort", abort);
			}
			this.pending = pending;
		});
	}

	async handle(source: SessionSource, input: string): Promise<boolean> {
		const pending = this.pending;
		if (!pending || pending.sourceKey !== localApprovalSourceKey(source)) return false;
		const choice = input.trim().toLowerCase();
		if (["1", "allow", "允许", "允许一次"].includes(choice)) this.finish({ allowed: true });
		else if (["2", "allow session", "本会话允许"].includes(choice)) { this.grants.add(`${pending.sourceKey}:${pending.toolName}`); this.finish({ allowed: true }); }
		else if (["3", "deny", "拒绝"].includes(choice)) this.finish({ allowed: false, reason: "User denied the tool call" });
		else { process.stdout.write("Reply 1 (allow once), 2 (allow this session), or 3 (deny).\n"); }
		return true;
	}

	private finish(decision: ToolApprovalDecision): void {
		const pending = this.pending;
		if (!pending) return;
		this.pending = undefined;
		pending.abortCleanup?.();
		pending.resolve(decision);
	}
}

function localApprovalSourceKey(source: SessionSource): string { return `${source.platform}:${source.chatId}:${source.threadId ?? ""}:${source.userIdAlt ?? source.userId ?? "anon"}`; }

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
