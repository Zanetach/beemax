import assert from "node:assert/strict";
import test from "node:test";
import { ArtifactRuntime, ArtifactVerificationError, createArtifactTools, createSourceReceipt, validateSourceReceipt } from "../dist/index.js";

const digest = "a".repeat(64);
const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };

function acceptedChecks(dimensions) {
	return dimensions.map((dimension) => ({ dimension, status: "accepted", evidenceRefs: [`evidence:${dimension}`] }));
}

function fixtureRuntime(overrides = {}) {
	const provider = overrides.provider ?? {
		descriptor: {
			id: "beemax.chrome-pdf",
			version: "150.0.0",
			operations: [{ operation: "render", inputMediaTypes: ["text/html"], outputMediaTypes: ["application/pdf"] }],
		},
		async produce(request) {
			return {
				locator: request.output,
				mediaType: request.outputMediaType,
				sourceRefs: ["artifact:source-html"],
			};
		},
	};
	const verifier = overrides.verifier ?? {
		descriptor: {
			id: "beemax.artifact-verifier",
			version: "1.0.0",
			mediaTypes: ["text/html", "application/pdf"],
			dimensions: ["existence", "integrity", "semantic", "render", "consistency"],
		},
		async verify(request) {
			return {
				observed: { locator: request.locator, mediaType: request.mediaType, byteLength: 4096, sha256: digest },
				checks: acceptedChecks(request.dimensions),
			};
		},
	};
	return new ArtifactRuntime({ providers: [provider], verifiers: [verifier], now: () => 1_721_000_000_000 });
}

test("Source Receipts are content-addressed, bounded, and independently revalidatable", () => {
	const receipt = createSourceReceipt({
		capability: "market_series",
		subject: "XAU/USD 2026-07-13..2026-07-17",
		observedAt: 1_721_000_000_000,
		sourceRefs: ["https://example.test/xau", "https://example.test/reference"],
		payload: { interval: "daily", points: [{ date: "2026-07-17", close: 3997.4 }] },
	});
	assert.equal(receipt.schemaVersion, "beemax.source-receipt.v1");
	assert.match(receipt.id, /^source-receipt:sha256:[a-f0-9]{64}$/);
	assert.deepEqual(validateSourceReceipt(structuredClone(receipt)), receipt);
	assert.throws(() => validateSourceReceipt({ ...receipt, payload: { interval: "daily", points: [] } }), /id does not match/i);
});

test("Artifact Runtime produces a content-addressed Manifest and independent Verification Receipt", async () => {
	const runtime = fixtureRuntime();
	const result = await runtime.produce({
		operation: "render",
		input: { kind: "workspace", uri: "workspace:report.html" },
		inputMediaType: "text/html",
		output: { kind: "workspace", uri: "workspace:report.pdf" },
		outputMediaType: "application/pdf",
		requiredDimensions: ["existence", "integrity", "semantic", "render", "consistency"],
	});

	assert.equal(result.manifest.schemaVersion, "beemax.artifact-manifest.v1");
	assert.equal(result.manifest.id, `artifact:sha256:${digest}`);
	assert.equal(result.manifest.byteLength, 4096);
	assert.deepEqual(result.manifest.producer, { providerId: "beemax.chrome-pdf", providerVersion: "150.0.0", operation: "render" });
	assert.equal(result.receipt.schemaVersion, "beemax.artifact-verification.v1");
	assert.equal(result.receipt.artifactId, result.manifest.id);
	assert.equal(result.receipt.artifactSha256, digest);
	assert.deepEqual(result.receipt.verifiers, [{ id: "beemax.artifact-verifier", version: "1.0.0" }]);
	assert.deepEqual(result.receipt.checks.map(({ dimension, status }) => ({ dimension, status })), [
		{ dimension: "existence", status: "accepted" },
		{ dimension: "integrity", status: "accepted" },
		{ dimension: "semantic", status: "accepted" },
		{ dimension: "render", status: "accepted" },
		{ dimension: "consistency", status: "accepted" },
	]);
	assert.ok(Object.isFrozen(result.manifest));
	assert.ok(Object.isFrozen(result.receipt));
});

