import { redactCredentialMaterial } from "./credential-material.ts";

export type CapabilityProviderKind = "tool" | "mcp";
export type CapabilityProviderHealthStatus = "ready" | "unverified" | "configuration_required" | "unhealthy" | "unavailable";

export interface CapabilityProviderHealth {
	status: CapabilityProviderHealthStatus;
	/** Observed installation presence. `absent` is required to safely clear an outcome-unknown quarantine for retry. */
	installationState?: "present" | "absent" | "unknown";
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
	installed: boolean | (() => boolean);
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
	code: "configuration_required" | "provider_unhealthy" | "provider_unavailable" | "installation_authorization_required" | "installation_denied" | "installation_failed" | "installation_outcome_unknown";
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
	authorityEvidenceRef?: string;
}

export interface CapabilityProviderInstallReceipt { receiptId: string; installedAt: number; evidenceRef: string; }
export interface CapabilityProviderInstaller { install(provider: CapabilityProviderDescriptor, signal: AbortSignal): Promise<CapabilityProviderInstallReceipt>; }
export interface CapabilityProviderInstallAuthority {
	authorize(input: { capability: string; provider: CapabilityProviderDescriptor }, signal?: AbortSignal): Promise<{ allowed: boolean; evidenceRef?: string; reason?: string }>;
}

export interface CapabilityProviderRuntimeOptions {
	healthTimeoutMs?: number;
	authorityTimeoutMs?: number;
	installTimeoutMs?: number;
	installer?: CapabilityProviderInstaller;
	installAuthority?: CapabilityProviderInstallAuthority;
}

type NormalizedCapabilityProviderDescriptor = Omit<CapabilityProviderDescriptor, "installed"> & { installed: boolean };

const trustedAcquisitionTools = new WeakSet<object>();
const trustedResolutionTools = new WeakSet<object>();
/** Internal composition brand: untrusted MCP/Tool results cannot self-certify Provider installation. */
export function attestCapabilityProviderAcquisitionTool<T extends object>(tool: T): T { trustedAcquisitionTools.add(tool); return tool; }
export function isTrustedCapabilityProviderAcquisitionTool(tool: unknown): boolean { return Boolean(tool && typeof tool === "object" && trustedAcquisitionTools.has(tool as object)); }
/** Internal composition brand: only the Core resolver may reclassify dynamic Provider availability. */
export function attestCapabilityProviderResolutionTool<T extends object>(tool: T): T { trustedResolutionTools.add(tool); return tool; }
export function isTrustedCapabilityProviderResolutionTool(tool: unknown): boolean { return Boolean(tool && typeof tool === "object" && trustedResolutionTools.has(tool as object)); }

/** Resolves Tool/MCP implementations without changing the requested capability contract. */
export class CapabilityProviderRuntime {
	private readonly healthTimeoutMs: number;
	private readonly authorityTimeoutMs: number;
	private readonly installTimeoutMs: number;
	private readonly installer?: CapabilityProviderInstaller;
	private readonly installAuthority?: CapabilityProviderInstallAuthority;
	private readonly installerSettlements = new Map<string, Promise<CapabilityProviderInstallReceipt>>();
	private readonly installationOutcomeUnknown = new Map<string, { observedAt: number; reason: string }>();

	constructor(options: CapabilityProviderRuntimeOptions = {}) {
		this.healthTimeoutMs = Math.max(100, Math.min(Math.trunc(options.healthTimeoutMs ?? 5_000), 60_000));
		this.authorityTimeoutMs = Math.max(100, Math.min(Math.trunc(options.authorityTimeoutMs ?? 10_000), 60_000));
		this.installTimeoutMs = Math.max(100, Math.min(Math.trunc(options.installTimeoutMs ?? 60_000), 5 * 60_000));
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
		const selected = candidates.find((candidate) => candidate.installed && (candidate.health.status === "ready" || (candidate.health.status === "unverified" && !candidate.installable)));
		if (selected) return { status: "ready", capability, selected, candidates };
		return { status: "blocked", capability, candidates, blocker: blockerFor(candidates) };
	}

