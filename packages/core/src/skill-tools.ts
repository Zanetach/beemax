/** Managed instruction-only Skill evolution is Core runtime policy. */
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { resolve, sep } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MUTATING_TOOL_POLICY, READ_ONLY_TOOL_POLICY, withToolPolicy, type ToolPolicy } from "./tool-runtime.ts";
import { assertNoCredentialMaterial, containsCredentialMaterial, redactCredentialMaterial } from "./credential-material.ts";
import { SkillRegistry, SkillRuntime } from "./skill-runtime.ts";
import { rankCapabilityIndex } from "./capability-ranking.ts";
import { CapabilityRuntime, SEMANTIC_CAPABILITY_MINIMUM_SIMILARITY, capabilityDescriptor, capabilityVersionOf, type CapabilityOperationalSignals, type CapabilityRanker } from "./capability-runtime.ts";
import { CapabilityProviderRuntime, attestCapabilityProviderAcquisitionTool, attestCapabilityProviderResolutionTool, type CapabilityProviderAcquisition, type CapabilityProviderDescriptor, type CapabilityProviderResolution } from "./capability-provider.ts";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillTrialAssertion { claim: string; evidence: string; }
export interface SkillTrialToolCall { callId: string; name: string; }
interface SkillCandidateAttempt { id: string; trialId?: string; outcome: "accepted" | "rejected"; evidence: string; assertions?: SkillTrialAssertion[]; toolCalls?: SkillTrialToolCall[]; scenarioHash: string; at: number; }
interface SkillCandidate { version: 1; name: string; description: string; instructions: string; source: string; sha256: string; createdAt: number; attempts: SkillCandidateAttempt[]; signature: string; }
export interface SkillCandidateTrialInput { name: string; description: string; instructions: string; scenario: string; acceptanceCriteria: string; }
export interface SkillCandidateTrialResult { trialId: string; accepted: boolean; evidence: string; assertions: SkillTrialAssertion[]; toolCalls: SkillTrialToolCall[]; }
export type SkillCandidateVerifier = (input: SkillCandidateTrialInput, signal?: AbortSignal) => Promise<SkillCandidateTrialResult>;
export interface SkillCandidatePromotionAuthorityInput { name: string; source: string; sha256: string; acceptedTrialIds: string[]; }
export type SkillCandidatePromotionAuthority = (input: SkillCandidatePromotionAuthorityInput) => Promise<{ allowed: boolean; evidenceRef?: string; reason?: string }>;

interface SkillVersionRecord { version: 1; name: string; description: string; instructions: string; source: string; sha256: string; promotedAt: number; authorityEvidenceRef?: string; signature: string; }
interface SkillVersionEvent { id: string; kind: "promoted" | "rollback"; name: string; fromSha256?: string; toSha256: string; evidenceRef?: string; at: number; signature: string; }

export interface CapabilityMetadata extends Pick<ToolDefinition, "name" | "description"> { parameters?: ToolDefinition["parameters"]; kind?: "tool" | "mcp"; aliases?: readonly string[]; triggers?: readonly string[]; exclude?: readonly string[]; version?: string; providers?: readonly CapabilityProviderDescriptor[]; signals?: CapabilityOperationalSignals; }

type CapabilitySelectionOptions = { requirements?: Array<{ id: string; text: string }>; boundaries?: Array<{ kind: "constraint" | "prohibition"; text: string }>; contractDigest?: string };