test("Artifact Runtime fails closed when required dimensions are rejected or unavailable", async () => {
	for (const status of ["rejected", "unavailable"]) {
		const runtime = fixtureRuntime({
			verifier: {
				descriptor: { id: "beemax.artifact-verifier", version: "1", mediaTypes: ["application/pdf"], dimensions: ["existence", "integrity", "render"] },
				async verify(request) {
					return {
						observed: { locator: request.locator, mediaType: request.mediaType, byteLength: 100, sha256: digest },
						checks: request.dimensions.map((dimension) => ({ dimension, status: dimension === "render" ? status : "accepted", evidenceRefs: [] })),
					};
				},
			},
		});
		await assert.rejects(() => runtime.produce({
			operation: "render", input: { kind: "workspace", uri: "workspace:in.html" }, inputMediaType: "text/html",
			output: { kind: "workspace", uri: "workspace:out.pdf" }, outputMediaType: "application/pdf",
			requiredDimensions: ["existence", "integrity", "render"],
		}), (error) => {
			assert.ok(error instanceof ArtifactVerificationError);
			assert.match(error.message, new RegExp(`Artifact verification render was ${status}`));
			assert.deepEqual(error.observation, { locator: { kind: "workspace", uri: "workspace:out.pdf" }, mediaType: "application/pdf", byteLength: 100, sha256: digest });
			return true;
		});
	}
});

test("Artifact Runtime rejects unsupported verification coverage before invoking a mutating Provider", async () => {
	let providerCalls = 0;
	const runtime = fixtureRuntime({
		provider: {
			descriptor: {
				id: "beemax.chrome-pdf",
				version: "150.0.0",
				operations: [{ operation: "render", inputMediaTypes: ["text/html"], outputMediaTypes: ["application/pdf"] }],
			},
			async produce(request) {
				providerCalls++;
				return { locator: request.output, mediaType: request.outputMediaType, sourceRefs: [] };
			},
		},
		verifier: {
			descriptor: { id: "beemax.artifact-verifier", version: "1", mediaTypes: ["application/pdf"], dimensions: ["existence", "integrity", "render"] },
			async verify(request) {
				return { observed: { locator: request.locator, mediaType: request.mediaType, byteLength: 100, sha256: digest }, checks: acceptedChecks(request.dimensions) };
			},
		},
	});

	await assert.rejects(() => runtime.produce({
		operation: "render", input: { kind: "workspace", uri: "workspace:in.html" }, inputMediaType: "text/html",
		output: { kind: "workspace", uri: "workspace:out.pdf" }, outputMediaType: "application/pdf",
		requiredDimensions: ["existence", "execution"],
	}), /No Artifact Verifier covers required dimensions: execution/);
	assert.equal(providerCalls, 0, "an invalid verification plan cannot mutate the requested output");
});

test("Artifact expectations automatically require their matching verification dimensions", async () => {
	const observedDimensions = [];
	const runtime = fixtureRuntime({
		verifier: {
			descriptor: { id: "beemax.artifact-verifier", version: "1", mediaTypes: ["text/html"], dimensions: ["existence", "semantic", "consistency"] },
			async verify(request) {
				observedDimensions.push([...request.dimensions]);
				return { observed: { locator: request.locator, mediaType: request.mediaType, byteLength: 100, sha256: digest }, checks: acceptedChecks(request.dimensions) };
			},
		},
	});
	const inspected = await runtime.inspect(
		{ kind: "workspace", uri: "workspace:report.html" }, "text/html", ["existence"],
		{ requiredText: ["weekly high"], consistentWith: { locator: { kind: "workspace", uri: "workspace:source.html" }, mediaType: "text/html" } },
	);
	assert.deepEqual(observedDimensions, [["existence", "semantic", "consistency"]]);
	assert.deepEqual(inspected.checks.map(({ dimension }) => dimension), ["existence", "semantic", "consistency"]);
});

