import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = join(process.cwd(), "apps", "cli", "dist", "cli.js");

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function writeReleaseProvenance(installDir, dataHome) {
	await mkdir(installDir, { recursive: true });
	await mkdir(dataHome, { recursive: true });
	await writeFile(
		join(installDir, ".beemax-release-install"),
		`BeeMax verified release install\ninstall-root=${installDir}\nversion=v-test\n`,
	);
	await writeFile(
		join(dataHome, ".beemax-home"),
		`BeeMax Profile Home\ninstall-root=${installDir}\n`,
	);
}

test("beemax uninstall delegates to the release installer and preserves Profile data by default", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "beemax-cli-uninstall-"));
	try {
		const home = join(fixture, "home");
		const installDir = join(home, ".beemax", "app");
		const installer = join(installDir, "scripts", "bootstrap-install.sh");
		const capture = join(fixture, "args.txt");
		const profileMemory = join(home, ".beemax", "profiles", "personal", "memory.sqlite");
		await mkdir(join(installDir, "scripts"), { recursive: true });
		await mkdir(join(home, ".beemax", "profiles", "personal"), { recursive: true });
		await writeReleaseProvenance(installDir, join(home, ".beemax"));
		await writeFile(profileMemory, "keep-me");
		await writeFile(installer, `#!/usr/bin/env bash
printf '%s\n' "$*" > "$BEEMAX_UNINSTALL_CAPTURE"
`);
		await chmod(installer, 0o755);

		const result = spawnSync(process.execPath, [
			cli,
			"uninstall",
			"--yes",
			"--home",
			join(home, ".beemax"),
			"--root",
			installDir,
		], {
			encoding: "utf8",
			env: {
				...process.env,
				BEEMAX_HOME: join(home, ".beemax"),
				BEEMAX_INSTALL_DIR: installDir,
				BEEMAX_UNINSTALL_CAPTURE: capture,
			},
		});

		assert.equal(result.status, 0, result.stderr);
		assert.equal((await readFile(capture, "utf8")).trim(), "--uninstall --yes");
		assert.equal(await readFile(profileMemory, "utf8"), "keep-me");
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
});

test("beemax uninstall --purge requires confirmation and forwards the explicit destructive request", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "beemax-cli-purge-"));
	try {
		const dataHome = join(fixture, "home", ".beemax");
		const installDir = join(dataHome, "app");
		const installer = join(installDir, "scripts", "bootstrap-install.sh");
		const capture = join(fixture, "args.txt");
		await mkdir(join(installDir, "scripts"), { recursive: true });
		await writeReleaseProvenance(installDir, dataHome);
		await writeFile(installer, `#!/usr/bin/env bash
printf '%s\n' "$*" > "$BEEMAX_UNINSTALL_CAPTURE"
`);
		await chmod(installer, 0o755);
		const commonArgs = ["--home", dataHome, "--root", installDir];
		const env = {
			...process.env,
			BEEMAX_HOME: dataHome,
			BEEMAX_INSTALL_DIR: installDir,
			BEEMAX_UNINSTALL_CAPTURE: capture,
		};

		const denied = spawnSync(process.execPath, [cli, "uninstall", "--purge", ...commonArgs], {
			encoding: "utf8",
			env,
		});
		assert.notEqual(denied.status, 0);
		assert.match(denied.stderr, /requires --yes/);
		assert.equal(await exists(capture), false);

		const confirmed = spawnSync(process.execPath, [cli, "uninstall", "--purge", "--yes", ...commonArgs], {
			encoding: "utf8",
			env,
		});
		assert.equal(confirmed.status, 0, confirmed.stderr);
		assert.equal((await readFile(capture, "utf8")).trim(), "--uninstall --purge --yes");
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
});

