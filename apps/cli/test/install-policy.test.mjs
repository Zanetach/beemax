import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("default build is offline-stable and model catalog refresh is explicit", async () => {
	const pkg = JSON.parse(await readFile("package.json", "utf8"));
	assert.doesNotMatch(pkg.scripts.build, /generate-models|generate-image-models/);
	assert.match(pkg.scripts["models:update"], /generate-models/);
	assert.match(pkg.scripts["models:update"], /generate-image-models/);
});

test("source installer keeps native dependency scripts and pins CLI commands to the install root", async () => {
	const installer = await readFile("scripts/install.sh", "utf8");
	assert.match(installer, /npm ci\n/);
	assert.doesNotMatch(installer, /npm ci --ignore-scripts/);
	assert.match(installer, /install-media-dependencies\.sh/);
	assert.match(installer, /export BEEMAX_ROOT/);
	assert.match(installer, /apps\/cli\/dist\/cli\.js/);
});

test("media dependency installer auto-installs Tesseract on Ubuntu and macOS", async () => {
	const installer = await readFile("scripts/install-media-dependencies.sh", "utf8");
	assert.match(installer, /BEEMAX_INSTALL_MEDIA_DEPS/);
	assert.match(installer, /BEEMAX_TESSERACT:-tesseract/);
	assert.match(installer, /command -v "\$\{TESSERACT_BIN\}"/);
	assert.match(installer, /tesseract-ocr/);
	assert.match(installer, /tesseract-ocr-eng/);
	assert.match(installer, /tesseract-ocr-chi-sim/);
	assert.match(installer, /apt-get/);
	assert.match(installer, /sudo/);
	assert.match(installer, /tesseract-lang/);
	assert.match(installer, /brew/);
});

