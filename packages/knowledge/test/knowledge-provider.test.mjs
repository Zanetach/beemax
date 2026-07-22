import assert from "node:assert/strict";
import test from "node:test";

import { WeKnoraKnowledgeProvider } from "../dist/index.js";

const context = {
  organizationId: "org-1",
  workspaceId: "sales",
  profileId: "pcb-quote",
  userId: "user-1",
  conversationId: "conversation-1",
  taskId: "task-1",
  runId: "run-1",
};

function response(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

test("captures manually uploaded and channel-produced knowledge through one asset seam", async () => {
  const requests = [];
  const provider = new WeKnoraKnowledgeProvider({
    baseUrl: "http://knowledge.internal:8080",
    apiKey: "secret",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return response({
        success: true,
        data: {
          id: requests.length === 1 ? "knowledge-upload" : "knowledge-feishu",
          knowledge_base_id: "kb-customer",
          parse_status: "processing",
        },
      }, { status: 201 });
    },
  });

  const uploaded = await provider.capture({
    context,
    destination: { knowledgeBaseId: "kb-customer" },
    source: {
      kind: "text",
      channel: "knowledge_center",
      title: "PCB工艺规范",
      content: "# PCB工艺规范\n\n沉金厚度要求。",
    },
  });
  const fromFeishu = await provider.capture({
    context,
    destination: { knowledgeBaseId: "kb-customer" },
    source: {
      kind: "text",
      channel: "feishu",
      title: "客户会议结论",
      content: "客户要求24小时内提供报价。",
      externalRef: { messageId: "om-1", chatId: "oc-1" },
    },
  });

  assert.equal(uploaded.knowledgeId, "knowledge-upload");
  assert.equal(fromFeishu.knowledgeId, "knowledge-feishu");
  assert.equal(requests[0].url, "http://knowledge.internal:8080/api/v1/knowledge-bases/kb-customer/knowledge/manual");
  assert.equal(requests[1].url, requests[0].url);

  const firstBody = JSON.parse(requests[0].init.body);
  const secondBody = JSON.parse(requests[1].init.body);
  assert.equal(firstBody.channel, "knowledge_center");
  assert.equal(secondBody.channel, "feishu");
  assert.equal(requests[0].init.headers["X-Request-ID"], "run-1");
  assert.equal(requests[0].init.headers["X-Thruvera-Organization-ID"], "org-1");
  assert.equal(requests[0].init.headers["X-Thruvera-Task-ID"], "task-1");
});

test("retrieval is constrained to the knowledge bases authorized by Thruvera", async () => {
  let request;
  const provider = new WeKnoraKnowledgeProvider({
    baseUrl: "http://knowledge.internal:8080/",
    apiKey: "secret",
    fetch: async (url, init) => {
      request = { url: String(url), init };
      return response({
        success: true,
        data: [{
          id: "chunk-1",
          content: "报价超过十万元需要审批。",
          knowledge_id: "knowledge-1",
          knowledge_title: "报价制度",
          knowledge_filename: "pricing.md",
          score: 0.93,
          metadata: {},
        }],
      });
    },
  });

  const result = await provider.retrieve({
    context,
    query: "报价审批规则",
    authorizedKnowledgeBaseIds: ["kb-public", "kb-junhao"],
  });

  assert.equal(request.url, "http://knowledge.internal:8080/api/v1/knowledge-search");
  assert.deepEqual(JSON.parse(request.init.body), {
    query: "报价审批规则",
    knowledge_base_ids: ["kb-public", "kb-junhao"],
  });
  assert.deepEqual(result.items[0], {
    chunkId: "chunk-1",
    content: "报价超过十万元需要审批。",
    knowledgeId: "knowledge-1",
    title: "报价制度",
    filename: "pricing.md",
    score: 0.93,
    metadata: {},
  });
});

test("refuses retrieval without an explicit Thruvera knowledge scope", async () => {
  const provider = new WeKnoraKnowledgeProvider({
    baseUrl: "http://knowledge.internal:8080",
    apiKey: "secret",
    fetch: async () => {
      throw new Error("must not call WeKnora");
    },
  });

  await assert.rejects(
    provider.retrieve({ context, query: "anything", authorizedKnowledgeBaseIds: [] }),
    (error) => error.code === "knowledge_scope_required",
  );
});

test("maps WeKnora failures to a stable Thruvera knowledge error", async () => {
  const provider = new WeKnoraKnowledgeProvider({
    baseUrl: "http://knowledge.internal:8080",
    apiKey: "secret",
    fetch: async () => response({
      success: false,
      error: { code: "forbidden", message: "knowledge base access denied" },
    }, { status: 403 }),
  });

  await assert.rejects(
    provider.capture({
      context,
      destination: { knowledgeBaseId: "kb-private" },
      source: { kind: "text", channel: "feishu", title: "secret", content: "secret" },
    }),
    (error) => error.code === "knowledge_access_denied" && error.status === 403,
  );
});

test("uploads channel attachments with their provenance and Thruvera ownership metadata", async () => {
  let request;
  const provider = new WeKnoraKnowledgeProvider({
    baseUrl: "http://knowledge.internal:8080",
    apiKey: "secret",
    fetch: async (url, init) => {
      request = { url: String(url), init };
      return response({
        success: true,
        data: {
          id: "knowledge-file",
          knowledge_base_id: "kb-project",
          parse_status: "processing",
        },
      }, { status: 201 });
    },
  });

  await provider.capture({
    context,
    destination: { knowledgeBaseId: "kb-project" },
    source: {
      kind: "file",
      channel: "feishu",
      filename: "客户需求.docx",
      content: new Blob(["document bytes"], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
      externalRef: { message_id: "om-1", file_key: "file-1" },
      enableMultimodal: true,
    },
  });

  assert.equal(request.url, "http://knowledge.internal:8080/api/v1/knowledge-bases/kb-project/knowledge/file");
  assert.equal(request.init.headers["Content-Type"], undefined);
  assert.equal(request.init.body.get("channel"), "feishu");
  assert.equal(request.init.body.get("fileName"), "客户需求.docx");
  assert.equal(request.init.body.get("enable_multimodel"), "true");
  assert.deepEqual(JSON.parse(request.init.body.get("metadata")), {
    message_id: "om-1",
    file_key: "file-1",
    beemax_organization_id: "org-1",
    beemax_conversation_id: "conversation-1",
    beemax_task_id: "task-1",
  });
});

test("reports Knowledge Kernel health without exposing transport failures", async () => {
  const healthy = new WeKnoraKnowledgeProvider({
    baseUrl: "http://knowledge.internal:8080",
    apiKey: "secret",
    fetch: async () => new Response("ok", { status: 200 }),
  });
  const unavailable = new WeKnoraKnowledgeProvider({
    baseUrl: "http://knowledge.internal:8080",
    apiKey: "secret",
    fetch: async () => { throw new Error("connection refused"); },
  });

  assert.deepEqual(await healthy.healthCheck(), { healthy: true, status: 200 });
  assert.deepEqual(await unavailable.healthCheck(), { healthy: false, status: 0 });
});
