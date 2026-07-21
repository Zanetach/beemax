import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface ProfileStorageOptions {
	root?: string;
	home?: string;
}

export interface ProfilePaths {
	homePath: string;
	configPath: string;
	envPath: string;
	soulPath: string;
	dataPath: string;
}

export interface ProfileLocation extends ProfilePaths {
	basePath: string;
	isHome: boolean;
}

export function beemaxRoot(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.BEEMAX_ROOT?.trim() || process.cwd());
}

export function beemaxHome(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.BEEMAX_HOME?.trim() || join(homedir(), ".beemax"));
}

export function profilePaths(profile: string, options: ProfileStorageOptions = {}): ProfilePaths {
	validateProfileName(profile);
	const homePath = join(resolve(options.home ?? beemaxHome()), "profiles", profile);
	return {
		homePath,
		configPath: join(homePath, "config.yaml"),
		envPath: join(homePath, ".env"),
		soulPath: join(homePath, "SOUL.md"),
		dataPath: homePath,
	};
}

export function legacyProfilePaths(profile: string, options: ProfileStorageOptions = {}): ProfilePaths {
	validateProfileName(profile);
	const root = resolve(options.root ?? beemaxRoot());
	const configPath = profile === "default"
		? join(root, "config", "beemax.yaml")
		: join(root, "config", "profiles", `${profile}.yaml`);
	const dataPath = profile === "default" ? join(root, "data") : join(root, "data", "profiles", profile);
	return {
		homePath: dataPath,
		configPath,
		envPath: configPath.replace(/\.ya?ml$/i, ".env"),
		soulPath: join(dataPath, "SOUL.md"),
		dataPath,
	};
}

export function resolveProfileLocation(
	profile: string,
	explicitConfig?: string,
	options: ProfileStorageOptions = {},
): ProfileLocation {
	const root = resolve(options.root ?? beemaxRoot());
	const home = resolve(options.home ?? beemaxHome());
	const modern = profilePaths(profile, { root, home });
	if (explicitConfig) {
		const configPath = isAbsolute(explicitConfig) ? explicitConfig : resolve(root, explicitConfig);
		const basePath = dirname(configPath);
		const isHome = configPath === modern.configPath || existsSync(join(basePath, "SOUL.md"));
		if (isHome && basename(basePath) !== profile) {
			throw new Error(`Explicit Profile config path belongs to '${basename(basePath)}', not requested Profile '${profile}'`);
		}
		return {
			...(isHome ? { ...modern, homePath: basePath, dataPath: basePath } : legacyProfilePaths(profile, { root, home })),
			configPath,
			envPath: isHome ? join(basePath, ".env") : configPath.replace(/\.ya?ml$/i, ".env"),
			soulPath: join(basePath, "SOUL.md"),
			basePath: isHome ? basePath : root,
			isHome,
		};
	}
	// Once a modern Profile Home exists, never fall back to stale legacy/global
	// configuration merely because config.yaml is missing or temporarily unreadable.
	if (pathEntryExists(modern.homePath)) return { ...modern, basePath: modern.homePath, isHome: true };
	const legacy = legacyProfilePaths(profile, { root, home });
	return { ...legacy, basePath: root, isHome: false };
}

function pathEntryExists(path: string): boolean {
	try { lstatSync(path); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export function activeProfile(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.BEEMAX_PROFILE?.trim();
	if (explicit) {
		validateProfileName(explicit);
		return explicit;
	}
	try {
		const selected = readFileSync(join(beemaxHome(env), "active-profile"), "utf8").trim();
		if (!selected) throw new Error("BeeMax active-profile marker is empty");
		validateProfileName(selected);
		return selected;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return "default";
}

export function validateProfileName(profile: string): void {
	if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(profile)) {
		throw new Error(`Invalid profile name: ${profile}. Use lowercase letters, numbers, hyphens, or underscores.`);
	}
}
