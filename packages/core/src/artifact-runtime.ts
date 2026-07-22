import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ThruveraRuntimeSource } from "./runtime.ts";
import { MUTATING_TOOL_POLICY, READ_ONLY_TOOL_POLICY, withToolPolicy } from "./tool-runtime.ts";
import type { ArtifactVerificationDimension } from "./open-world-contract.ts";

export const ARTIFACT_MANIFEST_SCHEMA_VERSION = "beemax.artifact-manifest.v1" as const;
export const ARTIFACT_VERIFICATION_SCHEMA_VERSION = "beemax.artifact-verification.v1" as const;
export const SOURCE_RECEIPT_SCHEMA_VERSION = "beemax.source-receipt.v1" as const;

const ARTIFACT_DIMENSION_VALUES = ["existence", "integrity", "semantic", "render", "consistency", "freshness", "delivery", "execution"] as const satisfies readonly ArtifactVerificationDimension[];
const ARTIFACT_DIMENSIONS = new Set<ArtifactVerificationDimension>(ARTIFACT_DIMENSION_VALUES);
const ARTIFACT_STATUSES = new Set<ArtifactVerificationStatus>(["accepted", "rejected", "unavailable"]);
const MAX_ARTIFACT_BYTES = 1_000_000_000;
const MAX_SOURCE_RECEIPT_PAYLOAD_BYTES = 256_000;
const ARTIFACT_EFFECT_PROOF_PROVIDER = "beemax-artifact-runtime";

export interface ArtifactLocator {
	kind: "workspace" | "url" | "reference";
	uri: string;
}

export interface ArtifactProducerDescriptor {
	providerId: string;
	providerVersion: string;
	operation: string;
}

export interface ArtifactManifest {
	schemaVersion: typeof ARTIFACT_MANIFEST_SCHEMA_VERSION;
	id: `artifact:sha256:${string}`;
	locator: ArtifactLocator;
	mediaType: string;
	byteLength: number;
	sha256: string;
	producer: ArtifactProducerDescriptor;
	sourceRefs: readonly string[];
	createdAt: number;
}

export type ArtifactManifestInput = Omit<ArtifactManifest, "schemaVersion" | "id">;

/** Durable, content-addressed evidence returned by an observing Tool or Provider. */
export interface SourceReceipt {
	schemaVersion: typeof SOURCE_RECEIPT_SCHEMA_VERSION;
	id: `source-receipt:sha256:${string}`;
	capability: string;
	subject: string;
	observedAt: number;
	sourceRefs: readonly string[];
	payload: unknown;
}

export type SourceReceiptInput = Omit<SourceReceipt, "schemaVersion" | "id">;

export function createSourceReceipt(input: SourceReceiptInput): Readonly<SourceReceipt> {
	const unsigned = normalizeSourceReceiptUnsigned(input);
	return deepFreeze({ ...unsigned, id: `source-receipt:sha256:${sha256Json(unsigned)}` as const });
}

/** Creates Manifest evidence for bytes a trusted Provider has just produced; it does not verify Acceptance Criteria. */
export function createArtifactManifest(input: ArtifactManifestInput): Readonly<ArtifactManifest> {
	const sha256 = normalizeSha256(input.sha256);
	return validateArtifactManifest({ ...input, schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION, id: `artifact:sha256:${sha256}`, sha256 });
}

export type ArtifactVerificationStatus = "accepted" | "rejected" | "unavailable";

export interface ArtifactVerificationCheck {
	dimension: ArtifactVerificationDimension;
	status: ArtifactVerificationStatus;
	evidenceRefs: readonly string[];
	message?: string;
}

export interface ArtifactVerificationReceipt {
	schemaVersion: typeof ARTIFACT_VERIFICATION_SCHEMA_VERSION;
	id: `artifact-verification:sha256:${string}`;
	artifactId: ArtifactManifest["id"];
	artifactSha256: string;
	expectationSha256: string;
	verifiedAt: number;
	verifiers: ReadonlyArray<{ id: string; version: string }>;
	checks: readonly ArtifactVerificationCheck[];
}

export interface ArtifactVerificationExpectation {
	requiredText?: readonly string[];
	/** Exact decoded-source substrings, distinct from normalized visible/extracted text. */
	requiredSourceText?: readonly string[];
	/** HTML-only bindings: sourceText must occur in one element's opening tag and visibleText in that same element. */
	requiredSourceVisiblePairs?: ReadonlyArray<Readonly<{ sourceText: string; visibleText: string }>>;
	minimumTextChars?: number;
	minimumExternalUrls?: number;
	maximumExternalUrls?: number;
	consistentWith?: { locator: ArtifactLocator; mediaType: string };
}

export interface ArtifactProviderDescriptor {
	id: string;
	version: string;
	operations: ReadonlyArray<{ operation: string; inputMediaTypes: readonly string[]; outputMediaTypes: readonly string[] }>;
}

export interface ArtifactProduceRequest {
	operation: string;
	input: ArtifactLocator;
	inputMediaType: string;
	output: ArtifactLocator;
	outputMediaType: string;
	requiredDimensions: readonly ArtifactVerificationDimension[];
	expectation?: ArtifactVerificationExpectation;
	signal?: AbortSignal;
}

export interface ArtifactProviderPort {
	descriptor: ArtifactProviderDescriptor;
	produce(request: ArtifactProduceRequest): Promise<{ locator: ArtifactLocator; mediaType: string; sourceRefs?: readonly string[] }>;
}

export interface ArtifactVerifierDescriptor {
	id: string;
	version: string;
	mediaTypes: readonly string[];
	dimensions: readonly ArtifactVerificationDimension[];
}

export interface ArtifactObservation {
	locator: ArtifactLocator;
	mediaType: string;
	byteLength: number;
	sha256: string;
}

