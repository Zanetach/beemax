import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { beemaxRoot, validateProfileName } from "./config.ts";
import { readEnvFile, writeEnvFile } from "./env-file.ts";

export interface FeishuChannelInput {
	appId: string;
	appSecret: string;
	domain?: "feishu" | "lark";
	requireMention?: boolean;
	allowedUsers: string[];
	allowedChats?: string[];
}

export interface ProfilePaths {
	configPath: string;
	envPath: string;
	dataPath: string;
}

export interface ModelInput {
	provider: string;
	model: string;
	apiKey?: string;
	baseUrl?: string;
}

export function profilePaths(profile: string, root = beemaxRoot()): ProfilePaths {
	validateProfileName(profile);
	const configDir = join(resolve(root), "config", "profiles");
	return {
		configPath: join(configDir, `${profile}.yaml`),
		envPath: join(configDir, `${profile}.env`),
		dataPath: join(resolve(root), "data", "profiles", profile),
	};
}

export async function createProfile(profile: string, root = beemaxRoot()): Promise<ProfilePaths> {
	const paths = profilePaths(profile, root);
	await mkdir(dirname(paths.configPath), { recursive: true });
	try {
		await writeFile(paths.configPath, defaultProfileYaml(profile), { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Agent profile ${profile} already exists`);
		throw error;
	}
	return paths;
}

export async function listProfiles(root = beemaxRoot()): Promise<string[]> {
	const profiles = new Set<string>();
	try {
		await readFile(join(resolve(root), "config", "beemax.yaml"), "utf8");
		profiles.add("default");
	} catch { /* optional default profile */ }
	try {
		for (const entry of await readdir(join(resolve(root), "config", "profiles"))) {
			if (/^[a-z0-9][a-z0-9_-]{0,31}\.ya?ml$/.test(entry)) profiles.add(entry.replace(/\.ya?ml$/, ""));
		}
	} catch { /* no profiles yet */ }
	return [...profiles].sort();
}

export async function deleteProfile(profile: string, root = beemaxRoot()): Promise<ProfilePaths> {
	const paths = profilePaths(profile, root);
	await rm(paths.configPath, { force: true });
	await rm(paths.envPath, { force: true });
	return paths;
}

export async function configureFeishuChannel(
	profile: string,
	input: FeishuChannelInput,
	root = beemaxRoot(),
): Promise<ProfilePaths> {
	if (!input.appId.trim() || !input.appSecret.trim()) throw new Error("Feishu App ID and App Secret are required");
	if (input.allowedUsers.length === 0) throw new Error("At least one allowed Feishu user ID is required");
	const paths = profilePaths(profile, root);
	const raw = await readFile(paths.configPath, "utf8").catch(() => {
		throw new Error(`Agent profile ${profile} does not exist; run beemax agent create ${profile}`);
	});
	const config = (parseYaml(raw) ?? {}) as Record<string, unknown>;
	config.feishu = {
		...asRecord(config.feishu),
		domain: input.domain ?? "feishu",
		requireMention: input.requireMention ?? true,
		allowedChats: input.allowedChats ?? [],
		allowAllUsers: false,
	};
	await writeFile(paths.configPath, stringifyYaml(config), { encoding: "utf8", mode: 0o600 });
	await writeEnvFile(paths.envPath, {
		...await readEnvFile(paths.envPath),
		FEISHU_APP_ID: input.appId.trim(),
		FEISHU_APP_SECRET: input.appSecret.trim(),
		FEISHU_ALLOWED_USERS: input.allowedUsers.join(","),
	});
	return paths;
}

export async function configureModel(profile: string, input: ModelInput, root = beemaxRoot()): Promise<ProfilePaths> {
	if (!input.provider.trim() || !input.model.trim()) throw new Error("Model provider and model ID are required");
	const paths = profilePaths(profile, root);
	const raw = await readFile(paths.configPath, "utf8").catch(() => {
		throw new Error(`Agent profile ${profile} does not exist; run beemax agent create ${profile}`);
	});
	const config = (parseYaml(raw) ?? {}) as Record<string, unknown>;
	config.model = {
		provider: input.provider.trim(),
		model: input.model.trim(),
		...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
	};
	await writeFile(paths.configPath, stringifyYaml(config), { encoding: "utf8", mode: 0o600 });
	if (input.apiKey?.trim()) {
		await writeEnvFile(paths.envPath, {
			...await readEnvFile(paths.envPath),
			BEEMAX_API_KEY: input.apiKey.trim(),
		});
	}
	return paths;
}

export async function removeFeishuChannel(profile: string, root = beemaxRoot()): Promise<ProfilePaths> {
	const paths = profilePaths(profile, root);
	const values = await readEnvFile(paths.envPath);
	delete values.FEISHU_APP_ID;
	delete values.FEISHU_APP_SECRET;
	delete values.FEISHU_ALLOWED_USERS;
	await writeEnvFile(paths.envPath, values);
	return paths;
}

export async function testFeishuCredentials(
	input: Pick<FeishuChannelInput, "appId" | "appSecret" | "domain">,
	fetcher: typeof fetch = fetch,
): Promise<string> {
	const origin = input.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
	const response = await fetcher(`${origin}/open-apis/auth/v3/tenant_access_token/internal`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ app_id: input.appId, app_secret: input.appSecret }),
		signal: AbortSignal.timeout(15_000),
	});
	const body = await response.json() as { code?: number; msg?: string; tenant_access_token?: string };
	if (!response.ok || body.code !== 0 || !body.tenant_access_token) {
		throw new Error(`Feishu credential check failed: ${body.msg ?? `HTTP ${response.status}`}`);
	}
	return "Feishu credentials are valid";
}

function defaultProfileYaml(profile: string): string {
	return stringifyYaml({
		agent: { systemPrompt: "You are my private personal assistant. Keep responses concise and surface only actionable information." },
		model: { provider: "anthropic", model: "claude-sonnet-4-5" },
		feishu: { domain: "feishu", requireMention: true, allowedUsers: [], allowedChats: [], allowAllUsers: false },
		memory: { dbPath: `data/profiles/${profile}/beemax.db` },
		mcp: { configPath: `config/profiles/${profile}.mcp.json` },
		imageGeneration: { enabled: false, provider: "openai-codex", quality: "medium", outputDir: `data/profiles/${profile}/cache/images` },
		subagents: { enabled: true, maxConcurrent: 3, maxChildrenPerOwner: 5, timeoutMs: 900000 },
		automation: { enabled: true, timezone: "Asia/Shanghai", heartbeat: { enabled: true, every: "30m", activeHours: { start: "08:00", end: "23:00", timezone: "Asia/Shanghai" } } },
		paths: { agentDir: `data/profiles/${profile}/agent`, cwd: "." },
	});
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
