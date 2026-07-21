import { constants, type Stats } from "node:fs";
import { access, copyFile, cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { backupSqliteDatabase, verifySqliteDatabase } from "@beemax/memory";
import { DEFAULT_DOCKER_SANDBOX_IMAGE, DEFAULT_RUNTIME_RESOURCE_LIMITS } from "@beemax/core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { readEnvFile, renderEnv, writeEnvFile } from "./env-file.ts";
import { DEFAULT_SOUL, resolveSoul, validateCustomSoul } from "./soul.ts";
import { providerApiKeyEnv } from "./provider-resolver.ts";
import type { CustomProtocol } from "./config.ts";
import { mutateProfileConfig } from "./profile-config-transaction.ts";
import { inspectProfileSkillTree } from "./profile-skill-integrity.ts";
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
	const storageHome = resolve(options.home ?? beemaxHome());
	const existingStorageHome = await lstatIfPresent(storageHome);
	if (existingStorageHome && (existingStorageHome.isSymbolicLink() || !existingStorageHome.isDirectory())) {
		throw new Error(`BeeMax Home must be a real directory, not a symbolic link: ${storageHome}`);
	}
	await mkdir(storageHome, { recursive: true, mode: 0o700 });
	await ensureProfileOwnedDirectory(storageHome, dirname(paths.homePath));
	const profilesParent = await stableDirectoryIdentity(dirname(paths.homePath), "Profiles directory");
	if (await lstatIfPresent(paths.homePath)) throw new Error(`Agent profile ${profile} already exists`);
	const temp = `${paths.homePath}.creating-${crypto.randomUUID()}`;
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
		await installBuiltinSkills(temp, options.root);
		await assertSameDirectory(dirname(paths.homePath), profilesParent, "Profiles directory changed before Profile creation");
		if (await lstatIfPresent(paths.homePath)) throw new Error(`Agent profile ${profile} appeared during creation`);
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

/** Add missing packaged skills to the directory used by the Profile Skill Runtime without replacing custom skills. */
export async function syncBuiltinSkills(profile: string, options: ProfileStorageOptions = {}, agentDir?: string): Promise<ProfilePaths> {
	const paths = await writableProfilePaths(profile, options);
	await ensureCredentialVaultKey(profile, options);
	await syncBuiltinSkillsAtProfileHome(paths.dataPath, agentDir ?? paths.dataPath, options.root);
	return paths;
}

/** Startup upgrade hook for an already-resolved Profile; never crosses its Profile Home. */
export async function syncBuiltinSkillsAtProfileHome(profileHome: string, agentDir: string, rootOverride?: string): Promise<void> {
	const target = resolve(agentDir);
	await ensureProfileOwnedDirectory(resolve(profileHome), join(target, "skills"));
	await installBuiltinSkills(target, rootOverride);
}

/** Explicitly enable the pinned standard-web Provider without removing other operator-approved Providers. */
export async function enableStandardWebProvider(profile: string, options: ProfileStorageOptions = {}): Promise<ProfilePaths> {
	const paths = await writableProfilePaths(profile, options);
	const environment = await readEnvFile(paths.envPath);
	const environmentAllowedProviders = (environment.BEEMAX_PROVIDER_INSTALLATION_ALLOW ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	await mutateProfileConfig(paths.configPath, (config) => {
		const providers = asRecord(config.capabilityProviders);
		const installation = asRecord(providers.installation);
		const allowed = Array.isArray(installation.allowedProviders)
			? installation.allowedProviders.filter((value): value is string => typeof value === "string")
			: [];
		providers.installation = {
			...installation,
			enabled: true,
			allowedProviders: [...new Set([...allowed, ...environmentAllowedProviders, "exa-mcporter"])],
		};
		config.capabilityProviders = providers;
	});
	// An explicit install is the operator's opt-in. Fold legacy environment
	// overrides into YAML, then remove them so they cannot silently keep the
	// effective policy disabled after this command succeeds.
	delete environment.BEEMAX_PROVIDER_INSTALLATION_ENABLED;
	delete environment.BEEMAX_PROVIDER_INSTALLATION_ALLOW;
	await writeStableProfileTextFile(paths, paths.envPath, "Profile environment", renderEnv(environment), MAX_PROFILE_ENV_BYTES);
	return paths;
}

export async function ensureCredentialVaultKey(profile: string, options: ProfileStorageOptions = {}): Promise<ProfilePaths> {
	const paths = await writableProfilePaths(profile, options);
	const env = await readEnvFile(paths.envPath);
	const keyPath = join(paths.dataPath, "state", "credential-vault.key");
	const configured = env.BEEMAX_CREDENTIAL_VAULT_KEY || await readStableProfileTextFile(paths, keyPath, "Profile Credential Vault key", MAX_PROFILE_VAULT_KEY_BYTES, true);
	if (configured) {
		if (Buffer.from(configured, "base64").byteLength !== 32) throw new Error(`Credential Vault key is invalid for Profile '${profile}'`);
		return paths;
	}
	if (await exists(join(paths.dataPath, "credentials.vault"))) throw new Error(`Credential Vault key is missing for Profile '${profile}', but encrypted data already exists; restore the original Profile .env`);
	await ensureProfileOwnedDirectory(paths.homePath, dirname(keyPath));
	await writeStableProfileTextFile(paths, keyPath, "Profile Credential Vault key", Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"), MAX_PROFILE_VAULT_KEY_BYTES);
	return paths;
}

export async function deleteProfile(profile: string, options: ProfileStorageOptions = {}): Promise<ProfilePaths> {
	const paths = await writableProfilePaths(profile, options);
	const home = resolve(options.home ?? beemaxHome());
	let preserved = paths.dataPath;
	if (paths.configPath === join(paths.homePath, "config.yaml")) {
		const source = await stableDirectoryIdentity(paths.homePath, "Profile Home");
		const archive = join(home, "deleted", `${profile}-${Date.now()}-${crypto.randomUUID()}`);
		await ensureProfileOwnedDirectory(home, dirname(archive));
		const archiveParent = await stableDirectoryIdentity(dirname(archive), "Deleted Profiles directory");
		if (await lstatIfPresent(archive)) throw new Error(`Deleted Profile archive already exists: ${archive}`);
		await validateModernWritableProfile(paths, profile);
		await assertSameDirectory(paths.homePath, source, "Profile Home changed before deletion");
		await assertSameDirectory(dirname(archive), archiveParent, "Deleted Profiles directory changed before deletion");
		await rename(paths.homePath, archive);
		const archived = await stableDirectoryIdentity(archive, "Deleted Profile archive");
		if (archived.dev !== source.dev || archived.ino !== source.ino) throw new Error(`Profile Home changed during deletion: ${archive}`);
		await rm(join(archive, "config.yaml"), { force: true });
		await rm(join(archive, ".env"), { force: true });
		await rm(join(archive, "SOUL.md"), { force: true });
		preserved = archive;
	} else {
		await validateLegacyWritableProfile(paths);
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
	await writeStableProfileTextFile(paths, paths.envPath, "Profile environment", renderEnv({
		...await readEnvFile(paths.envPath),
		FEISHU_APP_ID: input.appId.trim(),
		FEISHU_APP_SECRET: input.appSecret.trim(),
		FEISHU_ALLOWED_USERS: input.allowedUsers.join(","),
		...(input.connectionMode === "webhook" ? {
			FEISHU_CONNECTION_MODE: "webhook",
			FEISHU_WEBHOOK_VERIFICATION_TOKEN: input.webhookVerificationToken ?? "",
			FEISHU_WEBHOOK_ENCRYPT_KEY: input.webhookEncryptKey ?? "",
		} : { FEISHU_CONNECTION_MODE: "websocket" }),
	}), MAX_PROFILE_ENV_BYTES);
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
	await writeStableProfileTextFile(paths, paths.envPath, "Profile environment", renderEnv({
		...await readEnvFile(paths.envPath),
		TELEGRAM_BOT_TOKEN: input.botToken.trim(),
	}), MAX_PROFILE_ENV_BYTES);
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
		await writeStableProfileTextFile(paths, paths.envPath, "Profile environment", renderEnv({
			...await readEnvFile(paths.envPath),
			[providerApiKeyEnv(input.provider)]: input.apiKey.trim(),
		}), MAX_PROFILE_ENV_BYTES);
	}
	return paths;
}

export async function configureSoul(profile: string, identity: string, options: ProfileStorageOptions = {}): Promise<ProfilePaths> {
	const value = validateCustomSoul(identity);
	const paths = await writableProfilePaths(profile, options);
	if (paths.configPath === join(paths.homePath, "config.yaml")) {
		await writeStableProfileTextFile(paths, paths.soulPath, "Profile SOUL", `${value}\n`, MAX_PROFILE_SOUL_BYTES);
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
	await writeStableProfileTextFile(paths, paths.envPath, "Profile environment", renderEnv(values), MAX_PROFILE_ENV_BYTES);
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
	await writeStableProfileTextFile(paths, paths.envPath, "Profile environment", renderEnv(values), MAX_PROFILE_ENV_BYTES);
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
	if (!(await lstatIfPresent(legacy.configPath))) throw new Error(`Legacy Agent profile ${profile} does not exist`);
	await validateLegacyWritableProfile(legacy);
	const existingHome = await lstatIfPresent(home);
	if (existingHome && (existingHome.isSymbolicLink() || !existingHome.isDirectory())) throw new Error(`BeeMax Home must be a real directory, not a symbolic link: ${home}`);
	await mkdir(home, { recursive: true, mode: 0o700 });
	await ensureProfileOwnedDirectory(home, dirname(target.homePath));
	const targetParent = await stableDirectoryIdentity(dirname(target.homePath), "Profiles directory");
	if (await lstatIfPresent(target.homePath)) throw new Error(`Agent profile ${profile} already exists at ${target.homePath}`);

	const legacyConfigParent = await stableDirectoryIdentity(dirname(legacy.configPath), "Legacy Profile configuration directory");
	const raw = await readStableTextFile(legacy.configPath, "Profile configuration", MAX_PROFILE_CONFIG_BYTES, false, legacyConfigParent.realPath);
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
	const capabilityProviders = asRecord(config.capabilityProviders);
	capabilityProviders.installation = migratedProviderInstallation(capabilityProviders.installation);
	config.capabilityProviders = capabilityProviders;
	delete config.imageGeneration;
	const pathsConfig = asRecord(config.paths);
	const workspace = absoluteFrom(root, legacyEnv.BEEMAX_CWD || (typeof pathsConfig.cwd === "string" ? pathsConfig.cwd : "."));
	config.paths = { ...pathsConfig, agentDir: ".", cwd: workspace };
	const oldMemory = absoluteFrom(root, legacyEnv.BEEMAX_DB_PATH || stringAt(originalConfig, ["memory", "dbPath"]) || join(legacy.dataPath, "beemax.db"));
	const oldMcp = absoluteFrom(root, legacyEnv.BEEMAX_MCP_CONFIG || stringAt(originalConfig, ["mcp", "configPath"]) || legacy.configPath.replace(/\.ya?ml$/i, ".mcp.json"));
	const oldAgent = absoluteFrom(root, legacyEnv.BEEMAX_AGENT_DIR || stringAt(originalConfig, ["paths", "agentDir"]) || join(legacy.dataPath, "agent"));
	const migratedEnv = { ...legacyEnv };
	for (const [envKey, configKey] of [["FEISHU_APP_ID", "appId"], ["FEISHU_APP_SECRET", "appSecret"], ["FEISHU_WEBHOOK_VERIFICATION_TOKEN", "webhookVerificationToken"], ["FEISHU_WEBHOOK_ENCRYPT_KEY", "webhookEncryptKey"]] as const) {
		const legacyValue = legacyFeishu[configKey];
		if (!migratedEnv[envKey] && typeof legacyValue === "string" && legacyValue.trim()) migratedEnv[envKey] = legacyValue.trim();
	}
	for (const key of PROFILE_ROUTING_ENV) delete migratedEnv[key];

	const temp = `${target.homePath}.migrating-${crypto.randomUUID()}`;
	await mkdir(temp, { recursive: false, mode: 0o700 });
	try {
		await writeFile(join(temp, "config.yaml"), stringifyYaml(config), { encoding: "utf8", mode: 0o600 });
		await writeFile(join(temp, "SOUL.md"), `${identity}\n`, { encoding: "utf8", mode: 0o600 });
		await writeEnvFile(join(temp, ".env"), migratedEnv);
		if (await exists(oldMemory)) await backupSqliteDatabase(oldMemory, join(temp, "memory.db"));
		if (await exists(oldMcp)) await copyFile(oldMcp, join(temp, "mcp.json"), constants.COPYFILE_EXCL);
		if (await exists(oldAgent)) {
			for (const entry of await readdir(oldAgent)) {
				await cp(join(oldAgent, entry), join(temp, entry), { recursive: true, errorOnExist: true, force: false });
			}
		}
		for (const directory of ["sessions", "skills", "cache", "state"]) await mkdir(join(temp, directory), { recursive: true });
		await writeFile(join(temp, "USER.md"), "", { encoding: "utf8", mode: 0o600 });
		await writeFile(join(temp, "MEMORY.md"), "", { encoding: "utf8", mode: 0o600 });
		await installBuiltinSkills(temp, options.root);
		await verifyMigratedProfile(temp, {
			identity,
			oldAgent,
			oldMcp,
			sourceHadMemory: await exists(oldMemory),
			sourceHadMcp: await exists(oldMcp),
		});
		await assertSameDirectory(dirname(target.homePath), targetParent, "Profiles directory changed before Profile migration");
		if (await lstatIfPresent(target.homePath)) throw new Error(`Agent profile ${profile} appeared during migration`);
		await rename(temp, target.homePath);
	} catch (error) {
		await rm(temp, { recursive: true, force: true });
		throw error;
	}
	return target;
}

function migratedProviderInstallation(value: unknown): Record<string, unknown> {
	const installation = asRecord(value);
	const configuredAllowlist = installation.allowedProviders;
	const hasExplicitEnabled = typeof installation.enabled === "boolean";
	const hasExplicitAllowlist = Array.isArray(configuredAllowlist);
	if (hasExplicitEnabled && hasExplicitAllowlist) return installation;
	// A legacy operator's explicit false is an opt-out even when an older
	// release did not persist the companion allowlist field.
	if (installation.enabled === false) return { ...installation, enabled: false, allowedProviders: [] };
	const allowedProviders = hasExplicitAllowlist
		? configuredAllowlist.filter((provider: unknown): provider is string => typeof provider === "string")
		: [];
	return {
		...installation,
		enabled: true,
		allowedProviders: [...new Set([...allowedProviders, "exa-mcporter"])],
	};
}

function defaultProfileYaml(): string {
	return stringifyYaml({
		agent: { toolset: "standard", maxSessions: 100, sessionIdleMs: 1800000 },
		model: { provider: "anthropic", model: "claude-sonnet-4-5" },
		gateway: { artifactSite: { enabled: true }, feishu: { domain: "feishu", requireMention: true, allowedUsers: [], allowedChats: [], allowAllUsers: false }, channels: [] },
		memory: { dbPath: "memory.db", memberships: [] },
		mcp: { configPath: "mcp.json" },
		capabilityProviders: { installation: { enabled: true, allowedProviders: ["exa-mcporter"] } },
		knowledge: { enabled: false, provider: "weknora", baseUrl: "http://127.0.0.1:8080", spaces: [] },
		mediaUnderstanding: { localOcr: { enabled: true, timeoutMs: 30000 }, auxiliaryVisionEnabled: true },
		context: { maxTurnChars: 12000, maxToolResultTokens: 12000, compaction: { enabled: true } },
		execution: { backend: "local", mode: "off", workspaceAccess: "none", image: DEFAULT_DOCKER_SANDBOX_IMAGE, timeoutMs: 180000 },
		subagents: { enabled: true, maxConcurrent: DEFAULT_RUNTIME_RESOURCE_LIMITS.taskConcurrency, maxChildrenPerOwner: 5, timeoutMs: 900000 },
		automation: { enabled: true, timezone: "Asia/Shanghai", heartbeat: { enabled: true, every: "30m", activeHours: { start: "08:00", end: "23:00", timezone: "Asia/Shanghai" } } },
		paths: { agentDir: ".", cwd: "workspace" },
	});
}

const REQUIRED_BUILTIN_SKILLS = ["agent-reach", "pi-web-access"] as const;
const MAX_PROFILE_CONFIG_BYTES = 1024 * 1024;
const MAX_PROFILE_ENV_BYTES = 256 * 1024;
const MAX_PROFILE_SOUL_BYTES = 64 * 1024;
const MAX_PROFILE_VAULT_KEY_BYTES = 4 * 1024;

async function installBuiltinSkills(profileHome: string, rootOverride?: string): Promise<void> {
	const packagedSource = fileURLToPath(new URL("../../../skills/builtin/", import.meta.url));
	const overrideSource = rootOverride ? join(resolve(rootOverride), "skills", "builtin") : undefined;
	const overrideInfo = overrideSource
		? await lstat(overrideSource).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		})
		: undefined;
	// BEEMAX_ROOT controls Profile/workspace storage in several CLI workflows;
	// it is not necessarily the installation directory that owns packaged assets.
	// Keep an explicit existing fixture/installation override, otherwise resolve
	// bundled Skills relative to the installed CLI module.
	const source = overrideInfo ? overrideSource! : packagedSource;
	const packagedSkills = dirname(source);
	const [packagedSkillsInfo, sourceInfo] = await Promise.all([
		lstat(packagedSkills).catch(() => undefined),
		lstat(source).catch(() => undefined),
	]);
	if (!packagedSkillsInfo?.isDirectory() || packagedSkillsInfo.isSymbolicLink() || !sourceInfo?.isDirectory() || sourceInfo.isSymbolicLink()) {
		throw new Error(`Packaged builtin Skills directory is missing or invalid: ${source}`);
	}
	for (const name of REQUIRED_BUILTIN_SKILLS) {
		const skillRoot = join(source, name);
		if ((await inspectProfileSkillTree(source, name)).state !== "present") {
			throw new Error(`Required packaged builtin Skill '${name}' is missing or invalid: ${skillRoot}`);
		}
	}
	const targetSkills = join(profileHome, "skills");
	const targetSkillsInfo = await lstat(targetSkills).catch(() => undefined);
	if (!targetSkillsInfo?.isDirectory() || targetSkillsInfo.isSymbolicLink()) throw new Error(`Profile Skills directory is missing or invalid: ${targetSkills}`);
	for (const entry of await readdir(source, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const destination = join(targetSkills, entry.name);
		if (await exists(destination)) continue;
		await cp(join(source, entry.name), destination, { recursive: true, force: false, errorOnExist: true });
	}
	for (const name of REQUIRED_BUILTIN_SKILLS) {
		if ((await inspectProfileSkillTree(targetSkills, name)).state !== "present") {
			throw new Error(`Profile Skill '${name}' is missing or invalid after builtin synchronization: ${join(targetSkills, name)}`);
		}
	}
}

async function ensureProfileOwnedDirectory(profileHome: string, target: string): Promise<void> {
	const boundary = resolve(profileHome);
	const destination = resolve(target);
	const relativeTarget = relative(boundary, destination);
	if (isAbsolute(relativeTarget) || relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
		throw new Error(`Profile-owned directory must stay inside its Profile Home: ${destination}`);
	}
	const boundaryInfo = await lstat(boundary);
	if (boundaryInfo.isSymbolicLink() || !boundaryInfo.isDirectory()) throw new Error(`Profile Home must be a real directory: ${boundary}`);
	let current = boundary;
	for (const segment of relativeTarget.split(sep).filter(Boolean)) {
		current = join(current, segment);
		let info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (!info) {
			await mkdir(current, { recursive: false, mode: 0o700 });
			info = await lstat(current);
		}
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Profile-owned path must be a real directory: ${current}`);
	}
	const [realBoundary, realDestination] = await Promise.all([realpath(boundary), realpath(destination)]);
	const relativeReal = relative(realBoundary, realDestination);
	if (isAbsolute(relativeReal) || relativeReal === ".." || relativeReal.startsWith(`..${sep}`)) throw new Error(`Profile-owned directory escapes its Profile Home: ${destination}`);
}

async function writableProfilePaths(profile: string, options: ProfileStorageOptions): Promise<ProfilePaths> {
	const modern = profilePaths(profile, options);
	// The Home entry itself is authoritative. A missing, unreadable, or linked
	// config beneath an existing modern Home must never redirect writes into the
	// legacy/global layout.
	if (await lstatIfPresent(modern.homePath)) {
		await validateModernWritableProfile(modern, profile);
		return modern;
	}
	const legacy = legacyProfilePaths(profile, options);
	if (await lstatIfPresent(legacy.configPath)) {
		await validateLegacyWritableProfile(legacy);
		return legacy;
	}
	throw new Error(`Agent profile ${profile} does not exist; run beemax profile create ${profile}`);
}

async function validateModernWritableProfile(paths: ProfilePaths, profile: string): Promise<void> {
	const parent = await stableDirectoryIdentity(dirname(paths.homePath), "Profiles directory");
	const home = await stableDirectoryIdentity(paths.homePath, "Profile Home");
	if (relative(parent.realPath, home.realPath) !== profile) {
		throw new Error(`Profile Home escapes the selected Profile '${profile}': ${paths.homePath}`);
	}
	await assertStableRegularFile(paths.configPath, "Profile configuration", MAX_PROFILE_CONFIG_BYTES, false, home.realPath);
	await assertStableRegularFile(paths.envPath, "Profile environment", MAX_PROFILE_ENV_BYTES, true, home.realPath);
	await assertStableRegularFile(paths.soulPath, "Profile SOUL", MAX_PROFILE_SOUL_BYTES, true, home.realPath);
	const statePath = join(paths.homePath, "state");
	const state = await lstatIfPresent(statePath);
	if (state) await assertStableDirectoryInside(statePath, "Profile state directory", home.realPath);
	await assertStableRegularFile(join(statePath, "credential-vault.key"), "Profile Credential Vault key", MAX_PROFILE_VAULT_KEY_BYTES, true, home.realPath);
	await assertSameDirectory(paths.homePath, home, "Profile Home changed while resolving writable files");
}

async function validateLegacyWritableProfile(paths: ProfilePaths): Promise<void> {
	const configParent = await stableDirectoryIdentity(dirname(paths.configPath), "Legacy Profile configuration directory");
	await assertStableRegularFile(paths.configPath, "Profile configuration", MAX_PROFILE_CONFIG_BYTES, false, configParent.realPath);
	await assertStableRegularFile(paths.envPath, "Profile environment", MAX_PROFILE_ENV_BYTES, true, configParent.realPath);
	const data = await lstatIfPresent(paths.homePath);
	if (data) {
		const home = await stableDirectoryIdentity(paths.homePath, "Profile Home");
		const statePath = join(paths.homePath, "state");
		const state = await lstatIfPresent(statePath);
		if (state) await assertStableDirectoryInside(statePath, "Profile state directory", home.realPath);
		await assertStableRegularFile(join(statePath, "credential-vault.key"), "Profile Credential Vault key", MAX_PROFILE_VAULT_KEY_BYTES, true, home.realPath);
	}
}

async function writeStableProfileTextFile(
	paths: ProfilePaths,
	path: string,
	label: string,
	content: string,
	maxBytes: number,
): Promise<void> {
	const encoded = Buffer.from(content, "utf8");
	if (encoded.byteLength > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte size limit: ${path}`);
	const modern = paths.configPath === join(paths.homePath, "config.yaml");
	if (modern) await validateModernWritableProfile(paths, basename(paths.homePath));
	else await validateLegacyWritableProfile(paths);
	const parent = await stableDirectoryIdentity(dirname(path), `${label} parent`);
	const profileHome = modern ? (await stableDirectoryIdentity(paths.homePath, "Profile Home")).realPath : undefined;
	if (profileHome && !pathIsInside(profileHome, parent.realPath)) throw new Error(`${label} parent escapes its Profile Home: ${path}`);
	const existing = await stableOptionalFileState(path, label, maxBytes, parent.realPath);
	let temporary = join(dirname(path), `.${basename(path) || "profile"}-${crypto.randomUUID()}.tmp`);
	try {
		const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
		try {
			await handle.writeFile(encoded);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await assertSameDirectory(dirname(path), parent, `${label} parent changed before publish`);
		await assertSameOptionalFile(path, label, existing);
		await rename(temporary, path);
		temporary = "";
		await assertSameDirectory(dirname(path), parent, `${label} parent changed during publish`);
		await assertStableRegularFile(path, label, maxBytes, false, parent.realPath);
		await syncStableDirectory(dirname(path), parent, label);
	} finally {
		if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
	}
}

async function readStableProfileTextFile(
	paths: ProfilePaths,
	path: string,
	label: string,
	maxBytes: number,
	optional: boolean,
): Promise<string> {
	const modern = paths.configPath === join(paths.homePath, "config.yaml");
	if (modern) await validateModernWritableProfile(paths, basename(paths.homePath));
	else await validateLegacyWritableProfile(paths);
	if (optional && !(await lstatIfPresent(path))) return "";
	const boundary = modern ? (await stableDirectoryIdentity(paths.homePath, "Profile Home")).realPath : (await stableDirectoryIdentity(dirname(path), `${label} parent`)).realPath;
	return readStableTextFile(path, label, maxBytes, optional, boundary);
}

async function readStableTextFile(path: string, label: string, maxBytes: number, optional: boolean, boundary: string): Promise<string> {
	const initial = await lstatIfPresent(path);
	if (!initial) {
		if (optional) return "";
		throw new Error(`${label} is missing: ${path}`);
	}
	if (initial.isSymbolicLink() || !initial.isFile()) throw new Error(`${label} must be a regular file, not a symbolic link: ${path}`);
	if (initial.size > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte size limit: ${path}`);
	const realPath = await realpath(path);
	if (!pathIsInside(boundary, realPath)) throw new Error(`${label} escapes its Profile boundary: ${path}`);
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || !sameFilesystemObject(initial, opened)) throw new Error(`${label} changed while opening: ${path}`);
		const bytes = await readBoundedFile(handle, maxBytes, label);
		const finalOpened = await handle.stat();
		const finalPath = await lstat(path);
		if (finalPath.isSymbolicLink()
			|| !finalPath.isFile()
			|| !sameFileState(fileState(initial), fileState(finalPath))
			|| !sameFileState(fileState(opened), fileState(finalOpened))
			|| await realpath(path) !== realPath) {
			throw new Error(`${label} changed while reading: ${path}`);
		}
		try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
		catch { throw new Error(`${label} is not valid UTF-8: ${path}`); }
	} finally {
		await handle.close();
	}
}

interface StableDirectoryIdentity {
	dev: number;
	ino: number;
	realPath: string;
}

interface StableFileState {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}

async function stableDirectoryIdentity(path: string, label: string): Promise<StableDirectoryIdentity> {
	const initial = await lstat(path);
	if (initial.isSymbolicLink() || !initial.isDirectory()) throw new Error(`${label} must be a real directory, not a symbolic link: ${path}`);
	const realPath = await realpath(path);
	const final = await lstat(path);
	if (final.isSymbolicLink() || !final.isDirectory() || !sameFilesystemObject(initial, final) || await realpath(path) !== realPath) {
		throw new Error(`${label} changed while resolving: ${path}`);
	}
	return { dev: initial.dev, ino: initial.ino, realPath };
}

async function assertStableDirectoryInside(path: string, label: string, boundary: string): Promise<StableDirectoryIdentity> {
	const identity = await stableDirectoryIdentity(path, label);
	if (!pathIsInside(boundary, identity.realPath)) throw new Error(`${label} escapes its Profile Home: ${path}`);
	return identity;
}

async function assertSameDirectory(path: string, expected: StableDirectoryIdentity, message: string): Promise<void> {
	const current = await lstat(path);
	if (current.isSymbolicLink()
		|| !current.isDirectory()
		|| current.dev !== expected.dev
		|| current.ino !== expected.ino
		|| await realpath(path) !== expected.realPath) throw new Error(`${message}: ${path}`);
}

async function assertStableRegularFile(path: string, label: string, maxBytes: number, optional: boolean, boundary: string): Promise<StableFileState | undefined> {
	const initial = await lstatIfPresent(path);
	if (!initial) {
		if (optional) return undefined;
		throw new Error(`${label} is missing: ${path}`);
	}
	if (initial.isSymbolicLink() || !initial.isFile()) throw new Error(`${label} must be a regular file, not a symbolic link: ${path}`);
	if (initial.size > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte size limit: ${path}`);
	const realPath = await realpath(path);
	if (!pathIsInside(boundary, realPath)) throw new Error(`${label} escapes its Profile boundary: ${path}`);
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const opened = await handle.stat();
		const final = await lstat(path);
		if (!opened.isFile()
			|| final.isSymbolicLink()
			|| !final.isFile()
			|| !sameFileState(fileState(initial), fileState(opened))
			|| !sameFileState(fileState(initial), fileState(final))
			|| await realpath(path) !== realPath) throw new Error(`${label} changed while opening: ${path}`);
		return fileState(initial);
	} finally {
		await handle.close();
	}
}

async function stableOptionalFileState(path: string, label: string, maxBytes: number, boundary: string): Promise<StableFileState | undefined> {
	return assertStableRegularFile(path, label, maxBytes, true, boundary);
}

async function assertSameOptionalFile(path: string, label: string, expected: StableFileState | undefined): Promise<void> {
	const current = await lstatIfPresent(path);
	if (!expected) {
		if (current) throw new Error(`${label} appeared before publish: ${path}`);
		return;
	}
	if (!current || current.isSymbolicLink() || !current.isFile() || !sameFileState(expected, fileState(current))) {
		throw new Error(`${label} changed before publish: ${path}`);
	}
}

async function syncStableDirectory(path: string, expected: StableDirectoryIdentity, label: string): Promise<void> {
	const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
	try {
		const opened = await handle.stat();
		if (!opened.isDirectory() || opened.dev !== expected.dev || opened.ino !== expected.ino) throw new Error(`${label} parent changed while syncing: ${path}`);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function readBoundedFile(handle: Awaited<ReturnType<typeof open>>, maxBytes: number, label: string): Promise<Buffer> {
	const buffer = Buffer.alloc(maxBytes + 1);
	let offset = 0;
	while (offset < buffer.length) {
		const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	if (offset > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte size limit`);
	return buffer.subarray(0, offset);
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
	return lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
}

function pathIsInside(boundary: string, candidate: string): boolean {
	const relation = relative(boundary, candidate);
	return !isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`);
}

function fileState(value: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): StableFileState {
	return { dev: value.dev, ino: value.ino, size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs };
}

function sameFilesystemObject(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameFileState(left: StableFileState, right: StableFileState): boolean {
	return sameFilesystemObject(left, right)
		&& left.size === right.size
		&& left.mtimeMs === right.mtimeMs
		&& left.ctimeMs === right.ctimeMs;
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
	expected: { identity: string; oldAgent: string; oldMcp: string; sourceHadMemory: boolean; sourceHadMcp: boolean },
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
