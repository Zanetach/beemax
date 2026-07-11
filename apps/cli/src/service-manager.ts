import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { beemaxHome, beemaxRoot, validateProfileName } from "./config.ts";
import { readGatewayLogs } from "./gateway-observability.ts";

export type ServiceAction = "start" | "stop" | "restart" | "status" | "logs";
export type ServiceScope = "user" | "system";
type Runner = (command: string, args: string[]) => Pick<SpawnSyncReturns<Buffer>, "status" | "error">;

export function renderSystemdService(
	root = beemaxRoot(),
	nodePath = process.execPath,
	scope: ServiceScope = "user",
	serviceUser?: string,
	home = beemaxHome(),
): string {
	const absoluteRoot = resolve(root);
	const absoluteHome = resolve(home);
	const cliPath = join(absoluteRoot, "apps", "cli", "dist", "cli.js");
	return `[Unit]
Description=BeeMax Agent profile %i
After=network-online.target
Wants=network-online.target
PartOf=beemax.target

[Service]
Type=simple
${scope === "system" ? `User=${serviceUser ?? "beemax"}\n` : ""}WorkingDirectory=${systemdQuote(absoluteRoot)}
EnvironmentFile=-${systemdQuote(join(absoluteHome, "profiles", "%i", ".env"))}
EnvironmentFile=-${systemdQuote(join(absoluteRoot, "config", "profiles", "%i.env"))}
EnvironmentFile=-/etc/beemax/%i.env
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
	systemdDir = scope === "user" ? join(homedir(), ".config", "systemd", "user") : "/etc/systemd/system",
	runner: Runner = runInherited,
): Promise<void> {
	if (process.platform !== "linux") throw new Error("systemd installation is supported only on Linux");
	if (scope === "system" && typeof process.getuid === "function" && process.getuid() !== 0) {
		throw new Error("systemd installation requires root; rerun with sudo");
	}
	const serviceUser = scope === "system"
		? process.env.BEEMAX_SERVICE_USER || process.env.SUDO_USER || (process.env.USER !== "root" ? process.env.USER : undefined)
		: undefined;
	if (scope === "system" && !serviceUser) {
		throw new Error("systemd system service needs a non-root account; set BEEMAX_SERVICE_USER");
	}
	const serviceHome = scope === "system" ? process.env.BEEMAX_HOME?.trim() : beemaxHome();
	if (!serviceHome) {
		throw new Error("systemd system service needs an explicit BEEMAX_HOME owned by BEEMAX_SERVICE_USER");
	}
	await mkdir(systemdDir, { recursive: true });
	if (scope === "system") await mkdir("/etc/beemax", { recursive: true, mode: 0o700 });
	await writeFile(join(systemdDir, "beemax@.service"), renderSystemdService(root, process.execPath, scope, serviceUser, serviceHome), { mode: 0o644 });
	await writeFile(join(systemdDir, "beemax.target"), renderSystemdTarget(scope), { mode: 0o644 });
	const args = scope === "user" ? ["--user", "daemon-reload"] : ["daemon-reload"];
	assertCommand(runner("systemctl", args), `systemctl ${args.join(" ")}`);
}

export async function installMacLaunchAgent(
	profile: string,
	root = beemaxRoot(),
	home = beemaxHome(),
	launchAgentsDir = join(homedir(), "Library", "LaunchAgents"),
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
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(join(logsDir, "gateway.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logsDir, "gateway.error.log"))}</string>
</dict></plist>\n`;
}

export function runServiceAction(
	action: ServiceAction,
	profile: string,
	runner: Runner = runInherited,
	platform = process.platform,
	scope: ServiceScope = "user",
): void {
	validateProfileName(profile);
	if (platform === "darwin") return runMacServiceAction(action, profile, runner);
	if (platform !== "linux") {
		throw new Error(`beemax ${action} requires Linux systemd; use 'beemax gateway --profile ${profile}' for foreground testing`);
	}
	const unit = `beemax@${profile}.service`;
	const command = action === "logs" ? "journalctl" : "systemctl";
	const scopeArgs = scope === "user" ? ["--user"] : [];
	const serviceArgs = action === "start"
		? ["enable", "--now", unit]
		: action === "stop" ? ["disable", "--now", unit] : [action, unit];
	const args = action === "logs" ? [...scopeArgs, "-u", unit, "-f"] : [...scopeArgs, ...serviceArgs];
	assertCommand(runner(command, args), `${command} ${args.join(" ")}`);
}

function runMacServiceAction(action: ServiceAction, profile: string, runner: Runner): void {
	const domain = `gui/${process.getuid?.() ?? 0}`;
	const label = macLabel(profile);
	const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
	if (action === "logs") {
		process.stdout.write(`${readGatewayLogs(join(beemaxHome(), "profiles", profile))}\n`);
		return;
	}
	if (action === "start") {
		assertCommand(runner("launchctl", ["bootstrap", domain, plist]), `launchctl bootstrap ${domain} ${plist}`);
		return;
	}
	if (action === "stop") {
		assertCommand(runner("launchctl", ["bootout", `${domain}/${label}`]), `launchctl bootout ${domain}/${label}`);
		return;
	}
	if (action === "restart") {
		const stopped = runner("launchctl", ["bootout", `${domain}/${label}`]);
		if (stopped.error) throw stopped.error;
		assertCommand(runner("launchctl", ["bootstrap", domain, plist]), `launchctl bootstrap ${domain} ${plist}`);
		return;
	}
	assertCommand(runner("launchctl", ["print", `${domain}/${label}`]), `launchctl print ${domain}/${label}`);
}

function macLabel(profile: string): string { return `com.beemax.agent.${profile}`; }
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

function runInherited(command: string, args: string[]): Pick<SpawnSyncReturns<Buffer>, "status" | "error"> {
	return spawnSync(command, args, { stdio: "inherit" });
}

function assertCommand(result: Pick<SpawnSyncReturns<Buffer>, "status" | "error">, label: string): void {
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
}