	async acquire(input: { capability: string; providers: readonly CapabilityProviderDescriptor[]; signal?: AbortSignal }): Promise<CapabilityProviderAcquisition> {
		const capability = required(input.capability, "Capability", 500);
		const providers = input.providers.map(providerDescriptor).filter((provider) => provider.capabilities.some((value) => normalized(value) === normalized(capability)));
		const current = await this.resolve({ capability, providers, ...(input.signal ? { signal: input.signal } : {}) });
		if (current.status === "ready") return current;
		const quarantined = providers.filter((candidate) => this.installationOutcomeUnknown.has(candidate.id)).sort((left, right) => left.id.localeCompare(right.id))[0];
		if (quarantined) return this.reconcileUnknownInstallation(capability, quarantined, current, input.signal);
		const provider = providers.filter((candidate) => !candidate.installed && candidate.install).sort((left, right) => left.id.localeCompare(right.id))[0];
		if (!provider) return current;
		if (!this.installAuthority) return { ...current, blocker: { code: "installation_authorization_required", reason: `Provider ${provider.id} requires explicit installation authority`, requiredConfiguration: [] } };
		const authorityAbort = new AbortController();
		const authoritySignal = input.signal ? AbortSignal.any([input.signal, authorityAbort.signal]) : authorityAbort.signal;
		let authority: Awaited<ReturnType<CapabilityProviderInstallAuthority["authorize"]>>;
		try {
			authority = await bounded(() => this.installAuthority!.authorize({ capability, provider }, authoritySignal), this.authorityTimeoutMs, input.signal, () => authorityAbort.abort(new Error(`Provider ${provider.id} installation authority timed out after ${this.authorityTimeoutMs}ms`)), `Provider ${provider.id} installation authority timed out after ${this.authorityTimeoutMs}ms`);
		} catch (error) {
			return { ...current, blocker: { code: "installation_authorization_required", reason: `Provider ${provider.id} installation authority is unavailable: ${safeReason(error)}`, requiredConfiguration: [] } };
		}
		if (!authority.allowed) return { ...current, blocker: { code: "installation_denied", reason: authority.reason ? safeText(authority.reason, "Provider installation denial reason", 2_000) : `Installation authority denied Provider ${provider.id}`, requiredConfiguration: [] } };
		if (!authority.evidenceRef?.trim()) return { ...current, blocker: { code: "installation_denied", reason: `Installation authority for Provider ${provider.id} returned no evidence`, requiredConfiguration: [] } };
		let authorityEvidenceRef: string;
		try { authorityEvidenceRef = evidenceReference(authority.evidenceRef, "Provider installation authority evidence"); }
		catch (error) { return { ...current, blocker: { code: "installation_denied", reason: safeReason(error), requiredConfiguration: [] } }; }
		if (!this.installer) return { ...current, blocker: { code: "installation_failed", reason: `No trusted installer is configured for Provider ${provider.id}`, requiredConfiguration: [] } };
		if (!provider.health) return { ...current, blocker: { code: "installation_failed", reason: `Provider ${provider.id} cannot be installed because no post-install health probe is defined`, requiredConfiguration: [] }, authorityEvidenceRef };
		try {
			const receipt = await this.installProvider(provider, input.signal);
			this.installationOutcomeUnknown.delete(provider.id);
			const verified = await this.resolve({ capability, providers: providers.map((candidate) => candidate.id === provider.id ? { ...candidate, installed: true } : candidate), ...(input.signal ? { signal: input.signal } : {}) });
			if (verified.status !== "ready" || verified.selected?.health.status !== "ready" || !verified.selected.health.evidenceRef?.trim()) return { ...verified, status: "blocked", selected: undefined, blocker: { code: "installation_failed", reason: `Provider ${provider.id} was installed but did not pass its health check: ${verified.blocker?.reason ?? verified.selected?.health.reason ?? "verified ready evidence is unavailable"}`, requiredConfiguration: verified.blocker?.requiredConfiguration ?? [] }, installationReceipt: receipt, authorityEvidenceRef };
			return { ...verified, installationReceipt: receipt, authorityEvidenceRef };
		} catch (error) {
			if (error instanceof ProviderInstallationOutcomeUnknownError || input.signal?.aborted) {
				this.installationOutcomeUnknown.set(provider.id, { observedAt: Date.now(), reason: safeReason(error) });
				return { ...current, blocker: { code: "installation_outcome_unknown", reason: `Provider ${provider.id} installation was interrupted and may still have changed host state; reconcile Provider health before retrying: ${safeReason(error)}`, requiredConfiguration: [] }, authorityEvidenceRef };
			}
			return { ...current, blocker: { code: "installation_failed", reason: `Provider ${provider.id} installation failed: ${safeReason(error)}`, requiredConfiguration: [] } };
		}
	}

