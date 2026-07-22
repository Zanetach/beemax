import { homedir } from "node:os";
import { join } from "node:path";
import { validateProfileName } from "./profile-home.ts";

export type ServicePlatform = "linux" | "darwin";
export type ServiceScope = "user" | "system";
export type ServiceAction = "start" | "stop" | "restart" | "status" | "logs";

export interface ServiceCommand {
	command: string;
	args: string[];
	allowFailure?: boolean;
}

export interface ServicePlatformOptions {
	platform?: NodeJS.Platform;
	scope?: ServiceScope;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
}

export interface ServiceLayout {
	platform: ServicePlatform;
	scope: ServiceScope;
	unitDirectory: string;
	unitTemplatePath: string;
	targetPath?: string;
	environmentDirectory?: string;
}

/**
 * The single platform seam for service filesystem layout. Callers express
 * service intent and do not encode XDG, systemd, or launchd paths themselves.
 */
export function resolveServiceLayout(options: ServicePlatformOptions = {}): ServiceLayout {
	const platform = supportedPlatform(options.platform ?? process.platform);
	const scope = options.scope ?? "user";
	const env = options.env ?? process.env;
	const home = options.homeDir ?? homedir();
	if (platform === "darwin") {
		if (scope === "system") throw new Error("macOS system-wide Gateway services are not supported; use the user LaunchAgent");
		const unitDirectory = configuredPath(env.THRUVERA_LAUNCH_AGENTS_DIR) ?? join(home, "Library", "LaunchAgents");
		return { platform, scope, unitDirectory, unitTemplatePath: join(unitDirectory, "com.thruvera.agent.%i.plist") };
	}
	const userConfig = configuredPath(env.XDG_CONFIG_HOME) ?? join(home, ".config");
	const unitDirectory = scope === "user"
		? configuredPath(env.THRUVERA_SYSTEMD_USER_DIR) ?? join(userConfig, "systemd", "user")
		: configuredPath(env.THRUVERA_SYSTEMD_SYSTEM_DIR) ?? "/etc/systemd/system";
	return {
		platform,
		scope,
		unitDirectory,
		unitTemplatePath: join(unitDirectory, "thruvera@.service"),
		targetPath: join(unitDirectory, "thruvera.target"),
		environmentDirectory: scope === "system" ? configuredPath(env.THRUVERA_SYSTEM_CONFIG_DIR) ?? "/etc/thruvera" : undefined,
	};
}

export function serviceDisplayName(profile: string, platform: NodeJS.Platform = process.platform): string {
	validateProfileName(profile);
	if (platform === "linux") return `thruvera@${profile}.service`;
	if (platform === "darwin") return `com.thruvera.agent.${profile}`;
	return `thruvera:${profile}`;
}

export function serviceInstallationPath(profile: string, options: ServicePlatformOptions = {}): string {
	validateProfileName(profile);
	const layout = resolveServiceLayout(options);
	return layout.platform === "linux" ? layout.unitTemplatePath : join(layout.unitDirectory, `${serviceDisplayName(profile, "darwin")}.plist`);
}

export function resolveServiceCommands(action: ServiceAction, profile: string, options: ServicePlatformOptions = {}): ServiceCommand[] {
	validateProfileName(profile);
	const platform = supportedPlatform(options.platform ?? process.platform);
	const scope = options.scope ?? "user";
	if (platform === "linux") {
		const unit = serviceDisplayName(profile, platform);
		const scopeArgs = scope === "user" ? ["--user"] : [];
		if (action === "logs") return [{ command: "journalctl", args: [...scopeArgs, "-u", unit, "-f"] }];
		const serviceArgs = action === "start" ? ["enable", "--now", unit]
			: action === "stop" ? ["disable", "--now", unit] : [action, unit];
		return [{ command: "systemctl", args: [...scopeArgs, ...serviceArgs] }];
	}
	if (action === "logs") return [];
	const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;
	const label = serviceDisplayName(profile, platform);
	const plist = serviceInstallationPath(profile, { ...options, platform });
	if (action === "start") return [{ command: "launchctl", args: ["bootstrap", domain, plist] }];
	if (action === "stop") return [{ command: "launchctl", args: ["bootout", `${domain}/${label}`] }];
	if (action === "restart") return [
		{ command: "launchctl", args: ["bootout", `${domain}/${label}`], allowFailure: true },
		{ command: "launchctl", args: ["bootstrap", domain, plist] },
	];
	return [{ command: "launchctl", args: ["print", `${domain}/${label}`] }];
}

export function resolveServiceLogCommand(profile: string, tail: number, options: ServicePlatformOptions = {}): ServiceCommand | undefined {
	const platform = supportedPlatform(options.platform ?? process.platform);
	if (platform !== "linux") return undefined;
	const scopeArgs = (options.scope ?? "user") === "user" ? ["--user"] : [];
	return { command: "journalctl", args: [...scopeArgs, "-u", serviceDisplayName(profile, platform), "-n", String(tail), "--no-pager"] };
}

function supportedPlatform(platform: NodeJS.Platform): ServicePlatform {
	if (platform === "linux" || platform === "darwin") return platform;
	throw new Error(`Thruvera service management is not available on ${platform}; run 'thruvera gateway' under an external supervisor`);
}

function configuredPath(value: string | undefined): string | undefined {
	return value?.trim() || undefined;
}
