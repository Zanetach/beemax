export interface KnowledgeExecutionContext {
  organizationId: string;
  workspaceId?: string;
  profileId: string;
  userId: string;
  conversationId: string;
  taskId?: string;
  runId: string;
}

export type KnowledgeChannel =
  | "knowledge_center"
  | "feishu"
  | "dingtalk"
  | "web"
  | "app"
  | "meeting"
  | "agent"
  | (string & {});

export interface TextKnowledgeSource {
  kind: "text";
  channel: KnowledgeChannel;
  title: string;
  content: string;
  externalRef?: Record<string, string>;
}

export interface FileKnowledgeSource {
  kind: "file";
  channel: KnowledgeChannel;
  filename: string;
  content: Blob;
  externalRef?: Record<string, string>;
  enableMultimodal?: boolean;
}

export type KnowledgeSource = TextKnowledgeSource | FileKnowledgeSource;

export interface CaptureKnowledgeInput {
  context: KnowledgeExecutionContext;
  destination: { knowledgeBaseId: string };
  source: KnowledgeSource;
}

export interface CaptureKnowledgeResult {
  knowledgeId: string;
  knowledgeBaseId: string;
  status: "pending" | "processing" | "finalizing" | "completed" | "failed" | "cancelled";
}

export interface RetrieveKnowledgeInput {
  context: KnowledgeExecutionContext;
  query: string;
  authorizedKnowledgeBaseIds: string[];
  knowledgeIds?: string[];
}

export interface KnowledgeItem {
  chunkId: string;
  content: string;
  knowledgeId: string;
  title: string;
  filename: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface RetrieveKnowledgeResult {
  items: KnowledgeItem[];
}

export interface KnowledgeHealth {
  healthy: boolean;
  status: number;
}

export interface KnowledgeProvider {
  healthCheck(): Promise<KnowledgeHealth>;
  capture(input: CaptureKnowledgeInput): Promise<CaptureKnowledgeResult>;
  retrieve(input: RetrieveKnowledgeInput): Promise<RetrieveKnowledgeResult>;
}

export class KnowledgeProviderError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(
    code: string,
    message: string,
    status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "KnowledgeProviderError";
    this.code = code;
    this.status = status;
  }
}
