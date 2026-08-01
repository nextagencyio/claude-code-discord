import type { ClaudeMessage } from "../claude/types.ts";

// NOTE: the bot does not select models. Every provider runs its CLI with no
// model flag, so each CLI uses whatever default the user configured for it
// (`claude` settings, `~/.codex/config.toml`, `devin`'s own default, etc.).
// Model choice belongs to the CLI, not to Discord — the bot only picks WHICH
// CLI to talk to. `ProviderResult.modelUsed` reports back what the CLI
// actually ran, when it tells us.

export interface PromptOptions {
  workDir: string;
  prompt: string;
  controller: AbortController;
  sessionId?: string;
  onChunk?: (text: string) => void;
  onStreamJson?: (json: unknown) => void;
  onMessage?: (msg: ClaudeMessage) => void;
  continueMode?: boolean;
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
  /** Alternate names accepted by `/provider set` (e.g. "claude" → "claude-code"). */
  aliases?: string[];

  sendPrompt(opts: PromptOptions): Promise<ProviderResult>;
  isAvailable(): Promise<boolean>;
}

export interface ProviderRegistry {
  getProvider(name: string): AIProvider;
  getDefaultProvider(): AIProvider;
  getAvailableProviders(): Promise<AIProvider[]>;
  registerProvider(provider: AIProvider): void;
  hasProvider(name: string): boolean;
}
