import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialVault } from "../dist/index.js";

const key = Buffer.alloc(32, 7);

test("Credential Vault persists an encrypted Secret behind an owner-scoped Credential Ref", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-credential-vault-"));
	const path = join(root, "credentials.vault");
	try {
		const events = [];
		const first = new FileCredentialVault(path, key, (event) => events.push(event));
		const credential = first.put({ ownerKey: "profile:personal", label: "Example account", purpose: "example.com login", secret: "correct-horse-battery-staple" }, 10);
		assert.match(credential.ref, /^cred_[a-f0-9-]+$/);
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.doesNotMatch(readFileSync(path, "utf8"), /correct-horse|Example account|example\.com/);

		const reopened = new FileCredentialVault(path, key, (event) => events.push(event));
		const injected = await reopened.withSecret("profile:personal", credential.ref, "browser.login", async (secret) => `used:${secret}` , 20);
		assert.equal(injected, "used:correct-horse-battery-staple");
		assert.deepEqual(reopened.list("profile:personal"), [{ ...credential, updatedAt: 20, lastUsedAt: 20 }]);
		assert.equal(reopened.list("profile:other").length, 0);
		await assert.rejects(() => reopened.withSecret("profile:other", credential.ref, "browser.login", async () => undefined), /not found/i);
		await assert.rejects(() => reopened.withSecret("profile:other", "secret-in-ref", "browser.login", async () => undefined), /not found/i);
		assert.deepEqual(events.map(({ action, ownerKey, ref }) => ({ action, ownerKey, ref })), [
			{ action: "stored", ownerKey: "profile:personal", ref: credential.ref },
			{ action: "accessed", ownerKey: "profile:personal", ref: credential.ref },
			{ action: "access_denied", ownerKey: "profile:other", ref: credential.ref },
			{ action: "access_denied", ownerKey: "profile:other", ref: "invalid" },
		]);
		assert.doesNotMatch(JSON.stringify(events), /correct-horse|Example account|example\.com|secret-in-ref/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Credential Vault fails closed for a wrong key and invalidates a removed Credential Ref", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-credential-key-"));
	const path = join(root, "credentials.vault");
	try {
		const vault = new FileCredentialVault(path, key);
		const credential = vault.put({ ownerKey: "profile:personal", label: "Account", purpose: "login", secret: "private-value" }, 10);
		assert.throws(() => new FileCredentialVault(path, Buffer.alloc(32, 8)), /decrypt|key|corrupt/i);
		assert.equal(vault.remove("profile:other", credential.ref), false);
		assert.equal(vault.remove("profile:personal", credential.ref), true);
		await assert.rejects(() => vault.withSecret("profile:personal", credential.ref, "login", async () => undefined), /not found/i);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