export function createSkillTools(agentDir: string, markReloadNeeded: () => void, availableTools: readonly CapabilityMetadata[] = [], verifyCandidate?: SkillCandidateVerifier, additionalSkillRoots: readonly string[] = [], _activateTools?: (names: string[]) => void, capabilityRanker?: CapabilityRanker, promotionAuthority?: SkillCandidatePromotionAuthority, capabilityPreferences?: Readonly<Record<string, number>>, providerRuntime = new CapabilityProviderRuntime()): ToolDefinition[] {
	const root = resolve(agentDir, "skills");
	const candidateRoot = resolve(agentDir, "skill-candidates");
	const versionRoot = resolve(agentDir, "skill-versions");
	const registry = new SkillRegistry([root, ...additionalSkillRoots.map((item) => resolve(item))]);
	const canonicalToolNames = canonicalToolNameResolver(availableTools.filter((tool) => tool.name !== "bash"));
	const runtime = new SkillRuntime(registry, 200_000, 20, [...canonicalToolNames.keys()]);
	const resolveDeclaredTools = (names: readonly string[]) => [...new Set(names.map((name) => canonicalToolNames.get(name) ?? name))];
	// Selection returns proposed activation metadata; BeeMaxAgentRuntime is the
	// sole authority that compiles it into the next Pi Tool Spec Plan.
	const capabilities = new CapabilityRuntime({ ...(capabilityRanker ? { ranker: capabilityRanker } : {}) });
	const markSkillsChanged = () => { registry.invalidate(); runtime.reset(); markReloadNeeded(); };
	const selectAvailableCapabilities = async (query: string, limit: number, signal?: AbortSignal, options?: CapabilitySelectionOptions, excludedToolNames: ReadonlySet<string> = new Set()) => {
		const eligibleTools = availableTools.filter((tool) => tool.name !== "bash" && !excludedToolNames.has(tool.name));
		const skillInventory = await registry.list();
		const inventory = [
			...eligibleTools.map((tool) => capabilityDescriptor({ kind: tool.kind ?? "tool", name: tool.name, description: tool.description, aliases: tool.aliases, triggers: tool.triggers, exclude: tool.exclude, version: tool.version ?? stableCapabilityMetadataVersion(tool), activeTools: [tool.name], ...(tool.signals ? { signals: tool.providers?.length ? { ...tool.signals, health: "unknown" } : tool.signals } : {}) })),
			...skillInventory.map((skill) => {
				const profilePreference = capabilityPreferences?.[`skill:${skill.name}`] ?? capabilityPreferences?.[skill.name];
				return capabilityDescriptor({ kind: "skill", name: skill.name, description: skill.description, triggers: skill.triggers, exclude: skill.exclude, version: `sha256:${skill.sha256}`, activeTools: ["skill_activate", "skill_read"], signals: { inputModalities: ["text"], outputModalities: ["text"], freshness: "unknown", evidence: "unknown", health: "ready", ...(profilePreference !== undefined ? { profilePreference } : {}) } });
			}),
		];
		let selection = await capabilities.discover({ query, inventory, limit, ...(signal ? { signal } : {}), ...(options?.requirements ? { requirements: options.requirements } : {}), ...(options?.boundaries?.length ? { boundaries: options.boundaries } : {}), ...(options?.contractDigest ? { contractDigest: options.contractDigest } : {}) });
		// Requirement-bound cognition selects the executable outcome Tools. In the
		// same preflight, progressively add only strongly matched, immutable workflow
		// Skills from local metadata. They remain unbound guidance (never evidence for
		// an unrelated business outcome) but are available before execution starts.
		if (options?.requirements?.length && skillInventory.length) {
			const selectedNames = new Set(selection.candidates.map((candidate) => candidate.name));
			const workflowSkills = (await registry.search(query, 3))
				.filter((match) => match.confidence >= SEMANTIC_CAPABILITY_MINIMUM_SIMILARITY && !selectedNames.has(match.name))
				.flatMap((match) => {
					const descriptor = inventory.find((candidate) => candidate.kind === "skill" && candidate.name === match.name);
					return descriptor ? [{ descriptor, match }] : [];
				});
			if (workflowSkills.length) selection = {
				...selection,
				candidates: [...selection.candidates, ...workflowSkills.map(({ descriptor, match }) => ({
					kind: descriptor.kind, name: descriptor.name, version: descriptor.version,
					score: match.score, confidence: match.confidence,
					explanation: { strategy: "lexical" as const, summary: `workflow Skill metadata: ${match.reason}`, signals: ["workflow_skill_metadata_match", match.reason] },
				}))],
			};
		}
		return { eligibleTools, selection };
	};
	const prefetchCapabilities = async (query: string, signal?: AbortSignal, options?: { explicitSkillName?: string; requirements?: Array<{ id: string; text: string }>; boundaries?: Array<{ kind: "constraint" | "prohibition"; text: string }>; contractDigest?: string }) => {
		if (options?.explicitSkillName) {
			const explicitSkill = (await registry.list()).find((skill) => skill.name === options.explicitSkillName);
			const selectedSkills = await runtime.admitDiscovered(explicitSkill ? [explicitSkill.name] : []);
			const explicitCognitionId = `cap:explicit:${createHash("sha256").update(options.explicitSkillName).digest("hex").slice(0, 32)}`;
			if (!explicitSkill) return { cognitionId: explicitCognitionId, candidates: [], activatedTools: [], skills: [], skillBlocker: { code: "skill_not_installed" as const, name: options.explicitSkillName } };
			const identity = { kind: "skill" as const, name: explicitSkill.name, version: `sha256:${explicitSkill.sha256}`, confidence: 1 };
			if (options.requirements?.length) {
				const { selection } = await selectAvailableCapabilities(query, 10, signal, options);
				const selectedCandidates = selection.candidates.filter((candidate) => candidate.kind !== "skill" || candidate.name === explicitSkill.name);
				const proposalCandidates = selectedCandidates.map(({ kind, name, version, confidence, requirementId, outcomeIndex, necessity }) => ({ kind, name, version, confidence, ...(requirementId ? { requirementId, outcomeIndex, necessity } : {}) }));
				if (!proposalCandidates.some((candidate) => candidate.kind === "skill" && candidate.name === explicitSkill.name)) proposalCandidates.push(identity);
				const { selectedToolNames, providerResolutions } = await resolveSelectedToolProviders(selectedCandidates, signal);
				const blockedTools = new Set(providerResolutions.filter((resolution) => resolution.status === "blocked").map((resolution) => resolution.capability));
				const canAcquire = providerResolutions.some((resolution) => resolution.status === "blocked" && resolution.candidates.some((candidate) => !candidate.installed && candidate.installable));
				return {
					cognitionId: selection.cognitionId,
					candidates: proposalCandidates,
					activatedTools: [...new Set([...selectedToolNames.filter((name) => !blockedTools.has(name)), ...(canAcquire ? ["capability_acquire"] : []), "skill_activate", "skill_read"])],
					skills: selectedSkills.map(publicSkill),
					providerResolutions: publicProviderResolutions(providerResolutions),
				};
			}
			return {
				cognitionId: explicitCognitionId,
				candidates: [identity],
				activatedTools: ["skill_activate", "skill_read"],
				skills: selectedSkills.map(publicSkill),
			};
		}
		const { selection, selectedToolNames, providerResolutions } = await selectCapabilitiesWithProviderFallback(query, 10, signal, options);
		const selectedSkillNames = selection.candidates.filter((item) => item.kind === "skill" && item.confidence >= SEMANTIC_CAPABILITY_MINIMUM_SIMILARITY).map((item) => item.name);
		const selectedSkills = await runtime.admitDiscovered(selectedSkillNames);
		const blockedTools = new Set(providerResolutions.filter((resolution) => resolution.status === "blocked").map((resolution) => resolution.capability));
		const canAcquire = providerResolutions.some((resolution) => resolution.status === "blocked" && resolution.candidates.some((candidate) => !candidate.installed && candidate.installable));
		const candidateToolNames = new Set(selection.candidates.filter((candidate) => candidate.kind !== "skill").map((candidate) => candidate.name));
		const activatedTools = [...new Set([...selectedToolNames.filter((name) => !blockedTools.has(name)), ...selection.activatedTools.filter((name) => !candidateToolNames.has(name) && name !== "skill_activate" && name !== "skill_read"), ...(canAcquire ? ["capability_acquire"] : []), ...(selectedSkillNames.length ? ["skill_activate", "skill_read"] : [])])];
		return {
			cognitionId: selection.cognitionId,
			candidates: selection.candidates.map(({ kind, name, version, confidence, requirementId, outcomeIndex, necessity }) => ({ kind, name, version, confidence, ...(requirementId ? { requirementId, outcomeIndex, necessity } : {}) })),
			activatedTools,
			skills: selectedSkills.map(publicSkill),
			providerResolutions: publicProviderResolutions(providerResolutions),
		};
	};
	const resolveToolProviders = async (toolNames: readonly string[], signal?: AbortSignal) => Promise.all(availableTools
		.filter((tool) => toolNames.includes(tool.name) && tool.providers?.length)
		.map((tool) => providerRuntime.resolve({ capability: tool.name, providers: tool.providers!, ...(signal ? { signal } : {}) })));
	const resolveSelectedToolProviders = async (candidates: ReadonlyArray<{ kind: "tool" | "mcp" | "skill"; name: string; requirementId?: string; outcomeIndex?: number; necessity?: "required" | "alternative" }>, signal?: AbortSignal) => {
		const executable = candidates.filter((candidate) => candidate.kind !== "skill");
		const resolutions = await resolveToolProviders(executable.map(({ name }) => name), signal);
		const resolutionByName = new Map(resolutions.map((resolution) => [resolution.capability, resolution]));
		const groups = new Map<string, typeof executable>();
		for (const candidate of executable) {
			const groupId = candidate.requirementId ? `${candidate.requirementId}:${candidate.outcomeIndex ?? 0}` : `candidate:${candidate.kind}:${candidate.name}`;
			groups.set(groupId, [...(groups.get(groupId) ?? []), candidate]);
		}
		const selectedToolNames: string[] = [];
		const selectedResolutions: CapabilityProviderResolution[] = [];
		for (const group of groups.values()) {
			const required = group.filter((candidate) => candidate.necessity !== "alternative");
			const alternatives = group.filter((candidate) => candidate.necessity === "alternative");
			const ready = (candidate: typeof group[number]) => !availableTools.find((tool) => tool.name === candidate.name)?.providers?.length || resolutionByName.get(candidate.name)?.status === "ready";
			const installable = (candidate: typeof group[number]) => resolutionByName.get(candidate.name)?.candidates.some((provider) => !provider.installed && provider.installable);
			// A semantically required capability with a pre-authorized install path is
			// stronger than a merely ready fallback. Use the fallback only when the
			// primary cannot be made ready autonomously.
			const selected = required.find(ready) ?? required.find(installable) ?? alternatives.find(ready) ?? alternatives.find(installable) ?? required[0] ?? alternatives[0];
			if (!selected) continue;
			selectedToolNames.push(selected.name);
			const resolution = resolutionByName.get(selected.name);
			if (resolution) selectedResolutions.push(resolution);
		}
		return { selectedToolNames: [...new Set(selectedToolNames)], providerResolutions: selectedResolutions };
	};
	const selectCapabilitiesWithProviderFallback = async (query: string, limit: number, signal?: AbortSignal, options?: CapabilitySelectionOptions) => {
		let selected = await selectAvailableCapabilities(query, limit, signal, options);
		let providers = await resolveSelectedToolProviders(selected.selection.candidates, signal);
		const excluded = new Set<string>();
		// Probe only the semantically selected Provider set. When that exact route is
		// non-installably blocked, preserve every Core requirement id and perform one
		// bounded re-selection without the unavailable implementation.
		const blocked = providers.providerResolutions.filter((resolution) => resolution.status === "blocked"
			&& !resolution.candidates.some((candidate) => !candidate.installed && candidate.installable));
		if (!blocked.length) return { ...selected, ...providers };
		for (const resolution of blocked) excluded.add(resolution.capability);
		const alternative = await selectAvailableCapabilities(query, limit, signal, options, excluded);
		const coversRequirements = !options?.requirements?.length || options.requirements.every(({ id }) => alternative.selection.candidates.some((candidate) => candidate.requirementId === id && candidate.necessity === "required"));
		if (!coversRequirements || !alternative.selection.candidates.length) return { ...selected, ...providers };
		const alternativeProviders = await resolveSelectedToolProviders(alternative.selection.candidates, signal);
		selected = alternative;
		providers = alternativeProviders;
		return { ...selected, ...providers };
	};
	const publicProviderResolutions = (resolutions: Awaited<ReturnType<typeof resolveToolProviders>>) => resolutions.map(publicProviderResolution);
	let signingKeyPromise: Promise<Buffer> | undefined;
	const signingKey = () => signingKeyPromise ??= skillLearningKey(agentDir);
	const tools = [
		attestCapabilityProviderResolutionTool(Object.assign(defineTool({ name: "capability_discover", label: "Discover Capabilities", description: "Search the tools, active Skills, and isolated Skill candidates actually available in this Profile before concluding a capability is missing.", parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 500 }) }), execute: async (_id, params, signal) => {
			const existingKey = await readSkillLearningKey(agentDir);
			const candidates = existingKey ? await listCandidates(candidateRoot, existingKey) : [];
			const matches = <T extends CapabilityMetadata>(items: T[]) => rankCapabilities(params.query, items, 20);
			const { eligibleTools, selection, selectedToolNames, providerResolutions } = await selectCapabilitiesWithProviderFallback(params.query, 10, signal);
			const selectedSkillNames = selection.candidates.filter((item) => item.kind === "skill" && item.confidence >= SEMANTIC_CAPABILITY_MINIMUM_SIMILARITY).map((item) => item.name);
			const selectedSkills = await runtime.admitDiscovered(selectedSkillNames);
			const candidateToolNames = new Set(selection.candidates.filter((item) => item.kind !== "skill").map((item) => item.name));
			const matchedTools = eligibleTools.filter((tool) => candidateToolNames.has(tool.name)).sort((left, right) => selection.candidates.findIndex((item) => item.name === left.name) - selection.candidates.findIndex((item) => item.name === right.name));
			const publicTools = matchedTools.map(({ name, description }) => ({ name, description }));
			const publicSkills = selectedSkills.map(publicSkill);
			const publicProviders = providerResolutions.flatMap((resolution) => resolution.candidates);
			const blockedTools = new Set(providerResolutions.filter((resolution) => resolution.status === "blocked").map((resolution) => resolution.capability));
			const canAcquire = providerResolutions.some((resolution) => resolution.status === "blocked" && resolution.candidates.some((candidate) => !candidate.installed && candidate.installable));
			const activatedTools = [...new Set([...selectedToolNames.filter((name) => !blockedTools.has(name)), ...selection.activatedTools.filter((name) => !candidateToolNames.has(name) && (selectedSkillNames.length || (name !== "skill_activate" && name !== "skill_read"))), ...(canAcquire ? ["capability_acquire"] : [])])];
			const resolutionByCapability = new Map(providerResolutions.map((resolution) => [resolution.capability, resolution]));
			const activatedToolNames = new Set(activatedTools);
			const modelVisible = [
				"Capability discovery results (use these exact names):",
				...publicSkills.map((skill) => `- skill: ${skill.name} — ${skill.description}`),
				...matchedTools.map((tool) => {
					const resolution = resolutionByCapability.get(tool.name);
					const state = activatedToolNames.has(tool.name) ? "active" : resolution?.status === "blocked" ? "unavailable" : "candidate; not active";
					return `- ${tool.kind === "mcp" ? "mcp" : "tool"}: ${tool.name} [${state}] — ${tool.description}${resolution?.status === "blocked" ? `; ${resolution.blocker?.reason ?? "Provider is unavailable"}` : ""}`;
				}),
				...publicProviders.map((provider) => `- provider: ${provider.id}: ${provider.health.status}${provider.health.reason ? ` — ${provider.health.reason}` : ""}`),
				...(canAcquire ? ["A matching Provider can be acquired with capability_acquire after its installation authority is verified."] : []),
				...(activatedTools.length ? [`Activated for the next turn: ${activatedTools.join(", ")}. Call only exact Tool names marked active or listed in this activation set.`] : publicSkills.length || publicTools.length ? ["Candidates matched, but none is active. Do not call an unavailable or inactive Tool."] : ["No active Skill, Tool, or MCP capability matched this query."]),
			].join("\n");
			return result(modelVisible, {
				cognitionId: selection.cognitionId,
				tools: publicTools,
				skills: publicSkills,
				ranked: selection.candidates.map((item) => ({ ...item, reason: item.explanation.summary })),
				candidates: matches(candidates.map((item) => ({ name: item.name, description: item.description, attempts: item.attempts.length }))),
				providers: publicProviders,
				providerResolutions: publicProviderResolutions(providerResolutions),
				activatedTools,
			});
		} }), { beemaxCapabilityPrefetch: prefetchCapabilities })),
		attestCapabilityProviderAcquisitionTool(defineTool({ name: "capability_acquire", label: "Acquire Capability Provider", description: "Install only an exact capability reported as installable by the immediately preceding capability_discover result. Never invent a capability name or use this for an installed/local Tool; discover those first. Installation requires trusted authority and verified Provider health before activation.", parameters: Type.Object({ capability: Type.String({ pattern: "^[a-z0-9][a-z0-9._:-]{0,127}$" }) }), execute: async (_id, params, signal) => {
			const capability = availableTools.find((tool) => tool.name === params.capability);
			const acquisition = await providerRuntime.acquire({ capability: params.capability, providers: capability?.providers ?? [], ...(signal ? { signal } : {}) });
			const visible = publicProviderAcquisition(acquisition);
			const text = acquisition.status === "ready"
				? `Provider ${acquisition.selected!.id} is healthy for ${acquisition.capability}; resume the unchanged Objective with ${acquisition.capability}.`
				: `Capability ${acquisition.capability} remains unavailable (${acquisition.blocker!.code}): ${acquisition.blocker!.reason}${acquisition.blocker!.requiredConfiguration.length ? `; required configuration: ${acquisition.blocker!.requiredConfiguration.join(", ")}` : ""}`;
			return result(text, { providerAcquisition: visible, activatedTools: acquisition.status === "ready" ? [acquisition.capability] : [] }, acquisition.status !== "ready");
		} })),
		defineTool({ name: "skill_list", label: "List Skills", description: "List metadata for Profile, project, and global Skills without loading their instruction bodies.", parameters: Type.Object({}), execute: async () => {
			const skills = await registry.list(); return result(skills.length ? skills.map((item) => `- ${item.name}: ${item.description}`).join("\n") : "No Skills available.", { skills: skills.map(publicSkill) });
		} }),
		defineTool({ name: "skill_activate", label: "Activate Skill", description: "Load one discovered Skill's global rules and route table, locking its SHA256 for this execution.", parameters: Type.Object({ name: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }) }), execute: async (toolCallId, params) => {
			const activated = await runtime.activate(params.name); const state = runtime.snapshot(); const routeSummary = activated.routes.map((route) => `${route.name}${route.description ? ` — ${route.description}` : ""}`).join(", ");
			const status = state.state === "module_loaded" || state.state === "executing"
				? `Skill route ${state.route ?? "legacy"} is already loaded; follow the rules below and call skill_complete when finished.`
				: `Available Skill routes: ${routeSummary || "none"}. Select one exact route with skill_route before loading its module.`;
			return ephemeralResult(`${status}\n\n${modelSafeSkillText(activated.instructions)}`, { descriptor: publicSkill(activated.descriptor), routes: activated.routes, state, activatedTools: state.state === "module_loaded" || state.state === "executing" ? ["skill_complete"] : ["skill_route", "skill_complete"], skillLifecycleReceipt: skillLifecycleReceipt(activated.descriptor.name, activated.descriptor.sha256, "activated", "skill_activate", toolCallId) });
		} }),
		attestCapabilityProviderResolutionTool(defineTool({ name: "skill_route", label: "Route Skill", description: "Select one declared module route after Skill activation.", parameters: Type.Object({ route: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }) }), execute: async (toolCallId, params) => {
			const routed = await runtime.routeTo(params.route); const snapshot = runtime.snapshot(); const routedTools = resolveDeclaredTools(routed.tools); const providerResolutions = await resolveToolProviders(routedTools); return result(`Selected Skill route ${routed.route}.`, { ...routed, declaredTools: routed.tools, tools: routedTools, state: snapshot, activatedTools: ["skill_resource_read", "skill_complete", ...routedTools], providerResolutions: publicProviderResolutions(providerResolutions), skillLifecycleReceipt: skillLifecycleReceipt(snapshot.skill!, snapshot.sha256!, "routed", "skill_route", toolCallId) });
		} })),
		defineTool({ name: "skill_resource_read", label: "Read Skill Resource", description: "Read one module or reference declared by the active Skill route.", parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 500 }) }), execute: async (toolCallId, params) => {
			const resource = await runtime.readResource(params.path); const snapshot = runtime.snapshot(); return ephemeralResult(modelSafeSkillText(resource.content), { ...resource, content: undefined, state: snapshot, skillLifecycleReceipt: skillLifecycleReceipt(snapshot.skill!, snapshot.sha256!, "resource_read", "skill_resource_read", toolCallId) });
		} }),
		defineTool({ name: "skill_complete", label: "Complete Skill", description: "Complete the turn-scoped Skill execution and retain only its versioned resource summary.", parameters: Type.Object({}), execute: async (toolCallId) => {
			const summary = runtime.complete();
			if (!summary.skill || !summary.sha256) throw new Error("Completed Skill lacks its immutable identity");
			return result(`Completed Skill ${summary.skill}${summary.route ? ` via ${summary.route}` : ""}.`, { ...summary, skillLifecycleReceipt: skillLifecycleReceipt(summary.skill, summary.sha256, "completed", "skill_complete", toolCallId), capabilityReceipt: { id: `receipt:skill:${summary.skill}:${summary.sha256}`, kind: "skill", name: summary.skill, version: `sha256:${summary.sha256}`, sourceTool: "skill_complete" } });
		} }),
		attestCapabilityProviderResolutionTool(defineTool({ name: "skill_read", label: "Read Skill (Compatibility)", description: "Compatibility alias that discovers and activates a Profile, project, or global Skill by name.", parameters: Type.Object({ name: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }) }), execute: async (toolCallId, params) => {
			if (!runtime.isDiscovered(params.name)) await runtime.discover(params.name, 10);
			const activated = await runtime.activate(params.name); const legacy = activated.routes.length === 1 && activated.routes[0]?.name === "legacy";
			let activatedTools: string[];
			let providerResolutions: Awaited<ReturnType<typeof resolveToolProviders>> = [];
			let sourceDeclaredTools: string[] = [];
			if (legacy) { const routed = await runtime.routeTo("legacy"); runtime.useActivatedInstructionsAsModule(); sourceDeclaredTools = routed.tools; const routedTools = resolveDeclaredTools(routed.tools); activatedTools = ["skill_complete", ...routedTools]; providerResolutions = await resolveToolProviders(routedTools); }
			else activatedTools = ["skill_route", "skill_complete"];
			const declaredTools = legacy ? activatedTools.filter((name) => name !== "skill_complete") : [];
			return ephemeralResult(modelSafeSkillText(activated.instructions), { descriptor: publicSkill(activated.descriptor), routes: activated.routes, state: runtime.snapshot(), legacy, declaredTools, ...(sourceDeclaredTools.length ? { sourceDeclaredTools } : {}), activatedTools, providerResolutions: publicProviderResolutions(providerResolutions), skillLifecycleReceipt: skillLifecycleReceipt(activated.descriptor.name, activated.descriptor.sha256, "read", "skill_read", toolCallId) });
		} })),
		defineTool({ name: "skill_create", label: "Create Skill", description: "Create a durable instruction-only Agent Skill after a workflow proves reusable. Requires approval. Never put credentials in skills.", parameters: Type.Object({ name: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 }), description: Type.String({ minLength: 10, maxLength: 1024 }), instructions: Type.String({ minLength: 20, maxLength: 30_000 }) }), execute: async (_id, params) => {
			assertSafeCandidate({ ...params, source: "direct Skill creation" });
			const path = skillPath(root, params.name); await mkdir(resolve(path, ".."), { recursive: true });
			try { await readFile(path, "utf8"); throw new Error(`Skill ${params.name} already exists; use skill_update`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			await writeFile(path, renderSkill(params), { encoding: "utf8", flag: "wx" });
			const version = skillVersionOf({ ...params, source: "direct Skill creation", sha256: createHash("sha256").update(params.instructions.trim()).digest("hex") });
			await persistSkillVersion(versionRoot, version, await signingKey());
			await recordSkillVersionEvent(versionRoot, { id: crypto.randomUUID(), kind: "promoted", name: params.name, toSha256: version.sha256, evidenceRef: "approved:direct-skill-creation", at: Date.now(), signature: "" }, await signingKey());
			markSkillsChanged(); return result(`Created and queued skill ${params.name} for hot reload after this turn.`, { name: params.name, path, sha256: version.sha256 });
		} }),
		defineTool({ name: "skill_update", label: "Update Skill", description: "Replace a managed instruction-only Agent Skill after learning a better verified workflow. Requires approval.", parameters: Type.Object({ name: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 }), description: Type.String({ minLength: 10, maxLength: 1024 }), instructions: Type.String({ minLength: 20, maxLength: 30_000 }) }), execute: async (_id, params) => {
			assertSafeCandidate({ ...params, source: "direct Skill update" });
			const path = skillPath(root, params.name); const previous = await activeSkillVersion(path, params.name); if (!previous) throw new Error(`Skill ${params.name} is not active`);
			const key = await signingKey(); await persistSkillVersion(versionRoot, previous, key);
			const version = skillVersionOf({ ...params, source: "direct Skill update", sha256: createHash("sha256").update(params.instructions.trim()).digest("hex") });
			await persistSkillVersion(versionRoot, version, key); await writeTextAtomic(path, renderSkill(params));
			await recordSkillVersionEvent(versionRoot, { id: crypto.randomUUID(), kind: "promoted", name: params.name, fromSha256: previous.sha256, toSha256: version.sha256, evidenceRef: "approved:direct-skill-update", at: Date.now(), signature: "" }, key);
			markSkillsChanged(); return result(`Updated and queued skill ${params.name} for hot reload after this turn.`, { name: params.name, path, sha256: version.sha256 });
		} }),
		defineTool({ name: "skill_candidate_install", label: "Install Skill Candidate", description: "Safely stage an instruction-only Skill candidate in quarantine. Does not execute code or affect active Agent behavior.", parameters: Type.Object({ name: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 }), description: Type.String({ minLength: 10, maxLength: 1024 }), instructions: Type.String({ minLength: 20, maxLength: 30_000 }), source: Type.String({ minLength: 1, maxLength: 2_000 }) }), execute: async (_id, params) => {
			assertSafeCandidate(params);
			const path = candidatePath(candidateRoot, params.name);
			await mkdir(candidateRoot, { recursive: true });
			try { await readFile(path, "utf8"); throw new Error(`Skill candidate ${params.name} already exists`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			const candidate = sealCandidate(candidateOf(params), await signingKey());
			await writeJsonAtomic(path, candidate, true);
			return result(`Installed ${params.name} into isolated candidate storage; it is not active.`, candidateSummary(candidate));
		} }),
		defineTool({ name: "skill_candidate_verify", label: "Verify Skill Candidate", description: "Run a candidate in an independent read-only verifier. A rejection remains isolated and resets the promotion threshold.", parameters: Type.Object({ name: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 }), scenario: Type.String({ minLength: 10, maxLength: 5_000 }), acceptanceCriteria: Type.String({ minLength: 10, maxLength: 2_000 }) }), execute: async (_id, params, signal) => {
			if (!verifyCandidate) throw new Error("Independent Skill candidate verification is unavailable");
			return withCandidateLock(candidateRoot, params.name, async () => {
				const path = candidatePath(candidateRoot, params.name);
				const key = await signingKey();
				const candidate = await readCandidate(path, key);
				const scenarioHash = normalizedEvidence(params.scenario);
				if (candidate.attempts.some((attempt) => attempt.scenarioHash === scenarioHash)) throw new Error("Skill candidate trials require a distinct scenario");
				const verdict = await verifyCandidate({ name: candidate.name, description: candidate.description, instructions: candidate.instructions, scenario: params.scenario, acceptanceCriteria: params.acceptanceCriteria }, signal);
				if (!verdict.trialId.trim()) throw new Error("Independent Skill verification did not return a trial identity");
				if (verdict.evidence.trim().length < 20) throw new Error("Independent Skill verification did not return sufficient observable evidence");
				if (verdict.accepted && !validAssertions(verdict.assertions)) throw new Error("Accepted Skill verification did not return structured observable assertions");
				assertNoCredentialMaterial(verdict.evidence, "Skill candidate verification evidence");
				for (const assertion of verdict.assertions) { assertNoCredentialMaterial(assertion.claim, "Skill trial assertion"); assertNoCredentialMaterial(assertion.evidence, "Skill trial assertion evidence"); }
				const outcome = verdict.accepted ? "accepted" as const : "rejected" as const;
				candidate.attempts = [...candidate.attempts, { id: crypto.randomUUID(), trialId: verdict.trialId.trim().slice(0, 256), outcome, evidence: verdict.evidence.trim().slice(0, 5_000), assertions: verdict.assertions.slice(0, 10), toolCalls: verdict.toolCalls.slice(0, 50), scenarioHash, at: Date.now() }].slice(-20);
				await writeJsonAtomic(path, sealCandidate(candidate, key));
				return result(`Independent verifier recorded ${outcome} for ${params.name}.`, candidateSummary(candidate));
			});
		} }),
		defineTool({ name: "skill_candidate_promote", label: "Promote Skill Candidate", description: "Promote a quarantined instruction-only candidate after at least two independent consecutive successful trials. Requires approval.", parameters: Type.Object({ name: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 }) }), execute: async (_id, params) => withCandidateLock(candidateRoot, params.name, async () => {
			const candidateFile = candidatePath(candidateRoot, params.name);
			const candidate = await readCandidate(candidateFile, await signingKey());
			const consecutive = consecutiveAccepted(candidate.attempts);
			if (consecutive < 2) throw new Error(`Skill candidate ${params.name} needs two consecutive accepted trials after its most recent rejection; current=${consecutive}`);
			const acceptedTrialIds = candidate.attempts.slice(-consecutive).map((attempt) => attempt.trialId!).filter(Boolean);
			let authorityEvidenceRef: string | undefined;
			if (candidate.source.startsWith("workflow-candidate:")) {
				if (!promotionAuthority) throw new Error("Workflow Skill promotion authority is unavailable");
				const authority = await promotionAuthority({ name: candidate.name, source: candidate.source, sha256: candidate.sha256, acceptedTrialIds });
				if (!authority.allowed) throw new Error(authority.reason ?? "Workflow Skill promotion was denied by its authority");
				if (!authority.evidenceRef?.trim()) throw new Error("Workflow Skill promotion authority did not provide evidence");
				authorityEvidenceRef = authority.evidenceRef.trim().slice(0, 1_000);
				assertNoCredentialMaterial(authorityEvidenceRef, "Skill promotion authority evidence");
			}
			const path = skillPath(root, params.name);
			await mkdir(resolve(path, ".."), { recursive: true });
			const previous = await activeSkillVersion(path, params.name);
			if (previous) await persistSkillVersion(versionRoot, previous, await signingKey());
			const promoted = skillVersionOf(candidate, authorityEvidenceRef);
			await persistSkillVersion(versionRoot, promoted, await signingKey());
			await writeTextAtomic(path, renderSkill(candidate));
			await recordSkillVersionEvent(versionRoot, { id: crypto.randomUUID(), kind: "promoted", name: params.name, ...(previous ? { fromSha256: previous.sha256 } : {}), toSha256: promoted.sha256, ...(authorityEvidenceRef ? { evidenceRef: authorityEvidenceRef } : {}), at: Date.now(), signature: "" }, await signingKey());
			await unlink(candidateFile).catch(() => undefined);
			markSkillsChanged();
			return result(`Promoted and queued verified skill ${params.name} for Profile-scoped gray rollout after this turn.`, { name: params.name, path, verifiedTrials: consecutive, sha256: promoted.sha256, ...(authorityEvidenceRef ? { authorityEvidenceRef } : {}) });
		}) }),
		defineTool({ name: "skill_versions", label: "List Skill Versions", description: "List immutable managed Skill versions and rollout events without loading their instruction bodies.", parameters: Type.Object({ name: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 }) }), execute: async (_id, params) => {
			const key = await readSkillLearningKey(agentDir);
			const versions = key ? await listSkillVersions(versionRoot, params.name, key) : [];
			const events = key ? await listSkillVersionEvents(versionRoot, params.name, key) : [];
			const active = await activeSkillVersion(skillPath(root, params.name), params.name);
			return result(`Found ${versions.length} immutable versions for ${params.name}.`, { name: params.name, currentSha256: active?.sha256, versions: versions.map(({ instructions: _instructions, signature: _signature, ...version }) => version), events: events.map(({ signature: _signature, ...event }) => event) });
		} }),
		defineTool({ name: "skill_rollback", label: "Rollback Skill", description: "Restore one immutable verified managed Skill version. Requires approval and retains a durable rollback event.", parameters: Type.Object({ name: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 }), sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }) }), execute: async (_id, params) => withCandidateLock(candidateRoot, params.name, async () => {
			const key = await signingKey();
			const target = await readSkillVersion(versionRoot, params.name, params.sha256, key);
			const path = skillPath(root, params.name);
			const current = await activeSkillVersion(path, params.name);
			if (!current) throw new Error(`Skill ${params.name} is not active`);
			await persistSkillVersion(versionRoot, current, key);
			await writeTextAtomic(path, renderSkill(target));
			await recordSkillVersionEvent(versionRoot, { id: crypto.randomUUID(), kind: "rollback", name: params.name, fromSha256: current.sha256, toSha256: target.sha256, at: Date.now(), signature: "" }, key);
			markSkillsChanged();
			return result(`Rolled back ${params.name} to ${target.sha256}.`, { name: params.name, fromSha256: current.sha256, currentSha256: target.sha256 });
		}) }),
	];
	const evolveSkill: ToolPolicy = { ...MUTATING_TOOL_POLICY, sideEffect: "local", risk: "high", reversible: "unknown", impact: "Changes durable instructions that influence future Agent behavior" };
	const policies: Record<string, ToolPolicy> = {
		capability_discover: { ...READ_ONLY_TOOL_POLICY },
		capability_acquire: { ...MUTATING_TOOL_POLICY, sideEffect: "local", risk: "high", approval: "always", reversible: "unknown", maxAttempts: 1, impact: "Installs a versioned Tool or MCP Provider from a trusted catalog after evidence-backed authority" },
		skill_list: { ...READ_ONLY_TOOL_POLICY },
		skill_read: { ...READ_ONLY_TOOL_POLICY },
		skill_activate: { ...READ_ONLY_TOOL_POLICY },
		skill_route: { ...READ_ONLY_TOOL_POLICY },
		skill_resource_read: { ...READ_ONLY_TOOL_POLICY },
		skill_complete: { ...READ_ONLY_TOOL_POLICY },
		skill_create: { ...evolveSkill, reversible: true },
		skill_update: evolveSkill,
		skill_candidate_install: { ...evolveSkill, reversible: true },
		skill_candidate_verify: { ...MUTATING_TOOL_POLICY, sideEffect: "local", risk: "low", approval: "never", reversible: false, impact: "Appends immutable bounded verification evidence in isolated candidate storage" },
		skill_candidate_promote: { ...evolveSkill, reversible: true },
		skill_versions: { ...READ_ONLY_TOOL_POLICY },
		skill_rollback: { ...evolveSkill, reversible: true },
	};
	return tools.map((tool) => Object.assign(withToolPolicy(tool, policies[tool.name]!),
		["skill_activate", "skill_read", "skill_resource_read"].includes(tool.name) ? { persistResultAsSummary: true } : {},
		tool.name === "skill_complete" ? { beemaxTurnReset: () => runtime.reset() } : {}));
}

