export type CapabilityProviderKind = "tool" | "mcp";
export type CapabilityProviderHealthStatus = "ready" | "unverified" | "configuration_required" | "unhealthy" | "unavailable";

export interface CapabilityProviderHealth {
	status: CapabilityProviderHealthStatus;
	reason?: string;
	evidenceRef?: string;
	missingConfiguration?: readonly string[];
}

export interface CapabilityProviderConfiguration {
	required: readonly string[];
	instructions: string;
}

export interface CapabilityProviderInstallSpec {
	source: string;
	package: string;
	version?: string;
}

export interface CapabilityProviderDescriptor {
	id: string;
	kind: CapabilityProviderKind;
	capabilities: readonly string[];
	installed: boolean;
	configuration?: CapabilityProviderConfiguration;
	install?: CapabilityProviderInstallSpec;
	health?: (signal: AbortSignal) => Promise<CapabilityProviderHealth>;
}

export interface CapabilityProviderCandidate {
	id: string;
	kind: CapabilityProviderKind;
	installed: boolean;
	health: CapabilityProviderHealth;
	configuration?: CapabilityProviderConfiguration;
	installable: boolean;
}

export interface CapabilityProviderBlocker {
	code: "configuration_required" | "provider_unhealthy" | "provider_unavailable" | "installation_authorization_required" | "installation_denied" | "installation_failed";
	reason: string;
	requiredConfiguration: string[];
}

export interface CapabilityProviderResolution {
	status: "ready" | "blocked";
	capability: string;
	selected?: CapabilityProviderCandidate;
	candidates: CapabilityProviderCandidate[];
	blocker?: CapabilityProviderBlocker;
}

export interface CapabilityProviderAcquisition extends CapabilityProviderResolution {
	installationReceipt?: CapabilityProviderInstallReceipt;
}

export interface CapabilityProviderInstallReceipt { receiptId: string; installedAt: number; evidenceRef?: string; }
export interface CapabilityProviderInstaller { install(provider: CapabilityProviderDescriptor, signal: AbortSignal): Promise<CapabilityProviderInstallReceipt>; }
export interface CapabilityProviderInstallAuthority {
	authorize(input: { capability: string; provider: CapabilityProviderDescriptor }): Promise<{ allowed: boolean; evidenceRef?: string; reason?: string }>;
}

export interface CapabilityProviderRuntimeOptions {
	healthTimeoutMs?: number;
	installer?: CapabilityProviderInstaller;
	installAuthority?: CapabilityProviderInstallAuthority;
}

/** Resolves Tool/MCP implementations without changing the requested capability contract. */
export class CapabilityProviderRuntime {
	private readonly healthTimeoutMs: number;
	private readonly installer?: CapabilityProviderInstaller;
	private readonly installAuthority?: CapabilityProviderInstallAuthority;

	constructor(options: CapabilityProviderRuntimeOptions = {}) {
		this.healthTimeoutMs = Math.max(100, Math.min(Math.trunc(options.healthTimeoutMs ?? 5_000), 60_000));
		this.installer = options.installer;
		this.installAuthority = options.installAuthority;
	}

	async resolve(input: { capability: string; providers: readonly CapabilityProviderDescriptor[]; signal?: AbortSignal }): Promise<CapabilityProviderResolution> {
		const capability = required(input.capability, "Capability", 500);
		const providers = input.providers.map(providerDescriptor).filter((provider) => provider.capabilities.some((value) => normalized(value) === normalized(capability)));
		const candidates = await Promise.all(providers.map(async (provider): Promise<CapabilityProviderCandidate> => {
			const health = await this.inspectHealth(provider, input.signal);
			return Object.freeze({ id: provider.id, kind: provider.kind, installed: provider.installed, health, ...(provider.configuration ? { configuration: provider.configuration } : {}), installable: Boolean(provider.install) });
		}));
		candidates.sort((left, right) => healthPriority(left.health.status) - healthPriority(right.health.status) || Number(right.installed) - Number(left.installed) || left.id.localeCompare(right.id));
		const selected = candidates.find((candidate) => candidate.installed && (candidate.health.status === "ready" || candidate.health.status === "unverified"));
		if (selected) return { status: "ready", capability, selected, candidates };
		return { status: "blocked", capability, candidates, blocker: blockerFor(candidates) };
	}