/** A postcondition failed after an independent verifier observed produced bytes. */
export class ArtifactVerificationError extends Error {
	override readonly name = "ArtifactVerificationError";
	readonly observation: Readonly<ArtifactObservation>;
	readonly checks: readonly ArtifactVerificationCheck[];
	readonly verifiers: ReadonlyArray<{ id: string; version: string }>;
	constructor(message: string, evidence: { observation: ArtifactObservation; checks: readonly ArtifactVerificationCheck[]; verifiers: ReadonlyArray<{ id: string; version: string }> }) {
		super(message);
		this.observation = deepFreeze({ ...evidence.observation, locator: { ...evidence.observation.locator } });
		this.checks = deepFreeze(evidence.checks.map((check) => ({ ...check, evidenceRefs: [...check.evidenceRefs] })));
		this.verifiers = deepFreeze(evidence.verifiers.map((verifier) => ({ ...verifier })));
	}
}

interface ArtifactRenderToolDetails {
	manifest?: Readonly<ArtifactManifest>;
	receipt?: Readonly<ArtifactVerificationReceipt>;
	artifactObservation?: Readonly<ArtifactObservation>;
	artifactChecks?: readonly ArtifactVerificationCheck[];
	artifactVerifiers?: ReadonlyArray<{ id: string; version: string }>;
	beemaxEffect?: {
		operation: string;
		externalRef: string;
		proof: { provider: string; resourceType: string; resourceId: string };
	};
}

export interface ArtifactVerifierPort {
	descriptor: ArtifactVerifierDescriptor;
	verify(request: { locator: ArtifactLocator; mediaType: string; dimensions: readonly ArtifactVerificationDimension[]; expectation: Readonly<ArtifactVerificationExpectation>; signal?: AbortSignal }): Promise<{ observed: ArtifactObservation; checks: readonly ArtifactVerificationCheck[] }>;
}

export interface ArtifactRuntimeOptions {
	providers?: readonly ArtifactProviderPort[];
	verifiers: readonly ArtifactVerifierPort[];
	now?: () => number;
}

export class ArtifactRuntime {
	readonly providers: readonly ArtifactProviderPort[];
	readonly verifiers: readonly ArtifactVerifierPort[];
	private readonly now: () => number;

	constructor(options: ArtifactRuntimeOptions) {
		this.providers = Object.freeze([...options.providers ?? []]);
		this.verifiers = Object.freeze([...options.verifiers]);
		this.now = options.now ?? Date.now;
		validateAuthorities(this.providers, this.verifiers);
	}

	async produce(request: ArtifactProduceRequest): Promise<{ manifest: Readonly<ArtifactManifest>; receipt: Readonly<ArtifactVerificationReceipt> }> {
		const normalized = normalizeProduceRequest(request);
		const provider = this.providers.find((candidate) => candidate.descriptor.operations.some((operation) => operation.operation === normalized.operation && operation.inputMediaTypes.includes(normalized.inputMediaType) && operation.outputMediaTypes.includes(normalized.outputMediaType)));
		if (!provider) throw new Error(`No Artifact Provider supports ${normalized.operation} ${normalized.inputMediaType} -> ${normalized.outputMediaType}`);
		this.selectVerifiers(normalized.outputMediaType, normalized.requiredDimensions, provider.descriptor.id);
		throwIfAborted(normalized.signal);
		const candidate = await provider.produce(normalized);
		throwIfAborted(normalized.signal);
		const locator = normalizeLocator(candidate.locator);
		if (!sameLocator(locator, normalized.output) || normalizeMediaType(candidate.mediaType) !== normalized.outputMediaType) throw new Error("Artifact Provider returned an output outside the requested locator or media type");
		const expectation = normalized.requiredDimensions.includes("consistency") && !normalized.expectation?.consistentWith
			? normalizeExpectation({ ...normalized.expectation, consistentWith: { locator: normalized.input, mediaType: normalized.inputMediaType } })
			: normalizeExpectation(normalized.expectation);
		const verification = await this.observe(locator, normalized.outputMediaType, normalized.requiredDimensions, expectation, normalized.signal, provider.descriptor.id);
		const manifest = createArtifactManifest({
			locator,
			mediaType: normalized.outputMediaType,
			byteLength: verification.observed.byteLength,
			sha256: verification.observed.sha256,
			producer: { providerId: boundedIdentifier(provider.descriptor.id, "Provider id"), providerVersion: boundedIdentifier(provider.descriptor.version, "Provider version"), operation: normalized.operation },
			sourceRefs: normalizeRefs(candidate.sourceRefs),
			createdAt: this.now(),
		});
		return { manifest, receipt: buildReceipt(manifest, expectation, verification, this.now()) };
	}

	async verify(manifest: Readonly<ArtifactManifest>, dimensions: readonly ArtifactVerificationDimension[], expectation?: ArtifactVerificationExpectation, signal?: AbortSignal): Promise<Readonly<ArtifactVerificationReceipt>> {
		const normalizedManifest = validateArtifactManifest(manifest);
		const normalizedExpectation = normalizeExpectation(expectation);
		const normalizedDimensions = normalizeDimensionsForExpectation(dimensions, normalizedExpectation);
		const verification = await this.observe(normalizedManifest.locator, normalizedManifest.mediaType, normalizedDimensions, normalizedExpectation, signal);
		if (verification.observed.byteLength !== normalizedManifest.byteLength || verification.observed.sha256 !== normalizedManifest.sha256) throw new Error("Artifact no longer matches its Manifest content identity");
		return buildReceipt(normalizedManifest, normalizedExpectation, verification, this.now());
	}

	async inspect(locator: ArtifactLocator, mediaType: string, dimensions: readonly ArtifactVerificationDimension[], expectation?: ArtifactVerificationExpectation, signal?: AbortSignal): Promise<Readonly<{ observation: ArtifactObservation; checks: readonly ArtifactVerificationCheck[]; verifiers: ReadonlyArray<{ id: string; version: string }> }>> {
		const normalizedLocator = normalizeLocator(locator);
		const normalizedMediaType = normalizeMediaType(mediaType);
		const normalizedExpectation = normalizeExpectation(expectation);
		const normalizedDimensions = normalizeDimensionsForExpectation(dimensions, normalizedExpectation);
		const verification = await this.observe(normalizedLocator, normalizedMediaType, normalizedDimensions, normalizedExpectation, signal);
		return deepFreeze({ observation: verification.observed, checks: verification.checks, verifiers: verification.verifiers });
	}

