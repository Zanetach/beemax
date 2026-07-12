import { loadConfig } from "./config.ts";
import type { CustomProtocol } from "./config.ts";
import { presetFor, renderModelProviderChoices, resolveProviderSelection } from "./model-catalog.ts";
import { runDoctor } from "./doctor.ts";
import {
	configureFeishuChannel,
	configureModel,
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

	const configureGateway = options.gatewayOnly || options.configureGateway === true
		|| Boolean(options.appId || options.appSecret || options.allowedUsers);
	let appId = "";
	let appSecret = "";
	let allowedUsers: string[] = [];
	let domain = currentFeishu.domain;
	let connectionMode = currentFeishu.connectionMode;
	let webhookEncryptKey: string | undefined;
	let probe: Awaited<ReturnType<typeof probeFeishuApp>> | undefined;
	if (configureGateway) {
		if (!options.nonInteractive) console.log("\nBeeMax Feishu Gateway setup\nFour short steps; press Enter to accept the recommended defaults.\n");
		domain = options.domain ?? (options.nonInteractive ? currentFeishu.domain : parseDomain(await ask("[1/4] Platform (feishu or lark)", currentFeishu.domain)));
		if (!options.nonInteractive) console.log("[2/4] App credentials — Feishu Developer Console > Credentials & Basic Info");
		appId = options.appId ?? (options.nonInteractive ? currentFeishu.appId : await ask("Feishu App ID", currentFeishu.appId));
		appSecret = options.appSecret ?? currentFeishu.appSecret;
		if (!appSecret && !options.nonInteractive) appSecret = await ask("Feishu App Secret", undefined, true);
		connectionMode = options.connectionMode ?? (options.nonInteractive ? currentFeishu.connectionMode : parseConnectionMode(await ask("[3/4] Connection mode (websocket or webhook)", currentFeishu.connectionMode)));
		webhookEncryptKey = options.webhookEncryptKey ?? currentFeishu.webhookEncryptKey;
		if (connectionMode === "webhook" && !webhookEncryptKey && !options.nonInteractive) {
			webhookEncryptKey = await ask("Feishu webhook encrypt key", undefined, true);
		}
		if (!options.nonInteractive) console.log("[4/4] Access — enter your own open_id, union_id, or user_id. Multiple IDs use commas.");
		allowedUsers = options.allowedUsers ?? currentFeishu.allowedUsers;
		if (allowedUsers.length === 0 && !options.nonInteractive) allowedUsers = splitList(await ask("Allowed Feishu user IDs (comma-separated)"));
		if (!appId || !appSecret || allowedUsers.length === 0) throw new Error("Gateway setup requires Feishu App ID, App Secret, and at least one allowed user");
		if (connectionMode === "webhook" && !webhookEncryptKey) throw new Error("Webhook setup requires FEISHU_WEBHOOK_ENCRYPT_KEY");
		probe = await (dependencies.probe ?? probeFeishuApp)({ appId, appSecret, domain });
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
	}
	if (configureGateway) {
		await configureFeishuChannel(options.profile, {
			appId, appSecret, allowedUsers,
			allowedChats: options.allowedChats ?? currentFeishu.allowedChats,
			domain, requireMention: options.requireMention ?? currentFeishu.requireMention,
			connectionMode, webhookHost: options.webhookHost ?? currentFeishu.webhookHost,
			webhookPort: options.webhookPort ?? currentFeishu.webhookPort,
			webhookPath: options.webhookPath ?? currentFeishu.webhookPath,
			webhookVerificationToken: options.webhookVerificationToken ?? currentFeishu.webhookVerificationToken,
			webhookEncryptKey,
		});
		printFeishuChecklist(connectionMode);
		console.log(probe!.botName || probe!.botOpenId
			? `PASS  Feishu live probe       bot=${probe!.botName ?? probe!.botOpenId}`
			: `WARN  Feishu live probe       ${probe!.warning ?? "credentials valid; bot identity unavailable"}`);
		console.log(`\nNext: finish the Feishu console checklist above, then run:\n  beemax gateway run --profile ${options.profile}\nSend the bot a private message to verify streaming cards and approval buttons.\n`);
	}
	if (options.gatewayOnly) {
		await setActiveProfile(options.profile);
		console.log(`BeeMax Gateway setup complete for Profile '${options.profile}'.`);
		return true;
	}
	const ready = await (dependencies.doctor ?? runDoctor)(loadConfig(undefined, options.profile), { requireGateway: configureGateway });
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
