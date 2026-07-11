import test from "node:test";
import assert from "node:assert/strict";
import { INTERACTION_COMMANDS, interactionCommandHelp, parseInteractionCommand } from "../dist/index.js";

test("interaction command grammar is surface-neutral and complete", () => {
	assert.deepEqual(parseInteractionCommand("/history 12"), { kind: "history", limit: 12 });
	assert.deepEqual(parseInteractionCommand("/resume local-123"), { kind: "resume", sessionId: "local-123" });
	assert.deepEqual(parseInteractionCommand("/think high"), { kind: "think", level: "high" });
	assert.deepEqual(parseInteractionCommand("/details expanded"), { kind: "details", mode: "expanded" });
	assert.equal(parseInteractionCommand("hello"), undefined);
	assert.equal(INTERACTION_COMMANDS.some((command) => command.name === "stop"), true);
	assert.match(interactionCommandHelp(), /\/stop/);
});