	private async observe(locator: ArtifactLocator, mediaType: string, dimensions: readonly ArtifactVerificationDimension[], expectation: Readonly<ArtifactVerificationExpectation>, signal?: AbortSignal, providerId?: string): Promise<{ observed: ArtifactObservation; checks: ArtifactVerificationCheck[]; verifiers: Array<{ id: string; version: string }> }> {
		const selected = this.selectVerifiers(mediaType, dimensions, providerId);
		let observed: ArtifactObservation | undefined;
		const checks: ArtifactVerificationCheck[] = [];
		const verifierIdentities: Array<{ id: string; version: string }> = [];
		for (const selection of selected) {
			throwIfAborted(signal);
			const result = await selection.verifier.verify({ locator, mediaType, dimensions: selection.dimensions, expectation, ...(signal ? { signal } : {}) });
			throwIfAborted(signal);
			const nextObservation = normalizeObservation(result.observed, locator, mediaType);
			if (observed && (observed.byteLength !== nextObservation.byteLength || observed.sha256 !== nextObservation.sha256)) throw new Error("Conflicting Artifact observations from independent verifiers");
			observed ??= nextObservation;
			checks.push(...normalizeChecks(result.checks, selection.dimensions));
			verifierIdentities.push({ id: boundedIdentifier(selection.verifier.descriptor.id, "Verifier id"), version: boundedIdentifier(selection.verifier.descriptor.version, "Verifier version") });
		}
		if (!observed) throw new Error("Artifact observation is unavailable");
		const byDimension = new Map(checks.map((check) => [check.dimension, check]));
		for (const dimension of dimensions) {
			const check = byDimension.get(dimension);
			const evidence = { observation: observed, checks, verifiers: verifierIdentities };
			if (!check) throw new ArtifactVerificationError(`Artifact verification ${dimension} was unavailable`, evidence);
			if (check.status !== "accepted") throw new ArtifactVerificationError(`Artifact verification ${dimension} was ${check.status}${check.message ? `: ${check.message}` : ""}`, evidence);
		}
		return { observed, checks: dimensions.map((dimension) => byDimension.get(dimension)!), verifiers: verifierIdentities };
	}

	private selectVerifiers(mediaType: string, dimensions: readonly ArtifactVerificationDimension[], providerId?: string): Array<{ verifier: ArtifactVerifierPort; dimensions: ArtifactVerificationDimension[] }> {
		const remaining = new Set(dimensions);
		const selected: Array<{ verifier: ArtifactVerifierPort; dimensions: ArtifactVerificationDimension[] }> = [];
		for (const verifier of this.verifiers) {
			if (!verifier.descriptor.mediaTypes.includes(mediaType)) continue;
			if (providerId && verifier.descriptor.id === providerId) continue;
			const supported = verifier.descriptor.dimensions.filter((dimension) => remaining.has(dimension));
			if (!supported.length) continue;
			selected.push({ verifier, dimensions: supported });
			for (const dimension of supported) remaining.delete(dimension);
			if (!remaining.size) break;
		}
		if (remaining.size) {
			const sameAuthorityCouldCover = providerId && this.verifiers.some((verifier) => verifier.descriptor.id === providerId && verifier.descriptor.mediaTypes.includes(mediaType) && verifier.descriptor.dimensions.some((dimension) => remaining.has(dimension)));
			throw new Error(sameAuthorityCouldCover ? "Artifact Verification must be independent from the producing Provider" : `No Artifact Verifier covers required dimensions: ${[...remaining].join(", ")}`);
		}
		return selected;
	}
}

