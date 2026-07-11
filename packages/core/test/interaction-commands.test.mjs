import test from "node:test";
import assert from "node:assert/strict";
import { INTERACTION_COMMANDS, interactionCommandHelp, parseInteractionCommand } from "../dist/index.js";

test("interaction command grammar is surface-neutral and complete", () => {
	assert.deepEqual(parseInteractionCommand("/history 12"), { kind: "history", limit: 12 });
	assert.deepEqual(parseInteractionCommand("/resume local-123"), { kind: "resume", sessionId: "local-123" });
	assert.deepEqual(parseInteractionCommand("/think high"), { kind: "think", level: "high" });
	assert.deepEqual(parseInteractionCommand("/details expanded"), { kind: "details", mode: "expanded" });
	assert.deepEqual(parseInteractionCommand("/models gpt"), { kind: "models", query: "gpt" });
	assert.deepEqual(parseInteractionCommand("/sessions local"), { kind: "sessions", query: "local" });
	assert.deepEqual(parseInteractionCommand("/steer focus on tests"), { kind: "steer", text: "focus on tests" });
	assert.deepEqual(parseInteractionCommand("/tasks retry plan-123"), { kind: "tasks", action: "retry", planId: "plan-123" });
	assert.equal(parseInteractionCommand("hello"), undefined);
	assert.equal(INTERACTION_COMMANDS.some((command) => command.name === "stop"), true);
	assert.equal(INTERACTION_COMMANDS.some((command) => command.name === "steer"), true);
	assert.match(interactionCommandHelp(), /\/stop/);
});