test("bootstrap uninstall removes the matching command and macOS service but keeps Profile data", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "beemax-bootstrap-uninstall-"));
	try {
		const home = join(fixture, "home");
		const dataHome = join(home, ".beemax");
		const installDir = join(dataHome, "app");
		const binDir = join(home, ".local", "bin");
		const command = join(binDir, "beemax");
		const profileMemory = join(dataHome, "profiles", "personal", "memory.sqlite");
		const launchAgents = join(home, "Library", "LaunchAgents");
		const service = join(launchAgents, "com.beemax.agent.personal.plist");
		const launchctl = join(fixture, "launchctl");
		await mkdir(installDir, { recursive: true });
		await mkdir(binDir, { recursive: true });
		await mkdir(join(dataHome, "profiles", "personal"), { recursive: true });
		await mkdir(launchAgents, { recursive: true });
		await writeFile(join(installDir, "package.json"), '{\n  "name": "beemax-agent"\n}\n');
		await writeReleaseProvenance(installDir, dataHome);
		await writeFile(command, `#!/usr/bin/env bash\nexport BEEMAX_ROOT=${installDir}\n`);
		await writeFile(profileMemory, "keep-me");
		await writeFile(service, `<string>${installDir}/apps/cli/dist/cli.js</string>`);
		await writeFile(launchctl, `#!/usr/bin/env bash
if [[ "$1" == "print" ]]; then exit 1; fi
exit 0
`);
		await chmod(launchctl, 0o755);

		const result = spawnSync("bash", ["scripts/bootstrap-install.sh", "--uninstall"], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: {
				...process.env,
				HOME: home,
				BEEMAX_HOME: dataHome,
				BEEMAX_INSTALL_DIR: installDir,
				BEEMAX_BIN_DIR: binDir,
				BEEMAX_LAUNCH_AGENTS_DIR: launchAgents,
				BEEMAX_UNINSTALL_PLATFORM: "Darwin",
				BEEMAX_LAUNCHCTL: launchctl,
			},
		});

		assert.equal(result.status, 0, result.stderr);
		assert.equal(await exists(command), false);
		assert.equal(await exists(installDir), false);
		assert.equal(await exists(service), false);
		assert.equal(await readFile(profileMemory, "utf8"), "keep-me");
		assert.match(result.stdout, /Profiles and data.*were kept/);
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
});

test("macOS uninstall aborts before deletion when a loaded LaunchAgent cannot stop", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "beemax-mac-stop-failure-"));
	try {
		const home = join(fixture, "home");
		const dataHome = join(home, ".beemax");
		const installDir = join(dataHome, "app");
		const launchAgents = join(home, "Library", "LaunchAgents");
		const service = join(launchAgents, "com.beemax.agent.personal.plist");
		const launchctl = join(fixture, "launchctl");
		await mkdir(launchAgents, { recursive: true });
		await writeReleaseProvenance(installDir, dataHome);
		await writeFile(join(installDir, "package.json"), '{\n  "name": "beemax-agent"\n}\n');
		await writeFile(service, `<string>${installDir}/apps/cli/dist/cli.js</string>`);
		await writeFile(launchctl, `#!/usr/bin/env bash
if [[ "$1" == "print" ]]; then exit 0; fi
if [[ "$1" == "bootout" ]]; then exit 1; fi
`);
		await chmod(launchctl, 0o755);

		const result = spawnSync("bash", ["scripts/bootstrap-install.sh", "--uninstall"], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: {
				...process.env,
				HOME: home,
				BEEMAX_HOME: dataHome,
				BEEMAX_INSTALL_DIR: installDir,
				BEEMAX_LAUNCH_AGENTS_DIR: launchAgents,
				BEEMAX_UNINSTALL_PLATFORM: "Darwin",
				BEEMAX_LAUNCHCTL: launchctl,
			},
		});

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /could not stop LaunchAgent/);
		assert.equal(await exists(service), true);
		assert.equal(await exists(installDir), true);
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
});

test("bootstrap purge requires confirmation before changing anything, then removes all BeeMax data", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "beemax-bootstrap-purge-"));
	try {
		const home = join(fixture, "home");
		const dataHome = join(home, ".beemax");
		const installDir = join(dataHome, "app");
		const binDir = join(home, ".local", "bin");
		const command = join(binDir, "beemax");
		const profileMemory = join(dataHome, "profiles", "personal", "memory.sqlite");
		await mkdir(installDir, { recursive: true });
		await mkdir(binDir, { recursive: true });
		await mkdir(join(dataHome, "profiles", "personal"), { recursive: true });
		await writeFile(join(installDir, "package.json"), '{\n  "name": "beemax-agent"\n}\n');
		await writeReleaseProvenance(installDir, dataHome);
		await writeFile(command, `#!/usr/bin/env bash\nexport BEEMAX_ROOT=${installDir}\n`);
		await writeFile(profileMemory, "remove-me");
		const env = {
			...process.env,
			HOME: home,
			BEEMAX_HOME: dataHome,
			BEEMAX_INSTALL_DIR: installDir,
			BEEMAX_BIN_DIR: binDir,
			BEEMAX_UNINSTALL_PLATFORM: "unsupported-test-platform",
		};

		const denied = spawnSync("bash", ["scripts/bootstrap-install.sh", "--uninstall", "--purge"], {
			cwd: process.cwd(),
			encoding: "utf8",
			env,
		});
		assert.notEqual(denied.status, 0);
		assert.match(denied.stderr, /requires --yes/);
		assert.equal(await exists(installDir), true);
		assert.equal(await readFile(profileMemory, "utf8"), "remove-me");

		const confirmed = spawnSync("bash", ["scripts/bootstrap-install.sh", "--uninstall", "--purge", "--yes"], {
			cwd: process.cwd(),
			encoding: "utf8",
			env,
		});
		assert.equal(confirmed.status, 0, confirmed.stderr);
		assert.equal(await exists(command), false);
		assert.equal(await exists(dataHome), false);
		assert.match(confirmed.stdout, /Profiles, and data were removed/);
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
});

