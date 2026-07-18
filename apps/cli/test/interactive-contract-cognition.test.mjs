import assert from "node:assert/strict";
import test from "node:test";
import { createInteractiveContractCognition } from "../dist/interactive-contract-cognition.js";

test("interactive composition admits intent once and does not gate Pi on an OpenWorld reviewer", () => {
	const cognition = createInteractiveContractCognition([{ model: {
		id: "test-model",
		provider: "test",
		api: "test",
		name: "test-model",
		contextWindow: 16_000,
		maxTokens: 8_192,
	} }]);

	assert.equal(typeof cognition.workContractBuilder.build, "function");
	assert.equal("openWorldContractCompiler" in cognition, false);
});
