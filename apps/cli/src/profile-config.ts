import { constants } from "node:fs";
import { access, copyFile, cp, lstat, mkdir, open, readFile, readdir, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { backupSqliteDatabase, verifySqliteDatabase } from "@beemax/memory";
import { DEFAULT_DOCKER_SANDBOX_IMAGE, DEFAULT_RUNTIME_RESOURCE_LIMITS } from "@beemax/core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { readEnvFile, writeEnvFile } from "./env-file.ts";
import { DEFAULT_SOUL, resolveSoul, validateCustomSoul } from "./soul.ts";
import { providerApiKeyEnv } from "./provider-resolver.ts";
import type { CustomProtocol } from "./config.ts";
import { mutateProfileConfig } from "./profile-config-transaction.ts";
import {
	beemaxHome,
	beemaxRoot,
	legacyProfilePaths,
	profilePaths,
	type ProfilePaths,
	type ProfileStorageOptions,
	validateProfileName,
} from "./profile-home.ts";

export { profilePaths, type ProfilePaths, type ProfileStorageOptions } from "./profile-home.ts";

export interface FeishuChannelInput {
	appId: string;
	appSecret: string;
	domain?: "feishu" | "lark";
	requireMention?: boolean;
	allowedUsers: string[];
	allowedChats?: string[];
	groupPolicy?: "open" | "allowlist" | "disabled";
	connectionMode?: "websocket" | "webhook";
	webhookHost?: string;
	webhookPort?: number;
	webhookPath?: string;
	webhookVerificationToken?: string;
	webhookEncryptKey?: string;
}

export interface TelegramChannelInput {
	botToken: string;
	allowedUsers: string[];
	allowedChats?: string[];
	allowAllUsers?: boolean;
	pollingTimeoutSeconds?: number;
	retryBaseDelayMs?: number;
}

export interface ModelInput {
	provider: string;
	model: string;
	apiKey?: string;
	baseUrl?: string;
	customProtocol?: CustomProtocol;
	contextWindow?: number;
	maxTokens?: number;
}

export interface FeishuProbeResult {
	botOpenId?: string;
	botName?: string;
	warning?: string;
}

export async function createProfile(profile: string, options: ProfileStorageOptions = {}): Promise<ProfilePaths> {
	const paths = profilePaths(profile, options);
	if (await exists(paths.homePath)) throw new Error(`Agent profile ${profile} already exists`);
	const temp = `${paths.homePath}.creating-${crypto.randomUUID()}`;
	await mkdir(dirname(paths.homePath), { recursive: true, mode: 0o700 });
	await mkdir(temp, { recursive: false, mode: 0o700 });
	try {
		await Promise.all([
			mkdir(join(temp, "sessions")),
			mkdir(join(temp, "skills")),
			mkdir(join(temp, "cache")),
			mkdir(join(temp, "state")),
			mkdir(join(temp, "workspace")),
		]);
		await writeFile(join(temp, "config.yaml"), defaultProfileYaml(), { encoding: "utf8", mode: 0o600 });
		await writeFile(join(temp, "SOUL.md"), `${DEFAULT_SOUL}\n`, { encoding: "utf8", mode: 0o600 });
		await writeFile(join(temp, "USER.md"), "", { encoding: "utf8", mode: 0o600 });
		await writeFile(join(temp, "MEMORY.md"), "", { encoding: "utf8", mode: 0o600 });
		await writeEnvFile(join(temp, ".env"), {});
		await writeFile(join(temp, "state", "credential-vault.key"), Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"), { encoding: "utf8", mode: 0o600 });
		await installBuiltinSkills(temp, options.root ?? beemaxRoot());
		await rename(temp, paths.homePath);
	} catch (error) {
		await rm(temp, { recursive: true, force: true });
		throw error;
	}
	return paths;
}

export async function listProfiles(options: ProfileStorageOptions = {}): Promise<string[]> {
	const profiles = new Set<string>();
	const root = resolve(options.root ?? beemaxRoot());
	const home = resolve(options.home ?? beemaxHome());
	try {
		await readFile(join(root, "config", "beemax.yaml"), "utf8");
		profiles.add("default");
	} catch { /* optional default profile */ }
	try {
		for (const entry of await readdir(join(root, "config", "profiles"))) {
			if (/^[a-z0-9][a-z0-9_-]{0,31}\.ya?ml$/.test(entry)) profiles.add(entry.replace(/\.ya?ml$/, ""));
		}
	} catch { /* no profiles yet */ }
	try {
		for (const entry of await readdir(join(home, "profiles"), { withFileTypes: true })) {
			if (entry.isDirectory() && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(entry.name) && await exists(join(home, "profiles", entry.name, "config.yaml"))) {
				profiles.add(entry.name);
			}
		}
	} catch { /* no profile home yet */ }
	return [...profiles].sort();
}

/** Add missing packaged skills to an existing Profile without replacing its custom skills. */
export async function syncBuiltinSkills(profile: string, options: ProfileStorageOptions = {}): Promise<ProfilePaths> {
	const paths = await writableProfilePaths(profile, options);
	await ensureCredentialVaultKey(profile, options);
	await mkdir(join(paths.homePath, "skills"), { recursive: true });
	await installBuiltinSkills(paths.homePath, options.root ?? beemaxRoot());
	return paths;
}

export async function ensureCredentialVaultKey(profile: string, options: ProfileStorageOptions = {}): Promise<ProfilePaths> {
	const paths = await writableProfilePaths(profile, options);
	const env = await readEnvFile(paths.envPath);
	const keyPath = join(paths.dataPath, "state", "credential-vault.key");
	const configured = env.BEEMAX_CREDENTIAL_VAULT_KEY || await readFile(keyPath, "utf8").catch(() => "");
	if (configured) {
		if (Buffer.from(configured, "base64").byteLength !== 32) throw new Error(`Credential Vault key is invalid for Profile '${profile}'`);
		return paths;
	}
	if (await exists(join(paths.dataPath, "credentials.vault"))) throw new Error(`Credential Vault key is missing for Profile '${profile}', but encrypted data already exists; restore the original Profile .env`);
	await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
	await writeFile(keyPath, Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"), { encoding: "utf8", mode: 0o600 });
	return paths;
}

export async function deleteProfile(profile: string, options: ProfileStorageOptions = {}): Promise<ProfilePaths> {
	const paths = await writableProfilePaths(profile, options);
	const home = resolve(options.home ?? beemaxHome());
	let preserved = paths.dataPath;
	if (paths.configPath === join(paths.homePath, "config.yaml")) {
		const archive = join(home, "deleted", `${profile}-${Date.now()}-${crypto.randomUUID()}`);
		await mkdir(dirname(archive), { recursive: true, mode: 0o700 });
		await rename(paths.homePath, archive);
		await rm(join(archive, "config.yaml"), { force: true });
		await rm(join(archive, ".env"), { force: true });
		await rm(join(archive, "SOUL.md"), { force: true });
		preserved = archive;
	} else {
		await rm(paths.configPath, { force: true });
		await rm(paths.envPath, { force: true });
	}
	try {
		if ((await readFile(join(home, "active-profile"), "utf8")).trim() === profile) {
			await rm(join(home, "active-profile"), { force: true });
		}
	} catch { /* profile was not active */ }
	return { ...paths, homePath: preserved, dataPath: preserved };
}

export async function configureFeishuChannel(
	profile: string,
	input: FeishuChannelInput,
	options: ProfileStorageOptions = {},
): Promise<ProfilePaths> {
	if (!input.appId.trim() || !input.appSecret.trim()) throw new Error("Feishu App ID and App Secret are required");
	if (input.allowedUsers.length === 0) throw new Error("At least one allowed Feishu user ID is required");
	const paths = await writableProfilePaths(profile, options);
	await mutateProfileConfig(paths.configPath, (config) => {
		const gateway = asRecord(config.gateway);
		config.gateway = {
			...gateway,
			channels: upsertGatewayChannel(gateway.channels, {
				id: "feishu-main", adapter: "feishu", enabled: true, credentialRef: "profile-env:feishu", settings: {},
			}),
			feishu: {
				...asRecord(gateway.feishu ?? config.feishu),
				domain: input.domain ?? "feishu",
				requireMention: input.requireMention ?? true,
				allowedChats: input.allowedChats ?? [],
				groupPolicy: input.groupPolicy ?? "allowlist",
				allowAllUsers: false,
				connectionMode: input.connectionMode ?? "websocket",
				...(input.connectionMode === "webhook" ? {
					webhookHost: input.webhookHost ?? "127.0.0.1",
					webhookPort: input.webhookPort ?? 8787,
					webhookPath: input.webhookPath ?? "/feishu/events",
				} : {}),
			},
		};
		delete config.feishu;
	});
	await writeEnvFile(paths.envPath, {
		...await readEnvFile(paths.envPath),
		FEISHU_APP_ID: input.appId.trim(),
		FEISHU_APP_SECRET: input.appSecret.trim(),
		FEISHU_ALLOWED_USERS: input.allowedUsers.join(","),
		...(input.connectionMode === "webhook" ? {
			FEISHU_CONNECTION_MODE: "webhook",
			FEISHU_WEBHOOK_VERIFICATION_TOKEN: input.webhookVerificationToken ?? "",
			FEISHU_WEBHOOK_ENCRYPT_KEY: input.webhookEncryptKey ?? "",
		} : { FEISHU_CONNECTION_MODE: "websocket" }),
	});
	return paths;
}

export async function configureTelegramChannel(
	profile: string,
	input: TelegramChannelInput,
	options: ProfileStorageOptions = {},
): Promise<ProfilePaths> {
	if (!input.botToken.trim()) throw new Error("Telegram Bot Token is required");
	if (!input.allowAllUsers && input.allowedUsers.length === 0) throw new Error("At least one allowed Telegram user ID is required");
	const paths = await writableProfilePaths(profile, options);
	await mutateProfileConfig(paths.configPath, (config) => {
		const gateway = asRecord(config.gateway);
		config.gateway = {
			...gateway,
			channels: upsertGatewayChannel(gateway.channels, {
				id: "telegram-main",
				adapter: "telegram",
				enabled: true,
				credentialRef: "profile-env:telegram",
				settings: {
					allowedUsers: input.allowedUsers,
					allowedChats: input.allowedChats ?? [],
					allowAllUsers: input.allowAllUsers ?? false,
					pollingTimeoutSeconds: input.pollingTimeoutSeconds ?? 25,
					retryBaseDelayMs: input.retryBaseDelayMs ?? 1_000,
				},
			}),
		};
	});
	await writeEnvFile(paths.envPath, {
		...await readEnvFile(paths.envPath),
		TELEGRAM_BOT_TOKEN: input.botToken.trim(),
	});
	return paths;
}

export async function setFeishuHomeChat(profile: string, chatId: string, userId?: string, chatType: "dm" | "group" = "dm", options: ProfileStorageOptions = {}): Promise<void> {
	if (!chatId.trim()) throw new Error("Feishu home chat ID is required");
	const paths = await writableProfilePaths(profile, options);
	await mutateProfileConfig(paths.configPath, (config) => {
		const gateway = asRecord(config.gateway);
		config.gateway = { ...gateway, feishu: { ...asRecord(gateway.feishu), homeChatId: chatId.trim(), homeChatType: chatType, ...(userId?.trim() ? { homeUserId: userId.trim() } : {}) } };
	});
}

export async function configureModel(profile: string, input: ModelInput, options: ProfileStorageOptions = {}): Promise<ProfilePaths> {
	if (!input.provider.trim() || !input.model.trim()) throw new Error("Model provider and model ID are required");
	const paths = await writableProfilePaths(profile, options);
	await mutateProfileConfig(paths.configPath, (config) => {
		config.model = {
			provider: input.provider.trim(),
			model: input.model.trim(),
			...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
			...(input.provider.trim() === "custom" ? { customProtocol: input.customProtocol ?? "openai-completions" } : {}),
			...(input.provider.trim() === "custom" && input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
			...(input.provider.trim() === "custom" && input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
		};
		const choices = Array.isArray(config.models) ? config.models : [];
		const next = { provider: input.provider.trim(), model: input.model.trim(), ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}), ...(input.provider.trim() === "custom" ? { customProtocol: input.customProtocol ?? "openai-completions" } : {}), ...(input.provider.trim() === "custom" && input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}), ...(input.provider.trim() === "custom" && input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}) };
		config.models = [next, ...choices.filter((item) => !sameModelChoice(item, next))];
	});
	if (input.apiKey?.trim()) {
		await writeEnvFile(paths.envPath, {
			...await readEnvFile(paths.envPath),
			[providerApiKeyEnv(input.provider)]: input.apiKey.trim(),
		});
	}
	return paths;
}

export async function configureSoul(profile: string, identity: string, options: ProfileStorageOptions = {}): Promise<ProfilePaths> {
	const value = validateCustomSoul(identity);
	const paths = await writableProfilePaths(profile, options);
	if (paths.configPath === join(paths.homePath, "config.yaml")) {
		await writeFile(paths.soulPath, `${value}\n`, { encoding: "utf8", mode: 0o600 });
		return paths;
	}
	await mutateProfileConfig(paths.configPath, (config) => { config.agent = { ...asRecord(config.agent), systemPrompt: value }; });
	return paths;
}

export async function removeFeishuChannel(profile: string, options: ProfileStorageOptions = {}): Promise<ProfilePaths> {
	const paths = await writableProfilePaths(profile, options);
	const values = await readEnvFile(paths.envPath);
	delete values.FEISHU_APP_ID;
	delete values.FEISHU_APP_SECRET;
	delete values.FEISHU_ALLOWED_USERS;
	delete values.FEISHU_CONNECTION_MODE;
	delete values.FEISHU_WEBHOOK_VERIFICATION_TOKEN;
	delete values.FEISHU_WEBHOOK_ENCRYPT_KEY;
	await writeEnvFile(paths.envPath, values);
	await mutateProfileConfig(paths.configPath, (config) => {
		const gateway = asRecord(config.gateway);
		config.gateway = { ...gateway, channels: removeGatewayChannel(gateway.channels, "feishu") };
	});
	return paths;
}

export async function removeTelegramChannel(profile: string, options: ProfileStorageOptions = {}): Promise<ProfilePaths> {
	const paths = await writableProfilePaths(profile, options);
	const values = await readEnvFile(paths.envPath);
	delete values.TELEGRAM_BOT_TOKEN;
	delete values.TELEGRAM_ALLOWED_USERS;
	delete values.TELEGRAM_ALLOWED_CHATS;
	await writeEnvFile(paths.envPath, values);
	await mutateProfileConfig(paths.configPath, (config) => {
		const gateway = asRecord(config.gateway);
		config.gateway = { ...gateway, channels: removeGatewayChannel(gateway.channels, "telegram") };
	});
	return paths;
}

export async function testFeishuCredentials(
	input: Pick<FeishuChannelInput, "appId" | "appSecret" | "domain">,
	fetcher: typeof fetch = fetch,
): Promise<string> {
	const result = await probeFeishuApp(input, fetcher);
	const identity = result.botName || result.botOpenId;
	return `Feishu credentials are valid${identity ? `; bot=${identity}` : ""}${result.warning ? `; warning=${result.warning}` : ""}`;
}

export async function testTelegramCredentials(botToken: string, fetcher: typeof fetch = fetch): Promise<string> {
	if (!botToken.trim()) throw new Error("Telegram Bot Token is required");
	const response = await fetcher(`https://api.telegram.org/bot${botToken.trim()}/getMe`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
		signal: AbortSignal.timeout(15_000),
	});
	const body = await response.json().catch(() => ({})) as { ok?: boolean; result?: { username?: string }; description?: string };
	if (!response.ok || !body.ok) throw new Error(`Telegram credential probe failed: ${body.description ?? `HTTP ${response.status}`}`);
	return `Telegram credentials are valid${body.result?.username ? `; bot=@${body.result.username}` : ""}`;
}

