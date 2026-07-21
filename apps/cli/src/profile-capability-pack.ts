import { lstat, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	EXA_MCPORTER_PROVIDER_VERSION,
	inspectProfileExaMcporter,
	installProfileExaMcporter,
	type CapabilityProviderCommandRunner,
	type ProfileCapabilityProviderInstallationPolicy,
} from "./capability-provider-composition.ts";
import { inspectProfileBrowser, type ProfileBrowserStatus } from "./profile-browser.ts";
import { inspectProfileSkillTree } from "./profile-skill-integrity.ts";

export const STANDARD_WEB_PACK_VERSION = "1";
export const PI_WEB_ACCESS_VERSION = "beemax-native-cdp.v1";

export interface StandardWebProfile {
	profile: string;
	profileHome: string;
	agentDir: string;
	installation: ProfileCapabilityProviderInstallationPolicy;
	integrityKey: Uint8Array;
}

export type StandardWebComponentState = "installed" | "ready_on_demand" | "disabled" | "missing" | "customized" | "invalid";
export type StandardWebSkillId = "agent-reach" | "pi-web-access";

export interface StandardWebPackStatus {
	pack: "standard-web";
	version: string;
	profile: string;
	components: Array<{
		id: "exa-web-search" | "agent-reach" | "pi-web-access";
		kind: "builtin+mcp" | "skill" | "builtin-browser+skill";
		state: StandardWebComponentState;
		detail: string;
		evidenceRef?: string;
		runtime?: ProfileBrowserStatus;
	}>;
}

export interface PiWebAccessInstallResult {
	installed: false;
	path: "@beemax/core/browser-tools";
	evidenceRef: string;
	revision: typeof PI_WEB_ACCESS_VERSION;
}

/** Fail closed when a capability operation is pointed at another Profile or a shared/symlinked Agent directory. */
export async function assertStandardWebProfileBoundary(input: Pick<StandardWebProfile, "profileHome" | "agentDir">): Promise<void> {
	const profileHome = resolve(input.profileHome);
	const agentDir = resolve(input.agentDir);
	const [initialHome, initialAgent] = await Promise.all([lstat(profileHome), lstat(agentDir)]);
	if (initialHome.isSymbolicLink() || !initialHome.isDirectory()) throw new Error(`Profile Home must be a real directory: ${profileHome}`);
	if (initialAgent.isSymbolicLink() || !initialAgent.isDirectory()) throw new Error(`Profile Agent directory must be a real directory: ${agentDir}`);
	const [realHome, realAgent] = await Promise.all([realpath(profileHome), realpath(agentDir)]);
	if (!inside(realHome, realAgent)) throw new Error(`Profile Agent directory must stay inside its Profile Home: ${agentDir}`);
	const [finalHome, finalAgent] = await Promise.all([lstat(profileHome), lstat(agentDir)]);
	if (!sameFile(initialHome, finalHome) || !sameFile(initialAgent, finalAgent)) throw new Error("Profile boundary changed during capability validation");
}