export function createArtifactTools(source: ThruveraRuntimeSource, cwd: string, runtime: ArtifactRuntime): ToolDefinition[] {
	const supportedDimensions = new Set(runtime.verifiers.flatMap((verifier) => verifier.descriptor.dimensions));
	const exposedDimensions = ARTIFACT_DIMENSION_VALUES.filter((dimension) => supportedDimensions.has(dimension));
	const dimensionLiterals = (exposedDimensions.length ? exposedDimensions : ARTIFACT_DIMENSION_VALUES).map((dimension) => Type.Literal(dimension));
	const dimensions = Type.Array(Type.Union(dimensionLiterals), { minItems: 1, maxItems: dimensionLiterals.length, uniqueItems: true });
	const providerOperations = runtime.providers.flatMap((provider) => provider.descriptor.operations);
	const inputMediaTypes = [...new Set(providerOperations.flatMap((operation) => operation.inputMediaTypes))];
	const outputMediaTypes = [...new Set(providerOperations.flatMap((operation) => operation.outputMediaTypes))];
	const inputMediaType = inputMediaTypes.length === 1 ? Type.Literal(inputMediaTypes[0]!) : inputMediaTypes.length ? Type.Union(inputMediaTypes.map((mediaType) => Type.Literal(mediaType))) : Type.String({ minLength: 3, maxLength: 128 });
	const outputMediaType = outputMediaTypes.length === 1 ? Type.Literal(outputMediaTypes[0]!) : outputMediaTypes.length ? Type.Union(outputMediaTypes.map((mediaType) => Type.Literal(mediaType))) : Type.String({ minLength: 3, maxLength: 128 });
	const inspectionExpectationProperties = {
		requiredText: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000, description: "Visible/extracted text assertions only; HTML tags and other markup are not searchable assertions" }), { maxItems: 100 })),
		requiredSourceText: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 100, description: "Exact decoded-source assertions, such as raw literals in HTML markup; checked separately from visible/extracted text and unsupported for opaque media" })),
		requiredSourceVisiblePairs: Type.Optional(Type.Array(Type.Object({
			sourceText: Type.String({ minLength: 1, maxLength: 1000, description: "Exact decoded text that must occur in one HTML element opening tag" }),
			visibleText: Type.String({ minLength: 1, maxLength: 1000, description: "Visible text that must occur inside the same HTML element" }),
		}, { additionalProperties: false }), { maxItems: 100, description: "Bind each raw/source literal to its formatted visible equivalent in the same HTML element; unsupported for opaque media" })),
		minimumTextChars: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000, description: "Minimum normalized visible/extracted text characters, not file bytes" })),
		minimumExternalUrls: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000, description: "Minimum number of unique external http(s) citation hrefs in an Artifact. Only actual link targets count; fragments are ignored during deduplication" })),
		maximumExternalUrls: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000, description: "Maximum number of unique external http(s) citation links in an Artifact; set equal to minimumExternalUrls for an exact count" })),
		consistentWithPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Workspace source Artifact used for an independent consistency comparison" })),
		consistentWithMediaType: Type.Optional(Type.String({ minLength: 3, maxLength: 128, description: "Media type of consistentWithPath. For HTML-to-PDF verification, inspect the PDF as output and use text/html here for the HTML source; never use application/pdf as the source media type" })),
	};
	const render = Object.assign(withToolPolicy(defineTool({
		name: "artifact_render",
		label: "Render Artifact",
		description: "Render one workspace Artifact into another media type through a configured Provider, then require independent Artifact verification.",
		parameters: Type.Object({
			inputPath: Type.String({ minLength: 1, maxLength: 4096 }),
			outputPath: Type.String({ minLength: 1, maxLength: 4096 }),
			inputMediaType,
			outputMediaType,
			requiredDimensions: dimensions,
			requiredText: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000, description: "Visible/extracted text assertions only; HTML tags and other markup are not searchable assertions" }), { maxItems: 100 })),
			minimumTextChars: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000, description: "Minimum normalized visible/extracted text characters, not file bytes" })),
		}),
		execute: async (_id, params, signal): Promise<{ content: Array<{ type: "text"; text: string }>; details: ArtifactRenderToolDetails; isError?: boolean }> => {
			const input = workspaceLocator(cwd, params.inputPath);
			const output = workspaceLocator(cwd, params.outputPath);
			try {
				const result = await runtime.produce({ operation: "render", input, inputMediaType: params.inputMediaType, output, outputMediaType: params.outputMediaType, requiredDimensions: params.requiredDimensions, ...((params.requiredText || params.minimumTextChars !== undefined) ? { expectation: { ...(params.requiredText ? { requiredText: params.requiredText } : {}), ...(params.minimumTextChars !== undefined ? { minimumTextChars: params.minimumTextChars } : {}) } } : {}), ...(signal ? { signal } : {}) });
				return { content: [{ type: "text" as const, text: `Rendered and verified ${result.manifest.locator.uri} (${result.manifest.mediaType}, ${result.manifest.byteLength} bytes, sha256:${result.manifest.sha256})` }], details: result };
			} catch (error) {
				if (!(error instanceof ArtifactVerificationError)) throw error;
				const resourceId = output.uri.slice("workspace:".length);
				return {
					content: [{ type: "text" as const, text: `Rendered ${output.uri}, but independent verification failed: ${error.message}` }],
					details: {
						artifactObservation: error.observation,
						artifactChecks: error.checks,
						artifactVerifiers: error.verifiers,
						beemaxEffect: { operation: "render workspace Artifact", externalRef: output.uri, proof: { provider: ARTIFACT_EFFECT_PROOF_PROVIDER, resourceType: "workspace-artifact", resourceId } },
					},
					isError: true,
				};
			}
		},
	}), { ...MUTATING_TOOL_POLICY, sideEffect: "local", effectProofProvider: ARTIFACT_EFFECT_PROOF_PROVIDER, impact: "Writes one rendered Artifact inside the configured workspace" }), {
		aliases: ["html_to_pdf", "pdf_render", "artifact_consistency", "跨文件一致性"],
		triggers: ["pdf", "html to pdf", "application/pdf", "生成 pdf", "转换为 pdf", "渲染为 pdf", "html 渲染", "两份文件关键数字和来源一致性", "html 与 pdf 一致性", "source and rendered artifact consistency"],
		beemaxToolSpec: { kind: "tool" as const, version: "1", configured: runtime.providers.length > 0, health: runtime.providers.length > 0 ? "ready" as const : "configuration_required" as const, ranking: { inputModalities: ["text/html"], outputModalities: ["application/pdf"], freshness: "static" as const, evidence: "verified" as const } },
	});
	const verify = Object.assign(withToolPolicy(defineTool({
		name: "artifact_verify",
		label: "Verify Artifact",
		description: "Independently re-observe an exact Artifact Manifest across required verification dimensions. When consistency is required, supply both consistentWithPath and consistentWithMediaType.",
		parameters: Type.Object({
			manifest: Type.Object({
				schemaVersion: Type.Literal(ARTIFACT_MANIFEST_SCHEMA_VERSION), id: Type.String({ pattern: "^artifact:sha256:[a-f0-9]{64}$" }),
				locator: Type.Object({ kind: Type.Union([Type.Literal("workspace"), Type.Literal("url"), Type.Literal("reference")]), uri: Type.String({ minLength: 1, maxLength: 4096, description: "For kind=workspace, use workspace:<relative-path>; a workspace-relative path is also accepted and canonicalized" }) }),
				mediaType: Type.String({ minLength: 3, maxLength: 128 }), byteLength: Type.Integer({ minimum: 0, maximum: MAX_ARTIFACT_BYTES }), sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
				producer: Type.Object({ providerId: Type.String({ minLength: 1, maxLength: 128 }), providerVersion: Type.String({ minLength: 1, maxLength: 128 }), operation: Type.String({ minLength: 1, maxLength: 64 }) }),
				sourceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 64 }), createdAt: Type.Integer({ minimum: 0 }),
			}),
			requiredDimensions: dimensions,
			...inspectionExpectationProperties,
		}),
		execute: async (_id, params, signal) => {
			const manifest = params.manifest.locator.kind === "workspace" ? { ...params.manifest, locator: workspaceLocatorFromUri(cwd, params.manifest.locator.uri) } : params.manifest;
			if (Boolean(params.consistentWithPath) !== Boolean(params.consistentWithMediaType)) throw new Error("consistentWithPath and consistentWithMediaType must be supplied together");
			const expectation = {
				...(params.requiredText ? { requiredText: params.requiredText } : {}),
				...(params.requiredSourceText ? { requiredSourceText: params.requiredSourceText } : {}),
				...(params.requiredSourceVisiblePairs ? { requiredSourceVisiblePairs: params.requiredSourceVisiblePairs } : {}),
				...(params.minimumTextChars !== undefined ? { minimumTextChars: params.minimumTextChars } : {}),
				...(params.minimumExternalUrls !== undefined ? { minimumExternalUrls: params.minimumExternalUrls } : {}),
				...(params.maximumExternalUrls !== undefined ? { maximumExternalUrls: params.maximumExternalUrls } : {}),
				...(params.consistentWithPath && params.consistentWithMediaType ? { consistentWith: { locator: workspaceLocator(cwd, params.consistentWithPath), mediaType: params.consistentWithMediaType } } : {}),
			};
			const receipt = await runtime.verify(manifest as ArtifactManifest, params.requiredDimensions, Object.keys(expectation).length ? expectation : undefined, signal);
			const externalUrls = artifactExternalUrls(receipt.checks);
			return { content: [{ type: "text" as const, text: `Verified ${receipt.artifactId} across ${receipt.checks.map((check) => check.dimension).join(", ")}${externalUrls.length ? `; external citation URLs: ${JSON.stringify(externalUrls)}` : ""}` }], details: { manifest, receipt, ...(externalUrls.length ? { externalUrls } : {}) } };
		},
	}), { ...READ_ONLY_TOOL_POLICY, impact: "Reads and independently verifies one declared Artifact" }), {
		aliases: ["manifest_verify", "artifact_manifest_verification"],
		triggers: ["manifest reverify", "verify declared manifest", "复验 artifact manifest", "manifest 验证回执"],
		beemaxToolSpec: { kind: "tool" as const, version: "1", configured: runtime.verifiers.length > 0, health: runtime.verifiers.length > 0 ? "ready" as const : "configuration_required" as const, ranking: { inputModalities: ["file", "text/html", "application/pdf"], outputModalities: ["structured"], freshness: "current" as const, evidence: "verified" as const } },
	});
	const inspect = Object.assign(withToolPolicy(defineTool({
		name: "artifact_inspect",
		label: "Inspect Artifact",
		description: "Independently observe and verify an existing workspace Artifact directly from its path, returning its exact byte length and SHA-256 without requiring a prior Manifest. Semantic assertions can separately inspect normalized visible/extracted text and exact decoded HTML source; requiredText accepts visible text only, while source-only raw literals belong in requiredSourceText or requiredSourceVisiblePairs. HTML checks can also count unique external http(s) citation hrefs. For HTML-to-PDF consistency, inspect the PDF output and supply the HTML source through consistentWithPath with consistentWithMediaType=text/html.",
		parameters: Type.Object({
			path: Type.String({ minLength: 1, maxLength: 4096 }),
			mediaType: Type.String({ minLength: 3, maxLength: 128 }),
			requiredDimensions: dimensions,
			...inspectionExpectationProperties,
		}),
		execute: async (_id, params, signal) => {
			const locator = workspaceLocator(cwd, params.path);
			if (Boolean(params.consistentWithPath) !== Boolean(params.consistentWithMediaType)) throw new Error("consistentWithPath and consistentWithMediaType must be supplied together");
			const expectation = {
				...(params.requiredText ? { requiredText: params.requiredText } : {}),
				...(params.requiredSourceText ? { requiredSourceText: params.requiredSourceText } : {}),
				...(params.requiredSourceVisiblePairs ? { requiredSourceVisiblePairs: params.requiredSourceVisiblePairs } : {}),
				...(params.minimumTextChars !== undefined ? { minimumTextChars: params.minimumTextChars } : {}),
				...(params.minimumExternalUrls !== undefined ? { minimumExternalUrls: params.minimumExternalUrls } : {}),
				...(params.maximumExternalUrls !== undefined ? { maximumExternalUrls: params.maximumExternalUrls } : {}),
				...(params.consistentWithPath && params.consistentWithMediaType ? { consistentWith: { locator: workspaceLocator(cwd, params.consistentWithPath), mediaType: params.consistentWithMediaType } } : {}),
			};
			const result = await runtime.inspect(locator, params.mediaType, params.requiredDimensions, Object.keys(expectation).length ? expectation : undefined, signal);
			const externalUrls = artifactExternalUrls(result.checks);
			return { content: [{ type: "text" as const, text: `Inspected and verified ${result.observation.locator.uri} (${result.observation.mediaType}, ${result.observation.byteLength} bytes, sha256:${result.observation.sha256}) across ${result.checks.map((check) => check.dimension).join(", ")}${externalUrls.length ? `; external citation URLs: ${JSON.stringify(externalUrls)}` : ""}` }], details: { ...result, ...(externalUrls.length ? { externalUrls } : {}) } };
		},
	}), { ...READ_ONLY_TOOL_POLICY, impact: "Reads and independently verifies one existing workspace Artifact" }), {
		aliases: ["artifact_observe", "inspect_workspace_artifact", "html_verify", "pdf_inspect"],
		triggers: ["html 内容与渲染", "检查 html", "验证 html", "检查 pdf", "pdf 可解析", "页面渲染", "文件完整性", "现存文件", "href 去重", "唯一外部 url", "外部 url 数量", "external url count", "count href links", "existing artifact"],
		beemaxToolSpec: { kind: "tool" as const, version: "1", configured: runtime.verifiers.length > 0, health: runtime.verifiers.length > 0 ? "ready" as const : "configuration_required" as const, ranking: { inputModalities: ["file", "text/html", "application/pdf"], outputModalities: ["structured"], freshness: "current" as const, evidence: "verified" as const } },
	});
	return [render, verify, inspect];
}