function canonicalToolNameResolver(tools: readonly CapabilityMetadata[]): Map<string, string> {
	const canonical = new Map(tools.map((tool) => [tool.name, tool.name]));
	const aliasOwners = new Map<string, Set<string>>();
	for (const tool of tools) for (const alias of tool.aliases ?? []) {
		if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(alias)) continue;
		aliasOwners.set(alias, new Set([...(aliasOwners.get(alias) ?? []), tool.name]));
	}
	for (const [alias, owners] of aliasOwners) if (owners.size === 1 && !canonical.has(alias)) canonical.set(alias, [...owners][0]!);
	return canonical;
}

function rankCapabilities<T extends CapabilityMetadata>(query: string, items: readonly T[], limit: number): T[] {
	return rankCapabilityIndex(query, items, limit).map(({ item }) => item);
}

/** Operational health, latency, cost, and Profile preference never change immutable Tool identity. */
function stableCapabilityMetadataVersion(tool: CapabilityMetadata): string {
	return capabilityVersionOf({
		kind: tool.kind ?? "tool", name: tool.name, description: tool.description, parameters: tool.parameters,
		aliases: tool.aliases, triggers: tool.triggers, exclude: tool.exclude,
		...(tool.signals ? { signals: {
			inputModalities: tool.signals.inputModalities, outputModalities: tool.signals.outputModalities,
			freshness: tool.signals.freshness, evidence: tool.signals.evidence, effect: tool.signals.effect,
		} } : {}),
	});
}

