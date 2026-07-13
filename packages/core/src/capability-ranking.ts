import { multilingualLexicalTerms } from "./multilingual-lexical.ts";

export interface RankableCapability {
	name: string; description?: string; aliases?: readonly string[]; triggers?: readonly string[]; exclude?: readonly string[]; priority?: number;
}
export interface CapabilityRank<T> { item: T; score: number; confidence: number; reason: string; }

/** One calibrated lexical rank contract shared by Tool, MCP, and Skill metadata. */
export function rankCapabilityIndex<T extends RankableCapability>(query: string, items: readonly T[], limit: number): Array<CapabilityRank<T>> {
	const normalized = query.normalize("NFKC").toLocaleLowerCase();
	const terms = multilingualLexicalTerms(normalized);
	return items.flatMap((item): Array<CapabilityRank<T>> => {
		const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase();
		if (item.exclude?.some((term) => normalized.includes(normalize(term)))) return [];
		const name = normalize(item.name); const aliases = item.aliases ?? []; const triggers = item.triggers ?? [];
		const haystack = [item.name, item.description ?? "", ...aliases, ...triggers].join(" ").normalize("NFKC").toLocaleLowerCase();
		const triggerHits = triggers.filter((term) => normalized.includes(normalize(term))).length;
		const aliasHits = aliases.filter((term) => normalized.includes(normalize(term))).length;
		const termHits = terms.filter((term) => haystack.includes(term)).length;
		const score = (normalized === name ? 100 : normalized.includes(name) ? 40 : 0) + triggerHits * 60 + aliasHits * 50 + termHits * 5;
		if (!score) return [];
		return [{ item, score, confidence: Math.min(1, score / 100), reason: triggerHits ? `matched ${triggerHits} trigger(s)` : aliasHits ? `matched ${aliasHits} alias(es)` : `matched ${termHits} lexical term(s)` }];
	}).sort((left, right) => right.score - left.score || (left.item.priority ?? 1_000) - (right.item.priority ?? 1_000) || left.item.name.localeCompare(right.item.name)).slice(0, Math.max(1, Math.min(limit, 100)));
}
