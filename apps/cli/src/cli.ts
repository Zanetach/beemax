#!/usr/bin/env node
/**
 * beemax - BeeMax Agent CLI.
 *
 * Usage:
 *   beemax gateway    Start the Profile messaging gateway (long-running)
 *   beemax chat       Local interactive chat on stdout
 *   beemax tui        Compatibility alias for beemax chat --full
 *   beemax model      Show / set the configured model
 */

import { buildMainAgentSystemPrompt, buildSubagentSystemPrompt, createSkillCandidateVerifier, createTaskVerifier, createVerifiedObjectiveMemoryPublisher, executeObjectiveDelivery, executePlannedTask, executeSubagentTask, mainAgentTools, readOnlyAgentTools, runGateway, runProfileAutomation, subagentExecutionTools, verificationAgentToolsForTask } from "./gateway.ts";
import { beemaxHome, beemaxRoot, consumeChannelCredential, loadConfig, profileEnvironmentSnapshot, profileTurnTimeoutMs } from "./config.ts";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { backupSqliteDatabase, MemoryStore, memoryPersistencePorts, verifySqliteDatabase } from "@beemax/memory";
import { runDoctor } from "./doctor.ts";
import {
	configureFeishuChannel,
	configureTelegramChannel,
	configureModel,
	createProfile,
	deleteProfile,
	enableStandardWebProvider,
	ensureCredentialVaultKey,
	listProfiles,
	migrateProfile,
	removeFeishuChannel,
	removeTelegramChannel,
	setActiveProfile,
	syncBuiltinSkills,
	syncBuiltinSkillsAtProfileHome,
	testFeishuCredentials,
	testTelegramCredentials,
} from "./profile-config.ts";
import { activeProfile, resolveProfileLocation } from "./profile-home.ts";
import { installMacLaunchAgent, installSystemdService, runServiceAction, type ServiceAction } from "./service-manager.ts";
import { resolveServiceLogCommand, serviceDisplayName } from "./service-platform.ts";
import { runSetup, type SetupOptions } from "./setup.ts";
import { configuredAuxiliaryTextModels, configuredCapabilityRanker, configuredMediaUnderstanding, configuredRuntimeModels, ProfileModelCatalog, renderModelProviderChoices, resolveProfileCognitionModels, resolveProviderSelection } from "./model-catalog.ts";
import { executionPortFor, executionSafeTools } from "./execution-composition.ts";
import { createProfileRuntime } from "./runtime-composition.ts";
import { createProfileControlHandler, renderTaskPlanDetails, renderTaskPlanNotFound, renderTaskPlanRetryResult, renderTaskPlans, renderTaskRecoveryStatus, renderTaskSchedulerStatus, renderTasks, type TaskRecoveryStatus } from "./profile-control.ts";
import { LocalActivityPresenter, LocalReasoningPresenter, renderChatFooter, type DetailsDisplay, parseReasoningCommand } from "./local-chat-renderer.ts";
import { renderTerminalMarkdown, StreamingTerminalMarkdown } from "./terminal-markdown.ts";
import { fullScreenEnter, fullScreenExit, resolveChatPresentationMode, type ChatPresentationMode } from "./chat-mode.ts";
import { FullWorkbench, startFullWorkbenchInput, type FullWorkbenchInput } from "./full-workbench.ts";
import { inspectGateway, readGatewayLogs, recordGatewayEvent } from "./gateway-observability.ts";
import { createTaskAwareConversationContext, ensureBuiltinTasks, installedVersion } from "./runtime-facts.ts";
import { AUTONOMY_LEVELS, ActionGovernance, AgentRunError, AuthStorage, AutonomyRolloutController, DefaultMemoryLearningKernel, DeterministicLearningExtractor, FileCredentialVault, FileCredentialVaultAuditJournal, ObjectiveCompletionDeliveryService, PiLearningExtractor, ProactiveInvestigationRuntime, ProgressiveLearningExtractor, TaskPlanNoticeDeliveryService, ToolPolicyRegistry, buildActiveTaskPreservationEnvelope, buildTaskPreservationEnvelope, compileLongTermMemorySnapshot, conversationKey, createContractAdmissionReceiptIntegrity, createExecutionEnvelope, createSubagentTools, createTaskLedgerTools, createTaskOrchestrationTools, guardVerifiedObjectiveMemoryPublisher, interactionCommandHelp, isVerifiedAutomationOutcome, objectiveIdFromCompletionId, parseInteractionCommand, redactCredentialMaterial, responsibilityOwnerKey, responsibilityOwnerKeys, type AutonomyLevel, type AutonomyRolloutAuthority, type DeliveryPort, type LearningObjectiveAdmissionPort } from "@beemax/core";
import type { SessionSource } from "@beemax/channel-runtime";
import { PairingStore, assertProfileBindingConfiguration } from "@beemax/gateway";
import { executeFeishuSmoke } from "./feishu-smoke.ts";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { loadMcpConfig, McpManager } from "@beemax/mcp-capability";
import { WeKnoraKnowledgeProvider, createKnowledgeTools } from "@beemax/knowledge";
import { buildAgentFactory } from "./agent-factory.ts";
import { inspectProfileExecutionTrace, renderExecutionTrace } from "./execution-trace-inspection.ts";
import { inspectProfileEffects, reconcileProfileEffect } from "./effect-inspection.ts";
import { loadInstalledAutonomyRolloutEvidence, renderAutonomyRollout } from "./autonomy-control.ts";
import { createLocalMediaUnderstandingAdapters } from "./local-media-understanding.ts";
import { setProfileBindingEnabled } from "./profile-binding-config.ts";
import { applyProfileChannelInstanceMigration, planProfileChannelInstanceMigration, rollbackProfileChannelInstanceMigration } from "./channel-instance-migration.ts";
import { applyProfileSessionOwnershipMigration, planProfileSessionOwnershipMigration, rollbackProfileSessionOwnershipMigration } from "./session-ownership-migration.ts";
import { createProfileCapabilityProviderBundle, installProfileExaMcporter, profileProviderIntegrityKey } from "./capability-provider-composition.ts";
import { assertStandardWebProfileBoundary, inspectStandardWebPack, inspectStandardWebSkill, installPiWebAccess, installStandardWebRuntime, type StandardWebPackStatus, type StandardWebSkillId } from "./profile-capability-pack.ts";
import { startProfileBrowser, stopProfileBrowser } from "./profile-browser.ts";
import { inspectLocalSkill, installLocalSkill } from "./profile-skill-install.ts";
import { addProfileMcpServer, removeProfileMcpServer } from "./profile-mcp-config.ts";
import { createLocalArtifactRuntime } from "./artifact-composition.ts";
import { createInteractiveContractCognition } from "./interactive-contract-cognition.ts";
import { admitLearningObjective as admitLearningObjectiveThroughRuntime } from "./learning-objective-composition.ts";

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
		case "binding":
			await runBindingCommand(parsed);
			break;
		case "pairing":
			await runPairingCommand(parsed);
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
				console.log((await listProfiles()).map((name) => `${name}  ${serviceDisplayName(name)}`).join("\n") || "No Agent Profiles configured.");
			} else if (["start", "stop", "restart", "status", "logs"].includes(parsed.positionals[1] ?? "")) {
				const profiles = parsed.options.all === true ? await listProfiles() : [gatewayProfile(parsed)];
				for (const name of profiles) await runServiceAction(parsed.positionals[1] as ServiceAction, name, undefined, process.platform, parsed.options.system === true ? "system" : "user");
			} else if (parsed.positionals[1] === "health") {
				if (!(await runDoctor(loadConfig(parsed.configPath, gatewayProfile(parsed)), { json: parsed.options.json === true }))) process.exitCode = 1;
			} else if (parsed.positionals[1] === "smoke") {
				const smokeConfig = loadConfig(parsed.configPath, gatewayProfile(parsed));
				let chatId = optionString(parsed, "chat-id") ?? smokeConfig.gateway.feishu.homeChatId;
				if (!chatId && process.stdin.isTTY) chatId = await askOne("Feishu target chat_id: ");
				if (!chatId) throw new Error("Feishu smoke test requires --chat-id <oc_xxx> or a configured home chat");
				if (parsed.options.yes !== true) {
					if (!process.stdin.isTTY) throw new Error("Feishu smoke test sends three visible messages; rerun with --yes to confirm");
					const confirmed = await askOne(`Send text, card, and image probes to ${chatId}? [y/N]: `);
					if (!/^(y|yes)$/i.test(confirmed.trim())) throw new Error("Feishu smoke test cancelled");
				}
				const smoke = await executeFeishuSmoke(smokeConfig, chatId);
				console.log(smoke.output);
				if (!smoke.success) process.exitCode = 1;
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
				once: optionString(parsed, "once"),
				thread: optionString(parsed, "thread"),
			});
			break;
		case "tui":
			await runChat(getConfig(), {
				full: true,
				compact: false,
				plain: false,
				noAltScreen: parsed.options["no-alt-screen"] === true,
				once: undefined,
				thread: undefined,
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
		case "migration":
			await runMigrationCommand(parsed);
			break;
		case "skills":
			await runSkillsCommand(parsed);
			break;
		case "capabilities":
			await runCapabilitiesCommand(parsed);
			break;
		case "mcp":
			await runMcpCommand(parsed, getConfig());
			break;
		case "memory":
			await runMemoryCommand(parsed, getConfig());
			break;
		case "autonomy":
			await runAutonomyCommand(parsed, getConfig());
			break;
		case "credentials":
			if (parsed.configPath) throw new Error("beemax credentials does not support --config; select a Profile with --profile");
			await ensureCredentialVaultKey(profile);
			await runCredentialCommand(parsed, getConfig());
			break;
		case "task":
			await runTaskCommand(parsed, getConfig());
			break;
		case "trace": {
			if (parsed.positionals[1] !== "show" || !parsed.positionals[2]) throw new Error("Usage: beemax trace show <execution-id> [--access-scope <scope-id>] --profile <name>");
			const trace = inspectProfileExecutionTrace(getConfig().paths.agentDir, parsed.positionals[2], optionString(parsed, "access-scope"));
			if (!trace) throw new Error("Execution Trace not found or Access Scope did not match");
			console.log(renderExecutionTrace(trace));
			break;
		}
		case "effect": {
			const action = parsed.positionals[1];
			if (action === "list") {
				const status = optionString(parsed, "status") ?? "unknown";
				if (!["all", "planned", "executing", "committed", "failed", "unknown"].includes(status)) throw new Error("Effect status filter is invalid");
				const effects = inspectProfileEffects(getConfig().paths.agentDir, status as "all" | "planned" | "executing" | "committed" | "failed" | "unknown");
				console.log(effects.length ? effects.map((effect) => `${effect.id}  [${effect.status}]  ${effect.toolName}${effect.taskId ? `  task=${effect.taskId}` : ""}`).join("\n") : "No matching Effects.");
				break;
			}
			if (action === "reconcile" && parsed.positionals[2]) {
				const status = optionString(parsed, "status");
				if (status !== "committed" && status !== "failed") throw new Error("Usage: beemax effect reconcile <id> --status <committed|failed> [--operation <observed-operation>] [--external-ref <reference>]");
				const effect = reconcileProfileEffect(getConfig().paths.agentDir, parsed.positionals[2], { status, ...(optionString(parsed, "operation") ? { operation: optionString(parsed, "operation") } : {}), ...(optionString(parsed, "external-ref") ? { externalRef: optionString(parsed, "external-ref") } : {}) });
				console.log(`Reconciled Effect ${effect.id} as ${effect.status}.`);
				break;
			}
			throw new Error("Usage: beemax effect list [--status <status>] | beemax effect reconcile <id> --status <committed|failed>");
		}
		case "service":
			if (parsed.positionals[1] !== "install") throw new Error("Usage: beemax service install");
			await installGatewayService(serviceProfile(parsed), parsed.options.system === true ? "system" : "user");
			console.log("BeeMax Gateway service installed. Start an agent with: beemax start <name>");
			break;
		case "start":
		case "stop":
		case "restart":
			await runServiceAction(cmd, serviceProfile(parsed), undefined, process.platform, parsed.options.system === true ? "system" : "user");
			break;
		case "status":
			if (parsed.options.deep === true) { runGatewayStatus(getConfig(), parsed.options.system === true ? "system" : "user"); break; }
			await runServiceAction(cmd, serviceProfile(parsed), undefined, process.platform, parsed.options.system === true ? "system" : "user");
			break;
		case "logs":
			if (parsed.options.follow === true) await runServiceAction(cmd, serviceProfile(parsed), undefined, process.platform, parsed.options.system === true ? "system" : "user");
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
  binding    validate | activate <id> | disable <id> | explain --channel-instance <id> --conversation <id>
  pairing    list | approve <platform> <code> | revoke <platform> <user_id> | clear [platform]
  gateway    run | setup | smoke | install | start | stop | restart | status | logs | list | health
  chat       Adaptive terminal Agent (Full / Compact / Plain)
  model      show | set <provider> <model>
  doctor     Check profile readiness
  update     Update the installed BeeMax release, preserving all Profiles
  profile    create | list | show | path | use | migrate | backup | delete
  migration  channel-instance | session plan | apply | rollback (explicit legacy ownership)
  skills     list | sync | inspect --from <path> | install pi-web-access | install --from <path> --sha256 <digest>
  capabilities status | install <standard-web|exa-web-search|agent-reach|pi-web-access> | start | stop pi-web-access
  mcp        status | add <name> --from <descriptor.json> | remove <name>
  memory     status | list | candidates | claims | explain <id> | compile | promote <id> | reject <id> | forget <id>
  autonomy   status | promote <level> | stop <level> | rollback <level> | resume <level> (evidence-gated Profile rollout)
  credentials add | list | rotate | remove (encrypted Profile Credential Vault)
  task       list | set <id> <open|in_progress|done|cancelled> --title <title> [--evidence <ref>]
  trace      show <execution-id> [--access-scope <scope-id>]
  effect     list [--status <status>] | reconcile <id> --status <committed|failed>
  service    install (Linux systemd or macOS LaunchAgent)
  start      Start a profile service
  stop       Stop a profile service
  restart    Restart a profile service
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
  --once <prompt>          Run one non-interactive Turn and exit after settlement
  --thread <id>            Use an isolated named local session (recommended for repeatable --once runs)
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
  BEEMAX_CREDENTIAL_VAULT_KEY  Optional external override for the protected Profile Vault key
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

const BOOLEAN_OPTIONS = new Set(["yes", "require-mention", "no-require-mention", "non-interactive", "system", "all", "open", "help", "deep", "follow", "full", "compact", "plain", "no-alt-screen", "json"]);

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
	console.log(`Metrics (${snapshot.operational.windowMinutes}m): events=${snapshot.operational.events}; fallbacks=${snapshot.operational.modelFallbacks}; replayed=${snapshot.operational.replayedEvents}; noncompliant=${snapshot.operational.planningNoncompliant}`);
	for (const alert of snapshot.operational.alerts) console.log(`Alert [${alert.severity}] ${alert.code}: ${alert.detail}`);
	if (snapshot.pid) console.log(`PID: ${snapshot.pid}`);
	if (snapshot.startedAt) console.log(`Started: ${snapshot.startedAt}`);
	if (snapshot.lastError) console.log(`Last issue: ${snapshot.lastError}`);
	if (snapshot.logs === "absent") console.log(`Next: beemax start ${config.profile}`);
}

function readProfileLogs(profile: string, agentDir: string, tail: number, scope: "user" | "system"): string {
	let command;
	try { command = resolveServiceLogCommand(profile, tail, { scope }); } catch { return readGatewayLogs(agentDir, tail); }
	if (!command) return readGatewayLogs(agentDir, tail);
	const result = spawnSync(command.command, command.args, { encoding: "utf8" });
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
		const deleting = loadConfig(undefined, profile);
		await assertStandardWebProfileBoundary({ profileHome: deleting.paths.profileHome, agentDir: deleting.paths.agentDir });
		await stopProfileBrowser(deleting.paths.agentDir);
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

async function runBindingCommand(parsed: ParsedArgs): Promise<void> {
	const action = parsed.positionals[1];
	const profile = selectedProfile(parsed);
	const config = loadConfig(parsed.configPath, profile);
	const enabledChannels = config.gateway.channels.filter((channel) => channel.enabled);
	if (action === "activate" || action === "disable") {
		const bindingId = parsed.positionals[2];
		if (!bindingId) throw new Error(`binding ${action} requires a Binding id`);
		const configPath = parsed.configPath ? resolve(parsed.configPath) : resolveProfileLocation(profile).configPath;
		await setProfileBindingEnabled(configPath, bindingId, action === "activate", config.profile);
		console.log(`${action === "activate" ? "Activated" : "Disabled"} Profile Binding '${bindingId}' for Profile '${config.profile}'.`);
		return;
	}
	const resolver = assertProfileBindingConfiguration(config.gateway.bindings, {
		profileId: config.profile,
		channelInstanceIds: enabledChannels.map((channel) => channel.id),
	});
	const enabledBindingCount = config.gateway.bindings.filter((binding) => binding.enabled).length;
	if (action === "validate") {
		console.log(`Profile Binding valid: ${enabledBindingCount} enabled bindings for Profile '${config.profile}'.`);
		return;
	}
	if (action === "explain") {
		const channelInstanceId = optionString(parsed, "channel-instance");
		const conversationId = optionString(parsed, "conversation");
		const accountRef = optionString(parsed, "account");
		const threadId = optionString(parsed, "thread");
		if (!channelInstanceId || !conversationId) throw new Error("binding explain requires --channel-instance <id> and --conversation <id>");
		const explanation = resolver.explain({
			channelInstanceId,
			conversationId,
			...(accountRef ? { accountRef } : {}),
			...(threadId ? { threadId } : {}),
		});
		if (explanation.status !== "matched") throw new Error(explanation.status === "conflict"
			? `Profile Binding conflict at ${explanation.precedence}: ${explanation.candidates.join(", ")}`
			: `No Profile Binding matches Channel Instance ${channelInstanceId}`);
		console.log(`matched profile=${explanation.profileId} binding=${explanation.bindingId} precedence=${explanation.precedence}`);
		return;
	}
	throw new Error("Usage: beemax binding validate | activate <id> | disable <id> | explain --channel-instance <id> --conversation <id> [--account <ref>] [--thread <id>]");
}

async function runChannelCommand(parsed: ParsedArgs): Promise<void> {
	const action = parsed.positionals[1] ?? "list";
	const profile = selectedProfile(parsed);
	if (action === "qr" || action === "create") {
		const url = "https://open.feishu.cn/app";
		console.log(`Open Feishu Developer Console to create/configure a self-built app:\n${url}`);
		console.log("After scanning/signing in, copy App ID and App Secret, then run: beemax setup --profile " + profile);
		if (parsed.options.open === true) {
			const [command, args] = process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
			const child = spawn(command, args, { detached: true, stdio: "ignore" });
			child.once("error", (error) => console.warn(`Could not open browser automatically: ${error.message}`));
			child.unref();
		}
		return;
	}
	if (action === "list") {
		const config = loadConfig(parsed.configPath, profile);
		if (!config.gateway.channels.length) { console.log("No channels configured."); return; }
		for (const channel of config.gateway.channels) {
			const configured = consumeChannelCredential(config, channel, () => true) === true;
			console.log(`${channel.adapter}  ${configured ? "configured" : "not configured"}  id=${channel.id}  ${channel.enabled ? "enabled" : "disabled"}`);
		}
		return;
	}
	if (action === "remove") {
		if (parsed.options.yes !== true) throw new Error("Channel removal requires --yes");
		const platform = parsed.positionals[2] ?? "feishu";
		if (platform === "feishu") await removeFeishuChannel(profile);
		else if (platform === "telegram") await removeTelegramChannel(profile);
		else throw new Error(`Unknown channel adapter: ${platform}`);
		console.log(`Removed ${platform} credentials from Agent '${profile}'.`);
		return;
	}
	if (action === "test") {
		const config = loadConfig(parsed.configPath, profile);
		const platform = parsed.positionals[2] ?? "feishu";
		const instance = config.gateway.channels.find((channel) => channel.enabled && channel.adapter === platform);
		if (!instance) throw new Error(`No enabled ${platform} Channel Instance is configured`);
		const result = await consumeChannelCredential(config, instance, (credential) => credential.adapter === "feishu" && platform === "feishu"
			? testFeishuCredentials({ ...credential, domain: config.gateway.feishu.domain })
			: credential.adapter === "telegram" && platform === "telegram" ? testTelegramCredentials(credential.botToken) : undefined);
		if (result) console.log(result);
		else if (platform === "feishu" || platform === "telegram") throw new Error(`Channel Instance '${instance.id}' has no valid credentials`);
		else throw new Error(`Unknown channel adapter: ${platform}`);
		return;
	}
	if (action === "add" && parsed.positionals[2] === "telegram") {
		const current = loadConfig(parsed.configPath, profile);
		const nonInteractive = parsed.options["non-interactive"] === true || !process.stdin.isTTY;
		const existingInstance = current.gateway.channels.find((channel) => channel.adapter === "telegram");
		const existingBotToken = existingInstance ? consumeChannelCredential(current, existingInstance, (credential) => credential.adapter === "telegram" ? credential.botToken : "") : "";
		let botToken = process.env.TELEGRAM_BOT_TOKEN ?? existingBotToken ?? "";
		let allowedUsers = splitList(optionString(parsed, "allowed-users") ?? process.env.TELEGRAM_ALLOWED_USERS) ?? current.gateway.telegram.allowedUsers;
		if (!nonInteractive) {
			botToken ||= await askOne("Telegram Bot Token: ", true);
			if (!allowedUsers.length) allowedUsers = splitList(await askOne("Allowed Telegram user IDs (comma-separated): ")) ?? [];
		}
		if (!botToken || !allowedUsers.length) throw new Error("Missing Telegram configuration. Set TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USERS or run interactively.");
		await configureTelegramChannel(profile, {
			botToken,
			allowedUsers,
			allowedChats: splitList(optionString(parsed, "allowed-chats")) ?? current.gateway.telegram.allowedChats,
			allowAllUsers: parsed.options["allow-all-users"] === true,
			pollingTimeoutSeconds: current.gateway.telegram.pollingTimeoutSeconds,
			retryBaseDelayMs: current.gateway.telegram.retryBaseDelayMs,
		});
		console.log(`Configured Telegram channel for Agent '${profile}'. Run: beemax channel test telegram --profile ${profile}`);
		return;
	}
	if (action !== "add" || parsed.positionals[2] !== "feishu") {
		throw new Error("Usage: beemax channel add <feishu|telegram> | list | remove <adapter> | test <adapter>");
	}
	const current = loadConfig(parsed.configPath, profile);
	const currentFeishu = current.gateway.feishu;
	const currentFeishuInstance = current.gateway.channels.find((channel) => channel.adapter === "feishu");
	const currentFeishuCredential = currentFeishuInstance ? consumeChannelCredential(current, currentFeishuInstance, (credential) => credential.adapter === "feishu" ? { appId: credential.appId, appSecret: credential.appSecret, webhookVerificationToken: credential.webhookVerificationToken, webhookEncryptKey: credential.webhookEncryptKey } : undefined) : undefined;
	const nonInteractive = parsed.options["non-interactive"] === true || !process.stdin.isTTY;
	let appId = optionString(parsed, "app-id") ?? process.env.FEISHU_APP_ID ?? currentFeishuCredential?.appId ?? "";
	let appSecret = process.env.FEISHU_APP_SECRET ?? currentFeishuCredential?.appSecret ?? "";
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
		groupPolicy: channelGroupPolicy(parsed, currentFeishu.groupPolicy),
		domain: channelDomain(parsed, currentFeishu.domain),
		requireMention: parsed.options["no-require-mention"] === true
			? false
			: parsed.options["require-mention"] === true ? true : currentFeishu.requireMention,
		connectionMode: channelConnectionMode(parsed, currentFeishu.connectionMode),
		webhookHost: optionString(parsed, "webhook-host") ?? currentFeishu.webhookHost,
		webhookPort: webhookPort(parsed, currentFeishu.webhookPort),
		webhookPath: optionString(parsed, "webhook-path") ?? currentFeishu.webhookPath,
		webhookVerificationToken: process.env.FEISHU_WEBHOOK_VERIFICATION_TOKEN ?? currentFeishuCredential?.webhookVerificationToken,
		webhookEncryptKey: process.env.FEISHU_WEBHOOK_ENCRYPT_KEY ?? currentFeishuCredential?.webhookEncryptKey,
	});
	console.log(`Configured Feishu channel for Agent '${profile}'. Run: beemax channel test --profile ${profile}`);
}