async function listCandidates(root: string, key: Buffer): Promise<SkillCandidate[]> {
	let entries; try { entries = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).slice(0, 1_000); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	const candidates: SkillCandidate[] = [];
	let remainingBytes = 8 * 1024 * 1024;
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) try { const candidate = await readCandidate(resolve(root, entry.name), key, Math.min(256 * 1024, remainingBytes)); remainingBytes -= Buffer.byteLength(JSON.stringify(candidate)); candidates.push(candidate); if (remainingBytes <= 0) break; } catch { /* Ignore corrupt quarantined candidates. */ }
	return candidates;
}

function candidateOf(input: { name: string; description: string; instructions: string; source: string }): SkillCandidate {
	const instructions = input.instructions.trim();
	return { version: 1, name: input.name, description: input.description.replace(/[\r\n]+/g, " ").trim(), instructions, source: input.source.trim(), sha256: createHash("sha256").update(instructions).digest("hex"), createdAt: Date.now(), attempts: [], signature: "" };
}

function candidateSummary(candidate: SkillCandidate) { return { name: candidate.name, description: candidate.description, source: candidate.source, sha256: candidate.sha256, attempts: candidate.attempts, consecutiveAccepted: consecutiveAccepted(candidate.attempts), active: false }; }
function normalizedEvidence(value: string): string { return createHash("sha256").update(value.trim().toLowerCase()).digest("hex"); }
function consecutiveAccepted(attempts: SkillCandidateAttempt[]): number { let count = 0; const trials = new Set<string>(); for (let index = attempts.length - 1; index >= 0 && attempts[index]?.outcome === "accepted"; index--) { const attempt = attempts[index]; const trialId = attempt?.trialId; if (!trialId || trials.has(trialId) || !validAssertions(attempt.assertions ?? [])) break; trials.add(trialId); count++; } return count; }
function validAssertions(assertions: readonly SkillTrialAssertion[]): boolean { return assertions.length > 0 && assertions.every((item) => item.claim.trim().length >= 5 && item.evidence.trim().length >= 10); }
function candidatePath(root: string, name: string): string { if (!SKILL_NAME.test(name) || name.length > 64) throw new Error(`Invalid skill name: ${name}`); const path = resolve(root, `${name}.json`); if (!path.startsWith(`${root}${sep}`)) throw new Error("Skill candidate path escaped managed directory"); return path; }
async function withCandidateLock<T>(root: string, name: string, operation: () => Promise<T>): Promise<T> {
	await mkdir(root, { recursive: true }); const lock = resolve(root, `${name}.lock`); const claim = `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`;
	for (let attempt = 0; attempt < 2; attempt++) try { await writeFile(lock, claim, { encoding: "utf8", flag: "wx", mode: 0o600 }); break; } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (attempt || !await staleCandidateLock(lock)) throw new Error(`Skill candidate ${name} is being updated by another process`);
		await unlink(lock).catch(() => undefined);
	}
	try { return await operation(); } finally { await unlink(lock).catch(() => undefined); }
}
async function staleCandidateLock(path: string): Promise<boolean> { try { const [record, info] = await Promise.all([readFile(path, "utf8"), stat(path)]); const parsed = JSON.parse(record) as { pid?: number; at?: number }; if (typeof parsed.pid === "number") try { process.kill(parsed.pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; } return Date.now() - Math.max(info.mtimeMs, parsed.at ?? 0) > 1_000; } catch { return true; } }
async function readCandidate(path: string, key: Buffer, maxBytes = 256 * 1024): Promise<SkillCandidate> { const candidate = JSON.parse(await boundedCandidateRead(path, maxBytes)) as SkillCandidate; const hash = typeof candidate.instructions === "string" ? createHash("sha256").update(candidate.instructions).digest("hex") : ""; if (candidate.version !== 1 || !SKILL_NAME.test(candidate.name) || !Array.isArray(candidate.attempts) || candidate.sha256 !== hash || candidate.signature !== candidateSignature(candidate, key) || candidate.attempts.some((attempt) => !attempt.id || !attempt.scenarioHash || (attempt.outcome !== "accepted" && attempt.outcome !== "rejected") || !attempt.evidence)) throw new Error("Invalid or tampered Skill candidate record"); return candidate; }
async function boundedCandidateRead(path: string, maxBytes: number): Promise<string> { if (maxBytes <= 0) throw new Error("Skill candidate byte budget exceeded"); const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const info = await handle.stat(); if (!info.isFile() || info.size > maxBytes) throw new Error("Skill candidate byte budget exceeded"); const buffer = Buffer.alloc(info.size + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); if (bytesRead > maxBytes) throw new Error("Skill candidate byte budget exceeded"); return buffer.subarray(0, bytesRead).toString("utf8"); } finally { await handle.close(); } }
async function writeJsonAtomic(path: string, value: SkillCandidate, exclusive = false): Promise<void> { const serialized = `${JSON.stringify(value, null, 2)}\n`; const temporary = `${path}.${crypto.randomUUID()}.tmp`; await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 }); try { if (exclusive) await writeFile(path, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 }); else await rename(temporary, path); } finally { await unlink(temporary).catch(() => undefined); } }
async function writeTextAtomic(path: string, value: string): Promise<void> { const temporary = `${path}.${crypto.randomUUID()}.tmp`; await writeFile(temporary, value, { encoding: "utf8", flag: "wx", mode: 0o600 }); try { await rename(temporary, path); } finally { await unlink(temporary).catch(() => undefined); } }