function artifactExternalUrls(checks: readonly ArtifactVerificationCheck[]): string[] {
	const urls = new Set<string>();
	for (const ref of checks.flatMap((check) => check.evidenceRefs)) {
		if (!ref.startsWith("artifact:external-url:")) continue;
		try {
			const url = new URL(ref.slice("artifact:external-url:".length));
			if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) continue;
			url.hash = "";
			urls.add(url.href);
		} catch { /* Ignore malformed verifier metadata. */ }
	}
	return [...urls].sort();
}

function validateAuthorities(providers: readonly ArtifactProviderPort[], verifiers: readonly ArtifactVerifierPort[]): void {
	const providerIds = new Set<string>();
	for (const provider of providers) {
		const id = boundedIdentifier(provider.descriptor.id, "Provider id");
		if (providerIds.has(id)) throw new Error(`Duplicate Artifact Provider id: ${id}`);
		providerIds.add(id);
		boundedIdentifier(provider.descriptor.version, "Provider version");
		if (!provider.descriptor.operations.length) throw new Error(`Artifact Provider ${id} declares no operations`);
	}
	const verifierIds = new Set<string>();
	for (const verifier of verifiers) {
		const id = boundedIdentifier(verifier.descriptor.id, "Verifier id");
		if (verifierIds.has(id)) throw new Error(`Duplicate Artifact Verifier id: ${id}`);
		verifierIds.add(id);
		boundedIdentifier(verifier.descriptor.version, "Verifier version");
		if (!verifier.descriptor.mediaTypes.length || !verifier.descriptor.dimensions.length) throw new Error(`Artifact Verifier ${id} declares no coverage`);
		for (const dimension of verifier.descriptor.dimensions) if (!ARTIFACT_DIMENSIONS.has(dimension)) throw new Error(`Unknown Artifact verification dimension: ${dimension}`);
	}
}