async function runPairingCommand(parsed: ParsedArgs): Promise<void> {
	const profile = selectedProfile(parsed);
	const config = loadConfig(undefined, profile);
	const store = new PairingStore(config.paths.agentDir);
	const action = parsed.positionals[1] ?? "list";
	const platform = parsed.positionals[2] ?? "feishu";
	if (action === "list") {
		const state = store.list(platform);
		if (!state.pending.length && !state.approved.length) { console.log(`No ${platform} pairing requests or approvals for Profile '${profile}'.`); return; }
		if (state.pending.length) {
			console.log(`Pending ${platform} pairing requests:`);
			for (const item of state.pending) console.log(`  ${item.code}  ${item.userId}  expires=${new Date(item.expiresAt).toISOString()}`);
		}
		if (state.approved.length) {
			console.log(`Approved ${platform} users:`);
			for (const item of state.approved) console.log(`  ${item.userId}  approved=${new Date(item.approvedAt).toISOString()}`);
		}
		return;
	}
	if (action === "approve") {
		const code = parsed.positionals[3];
		if (!code) throw new Error("Usage: beemax pairing approve <platform> <code> --profile <name>");
		const approved = store.approve(platform, code);
		if (!approved) throw new Error("Pairing code was not found or has expired");
		console.log(`Approved ${approved.userId} for ${platform} on Profile '${profile}'.`);
		return;
	}
	if (action === "revoke") {
		const userId = parsed.positionals[3];
		if (!userId) throw new Error("Usage: beemax pairing revoke <platform> <user_id> --profile <name>");
		if (!store.revoke(platform, userId)) throw new Error(`User ${userId} is not paired for ${platform}`);
		console.log(`Revoked ${userId} for ${platform} on Profile '${profile}'.`);
		return;
	}
	if (action === "clear-pending" || action === "clear") {
		console.log(`Cleared ${store.clearPending(platform)} pending ${platform} pairing request(s).`);
		return;
	}
	throw new Error("Usage: beemax pairing [list | approve <platform> <code> | revoke <platform> <user_id> | clear [platform]] --profile <name>");
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
		groupPolicy: channelGroupPolicy(parsed, undefined),
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

function channelGroupPolicy(parsed: ParsedArgs, fallback: "open" | "allowlist" | "disabled" | undefined): "open" | "allowlist" | "disabled" | undefined {
	const policy = optionString(parsed, "group-policy") ?? process.env.FEISHU_GROUP_POLICY;
	if (policy === undefined) return fallback;
	if (policy !== "open" && policy !== "allowlist" && policy !== "disabled") throw new Error("--group-policy must be open, allowlist, or disabled");
	return policy;
}

function webhookPort(parsed: ParsedArgs, fallback: number | undefined): number | undefined {
	const value = optionString(parsed, "webhook-port");
	if (value === undefined) return fallback;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--webhook-port must be an integer between 1 and 65535");
	return port;
}

async function askOne(prompt: string, secret = false): Promise<string> {
	if (!secret) {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try { return (await rl.question(prompt)).trim(); } finally { rl.close(); }
	}
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

async function runMigrationCommand(parsed: ParsedArgs): Promise<void> {
	const kind = parsed.positionals[1];
	const action = parsed.positionals[2];
	if (!["channel-instance", "session"].includes(kind ?? "") || !["plan", "apply", "rollback"].includes(action ?? "")) {
		throw new Error("Usage: beemax migration <channel-instance|session> <plan|apply|rollback> [manifest] --profile <name>");
	}
	const profile = parsed.profile ?? activeProfile();
	if (kind === "session") {
		const location = resolveProfileLocation(profile, parsed.configPath);
		const config = loadConfig(parsed.configPath, profile);
		if (action === "rollback") {
			const manifestPath = parsed.positionals[3];
			if (!manifestPath) throw new Error("session rollback requires a manifest path");
			if (parsed.options.yes !== true) throw new Error("Session ownership migration rollback requires --yes");
			const result = await rollbackProfileSessionOwnershipMigration({ lockRoot: beemaxHome(), profileHome: location.homePath, agentDir: config.paths.agentDir, profile, manifestPath });
			console.log(`Rolled back Session ownership migration '${result.migrationId}' for Profile '${profile}'.`);
			return;
		}
		const platform = optionString(parsed, "platform");
		const channelInstanceId = optionString(parsed, "channel-instance");
		const chatId = optionString(parsed, "chat-id");
		const legacyUser = optionString(parsed, "legacy-user");
		const chatType = optionString(parsed, "chat-type") ?? (optionString(parsed, "thread") ? "thread" : "group");
		if (!platform || !channelInstanceId || !chatId || !legacyUser || !["group", "thread"].includes(chatType)) {
			throw new Error("session plan/apply requires --platform, --channel-instance, --chat-id, --legacy-user and optional --chat-type <group|thread>");
		}
		const channel = config.gateway.channels.find((candidate) => candidate.id === channelInstanceId);
		if (!channel || !channel.enabled || channel.adapter !== platform) throw new Error(`Configured enabled Channel Instance '${channelInstanceId}' does not belong to platform '${platform}' in Profile '${profile}'`);
		const source = { platform, channelInstanceId, chatId, chatType: chatType as "group" | "thread", userId: legacyUser, ...(optionString(parsed, "thread") ? { threadId: optionString(parsed, "thread") } : {}) };
		const target = { lockRoot: beemaxHome(), profileHome: location.homePath, agentDir: config.paths.agentDir, profile, source };
		const legacySessionId = optionString(parsed, "legacy-session-id");
		if (action === "plan") {
			const plan = await planProfileSessionOwnershipMigration(target, legacySessionId);
			console.log(`Session ownership plan: canonical=${plan.canonicalSessionId}; candidates=${plan.candidates.length}.`);
			for (const candidate of plan.candidates) console.log(`  ${candidate.sessionId}: ${candidate.bytes} bytes · ${candidate.path}`);
			for (const blocker of plan.blockers) console.log(`  BLOCKED: ${blocker}`);
			if (plan.blockers.length > 0) process.exitCode = 1;
			return;
		}
		if (!legacySessionId) throw new Error("session apply requires --legacy-session-id from the plan output");
		if (parsed.options.yes !== true) throw new Error("Session ownership migration apply requires --yes");
		const applied = await applyProfileSessionOwnershipMigration({ ...target, legacySessionId, migrationId: optionString(parsed, "migration-id") });
		console.log(`Migrated legacy Session '${legacySessionId}' to canonical '${applied.result.canonicalSessionId}' for Profile '${profile}'. Manifest: ${applied.manifestPath}`);
		return;
	}
	if (action === "rollback") {
		const manifestPath = parsed.positionals[3];
		if (!manifestPath) throw new Error("channel-instance rollback requires a manifest path");
		if (parsed.options.yes !== true) throw new Error("Channel instance migration rollback requires --yes");
		const config = loadConfig(parsed.configPath, profile);
		const location = resolveProfileLocation(profile, parsed.configPath);
		const result = await rollbackProfileChannelInstanceMigration({
			lockRoot: beemaxHome(),
			profileHome: location.homePath,
			profile,
			dbPath: config.memory.dbPath,
			manifestPath,
		});
		console.log(`Rolled back channel instance migration '${result.migrationId}' for Profile '${profile}'. Post-migration snapshot: ${result.postMigrationBackupPath}`);
		return;
	}

	const platform = optionString(parsed, "platform");
	const channelInstanceId = optionString(parsed, "channel-instance");
	if (!platform || !channelInstanceId) throw new Error("channel-instance plan/apply requires --platform and --channel-instance");
	const config = loadConfig(parsed.configPath, profile);
	const channel = config.gateway.channels.find((candidate) => candidate.id === channelInstanceId);
	if (!channel || !channel.enabled || channel.adapter !== platform) {
		throw new Error(`Configured enabled Channel Instance '${channelInstanceId}' does not belong to platform '${platform}' in Profile '${profile}'`);
	}
	const target = {
		lockRoot: beemaxHome(),
		profile,
		dbPath: config.memory.dbPath,
		platform,
		channelInstanceId,
	};
	if (action === "plan") {
		const plan = await planProfileChannelInstanceMigration(target);
		console.log(`Channel instance ownership plan: ${plan.totalRows} legacy row(s) from '${plan.legacyAddress}' to '${plan.targetAddress}'.`);
		for (const table of plan.tables) console.log(`  ${table.table}: ${table.rows} (${table.storage})`);
		for (const blocker of plan.blockers) console.log(`  BLOCKED: ${blocker}`);
		if (plan.blockers.length > 0) process.exitCode = 1;
		return;
	}

	if (parsed.options.yes !== true) throw new Error("Channel instance migration apply requires --yes");
	const location = resolveProfileLocation(profile, parsed.configPath);
	const applied = await applyProfileChannelInstanceMigration({
		...target,
		profileHome: location.homePath,
		migrationId: optionString(parsed, "migration-id"),
	});
	console.log(`Migrated ${applied.result.totalRows} legacy row(s) in migration '${applied.migrationId}' for Profile '${profile}'. Manifest: ${applied.manifestPath}`);
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
		const source = resolveProfileLocation(name, explicitConfig).homePath;
		const target = join(destination, name);
		const profileConfig = loadConfig(explicitConfig, name);
		const sourceDb = profileConfig.memory.dbPath;
		const dbRelativePath = relative(source, sourceDb);
		const targetDb = dbRelativePath && !dbRelativePath.startsWith("..") && !isAbsolute(dbRelativePath)
			? join(target, dbRelativePath)
			: join(target, "external-data", "memory.db");
		const backupPathFor = (path: string, fallback: string) => {
			const relativePath = relative(source, path);
			return relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath) ? join(target, relativePath) : join(target, "external-data", fallback);
		};
		const targetVault = backupPathFor(profileConfig.credentials.vaultPath, "credentials.vault");
		const targetVaultKey = backupPathFor(profileConfig.credentials.keyPath, "credential-vault.key");
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
				filter: (path) => path !== sourceDb && path !== `${sourceDb}-wal` && path !== `${sourceDb}-shm`
					&& !path.startsWith(`${profileConfig.credentials.vaultPath}.`),
			});
			await stat(sourceDb);
			await mkdir(dirname(targetDb), { recursive: true });
			await backupSqliteDatabase(sourceDb, targetDb);
			verifySqliteDatabase(targetDb);
			if (targetVault !== join(target, relative(source, profileConfig.credentials.vaultPath))) {
				await stat(profileConfig.credentials.vaultPath).then(async () => { await mkdir(dirname(targetVault), { recursive: true }); await copyFile(profileConfig.credentials.vaultPath, targetVault); }).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
			}
			if (targetVaultKey !== join(target, relative(source, profileConfig.credentials.keyPath))) {
				await mkdir(dirname(targetVaultKey), { recursive: true }); await copyFile(profileConfig.credentials.keyPath, targetVaultKey);
			}
			const keyInfo = await stat(targetVaultKey);
			if ((keyInfo.mode & 0o077) !== 0) throw new Error(`Credential Vault key permissions are broader than 0600: ${targetVaultKey}`);
			const backupKey = Buffer.from((await readFile(targetVaultKey, "utf8")).trim(), "base64");
			if (backupKey.byteLength !== 32) throw new Error("Credential Vault backup key is invalid");
			const sourceVaultExists = await stat(profileConfig.credentials.vaultPath).then(() => true).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; });
			if (sourceVaultExists) new FileCredentialVault(targetVault, backupKey).list(`profile:${name}`);
		} catch (error) {
			await rm(target, { recursive: true, force: true });
			throw new Error(`Profile backup verification failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		console.log(`Backed up Agent '${name}' to ${target} (SQLite snapshot verified; Credential Vault verified).`);
		return;
	}
	if (action === "delete") {
		if (parsed.options.yes !== true) throw new Error("Profile deletion requires --yes; runtime data is preserved");
		const deleting = loadConfig(explicitConfig, name);
		await assertStandardWebProfileBoundary({ profileHome: deleting.paths.profileHome, agentDir: deleting.paths.agentDir });
		await stopProfileBrowser(deleting.paths.agentDir);
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
	const config = loadConfig(parsed.configPath, profile);
	if (action === "inspect") {
		const source = typeof parsed.options.from === "string" ? parsed.options.from : parsed.positionals[2];
		if (!source) throw new Error("Usage: beemax skills inspect --from /absolute/path/to/skill [--json]");
		const result = await inspectLocalSkill(source);
		if (parsed.options.json === true) console.log(JSON.stringify(result));
		else console.log(`${result.name}  sha256=${result.sha256}  files=${result.fileCount}  bytes=${result.totalBytes}`);
		return;
	}
	if (action === "sync") {
		await syncBuiltinSkills(profile, {}, config.paths.agentDir);
		await assertStandardWebProfileBoundary({ profileHome: config.paths.profileHome, agentDir: config.paths.agentDir });
		console.log(`Synced bundled Skills into Agent '${profile}' without replacing existing skills.`);
		return;
	}
	if (action === "install") {
		const name = parsed.positionals[2];
		const source = typeof parsed.options.from === "string" ? parsed.options.from : name !== "pi-web-access" ? name : undefined;
		if (source) {
			const expectedSha256 = typeof parsed.options.sha256 === "string" ? parsed.options.sha256 : "";
			await assertStandardWebProfileBoundary({ profileHome: config.paths.profileHome, agentDir: config.paths.agentDir });
			const result = await installLocalSkill({ profileHome: config.paths.profileHome, agentDir: config.paths.agentDir, source, expectedSha256 });
			console.log(`Installed digest-pinned local Skill '${result.name}' for Profile '${profile}'.\nSHA-256: ${result.sha256}\nPath: ${result.destination}`);
			return;
		}
		if (name !== "pi-web-access") throw new Error("Usage: beemax skills install pi-web-access | --from /absolute/path/to/skill --sha256 <digest> --profile <name>");
		await syncBuiltinSkills(profile, {}, config.paths.agentDir);
		await assertStandardWebProfileBoundary({ profileHome: config.paths.profileHome, agentDir: config.paths.agentDir });
		await requirePackagedStandardWebSkill(config.paths.agentDir, "pi-web-access");
		const result = await installPiWebAccess();
		console.log(`${result.installed ? "Installed" : "Verified"} pinned Pi Web Access revision ${result.revision.slice(0, 12)} for Profile '${profile}'.\nRuntime: ${result.path}\nBrowser state is isolated to this Profile; no personal Chrome profile or Cookie values are copied.`);
		return;
	}
	if (action !== "list") throw new Error("Usage: beemax skills [list | sync | inspect --from <path> | install pi-web-access | install --from <path> --sha256 <digest>] --profile <name>");
	await assertStandardWebProfileBoundary({ profileHome: config.paths.profileHome, agentDir: config.paths.agentDir });
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
		await visit(join(config.paths.agentDir, "skills"));
	} catch { /* no Skills directory yet */ }
	if (parsed.options.json === true) { console.log(JSON.stringify({ profile, skills: skills.sort((a, b) => a.name.localeCompare(b.name)) })); return; }
	console.log(skills.sort((a, b) => a.name.localeCompare(b.name)).map((skill) => `${skill.name}  sha256=${skill.sha256.slice(0, 12)}  ${skill.description}`).join("\n") || "No Profile Skills installed. Run: beemax skills sync --profile " + profile);
}

async function runCapabilitiesCommand(parsed: ParsedArgs): Promise<void> {
	if (parsed.configPath) throw new Error("beemax capabilities does not support --config; select a Profile with --profile");
	const action = parsed.positionals[1] ?? "status";
	const target = parsed.positionals[2];
	const profile = selectedProfile(parsed);
	if (!(await listProfiles()).includes(profile)) throw new Error(`Agent profile ${profile} does not exist`);
	const paths = resolveProfileLocation(profile);
	let config = loadConfig(undefined, profile);
	let capabilityEnvironment = { ...profileEnvironmentSnapshot(config) };
	let capabilityIntegrityKey = profileProviderIntegrityKey(config.credentials.key, profile);
	let packInput = {
		profile,
		profileHome: paths.homePath,
		agentDir: config.paths.agentDir,
		installation: config.capabilityProviders.installation,
		integrityKey: capabilityIntegrityKey,
		environment: capabilityEnvironment,
	};
	if (action === "status") {
		if (target) throw new Error("Usage: beemax capabilities status --profile <name> [--json]");
		await assertStandardWebProfileBoundary({ profileHome: paths.homePath, agentDir: config.paths.agentDir });
		const status = await inspectStandardWebPack(packInput);
		if (parsed.options.json === true) console.log(JSON.stringify(status));
		else console.log(renderStandardWebStatus(status));
		return;
	}
	if (action === "start") {
		if (target !== "pi-web-access") throw new Error("Usage: beemax capabilities start pi-web-access --profile <name>");
		await assertStandardWebProfileBoundary({ profileHome: paths.homePath, agentDir: config.paths.agentDir });
		const browser = await startProfileBrowser(config.paths.agentDir);
		console.log(`Started Profile-isolated Pi Web Access browser for '${profile}' at ${browser.cdpUrl}. State: ${browser.dataDir}`);
		return;
	}
	if (action === "stop") {
		if (target !== "pi-web-access") throw new Error("Usage: beemax capabilities stop pi-web-access --profile <name>");
		await assertStandardWebProfileBoundary({ profileHome: paths.homePath, agentDir: config.paths.agentDir });
		const browser = await stopProfileBrowser(config.paths.agentDir);
		console.log(`Stopped Profile-isolated Pi Web Access browser for '${profile}'. State remains isolated at ${browser.dataDir}.`);
		return;
	}
	if (action !== "install") throw new Error("Usage: beemax capabilities status | install <standard-web|exa-web-search|agent-reach|pi-web-access> | start | stop pi-web-access --profile <name>");
	if (!target || !["standard-web", "exa-web-search", "agent-reach", "pi-web-access"].includes(target)) throw new Error("Usage: beemax capabilities install <standard-web|exa-web-search|agent-reach|pi-web-access> --profile <name>");
	await syncBuiltinSkills(profile, {}, config.paths.agentDir);
	await assertStandardWebProfileBoundary({ profileHome: paths.homePath, agentDir: config.paths.agentDir });
	if (target === "standard-web" || target === "agent-reach") await requirePackagedStandardWebSkill(config.paths.agentDir, "agent-reach");
	if (target === "standard-web" || target === "pi-web-access") await requirePackagedStandardWebSkill(config.paths.agentDir, "pi-web-access");
	if (target === "standard-web" || target === "exa-web-search") {
		await enableStandardWebProvider(profile);
		config = loadConfig(undefined, profile);
		capabilityEnvironment = { ...profileEnvironmentSnapshot(config) };
		capabilityIntegrityKey = profileProviderIntegrityKey(config.credentials.key, profile);
		packInput = {
			...packInput,
			installation: config.capabilityProviders.installation,
			integrityKey: capabilityIntegrityKey,
			environment: capabilityEnvironment,
		};
	}
	if (target === "agent-reach") {
		console.log(`Installed BeeMax-native Agent Reach routing Skill for Profile '${profile}'. Login-backed channels remain explicit customer opt-ins.`);
		return;
	}
	if (target === "pi-web-access") {
		const result = await installPiWebAccess();
		console.log(`Verified native Pi Web Access ${result.revision} for Profile '${profile}' at ${result.path}. Start its isolated browser with: beemax capabilities start pi-web-access --profile ${profile}`);
		return;
	}
	if (target === "exa-web-search") {
		const result = await installProfileExaMcporter({
			profileId: profile,
			agentDir: config.paths.agentDir,
			installation: config.capabilityProviders.installation,
			integrityKey: capabilityIntegrityKey,
			environment: capabilityEnvironment,
		});
		console.log(`Installed and verified the pinned Exa MCP adapter for Profile '${profile}' (${result?.evidenceRef ?? "existing verified artifact"}).`);
		return;
	}
	const result = await installStandardWebRuntime(packInput);
	console.log(`Installed standard-web runtime for Profile '${profile}'.\nExa MCP: ${result.exaEvidenceRef ?? "existing verified artifact"}\nPi Web Access: ${result.pi.evidenceRef} (native)`);
}

function renderStandardWebStatus(status: StandardWebPackStatus): string {
	return [
		`Standard Web pack v${status.version} · Profile ${status.profile}`,
		...status.components.map((component) => `${component.id}  [${component.state}]  ${component.detail}`),
		"Install all runtime payloads now: beemax capabilities install standard-web --profile " + status.profile,
	].join("\n");
}

async function requirePackagedStandardWebSkill(agentDir: string, skill: StandardWebSkillId): Promise<void> {
	const state = await inspectStandardWebSkill(agentDir, skill);
	if (state !== "installed") throw new Error(state === "customized"
		? `Profile-local Skill '${skill}' differs from BeeMax's packaged revision and was preserved. Review or remove it explicitly before installing the BeeMax-native Skill.`
		: `BeeMax-native Skill '${skill}' could not be verified after synchronization (state=${state}).`);
}