function skillVersionOf(input: { name: string; description: string; instructions: string; source: string; sha256: string }, authorityEvidenceRef?: string): SkillVersionRecord {
	return { version: 1, name: input.name, description: input.description, instructions: input.instructions, source: input.source, sha256: input.sha256, promotedAt: Date.now(), ...(authorityEvidenceRef ? { authorityEvidenceRef } : {}), signature: "" };
}
async function activeSkillVersion(path: string, name: string): Promise<SkillVersionRecord | undefined> {
	try {
		const content = await readFile(path, "utf8");
		const description = content.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, "") ?? "Managed Skill version";
		const instructions = content.replace(/^---[\s\S]*?---\s*/m, "").replace(/^#[^\n]*\n+/, "").trim();
		return skillVersionOf({ name, description, instructions, source: "active-snapshot", sha256: createHash("sha256").update(instructions).digest("hex") });
	} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function versionDirectory(root: string, name: string): string { if (!SKILL_NAME.test(name)) throw new Error(`Invalid skill name: ${name}`); const path = resolve(root, name); if (!path.startsWith(`${root}${sep}`)) throw new Error("Skill version path escaped managed directory"); return path; }
async function persistSkillVersion(root: string, record: SkillVersionRecord, key: Buffer): Promise<void> {
	const directory = versionDirectory(root, record.name); await mkdir(directory, { recursive: true });
	const sealed = sealSkillVersion(record, key); const path = resolve(directory, `${record.sha256}.json`);
	try { await writeFile(path, `${JSON.stringify(sealed, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await readSkillVersion(root, record.name, record.sha256, key); }
}
function sealSkillVersion(record: SkillVersionRecord, key: Buffer): SkillVersionRecord { const unsigned = { ...record, signature: "" }; return { ...unsigned, signature: createHmac("sha256", key).update(JSON.stringify(unsigned)).digest("hex") }; }
async function readSkillVersion(root: string, name: string, sha256: string, key: Buffer): Promise<SkillVersionRecord> {
	if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid Skill version identity");
	const record = JSON.parse(await boundedCandidateRead(resolve(versionDirectory(root, name), `${sha256}.json`), 256 * 1024)) as SkillVersionRecord;
	const sealed = sealSkillVersion(record, key);
	if (record.version !== 1 || record.name !== name || record.sha256 !== sha256 || record.signature !== sealed.signature || createHash("sha256").update(record.instructions).digest("hex") !== sha256) throw new Error("Invalid or tampered Skill version record");
	return record;
}
async function listSkillVersions(root: string, name: string, key: Buffer): Promise<SkillVersionRecord[]> {
	const directory = versionDirectory(root, name); let entries: string[];
	try { entries = (await readdir(directory)).filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	const records: SkillVersionRecord[] = []; for (const entry of entries.slice(0, 1_000)) records.push(await readSkillVersion(root, name, entry.slice(0, -5), key));
	return records.sort((left, right) => left.promotedAt - right.promotedAt);
}
function sealSkillVersionEvent(event: SkillVersionEvent, key: Buffer): SkillVersionEvent { const unsigned = { ...event, signature: "" }; return { ...unsigned, signature: createHmac("sha256", key).update(JSON.stringify(unsigned)).digest("hex") }; }
async function recordSkillVersionEvent(root: string, event: SkillVersionEvent, key: Buffer): Promise<void> { const directory = resolve(versionDirectory(root, event.name), "events"); await mkdir(directory, { recursive: true }); const sealed = sealSkillVersionEvent(event, key); await writeFile(resolve(directory, `${event.at}-${event.id}.json`), `${JSON.stringify(sealed)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
async function listSkillVersionEvents(root: string, name: string, key: Buffer): Promise<SkillVersionEvent[]> { const directory = resolve(versionDirectory(root, name), "events"); let entries: string[]; try { entries = (await readdir(directory)).filter((entry) => entry.endsWith(".json")).sort(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } const events: SkillVersionEvent[] = []; for (const entry of entries.slice(-1_000)) { const event = JSON.parse(await boundedCandidateRead(resolve(directory, entry), 16_000)) as SkillVersionEvent; if (event.name !== name || event.signature !== sealSkillVersionEvent(event, key).signature) throw new Error("Invalid or tampered Skill version event"); events.push(event); } return events; }
function assertSafeCandidate(candidate: { description: string; instructions: string; source: string }): void {
	for (const value of [candidate.description, candidate.instructions, candidate.source]) assertNoCredentialMaterial(value, "Skill candidate");
}
function sealCandidate(candidate: SkillCandidate, key: Buffer): SkillCandidate { const sealed = { ...candidate, signature: "" }; return { ...sealed, signature: candidateSignature(sealed, key) }; }
function candidateSignature(candidate: SkillCandidate, key: Buffer): string { const { signature: _signature, ...record } = candidate; return createHmac("sha256", key).update(JSON.stringify(record)).digest("hex"); }
async function skillLearningKey(agentDir: string): Promise<Buffer> { const state = resolve(agentDir, "state"); const path = resolve(state, "skill-learning.key"); await mkdir(state, { recursive: true }); try { return Buffer.from((await readFile(path, "utf8")).trim(), "hex"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; const key = randomBytes(32); try { await writeFile(path, `${key.toString("hex")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); return key; } catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError; return Buffer.from((await readFile(path, "utf8")).trim(), "hex"); } } }
async function readSkillLearningKey(agentDir: string): Promise<Buffer | undefined> { try { return Buffer.from((await readFile(resolve(agentDir, "state", "skill-learning.key"), "utf8")).trim(), "hex"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
async function listSkills(root: string): Promise<Array<{ name: string; description: string; path: string; sha256: string; managed: boolean }>> {
	let entries: string[]; try { entries = await readdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	const result: Array<{ name: string; description: string; path: string; sha256: string; managed: boolean }> = [];
	for (const name of entries.sort()) { if (!SKILL_NAME.test(name)) continue; try { const path = skillPath(root, name); const content = await readFile(path, "utf8"); result.push({ name, description: content.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "(no description)", path, sha256: createHash("sha256").update(content).digest("hex"), managed: /managed-by:\s*beemax\b/.test(content) }); } catch { /* Ignore incomplete directories. */ } }
	return result;
}
function deduplicateSkills(skills: Array<{ name: string; description: string; path: string; sha256: string; managed: boolean }>) { return [...new Map(skills.map((skill) => [skill.name, skill])).values()]; }
function skillPath(root: string, name: string): string { if (!SKILL_NAME.test(name) || name.length > 64) throw new Error(`Invalid skill name: ${name}`); const path = resolve(root, name, "SKILL.md"); if (!path.startsWith(`${root}${sep}`)) throw new Error("Skill path escaped managed directory"); return path; }
function renderSkill(input: { name: string; description: string; instructions: string }): string { const description = input.description.replace(/[\r\n]+/g, " ").trim(); return `---\nname: ${input.name}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  managed-by: beemax\n---\n\n# ${input.name}\n\n${input.instructions.trim()}\n`; }
function modelSafeSkillText(value: string): string {
	if (!containsCredentialMaterial(value)) return value;
	// Skills may document credential placeholders, but neither placeholders nor
	// real values belong in model context. Redact the complete affected line so
	// the remaining operational rules and route guidance stay usable.
	if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/iu.test(value)) return "[credential-bearing Skill instructions redacted]";
	const sanitized = value.split(/\r?\n/u).map((line) => containsCredentialMaterial(line) ? "[credential-bearing Skill line redacted]" : line).join("\n");
	return containsCredentialMaterial(sanitized) ? "[credential-bearing Skill instructions redacted]" : sanitized;
}
function result(text: string, details: unknown, isError = false) { return { content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) }; }
function publicProviderCandidate(candidate: CapabilityProviderResolution["candidates"][number]) {
	return {
		...candidate,
		health: { ...candidate.health, ...(candidate.health.reason ? { reason: redactCredentialMaterial(candidate.health.reason) } : {}) },
		...(candidate.configuration ? { configuration: { ...candidate.configuration, instructions: redactCredentialMaterial(candidate.configuration.instructions) } } : {}),
	};
}
function publicProviderResolution(resolution: CapabilityProviderResolution) {
	return {
		status: resolution.status,
		capability: resolution.capability,
		...(resolution.selected ? { selected: publicProviderCandidate(resolution.selected) } : {}),
		candidates: resolution.candidates.map(publicProviderCandidate),
		...(resolution.blocker ? { blocker: { ...resolution.blocker, reason: redactCredentialMaterial(resolution.blocker.reason) } } : {}),
	};
}
function publicProviderAcquisition(acquisition: CapabilityProviderAcquisition) {
	return {
		status: acquisition.status,
		capability: acquisition.capability,
		...(acquisition.selected ? { selected: publicProviderCandidate(acquisition.selected) } : {}),
		candidates: acquisition.candidates.map(publicProviderCandidate),
		...(acquisition.blocker ? { blocker: { ...acquisition.blocker, reason: redactCredentialMaterial(acquisition.blocker.reason) } } : {}),
		...(acquisition.installationReceipt ? { installationReceipt: acquisition.installationReceipt } : {}),
		...(acquisition.authorityEvidenceRef ? { authorityEvidenceRef: acquisition.authorityEvidenceRef } : {}),
	};
}
function ephemeralResult(text: string, details: Record<string, unknown>) { return result(text, { ...details, beemaxPersistence: { mode: "summary", text: "[Turn-scoped Skill context omitted; versioned execution metadata retained.]" } }); }
function publicSkill(skill: { name: string; description: string; sha256: string; priority?: number }) { return { name: skill.name, description: skill.description, sha256: skill.sha256, priority: skill.priority }; }
function skillLifecycleReceipt(name: string, sha256: string, phase: "activated" | "routed" | "resource_read" | "read" | "completed", sourceTool: "skill_activate" | "skill_route" | "skill_resource_read" | "skill_read" | "skill_complete", discriminator = "stage") {
	const suffix = createHash("sha256").update(discriminator).digest("hex");
	return { id: `receipt:skill-lifecycle:${phase}:${name}:${sha256}:${suffix}`, name, version: `sha256:${sha256}`, phase, sourceTool };
}