export async function probeFeishuApp(
	input: Pick<FeishuChannelInput, "appId" | "appSecret" | "domain">,
	fetcher: typeof fetch = fetch,
): Promise<FeishuProbeResult> {
	const origin = input.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
	let response: Response;
	try {
		response = await fetcher(`${origin}/open-apis/auth/v3/tenant_access_token/internal`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ app_id: input.appId, app_secret: input.appSecret }),
			signal: AbortSignal.timeout(15_000),
		});
	} catch (error) {
		throw new Error(`Feishu credential probe failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const body = await responseJson(response, "Feishu credential probe") as { code?: number; msg?: string; tenant_access_token?: string };
	if (!response.ok || body.code !== 0 || !body.tenant_access_token) {
		throw new Error(`Feishu credential check failed: ${body.msg ?? `HTTP ${response.status}`}`);
	}
	try {
		const botResponse = await fetcher(`${origin}/open-apis/bot/v3/info`, {
			headers: { Authorization: `Bearer ${body.tenant_access_token}` },
			signal: AbortSignal.timeout(15_000),
		});
		const botBody = await responseJson(botResponse, "Feishu bot identity probe") as {
			code?: number;
			msg?: string;
			bot?: { open_id?: string; app_name?: string; bot_name?: string };
			data?: { bot?: { open_id?: string; app_name?: string; bot_name?: string } };
		};
		if (!botResponse.ok || botBody.code !== 0) return { warning: `bot identity unavailable: ${botBody.msg ?? `HTTP ${botResponse.status}`}` };
		const bot = botBody.bot ?? botBody.data?.bot;
		return { botOpenId: bot?.open_id, botName: bot?.app_name ?? bot?.bot_name };
	} catch (error) {
		return { warning: `bot identity unavailable: ${error instanceof Error ? error.message : String(error)}` };
	}
}

async function responseJson(response: Response, label: string): Promise<Record<string, unknown>> {
	const text = await response.text();
	if (!text) return {};
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		if (!response.ok) return { msg: `HTTP ${response.status}` };
		throw new Error(`${label} returned invalid JSON (HTTP ${response.status})`);
	}
}

export async function setActiveProfile(profile: string, options: ProfileStorageOptions = {}): Promise<void> {
	validateProfileName(profile);
	if (!(await listProfiles(options)).includes(profile)) throw new Error(`Agent profile ${profile} does not exist`);
	const home = resolve(options.home ?? beemaxHome());
	await mkdir(home, { recursive: true, mode: 0o700 });
	const target = join(home, "active-profile");
	const temp = join(home, `.active-profile-${crypto.randomUUID()}`);
	try {
		await writeFile(temp, `${profile}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temp, target);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

export async function migrateProfile(profile: string, options: ProfileStorageOptions = {}): Promise<ProfilePaths> {
	validateProfileName(profile);
	const root = resolve(options.root ?? beemaxRoot());
	const home = resolve(options.home ?? beemaxHome());
	const legacy = legacyProfilePaths(profile, { root, home });
	const target = profilePaths(profile, { root, home });
	if (!(await exists(legacy.configPath))) throw new Error(`Legacy Agent profile ${profile} does not exist`);
	if (await exists(target.homePath)) throw new Error(`Agent profile ${profile} already exists at ${target.homePath}`);

	const raw = await readFile(legacy.configPath, "utf8");
	const originalConfig = configFromYaml(raw);
	const legacyEnv = await readEnvFile(legacy.envPath);
	const legacyFeishu = { ...asRecord(originalConfig.feishu), ...asRecord(asRecord(originalConfig.gateway).feishu) };
	const config = structuredClone(originalConfig);
	scrubLegacyChannelSecrets(config);
	const agent = asRecord(config.agent);
	const legacyIdentity = legacyEnv.BEEMAX_SYSTEM_PROMPT?.trim()
		|| (typeof agent.systemPrompt === "string" ? agent.systemPrompt.trim() : "")
		|| DEFAULT_SOUL;
	const identity = resolveSoul(legacyIdentity);
	delete agent.systemPrompt;
	config.agent = agent;
	config.memory = { ...asRecord(config.memory), dbPath: "memory.db" };
	config.mcp = { ...asRecord(config.mcp), configPath: "mcp.json" };
	config.imageGeneration = { ...asRecord(config.imageGeneration), outputDir: "cache/images" };
	const pathsConfig = asRecord(config.paths);
	const workspace = absoluteFrom(root, legacyEnv.BEEMAX_CWD || (typeof pathsConfig.cwd === "string" ? pathsConfig.cwd : "."));
	config.paths = { ...pathsConfig, agentDir: ".", cwd: workspace };
	const oldMemory = absoluteFrom(root, legacyEnv.BEEMAX_DB_PATH || stringAt(originalConfig, ["memory", "dbPath"]) || join(legacy.dataPath, "beemax.db"));
	const oldMcp = absoluteFrom(root, legacyEnv.BEEMAX_MCP_CONFIG || stringAt(originalConfig, ["mcp", "configPath"]) || legacy.configPath.replace(/\.ya?ml$/i, ".mcp.json"));
	const oldImages = absoluteFrom(root, legacyEnv.BEEMAX_IMAGE_OUTPUT_DIR || stringAt(originalConfig, ["imageGeneration", "outputDir"]) || join(legacy.dataPath, "cache", "images"));
	const oldAgent = absoluteFrom(root, legacyEnv.BEEMAX_AGENT_DIR || stringAt(originalConfig, ["paths", "agentDir"]) || join(legacy.dataPath, "agent"));
	const migratedEnv = { ...legacyEnv };
	for (const [envKey, configKey] of [["FEISHU_APP_ID", "appId"], ["FEISHU_APP_SECRET", "appSecret"], ["FEISHU_WEBHOOK_VERIFICATION_TOKEN", "webhookVerificationToken"], ["FEISHU_WEBHOOK_ENCRYPT_KEY", "webhookEncryptKey"]] as const) {
		const legacyValue = legacyFeishu[configKey];
		if (!migratedEnv[envKey] && typeof legacyValue === "string" && legacyValue.trim()) migratedEnv[envKey] = legacyValue.trim();
	}
	for (const key of PROFILE_ROUTING_ENV) delete migratedEnv[key];

	const temp = `${target.homePath}.migrating-${crypto.randomUUID()}`;
	await mkdir(dirname(target.homePath), { recursive: true, mode: 0o700 });
	await mkdir(temp, { recursive: false, mode: 0o700 });
	try {
		await writeFile(join(temp, "config.yaml"), stringifyYaml(config), { encoding: "utf8", mode: 0o600 });
		await writeFile(join(temp, "SOUL.md"), `${identity}\n`, { encoding: "utf8", mode: 0o600 });
		await writeEnvFile(join(temp, ".env"), migratedEnv);
		if (await exists(oldMemory)) await backupSqliteDatabase(oldMemory, join(temp, "memory.db"));
		if (await exists(oldMcp)) await copyFile(oldMcp, join(temp, "mcp.json"), constants.COPYFILE_EXCL);
		if (await exists(oldImages)) await cp(oldImages, join(temp, "cache", "images"), { recursive: true, errorOnExist: true, force: false });
		if (await exists(oldAgent)) {
			for (const entry of await readdir(oldAgent)) {
				await cp(join(oldAgent, entry), join(temp, entry), { recursive: true, errorOnExist: true, force: false });
			}
		}
		for (const directory of ["sessions", "skills", "cache", "state"]) await mkdir(join(temp, directory), { recursive: true });
		await writeFile(join(temp, "USER.md"), "", { encoding: "utf8", mode: 0o600 });
		await writeFile(join(temp, "MEMORY.md"), "", { encoding: "utf8", mode: 0o600 });
		await installBuiltinSkills(temp, options.root ?? beemaxRoot());
		await verifyMigratedProfile(temp, {
			identity,
			oldAgent,
			oldImages,
			oldMcp,
			sourceHadMemory: await exists(oldMemory),
			sourceHadMcp: await exists(oldMcp),
		});
		await rename(temp, target.homePath);
	} catch (error) {
		await rm(temp, { recursive: true, force: true });
		throw error;
	}
	return target;
}

function defaultProfileYaml(): string {
	return stringifyYaml({
		agent: { toolset: "standard", maxSessions: 100, sessionIdleMs: 1800000, turnIdleSettleMs: 60000 },
		model: { provider: "anthropic", model: "claude-sonnet-4-5" },
		gateway: { feishu: { domain: "feishu", requireMention: true, allowedUsers: [], allowedChats: [], allowAllUsers: false }, channels: [] },
		memory: { dbPath: "memory.db", memberships: [] },
		mcp: { configPath: "mcp.json" },
		knowledge: { enabled: false, provider: "weknora", baseUrl: "http://127.0.0.1:8080", spaces: [] },
		imageGeneration: { enabled: false, provider: "openai-codex", quality: "medium", outputDir: "cache/images" },
		mediaUnderstanding: { localOcr: { enabled: true, timeoutMs: 30000 }, auxiliaryVisionEnabled: true },
		context: { maxTurnChars: 12000, maxToolResultTokens: 12000, compaction: { enabled: true } },
		execution: { backend: "local", mode: "off", workspaceAccess: "none", image: DEFAULT_DOCKER_SANDBOX_IMAGE, timeoutMs: 180000 },
		subagents: { enabled: true, maxConcurrent: DEFAULT_RUNTIME_RESOURCE_LIMITS.taskConcurrency, maxChildrenPerOwner: 5, timeoutMs: 900000 },
		automation: { enabled: true, timezone: "Asia/Shanghai", heartbeat: { enabled: true, every: "30m", activeHours: { start: "08:00", end: "23:00", timezone: "Asia/Shanghai" } } },
		paths: { agentDir: ".", cwd: "workspace" },
	});
}

async function installBuiltinSkills(profileHome: string, root: string): Promise<void> {
	const source = join(resolve(root), "skills", "builtin");
	if (!(await exists(source))) return;
	for (const entry of await readdir(source, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const destination = join(profileHome, "skills", entry.name);
		if (await exists(destination)) continue;
		await cp(join(source, entry.name), destination, { recursive: true, force: false, errorOnExist: true });
	}
}

async function writableProfilePaths(profile: string, options: ProfileStorageOptions): Promise<ProfilePaths> {
	const modern = profilePaths(profile, options);
	if (await exists(modern.configPath)) return modern;
	const legacy = legacyProfilePaths(profile, options);
	if (await exists(legacy.configPath)) return legacy;
	throw new Error(`Agent profile ${profile} does not exist; run beemax profile create ${profile}`);
}

async function exists(path: string): Promise<boolean> {
	try { await access(path); return true; } catch { return false; }
}

function absoluteFrom(root: string, path: string): string {
	return isAbsolute(path) ? path : resolve(root, path);
}

function configFromYaml(raw: string): Record<string, unknown> {
	return (parseYaml(raw) ?? {}) as Record<string, unknown>;
}

function stringAt(config: Record<string, unknown>, path: [string, string]): string | undefined {
	const value = asRecord(config[path[0]])[path[1]];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function verifyMigratedProfile(
	home: string,
	expected: { identity: string; oldAgent: string; oldImages: string; oldMcp: string; sourceHadMemory: boolean; sourceHadMcp: boolean },
): Promise<void> {
	const config = configFromYaml(await readFile(join(home, "config.yaml"), "utf8"));
	if (stringAt(config, ["memory", "dbPath"]) !== "memory.db"
		|| stringAt(config, ["mcp", "configPath"]) !== "mcp.json"
		|| stringAt(config, ["paths", "agentDir"]) !== ".") {
		throw new Error("Migrated Profile config failed path validation");
	}
	if ((await readFile(join(home, "SOUL.md"), "utf8")).trim() !== expected.identity) {
		throw new Error("Migrated Profile SOUL.md failed validation");
	}
	const env = await readEnvFile(join(home, ".env"));
	for (const key of PROFILE_ROUTING_ENV) if (key in env) throw new Error(`Migrated Profile retained reserved env ${key}`);
	if (expected.sourceHadMemory) verifySqliteDatabase(join(home, "memory.db"));
	if (expected.sourceHadMcp && (await stat(expected.oldMcp)).size !== (await stat(join(home, "mcp.json"))).size) {
		throw new Error("Migrated Profile MCP copy failed validation");
	}
	if (await exists(expected.oldAgent)) await verifyTreeCopied(expected.oldAgent, home);
	if (await exists(expected.oldImages)) await verifyTreeCopied(expected.oldImages, join(home, "cache", "images"));
}

async function verifyTreeCopied(source: string, destination: string): Promise<void> {
	const sourceManifest = await treeManifest(source);
	const destinationManifest = await treeManifest(destination);
	for (const [path, signature] of sourceManifest) {
		if (destinationManifest.get(path) !== signature) throw new Error(`Migrated Profile copy failed validation: ${path}`);
	}
}

async function treeManifest(root: string): Promise<Map<string, string>> {
	const manifest = new Map<string, string>();
	async function visit(path: string): Promise<void> {
		for (const entry of await readdir(path, { withFileTypes: true })) {
			const absolute = join(path, entry.name);
			const key = relative(root, absolute);
			if (entry.isDirectory()) {
				manifest.set(key, "directory");
				await visit(absolute);
			} else if (entry.isSymbolicLink()) {
				manifest.set(key, `symlink:${await readlink(absolute)}`);
			} else {
				manifest.set(key, `file:${(await lstat(absolute)).size}`);
			}
		}
	}
	await visit(root);
	return manifest;
}

const PROFILE_ROUTING_ENV = [
	"BEEMAX_HOME",
	"BEEMAX_ROOT",
	"BEEMAX_PROFILE",
	"BEEMAX_DB_PATH",
	"BEEMAX_MCP_CONFIG",
	"BEEMAX_IMAGE_OUTPUT_DIR",
	"BEEMAX_AGENT_DIR",
	"BEEMAX_CWD",
	"BEEMAX_SYSTEM_PROMPT",
] as const;

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function upsertGatewayChannel(value: unknown, channel: Record<string, unknown>): Record<string, unknown>[] {
	const channels = Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)) : [];
	return [...channels.filter((entry) => entry.id !== channel.id && entry.adapter !== channel.adapter), channel];
}

function removeGatewayChannel(value: unknown, adapter: string): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => !entry || typeof entry !== "object" || Array.isArray(entry) || (entry as Record<string, unknown>).adapter !== adapter) as Record<string, unknown>[];
}

function scrubLegacyChannelSecrets(config: Record<string, unknown>): void {
	for (const owner of [config, asRecord(config.gateway)]) {
		const feishu = asRecord(owner.feishu);
		for (const key of ["appId", "appSecret", "webhookVerificationToken", "webhookEncryptKey"]) delete feishu[key];
		if (Object.keys(feishu).length) owner.feishu = feishu;
	}
}

function sameModelChoice(value: unknown, model: { provider: string; model: string }): boolean {
	const candidate = asRecord(value);
	return candidate.provider === model.provider && candidate.model === model.model;
}