test("Artifact Runtime refuses provider self-verification and conflicting observations", async () => {
	const sameAuthority = fixtureRuntime({
		verifier: {
			descriptor: { id: "beemax.chrome-pdf", version: "150.0.0", mediaTypes: ["application/pdf"], dimensions: ["existence", "integrity"] },
			async verify(request) { return { observed: { locator: request.locator, mediaType: request.mediaType, byteLength: 10, sha256: digest }, checks: acceptedChecks(request.dimensions) }; },
		},
	});
	await assert.rejects(() => sameAuthority.produce({
		operation: "render", input: { kind: "workspace", uri: "workspace:in.html" }, inputMediaType: "text/html",
		output: { kind: "workspace", uri: "workspace:out.pdf" }, outputMediaType: "application/pdf", requiredDimensions: ["existence", "integrity"],
	}), /independent.*provider/i);

	const conflicting = new ArtifactRuntime({
		providers: [fixtureRuntime().providers[0]],
		verifiers: [
			{ descriptor: { id: "verify-bytes", version: "1", mediaTypes: ["application/pdf"], dimensions: ["existence"] }, async verify(request) { return { observed: { locator: request.locator, mediaType: request.mediaType, byteLength: 10, sha256: digest }, checks: acceptedChecks(request.dimensions) }; } },
			{ descriptor: { id: "verify-integrity", version: "1", mediaTypes: ["application/pdf"], dimensions: ["integrity"] }, async verify(request) { return { observed: { locator: request.locator, mediaType: request.mediaType, byteLength: 11, sha256: "b".repeat(64) }, checks: acceptedChecks(request.dimensions) }; } },
		],
	});
	await assert.rejects(() => conflicting.produce({
		operation: "render", input: { kind: "workspace", uri: "workspace:in.html" }, inputMediaType: "text/html",
		output: { kind: "workspace", uri: "workspace:out.pdf" }, outputMediaType: "application/pdf", requiredDimensions: ["existence", "integrity"],
	}), /conflicting Artifact observations/i);
});

test("Artifact Runtime detects content changes when an existing Manifest is reverified", async () => {
	const runtime = fixtureRuntime();
	const produced = await runtime.produce({
		operation: "render", input: { kind: "workspace", uri: "workspace:in.html" }, inputMediaType: "text/html",
		output: { kind: "workspace", uri: "workspace:out.pdf" }, outputMediaType: "application/pdf", requiredDimensions: ["existence", "integrity"],
	});
	const changed = fixtureRuntime({
		verifier: {
			descriptor: { id: "beemax.artifact-verifier", version: "2", mediaTypes: ["application/pdf"], dimensions: ["existence", "integrity"] },
			async verify(request) { return { observed: { locator: request.locator, mediaType: request.mediaType, byteLength: 4097, sha256: "b".repeat(64) }, checks: acceptedChecks(request.dimensions) }; },
		},
	});
	await assert.rejects(() => changed.verify(produced.manifest, ["existence", "integrity"]), /no longer matches its Manifest/i);
});