function normalizeProduceRequest(request: ArtifactProduceRequest): ArtifactProduceRequest {
	const expectation = normalizeExpectation(request.expectation);
	return {
		operation: boundedIdentifier(request.operation, "Artifact operation", 64), input: normalizeLocator(request.input), inputMediaType: normalizeMediaType(request.inputMediaType),
		output: normalizeLocator(request.output), outputMediaType: normalizeMediaType(request.outputMediaType), requiredDimensions: normalizeDimensionsForExpectation(request.requiredDimensions, expectation), ...(request.signal ? { signal: request.signal } : {}),
		...(Object.keys(expectation).length ? { expectation } : {}),
	};
}

function normalizeDimensions(value: readonly ArtifactVerificationDimension[]): ArtifactVerificationDimension[] {
	if (!Array.isArray(value) || !value.length || value.length > 8) throw new Error("Artifact verification dimensions must contain 1 to 8 values");
	const dimensions = value.map((dimension) => {
		if (!ARTIFACT_DIMENSIONS.has(dimension)) throw new Error(`Unknown Artifact verification dimension: ${String(dimension)}`);
		return dimension;
	});
	if (new Set(dimensions).size !== dimensions.length) throw new Error("Artifact verification dimensions must be unique");
	return dimensions;
}

function normalizeDimensionsForExpectation(value: readonly ArtifactVerificationDimension[], expectation: Readonly<ArtifactVerificationExpectation>): ArtifactVerificationDimension[] {
	const dimensions = normalizeDimensions(value);
	if ((expectation.requiredText?.length || expectation.requiredSourceText?.length || expectation.requiredSourceVisiblePairs?.length || expectation.minimumTextChars !== undefined || expectation.minimumExternalUrls !== undefined || expectation.maximumExternalUrls !== undefined) && !dimensions.includes("semantic")) dimensions.push("semantic");
	if (expectation.consistentWith && !dimensions.includes("consistency")) dimensions.push("consistency");
	return dimensions;
}

function normalizeObservation(value: ArtifactObservation, locator: ArtifactLocator, mediaType: string): ArtifactObservation {
	if (!value || typeof value !== "object") throw new Error("Artifact Verifier returned no observation");
	const observedLocator = normalizeLocator(value.locator);
	if (!sameLocator(observedLocator, locator) || normalizeMediaType(value.mediaType) !== mediaType) throw new Error("Artifact Verifier observed a different locator or media type");
	if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || value.byteLength > MAX_ARTIFACT_BYTES) throw new Error("Artifact byte length is invalid");
	const sha256 = normalizeSha256(value.sha256);
	return { locator: observedLocator, mediaType, byteLength: value.byteLength, sha256 };
}

function normalizeChecks(value: readonly ArtifactVerificationCheck[], expected: readonly ArtifactVerificationDimension[]): ArtifactVerificationCheck[] {
	if (!Array.isArray(value) || value.length !== expected.length) throw new Error("Artifact Verifier returned incomplete checks");
	const byDimension = new Map<ArtifactVerificationDimension, ArtifactVerificationCheck>();
	for (const candidate of value) {
		if (!candidate || !ARTIFACT_DIMENSIONS.has(candidate.dimension) || !ARTIFACT_STATUSES.has(candidate.status) || byDimension.has(candidate.dimension)) throw new Error("Artifact Verifier returned invalid checks");
		const evidenceRefs = normalizeRefs(candidate.evidenceRefs, 32);
		const message = candidate.message?.trim().slice(0, 1000);
		byDimension.set(candidate.dimension, Object.freeze({ dimension: candidate.dimension, status: candidate.status, evidenceRefs, ...(message ? { message } : {}) }));
	}
	if (expected.some((dimension) => !byDimension.has(dimension))) throw new Error("Artifact Verifier returned checks for unrequested dimensions");
	return expected.map((dimension) => byDimension.get(dimension)!);
}

