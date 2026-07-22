import {
  KnowledgeProviderError,
  type CaptureKnowledgeInput,
  type CaptureKnowledgeResult,
  type KnowledgeExecutionContext,
  type KnowledgeHealth,
  type KnowledgeItem,
  type KnowledgeProvider,
  type RetrieveKnowledgeInput,
  type RetrieveKnowledgeResult,
} from "./types.ts";

type Fetch = typeof fetch;

export interface WeKnoraKnowledgeProviderOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: Fetch;
}

interface WeKnoraEnvelope<T> {
  success?: boolean;
  data?: T;
  error?: { code?: string; message?: string; details?: unknown };
}

interface WeKnoraKnowledge {
  id: string;
  knowledge_base_id: string;
  parse_status: CaptureKnowledgeResult["status"];
}

interface WeKnoraSearchItem {
  id: string;
  content: string;
  knowledge_id: string;
  knowledge_title?: string;
  knowledge_filename?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export class WeKnoraKnowledgeProvider implements KnowledgeProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: Fetch;

  constructor(options: WeKnoraKnowledgeProviderOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async healthCheck(): Promise<KnowledgeHealth> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`);
      return { healthy: response.ok, status: response.status };
    } catch {
      return { healthy: false, status: 0 };
    }
  }

  async capture(input: CaptureKnowledgeInput): Promise<CaptureKnowledgeResult> {
    const kbId = encodeURIComponent(input.destination.knowledgeBaseId);
    const endpoint = `${this.baseUrl}/api/v1/knowledge-bases/${kbId}/knowledge`;
    let response: Response;

    if (input.source.kind === "text") {
      response = await this.fetchImpl(`${endpoint}/manual`, {
        method: "POST",
        headers: this.headers(input.context, true),
        body: JSON.stringify({
          title: input.source.title,
          content: input.source.content,
          status: "published",
          channel: input.source.channel,
        }),
      });
    } else {
      const form = new FormData();
      form.set("file", input.source.content, input.source.filename);
      form.set("fileName", input.source.filename);
      form.set("channel", input.source.channel);
      form.set("enable_multimodel", input.source.enableMultimodal ? "true" : "false");
      form.set("metadata", JSON.stringify({
        ...input.source.externalRef,
        beemax_organization_id: input.context.organizationId,
        beemax_conversation_id: input.context.conversationId,
        ...(input.context.taskId ? { beemax_task_id: input.context.taskId } : {}),
      }));
      response = await this.fetchImpl(`${endpoint}/file`, {
        method: "POST",
        headers: this.headers(input.context, false),
        body: form,
      });
    }

    const data = await this.unwrap<WeKnoraKnowledge>(response);
    return {
      knowledgeId: data.id,
      knowledgeBaseId: data.knowledge_base_id,
      status: data.parse_status,
    };
  }

  async retrieve(input: RetrieveKnowledgeInput): Promise<RetrieveKnowledgeResult> {
    if (input.authorizedKnowledgeBaseIds.length === 0) {
      throw new KnowledgeProviderError(
        "knowledge_scope_required",
        "Thruvera must authorize at least one knowledge space before retrieval",
      );
    }

    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/knowledge-search`, {
      method: "POST",
      headers: this.headers(input.context, true),
      body: JSON.stringify({
        query: input.query,
        knowledge_base_ids: input.authorizedKnowledgeBaseIds,
        ...(input.knowledgeIds?.length ? { knowledge_ids: input.knowledgeIds } : {}),
      }),
    });
    const data = await this.unwrap<WeKnoraSearchItem[]>(response);
    return { items: data.map(mapSearchItem) };
  }

  private headers(context: KnowledgeExecutionContext, json: boolean): Record<string, string> {
    return {
      "X-API-Key": this.apiKey,
      "X-Request-ID": context.runId,
      "X-Thruvera-Organization-ID": context.organizationId,
      "X-Thruvera-Profile-ID": context.profileId,
      "X-Thruvera-User-ID": context.userId,
      "X-Thruvera-Conversation-ID": context.conversationId,
      // Preserve the established provider contract while downstream services
      // migrate to the Thruvera header namespace.
      "X-BeeMax-Organization-ID": context.organizationId,
      "X-BeeMax-Profile-ID": context.profileId,
      "X-BeeMax-User-ID": context.userId,
      "X-BeeMax-Conversation-ID": context.conversationId,
      ...(context.workspaceId ? { "X-Thruvera-Workspace-ID": context.workspaceId } : {}),
      ...(context.taskId ? { "X-Thruvera-Task-ID": context.taskId } : {}),
      ...(context.workspaceId ? { "X-BeeMax-Workspace-ID": context.workspaceId } : {}),
      ...(context.taskId ? { "X-BeeMax-Task-ID": context.taskId } : {}),
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  private async unwrap<T>(response: Response): Promise<T> {
    let envelope: WeKnoraEnvelope<T>;
    try {
      envelope = await response.json() as WeKnoraEnvelope<T>;
    } catch (cause) {
      throw new KnowledgeProviderError(
        "knowledge_invalid_response",
        "Knowledge Kernel returned an invalid response",
        response.status,
        { cause },
      );
    }

    if (!response.ok || envelope.success === false || envelope.data === undefined) {
      const message = envelope.error?.message ?? `Knowledge Kernel request failed (${response.status})`;
      throw new KnowledgeProviderError(
        response.status === 401 || response.status === 403
          ? "knowledge_access_denied"
          : "knowledge_provider_failed",
        message,
        response.status,
      );
    }
    return envelope.data;
  }
}

function mapSearchItem(item: WeKnoraSearchItem): KnowledgeItem {
  return {
    chunkId: item.id,
    content: item.content,
    knowledgeId: item.knowledge_id,
    title: item.knowledge_title ?? "",
    filename: item.knowledge_filename ?? "",
    score: item.score ?? 0,
    metadata: item.metadata ?? {},
  };
}
