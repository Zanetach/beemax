import test from "node:test";
import assert from "node:assert/strict";
import { fullScreenEnter, fullScreenExit, resolveChatPresentationMode } from "../dist/chat-mode.js";

test("chat presentation selects one adaptive mode without changing the command surface", () => {
	assert.equal(resolveChatPresentationMode({ isInputTty: true, isOutputTty: true, term: "xterm-256color" }), "full");
	assert.equal(resolveChatPresentationMode({ isInputTty: true, isOutputTty: true, noAltScreen: true }), "compact");
	assert.equal(resolveChatPresentationMode({ isInputTty: true, isOutputTty: true, plain: true }), "plain");
	assert.equal(resolveChatPresentationMode({ isInputTty: false, isOutputTty: true }), "plain");
	assert.equal(resolveChatPresentationMode({ isInputTty: true, isOutputTty: true, compact: true, full: true }), "full");
	assert.equal(resolveChatPresentationMode({ isInputTty: true, isOutputTty: true, full: true, noAltScreen: true }), "compact");
	assert.equal(fullScreenEnter("BeeMax Chat"), "\x1b[?1049h\x1b[H\x1b[2JBeeMax Chat\n\n");
	assert.equal(fullScreenExit(), "\x1b[?1049l");
});