test("Artifact Tools constrain workspace locators and expose render separately from read-only verification", async () => {
	const runtime = fixtureRuntime();
	const tools = createArtifactTools(source, "/workspace", runtime);
	assert.deepEqual(tools.map((tool) => tool.name), ["artifact_render", "artifact_verify", "artifact_inspect"]);
	assert.equal(tools[0].beemaxPolicy.sideEffect, "local");
	assert.equal(tools[0].beemaxPolicy.approval, "always");
	assert.equal(tools[1].beemaxPolicy.sideEffect, "none");
	assert.equal(tools[2].beemaxPolicy.sideEffect, "none");
	assert.deepEqual(tools[0].beemaxToolSpec.ranking.outputModalities, ["application/pdf"]);
	assert.doesNotMatch(JSON.stringify(tools[0].parameters.properties.requiredDimensions), /execution/);
	assert.deepEqual(tools[0].parameters.properties.inputMediaType, { type: "string", const: "text/html" });
	assert.deepEqual(tools[0].parameters.properties.outputMediaType, { type: "string", const: "application/pdf" });
	assert.ok(tools[2].triggers.includes("检查 pdf"));
	assert.ok(tools[1].triggers.includes("manifest reverify"));
	assert.equal(tools[1].triggers.includes("pdf 可解析"), false);

	const result = await tools[0].execute("call", {
		inputPath: "report.html", outputPath: "report.pdf", inputMediaType: "text/html", outputMediaType: "application/pdf",
		requiredDimensions: ["existence", "integrity", "semantic", "render", "consistency"],
	}, new AbortController().signal);
	assert.equal(result.isError, undefined);
	assert.equal(result.details.manifest.locator.uri, "workspace:report.pdf");
	await assert.rejects(() => tools[0].execute("call", {
		inputPath: "../outside.html", outputPath: "report.pdf", inputMediaType: "text/html", outputMediaType: "application/pdf", requiredDimensions: ["existence"],
	}, new AbortController().signal), /outside the configured workspace/i);

	const inspected = await tools[2].execute("inspect", {
		path: "report.html", mediaType: "text/html", requiredDimensions: ["existence", "integrity", "render"], requiredText: ["weekly report"],
	}, new AbortController().signal);
	assert.deepEqual(inspected.details.observation, {
		locator: { kind: "workspace", uri: "workspace:report.html" }, mediaType: "text/html", byteLength: 4096, sha256: digest,
	});
	assert.deepEqual(inspected.details.checks.map(({ dimension, status }) => ({ dimension, status })), [
		{ dimension: "existence", status: "accepted" }, { dimension: "integrity", status: "accepted" }, { dimension: "render", status: "accepted" }, { dimension: "semantic", status: "accepted" },
	]);

	const verified = await tools[1].execute("verify-relative-workspace-uri", {
		manifest: {
			schemaVersion: "beemax.artifact-manifest.v1", id: `artifact:sha256:${digest}`,
			locator: { kind: "workspace", uri: "report.pdf" }, mediaType: "application/pdf", byteLength: 4096, sha256: digest,
			producer: { providerId: "test-producer", providerVersion: "1", operation: "render" }, sourceRefs: [], createdAt: 1,
		},
		requiredDimensions: ["existence", "integrity"],
	}, new AbortController().signal);
	assert.match(verified.content[0].text, /Verified artifact:sha256:/);
	assert.equal(verified.details.manifest.locator.uri, "workspace:report.pdf");
});

test("Artifact inspection passes an explicit workspace consistency source to independent verifiers", async () => {
	let observedExpectation;
	const runtime = fixtureRuntime({
		verifier: {
			descriptor: { id: "beemax.artifact-verifier", version: "1", mediaTypes: ["application/pdf"], dimensions: ["existence", "consistency"] },
			async verify(request) {
				observedExpectation = request.expectation;
				return { observed: { locator: request.locator, mediaType: request.mediaType, byteLength: 100, sha256: digest }, checks: acceptedChecks(request.dimensions) };
			},
		},
	});
	const inspect = createArtifactTools(source, "/workspace", runtime).find((tool) => tool.name === "artifact_inspect");
	await inspect.execute("inspect-consistency", {
		path: "report.pdf", mediaType: "application/pdf", requiredDimensions: ["existence", "consistency"],
		consistentWithPath: "report.html", consistentWithMediaType: "text/html",
	}, new AbortController().signal);
	assert.deepEqual(observedExpectation.consistentWith, { locator: { kind: "workspace", uri: "workspace:report.html" }, mediaType: "text/html" });
	assert.match(inspect.parameters.properties.consistentWithMediaType.description ?? "", /PDF.*output.*HTML.*source|HTML.*source.*PDF.*output/i);
	await assert.rejects(() => inspect.execute("inspect-invalid-consistency", {
		path: "report.pdf", mediaType: "application/pdf", requiredDimensions: ["consistency"], consistentWithPath: "report.html",
	}, new AbortController().signal), /must be supplied together/u);
});

