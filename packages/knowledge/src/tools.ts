import {
  READ_ONLY_TOOL_POLICY,
  canonicalUserId,
  conversationKey,
  defineTool,
  withToolPolicy,
  type ThruveraRuntimeSource,
  type ToolDefinition,
} from "@thruvera/core";
import { Type } from "typebox";
import type { KnowledgeProvider } from "./types.ts";

export interface KnowledgeToolSpace {
  id: string;
  name: string;
  knowledgeBaseId: string;
}

export interface KnowledgeToolsOptions {
  profileId: string;
  organizationId?: string;
  workspaceId?: string;
  spaces: KnowledgeToolSpace[];
}

export function createKnowledgeTools(
  provider: KnowledgeProvider,
  source: ThruveraRuntimeSource,
  options: KnowledgeToolsOptions,
): ToolDefinition[] {
  const spacesById = new Map(options.spaces.map((space) => [space.id, space]));
  const retrieve = withToolPolicy(defineTool({
    name: "knowledge_retrieve",
    label: "Enterprise Knowledge",
    description: "Search authorized enterprise knowledge uploaded in the Thruvera Knowledge Center. Use for company rules, product documentation, customer history, project materials, and other enterprise facts. Returns source-backed excerpts; never searches unconfigured spaces.",
    parameters: Type.Object({
      query: Type.String({ description: "The precise enterprise knowledge question or search query" }),
      spaceIds: Type.Optional(Type.Array(Type.String(), { description: "Optional Thruvera knowledge space IDs to narrow the search" })),
    }),
    execute: async (toolCallId, params) => {
      const requested = params.spaceIds?.length ? params.spaceIds : [...spacesById.keys()];
      const unauthorized = requested.filter((id) => !spacesById.has(id));
      if (unauthorized.length) {
        return toolResult(`未授权或未配置的知识空间：${unauthorized.join(", ")}`, {
          code: "knowledge_space_not_authorized",
          unauthorized,
        }, true);
      }
      const spaces = requested.map((id) => spacesById.get(id)!);
      try {
        const result = await provider.retrieve({
          context: {
            organizationId: options.organizationId ?? `profile:${options.profileId}`,
            workspaceId: options.workspaceId,
            profileId: options.profileId,
            userId: canonicalUserId(source) ?? "anonymous",
            conversationId: conversationKey(source),
            runId: toolCallId,
          },
          query: params.query,
          authorizedKnowledgeBaseIds: spaces.map((space) => space.knowledgeBaseId),
        });
        if (!result.items.length) {
          return toolResult(`未在授权的企业知识空间中找到相关内容。\n查询范围：${spaces.map((space) => space.name).join("、")}`, {
            resultCount: 0,
            spaces: spaces.map((space) => space.id),
          });
        }
        const text = result.items.map((item, index) => [
          `## ${index + 1}. ${item.title || item.filename || "企业知识"}`,
          item.content,
          `来源：${item.filename || item.title || item.knowledgeId}`,
          `相关度：${item.score.toFixed(3)}`,
        ].join("\n")).join("\n\n");
        return toolResult(text, {
          resultCount: result.items.length,
          spaces: spaces.map((space) => space.id),
          references: result.items.map((item) => ({
            knowledgeId: item.knowledgeId,
            chunkId: item.chunkId,
            title: item.title,
            filename: item.filename,
            score: item.score,
          })),
        });
      } catch (error) {
        return toolResult(`企业知识检索失败：${error instanceof Error ? error.message : String(error)}`, {
          code: "knowledge_retrieve_failed",
        }, true);
      }
    },
  }), {
    ...READ_ONLY_TOOL_POLICY,
    timeoutMs: 60_000,
    maxAttempts: 2,
    impact: "Reads only the enterprise knowledge spaces authorized for this Thruvera Agent",
  });
  return [retrieve];
}

function toolResult(text: string, details: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details: { ...(typeof details === "object" && details ? details : {}), isError },
  };
}
