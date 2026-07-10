import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { validateProfileName } from "./config.ts";

export type ServiceAction = "start" | "stop" | "restart" | "status" | "logs";
export type ServiceScope = "user" | "system";
type Runner = (command: string, args: string[]) => Pick<SpawnSyncReturns<Buffer>, "status" | "error">;

export function renderSystemdService(root = process.cwd(), nodePath = process.execPath): string {
	const absoluteRoot = resolve(root);
	const cliPath = join(absoluteRoot, "apps", "cli", "dist", "cli.js");
	return `[Unit]
Description=BeeMax Agent profile %i
After=network-online.target
Wants=network-online.target
PartOf=beemax.target

[Service]
Type=simple
WorkingDirectory=${systemdQuote(absoluteRoot)}
Environment=NODE_ENV=production
Environment=BEEMAX_PROFILE=%i
EnvironmentFile=-${systemdQuote(join(absoluteRoot, "config", "profiles", "%i.env"))}
EnvironmentFile=-/etc/beemax/%i.env
ExecStart=${systemdQuote(nodePath)} ${systemdQuote(cliPath)} gateway --profile %i
Restart=on-failure
RestartSec=5s
TimeoutStopSec=60s
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
UMask=0077
StandardOutput=journal
StandardError=journal
SyslogIdentifier=beemax-%i

[Install]
WantedBy=multi-user.target
`;
}

export async function installSystemdService(
	root = process.cwd(),
	scope: ServiceScope = "user",
	systemdDir = scope === "user" ? join(homedir(), ".config", "systemd", "user") : "/etc/systemd/system",
	runner: Runner = runInherited,
): Promise<void> {
	if (process.platform !== "linux") throw new Error("systemd installation is supported only on Linux");
	if (scope === "system" && typeof process.getuid === "function" && process.getuid() !== 0) {
		throw new Error("systemd installation requires root; rerun with sudo");
	}
	await mkdir(systemdDir, { recursive: true });
	if (scope === "system") await mkdir("/etc/beemax", { recursive: true, mode: 0o700 });
	await writeFile(join(systemdDir, "beemax@.service"), renderSystemdService(root), { mode: 0o644 });
	await writeFile(join(systemdDir, "beemax.target"), renderSystemdTarget(), { mode: 0o644 });
	const args = scope === "user" ? ["--user", "daemon-reload"] : ["daemon-reload"];
	assertCommand(runner("systemctl", args), `systemctl ${args.join(" ")}`);
}

export function runServiceAction(
	action: ServiceAction,
	profile: string,
	runner: Runner = runInherited,
	platform = process.platform,
	scope: ServiceScope = "user",
): void {
	validateProfileName(profile);
	if (platform !== "linux") {
		throw new Error(`beemax ${action} requires Linux systemd; use 'beemax gateway --profile ${profile}' for foreground testing`);
	}
	const unit = `beemax@${profile}.service`;
	const command = action === "logs" ? "journalctl" : "systemctl";
	const scopeArgs = scope === "user" ? ["--user"] : [];
	const args = action === "logs" ? [...scopeArgs, "-u", unit, "-f"] : [...scopeArgs, action, unit];
	assertCommand(runner(command, args), `${command} ${args.join(" ")}`);
}

function renderSystemdTarget(): string {
	return `[Unit]
Description=BeeMax Agent profiles
Wants=network-online.target
After=network-online.target

[Install]
WantedBy=multi-user.target
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