test("media dependency installer executes the Ubuntu package plan and verifies Tesseract", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "beemax-media-install-"));
	try {
		const aptGet = join(fixture, "apt-get");
		const tesseract = join(fixture, "tesseract");
		const calls = join(fixture, "calls.log");
		await writeFile(aptGet, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$BEEMAX_TEST_CALLS"
if [[ "$1" == "install" ]]; then
  printf '#!/usr/bin/env bash\\nprintf "tesseract 5.5.0\\n"\\n' > "$BEEMAX_TEST_TESSERACT"
  chmod 0755 "$BEEMAX_TEST_TESSERACT"
fi
`);
		await chmod(aptGet, 0o755);
		const result = spawnSync("bash", ["scripts/install-media-dependencies.sh"], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: {
				...process.env,
				BEEMAX_APT_GET: aptGet,
				BEEMAX_INSTALL_EUID: "0",
				BEEMAX_INSTALL_OS: "ubuntu",
				BEEMAX_TESSERACT: tesseract,
				BEEMAX_TEST_TESSERACT: tesseract,
				BEEMAX_TEST_CALLS: calls,
				PATH: `${fixture}:${process.env.PATH}`,
			},
		});
		assert.equal(result.status, 0, result.stderr);
		const packageCalls = await readFile(calls, "utf8");
		assert.match(packageCalls, /^update$/m);
		assert.match(packageCalls, /install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim/);
		assert.match(result.stdout, /media dependency installed: tesseract 5\.5\.0/);
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
});

test("bootstrap installer downloads a verified single release archive and preserves Profile data on uninstall", async () => {
	const installer = await readFile("scripts/bootstrap-install.sh", "utf8");
	assert.match(installer, /BEEMAX_VERSION:-latest/);
	assert.match(installer, /BEEMAX_RELEASE_API/);
	assert.match(installer, /curl[^\n]+\$\{RELEASE_API\}/);
	assert.match(installer, /releases\/download/);
	assert.match(installer, /checksum verification failed/);
	assert.doesNotMatch(installer, /git clone/);
	assert.match(installer, /Node\.js 22\.19\+/);
	assert.match(installer, /command -v shasum[\s\S]*command -v sha256sum/);
	assert.match(installer, /Profiles and data under/);
	assert.match(installer, /BEEMAX_BIN_DIR/);
});

test("source installer requires the vendored Pi source without submodule initialization", async () => {
	const installer = await readFile("scripts/install.sh", "utf8");
	assert.match(installer, /vendored Pi source is missing/);
	assert.doesNotMatch(installer, /git submodule|command -v git/);
});

test("release archive includes Pi and excludes git metadata and dependencies", async () => {
	const packager = await readFile("scripts/create-release-archive.sh", "utf8");
	assert.match(packager, /Vendored Pi source is missing/);
	assert.match(packager, /--exclude='\.\/pi\/.git'/);
	assert.match(packager, /--exclude='node_modules'/);
	assert.match(packager, /--exclude='\*\/node_modules'/);
	assert.match(packager, /--exclude='dist'/);
	assert.match(packager, /--exclude='\*\/dist'/);
	assert.match(packager, /--exclude='\*\.tsbuildinfo'/);
	assert.match(packager, /--exclude='\.\/docs'/);
	assert.match(packager, /--exclude='\.\/evals'/);
	assert.match(packager, /--exclude='\.\/\.github'/);
	assert.match(packager, /--exclude='\*\/test'/);
	assert.match(packager, /--exclude='\.\/scripts'/);
	assert.match(packager, /clean-build-output\.mjs/);
	assert.match(packager, /install-media-dependencies\.sh/);
	assert.doesNotMatch(packager, /capability-outcome-harness/);
	assert.match(packager, /--exclude='\.\/data'/);
	assert.match(packager, /RELEASE_VERSION/);
	assert.match(packager, /verify-release-version\.mjs/);
	assert.match(packager, /command -v sha256sum/);
	assert.match(packager, /command -v shasum/);
	assert.match(packager, /cd "\$\{OUTPUT_DIR\}"/);
});

test("tag releases pass build, test, and isolated archive installation gates before publishing", async () => {
	const workflow = await readFile(".github/workflows/release.yml", "utf8");
	const ci = await readFile(".github/workflows/ci.yml", "utf8");
	const pkg = JSON.parse(await readFile("package.json", "utf8"));
	const verifier = await readFile("scripts/verify-release-archive.sh", "utf8");
	assert.match(workflow, /actions\/setup-node@v4/);
	assert.match(workflow, /node-version: 22\.19\.0/);
	for (const command of ["npm ci", "npm audit --omit=dev --audit-level=high", "npm run verify:release", "create-release-archive\.sh", "verify-release-archive\.sh"]) assert.match(workflow, new RegExp(command));
	assert.match(ci, /npm run verify:release/);
	for (const command of ["npm run build", "npm run typecheck", "npm run eval:runtime", "npm run eval:performance:release", "npm run eval:memory", "npm run eval:reliability", "npm run eval:acceptance", "npm test"]) assert.match(pkg.scripts["verify:release"], new RegExp(command));
	assert.ok(workflow.indexOf("verify-release-archive.sh") < workflow.indexOf("gh release create"));
	assert.match(verifier, /sha256/);
	assert.match(verifier, /portable archive filename/);
	assert.match(verifier, /RELEASE_VERSION/);
	assert.match(verifier, /verify-release-version\.mjs/);
	assert.match(verifier, /verify-release-agent-boundary\.mjs/);
	assert.match(verifier, /--whole-tree/);
	assert.doesNotMatch(verifier, /await import\s*\(/);
	assert.match(verifier, /node_modules/);
	assert.match(verifier, /BEEMAX_BIN_DIR/);
	assert.match(verifier, /BEEMAX_INSTALL_MEDIA_DEPS=0/);
	assert.match(verifier, /scripts\/install\.sh/);
	assert.match(verifier, /run_beemax --help/);
	assert.match(verifier, /env -i/);
	assert.match(verifier, /SMOKE_HOME="\$\{STAGING\}\/home\/\.beemax"/);
	assert.match(verifier, /BEEMAX_HOME="\$\{SMOKE_HOME\}"/);
	assert.match(verifier, /run_beemax profile create release-smoke/);
	assert.match(verifier, /run_beemax profile show release-smoke/);
	assert.match(verifier, /run_beemax skills list --profile release-smoke/);
	assert.doesNotMatch(workflow, /uses:\s+actions\/checkout@v4\s*\n\s+with:\s*$/m);
	assert.doesNotMatch(ci, /uses:\s+actions\/checkout@v4\s*\n\s+with:\s*$/m);
	assert.match(workflow, /--latest/);
	assert.match(workflow, /GITHUB_REF_NAME.*==.*\*-\*/);
	assert.match(workflow, /--prerelease/);
});
