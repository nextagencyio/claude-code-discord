import type { AIProvider, PromptOptions, ProviderResult } from "./types.ts";
import { sendToClaudeCode, cleanSessionId } from "../claude/client.ts";

export class ClaudeCodeProvider implements AIProvider {
  name = "claude-code";
  displayName = "Claude Code";
  aliases = ["claude"];

  async sendPrompt(opts: PromptOptions): Promise<ProviderResult> {
    const cleanedSessionId = opts.sessionId ? cleanSessionId(opts.sessionId) : undefined;

    const result = await sendToClaudeCode(
      opts.workDir,
      opts.prompt,
      opts.controller,
      cleanedSessionId,
      opts.onChunk,
      opts.onStreamJson as ((json: unknown) => void) | undefined,
      opts.continueMode,
      // No model options: the CLI uses whatever model it is configured with.
      undefined,
      opts.workspaceRootDir,
      opts.mcpServers,
    );

    return {
      response: result.response,
      sessionId: result.sessionId,
      cost: result.cost,
      duration: result.duration,
      modelUsed: result.modelUsed,
      stderrOutput: result.stderrOutput,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const claudePath = Deno.env.get("CLAUDE_PATH") || "claude";
      const cmd = new Deno.Command(claudePath, { args: ["--version"], stdout: "null", stderr: "null" });
      const { success } = await cmd.output();
      return success;
    } catch {
      return false;
    }
  }
}
