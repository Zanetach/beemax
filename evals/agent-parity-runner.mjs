export async function runAgentParityCorpus({ corpus, system, environment, executeCase, timeoutMs = 10 * 60_000, onCase }) {
	if (!corpus?.cases?.length) throw new Error("Agent parity runner requires a non-empty corpus");
	if (typeof executeCase !== "function") throw new Error("Agent parity runner requires an executeCase adapter");
	const boundedTimeout = Math.max(100, Math.min(Math.trunc(timeoutMs), 60 * 60_000));
	const cases = [];
	for (const scenario of corpus.cases) {
		const controller = new AbortController();
		let timer;
		let abortGraceTimer;
		const startedAt = performance.now();
		try {
			const result = await Promise.race([
				Promise.resolve(executeCase(scenario, controller.signal)),
				new Promise((_, reject) => { timer = setTimeout(() => {
					controller.abort(new Error(`Agent parity case ${scenario.id} timed out`));
					abortGraceTimer = setTimeout(() => reject(controller.signal.reason), 5_000);
				}, boundedTimeout); }),
			]);
			cases.push({ id: scenario.id, ...result });
		} catch (error) {
			cases.push(failedCase(scenario.id, Math.max(0, performance.now() - startedAt), error));
		} finally {
			if (timer) clearTimeout(timer);
			if (abortGraceTimer) clearTimeout(abortGraceTimer);
		}
		onCase?.(cases.at(-1), cases.length, corpus.cases.length);
	}
	return {
		schemaVersion: 1,
		system: { ...system },
		corpus: { version: corpus.version, seed: corpus.seed },
		environment: { ...environment },
		cases,
	};
}

function failedCase(id, durationMs, error) {
	return {
		id,
		status: "failed",
		durationMs,
		inputTokens: 0,
		outputTokens: 0,
		toolCalls: [],
		evidenceKinds: [],
		userInterventions: 0,
		duplicateEffects: null,
		objectiveDegraded: null,
		outcomeVerified: false,
		recovered: false,
		error: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
	};
}
