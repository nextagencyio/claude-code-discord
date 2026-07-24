import type { ClaudeMessage } from "../claude/types.ts";

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  contextWindow: number;
  recommended?: boolean;
  supportsThinking?: boolean;
}

export interface PromptOptions {
  workDir: string;
  prompt: string;
  controller: AbortController;
  sessionId?: string;
  onChunk?: (text: string) => void;
  onStreamJson?: (json: unknown) => void;
  onMessage?: (msg: ClaudeMessage) => void;
  continueMode?: boolean;
  modelOptions?: { model?: string };
  workspaceRootDir?: string;
  // deno-lint-ignore no-explicit-any
  mcpServers?: Record<string, any>;
}

export interface ProviderResult {
  response: string;
  sessionId?: string;
  cost?: number;
  duration?: number;
  modelUsed?: string;
  stderrOutput?: string;
  tokenUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    cachedTokens?: number;
  };
}

export interface AIProvider {
  name: string;
  displayName: string;

  sendPrompt(opts: PromptOptions): Promise<ProviderResult>;
  isAvailable(): Promise<boolean>;
  listModels?(): Promise<ModelInfo[]>;
}

export interface ProviderRegistry {
  getProvider(name: string): AIProvider;
  getDefaultProvider(): AIProvider;
  getAvailableProviders(): Promise<AIProvider[]>;
  registerProvider(provider: AIProvider): void;
  hasProvider(name: string): boolean;
}