test("bootstrap uninstall disables matching Linux Profile services and removes only BeeMax unit files", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "beemax-linux-uninstall-"));
	try {
		const home = join(fixture, "home");
		const dataHome = join(home, ".beemax");
		const installDir = join(dataHome, "app");
		const binDir = join(home, ".local", "bin");
		const systemdDir = join(home, ".config", "systemd", "user");
		const systemctl = join(fixture, "systemctl");
		const systemctlCalls = join(fixture, "systemctl.log");
		const unit = join(systemdDir, "beemax@.service");
		const target = join(systemdDir, "beemax.target");
		const unrelated = join(systemdDir, "unrelated.service");
		const profileMemory = join(dataHome, "profiles", "personal", "memory.sqlite");
		await mkdir(installDir, { recursive: true });
		await mkdir(binDir, { recursive: true });
		await mkdir(join(dataHome, "profiles", "personal"), { recursive: true });
		await mkdir(systemdDir, { recursive: true });
		await writeFile(join(installDir, "package.json"), '{\n  "name": "beemax-agent"\n}\n');
		await writeReleaseProvenance(installDir, dataHome);
		await writeFile(join(binDir, "beemax"), `#!/usr/bin/env bash\nexport BEEMAX_ROOT=${installDir}\n`);
		await writeFile(profileMemory, "keep-me");
		await writeFile(unit, `ExecStart=node ${installDir}/apps/cli/dist/cli.js gateway\n`);
		await writeFile(target, "Description=BeeMax Agent profiles\n");
		await writeFile(unrelated, "Description=unrelated\n");
		await writeFile(systemctl, `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$BEEMAX_SYSTEMCTL_CALLS"
if [[ "$*" == *"list-units"* ]]; then
  printf 'beemax@personal.service loaded active running BeeMax\n'
  printf 'beemax@stale.service loaded active running BeeMax\n'
elif [[ "$*" == *"list-unit-files"* ]]; then
  printf 'beemax@personal.service enabled\n'
  printf 'beemax@stale.service enabled\n'
fi
`);
		await chmod(systemctl, 0o755);

		const result = spawnSync("bash", ["scripts/bootstrap-install.sh", "--uninstall"], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: {
				...process.env,
				HOME: home,
				BEEMAX_HOME: dataHome,
				BEEMAX_INSTALL_DIR: installDir,
				BEEMAX_BIN_DIR: binDir,
				BEEMAX_SYSTEMD_USER_DIR: systemdDir,
				BEEMAX_UNINSTALL_PLATFORM: "Linux",
				BEEMAX_SYSTEMCTL: systemctl,
				BEEMAX_SYSTEMCTL_CALLS: systemctlCalls,
			},
		});

		assert.equal(result.status, 0, result.stderr);
		assert.equal(await exists(unit), false);
		assert.equal(await exists(target), false);
		assert.equal(await exists(unrelated), true);
		assert.equal(await readFile(profileMemory, "utf8"), "keep-me");
		const calls = await readFile(systemctlCalls, "utf8");
		assert.match(calls, /^--user disable --now beemax@personal\.service$/m);
		assert.match(calls, /^--user disable --now beemax@stale\.service$/m);
		assert.match(calls, /^--user daemon-reload$/m);
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
});