test("Artifact inspection passes bounded unique external URL expectations to independent verifiers", async () => {
	let observedExpectation;
	const runtime = fixtureRuntime({
		verifier: {
			descriptor: { id: "beemax.artifact-verifier", version: "1", mediaTypes: ["text/html"], dimensions: ["semantic"] },
			async verify(request) {
				observedExpectation = request.expectation;
				return { observed: { locator: request.locator, mediaType: request.mediaType, byteLength: 100, sha256: digest }, checks: [{ dimension: "semantic", status: "accepted", evidenceRefs: ["semantic:external-urls:1", "artifact:external-url:https://source.example/report"] }] };
			},
		},
	});
	const inspect = createArtifactTools(source, "/workspace", runtime).find((tool) => tool.name === "artifact_inspect");
	const inspected = await inspect.execute("inspect-url-count", {
		path: "report.html", mediaType: "text/html", requiredDimensions: ["semantic"], minimumExternalUrls: 6, maximumExternalUrls: 6,
	}, new AbortController().signal);
	assert.deepEqual(observedExpectation, { minimumExternalUrls: 6, maximumExternalUrls: 6 });
	assert.deepEqual(inspected.details.externalUrls, ["https://source.example/report"]);
	assert.match(inspected.content[0].text, /https:\/\/source\.example\/report/);
	assert.ok(inspect.triggers.includes("href 去重"));
	await assert.rejects(() => inspect.execute("inspect-invalid-url-count", {
		path: "report.html", mediaType: "text/html", requiredDimensions: ["semantic"], minimumExternalUrls: 7, maximumExternalUrls: 6,
	}, new AbortController().signal), /minimum external URL count cannot exceed maximum/i);
});

test("Artifact inspection passes exact decoded-source assertions and bound visible equivalents to independent verifiers", async () => {
	let observedExpectation;
	const runtime = fixtureRuntime({
		verifier: {
			descriptor: { id: "beemax.artifact-verifier", version: "1", mediaTypes: ["text/html"], dimensions: ["semantic"] },
			async verify(request) {
				observedExpectation = request.expectation;
				return { observed: { locator: request.locator, mediaType: request.mediaType, byteLength: 100, sha256: digest }, checks: acceptedChecks(request.dimensions) };
			},
		},
	});
	const inspect = createArtifactTools(source, "/workspace", runtime).find((tool) => tool.name === "artifact_inspect");
	await inspect.execute("inspect-source-text", {
		path: "report.html", mediaType: "text/html", requiredDimensions: ["semantic"],
		requiredText: ["4,111.40"], requiredSourceText: ["4111.4", "4007.8"],
		requiredSourceVisiblePairs: [{ sourceText: "4111.4", visibleText: "4,111.40" }],
	}, new AbortController().signal);
	assert.deepEqual(observedExpectation, {
		requiredText: ["4,111.40"], requiredSourceText: ["4111.4", "4007.8"],
		requiredSourceVisiblePairs: [{ sourceText: "4111.4", visibleText: "4,111.40" }],
	});
	assert.match(inspect.parameters.properties.requiredSourceText.description ?? JSON.stringify(inspect.parameters.properties.requiredSourceText), /source|源码/i);
	assert.match(inspect.parameters.properties.requiredSourceVisiblePairs.description ?? JSON.stringify(inspect.parameters.properties.requiredSourceVisiblePairs), /same.*element|同一.*元素/i);
});

test("Artifact render returns an attested structured error only after the output was independently observed", async () => {
	const runtime = fixtureRuntime({
		verifier: {
			descriptor: { id: "beemax.artifact-verifier", version: "1", mediaTypes: ["application/pdf"], dimensions: ["existence", "semantic"] },
			async verify(request) {
				return {
					observed: { locator: request.locator, mediaType: request.mediaType, byteLength: 512, sha256: digest },
					checks: request.dimensions.map((dimension) => ({ dimension, status: dimension === "semantic" ? "rejected" : "accepted", evidenceRefs: [] })),
				};
			},
		},
	});
	const render = createArtifactTools(source, "/workspace", runtime)[0];
	const result = await render.execute("render", {
		inputPath: "report.html", outputPath: "report.pdf", inputMediaType: "text/html", outputMediaType: "application/pdf", requiredDimensions: ["existence", "semantic"],
	}, new AbortController().signal);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /verification semantic was rejected/i);
	assert.deepEqual(result.details.artifactObservation, { locator: { kind: "workspace", uri: "workspace:report.pdf" }, mediaType: "application/pdf", byteLength: 512, sha256: digest });
	assert.deepEqual(result.details.beemaxEffect.proof, { provider: "beemax-artifact-runtime", resourceType: "workspace-artifact", resourceId: "report.pdf" });
	assert.equal(render.beemaxPolicy.effectProofProvider, "beemax-artifact-runtime");
});