export async function inspectStandardWebPack(input: StandardWebProfile, options: { trustedHostEnvironment?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; builtinSkillsRoot?: string } = {}): Promise<StandardWebPackStatus> {
	await assertStandardWebProfileBoundary(input);
	const [exa, agentReachSkill, piSkill, browser] = await Promise.all([
		inspectProfileExaMcporter(input.agentDir, input.integrityKey),
		inspectStandardWebSkill(input.agentDir, "agent-reach", options.builtinSkillsRoot),
		inspectStandardWebSkill(input.agentDir, "pi-web-access", options.builtinSkillsRoot),
		inspectProfileBrowser(input.agentDir, { ...(options.trustedHostEnvironment ? { trustedHostEnvironment: options.trustedHostEnvironment } : {}), ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) }),
	]);
	const exaAuthorized = input.installation.enabled && input.installation.allowedProviders.includes("exa-mcporter");
	return {
		pack: "standard-web",
		version: STANDARD_WEB_PACK_VERSION,
		profile: input.profile,
		components: [
			{
				id: "exa-web-search",
				kind: "builtin+mcp",
				state: exa.state === "installed" ? "installed" : exa.state === "invalid" ? "invalid" : exaAuthorized ? "ready_on_demand" : "disabled",
				detail: exa.state === "installed"
					? `Pinned Profile-scoped Exa MCP adapter ${EXA_MCPORTER_PROVIDER_VERSION} passed integrity verification.`
					: exa.state === "invalid"
						? "The Exa MCP adapter exists but failed integrity verification; preserve it for audit before reinstalling."
						: exaAuthorized
							? "Built-in web_search/exa_web_search are enabled; the pinned MCP adapter installs automatically on first use without an approval prompt."
							: "Profile policy does not authorize the pinned exa-mcporter Provider.",
				...(exa.evidenceRef ? { evidenceRef: exa.evidenceRef } : {}),
			},
			{
				id: "agent-reach",
				kind: "skill",
				state: agentReachSkill,
				detail: agentReachSkill === "installed"
					? "BeeMax-native Agent Reach routing Skill matches the packaged revision; login-backed social channels remain explicit customer opt-ins."
					: agentReachSkill === "customized"
						? "A Profile-local agent-reach Skill exists but differs from BeeMax's packaged revision; it was preserved and is not claimed as BeeMax-native."
					: agentReachSkill === "invalid"
							? "The Profile-local Agent Reach Skill tree failed bounded integrity validation."
							: "Agent Reach routing Skill is missing; run capabilities install agent-reach.",
			},
			{
				id: "pi-web-access",
				kind: "builtin-browser+skill",
				state: piSkill,
				detail: piSkill === "installed"
					? `Native Pi-compatible CDP Tools ${PI_WEB_ACCESS_VERSION} and the packaged Skill revision are installed; browser process=${browser.state}, endpoint=${browser.cdpUrl ?? "not started"}.`
					: piSkill === "customized"
						? "A Profile-local pi-web-access Skill exists but differs from BeeMax's packaged revision; it was preserved and is not claimed as BeeMax-native."
					: piSkill === "invalid"
							? "The Profile-local Pi Web Access Skill tree failed bounded integrity validation."
							: "Pi Web Access routing Skill is missing; run capabilities install pi-web-access.",
				evidenceRef: `builtin:${PI_WEB_ACCESS_VERSION}:${browser.cdpUrl ?? "not-started"}`,
				runtime: browser,
			},
		],
	};
}

/** Explicitly preinstall the only network payload in standard-web: pinned Exa/mcporter. */
export async function installStandardWebRuntime(input: StandardWebProfile & {
	environment?: NodeJS.ProcessEnv;
	runProviderCommand?: CapabilityProviderCommandRunner;
	signal?: AbortSignal;
}): Promise<{ exaEvidenceRef?: string; pi: PiWebAccessInstallResult }> {
	await assertStandardWebProfileBoundary(input);
	const exa = await installProfileExaMcporter({
		profileId: input.profile,
		agentDir: input.agentDir,
		installation: input.installation,
		integrityKey: input.integrityKey,
		...(input.environment ? { environment: input.environment } : {}),
		...(input.runProviderCommand ? { runCommand: input.runProviderCommand } : {}),
		...(input.signal ? { signal: input.signal } : {}),
	});
	return { ...(exa?.evidenceRef ? { exaEvidenceRef: exa.evidenceRef } : {}), pi: await installPiWebAccess() };
}

/** Compatibility install: the browser implementation is already shipped in @beemax/core. */
export async function installPiWebAccess(): Promise<PiWebAccessInstallResult> {
	return {
		installed: false,
		path: "@beemax/core/browser-tools",
		evidenceRef: `builtin:${PI_WEB_ACCESS_VERSION}`,
		revision: PI_WEB_ACCESS_VERSION,
	};
}

export async function inspectStandardWebSkill(agentDir: string, skill: StandardWebSkillId, builtinSkillsRoot = packagedBuiltinSkillsRoot()): Promise<"installed" | "missing" | "customized" | "invalid"> {
	const profileTree = await inspectProfileSkillTree(join(resolve(agentDir), "skills"), skill);
	if (profileTree.state !== "present") return profileTree.state;
	const packagedTree = await inspectProfileSkillTree(resolve(builtinSkillsRoot), skill);
	if (packagedTree.state !== "present") throw new Error(`Packaged standard-web Skill is unavailable or invalid: ${skill} (${packagedTree.reason})`);
	return profileTree.sha256 === packagedTree.sha256 ? "installed" : "customized";
}

function packagedBuiltinSkillsRoot(): string { return fileURLToPath(new URL("../../../skills/builtin/", import.meta.url)); }
function inside(root: string, candidate: string): boolean { return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`); }
function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean { return left.dev === right.dev && left.ino === right.ino; }
