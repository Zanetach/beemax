import { loadConfig } from "./config.ts";
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
	nonInteractive?: boolean;
	provider?: string;
	model?: string;
	apiKey?: string;
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
}

export async function runSetup(options: SetupOptions, dependencies: SetupDependencies = {}): Promise<boolean> {
	const profiles = await listProfiles();
	const exists = profiles.includes(options.profile);
	if (!exists && options.gatewayOnly) throw new Error(`Agent profile ${options.profile} does not exist; run beemax profile create ${options.profile}`);
	const current = loadConfig(undefined, options.profile);

	let soul: string | undefined;
	let provider: string | undefined;
	let model: string | undefined;
	let apiKey: string | undefined;
	if (!options.gatewayOnly) {
		soul = options.soul ?? (options.nonInteractive ? current.agent.systemPrompt : await askWithDefault("Agent identity (SOUL.md)", current.agent.systemPrompt ?? ""));
		provider = options.provider ?? (options.nonInteractive ? current.model.provider : await askWithDefault("Model provider", current.model.provider));
		model = options.model ?? (options.nonInteractive ? current.model.model : await askWithDefault("Model ID", current.model.model));
		apiKey = options.apiKey;
		if (!apiKey && !options.nonInteractive && !current.model.apiKey) apiKey = await askOne("Model API Key (leave empty to configure later): ", true);
		if (!soul?.trim()) throw new Error("Setup requires a non-empty Agent identity");
		if (!provider || !model) throw new Error("Setup requires a model provider and model ID");
		if (!apiKey && !current.model.apiKey) throw new Error("Setup requires a model API key");
	}

	const appId = options.appId ?? (options.nonInteractive ? current.feishu.appId : await askWithDefault("Feishu App ID", current.feishu.appId));
	let appSecret = options.appSecret ?? current.feishu.appSecret;
	if (!appSecret && !options.nonInteractive) appSecret = await askOne("Feishu App Secret: ", true);
	let allowedUsers = options.allowedUsers ?? current.feishu.allowedUsers;
	if (allowedUsers.length === 0 && !options.nonInteractive) allowedUsers = splitList(await askOne("Allowed Feishu user IDs (comma-separated): "));
	if (!appId || !appSecret || allowedUsers.length === 0) {
		throw new Error("Setup requires Feishu App ID, App Secret, and at least one allowed user");
	}
	const domain = options.domain ?? current.feishu.domain;
	const connectionMode = options.connectionMode ?? current.feishu.connectionMode;
	const webhookEncryptKey = options.webhookEncryptKey ?? current.feishu.webhookEncryptKey;
	if (connectionMode === "webhook" && !webhookEncryptKey) throw new Error("Webhook setup requires FEISHU_WEBHOOK_ENCRYPT_KEY");
	const probe = await (dependencies.probe ?? probeFeishuApp)({ appId, appSecret, domain });

	if (!exists) {
		await createProfile(options.profile);
		console.log(`Created Agent Profile '${options.profile}'.`);
	}
	if (!options.gatewayOnly) {
		await configureSoul(options.profile, soul!);
		await configureModel(options.profile, {
			provider: provider!,
			model: model!,
			apiKey,
			baseUrl: current.model.provider === provider ? current.model.baseUrl : undefined,
		});
	}
	await configureFeishuChannel(options.profile, {
		appId,
		appSecret,
		allowedUsers,
		allowedChats: options.allowedChats ?? current.feishu.allowedChats,
		domain,
		requireMention: options.requireMention ?? current.feishu.requireMention,
		connectionMode,
		webhookHost: options.webhookHost ?? current.feishu.webhookHost,
		webhookPort: options.webhookPort ?? current.feishu.webhookPort,
		webhookPath: options.webhookPath ?? current.feishu.webhookPath,
		webhookVerificationToken: options.webhookVerificationToken ?? current.feishu.webhookVerificationToken,
		webhookEncryptKey,
	});

	printFeishuChecklist(connectionMode);
	console.log(probe.botName || probe.botOpenId
		? `PASS  Feishu live probe       bot=${probe.botName ?? probe.botOpenId}`
		: `WARN  Feishu live probe       ${probe.warning ?? "credentials valid; bot identity unavailable"}`);
	if (options.gatewayOnly) {
		await setActiveProfile(options.profile);
		console.log(`BeeMax Gateway setup complete for Profile '${options.profile}'.`);
		return true;
	}
	const ready = await (dependencies.doctor ?? runDoctor)(loadConfig(undefined, options.profile));
	if (ready) {
		await setActiveProfile(options.profile);
		console.log(`BeeMax setup complete for Profile '${options.profile}'.`);
	}
	return ready;
}

function printFeishuChecklist(connectionMode: "websocket" | "webhook"): void {
	console.log(`\nRequired Feishu configuration:
	  1. Enable the Bot capability.
	  2. Grant im:message.p2p_msg:readonly for direct messages.
	  3. Grant im:message.group_at_msg:readonly for group @mentions.
	  4. Grant im:message:send_as_bot for replies.
	  5. ${connectionMode === "webhook" ? "Configure the HTTPS webhook URL and its encryption key." : "Select Long Connection (WebSocket)."}
	  6. Subscribe to im.message.receive_v1.
	  7. Publish the app version and obtain administrator approval when required.\n`);
}

async function askWithDefault(label: string, value: string): Promise<string> {
	return await askOne(`${label}${value ? ` [${value}]` : ""}: `) || value;
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