function buildReceipt(manifest: Readonly<ArtifactManifest>, expectation: Readonly<ArtifactVerificationExpectation>, verification: { checks: ArtifactVerificationCheck[]; verifiers: Array<{ id: string; version: string }> }, verifiedAt: number): Readonly<ArtifactVerificationReceipt> {
	const unsigned = { schemaVersion: ARTIFACT_VERIFICATION_SCHEMA_VERSION, artifactId: manifest.id, artifactSha256: manifest.sha256, expectationSha256: sha256Json(expectation), verifiedAt, verifiers: verification.verifiers, checks: verification.checks };
	const receipt: ArtifactVerificationReceipt = { ...unsigned, id: `artifact-verification:sha256:${sha256Json(unsigned)}` };
	return validateArtifactVerificationReceipt(receipt, manifest);
}

function normalizeExpectation(value: ArtifactVerificationExpectation | undefined): Readonly<ArtifactVerificationExpectation> {
	if (!value) return Object.freeze({});
	const normalizeAssertions = (assertions: readonly string[] | undefined) => assertions?.map((text) => {
		const normalized = text?.trim();
		if (!normalized || normalized.length > 1000 || /[\0]/.test(normalized)) throw new Error("Artifact semantic expectation text is invalid");
		return normalized;
	});
	const requiredText = normalizeAssertions(value.requiredText);
	const requiredSourceText = normalizeAssertions(value.requiredSourceText);
	const requiredSourceVisiblePairs = value.requiredSourceVisiblePairs?.map((pair) => {
		if (!pair || typeof pair !== "object") throw new Error("Artifact source-visible expectation pair is invalid");
		const [sourceText] = normalizeAssertions([pair.sourceText])!;
		const [visibleText] = normalizeAssertions([pair.visibleText])!;
		return { sourceText, visibleText };
	});
	if (requiredText && requiredText.length > 100) throw new Error("Artifact semantic expectations exceed the maximum count");
	if (requiredSourceText && requiredSourceText.length > 100) throw new Error("Artifact source expectations exceed the maximum count");
	if (requiredSourceVisiblePairs && requiredSourceVisiblePairs.length > 100) throw new Error("Artifact source-visible expectations exceed the maximum count");
	const minimumTextChars = value.minimumTextChars;
	if (minimumTextChars !== undefined && (!Number.isSafeInteger(minimumTextChars) || minimumTextChars < 0 || minimumTextChars > 1_000_000)) throw new Error("Artifact minimum text expectation is invalid");
	const minimumExternalUrls = value.minimumExternalUrls;
	const maximumExternalUrls = value.maximumExternalUrls;
	if (minimumExternalUrls !== undefined && (!Number.isSafeInteger(minimumExternalUrls) || minimumExternalUrls < 0 || minimumExternalUrls > 10_000)) throw new Error("Artifact minimum external URL count is invalid");
	if (maximumExternalUrls !== undefined && (!Number.isSafeInteger(maximumExternalUrls) || maximumExternalUrls < 0 || maximumExternalUrls > 10_000)) throw new Error("Artifact maximum external URL count is invalid");
	if (minimumExternalUrls !== undefined && maximumExternalUrls !== undefined && minimumExternalUrls > maximumExternalUrls) throw new Error("Artifact minimum external URL count cannot exceed maximum external URL count");
	return deepFreeze({
		...(requiredText?.length ? { requiredText } : {}), ...(requiredSourceText?.length ? { requiredSourceText } : {}), ...(requiredSourceVisiblePairs?.length ? { requiredSourceVisiblePairs } : {}), ...(minimumTextChars !== undefined ? { minimumTextChars } : {}),
		...(minimumExternalUrls !== undefined ? { minimumExternalUrls } : {}), ...(maximumExternalUrls !== undefined ? { maximumExternalUrls } : {}),
		...(value.consistentWith ? { consistentWith: { locator: normalizeLocator(value.consistentWith.locator), mediaType: normalizeMediaType(value.consistentWith.mediaType) } } : {}),
	});
}

export function validateArtifactManifest(value: Readonly<ArtifactManifest>): Readonly<ArtifactManifest> {
	if (!value || value.schemaVersion !== ARTIFACT_MANIFEST_SCHEMA_VERSION) throw new Error("Artifact Manifest schema is invalid");
	const sha256 = normalizeSha256(value.sha256);
	if (value.id !== `artifact:sha256:${sha256}`) throw new Error("Artifact Manifest id does not match its digest");
	if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || value.byteLength > MAX_ARTIFACT_BYTES) throw new Error("Artifact Manifest byte length is invalid");
	const manifest: ArtifactManifest = {
		schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION, id: value.id, locator: normalizeLocator(value.locator), mediaType: normalizeMediaType(value.mediaType), byteLength: value.byteLength, sha256,
		producer: { providerId: boundedIdentifier(value.producer?.providerId, "Provider id"), providerVersion: boundedIdentifier(value.producer?.providerVersion, "Provider version"), operation: boundedIdentifier(value.producer?.operation, "Artifact operation", 64) },
		sourceRefs: normalizeRefs(value.sourceRefs), createdAt: boundedTimestamp(value.createdAt, "Artifact creation time"),
	};
	return freezeManifest(manifest);
}

