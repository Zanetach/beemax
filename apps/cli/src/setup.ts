import { consumeChannelCredential, loadConfig } from "./config.ts";
import type { CustomProtocol } from "./config.ts";
import { registerFeishuBot } from "./feishu-onboarding.ts";
import { presetFor, renderModelProviderChoices, resolveProviderSelection } from "./model-catalog.ts";
import { runDoctor } from "./doctor.ts";
import {
	configureFeishuChannel,
	configureModel,
	configureSoftwareAgentMode,
	configureSoul,
	createProfile,
	listProfiles,
	probeFeishuApp,
	setActiveProfile,
} from "./profile-config.ts";

export interface SetupOptions {
	profile: string;
	gatewayOnly?: boolean;
	/** Configure Feishu during the initial setup; otherwise use `gateway setup` later. */
	configureGateway?: boolean;
	/** Offer Feishu/Lark as the next interactive step after model setup. */
	offerGateway?: boolean;
	/** Authorize autonomous file delivery inside the Profile workspace. */
	softwareAgent?: boolean;
	/** Offer the bounded software Agent mode during interactive quickstart. */
	offerSoftwareAgent?: boolean;
	nonInteractive?: boolean;
	provider?: string;
	model?: string;
	apiKey?: string;
	baseUrl?: string;
	customProtocol?: CustomProtocol;
	soul?: string;
	appId?: string;
	appSecret?: string;
	allowedUsers?: string[];
	allowedChats?: string[];
	groupPolicy?: "open" | "allowlist" | "disabled";
	domain?: "feishu" | "lark";
	requireMention?: boolean;
	connectionMode?: "websocket" | "webhook";
	webhookHost?: string;
	webhookPort?: number;
	webhookPath?: string;
	webhookVerificationToken?: string;
	webhookEncryptKey?: string;
}

export interface SetupDependencies {
	probe?: typeof probeFeishuApp;
	doctor?: typeof runDoctor;
	ask?: (request: SetupPrompt) => Promise<string>;
	qrRegister?: typeof registerFeishuBot;
}

export interface SetupPrompt { label: string; defaultValue?: string; secret?: boolean; }

