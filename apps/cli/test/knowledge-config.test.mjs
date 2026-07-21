import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createProfile } from "../dist/profile-config.js";

test("Profile loads a WeKnora connection and explicit Agent knowledge spaces without storing secrets in YAML", async () => {
  const home = await mkdtemp(join(tmpdir(), "beemax-knowledge-home-"));
  const paths = await createProfile("knowledge", { home });
  await writeFile(paths.configPath, `
agent:
  toolset: standard
knowledge:
  enabled: true
  provider: weknora
  baseUrl: http://knowledge.internal:8080
  spaces:
    - id: company
      name: 公司公共知识
      knowledgeBaseId: kb-company
    - id: pcb
      name: PCB专业知识
      knowledgeBaseId: kb-pcb
`);
  await writeFile(paths.envPath, 'BEEMAX_WEKNORA_API_KEY="secret-key"\n', { mode: 0o600 });

  const config = loadConfig(paths.configPath, "knowledge");
  assert.deepEqual(config.knowledge, {
    enabled: true,
    provider: "weknora",
    baseUrl: "http://knowledge.internal:8080",
    apiKey: "secret-key",
    spaces: [
      { id: "company", name: "公司公共知识", knowledgeBaseId: "kb-company" },
      { id: "pcb", name: "PCB专业知识", knowledgeBaseId: "kb-pcb" },
    ],
  });
});

test("knowledge integration stays disabled until connection and spaces are configured", async () => {
  const home = await mkdtemp(join(tmpdir(), "beemax-knowledge-home-"));
  const paths = await createProfile("empty", { home });
  assert.deepEqual(loadConfig(paths.configPath, "empty").knowledge, {
    enabled: false,
    provider: "weknora",
    baseUrl: "http://127.0.0.1:8080",
    apiKey: undefined,
    spaces: [],
  });
});