export function validateArtifactVerificationReceipt(value: Readonly<ArtifactVerificationReceipt>, manifest?: Readonly<ArtifactManifest>): Readonly<ArtifactVerificationReceipt> {
	if (!value || value.schemaVersion !== ARTIFACT_VERIFICATION_SCHEMA_VERSION) throw new Error("Artifact Verification Receipt schema is invalid");
	const artifactSha256 = normalizeSha256(value.artifactSha256);
	const artifactId = `artifact:sha256:${artifactSha256}` as const;
	if (value.artifactId !== artifactId || manifest && (manifest.id !== artifactId || manifest.sha256 !== artifactSha256)) throw new Error("Artifact Verification Receipt content identity is invalid");
	const expectationSha256 = normalizeSha256(value.expectationSha256);
	const verifiedAt = boundedTimestamp(value.verifiedAt, "Artifact verification time");
	if (!Array.isArray(value.verifiers) || !value.verifiers.length || value.verifiers.length > 20) throw new Error("Artifact Verification Receipt verifiers are invalid");
	const verifierIds = new Set<string>();
	const verifiers = value.verifiers.map((verifier) => {
		const id = boundedIdentifier(verifier?.id, "Verifier id");
		if (verifierIds.has(id)) throw new Error("Artifact Verification Receipt verifier identities must be unique");
		verifierIds.add(id);
		return { id, version: boundedIdentifier(verifier?.version, "Verifier version") };
	});
	if (!Array.isArray(value.checks) || !value.checks.length) throw new Error("Artifact Verification Receipt checks are invalid");
	const dimensions = value.checks.map((check) => check?.dimension);
	const checks = normalizeChecks(value.checks, normalizeDimensions(dimensions));
	const unsigned = { schemaVersion: ARTIFACT_VERIFICATION_SCHEMA_VERSION, artifactId, artifactSha256, expectationSha256, verifiedAt, verifiers, checks };
	const id = `artifact-verification:sha256:${sha256Json(unsigned)}` as const;
	if (value.id !== id) throw new Error("Artifact Verification Receipt id does not match its content");
	return deepFreeze({ ...unsigned, id });
}

export function validateSourceReceipt(value: Readonly<SourceReceipt>): Readonly<SourceReceipt> {
	if (!value || value.schemaVersion !== SOURCE_RECEIPT_SCHEMA_VERSION) throw new Error("Source Receipt schema is invalid");
	const unsigned = normalizeSourceReceiptUnsigned(value);
	const id = `source-receipt:sha256:${sha256Json(unsigned)}` as const;
	if (value.id !== id) throw new Error("Source Receipt id does not match its content");
	return deepFreeze({ ...unsigned, id });
}

function normalizeSourceReceiptUnsigned(value: SourceReceiptInput): Omit<SourceReceipt, "id"> {
	const capability = boundedIdentifier(value.capability, "Source Receipt capability", 128);
	const subject = value.subject?.trim();
	if (!subject || subject.length > 2_000 || /[\0]/u.test(subject)) throw new Error("Source Receipt subject is invalid");
	const sourceRefs = normalizeRefs(value.sourceRefs);
	if (!sourceRefs.length) throw new Error("Source Receipt requires at least one source reference");
	let serialized: string | undefined;
	try { serialized = JSON.stringify(value.payload); } catch { throw new Error("Source Receipt payload must be JSON serializable"); }
	if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_SOURCE_RECEIPT_PAYLOAD_BYTES) throw new Error("Source Receipt payload is empty or oversized");
	let payload: unknown;
	try { payload = JSON.parse(serialized); } catch { throw new Error("Source Receipt payload is invalid JSON"); }
	return {
		schemaVersion: SOURCE_RECEIPT_SCHEMA_VERSION,
		capability,
		subject,
		observedAt: boundedTimestamp(value.observedAt, "Source observation time"),
		sourceRefs,
		payload,
	};
}

function freezeManifest(value: ArtifactManifest): Readonly<ArtifactManifest> { return deepFreeze(value); }

function normalizeLocator(value: ArtifactLocator): ArtifactLocator {
	if (!value || !["workspace", "url", "reference"].includes(value.kind)) throw new Error("Artifact locator kind is invalid");
	const uri = value.uri?.trim();
	if (!uri || uri.length > 4096 || /[\r\n\0]/.test(uri)) throw new Error("Artifact locator URI is invalid");
	return Object.freeze({ kind: value.kind, uri });
}

function normalizeRefs(value: readonly string[] | undefined, limit = 64): readonly string[] {
	if (value === undefined) return Object.freeze([]);
	if (!Array.isArray(value) || value.length > limit) throw new Error("Artifact evidence references are invalid");
	const refs = value.map((ref) => {
		const normalized = ref?.trim();
		if (!normalized || normalized.length > 2048 || /[\r\n\0]/.test(normalized)) throw new Error("Artifact evidence reference is invalid");
		return normalized;
	});
	return Object.freeze(refs);
}

function normalizeMediaType(value: string): string {
	const mediaType = value?.trim().toLowerCase();
	if (!mediaType || mediaType.length > 128 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[ a-z0-9!#$&^_.+;=-]+)?$/.test(mediaType)) throw new Error("Artifact media type is invalid");
	return mediaType;
}

function boundedIdentifier(value: string | undefined, label: string, max = 128): string {
	const normalized = value?.trim();
	if (!normalized || normalized.length > max || /[\r\n\0]/.test(normalized)) throw new Error(`${label} is invalid`);
	return normalized;
}

function boundedTimestamp(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
	return value;
}

function normalizeSha256(value: string): string {
	const normalized = value?.trim().toLowerCase();
	if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error("Artifact SHA-256 is invalid");
	return normalized;
}

function workspaceLocator(cwd: string, input: string): ArtifactLocator {
	const path = resolve(cwd, input);
	const rel = relative(cwd, path);
	if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Artifact path is outside the configured workspace");
	return Object.freeze({ kind: "workspace", uri: `workspace:${rel.replaceAll("\\", "/") || "."}` });
}

function workspaceLocatorFromUri(cwd: string, uri: string): ArtifactLocator {
	const value = uri.startsWith("workspace:") ? uri.slice("workspace:".length) : uri;
	if (!value || (!uri.startsWith("workspace:") && /^[a-z][a-z0-9+.-]*:/i.test(uri))) throw new Error("Workspace Artifact locator is invalid");
	return workspaceLocator(cwd, value);
}

function sameLocator(left: ArtifactLocator, right: ArtifactLocator): boolean { return left.kind === right.kind && left.uri === right.uri; }
function sha256Json(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new Error("Artifact operation was cancelled"); }

function deepFreeze<T>(value: T): T {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const nested of Object.values(value)) deepFreeze(nested);
	return Object.freeze(value);
}