	async acquire(input: { capability: string; providers: readonly CapabilityProviderDescriptor[]; signal?: AbortSignal }): Promise<CapabilityProviderAcquisition> {
		const capability = required(input.capability, "Capability", 500);
		const providers = input.providers.map(providerDescriptor).filter((provider) => provider.capabilities.some((value) => normalized(value) === normalized(capability)));
		const current = await this.resolve({ capability, providers, ...(input.signal ? { signal: input.signal } : {}) });
		if (current.status === "ready") return current;
		const provider = providers.filter((candidate) => !candidate.installed && candidate.install).sort((left, right) => left.id.localeCompare(right.id))[0];
		if (!provider) return current;
		if (!this.installAuthority) return { ...current, blocker: { code: "installation_authorization_required", reason: `Provider ${provider.id} requires explicit installation authority`, requiredConfiguration: [] } };
		const authority = await this.installAuthority.authorize({ capability, provider });
		if (!authority.allowed) return { ...current, blocker: { code: "installation_denied", reason: authority.reason?.trim().slice(0, 2_000) || `Installation authority denied Provider ${provider.id}`, requiredConfiguration: [] } };
		if (!authority.evidenceRef?.trim()) return { ...current, blocker: { code: "installation_denied", reason: `Installation authority for Provider ${provider.id} returned no evidence`, requiredConfiguration: [] } };
		if (!this.installer) return { ...current, blocker: { code: "installation_failed", reason: `No trusted installer is configured for Provider ${provider.id}`, requiredConfiguration: [] } };
		try {
			const effectiveSignal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(this.healthTimeoutMs)]) : AbortSignal.timeout(this.healthTimeoutMs);
			const receipt = installReceipt(await this.installer.install(provider, effectiveSignal));
			const verified = await this.resolve({ capability, providers: providers.map((candidate) => candidate.id === provider.id ? { ...candidate, installed: true } : candidate), ...(input.signal ? { signal: input.signal } : {}) });
			if (verified.status !== "ready") return { ...verified, blocker: { code: "installation_failed", reason: `Provider ${provider.id} was installed but did not pass its health check: ${verified.blocker?.reason ?? "unknown health failure"}`, requiredConfiguration: verified.blocker?.requiredConfiguration ?? [] }, installationReceipt: receipt };
			return { ...verified, installationReceipt: receipt };
		} catch (error) {
			return { ...current, blocker: { code: "installation_failed", reason: `Provider ${provider.id} installation failed: ${safeReason(error)}`, requiredConfiguration: [] } };
		}
	}

	private async inspectHealth(provider: CapabilityProviderDescriptor, signal?: AbortSignal): Promise<CapabilityProviderHealth> {
		if (!provider.installed) return { status: "unavailable", reason: `Provider ${provider.id} is not installed` };
		if (!provider.health) return { status: "ready", evidenceRef: `installed:${provider.id}` };
		try {
			const timeout = new AbortController();
			const effectiveSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
			return providerHealth(await bounded(provider.health(effectiveSignal), this.healthTimeoutMs, signal, () => timeout.abort(new Error(`Provider ${provider.id} health check timed out after ${this.healthTimeoutMs}ms`)), `Provider ${provider.id} health check timed out after ${this.healthTimeoutMs}ms`));
		} catch (error) {
			return { status: "unavailable", reason: safeReason(error) };
		}
	}
}

function providerDescriptor(input: CapabilityProviderDescriptor): CapabilityProviderDescriptor {
	if (input.kind !== "tool" && input.kind !== "mcp") throw new Error("Capability Provider kind is invalid");
	const capabilities = [...new Set(input.capabilities.map((value) => required(value, "Provider capability", 500)))];
	if (!capabilities.length) throw new Error("Capability Provider must declare at least one capability");
	return Object.freeze({ ...input, id: required(input.id, "Provider id", 128), capabilities: Object.freeze(capabilities), ...(input.configuration ? { configuration: providerConfiguration(input.configuration) } : {}) });
}