async function runMcpCommand(parsed: ParsedArgs, config: ReturnType<typeof loadConfig>): Promise<void> {
	const action = parsed.positionals[1] ?? "status";
	if (action === "add") {
		const name = parsed.positionals[2];
		const descriptorPath = typeof parsed.options.from === "string" ? parsed.options.from : undefined;
		if (!name || !descriptorPath) throw new Error("Usage: beemax mcp add <name> --from /absolute/path/server.json --profile <name>");
		if (!config.mcp.profileHome) throw new Error("MCP self-service installation requires a Profile-local MCP config");
		const result = await addProfileMcpServer({ profileHome: config.mcp.profileHome, configPath: config.mcp.configPath, name, descriptorPath });
		console.log(`Installed MCP server '${name}' for Profile '${config.profile}' without exposing descriptor secrets.\nConfig: ${result.configPath}\nRun: beemax mcp status --profile ${config.profile}`);
		return;
	}
	if (action === "remove") {
		const name = parsed.positionals[2];
		if (!name) throw new Error("Usage: beemax mcp remove <name> --profile <name>");
		if (!config.mcp.profileHome) throw new Error("MCP self-service removal requires a Profile-local MCP config");
		const result = await removeProfileMcpServer({ profileHome: config.mcp.profileHome, configPath: config.mcp.configPath, name });
		console.log(`Removed MCP server '${name}' from Profile '${config.profile}'.\nConfig: ${result.configPath}`);
		return;
	}
	if (action !== "status") throw new Error("Usage: beemax mcp [status | add <name> --from <descriptor.json> | remove <name>] --profile <name>");
	const mcp = new McpManager({ environment: profileEnvironmentSnapshot(config) });
	try {
		const statuses = await mcp.connectAll(loadMcpConfig(config.mcp.configPath, config.mcp.profileHome ? { profileHome: config.mcp.profileHome } : {}));
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
	const store = new MemoryStore(config.memory.dbPath, config.profile);
	const localMemoryScope = { profileId: config.profile, platform: "cli" as const, chatId: "local", userId: "local" };
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

async function runAutonomyCommand(parsed: ParsedArgs, config: ReturnType<typeof loadConfig>): Promise<void> {
	const action = parsed.positionals[1] ?? "status";
	const store = new MemoryStore(config.memory.dbPath, config.profile);
	try {
		if (action === "status") {
			const rollout = new AutonomyRolloutController({ store: memoryPersistencePorts(store).autonomyRollout });
			console.log(renderAutonomyRollout(rollout.snapshot()));
			return;
		}
		const levelInput = parsed.positionals[2];
		if (!levelInput || !(AUTONOMY_LEVELS as readonly string[]).includes(levelInput)) {
			throw new Error(`Usage: beemax autonomy [status | promote <${AUTONOMY_LEVELS.join("|")}> | stop <level> | rollback <level> | resume <level>] --profile <name>`);
		}
		const level = levelInput as AutonomyLevel;
		if (parsed.options.yes !== true) throw new Error(`autonomy ${action} requires --yes`);
		if (action === "stop" || action === "rollback") {
			const evidenceRef = optionString(parsed, "evidence-ref");
			if (!evidenceRef) throw new Error(`autonomy ${action} requires --evidence-ref <auditable-reference>`);
			const authority: AutonomyRolloutAuthority = { actor: "operator", evidenceRef };
			const rollout = new AutonomyRolloutController({ store: memoryPersistencePorts(store).autonomyRollout });
			const record = action === "stop" ? rollout.stop(level, authority) : rollout.rollback(level, authority);
			console.log(`${action === "stop" ? "Stopped" : "Rolled back"} ${record.level} at revision ${record.revision}.`);
			return;
		}
		if (action !== "promote" && action !== "resume") throw new Error("Autonomy action must be status, promote, stop, rollback, or resume");
		const { evidence, evidenceRef } = loadInstalledAutonomyRolloutEvidence();
		const authority: AutonomyRolloutAuthority = { actor: "operator", evidenceRef };
		const rollout = new AutonomyRolloutController({ store: memoryPersistencePorts(store).autonomyRollout, evidence: () => evidence });
		const decision = action === "promote" ? rollout.promote(level, authority) : rollout.resume(level, authority);
		if (decision.outcome === "rejected") throw new Error(`Autonomy ${action} rejected: ${decision.reasons.join("; ")}`);
		console.log(`${action === "promote" ? "Promoted" : "Resumed"} ${level} at revision ${decision.record?.revision}.`);
	} finally {
		store.close();
	}
}

async function runCredentialCommand(parsed: ParsedArgs, config: ReturnType<typeof loadConfig>): Promise<void> {
	if (parsed.options.secret !== undefined) throw new Error("Do not pass Credential Secrets in argv; use the interactive prompt or BEEMAX_CREDENTIAL_SECRET");
	if (!config.credentials.key) throw new Error(`Credential Vault key is missing for Profile '${config.profile}'; recreate or migrate the Profile before storing credentials`);
	const audit = new FileCredentialVaultAuditJournal(join(config.paths.agentDir, "credential-audit.jsonl"));
	const vault = new FileCredentialVault(config.credentials.vaultPath, Buffer.from(config.credentials.key, "base64"), (event) => audit.append(event));
	const action = parsed.positionals[1] ?? "list";
	const ownerKey = `profile:${config.profile}`;
	if (action === "list") {
		const credentials = vault.list(ownerKey);
		console.log(credentials.map((credential) => `${credential.ref}  ${credential.label}  ${credential.purpose}${credential.lastUsedAt ? `  last_used=${new Date(credential.lastUsedAt).toISOString()}` : ""}`).join("\n") || "No credentials stored.");
		return;
	}
	if (action === "remove") {
		const ref = parsed.positionals[2];
		if (!ref || parsed.options.yes !== true) throw new Error("Usage: beemax credentials remove <credential_ref> --yes --profile <name>");
		if (!vault.remove(ownerKey, ref)) throw new Error(`Credential Ref not found: ${ref}`);
		console.log(`Removed Credential Ref ${ref}.`);
		return;
	}
	if (action === "rotate") {
		const ref = parsed.positionals[2];
		if (!ref) throw new Error("Usage: beemax credentials rotate <credential_ref> --profile <name>");
		let secret = process.env.BEEMAX_CREDENTIAL_SECRET;
		if (!secret && parsed.options["non-interactive"] !== true && process.stdin.isTTY) secret = await askOne("New Credential Secret: ", true);
		if (!secret) throw new Error("New Credential Secret is required through the interactive prompt or BEEMAX_CREDENTIAL_SECRET");
		if (!vault.rotate(ownerKey, ref, secret)) throw new Error(`Credential Ref not found: ${ref}`);
		console.log(`Rotated Credential Ref ${ref}.`);
		return;
	}
	if (action !== "add") throw new Error("Usage: beemax credentials [add | list | rotate | remove] --profile <name>");
	const label = optionString(parsed, "label");
	const purpose = optionString(parsed, "purpose");
	if (!label || !purpose) throw new Error("credentials add requires --label <label> and --purpose <purpose>");
	let secret = process.env.BEEMAX_CREDENTIAL_SECRET;
	if (!secret && parsed.options["non-interactive"] !== true && process.stdin.isTTY) secret = await askOne("Credential Secret: ", true);
	if (!secret) throw new Error("Credential Secret is required through the interactive prompt or BEEMAX_CREDENTIAL_SECRET");
	const credential = vault.put({ ownerKey, label, purpose, secret });
	console.log(`Stored Credential Ref ${credential.ref} for ${credential.label}.`);
}

async function runTaskCommand(parsed: ParsedArgs, config: ReturnType<typeof loadConfig>): Promise<void> {
	const action = parsed.positionals[1] ?? "list";
	const store = new MemoryStore(config.memory.dbPath, config.profile);
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

async function promptLine(message: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try { return await rl.question(message); } finally { rl.close(); }
}

async function runChat(config: ReturnType<typeof loadConfig>, requestedMode: { full: boolean; compact: boolean; plain: boolean; noAltScreen: boolean; once?: string; thread?: string }): Promise<void> {
	await syncBuiltinSkillsAtProfileHome(config.paths.profileHome, config.paths.agentDir);
	await assertStandardWebProfileBoundary({ profileHome: config.paths.profileHome, agentDir: config.paths.agentDir });
	const presentationMode: ChatPresentationMode = resolveChatPresentationMode({
		...requestedMode, isInputTty: process.stdin.isTTY === true, isOutputTty: process.stdout.isTTY === true, term: process.env.TERM,
	});
	const apiKey = config.model.apiKey ?? "";
	const profileAuth = AuthStorage.create(join(config.paths.agentDir, "auth.json"));
	const cognitionModels = await resolveProfileCognitionModels(config, (provider) => profileAuth.getApiKey(provider, { includeFallback: false }));
	const capabilityProviders = createProfileCapabilityProviderBundle({
		profileId: config.profile,
		agentDir: config.paths.agentDir,
		installation: config.capabilityProviders.installation,
		integrityKey: profileProviderIntegrityKey(config.credentials.key, config.profile),
		environment: profileEnvironmentSnapshot(config),
	});
	const modelCatalog = new ProfileModelCatalog(config);
	const memory = new MemoryStore(config.memory.dbPath, config.profile);
	const persistence = memoryPersistencePorts(memory);
	const autonomyRollout = new AutonomyRolloutController({ store: persistence.autonomyRollout });
	const auxiliaryTextModels = configuredAuxiliaryTextModels(config);
	const memoryLearningExtractor = new ProgressiveLearningExtractor(
		new DeterministicLearningExtractor(),
		auxiliaryTextModels.length ? new PiLearningExtractor({ models: auxiliaryTextModels }) : undefined,
	);
	let admitLearningObjectiveCandidate: LearningObjectiveAdmissionPort["admit"] = async () => ({ status: "deferred", reasonCode: "objective_runtime_starting" });
	let wakeMemoryLearning: () => void = () => undefined;
	const memoryLearningKernel = new DefaultMemoryLearningKernel({
		authority: persistence.memoryLearningAuthority,
		extractor: memoryLearningExtractor,
		learningObjectiveAdmission: { admit: (candidate) => admitLearningObjectiveCandidate(candidate) },
		onSignal: () => wakeMemoryLearning(),
	});
	const knowledgeProvider = config.knowledge.enabled && config.knowledge.apiKey && config.knowledge.spaces.length
		? new WeKnoraKnowledgeProvider({ baseUrl: config.knowledge.baseUrl, apiKey: config.knowledge.apiKey })
		: undefined;
	const mcp = new McpManager({ environment: profileEnvironmentSnapshot(config) });
	await mcp.connectAll(loadMcpConfig(config.mcp.configPath, config.mcp.profileHome ? { profileHome: config.mcp.profileHome } : {}));
	const credentialAudit = new FileCredentialVaultAuditJournal(join(config.paths.agentDir, "credential-audit.jsonl"));
	const credentialVault = config.credentials.key ? new FileCredentialVault(config.credentials.vaultPath, Buffer.from(config.credentials.key, "base64"), credentialAudit.append.bind(credentialAudit)) : undefined;
	const contractAdmissionIntegrity = config.credentials.key ? createContractAdmissionReceiptIntegrity({ key: Buffer.from(config.credentials.key, "base64"), profileId: config.profile }) : undefined;
	const artifactRuntime = config.execution.mode === "off" ? createLocalArtifactRuntime(config.paths.cwd) : undefined;

	let source: SessionSource = {
		platform: "cli",
		chatId: "local",
		chatType: "dm",
		userId: "local",
		...(requestedMode.thread ? { threadId: requestedMode.thread } : {}),
	};
	const readOnlyMcpTools = mcp.getTools().filter((tool) => tool.beemaxPolicy?.sideEffect === "none");
	const proactivePolicies = new ToolPolicyRegistry(readOnlyMcpTools);
	const proactiveCapabilities = executionSafeTools(config, readOnlyAgentTools(readOnlyMcpTools.map((tool) => tool.name)))
		.map((name) => ({ name, policy: proactivePolicies.get(name), reliability: "unknown" as const }))
		.filter((capability) => capability.policy.sideEffect === "none");
	const capabilityRanker = configuredCapabilityRanker(
		auxiliaryTextModels,
		(usage) => recordGatewayEvent(config.paths.agentDir, "capability_cognition", { profile: config.profile, ...usage }),
		config.agent.capabilityCognition,
	);
	const createSubagentAgent = buildAgentFactory({
		profileId: config.profile,
		capabilityRanker,
		capabilityPreferences: config.agent.capabilityPreferences,
		managedSkillLearning: persistence.managedSkillLearning,
		capabilityProviderRuntime: capabilityProviders.runtime,
		capabilityProviderEnvironment: capabilityProviders.environment,
		skillEnvironment: profileEnvironmentSnapshot(config),
		capabilityProviderIntegrityKey: capabilityProviders.artifactIntegrityKey,
		provider: () => config.model.provider,
		model: () => config.model.model,
		baseUrl: () => config.model.baseUrl,
		customProtocol: () => config.model.customProtocol,
		modelLimits: () => ({ contextWindow: config.model.contextWindow, maxTokens: config.model.maxTokens }),
		cwd: config.paths.cwd,
		agentDir: config.paths.agentDir,
		getApiKey: (provider: string) => config.model.apiKeys[provider] ?? (provider === config.model.provider ? apiKey : undefined),
		additionalModelProviders: () => configuredRuntimeModels(config).map((model) => model.provider),
		compaction: config.context.compaction,
		toolResultBudget: { maxEstimatedTokens: config.context.maxToolResultTokens },
		systemPrompt: buildSubagentSystemPrompt(config.agent.systemPrompt),
		memoryStore: memory,
		executionPortForSource: executionPortFor(config),
		artifactRuntime,
		customTools: readOnlyMcpTools,
		tools: executionSafeTools(config, subagentExecutionTools(readOnlyMcpTools.map((tool) => tool.name))),
		sessionTools: (sessionSource) => createTaskLedgerTools(memory, sessionSource),
		compactionInstructions: (sessionSource) => sessionSource.delegatedTask ? buildTaskPreservationEnvelope(memory.queryTasks({ ownerKeys: [sessionSource.delegatedTask.ownerKey], id: sessionSource.delegatedTask.id, limit: 1 })) : undefined,
	});
	let objectiveCompletionDelivery: ObjectiveCompletionDeliveryService | undefined;
	const profileRuntime = await createProfileRuntime<SessionSource>({
		work: {
		agentDir: config.paths.agentDir, ledger: persistence.taskLedger, recoveryQueue: persistence.recoveryQueue, maxConcurrent: config.subagents.maxConcurrent,
		maxSubagents: config.subagents.maxChildrenPerOwner, taskTimeoutMs: 0, subagentsEnabled: config.subagents.enabled,
		backgroundRecoveryEnabled: requestedMode.once === undefined,
		memoryLearning: {
			profileId: config.profile,
			kernel: memoryLearningKernel,
			onError: (error) => process.stderr.write(`Memory Learning maintenance failed: ${error instanceof Error ? error.message : String(error)}\n`),
		},
		executeTask: (task, signal, context, executionTrace, effectAuthority) => executePlannedTask(createSubagentAgent, task, task.executionScope as SessionSource, signal, null, context, executionTrace, effectAuthority, persistence.taskLedger),
		verifyTaskCandidate: (task, result, signal, context, executionTrace) => createTaskVerifier(createSubagentAgent, null, executionTrace, verificationAgentToolsForTask(readOnlyMcpTools, task, context?.successfulToolNames))(task, result, signal, context),
		deliverObjective: (input, signal, executionTrace) => executeObjectiveDelivery(createSubagentAgent, input, signal, null, executionTrace),
		publishVerifiedOutcome: guardVerifiedObjectiveMemoryPublisher(autonomyRollout, createVerifiedObjectiveMemoryPublisher(persistence.organizationMemory)),
		deliverDirectObjectiveVerification: async (task, resolution) => {
			if (resolution.accepted) { objectiveCompletionDelivery?.wake(); return; }
			process.stdout.write(`\nTask failed independent Verification: ${resolution.feedback}\n`);
		},
		executeSubagent: (task, signal, executionTrace) => executeSubagentTask(createSubagentAgent, task, signal, undefined, undefined, undefined, executionTrace, undefined, undefined, persistence.taskLedger),
		onTaskPlanError: ({ planId, error }) => process.stderr.write(`Background Task Plan ${planId} failed: ${redactCredentialMaterial(error instanceof Error ? error.message : String(error))}\n`),
		onRecoveryStatus: (_status, cycle) => {
			if (!cycle) return;
			const { reconciled, verification, recovery: summary } = cycle;
			if (reconciled.retried || reconciled.failed) process.stdout.write(`Recovered interrupted Tasks: retry=${reconciled.retried}; failed=${reconciled.failed}.\n`);
			if (verification.attempted) process.stdout.write(`Retried Candidate Verification: attempted=${verification.attempted}; accepted=${verification.accepted}; rejected=${verification.rejected}; unavailable=${verification.unavailable}.\n`);
			if (summary.plans) process.stdout.write(`Resumed ${summary.plans} Task Plan(s): succeeded=${summary.succeeded}; failed=${summary.failed}; blocked=${summary.blocked.length}.\n`);
		},
		onRecoveryError: (error) => process.stderr.write(`Task recovery failed: ${error instanceof Error ? error.message : String(error)}\n`),
		},
		resources: [
			{ name: "memory", dispose: () => memory.close() },
			{ name: "capability", dispose: () => mcp.close() },
		],
		compose: (work) => {
			const { taskScheduler, planningBudgets, taskPlanRuntime, verifyTask, taskRecovery, objectiveRuntime, subagents, toolEffects, executionTrace } = work;
			const createAgent = buildAgentFactory({
		profileId: config.profile,
		capabilityRanker,
		capabilityPreferences: config.agent.capabilityPreferences,
		managedSkillLearning: persistence.managedSkillLearning,
			capabilityProviderRuntime: capabilityProviders.runtime,
			capabilityProviderEnvironment: capabilityProviders.environment,
			skillEnvironment: profileEnvironmentSnapshot(config),
			capabilityProviderIntegrityKey: capabilityProviders.artifactIntegrityKey,
		provider: () => config.model.provider,
		model: () => config.model.model,
		baseUrl: () => config.model.baseUrl,
		customProtocol: () => config.model.customProtocol,
		modelLimits: () => ({ contextWindow: config.model.contextWindow, maxTokens: config.model.maxTokens }),
		cwd: config.paths.cwd,
		agentDir: config.paths.agentDir,
		getApiKey: (provider: string) => config.model.apiKeys[provider] ?? (provider === config.model.provider ? apiKey : undefined),
		additionalModelProviders: () => configuredRuntimeModels(config).map((model) => model.provider),
		compaction: config.context.compaction,
		toolResultBudget: { maxEstimatedTokens: config.context.maxToolResultTokens },
		systemPrompt: buildMainAgentSystemPrompt(config.agent.systemPrompt),
		memoryStore: memory,
		executionPortForSource: executionPortFor(config),
		artifactRuntime,
		customTools: mcp.getTools(),
		tools: executionSafeTools(config, mainAgentTools(config.agent.toolset, [
			...mcp.getTools().map((tool) => tool.name),
			...(knowledgeProvider ? ["knowledge_retrieve"] : []),
		])),
		verifySkillCandidate: createSkillCandidateVerifier(createSubagentAgent, config.subagents.timeoutMs, memory, executionTrace),
		authorizeSkillCandidatePromotion: async (sessionSource, input) => memory.authorizeWorkflowSkillPromotion(input.source, { profileId: config.profile, platform: sessionSource.platform, chatId: sessionSource.chatId, ...(sessionSource.userId ? { userId: sessionSource.userId } : {}), ...(sessionSource.threadId ? { threadId: sessionSource.threadId } : {}) }, { name: input.name, sha256: input.sha256 }),
		toolEffects,
			compactionInstructions: (sessionSource) => buildActiveTaskPreservationEnvelope(memory, sessionSource),
		credentials: credentialVault ? { ownerKey: `profile:${config.profile}`, vault: credentialVault } : undefined,
		sessionTools: (sessionSource) => [
			...(subagents ? [
				...createSubagentTools(subagents, sessionSource, { objectiveTaskId: () => planningBudgets.currentObjectiveTaskId(conversationKey(sessionSource)) }),
				...createTaskOrchestrationTools(memory, sessionSource, (task, signal, context) => taskScheduler.run(task.ownerKey, () => executePlannedTask(createSubagentAgent, task, sessionSource, signal, null, context, executionTrace, toolEffects, persistence.taskLedger), signal), { maxConcurrent: config.subagents.maxConcurrent, planRuntime: taskPlanRuntime, verify: verifyTask, planningDecision: () => planningBudgets.current(conversationKey(sessionSource)), objectiveTaskId: () => planningBudgets.currentObjectiveTaskId(conversationKey(sessionSource)), executionTrace }),
			] : []),
			...createTaskLedgerTools(memory, sessionSource),
			...(knowledgeProvider ? createKnowledgeTools(knowledgeProvider, sessionSource, {
				profileId: config.profile,
				spaces: config.knowledge.spaces,
			}) : []),
		],
			});
			return {
		profileId: config.profile,
		agentDir: config.paths.agentDir,
		policy: { maxSessions: config.agent.maxSessions, sessionIdleMs: config.agent.sessionIdleMs },
			runtime: {
			createAgent,
			interactiveAdmission: "model_first",
			interruptObjectiveWork: (sessionSource, cancellation) => {
				const ownerKeys = responsibilityOwnerKeys(sessionSource);
				let pendingExecutions = 0;
				for (const planId of cancellation.planIds) {
					taskRecovery.cancel(ownerKeys, planId);
				}
				let interruptedEffects = 0;
				for (const taskId of cancellation.taskIds) interruptedEffects += toolEffects.interruptTask(taskId);
				const ownerKey = cancellation.ownerKey;
				pendingExecutions += memory.objectiveInterruptionConvergence(ownerKey, cancellation.objectiveId).pendingExecutions;
				pendingExecutions += toolEffects.unresolvedTaskEffects?.({ ownerKey, taskIds: cancellation.taskIds }) ?? 0;
				return { interruptedEffects, pendingExecutions };
			},
			...createInteractiveContractCognition(cognitionModels),
			contractAdmissionIntegrity,
			requireContractAdmissionIntegrity: true,
			fallbackModels: configuredRuntimeModels(config),
			mediaUnderstanding: configuredMediaUnderstanding(config, createLocalMediaUnderstandingAdapters(config.mediaUnderstanding.localOcr)),
			context: createTaskAwareConversationContext(memory, { memoryScope: { profileId: config.profile }, organizationSituationAllowed: () => autonomyRollout.allows("situation_context").allowed, memoryLearningKernel, memoryLearningAllowed: () => autonomyRollout.allows("adaptive_learning").allowed, runtimeSnapshot: () => ({ profile: config.profile }), maxContextChars: config.context.maxTurnChars }),
		},
		cancelSubagents: (sessionSource) => subagents?.cancelOwner(sessionSource) ?? 0,
		cancelTaskPlans: (sessionSource) => {
			const ownerKey = responsibilityOwnerKey(sessionSource);
			const planIds = [...new Set([...taskPlanRuntime.activePlanIds([ownerKey]), ...objectiveRuntime.planIdsForOwner(ownerKey)])];
			const cancelled = planIds.reduce((count, planId) => count + (taskRecovery.cancel([ownerKey], planId).tasks > 0 ? 1 : 0), 0);
			objectiveRuntime.cancelPlans(ownerKey, planIds);
			return cancelled;
		},
		controlHandler: (profileRuntime, profileInteraction) => createProfileControlHandler(profileRuntime, config, profileInteraction, () => ({ taskScheduler: taskScheduler.snapshot(), taskRecovery: work.recoveryStatus() }), config.subagents.enabled ? {
			verifyTaskPlan: (sessionSource, planId) => taskRecovery.reverify(responsibilityOwnerKeys(sessionSource), planId),
			retryTaskPlan: (sessionSource, planId) => taskRecovery.retry(responsibilityOwnerKeys(sessionSource), planId, { maxConcurrent: config.subagents.maxConcurrent }),
			resumeTaskPlan: (sessionSource, planId) => taskRecovery.resume(responsibilityOwnerKeys(sessionSource), planId, { maxConcurrent: config.subagents.maxConcurrent }),
			cancelTaskPlan: (sessionSource, planId) => taskRecovery.cancel(responsibilityOwnerKeys(sessionSource), planId),
		} : undefined),
			};
		},
	});
	wakeMemoryLearning = () => profileRuntime.work.memoryLearning?.wake();
	const { work } = profileRuntime;
	const { taskScheduler, planningBudgets, taskPlanRuntime, verifyTask, taskRecovery, objectiveRuntime, subagents } = work;
	const { runtime, interaction: interactionAdapter } = profileRuntime;
	const proactiveInvestigation = new ProactiveInvestigationRuntime({
		ledger: persistence.taskLedger,
		governance: new ActionGovernance(),
		metrics: { record: (event) => recordGatewayEvent(config.paths.agentDir, "proactive_investigation", { profile: config.profile, source: "memory_learning", ...event }) },
		execute: async (input) => {
			const timeoutMs = Math.max(1_000, (input.budget.deadlineAt ?? Date.now() + 60_000) - Date.now());
			const executionEnvelope = createExecutionEnvelope({
				executionId: `learning:${input.observation.id}:${input.objective.id}`,
				trigger: { kind: "automation", id: input.observation.triggerId },
				objectiveId: input.objective.id,
				taskId: input.objective.id,
				budget: input.budget,
				mode: "normal",
			});
			const result = await runProfileAutomation(runtime, input.executionScope as SessionSource, input.prompt, {
				key: `learning:${input.observation.dedupeKey}`,
				timeoutMs,
				objectiveTaskId: input.objective.id,
				allowedCapabilities: input.allowedCapabilities,
				executionEnvelope,
			});
			const settled = memory.queryTasks({ ownerKeys: [input.objective.ownerKey], id: input.objective.id, kinds: ["objective"], limit: 1 })[0];
			const materialResult = Boolean(result.completionId && isVerifiedAutomationOutcome(settled));
			return { status: settled?.status === "cancelled" ? "cancelled" : materialResult ? "succeeded" : "failed", materialResult };
		},
	});
	admitLearningObjectiveCandidate = (candidate) => admitLearningObjectiveThroughRuntime(candidate, {
		allowsReadOnlyInvestigation: () => autonomyRollout.allows("read_only_investigation").allowed,
		runtime: proactiveInvestigation,
		capabilities: proactiveCapabilities,
	});
	wakeMemoryLearning();
	let fullScreenActive = false;
	let fullInput: FullWorkbenchInput | undefined;
	let subagentRefresh: ReturnType<typeof setInterval> | undefined;
	let taskPlanNotices: { start(): void; stop(): Promise<void> } | undefined;

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
		const prompt = () => presentationMode === "plain" ? "beemax> " : presentationMode === "compact" ? `beemax [${config.model.model}]> ` : `beemax [${config.profile} · ${config.model.provider}/${config.model.model} · ${source.threadId ?? "default"}]> `;
		const writePrompt = () => { if (!closed && !workbench) process.stdout.write(prompt()); };
		const localDelivery: DeliveryPort = { sendText: async (target, text, options) => {
			if (target.platform !== "cli") throw new Error(`Cannot deliver ${target.platform} Task Plan notice through local Chat`);
			if (workbench) { workbench.notice(text); fullInput?.requestRender(); }
			else { process.stdout.write(`\n${text}\n`); writePrompt(); }
			return { idempotencyKey: options?.idempotencyKey ?? `cli:${crypto.randomUUID()}`, deliveredAt: Date.now() };
		}, sendMedia: async () => { throw new Error("Local Chat Objective Completion does not deliver media"); } };
		taskPlanNotices = new TaskPlanNoticeDeliveryService(persistence.completionOutbox, localDelivery, { platform: "cli", deliverObjective: (notice, signal) => objectiveRuntime.settlePlanIfLinked(notice.ownerKey, notice.planId, notice.planStatus, signal), onCycle: (result) => { if (result.delivered) objectiveCompletionDelivery?.wake(); } });
		objectiveCompletionDelivery = new ObjectiveCompletionDeliveryService(persistence.completionOutbox, localDelivery, { platform: "cli", onDelivered: (completion) => objectiveRuntime.publishDelivered(completion) });
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
			const taskState = taskScheduler.snapshot();
			const usage = snapshot.usage;
			const context = usage?.contextWindow === null || usage?.contextWindow === undefined ? undefined : usage.contextTokens === null ? `?/${usage.contextWindow}` : `${usage.contextTokens}/${usage.contextWindow}`;
			if (workbench) {
				workbench.setFooter({ model: `${config.model.provider}/${config.model.model}`, session: source.threadId ?? "default", phase: snapshot.phase, context, lastDurationMs, queued: snapshot.queueDepth, tasksRunning: taskState.running, tasksQueued: taskState.queued, taskCapacity: taskState.maxConcurrent });
				if (fullInput) fullInput.requestRender();
				else process.stdout.write(`\x1b[H\x1b[2J${workbench.render()}\n`);
				return;
			}
			process.stdout.write(renderChatFooter({ profile: config.profile, model: `${config.model.provider}/${config.model.model}`, session: source.threadId ?? "default", phase: snapshot.phase, context, lastDurationMs, queued: snapshot.queueDepth, tasksRunning: taskState.running, tasksQueued: taskState.queued, taskCapacity: taskState.maxConcurrent }));
		};
		const status = async () => `Profile: ${config.profile}\nModel: ${config.model.provider}/${config.model.model}\nSession: ${source.threadId ?? "default"}\nRun: ${runtime.isBusy() ? "running" : "idle"}\n${renderTaskSchedulerStatus(taskScheduler.snapshot())}\n${renderTaskRecoveryStatus(work.recoveryStatus())}\nReasoning: ${reasoningDisplay}\nDetails: ${detailsDisplay}\nToolset: ${config.agent.toolset}\n${await usage()}`;
		const toolsStatus = () => {
			const tools = mcp.getTools().map((tool) => tool.name);
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
			process.stdout.write(`\n${stopped.cancelled ? "Stopped the active Agent turn" : "No active Agent turn"}${stopped.subagentsCancelled ? `; cancelled ${stopped.subagentsCancelled} Sub-Agent task(s)` : ""}${stopped.taskPlansCancelled ? `; cancelled ${stopped.taskPlansCancelled} Task Plan(s)` : ""}${stopped.queuedCancelled ? "; cleared queued input" : ""}.\n`);
		};
		if (presentationMode === "full") {
			fullScreenActive = true;
			workbench = new FullWorkbench({ profile: config.profile, model: `${config.model.provider}/${config.model.model}`, session: source.threadId ?? "default", details: detailsDisplay });
			process.stdout.write(fullScreenEnter(""));
		}
		if (requestedMode.once === undefined) { taskPlanNotices.start(); objectiveCompletionDelivery.start(); }
		const runTurn = async (text: string, turnSource: SessionSource) => {
			workbench?.user(text);
			let streamed = "";
			const richOutput = presentationMode !== "plain";
			const reasoning = new LocalReasoningPresenter(reasoningDisplay, richOutput);
			let answerStreamStarted = false;
			const terminal = new StreamingTerminalMarkdown();
			const outcome = await interactionAdapter.dispatch({ type: "message.send", source: turnSource, text, input: { timeoutMs: profileTurnTimeoutMs(config), mode: "interactive" } }, async (event) => {
				if (workbench) {
					activity.event(event);
					workbench.setSubagents(subagents?.list(turnSource) ?? []);
					workbench.event(event, activity.renderDetails());
					if (event.type !== "answer.delta") await writeFooter();
					else if (fullInput) fullInput.requestRender(); else process.stdout.write(`\x1b[H\x1b[2J${workbench.render()}\n`);
					return;
				}
				process.stdout.write(activity.event(event));
				if (event.type === "turn.started" || event.type === "turn.queued") await writeFooter();
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
			if (result.completionId) {
				const objectiveId = objectiveIdFromCompletionId(result.completionId);
				if (!objectiveId) throw new Error(`Invalid Objective Completion identity: ${result.completionId}`);
				await objectiveRuntime.publishAcceptedObjective(responsibilityOwnerKey(turnSource), objectiveId);
				const completion = persistence.completionOutbox.getObjectiveCompletion(result.completionId);
				if (!completion) throw new Error(`Local Objective Completion is unavailable: ${result.completionId}`);
				if (!persistence.completionOutbox.acknowledgeObjectiveCompletion(result.completionId, { idempotencyKey: completion.deliveryIdempotencyKey, deliveredAt: Date.now() })) throw new Error(`Local Objective delivery could not acknowledge Completion ${result.completionId}`);
			}
			await writeFooter();
		};
		const handleLine = async (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) { writePrompt(); return; }
			const command = parseInteractionCommand(trimmed);
			if (active) {
				if (command?.kind === "stop") { await stop(); return; }
				if (command?.kind === "tasks" && command.action === "cancel" && command.planId) {
					const result = taskRecovery.cancel(responsibilityOwnerKeys(source), command.planId);
					process.stdout.write(`\n${result.active || result.tasks ? `Cancelled Task Plan ${command.planId}: active=${result.active}; tasks=${result.tasks}.` : `No active or queued Tasks found in owned Plan ${command.planId}.`}\n`);
					return;
				}
				if (command?.kind === "status") { process.stdout.write(`\n${await status()}\n`); return; }
				const queued = command?.kind === "steer"
					? await interactionAdapter.dispatch({ type: "turn.steer", source, text: command.text })
					: await interactionAdapter.dispatch({ type: "turn.queue", source, text: trimmed });
				if (!("queued" in queued) || !queued.queued) { process.stdout.write("\nCould not queue input because no active turn is available.\n"); return; }
				const label = queued.mode === "steer" ? "Guidance delivered to the active Agent." : queued.mode === "follow_up" ? "Follow-up delivered to the active Agent." : queued.replaced ? "Replaced the queued input." : "Queued the next input.";
				process.stdout.write(`\n${label} Use /stop (or Ctrl+C) to cancel the active turn.\n`);
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
				const matching = modelCatalog.list(command.query).map((choice) => choice.key);
				modelChoices = matching;
				const rendered = matching.map((choice, index) => `${index + 1}. ${choice}`).join("\n");
				if (workbench) { workbench.setPicker("Model Picker · /model <number>", matching.map((choice, index) => `${index + 1}. ${choice}`)); await writeFooter(); }
				else process.stdout.write(`${rendered || "No matching configured models."}\n\nUse /model <number> or /model <provider/model>.\n`);
				writePrompt(); return;
			}
			if (command?.kind === "tools") { process.stdout.write(`${toolsStatus()}\n`); writePrompt(); return; }
			if (command?.kind === "tasks") {
				if (command.action === "plans") { process.stdout.write(`${renderTaskPlans(runtime.taskPlans(source, { limit: 200 }))}\n`); writePrompt(); return; }
				if (command.action === "show" && command.planId) {
					const plan = runtime.taskPlans(source, { id: command.planId, limit: 1 })[0];
					process.stdout.write(`${plan ? renderTaskPlanDetails(plan, runtime.tasks(source, { planId: command.planId, limit: 100 })) : renderTaskPlanNotFound(command.planId)}\n`);
					writePrompt(); return;
				}
				if (command.action === "verify" && command.planId) {
					if (!config.subagents.enabled) { process.stdout.write("Task Plan Verification Retry is unavailable because Sub-Agents are disabled.\n"); writePrompt(); return; }
					const result = await taskRecovery.reverify(responsibilityOwnerKeys(source), command.planId);
					process.stdout.write(`${result.attempted ? `Verified Candidate Results for Plan ${command.planId}: attempted=${result.attempted}; accepted=${result.accepted}; rejected=${result.rejected}; unavailable=${result.unavailable}.` : `No unavailable Candidate Results found in owned Plan ${command.planId}.`}\n`);
					writePrompt(); return;
				}
				if (command.action === "cancel" && command.planId) {
					const result = taskRecovery.cancel(responsibilityOwnerKeys(source), command.planId);
					process.stdout.write(`${result.active || result.tasks ? `Cancelled Task Plan ${command.planId}: active=${result.active}; tasks=${result.tasks}.` : `No active or queued Tasks found in owned Plan ${command.planId}.`}\n`);
					writePrompt(); return;
				}
				if (command.action === "retry" && command.planId) {
					if (!config.subagents.enabled) { process.stdout.write("Task Plan retry is unavailable because Sub-Agents are disabled.\n"); writePrompt(); return; }
					const result = await taskRecovery.retry(responsibilityOwnerKeys(source), command.planId, { maxConcurrent: config.subagents.maxConcurrent });
					process.stdout.write(`${renderTaskPlanRetryResult(command.planId, result)}\n`);
					writePrompt(); return;
				}
				const tasks = runtime.tasks(source, { limit: 50 });
				process.stdout.write(`${renderTasks(tasks)}\n`);
				writePrompt(); return;
			}
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
				const manualRetryAvailable = error instanceof AgentRunError && error.recoverable;
				if (manualRetryAvailable) retryText = trimmed;
				process.stdout.write(`Agent run failed: ${error instanceof Error ? error.message : String(error)}\n`);
				if (manualRetryAvailable) process.stdout.write("Automatic fallback was unsafe or unavailable. Use /retry to retry explicitly.\n");
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
		if (requestedMode.once !== undefined) {
			closed = true;
			await handleLine(requestedMode.once);
		} else if (workbench) {
			await new Promise<void>((resolve) => {
				closeInput = () => { closed = true; const input = fullInput; fullInput = undefined; input?.stop(); resolve(); };
				fullInput = startFullWorkbenchInput(
					workbench,
					(line) => { void handleLine(line); },
					() => { if (active) void stop(); else closeInput(); },
					closeInput,
				);
				subagentRefresh = setInterval(() => {
					if (!workbench || !fullInput) return;
					workbench.setSubagents(subagents?.list(source) ?? []);
					fullInput.requestRender();
				}, 1_000);
			});
		} else {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			let pendingLines = Promise.resolve();
			closeInput = () => { closed = true; rl.close(); };
			writePrompt();
			rl.on("line", (line) => { pendingLines = pendingLines.then(() => handleLine(line)); });
			rl.on("SIGINT", () => { if (active) void stop(); else closeInput(); });
			await new Promise<void>((resolve) => rl.once("close", resolve));
			await pendingLines;
		}
		} finally {
			await taskPlanNotices?.stop();
			await objectiveCompletionDelivery?.stop();
			if (subagentRefresh) clearInterval(subagentRefresh);
		fullInput?.stop();
			if (fullScreenActive) process.stdout.write(fullScreenExit());
			await profileRuntime.dispose();
		}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
