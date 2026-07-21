import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { beemaxHome, beemaxRoot, validateProfileName } from "./config.ts";
import { readGatewayLogs } from "./gateway-observability.ts";
import { resolveServiceCommands, resolveServiceLayout, serviceDisplayName, type ServiceAction, type ServiceScope } from "./service-platform.ts";

type Runner = (command: string, args: string[]) => Pick<SpawnSyncReturns<Buffer>, "status" | "error">;
type RetryDelay = (milliseconds: number) => Promise<void>;
export type { ServiceScope } from "./service-platform.ts";
export type { ServiceAction } from "./service-platform.ts";

export interface ServiceInstallOptions {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	nodePath?: string;
	runner?: Runner;
}

export interface ServiceResourceLimits {
	memoryMax?: string;
	cpuQuota?: string;
	tasksMax?: number;
}

export function renderSystemdService(
	root = beemaxRoot(),
	nodePath = process.execPath,
	scope: ServiceScope = "user",
	serviceUser?: string,
	home = beemaxHome(),
	systemEnvironmentDirectory = "/etc/beemax",
	resourceLimits: ServiceResourceLimits = {},
): string {
	const absoluteRoot = resolve(root);
	const absoluteHome = resolve(home);
	const cliPath = join(absoluteRoot, "apps", "cli", "dist", "cli.js");
	const limits = normalizeServiceResourceLimits(resourceLimits);
	return `[Unit]
Description=BeeMax Agent profile %i
After=network-online.target
Wants=network-online.target
PartOf=beemax.target

[Service]
Type=simple
${scope === "system" ? `User=${serviceUser ?? "beemax"}\n` : ""}WorkingDirectory=${systemdQuote(absoluteRoot)}
# Profile .env is read through BeeMax's scoped config boundary; never inject it into the host process environment.
EnvironmentFile=-${systemdQuote(join(systemEnvironmentDirectory, "%i.env"))}
Environment=NODE_ENV=production
Environment=BEEMAX_PROFILE=%i
ExecStart=${systemdQuote(nodePath)} ${systemdQuote(cliPath)} gateway --profile %i --home ${systemdQuote(absoluteHome)} --root ${systemdQuote(absoluteRoot)}
Restart=on-failure
RestartSec=5s
StartLimitIntervalSec=60
StartLimitBurst=5
TimeoutStopSec=60s
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
MemoryMax=${limits.memoryMax}
CPUQuota=${limits.cpuQuota}
TasksMax=${limits.tasksMax}
UMask=0077
StandardOutput=journal
StandardError=journal
LogRateLimitIntervalSec=30s
LogRateLimitBurst=200
SyslogIdentifier=beemax-%i

[Install]
WantedBy=${scope === "user" ? "default.target" : "multi-user.target"}
`;
}

export async function installSystemdService(
	root = beemaxRoot(),
	scope: ServiceScope = "user",
	options: ServiceInstallOptions = {},
): Promise<void> {
	const platform = options.platform ?? process.platform;
	if (platform !== "linux") throw new Error("systemd installation is supported only on Linux");
	const env = options.env ?? process.env;
	const layout = resolveServiceLayout({ platform, scope, env, homeDir: options.homeDir });
	const runner = options.runner ?? runInherited;
	if (scope === "system" && typeof process.getuid === "function" && process.getuid() !== 0) {
		throw new Error("systemd installation requires root; rerun with sudo");
	}
	const serviceUser = scope === "system"
		? env.BEEMAX_SERVICE_USER || env.SUDO_USER || (env.USER !== "root" ? env.USER : undefined)
		: undefined;
	if (scope === "system" && !serviceUser) {
		throw new Error("systemd system service needs a non-root account; set BEEMAX_SERVICE_USER");
	}
	const serviceHome = scope === "system" ? env.BEEMAX_HOME?.trim() : beemaxHome(env);
	if (!serviceHome) {
		throw new Error("systemd system service needs an explicit BEEMAX_HOME owned by BEEMAX_SERVICE_USER");
	}
	await mkdir(layout.unitDirectory, { recursive: true });
	if (layout.environmentDirectory) await mkdir(layout.environmentDirectory, { recursive: true, mode: 0o700 });
	await writeFile(layout.unitTemplatePath, renderSystemdService(root, options.nodePath ?? process.execPath, scope, serviceUser, serviceHome, layout.environmentDirectory, {
		memoryMax: env.BEEMAX_SERVICE_MEMORY_MAX,
		cpuQuota: env.BEEMAX_SERVICE_CPU_QUOTA,
		tasksMax: optionalInteger(env.BEEMAX_SERVICE_TASKS_MAX),
	}), { mode: 0o644 });
	await writeFile(layout.targetPath!, renderSystemdTarget(scope), { mode: 0o644 });
	const args = scope === "user" ? ["--user", "daemon-reload"] : ["daemon-reload"];
	assertCommand(runner("systemctl", args), `systemctl ${args.join(" ")}`);
}