	private async reconcileUnknownInstallation(capability: string, provider: NormalizedCapabilityProviderDescriptor, current: CapabilityProviderResolution, signal?: AbortSignal): Promise<CapabilityProviderAcquisition> {
		const unknown = this.installationOutcomeUnknown.get(provider.id)!;
		const health = await this.probeHealth(provider, signal);
		const observedCandidate: CapabilityProviderCandidate = Object.freeze({
			id: provider.id, kind: provider.kind, installed: health.status === "ready", health,
			...(provider.configuration ? { configuration: provider.configuration } : {}), installable: Boolean(provider.install),
		});
		const candidates = current.candidates.map((candidate) => candidate.id === provider.id ? observedCandidate : candidate);
		candidates.sort((left, right) => healthPriority(left.health.status) - healthPriority(right.health.status) || Number(right.installed) - Number(left.installed) || left.id.localeCompare(right.id));
		if (health.status === "ready" && health.evidenceRef) {
			if (this.installerSettlements.has(provider.id)) return { status: "blocked", capability, candidates, blocker: {
				code: "installation_outcome_unknown", reason: `Provider ${provider.id} reports ready, but the interrupted installer is still settling; reconciliation must wait for that operation to converge.`, requiredConfiguration: [],
			} };
			this.installationOutcomeUnknown.delete(provider.id);
			return { status: "ready", capability, selected: observedCandidate, candidates };
		}
		if (health.status === "unavailable" && health.installationState === "absent" && health.evidenceRef) {
			if (this.installerSettlements.has(provider.id)) return { status: "blocked", capability, candidates, blocker: {
				code: "installation_outcome_unknown", reason: `Provider ${provider.id} reports an absent installation, but the interrupted installer is still settling; absence must be observed again after that operation converges.`, requiredConfiguration: [],
			} };
			this.installationOutcomeUnknown.delete(provider.id);
			return { status: "blocked", capability, candidates, blocker: {
				code: "provider_unavailable",
				reason: `${provider.id}: ${health.reason ?? "installation is observably absent"}; absence evidence ${health.evidenceRef} cleared the prior outcome-unknown quarantine. A separate acquisition with fresh authority is required before retry.`,
				requiredConfiguration: [],
			} };
		}
		return { status: "blocked", capability, candidates, blocker: {
			code: "installation_outcome_unknown",
			reason: `Provider ${provider.id} installation outcome remains unknown since ${unknown.observedAt}: ${health.reason ?? unknown.reason}. A ready health result with evidence, or explicit absent installation evidence, is required before retry.`,
			requiredConfiguration: [],
		} };
	}

	private async installProvider(provider: CapabilityProviderDescriptor, signal?: AbortSignal): Promise<CapabilityProviderInstallReceipt> {
		while (true) {
			const existing = this.installerSettlements.get(provider.id);
			if (existing) {
				try {
					return await bounded(() => existing, this.installTimeoutMs, signal, () => undefined, `Provider ${provider.id} installer settlement timed out after ${this.installTimeoutMs}ms`, ProviderInstallationSettlementTimeoutError);
				} catch (error) {
					if (signal?.aborted) throw error;
					if (error instanceof ProviderInstallationSettlementTimeoutError) throw new ProviderInstallationOutcomeUnknownError(error.message);
					throw new ProviderInstallationOutcomeUnknownError(`Provider ${provider.id} shared installation did not settle successfully: ${safeReason(error)}`);
				}
			}

			const installAbort = new AbortController();
			const effectiveSignal = signal ? AbortSignal.any([signal, installAbort.signal]) : installAbort.signal;
			let settlement: Promise<CapabilityProviderInstallReceipt>;
			const operation = Promise.resolve().then(() => this.installer!.install(provider, effectiveSignal)).then(installReceipt);
			settlement = operation.finally(() => {
				if (this.installerSettlements.get(provider.id) === settlement) this.installerSettlements.delete(provider.id);
			});
			this.installerSettlements.set(provider.id, settlement);
			return bounded(() => settlement, this.installTimeoutMs, signal, () => installAbort.abort(new ProviderInstallationOutcomeUnknownError(`Provider ${provider.id} installation timed out after ${this.installTimeoutMs}ms`)), `Provider ${provider.id} installation timed out after ${this.installTimeoutMs}ms`, ProviderInstallationOutcomeUnknownError);
		}
	}

	private async inspectHealth(provider: CapabilityProviderDescriptor, signal?: AbortSignal): Promise<CapabilityProviderHealth> {
		if (!provider.installed) return { status: "unavailable", reason: `Provider ${provider.id} is not installed` };
		return this.probeHealth(provider, signal);
	}

