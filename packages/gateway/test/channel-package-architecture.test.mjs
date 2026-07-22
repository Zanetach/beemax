import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../../..");

test("Channel Runtime builds independently of Gateway and messaging platform SDKs", async () => {
	const runtime = JSON.parse(await readFile(join(root, "packages/channel-runtime/package.json"), "utf8"));
	assert.equal(runtime.name, "@thruvera/channel-runtime");
	assert.equal(runtime.dependencies?.["@thruvera/gateway"], undefined);
	assert.equal(runtime.dependencies?.["@larksuiteoapi/node-sdk"], undefined);
	const sources = await sourceText(join(root, "packages/channel-runtime/src"));
	assert.doesNotMatch(sources, /@thruvera\/(?:gateway|channel-feishu|channel-telegram)|@larksuiteoapi\/node-sdk/u);
	assert.doesNotMatch(sources, /\b(?:sendCard|updateCard|asCard)\b/u);
});

test("Interaction Gateway does not publish or depend on messaging platform implementations", async () => {
	const gateway = JSON.parse(await readFile(join(root, "packages/gateway/package.json"), "utf8"));
	assert.equal(gateway.dependencies?.["@larksuiteoapi/node-sdk"], undefined);
	assert.equal(gateway.dependencies?.["@thruvera/channel-feishu"], undefined);
	assert.equal(gateway.dependencies?.["@thruvera/channel-telegram"], undefined);
	const sources = await sourceText(join(root, "packages/gateway/src"));
	assert.doesNotMatch(sources, /@larksuiteoapi\/node-sdk|platforms\/(?:feishu|telegram)|@thruvera\/channel-(?:feishu|telegram)/u);
	assert.doesNotMatch(sources, /\b(?:CardSession|renderCard|FlushController)\b/u);
	const gatewayEntries = await readdir(join(root, "packages/gateway/src"), { withFileTypes: true });
	assert.equal(gatewayEntries.some((entry) => entry.isDirectory() && entry.name === "card"), false);
});

test("Platform presentation is owned by its Adapter package behind the Channel Runtime contract", async () => {
	const runtime = await sourceText(join(root, "packages/channel-runtime/src"));
	assert.match(runtime, /interface InteractionPresenter/u);
	assert.match(runtime, /readonly presentation\?: InteractionPresenter/u);

	const feishu = await sourceText(join(root, "packages/channel-feishu/src"));
	assert.match(feishu, /class FeishuInteractionPresenter implements InteractionPresenter/u);
	assert.match(feishu, /class CardSession/u);
	assert.match(feishu, /function renderCard/u);
});

async function sourceText(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const parts = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) parts.push(await sourceText(path));
		else if (entry.isFile() && entry.name.endsWith(".ts")) parts.push(await readFile(path, "utf8"));
	}
	return parts.join("\n");
}
