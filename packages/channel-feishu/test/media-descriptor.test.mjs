import test from "node:test";
import assert from "node:assert/strict";
import { parseFeishuMediaDescriptor } from "../dist/index.js";

test("Feishu media descriptors reject malformed content and normalize resource types", () => {
	assert.equal(parseFeishuMediaDescriptor({ message_type: "text", content: '{"text":"hello"}' }), undefined);
	assert.equal(parseFeishuMediaDescriptor({ message_type: "image", content: "not-json" }), undefined);
	assert.deepEqual(parseFeishuMediaDescriptor({ message_type: "image", content: '{"image_key":"img-key"}' }), {
		fileKey: "img-key", resourceType: "image", mimeType: "image/jpeg", displayName: undefined,
	});
	assert.deepEqual(parseFeishuMediaDescriptor({ message_type: "file", content: '{"file_key":"file-key","file_name":"report.pdf"}' }), {
		fileKey: "file-key", resourceType: "file", mimeType: "application/pdf", displayName: "report.pdf",
	});
});