test("Linux uninstall leaves services owned by another BeeMax installation untouched", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "beemax-linux-foreign-service-"));
	try {
		const home = join(fixture, "home");
		const dataHome = join(home, ".beemax");
		const installDir = join(dataHome, "app");
		const systemdDir = join(home, ".config", "systemd", "user");
		const systemctl = join(fixture, "systemctl");
		const systemctlCalls = join(fixture, "systemctl.log");
		const unit = join(systemdDir, "beemax@.service");
		const target = join(systemdDir, "beemax.target");
		await mkdir(join(dataHome, "profiles", "personal"), { recursive: true });
		await mkdir(systemdDir, { recursive: true });
		await writeReleaseProvenance(installDir, dataHome);
		await writeFile(join(installDir, "package.json"), '{\n  "name": "beemax-agent"\n}\n');
		await writeFile(unit, "ExecStart=node /different/beemax/apps/cli/dist/cli.js gateway\n");
		await writeFile(target, "Description=BeeMax Agent profiles\n");
		await writeFile(systemctl, `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$BEEMAX_SYSTEMCTL_CALLS"
`);
		await chmod(systemctl, 0o755);

		const result = spawnSync("bash", ["scripts/bootstrap-install.sh", "--uninstall"], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: {
				...process.env,
				HOME: home,
				BEEMAX_HOME: dataHome,
				BEEMAX_INSTALL_DIR: installDir,
				BEEMAX_SYSTEMD_USER_DIR: systemdDir,
				BEEMAX_UNINSTALL_PLATFORM: "Linux",
				BEEMAX_SYSTEMCTL: systemctl,
				BEEMAX_SYSTEMCTL_CALLS: systemctlCalls,
			},
		});

		assert.equal(result.status, 0, result.stderr);
		assert.equal(await exists(unit), true);
		assert.equal(await exists(target), true);
		assert.equal(await exists(systemctlCalls), false);
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
});

test("Linux uninstall aborts before deletion when a discovered service cannot stop", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "beemax-linux-stop-failure-"));
	try {
		const home = join(fixture, "home");
		const dataHome = join(home, ".beemax");
		const installDir = join(dataHome, "app");
		const systemdDir = join(home, ".config", "systemd", "user");
		const unit = join(systemdDir, "beemax@.service");
		const systemctl = join(fixture, "systemctl");
		await mkdir(systemdDir, { recursive: true });
		await writeReleaseProvenance(installDir, dataHome);
		await writeFile(join(installDir, "package.json"), '{\n  "name": "beemax-agent"\n}\n');
		await writeFile(unit, `ExecStart=node ${installDir}/apps/cli/dist/cli.js gateway\n`);
		await writeFile(systemctl, `#!/usr/bin/env bash
if [[ "$*" == *"list-units"* || "$*" == *"list-unit-files"* ]]; then
  printf 'beemax@personal.service enabled\n'
  exit 0
fi
if [[ "$*" == *"disable --now"* ]]; then exit 1; fi
exit 0
`);
		await chmod(systemctl, 0o755);

		const result = spawnSync("bash", ["scripts/bootstrap-install.sh", "--uninstall"], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: {
				...process.env,
				HOME: home,
				BEEMAX_HOME: dataHome,
				BEEMAX_INSTALL_DIR: installDir,
				BEEMAX_SYSTEMD_USER_DIR: systemdDir,
				BEEMAX_UNINSTALL_PLATFORM: "Linux",
				BEEMAX_SYSTEMCTL: systemctl,
			},
		});

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /could not stop systemd service/);
		assert.equal(await exists(unit), true);
		assert.equal(await exists(installDir), true);
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
});

test("system-service uninstall fails before removing application files when root authority is absent", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "beemax-system-uninstall-"));
	try {
		const home = join(fixture, "home");
		const dataHome = join(home, ".beemax");
		const installDir = join(dataHome, "app");
		await mkdir(installDir, { recursive: true });
		await writeFile(join(installDir, "package.json"), '{\n  "name": "beemax-agent"\n}\n');
		await writeReleaseProvenance(installDir, dataHome);

		const result = spawnSync("bash", ["scripts/bootstrap-install.sh", "--uninstall", "--system"], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: {
				...process.env,
				HOME: home,
				BEEMAX_HOME: dataHome,
				BEEMAX_INSTALL_DIR: installDir,
				BEEMAX_UNINSTALL_PLATFORM: "Linux",
			},
		});

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /system service uninstall requires root/);
		assert.equal(await exists(installDir), true);
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
});