function providerConfiguration(input: CapabilityProviderConfiguration): CapabilityProviderConfiguration {
	const requiredKeys = [...new Set(input.required.map((value) => required(value, "Provider configuration key", 128)))];
	return Object.freeze({ required: Object.freeze(requiredKeys), instructions: required(input.instructions, "Provider configuration instructions", 2_000) });
}

function providerHealth(input: CapabilityProviderHealth): CapabilityProviderHealth {
	if (!["ready", "unverified", "configuration_required", "unhealthy", "unavailable"].includes(input.status)) throw new Error("Capability Provider health status is invalid");
	return Object.freeze({ status: input.status, ...(input.reason ? { reason: required(input.reason, "Provider health reason", 2_000) } : {}), ...(input.evidenceRef ? { evidenceRef: required(input.evidenceRef, "Provider health evidence", 1_000) } : {}), ...(input.missingConfiguration ? { missingConfiguration: Object.freeze([...new Set(input.missingConfiguration.map((value) => required(value, "Missing configuration key", 128)))]) } : {}) });
}

function installReceipt(input: CapabilityProviderInstallReceipt): CapabilityProviderInstallReceipt {
	if (!Number.isSafeInteger(input.installedAt) || input.installedAt < 0) throw new Error("Provider installation receipt time is invalid");
	return Object.freeze({ receiptId: required(input.receiptId, "Provider installation receipt id", 256), installedAt: input.installedAt, ...(input.evidenceRef ? { evidenceRef: required(input.evidenceRef, "Provider installation receipt evidence", 1_000) } : {}) });
}

function blockerFor(candidates: readonly CapabilityProviderCandidate[]): CapabilityProviderBlocker {
	const configuration = candidates.filter((candidate) => candidate.health.status === "configuration_required");
	if (configuration.length) return { code: "configuration_required", reason: configuration.map((candidate) => `${candidate.id}: ${candidate.health.reason ?? "configuration is required"}`).join("; "), requiredConfiguration: [...new Set(configuration.flatMap((candidate) => candidate.health.missingConfiguration ?? candidate.configuration?.required ?? []))] };
	const unhealthy = candidates.filter((candidate) => candidate.health.status === "unhealthy");
	if (unhealthy.length) return { code: "provider_unhealthy", reason: unhealthy.map((candidate) => `${candidate.id}: ${candidate.health.reason ?? "health check failed"}`).join("; "), requiredConfiguration: [] };
	return { code: "provider_unavailable", reason: candidates.length ? candidates.map((candidate) => `${candidate.id}: ${candidate.health.reason ?? "unavailable"}`).join("; ") : "No Tool or MCP Provider candidate matched the required capability", requiredConfiguration: [] };
}

function healthPriority(status: CapabilityProviderHealthStatus): number { return status === "ready" ? 0 : status === "unverified" ? 1 : status === "configuration_required" ? 2 : status === "unhealthy" ? 3 : 4; }
function normalized(value: string): string { return value.normalize("NFKC").trim().toLocaleLowerCase(); }
function required(value: string, label: string, maxLength: number): string { const normalizedValue = value?.trim(); if (!normalizedValue || normalizedValue.length > maxLength) throw new Error(`${label} must be between 1 and ${maxLength} characters`); return normalizedValue; }
function safeReason(error: unknown): string { return error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000); }

function bounded<T>(operation: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined, onTimeout: () => void, timeoutMessage: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); callback(); };
		const abort = () => finish(() => reject(signal?.reason ?? new Error("Provider operation aborted")));
		const timer = setTimeout(() => finish(() => { onTimeout(); reject(new Error(timeoutMessage)); }), timeoutMs);
		signal?.addEventListener("abort", abort, { once: true });
		operation.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
	});
}
