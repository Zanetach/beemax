import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryScopeResolver } from "../dist/memory-membership.js";

test("trusted memory membership resolves canonical users and fails closed", () => {
	const resolve = createMemoryScopeResolver([{ platform: "feishu", userId: "union-1", projectId: "project-a", organizationId: "org-a" }]);
	assert.deepEqual(resolve({ platform: "feishu", chatId: "chat", chatType: "group", userId: "open-1", userIdAlt: "union-1" }), { projectId: "project-a", organizationId: "org-a" });
	assert.deepEqual(resolve({ platform: "feishu", chatId: "chat", chatType: "group", userId: "unknown" }), {});
	assert.deepEqual(resolve({ platform: "discord", chatId: "chat", chatType: "group", userId: "union-1" }), {});
});

test("trusted memory membership rejects ambiguous or empty grants", () => {
	assert.throws(() => createMemoryScopeResolver([{ platform: "feishu", userId: "u" }]), /no project or organization/);
	assert.throws(() => createMemoryScopeResolver([{ platform: "feishu", userId: "u", projectId: "a" }, { platform: "feishu", userId: "u", projectId: "b" }]), /Duplicate/);
});
