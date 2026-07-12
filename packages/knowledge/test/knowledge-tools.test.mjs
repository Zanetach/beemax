import assert from "node:assert/strict";
import test from "node:test";

import { createKnowledgeTools } from "../dist/index.js";

const source = {
  platform: "feishu",
  chatId: "oc-junhao",
  chatType: "group",
  userIdAlt: "ou-zhangsan",
  threadId: "thread-1",
};

test("Agent retrieves configured enterprise knowledge and receives source-backed results", async () => {
  let input;
  const provider = {
    async healthCheck() { return { healthy: true, status: 200 }; },
    async capture() { throw new Error("not used"); },
    async retrieve(value) {
      input = value;
      return {
        items: [{
          chunkId: "chunk-1",
          knowledgeId: "doc-1",
          title: "PCB特殊工艺报价规范V3",
          filename: "pricing-v3.pdf",
          content: "沉金板报价前必须确认沉金厚度。",
          score: 0.94,
          metadata: {},
        }],
      };
    },
  };

  const [tool] = createKnowledgeTools(provider, source, {
    profileId: "sales-agent",
    spaces: [
      { id: "pcb", name: "PCB专业知识", knowledgeBaseId: "kb-pcb" },
      { id: "junhao", name: "君浩电子", knowledgeBaseId: "kb-junhao" },
    ],
  });
  const result = await tool.execute("call-1", { query: "沉金板报价规则" }, undefined, undefined, {});

  assert.deepEqual(input.authorizedKnowledgeBaseIds, ["kb-pcb", "kb-junhao"]);
  assert.equal(input.context.profileId, "sales-agent");
  assert.equal(input.context.userId, "ou-zhangsan");
  assert.match(result.content[0].text, /沉金板报价前必须确认沉金厚度/);
  assert.match(result.content[0].text, /PCB特殊工艺报价规范V3/);
  assert.match(result.content[0].text, /pricing-v3\.pdf/);
  assert.equal(tool.beemaxPolicy.sideEffect, "none");
  assert.equal(tool.beemaxPolicy.approval, "never");
});

test("Agent cannot request an unconfigured knowledge space", async () => {
  let called = false;
  const provider = {
    async healthCheck() { return { healthy: true, status: 200 }; },
    async capture() { throw new Error("not used"); },
    async retrieve() { called = true; return { items: [] }; },
  };
  const [tool] = createKnowledgeTools(provider, source, {
    profileId: "sales-agent",
    spaces: [{ id: "pcb", name: "PCB专业知识", knowledgeBaseId: "kb-pcb" }],
  });
  const result = await tool.execute("call-2", { query: "财务制度", spaceIds: ["finance"] }, undefined, undefined, {});

  assert.equal(called, false);
  assert.match(result.content[0].text, /not authorized|未授权/i);
});