	private async probeHealth(provider: CapabilityProviderDescriptor, signal?: AbortSignal): Promise<CapabilityProviderHealth> {
		if (!provider.health) return { status: "unverified", reason: `Provider ${provider.id} has no observed health evidence` };
		try {
			const timeout = new AbortController();
			const effectiveSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
			return providerHealth(await bounded(() => provider.health!(effectiveSignal), this.healthTimeoutMs, signal, () => timeout.abort(new Error(`Provider ${provider.id} health check timed out after ${this.healthTimeoutMs}ms`)), `Provider ${provider.id} health check timed out after ${this.healthTimeoutMs}ms`));
		} catch (error) {
			return { status: "unavailable", reason: safeReason(error) };
		}
	}
}

function providerDescriptor(input: CapabilityProviderDescriptor): NormalizedCapabilityProviderDescriptor {
	if (input.kind !== "tool" && input.kind !== "mcp") throw new Error("Capability Provider kind is invalid");
	const capabilities = [...new Set(input.capabilities.map((value) => required(value, "Provider capability", 500)))];
	if (!capabilities.length) throw new Error("Capability Provider must declare at least one capability");
	return Object.freeze({ ...input, id: identifier(input.id, "Provider id", 128), installed: typeof input.installed === "function" ? Boolean(input.installed()) : Boolean(input.installed), capabilities: Object.freeze(capabilities), ...(input.configuration ? { configuration: providerConfiguration(input.configuration) } : {}) });
}

function providerConfiguration(input: CapabilityProviderConfiguration): CapabilityProviderConfiguration {
	const requiredKeys = [...new Set(input.required.map((value) => required(value, "Provider configuration key", 128)))];
	return Object.freeze({ required: Object.freeze(requiredKeys.map((value) => identifier(value, "Provider configuration key", 128))), instructions: safeText(input.instructions, "Provider configuration instructions", 2_000) });
}

function providerHealth(input: CapabilityProviderHealth): CapabilityProviderHealth {
	if (!["ready", "unverified", "configuration_required", "unhealthy", "unavailable"].includes(input.status)) throw new Error("Capability Provider health status is invalid");
	if (input.installationState !== undefined && !["present", "absent", "unknown"].includes(input.installationState)) throw new Error("Capability Provider installation state is invalid");
	if (input.status === "ready" && input.installationState === "absent") throw new Error("A ready Provider cannot report an absent installation");
	if (input.installationState === "absent" && input.status !== "unavailable") throw new Error("An absent Provider installation must report unavailable health");
	return Object.freeze({ status: input.status, ...(input.installationState ? { installationState: input.installationState } : {}), ...(input.reason ? { reason: safeText(input.reason, "Provider health reason", 2_000) } : {}), ...(input.evidenceRef ? { evidenceRef: evidenceReference(input.evidenceRef, "Provider health evidence") } : {}), ...(input.missingConfiguration ? { missingConfiguration: Object.freeze([...new Set(input.missingConfiguration.map((value) => identifier(value, "Missing configuration key", 128)))]) } : {}) });
}

function installReceipt(input: CapabilityProviderInstallReceipt): CapabilityProviderInstallReceipt {
	if (!Number.isSafeInteger(input.installedAt) || input.installedAt < 0) throw new Error("Provider installation receipt time is invalid");
	return Object.freeze({ receiptId: identifier(input.receiptId, "Provider installation receipt id", 256), installedAt: input.installedAt, evidenceRef: evidenceReference(input.evidenceRef, "Provider installation receipt evidence") });
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
function identifier(value: string, label: string, maxLength: number): string { const result = required(value, label, maxLength); if (!/^[a-z0-9][a-z0-9._:@-]*$/i.test(result)) throw new Error(`${label} must be an opaque identifier`); return result; }
function evidenceReference(value: string, label: string): string { return identifier(value, label, 1_000); }
function safeText(value: string, label: string, maxLength: number): string { return redactCredentialMaterial(required(value, label, maxLength)); }
function safeReason(error: unknown): string { return redactCredentialMaterial(error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000)); }

class ProviderInstallationOutcomeUnknownError extends Error {}
class ProviderInstallationSettlementTimeoutError extends Error {}

function bounded<T>(operation: () => Promise<T>, timeoutMs: number, signal: AbortSignal | undefined, onTimeout: () => void, timeoutMessage: string, TimeoutError: new (message: string) => Error = Error): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (signal?.aborted) { reject(signal.reason ?? new Error("Provider operation aborted")); return; }
		let settled = false;
		const finish = (callback: () => void) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); callback(); };
		const abort = () => finish(() => reject(signal?.reason ?? new Error("Provider operation aborted")));
		const timer = setTimeout(() => finish(() => { onTimeout(); reject(new TimeoutError(timeoutMessage)); }), timeoutMs);
		signal?.addEventListener("abort", abort, { once: true });
		operation().then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
	});
}
