import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const LIVE_ADAPTIVE_ADMISSION_EVIDENCE_SOURCES = Object.freeze([
	"packages/core/src/agent-runtime.ts",
	"packages/core/src/index.ts",
	"packages/core/src/autonomous-planning.ts",
	"packages/core/src/execution-trace.ts",
	"packages/core/src/turn-understanding.ts",
	"packages/core/src/work-contract.ts",
	"packages/core/src/runtime.ts",
	"packages/core/dist/agent-runtime.js",
	"packages/core/dist/index.js",
	"packages/core/dist/autonomous-planning.js",
	"packages/core/dist/execution-trace.js",
	"packages/core/dist/turn-understanding.js",
	"packages/core/dist/work-contract.js",
	"packages/core/dist/runtime.js",
	"apps/cli/src/config.ts",
	"apps/cli/src/model-catalog.ts",
	"apps/cli/src/runtime-composition.ts",
	"apps/cli/src/cli.ts",
	"apps/cli/src/gateway.ts",
	"apps/cli/dist/config.js",
	"apps/cli/dist/model-catalog.js",
	"apps/cli/dist/runtime-composition.js",
	"apps/cli/dist/cli.js",
	"apps/cli/dist/gateway.js",
	"pi/packages/ai/src/compat.ts",
	"pi/packages/ai/dist/compat.js",
	"packages/core/test/contract-driven-planning.test.mjs",
	"packages/core/test/model-first-turn.test.mjs",
	"evals/adaptive-turn-admission-corpus.mjs",
	"scripts/adaptive-turn-admission-evidence.mjs",
	"scripts/evaluate-live-adaptive-turn-admission.mjs",
	"scripts/verify-live-adaptive-turn-admission.mjs",
	"package.json",
	"package-lock.json",
]);

export async function liveAdaptiveAdmissionImplementationDigest(root = process.cwd()) {
	const hash = createHash("sha256");
	for (const path of LIVE_ADAPTIVE_ADMISSION_EVIDENCE_SOURCES) {
		hash.update(path); hash.update("\0"); hash.update(await readFile(resolve(root, path))); hash.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}