export async function runSetup(options: SetupOptions, dependencies: SetupDependencies = {}): Promise<boolean> {
	const ask = async (label: string, defaultValue?: string, secret = false): Promise<string> => {
		const answer = dependencies.ask
			? await dependencies.ask({ label, defaultValue, secret })
			: await askOne(`${label}${defaultValue ? ` [${defaultValue}]` : ""}: `, secret);
		return answer.trim() || defaultValue || "";
	};
	const profiles = await listProfiles();
	const exists = profiles.includes(options.profile);
	if (!exists && options.gatewayOnly) throw new Error(`Agent profile ${options.profile} does not exist; run beemax profile create ${options.profile}`);
	const current = loadConfig(undefined, options.profile);
	const currentFeishu = current.gateway.feishu;
	const currentFeishuInstance = current.gateway.channels.find((channel) => channel.adapter === "feishu");
	const currentFeishuCredential = currentFeishuInstance ? consumeChannelCredential(current, currentFeishuInstance, (credential) => credential.adapter === "feishu" ? { appId: credential.appId, appSecret: credential.appSecret, webhookVerificationToken: credential.webhookVerificationToken, webhookEncryptKey: credential.webhookEncryptKey } : undefined) : undefined;
	const currentAppId = currentFeishuCredential?.appId ?? "";
	const currentAppSecret = currentFeishuCredential?.appSecret ?? "";

	let soul: string | undefined;
	let provider: string | undefined;
	let model: string | undefined;
	let apiKey: string | undefined;
	let baseUrl: string | undefined;
	let customProtocol: CustomProtocol | undefined;
	if (!options.gatewayOnly) {
		soul = options.soul;
		if (soul === undefined && !options.nonInteractive) {
			const customSoul = await ask("Custom Agent identity (optional; leave empty to keep the generated SOUL.md)");
			soul = customSoul.trim() || undefined;
		}
		if (!options.nonInteractive && !options.provider) console.log(`\nChoose a model provider:\n${renderModelProviderChoices()}\n  Or enter any Pi-supported provider ID.`);
		provider = resolveProviderSelection(options.provider ?? (options.nonInteractive ? current.model.provider : await ask("Model provider", current.model.provider)));
		const preset = presetFor(provider);
		const suggestedModel = options.model ?? (provider === current.model.provider ? current.model.model : preset?.defaultModel ?? "");
		model = options.model ?? (options.nonInteractive ? suggestedModel : await ask("Model ID", suggestedModel));
		// Pi providers carry their own canonical base URL. Persist only an explicit
		// Profile override, so switching a built-in provider never pins stale URLs.
		baseUrl = options.baseUrl ?? (provider === current.model.provider ? current.model.baseUrl : undefined);
		if (!options.nonInteractive && (preset?.requiresBaseUrl || provider === "custom")) baseUrl = await ask("OpenAI-compatible Base URL", baseUrl ?? "");
		if (provider === "custom") customProtocol = options.customProtocol ?? (options.nonInteractive ? "openai-completions" : await askCustomProtocol(ask));
		apiKey = options.apiKey;
		if (!apiKey && !options.nonInteractive && !current.model.apiKey) apiKey = await ask("Model API Key (leave empty to configure later)", undefined, true);
		if (!provider || !model) throw new Error("Setup requires a model provider and model ID");
		if (!apiKey && !current.model.apiKey) throw new Error("Setup requires a model API key");
	}

	let softwareAgent = options.softwareAgent === true;
	if (!options.gatewayOnly && options.offerSoftwareAgent && options.softwareAgent === undefined && !options.nonInteractive) {
		softwareAgent = parseYesNo(await ask("Enable autonomous software delivery inside this Profile workspace (yes or no)", "yes"));
	}
	let configureGateway = options.gatewayOnly || options.configureGateway === true
		|| Boolean(options.appId || options.appSecret || options.allowedUsers);
	if (!options.gatewayOnly && options.offerGateway && !configureGateway && !options.nonInteractive) {
		configureGateway = parseYesNo(await ask("Connect Feishu/Lark now (yes or no)", "yes"));
	}
	const requireGateway = configureGateway;
	let replacingExistingGateway = false;
	let appId = "";
	let appSecret = "";
	let allowedUsers: string[] = [];
	let domain = currentFeishu.domain;
	let connectionMode = currentFeishu.connectionMode;
	let groupPolicy = currentFeishu.groupPolicy;
	let webhookEncryptKey: string | undefined;
	let usedQrRegistration = false;
	let probe: Awaited<ReturnType<typeof probeFeishuApp>> | undefined;
	if (configureGateway && !options.nonInteractive && currentAppId && currentAppSecret) {
		const existingAction = await ask("Existing Feishu configuration (keep or replace)", "keep");
		if (existingAction === "keep") {
			configureGateway = false;
			console.log(`Kept the existing Feishu Gateway configuration for Profile '${options.profile}'.`);
		} else if (existingAction === "replace") replacingExistingGateway = true;
		else throw new Error("Existing configuration action must be keep or replace");
	}
	if (configureGateway) {
		let qrOwnerId: string | undefined;
		if (!options.nonInteractive) {
			console.log("\nBeeMax Feishu Gateway setup\nScan to create a bot automatically, or choose manual setup.\n");
			const method = await ask("[1/5] Setup method (qr or manual)", "qr");
			if (method !== "qr" && method !== "manual") throw new Error("Setup method must be qr or manual");
			if (method === "qr") {
				try {
					const registered = await (dependencies.qrRegister ?? registerFeishuBot)({ initialDomain: options.domain ?? currentFeishu.domain });
					if (registered) {
						({ appId, appSecret, domain } = registered);
						qrOwnerId = registered.openId;
						connectionMode = "websocket";
						usedQrRegistration = true;
						console.log(`PASS  Feishu QR registration  app=${appId}${qrOwnerId ? " · owner authorized" : ""}`);
					} else console.log("WARN  QR registration did not complete; continuing with manual setup.");
				} catch (error) {
					console.log(`WARN  QR registration failed; continuing manually (${error instanceof Error ? error.message : String(error)}).`);
				}
			}
		}
		if (!usedQrRegistration) {
			domain = options.domain ?? (options.nonInteractive ? currentFeishu.domain : parseDomain(await ask("[2/5] Platform (feishu or lark)", currentFeishu.domain)));
			if (!options.nonInteractive) console.log("[3/5] App credentials — Feishu Developer Console > Credentials & Basic Info");
			appId = options.appId ?? (options.nonInteractive ? currentAppId : await ask("Feishu App ID", currentAppId));
			appSecret = options.appSecret ?? (replacingExistingGateway && !options.nonInteractive ? "" : currentAppSecret);
			if (!appSecret && !options.nonInteractive) appSecret = await ask("Feishu App Secret", undefined, true);
			connectionMode = options.connectionMode ?? (options.nonInteractive ? currentFeishu.connectionMode : parseConnectionMode(await ask("[4/5] Connection mode (websocket or webhook)", currentFeishu.connectionMode)));
		}
		webhookEncryptKey = options.webhookEncryptKey ?? currentFeishuCredential?.webhookEncryptKey;
		if (connectionMode === "webhook" && !webhookEncryptKey && !options.nonInteractive) {
			webhookEncryptKey = await ask("Feishu webhook encrypt key", undefined, true);
		}
		if (!options.nonInteractive) console.log("[5/5] Access — QR setup authorizes the scanning user; manual setup accepts open_id, union_id, or user_id.");
		allowedUsers = options.allowedUsers ?? (usedQrRegistration ? (qrOwnerId ? [qrOwnerId] : []) : currentFeishu.allowedUsers);
		if (allowedUsers.length === 0 && !options.nonInteractive) allowedUsers = splitList(await ask("Allowed Feishu user IDs (comma-separated)"));
		groupPolicy = options.groupPolicy ?? (options.nonInteractive ? currentFeishu.groupPolicy : parseSetupGroupPolicy(await ask("[6/6] Group chats (open, allowlist, or disabled)", currentFeishu.groupPolicy)));
		if (!appId || !appSecret || allowedUsers.length === 0) throw new Error("Gateway setup requires Feishu App ID, App Secret, and at least one allowed user");
		if (connectionMode === "webhook" && !webhookEncryptKey) throw new Error("Webhook setup requires FEISHU_WEBHOOK_ENCRYPT_KEY");
		try { probe = await (dependencies.probe ?? probeFeishuApp)({ appId, appSecret, domain }); }
		catch (error) {
			if (!usedQrRegistration) throw error;
			probe = { warning: `bot probe deferred: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	if (!exists) {
		await createProfile(options.profile);
		console.log(`Created Agent Profile '${options.profile}'.`);
	}
	if (!options.gatewayOnly) {
		if (soul?.trim()) await configureSoul(options.profile, soul);
		await configureModel(options.profile, {
			provider: provider!,
			model: model!,
			apiKey,
			baseUrl,
			customProtocol,
		});
		if (softwareAgent) {
			await configureSoftwareAgentMode(options.profile);
			console.log("Enabled software delivery: workspace writes and edits may continue autonomously; shell and external actions remain approval-gated.");
		}
	}
	if (configureGateway) {
		await configureFeishuChannel(options.profile, {
			appId, appSecret, allowedUsers,
			allowedChats: options.allowedChats ?? currentFeishu.allowedChats,
			groupPolicy,
			domain, requireMention: options.requireMention ?? currentFeishu.requireMention,
			connectionMode, webhookHost: options.webhookHost ?? currentFeishu.webhookHost,
			webhookPort: options.webhookPort ?? currentFeishu.webhookPort,
			webhookPath: options.webhookPath ?? currentFeishu.webhookPath,
			webhookVerificationToken: options.webhookVerificationToken ?? currentFeishuCredential?.webhookVerificationToken,
			webhookEncryptKey,
		});
		if (usedQrRegistration) console.log("\nPASS  Feishu application, permissions, events, and card callbacks were configured by QR registration.\n");
		else printFeishuChecklist(connectionMode);
		console.log(probe!.botName || probe!.botOpenId
			? `PASS  Feishu live probe       bot=${probe!.botName ?? probe!.botOpenId}`
			: `WARN  Feishu live probe       ${probe!.warning ?? "credentials valid; bot identity unavailable"}`);
		console.log(`\nNext: ${usedQrRegistration ? "run" : "finish the Feishu console checklist above, then run"}:\n  beemax gateway run --profile ${options.profile}\nSend the bot a private message to verify streaming cards and approval buttons.\n`);
	}
	if (options.gatewayOnly) {
		await setActiveProfile(options.profile);
		console.log(`BeeMax Gateway setup complete for Profile '${options.profile}'.`);
		return true;
	}
	const ready = await (dependencies.doctor ?? runDoctor)(loadConfig(undefined, options.profile), { requireGateway });
	if (ready) {
		await setActiveProfile(options.profile);
		console.log(`BeeMax setup complete for Profile '${options.profile}'.`);
		if (!configureGateway) console.log(`Start chatting now: beemax chat --profile ${options.profile}\nConnect Feishu later: beemax gateway setup --profile ${options.profile}`);
	}
	return ready;
}

async function askCustomProtocol(ask: (label: string, defaultValue?: string) => Promise<string>): Promise<CustomProtocol> {
	const value = await ask("Custom protocol [openai-completions | openai-responses | anthropic-messages]", "openai-completions");
	if (value === "openai-responses" || value === "anthropic-messages") return value;
	return "openai-completions";
}

function printFeishuChecklist(connectionMode: "websocket" | "webhook"): void {
	console.log(`\nRequired Feishu configuration:
	  1. Enable the Bot capability.
	  2. Grant im:message.p2p_msg:readonly for direct messages.
	  3. Grant im:message.group_at_msg:readonly for group @mentions.
	  4. Grant im:message:send_as_bot for replies.
	  5. ${connectionMode === "webhook" ? "Configure the HTTPS webhook URL and its encryption key." : "For both Events and Callbacks, select Long Connection (WebSocket)."}
	  6. Events: subscribe to im.message.receive_v1 (Receive messages v2.0).
	  7. Callbacks: subscribe to card.action.trigger (Card action trigger, not legacy v1).
	  8. Publish the app version and obtain administrator approval when required.\n`);
}

function parseDomain(value: string): "feishu" | "lark" {
	if (value === "feishu" || value === "lark") return value;
	throw new Error("Platform must be feishu or lark");
}

function parseConnectionMode(value: string): "websocket" | "webhook" {
	if (value === "websocket" || value === "webhook") return value;
	throw new Error("Connection mode must be websocket or webhook");
}

function parseSetupGroupPolicy(value: string): "open" | "allowlist" | "disabled" {
	if (value === "open" || value === "allowlist" || value === "disabled") return value;
	throw new Error("Group policy must be open, allowlist, or disabled");
}

function parseYesNo(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	if (["yes", "y", "1", "true", "是", "启用", "连接"].includes(normalized)) return true;
	if (["no", "n", "0", "false", "否", "跳过"].includes(normalized)) return false;
	throw new Error("Answer must be yes or no");
}

async function askOne(prompt: string, secret = false): Promise<string> {
	const { createInterface } = await import("node:readline/promises");
	if (!secret) {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try { return (await rl.question(prompt)).trim(); } finally { rl.close(); }
	}
	const { Writable } = await import("node:stream");
	let muted = false;
	const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
	const rl = createInterface({ input: process.stdin, output, terminal: true });
	try {
		process.stdout.write(prompt);
		muted = true;
		const answer = await rl.question("");
		muted = false;
		process.stdout.write("\n");
		return answer.trim();
	} finally { rl.close(); }
}

function splitList(value: string): string[] {
	return value.split(",").map((item) => item.trim()).filter(Boolean);
}
