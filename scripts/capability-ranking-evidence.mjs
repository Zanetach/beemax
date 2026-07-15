import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const LIVE_CAPABILITY_EVIDENCE_SOURCES = Object.freeze([
	"packages/core/src/capability-runtime.ts",
	"packages/core/src/capability-ranking.ts",
	"packages/core/src/capability-ranking-evaluation.ts",
	"packages/core/src/capability-calibration.ts",
	"packages/core/src/execution-trace.ts",
	"packages/core/src/skill-tools.ts",
	"packages/core/src/tool-runtime.ts",
	"packages/core/src/tool-spec-plan.ts",
	"packages/core/src/web-tools.ts",
	"packages/core/src/agent-runtime.ts",
	"packages/core/src/runtime.ts",
	"pi/packages/coding-agent/src/core/settings-manager.ts",
	"pi/packages/coding-agent/src/core/sdk.ts",
	"pi/packages/agent/src/agent-loop.ts",
	"pi/packages/agent/src/types.ts",
	"pi/packages/ai/src/types.ts",
	"apps/cli/src/agent-factory.ts",
	"apps/cli/src/model-catalog.ts",
	"apps/cli/src/config.ts",
	"apps/cli/src/gateway.ts",
	"apps/cli/src/gateway-observability.ts",
	"apps/cli/src/cli.ts",
	"evals/capability-ranking-corpus.mjs",
	"scripts/capability-ranking-evidence.mjs",
	"scripts/capability-outcome-harness.mjs",
	"scripts/pi-capability-outcome-harness.mjs",
	"scripts/evaluate-live-capability-ranking.mjs",
	"scripts/verify-live-capability-evidence.mjs",
	"package.json",
	"package-lock.json",
]);

export async function liveCapabilityImplementationDigest(root = process.cwd()) {
	const hash = createHash("sha256");
	for (const path of LIVE_CAPABILITY_EVIDENCE_SOURCES) {
		hash.update(path); hash.update("\0"); hash.update(await readFile(resolve(root, path))); hash.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}
