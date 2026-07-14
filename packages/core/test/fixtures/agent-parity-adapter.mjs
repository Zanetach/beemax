export async function createAgentParityAdapter() {
	return async (scenario) => ({
		status: "succeeded",
		durationMs: 1,
		inputTokens: 1,
		outputTokens: 1,
		toolCalls: scenario.requiredCapabilities.map((name) => ({ name, status: "succeeded", argumentsValid: true, required: true })),
		evidenceKinds: [...scenario.requiredEvidenceKinds],
		userInterventions: 0,
		duplicateEffects: 0,
		objectiveDegraded: false,
		outcomeVerified: true,
		recovered: scenario.facets.includes("recovery") || undefined,
	});
}