test("bootstrap uninstall refuses a source-like directory without release provenance", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "beemax-source-uninstall-"));
	try {
		const sourceRoot = join(fixture, "source");
		const userFile = join(sourceRoot, "uncommitted-user-work.txt");
		await mkdir(sourceRoot, { recursive: true });
		await writeFile(join(sourceRoot, "package.json"), '{\n  "name": "beemax-agent"\n}\n');
		await writeFile(userFile, "do-not-delete");

		const result = spawnSync("bash", ["scripts/bootstrap-install.sh", "--uninstall", "--dir", sourceRoot], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: {
				...process.env,
				HOME: join(fixture, "home"),
				BEEMAX_INSTALL_DIR: sourceRoot,
				BEEMAX_UNINSTALL_PLATFORM: "unsupported-test-platform",
			},
		});

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /without BeeMax release provenance/);
		assert.equal(await readFile(userFile, "utf8"), "do-not-delete");
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
});

test("bootstrap rejects a relative install directory before uninstall", () => {
	const result = spawnSync("bash", ["scripts/bootstrap-install.sh", "--uninstall", "--dir", "relative/beemax"], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: {
			...process.env,
			BEEMAX_UNINSTALL_PLATFORM: "unsupported-test-platform",
		},
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /install directory must be absolute/);
});

test("purge validates Profile Home provenance before removing services, command, or application", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "beemax-purge-preflight-"));
	try {
		const home = join(fixture, "home");
		const dataHome = join(home, ".beemax");
		const installDir = join(dataHome, "app");
		const binDir = join(home, ".local", "bin");
		const command = join(binDir, "beemax");
		await mkdir(binDir, { recursive: true });
		await writeReleaseProvenance(installDir, dataHome);
		await writeFile(join(installDir, "package.json"), '{\n  "name": "beemax-agent"\n}\n');
		await writeFile(join(dataHome, ".beemax-home"), "BeeMax Profile Home\ninstall-root=/different/install\n");
		await writeFile(command, "#!/usr/bin/env bash\n# BeeMax command\n");

		const result = spawnSync("bash", ["scripts/bootstrap-install.sh", "--uninstall", "--purge", "--yes"], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: {
				...process.env,
				HOME: home,
				BEEMAX_HOME: dataHome,
				BEEMAX_INSTALL_DIR: installDir,
				BEEMAX_BIN_DIR: binDir,
				BEEMAX_UNINSTALL_PLATFORM: "unsupported-test-platform",
			},
		});

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /does not match the requested install directory/);
		assert.equal(await exists(command), true);
		assert.equal(await exists(installDir), true);
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
});

test("purge rejects a symlinked Profile Home instead of reporting a false deletion", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "beemax-symlink-purge-"));
	try {
		const home = join(fixture, "home");
		const realDataHome = join(fixture, "real-beemax-home");
		const dataHome = join(home, ".beemax");
		const installDir = join(dataHome, "app");
		await mkdir(home, { recursive: true });
		await mkdir(join(realDataHome, "app"), { recursive: true });
		await symlink(realDataHome, dataHome, "dir");
		await writeReleaseProvenance(installDir, dataHome);
		await writeFile(join(installDir, "package.json"), '{\n  "name": "beemax-agent"\n}\n');

		const result = spawnSync("bash", ["scripts/bootstrap-install.sh", "--uninstall", "--purge", "--yes"], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: {
				...process.env,
				HOME: home,
				BEEMAX_HOME: dataHome,
				BEEMAX_INSTALL_DIR: installDir,
				BEEMAX_UNINSTALL_PLATFORM: "unsupported-test-platform",
			},
		});

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /symlinked BEEMAX_HOME/);
		assert.equal(await exists(join(realDataHome, "app")), true);
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
});

test("default uninstall refuses to remove an application that contains its Profile Home", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "beemax-nested-profile-home-"));
	try {
		const installDir = join(fixture, "beemax-app");
		const dataHome = join(installDir, "profile-data");
		const profileMemory = join(dataHome, "profiles", "personal", "memory.sqlite");
		await mkdir(join(dataHome, "profiles", "personal"), { recursive: true });
		await writeReleaseProvenance(installDir, dataHome);
		await writeFile(join(installDir, "package.json"), '{\n  "name": "beemax-agent"\n}\n');
		await writeFile(profileMemory, "must-survive");

		const result = spawnSync("bash", ["scripts/bootstrap-install.sh", "--uninstall"], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: {
				...process.env,
				HOME: join(fixture, "home"),
				BEEMAX_HOME: dataHome,
				BEEMAX_INSTALL_DIR: installDir,
				BEEMAX_UNINSTALL_PLATFORM: "unsupported-test-platform",
			},
		});

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /BEEMAX_HOME is inside the application directory/);
		assert.equal(await readFile(profileMemory, "utf8"), "must-survive");
		assert.equal(await exists(installDir), true);
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
});
