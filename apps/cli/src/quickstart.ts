import type { BeeMaxConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { runDoctor } from "./doctor.ts";
import { listProfiles, syncBuiltinSkills } from "./profile-config.ts";
import { runSetup, type SetupOptions } from "./setup.ts";

export interface QuickstartOptions {
	profile: string;
	setup: SetupOptions;
}

export interface QuickstartResult {
	profile: string;
	ready: boolean;
	setupPerformed: boolean;
}

export interface QuickstartDependencies {
	listProfiles: typeof listProfiles;
	setup: typeof runSetup;
	doctor: typeof runDoctor;
	loadConfig: typeof loadConfig;
	syncSkills: typeof syncBuiltinSkills;
}

export type QuickstartLaunchTarget = "chat" | "gateway";

const DEFAULT_DEPENDENCIES: QuickstartDependencies = {
	listProfiles,
	setup: runSetup,
	doctor: runDoctor,
	loadConfig,
	syncSkills: syncBuiltinSkills,
};

/**
 * Prepares the first useful BeeMax conversation without weakening Profile
 * isolation or bypassing the ordinary setup and readiness authorities.
 */
export async function prepareQuickstart(
	options: QuickstartOptions,
	dependencies: Partial<QuickstartDependencies> = {},
): Promise<QuickstartResult> {
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	const exists = (await deps.listProfiles()).includes(options.profile);
	if (!exists) return setupResult(options, deps);

	await deps.syncSkills(options.profile);
	const config = deps.loadConfig(undefined, options.profile);
	if (!hasUsableModelCredential(config)) return setupResult(options, deps);

	const ready = await deps.doctor(config, { requireGateway: false });
	return { profile: options.profile, ready, setupPerformed: false };
}

/**
 * A configured channel is useful only while its Gateway is running. Keep an
 * explicit one-shot request local; otherwise quickstart enters the channel
 * runtime immediately after setup.
 */
export function quickstartLaunchTarget(
	config: Pick<BeeMaxConfig, "gateway">,
	once?: string,
): QuickstartLaunchTarget {
	if (once !== undefined) return "chat";
	return config.gateway.channels.some((channel) => channel.enabled) ? "gateway" : "chat";
}

async function setupResult(options: QuickstartOptions, deps: QuickstartDependencies): Promise<QuickstartResult> {
	const ready = await deps.setup({ ...options.setup, profile: options.profile, gatewayOnly: false });
	return { profile: options.profile, ready, setupPerformed: true };
}

function hasUsableModelCredential(config: Pick<BeeMaxConfig, "model">): boolean {
	return Boolean(config.model.apiKey?.trim());
}
