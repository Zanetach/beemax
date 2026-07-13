import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { LocalTesseractMediaAdapter, createLocalMediaUnderstandingAdapters, findExecutable, parseTesseractTsv } from "../dist/local-media-understanding.js";

const image = { type: "image", mimeType: "image/png", data: Buffer.from("pixels").toString("base64") };

test("findExecutable discovers an executable from PATH without invoking a shell", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-ocr-path-"));
	const bin = join(root, "bin");
	mkdirSync(bin);
	const executable = join(bin, "tesseract");
	writeFileSync(executable, "#!/bin/sh\nexit 0\n");
	chmodSync(executable, 0o755);
	try {
		assert.equal(findExecutable("tesseract", { PATH: [join(root, "missing"), bin].join(delimiter) }), executable);
		assert.equal(findExecutable("missing", { PATH: bin }), undefined);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("local Tesseract adapter sends decoded image bytes over stdin and returns OCR evidence", async () => {
	const calls = [];
	const adapter = new LocalTesseractMediaAdapter({
		command: "/usr/bin/tesseract",
		languages: "eng+chi_sim",
		run: async (input) => { calls.push(input); return { stdout: "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t96\t识别结果\n5\t1\t1\t1\t1\t2\t10\t0\t10\t10\t84\t88.00\n", stderr: "", exitCode: 0 }; },
	});
	const request = { text: "提取文字", images: [image], primaryModel: { id: "text", input: ["text"] } };
	assert.equal((await adapter.evaluate(request)).score, 95);
	assert.equal((await adapter.evaluate({ ...request, text: "这张照片里发生了什么" })).score, 60);
	const result = await adapter.understand(request);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].args, ["stdin", "stdout", "-l", "eng+chi_sim", "tsv"]);
	assert.deepEqual(calls[0].stdin, Buffer.from("pixels"));
	assert.equal(result.outputs[0].content, "识别结果 88.00");
	assert.equal(result.outputs[0].confidence, 0.9);
});

test("Tesseract TSV parsing preserves line structure and exposes confidence for verification", () => {
	const parsed = parseTesseractTsv("level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t0\t0\t1\t1\t40\tlow\n5\t1\t1\t1\t2\t1\t0\t2\t1\t1\t80\tnext\n");
	assert.deepEqual(parsed, { content: "low\nnext", confidence: 0.6 });
});

test("local OCR auto-discovery is optional and requires a real executable", () => {
	assert.deepEqual(createLocalMediaUnderstandingAdapters({ enabled: false }), []);
	assert.deepEqual(createLocalMediaUnderstandingAdapters({ enabled: true, command: "definitely-not-installed", env: { PATH: "" } }), []);
});
