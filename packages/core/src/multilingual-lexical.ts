/** Deterministic zero-dependency lexical normalization shared by routing and memory fallback search. */
export function multilingualLexicalTerms(input: string): string[] {
	const raw = input.normalize("NFKC").toLocaleLowerCase().match(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu) ?? [];
	const terms = raw.flatMap((term) => {
		if (/^\p{Script=Han}+$/u.test(term)) {
			if (term.length <= 2) return [term];
			return Array.from({ length: term.length - 1 }, (_, index) => term.slice(index, index + 2));
		}
		if (/^[a-z]+$/i.test(term) && term.length > 4) return [term.replace(/(?:ies|ing|ed|es|s)$/i, (suffix) => suffix.toLowerCase() === "ies" ? "y" : "")];
		return [term];
	});
	return [...new Set(terms.filter(Boolean))];
}