export async function installMacLaunchAgent(
	profile: string,
	root = beemaxRoot(),
	home = beemaxHome(),
	launchAgentsDir = resolveServiceLayout({ platform: "darwin", scope: "user" }).unitDirectory,
): Promise<string> {
	validateProfileName(profile);
	const profileHome = join(resolve(home), "profiles", profile);
	const logsDir = join(profileHome, "logs");
	const plist = join(launchAgentsDir, `${macLabel(profile)}.plist`);
	await mkdir(logsDir, { recursive: true, mode: 0o700 });
	await mkdir(launchAgentsDir, { recursive: true });
	await writeFile(plist, renderMacLaunchAgent(profile, root, home), { encoding: "utf8", mode: 0o644 });
	return plist;
}

export function renderMacLaunchAgent(profile: string, root = beemaxRoot(), home = beemaxHome(), nodePath = process.execPath): string {
	validateProfileName(profile);
	const profileHome = join(resolve(home), "profiles", profile);
	const logsDir = join(profileHome, "logs");
	const cliPath = join(resolve(root), "apps", "cli", "dist", "cli.js");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(macLabel(profile))}</string>
  <key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(cliPath)}</string><string>gateway</string><string>--profile</string><string>${xml(profile)}</string><string>--home</string><string>${xml(resolve(home))}</string><string>--root</string><string>${xml(resolve(root))}</string></array>
  <key>WorkingDirectory</key><string>${xml(resolve(root))}</string>
  <key>EnvironmentVariables</key><dict><key>NODE_ENV</key><string>production</string><key>BEEMAX_PROFILE</key><string>${xml(profile)}</string></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(join(logsDir, "gateway.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logsDir, "gateway.error.log"))}</string>
</dict></plist>\n`;
}

export async function runServiceAction(
	action: ServiceAction,
	profile: string,
	runner: Runner = runInherited,
	platform = process.platform,
	scope: ServiceScope = "user",
	retryDelay: RetryDelay = delay,
): Promise<void> {
	validateProfileName(profile);
	if (platform === "darwin") return runMacServiceAction(action, profile, runner, retryDelay);
	if (platform !== "linux") {
		throw new Error(`beemax ${action} requires Linux systemd; use 'beemax gateway --profile ${profile}' for foreground testing`);
	}
	for (const plan of resolveServiceCommands(action, profile, { platform, scope })) {
		const result = runner(plan.command, plan.args);
		if (!plan.allowFailure) assertCommand(result, `${plan.command} ${plan.args.join(" ")}`);
		else if (result.error) throw result.error;
	}
}

async function runMacServiceAction(action: ServiceAction, profile: string, runner: Runner, retryDelay: RetryDelay): Promise<void> {
	if (action === "logs") {
		process.stdout.write(`${readGatewayLogs(join(beemaxHome(), "profiles", profile))}\n`);
		return;
	}
	for (const plan of resolveServiceCommands(action, profile, { platform: "darwin" })) {
		if (action === "restart" && plan.command === "launchctl" && plan.args[0] === "bootstrap") {
			await runLaunchctlBootstrapWithRetry(plan.args, runner, retryDelay);
			continue;
		}
		const result = runner(plan.command, plan.args);
		if (!plan.allowFailure) assertCommand(result, `${plan.command} ${plan.args.join(" ")}`);
		else if (result.error) throw result.error;
	}
}

async function runLaunchctlBootstrapWithRetry(args: string[], runner: Runner, retryDelay: RetryDelay): Promise<void> {
	const label = `launchctl ${args.join(" ")}`;
	let result: ReturnType<Runner> | undefined;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		result = runner("launchctl", args);
		if (result.error) throw result.error;
		if (result.status === 0) return;
		if (result.status !== 5 || attempt === 4) break;
		await retryDelay(100 * (2 ** attempt));
	}
	assertCommand(result!, label);
}

function macLabel(profile: string): string { return serviceDisplayName(profile, "darwin"); }
function xml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }

function renderSystemdTarget(scope: ServiceScope): string {
	return `[Unit]
Description=BeeMax Agent profiles
Wants=network-online.target
After=network-online.target

[Install]
WantedBy=${scope === "user" ? "default.target" : "multi-user.target"}
`;
}

function systemdQuote(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function normalizeServiceResourceLimits(input: ServiceResourceLimits): Required<ServiceResourceLimits> {
	const memoryMax = input.memoryMax?.trim() || "2G";
	const cpuQuota = input.cpuQuota?.trim() || "200%";
	const tasksMax = input.tasksMax ?? 512;
	if (!/^[1-9][0-9]*(?:\.[0-9]+)?[KMGTPE]?$/.test(memoryMax)) throw new Error("Invalid systemd Profile memory limit");
	if (!/^[1-9][0-9]*(?:\.[0-9]+)?%$/.test(cpuQuota) || Number.parseFloat(cpuQuota) > 10_000) throw new Error("Invalid systemd Profile CPU quota");
	if (!Number.isSafeInteger(tasksMax) || tasksMax < 32 || tasksMax > 1_000_000) throw new Error("Invalid systemd Profile task limit");
	return { memoryMax, cpuQuota, tasksMax };
}

function optionalInteger(value: string | undefined): number | undefined {
	if (value === undefined || !value.trim()) return undefined;
	return Number(value);
}

function runInherited(command: string, args: string[]): Pick<SpawnSyncReturns<Buffer>, "status" | "error"> {
	return spawnSync(command, args, { stdio: "inherit" });
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function assertCommand(result: Pick<SpawnSyncReturns<Buffer>, "status" | "error">, label: string): void {
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
}
