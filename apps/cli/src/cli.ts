#!/usr/bin/env node
/**
 * beemax - BeeMax Agent CLI.
 *
 * Usage:
 *   beemax gateway    Start the Feishu gateway (long-running)
 *   beemax chat       Local interactive chat on stdout (no Feishu)
 *   beemax tui        Compatibility alias for beemax chat --full
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
import { renderModelProviderChoices, resolveProviderSelection } from "./model-catalog.ts";
import { configuredApiKey } from "./provider-resolver.ts";
import { executionPortFor, executionSafeTools } from "./execution-composition.ts";
import { createProfileRuntime } from "./runtime-composition.ts";
import { createProfileControlHandler } from "./profile-control.ts";
import { LocalActivityPresenter, LocalReasoningPresenter, renderChatFooter, type DetailsDisplay, parseReasoningCommand } from "./local-chat-renderer.ts";
import { renderTerminalMarkdown, StreamingTerminalMarkdown } from "./terminal-markdown.ts";
import { fullScreenEnter, fullScreenExit, resolveChatPresentationMode, type ChatPresentationMode } from "./chat-mode.ts";
import { FullWorkbench, startFullWorkbenchInput, type FullWorkbenchInput } from "./full-workbench.ts";
import { inspectGateway, readGatewayLogs } from "./gateway-observability.ts";
import { createTaskAwareConversationContext, ensureBuiltinTasks, installedVersion } from "./runtime-facts.ts";
import { AgentRunError, FileInteractionEventJournal, InteractionEventAdapter, SessionCatalog, ToolApprovalBroker, compileLongTermMemorySnapshot, interactionCommandHelp, parseInteractionCommand, type BeeMaxAgentRuntime } from "@beemax/core";
import type { SessionSource } from "@beemax/gateway";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const PI_SKILLS_BROWSER_TOOLS_COMMIT = "90bb51cae36515a648515b633a81c0c6efc8c74d";

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
			await runChat(getConfig(), {
				full: parsed.options.full === true,
				compact: parsed.options.compact === true,
				plain: parsed.options.plain === true,
				noAltScreen: parsed.options["no-alt-screen"] === true,
			});
			break;
		case "tui":
			await runChat(getConfig(), {
				full: true,
				compact: false,
				plain: false,
				noAltScreen: parsed.options["no-alt-screen"] === true,
			});
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
  chat       Adaptive terminal Agent (Full / Compact / Plain)
  model      show | set <provider> <model>
  doctor     Check profile readiness
  update     Update the installed BeeMax release, preserving all Profiles
  profile    create | list | show | path | use | migrate | backup | delete
  skills     list | sync (prepackaged Profile Skills)
  mcp        status (probe configured MCP servers)
  memory     status | list | candidates | claims | explain <id> | compile | promote <id> | reject <id> | forget <id>
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
  --full                   Force Full workbench presentation when interactive
  --compact                Force compact terminal presentation
  --plain                  Force pipe/log-friendly text presentation
  --no-alt-screen          Disable full-screen terminal behavior
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

const BOOLEAN_OPTIONS = new Set(["yes", "require-mention", "no-require-mention", "non-interactive", "system", "all", "open", "help", "deep", "follow", "full", "compact", "plain", "no-alt-screen"]);

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
	const { lstat, mkdir, readdir, readFile, realpath } = await import("node:fs/promises");
	const paths = resolveProfileLocation(profile, parsed.configPath);
	if (action === "sync") {
		await syncBuiltinSkills(profile);
		console.log(`Synced bundled Skills into Agent '${profile}' without replacing existing skills.`);
		return;
	}
	if (action === "install") {
		const name = parsed.positionals[2];
		if (name !== "pi-web-access") throw new Error("Usage: beemax skills install pi-web-access --profile <name>");
		const skillsRoot = join(paths.homePath, "skills");
		const piSkillsRoot = join(skillsRoot, "pi-skills");
		const browserTools = join(piSkillsRoot, "browser-tools");
		const directoryExists = async (path: string): Promise<boolean> => {
			const info = await lstat(path).catch(() => undefined);
			return Boolean(info?.isDirectory() && !info.isSymbolicLink());
		};
		const rootExists = await lstat(piSkillsRoot).then(() => true).catch(() => false);
		if (!await directoryExists(browserTools)) {
			if (rootExists) throw new Error(`Untrusted or incomplete Pi Skills directory at ${piSkillsRoot}; remove it before reinstalling.`);
			await mkdir(skillsRoot, { recursive: true, mode: 0o700 });
			const clone = spawnSync("git", ["clone", "--depth", "1", "https://github.com/badlogic/pi-skills.git", piSkillsRoot], { stdio: "inherit" });
			if (clone.status !== 0) throw new Error("Could not install official Pi Web Access skill. Ensure git and network access are available.");
		}
		const [resolvedSkillsRoot, resolvedBrowserTools] = await Promise.all([realpath(skillsRoot), realpath(browserTools)]);
		if (!resolvedBrowserTools.startsWith(`${resolvedSkillsRoot}/`)) throw new Error("Pi Web Access skill path escapes this Profile's Skills directory.");
		const revision = spawnSync("git", ["-C", piSkillsRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
		const origin = spawnSync("git", ["-C", piSkillsRoot, "remote", "get-url", "origin"], { encoding: "utf8" });
		if (revision.status !== 0 || revision.stdout.trim() !== PI_SKILLS_BROWSER_TOOLS_COMMIT || origin.status !== 0 || origin.stdout.trim() !== "https://github.com/badlogic/pi-skills.git") throw new Error(`Pi Skills installation is not the approved official revision ${PI_SKILLS_BROWSER_TOOLS_COMMIT}.`);
		const install = spawnSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: resolvedBrowserTools, stdio: "inherit" });
		if (install.status !== 0) throw new Error("Pi Web Access skill was downloaded but its npm dependencies could not be installed.");
		console.log(`Installed official Pi Web Access (browser-tools) revision ${PI_SKILLS_BROWSER_TOOLS_COMMIT.slice(0, 12)} for Profile '${profile}'. Start Chrome with:\n${join(resolvedBrowserTools, "browser-start.js")} --profile`);
		return;
	}
	if (action !== "list") throw new Error("Usage: beemax skills [list | sync | install pi-web-access] --profile <name>");
	const skills: Array<{ name: string; description: string; sha256: string }> = [];
	const visit = async (directory: string, prefix = ""): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
			const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
			const child = join(directory, entry.name);
			const content = await readFile(join(child, "SKILL.md"), "utf8").catch(() => "");
			const description = content.match(/^description:\s*(.+)$/m)?.[1]?.replaceAll('"', "").trim();
			if (description) { skills.push({ name: relativeName, description, sha256: createHash("sha256").update(content).digest("hex") }); continue; }
			await visit(child, relativeName);
		}
	};
	try {
		await visit(join(paths.homePath, "skills"));
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
	const localMemoryScope = { platform: "cli" as const, chatId: "local", userId: "local" };
	try {
		if (action === "status") {
			const stats = store.stats(localMemoryScope);
			console.log(`Profile ${config.profile}: curated=${stats.curated} pending=${stats.pending} promoted=${stats.promoted} rejected=${stats.rejected}`);
			return;
		}
		if (action === "claims") {
			const claims = store.listClaims({ ...localMemoryScope, limit: 50 });
			console.log(claims.map((claim) => `${claim.id}  [${claim.kind}/${claim.stability}/${claim.confidence.toFixed(2)}] ${claim.statement}`).join("\n") || "No active structured memories.");
			return;
		}
		if (action === "explain") {
			const id = parsed.positionals[2];
			if (!id) throw new Error("Usage: beemax memory explain <id> --profile <name>");
			const explanation = store.explainClaim(id, localMemoryScope);
			if (!explanation) throw new Error(`Memory understanding ${id} was not found`);
			console.log(`${explanation.claim.statement}\n${explanation.evidence.map((item) => `- [${item.eventId ?? item.kind}] ${new Date(item.event?.occurredAt ?? item.createdAt).toISOString()}: ${item.event?.content ?? item.excerpt}`).join("\n")}`);
			return;
		}
		if (action === "compile") {
			if (parsed.options.yes !== true) throw new Error("memory compile writes MEMORY.md; rerun with --yes");
			// MEMORY.md is profile-global and injected by the Gateway, so never compile
			// arbitrary channel users into it. Personal CLI memory is the only safe default.
			const path = compileLongTermMemorySnapshot(store, config.paths.agentDir, { ...localMemoryScope, chatType: "dm" });
			console.log(`Compiled ${path}.`);
			return;
		}
		if (action === "correct") {
			const id = parsed.positionals[2];
			const statement = optionString(parsed, "statement");
			if (!id || !statement) throw new Error("Usage: beemax memory correct <id> --statement <text> --yes --profile <name>");
			if (parsed.options.yes !== true) throw new Error("memory correct requires --yes");
			const eventId = store.recordEvent({ ...localMemoryScope, kind: "feedback", content: statement });
			const claim = store.correctClaim(id, { statement, evidence: { kind: "correction", eventId, excerpt: statement } }, localMemoryScope);
			if (!claim) throw new Error(`Memory understanding ${id} was not found`);
			console.log(`Corrected ${id} as ${claim.id}.`);
			return;
		}
		if (action === "list" || action === "candidates") {
			const records = action === "list" ? store.list({ ...localMemoryScope, limit: 50 }) : store.listCandidates({ ...localMemoryScope, limit: 50 });
			console.log(records.map((record) => `${record.id}  [${record.role}] ${record.content}`).join("\n") || `No ${action === "list" ? "curated memories" : "pending candidates"}.`);
			return;
		}
		const id = parsed.positionals[2];
		if ((action !== "promote" && action !== "reject" && action !== "forget") || !id) throw new Error("Usage: beemax memory [status | list | candidates | claims | explain <id> | compile | correct <id> --statement <text> | promote <id> | reject <id> | forget <id>] --profile <name>");
		if (parsed.options.yes !== true) throw new Error(`memory ${action} requires --yes`);
		const changed = action === "promote" ? store.promoteCandidate(id, localMemoryScope) : action === "reject" ? store.rejectCandidate(id, localMemoryScope) : store.forget(id, localMemoryScope) || store.forgetClaim(id, localMemoryScope);
		if (!changed) throw new Error(`${action === "forget" ? "Memory" : "Pending memory candidate"} ${id} was not found`);
		console.log(`${action === "promote" ? "Promoted" : action === "reject" ? "Rejected" : "Forgot"} ${action === "forget" ? "memory" : "memory candidate"} ${id}.`);
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

async function runChat(config: ReturnType<typeof loadConfig>, requestedMode: { full: boolean; compact: boolean; plain: boolean; noAltScreen: boolean }): Promise<void> {
	const presentationMode: ChatPresentationMode = resolveChatPresentationMode({
		...requestedMode, isInputTty: process.stdin.isTTY === true, isOutputTty: process.stdout.isTTY === true, term: process.env.TERM,
	});
	const {
		createSubagentTools,
		SubagentManager,
	} = await import("@beemax/gateway");
	const { loadMcpConfig, McpManager } = await import("@beemax/mcp-capability");
	const { buildAgentFactory } = await import("./agent-factory.ts");
	const { MemoryStore } = await import("@beemax/memory");
	const apiKey = configuredApiKey(config.model.provider, config.model.apiKey) ?? "";
	// Full mode renders approval lifecycle from semantic events in its own panel;
	// Compact/Plain retain the durable text prompt for SSH and scripts.
	const localApproval = new ToolApprovalBroker(async (_source, text) => {
		if (presentationMode !== "full") process.stdout.write(`\n${text}\n`);
	});
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
	let interactionAdapter: InteractionEventAdapter<SessionSource> | undefined;
	runtime = createProfileRuntime(
		{ maxSessions: config.agent.maxSessions, sessionIdleMs: config.agent.sessionIdleMs },
		{
			createAgent,
			sessionCatalog: SessionCatalog.forAgentDir<SessionSource>(config.paths.agentDir),
			context: createTaskAwareConversationContext(memory, { runtimeSnapshot: () => ({ model: `${config.model.provider}/${config.model.model}`, profile: config.profile }) }),
			controlHandler: (input) => createProfileControlHandler(runtime, config, interactionAdapter)(input),
		},
	);
	interactionAdapter = new InteractionEventAdapter(runtime, {
		profileId: config.profile,
		approvalBroker: localApproval,
		cancelSubagents: (sessionSource) => subagents?.cancelOwner(sessionSource) ?? 0,
		eventJournal: new FileInteractionEventJournal(join(config.paths.agentDir, "interaction-events.jsonl")),
	});
	let fullScreenActive = false;
	let fullInput: FullWorkbenchInput | undefined;
	let subagentRefresh: ReturnType<typeof setInterval> | undefined;

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
		let sessionChoices: string[] = [];
		let modelChoices: string[] = [];
		let retryText: string | undefined;
		let activity = new LocalActivityPresenter(detailsDisplay, presentationMode !== "plain");
		let controlInProgress = false;
		let lastDurationMs: number | undefined;
		let closed = false;
		let workbench: FullWorkbench | undefined;
		const { createInterface } = await import("node:readline/promises");
		const prompt = () => presentationMode === "plain" ? "beemax> " : presentationMode === "compact" ? `beemax [${config.model.model}]> ` : `beemax [${config.profile} · ${config.model.provider}/${config.model.model} · ${source.threadId ?? "default"}]> `;
		const writePrompt = () => { if (!closed && !workbench) process.stdout.write(prompt()); };
		let closeInput = () => { closed = true; };
		const usage = async () => {
			const current = await runtime.usage(source);
			if (!current) return "Usage: no live session. Resume or send a message to load one.";
			const context = current.contextWindow === null ? "unknown" : current.contextTokens === null ? `?/${current.contextWindow}` : `${current.contextTokens}/${current.contextWindow} (${Math.round(current.contextPercent ?? 0)}%)`;
			return `Usage: input=${current.inputTokens}; output=${current.outputTokens}; cache-read=${current.cacheReadTokens}; cache-write=${current.cacheWriteTokens}; context=${context}${lastDurationMs === undefined ? "" : `; last-turn=${Math.round(lastDurationMs / 1000)}s`}`;
		};
		const writeFooter = async () => {
			if (presentationMode === "plain") return;
			const snapshot = await interactionAdapter.snapshot(source);
			const usage = snapshot.usage;
			const context = usage?.contextWindow === null || usage?.contextWindow === undefined ? undefined : usage.contextTokens === null ? `?/${usage.contextWindow}` : `${usage.contextTokens}/${usage.contextWindow}`;
			if (workbench) {
				workbench.setFooter({ model: `${config.model.provider}/${config.model.model}`, session: source.threadId ?? "default", phase: snapshot.phase, context, lastDurationMs, queued: snapshot.queueDepth });
				if (fullInput) fullInput.requestRender();
				else process.stdout.write(`\x1b[H\x1b[2J${workbench.render()}\n`);
				return;
			}
			process.stdout.write(renderChatFooter({ profile: config.profile, model: `${config.model.provider}/${config.model.model}`, session: source.threadId ?? "default", phase: snapshot.phase, context, lastDurationMs, queued: snapshot.queueDepth }));
		};
		const status = async () => `Profile: ${config.profile}\nModel: ${config.model.provider}/${config.model.model}\nSession: ${source.threadId ?? "default"}\nRun: ${runtime.isBusy() ? "running" : "idle"}\nReasoning: ${reasoningDisplay}\nDetails: ${detailsDisplay}\nToolset: ${config.agent.toolset}\n${await usage()}`;
		const toolsStatus = () => {
			const tools = mcp.getTools().map((tool) => `${tool.name}${mcpApproval.has(tool.name) ? " (approval required)" : ""}`);
			return `Toolset: ${config.agent.toolset}\nMCP: ${tools.length ? tools.join(", ") : "no MCP tools connected"}`;
		};
		const sessions = async (query?: string) => {
			const live = new Map(runtime.listSessions(source).map((candidate) => [candidate.threadId ?? "default", candidate]));
			const saved = await runtime.listSavedSessions(source);
			const filtered = query ? saved.filter((record) => (record.threadId ?? "default").toLowerCase().includes(query.toLowerCase())) : saved;
			sessionChoices = filtered.map((record) => record.threadId ?? "default");
			const rendered = filtered.map((record, index) => {
					const id = record.threadId ?? "default";
					const current = live.get(id);
					return `${index + 1}. ${id}  ${current?.busy ? "running" : current ? "live" : "saved"}  ${new Date(current?.lastActiveAt ?? record.lastUsedAt).toLocaleString()}`;
				});
			if (workbench) workbench.setPicker("Session Picker · /resume <number>", rendered);
			return rendered.length ? `${rendered.join("\n")}\n\nUse /resume <number> or /resume <session-id>.` : query ? `No session matches '${query}'.` : "No saved sessions. Start a conversation to create one.";
		};
		const history = async (limit?: number) => {
			const entries = await runtime.history(source, limit);
			return entries.length
				? entries.map((entry) => `[${entry.role}] ${entry.text.replaceAll("\n", " ")}`).join("\n")
				: "No live message history. Resume or send a message to load this session.";
		};
		const stop = async () => {
			const stopped = await interactionAdapter.dispatch({ type: "turn.cancel", source });
			if (!("cancelled" in stopped)) throw new Error("Cancellation dispatch did not produce a cancellation result");
			process.stdout.write(`\n${stopped.cancelled ? "Stopped the active Agent turn" : "No active Agent turn"}${stopped.subagentsCancelled ? `; cancelled ${stopped.subagentsCancelled} Sub-Agent task(s)` : ""}${stopped.approvalCancelled ? "; cancelled pending approval" : ""}${stopped.queuedCancelled ? "; cleared queued input" : ""}.\n`);
		};
		if (presentationMode === "full") {
			fullScreenActive = true;
			workbench = new FullWorkbench({ profile: config.profile, model: `${config.model.provider}/${config.model.model}`, session: source.threadId ?? "default", details: detailsDisplay });
			process.stdout.write(fullScreenEnter(""));
		}
		const runTurn = async (text: string, turnSource: import("@beemax/gateway").SessionSource) => {
			workbench?.user(text);
			let streamed = "";
			const richOutput = presentationMode !== "plain";
			const reasoning = new LocalReasoningPresenter(reasoningDisplay, richOutput);
			let answerStreamStarted = false;
			const terminal = new StreamingTerminalMarkdown();
			const outcome = await interactionAdapter.dispatch({ type: "message.send", source: turnSource, text, input: { timeoutMs: 10 * 60_000, mode: "interactive" } }, async (event) => {
				if (workbench) {
					activity.event(event);
					workbench.setSubagents(subagents?.list(turnSource) ?? []);
					workbench.event(event, activity.renderDetails());
					if (event.type !== "answer.delta") await writeFooter();
					else if (fullInput) fullInput.requestRender(); else process.stdout.write(`\x1b[H\x1b[2J${workbench.render()}\n`);
					return;
				}
				process.stdout.write(activity.event(event));
				if (event.type === "turn.started" || event.type === "approval.requested" || event.type === "turn.queued") await writeFooter();
				const thinkingDelta = event.type === "reasoning.delta" ? event.text : undefined;
				if (thinkingDelta) process.stdout.write(reasoning.thinking(thinkingDelta));
				const delta = event.type === "answer.delta" ? event.text : undefined;
				if (delta) {
					if (!answerStreamStarted) process.stdout.write(reasoning.beforeAnswer());
					answerStreamStarted = true;
					streamed += delta;
					terminal.write(delta, (output) => process.stdout.write(output));
				}
			});
			if (!("answer" in outcome)) throw new Error("Message dispatch did not produce an Agent result");
			const result = outcome;
			if (workbench) {
				if (!streamed) workbench.answer(result.answer);
			} else if (streamed) terminal.finish((output) => process.stdout.write(output));
			else {
				process.stdout.write(reasoning.beforeAnswer());
				process.stdout.write(renderTerminalMarkdown(result.answer));
			}
			lastDurationMs = result.durationMs;
			if (!workbench) process.stdout.write("\n");
			await writeFooter();
		};
		const handleLine = async (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) { writePrompt(); return; }
			const command = parseInteractionCommand(trimmed);
			if (active) {
				if (command?.kind === "stop") { await stop(); return; }
				if (await interactionAdapter.handleApprovalReply(source, trimmed)) return;
				if (command?.kind === "status") { process.stdout.write(`\n${await status()}\n`); return; }
				const queued = await interactionAdapter.dispatch({ type: "turn.queue", source, text: trimmed });
				if (!("queued" in queued) || !queued.queued) { process.stdout.write("\nCould not queue input because no active turn is available.\n"); return; }
				process.stdout.write(`\n${queued.replaced ? "Replaced the queued input." : "Queued the next input."} Use /stop (or Ctrl+C) to cancel the active turn.\n`);
				return;
			}
			if (controlInProgress) {
				process.stdout.write("\nA control command is still being processed. Please wait.\n");
				return;
			}
			if (trimmed === "/quit" || trimmed === "/exit") { closeInput(); return; }
			if (command?.kind === "help") {
				process.stdout.write(`${interactionCommandHelp()}\n`);
				writePrompt();
				return;
			}
			if (command?.kind === "status") { process.stdout.write(`${await status()}\n`); writePrompt(); return; }
			if (command?.kind === "usage") { process.stdout.write(`${await usage()}\n`); writePrompt(); return; }
			if (command?.kind === "new") {
				const threadId = `local-${crypto.randomUUID()}`;
				source = { ...source, threadId };
				await interactionAdapter.dispatch({ type: "session.open", source });
				await applySessionPreferences();
				lastDurationMs = undefined;
				activity = new LocalActivityPresenter(detailsDisplay, presentationMode !== "plain");
				process.stdout.write(`Started new session: ${threadId}\n`);
				writePrompt();
				return;
			}
			if (command?.kind === "reset") {
				const resetResult = await interactionAdapter.dispatch({ type: "session.reset", source });
				const reset = "reset" in resetResult && resetResult.reset;
				const threadId = `local-${crypto.randomUUID()}`;
				source = { ...source, threadId };
				await interactionAdapter.dispatch({ type: "session.open", source });
				await applySessionPreferences();
				lastDurationMs = undefined;
				activity = new LocalActivityPresenter(detailsDisplay, presentationMode !== "plain");
				process.stdout.write(`${reset ? "Discarded the live session and" : "Started"} a fresh session: ${threadId}\n`);
				writePrompt();
				return;
			}
			if (command?.kind === "sessions") {
				const output = await sessions(command.query);
				if (workbench) await writeFooter(); else process.stdout.write(`${output}\n`);
				writePrompt(); return;
			}
			if (command?.kind === "models") {
				const allChoices = config.models.map((choice) => `${choice.provider}/${choice.model}`);
				const matching = command.query ? allChoices.filter((choice) => choice.toLowerCase().includes(command.query!.toLowerCase())) : allChoices;
				modelChoices = matching;
				const rendered = matching.map((choice, index) => `${index + 1}. ${choice}`).join("\n");
				if (workbench) { workbench.setPicker("Model Picker · /model <number>", matching.map((choice, index) => `${index + 1}. ${choice}`)); await writeFooter(); }
				else process.stdout.write(`${rendered || "No matching configured models."}\n\nUse /model <number> or /model <provider/model>.\n`);
				writePrompt(); return;
			}
			if (command?.kind === "tools") { process.stdout.write(`${toolsStatus()}\n`); writePrompt(); return; }
			if (command?.kind === "retry") {
				if (!retryText) process.stdout.write("No recoverable failed turn to retry.\n");
				else { const text = retryText; retryText = undefined; active = runTurn(text, source); try { await active; } catch (error) { process.stdout.write(`Agent run failed: ${error instanceof Error ? error.message : String(error)}\n`); } finally { active = undefined; } }
				writePrompt(); return;
			}
			if (command?.kind === "history") { process.stdout.write(`${await history(command.limit)}\n`); writePrompt(); return; }
			if (command?.kind === "resume") {
				const selected = /^\d+$/.test(command.sessionId) ? sessionChoices[Number(command.sessionId) - 1] : command.sessionId;
				if (!selected) {
					process.stdout.write("Unknown session number. Run /sessions and choose a listed number.\n");
					writePrompt();
					return;
				}
				const resumeSource = selected === "default" ? { ...source, threadId: undefined } : { ...source, threadId: selected };
				if (!await runtime.hasSavedSession(resumeSource)) {
					process.stdout.write(`Unknown session '${command.sessionId}'. Run /sessions to choose a saved session.\n`);
					writePrompt();
					return;
				}
				source = resumeSource;
				workbench?.clearPicker();
				lastDurationMs = undefined;
				activity = new LocalActivityPresenter(detailsDisplay, presentationMode !== "plain");
				await interactionAdapter.dispatch({ type: "session.open", source });
				await applySessionPreferences();
				process.stdout.write(`Restored session: ${source.threadId ?? "default"}. Use /history to inspect it or send a message to continue.\n`);
				writePrompt();
				return;
			}
			if (command?.kind === "stop") { await stop(); writePrompt(); return; }
			if (command?.kind === "compact") {
				const compacted = await interactionAdapter.dispatch({ type: "session.compact", source });
				process.stdout.write(`${"compacted" in compacted && compacted.compacted ? "Context compacted." : "No idle session is available to compact."}\n`);
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
				if (command.mode === "status") process.stdout.write(`Details: ${detailsDisplay}. Use /details hidden|collapsed|expanded.\n\n${activity.renderDetails()}\n`);
				else { detailsDisplay = command.mode; activity.setDetails(detailsDisplay); await runtime.updateSessionPreferences(source, { detailsDisplay }); process.stdout.write(`Details display set to ${detailsDisplay}.\n\n${activity.renderDetails()}\n`); }
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
					const numeric = trimmed.match(/^\/model\s+(\d+)\s*$/i);
					const selected = numeric ? modelChoices[Number(numeric[1]) - 1] : undefined;
					if (numeric && !selected) { process.stdout.write("Unknown model number. Run /models and choose a listed number.\n"); writePrompt(); return; }
					const control = await runtime.handleControl({ source, text: selected ? `/model ${selected}` : trimmed });
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
			finally {
				active = undefined;
				const next = interactionAdapter.takeQueuedInput(source);
				if (next) {
					process.stdout.write("\n▶ Running queued input…\n");
					void handleLine(next);
					return;
				}
				writePrompt();
			}
		};
		if (workbench) {
			await new Promise<void>((resolve) => {
				closeInput = () => { closed = true; const input = fullInput; fullInput = undefined; input?.stop(); resolve(); };
				fullInput = startFullWorkbenchInput(
					workbench,
					(line) => { void handleLine(line); },
					() => { if (active) void stop(); else closeInput(); },
					closeInput,
					(choice) => { void interactionAdapter.dispatch({ type: "approval.decide", source, choice }); },
				);
				subagentRefresh = setInterval(() => {
					if (!workbench || !fullInput) return;
					workbench.setSubagents(subagents?.list(source) ?? []);
					fullInput.requestRender();
				}, 1_000);
			});
		} else {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			closeInput = () => { closed = true; rl.close(); };
			writePrompt();
			rl.on("line", (line) => { void handleLine(line); });
			rl.on("SIGINT", () => { if (active) void stop(); else closeInput(); });
			await new Promise<void>((resolve) => rl.once("close", resolve));
		}
	} finally {
		if (subagentRefresh) clearInterval(subagentRefresh);
		fullInput?.stop();
		if (fullScreenActive) process.stdout.write(fullScreenExit());
		interactionAdapter.dispose();
		runtime.dispose();
		await subagents?.dispose();
		await mcp.close();
		localApproval.dispose();
		memory.close();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
