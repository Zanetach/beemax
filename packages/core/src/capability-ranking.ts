import { multilingualLexicalTerms } from "./multilingual-lexical.ts";

export interface RankableCapability {
	name: string; description?: string; aliases?: readonly string[]; triggers?: readonly string[]; exclude?: readonly string[]; priority?: number;
}
export interface CapabilityRank<T> { item: T; score: number; confidence: number; reason: string; }

/** Match a canonical Capability identifier as an independent token or phrase.
 * ASCII identifiers use ASCII word boundaries so they remain discoverable next
 * to non-Latin prose without matching inside a larger identifier such as GitHub. */
export function matchesCanonicalCapabilityName(text: string, capabilityName: string): boolean {
	const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase();
	const normalizedText = normalize(text);
	const normalizedName = normalize(capabilityName).trim();
	if (!normalizedName) return false;
	const tokens = normalizedName.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
	if (!tokens.length) return false;
	const phrase = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^\\p{L}\\p{N}]+");
	const identifierCharacters = /[a-z0-9]/u.test(normalizedName) ? "a-z0-9_-" : "\\p{L}\\p{N}_-";
	return new RegExp(`(?:^|[^${identifierCharacters}])${phrase}(?=$|[^${identifierCharacters}])`, "u").test(normalizedText);
}

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
		const nameTermHits = terms.filter((term) => name.includes(term)).length;
		const normalizedNamePhrase = name.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
		const score = (normalized === name || normalized === normalizedNamePhrase ? 100 : matchesCanonicalCapabilityName(normalized, name) ? 40 : 0) + triggerHits * 60 + aliasHits * 50 + nameTermHits * 20 + termHits * 5;
		if (!score) return [];
		return [{ item, score, confidence: Math.min(1, score / 100), reason: triggerHits ? `matched ${triggerHits} trigger(s)` : aliasHits ? `matched ${aliasHits} alias(es)` : `matched ${termHits} lexical term(s)` }];
	}).sort((left, right) => right.score - left.score || (left.item.priority ?? 1_000) - (right.item.priority ?? 1_000) || left.item.name.localeCompare(right.item.name)).slice(0, Math.max(1, Math.min(limit, 100)));
}
