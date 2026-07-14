export type ProfileBindingPrecedence = "thread" | "conversation" | "account" | "instance";

export interface ProfileBinding {
	id: string;
	profileId: string;
	channelInstanceId: string;
	accountRef?: string;
	conversationId?: string;
	threadId?: string;
	enabled?: boolean;
}

export interface ProfileBindingRoute {
	channelInstanceId: string;
	accountRef?: string;
	conversationId: string;
	threadId?: string;
}

export interface ProfileBindingConflict {
	precedence: ProfileBindingPrecedence;
	selector: string;
	bindingIds: string[];
}

export type ProfileBindingExplanation =
	| { status: "matched"; profileId: string; bindingId: string; precedence: ProfileBindingPrecedence; candidates: string[] }
	| { status: "conflict"; precedence: ProfileBindingPrecedence; candidates: string[] }
	| { status: "unmatched"; candidates: [] };

/** Deterministic, model-independent Channel route to Profile authority. */
export class ProfileBindingResolver {
	private readonly bindings: ProfileBinding[];

	constructor(bindings: readonly ProfileBinding[]) {
		this.bindings = bindings.filter((binding) => binding.enabled !== false).map((binding) => ({ ...binding }));
	}

	validate(): { valid: boolean; conflicts: ProfileBindingConflict[] } {
		const ids = new Set<string>();
		const selectors = new Map<string, { precedence: ProfileBindingPrecedence; selector: string; bindingIds: string[] }>();
		for (const binding of this.bindings) {
			validateBinding(binding);
			if (ids.has(binding.id)) throw new Error(`Duplicate Profile Binding id: ${binding.id}`);
			ids.add(binding.id);
			const precedence = bindingPrecedence(binding);
			const selector = bindingSelector(binding, precedence);
			const key = `${precedence}\0${selector}`;
			const record = selectors.get(key) ?? { precedence, selector, bindingIds: [] };
			record.bindingIds.push(binding.id);
			selectors.set(key, record);
		}
		const conflicts = [...selectors.values()]
			.filter((record) => record.bindingIds.length > 1)
			.map((record) => ({ ...record, bindingIds: [...record.bindingIds].sort() }))
			.sort((left, right) => left.selector.localeCompare(right.selector));
		return { valid: conflicts.length === 0, conflicts };
	}

	resolve(route: ProfileBindingRoute): Extract<ProfileBindingExplanation, { status: "matched" }> {
		const explanation = this.explain(route);
		if (explanation.status === "matched") return explanation;
		if (explanation.status === "conflict") throw new Error(`Profile Binding conflict at ${explanation.precedence}: ${explanation.candidates.join(", ")}`);
		throw new Error(`No Profile Binding matches Channel Instance ${route.channelInstanceId}`);
	}

	explain(route: ProfileBindingRoute): ProfileBindingExplanation {
		if (!route.channelInstanceId.trim() || !route.conversationId.trim()) throw new Error("Profile Binding route requires channelInstanceId and conversationId");
		for (const precedence of ["thread", "conversation", "account", "instance"] as const) {
			const candidates = this.bindings.filter((binding) => bindingPrecedence(binding) === precedence && bindingMatches(binding, route, precedence));
			if (!candidates.length) continue;
			const ids = candidates.map((binding) => binding.id).sort();
			if (candidates.length > 1) return { status: "conflict", precedence, candidates: ids };
			const selected = candidates[0]!;
			return { status: "matched", profileId: selected.profileId, bindingId: selected.id, precedence, candidates: ids };
		}
		return { status: "unmatched", candidates: [] };
	}
}

function validateBinding(binding: ProfileBinding): void {
	if (!binding.id.trim() || !binding.profileId.trim() || !binding.channelInstanceId.trim()) throw new Error("Profile Binding requires id, profileId, and channelInstanceId");
	if (binding.threadId && !binding.conversationId) throw new Error(`Profile Binding ${binding.id} cannot select a thread without a conversation`);
	if (binding.conversationId && binding.accountRef) throw new Error(`Profile Binding ${binding.id} cannot combine account and conversation selectors`);
}

function bindingPrecedence(binding: ProfileBinding): ProfileBindingPrecedence {
	return binding.threadId ? "thread" : binding.conversationId ? "conversation" : binding.accountRef ? "account" : "instance";
}

function bindingSelector(binding: ProfileBinding, precedence: ProfileBindingPrecedence): string {
	const base = binding.channelInstanceId;
	if (precedence === "thread") return `${base}:${binding.conversationId}#${binding.threadId}`;
	if (precedence === "conversation") return `${base}:${binding.conversationId}`;
	if (precedence === "account") return `${base}@${binding.accountRef}`;
	return base;
}

function bindingMatches(binding: ProfileBinding, route: ProfileBindingRoute, precedence: ProfileBindingPrecedence): boolean {
	if (binding.channelInstanceId !== route.channelInstanceId) return false;
	if (precedence === "thread") return binding.conversationId === route.conversationId && binding.threadId === route.threadId;
	if (precedence === "conversation") return binding.conversationId === route.conversationId;
	if (precedence === "account") return binding.accountRef === route.accountRef;
	return true;
}
