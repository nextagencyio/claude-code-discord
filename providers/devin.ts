import type { AIProvider, PromptOptions, ProviderResult, ModelInfo } from "./types.ts";
import type { ClaudeMessage } from "../claude/types.ts";

const SESSION_ID_PATTERN = /session[:\s]+([a-zA-Z0-9_-]+)/i;

export class DevinProvider implements AIProvider {
  name = "devin";
  displayName = "Devin CLI";

  async sendPrompt(opts: PromptOptions): Promise<ProviderResult> {
    const devinPath = Deno.env.get("DEVIN_PATH") || "devin";
    const args: string[] = ["-p", "--permission-mode", "bypass"];

    if (opts.continueMode) {
      args.push("-c");
    } else if (opts.sessionId) {
      args.push("-r", opts.sessionId);
    }

    if (opts.modelOptions?.model) {
      args.push("--model", opts.modelOptions.model);
    }

    // Use --export to capture session metadata
    const exportPath = `${opts.workDir}/.devin-session-${Date.now()}.json`;
    args.push("--export", exportPath);

    args.push("--", opts.prompt);

    console.log(`Devin CLI: Running with args: ${args.join(" ")} in cwd: ${opts.workDir}`);

    const cmd = new Deno.Command(devinPath, {
      args,
      cwd: opts.workDir,
      stdout: "piped",
      stderr: "piped",
      signal: opts.controller.signal,
    });

    const child = cmd.spawn();

    const stderrChunks: string[] = [];
    const stdoutChunks: string[] = [];
    let sessionId: string | undefined;
    let fullResponse = "";

    // Read stderr
    const stderrReader = child.stderr.getReader();
    const stderrPromise = (async () => {
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        stderrChunks.push(text);
        console.error(`[Devin CLI stderr]: ${text}`);

        // Try to extract session ID from stderr
        if (!sessionId) {
          const match = text.match(SESSION_ID_PATTERN);
          if (match) sessionId = match[1];
        }
      }
    })();

    // Read stdout — stream line by line as text messages
    const stdoutReader = child.stdout.getReader();
    const stdoutPromise = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        buffer += text;
        stdoutChunks.push(text);

        // Emit complete lines as text messages
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim()) {
            if (opts.onChunk) {
              opts.onChunk(line + "\n");
            }
            if (opts.onMessage) {
              const msg: ClaudeMessage = {
                type: "text",
                content: line,
              };
              opts.onMessage(msg);
            }
            // Try to extract session ID from stdout
            if (!sessionId) {
              const match = line.match(SESSION_ID_PATTERN);
              if (match) sessionId = match[1];
            }
          }
        }
      }
      // Flush remaining buffer
      if (buffer.trim()) {
        if (opts.onChunk) {
          opts.onChunk(buffer);
        }
        if (opts.onMessage) {
          const msg: ClaudeMessage = {
            type: "text",
            content: buffer,
          };
          opts.onMessage(msg);
        }
      }
    })();

    const statusPromise = child.status;

    let status: Deno.CommandStatus;
    try {
      [status] = await Promise.all([statusPromise, stdoutPromise, stderrPromise]);
    } catch (error) {
      if (opts.controller.signal.aborted || (error as Error).name === "AbortError") {
        try { child.kill("SIGTERM"); } catch { /* already exited */ }
        return { response: "Request was cancelled", sessionId, modelUsed: opts.modelOptions?.model || "Default" };
      }
      throw error;
    }

    fullResponse = stdoutChunks.join("");

    // Try to parse session ID from export file
    if (!sessionId) {
      try {
        const exportContent = await Deno.readTextFile(exportPath);
        const exportData = JSON.parse(exportContent);
        sessionId = exportData.session_id || exportData.sessionId || exportData.id;
      } catch {
        // Export file may not exist or may not be JSON
      }
    }

    // Clean up export file
    try {
      await Deno.remove(exportPath);
    } catch {
      // File may not exist
    }

    if (!status.success && !opts.controller.signal.aborted) {
      const stderrOutput = stderrChunks.join("");
      throw new Error(`Devin CLI exited with code ${status.code}. stderr: ${stderrOutput.substring(0, 1000)}`);
    }

    return {
      response: fullResponse || "No response received",
      sessionId,
      modelUsed: opts.modelOptions?.model || "Default",
      stderrOutput: stderrChunks.join(""),
    };
  }

  // Curated set of common Devin model aliases. Devin supports hundreds of
  // model variants (run `devin models list` for the full set); these short
  // aliases always resolve to the latest version in each family and cover the
  // vast majority of use-cases. Any string Devin accepts on `--model` works,
  // so users can type a full model ID (e.g. `glm-5-2-max`) even if not listed.
  static readonly COMMON_MODELS: ModelInfo[] = [
    { id: "adaptive", name: "Adaptive", description: "Intelligent model router — auto-selects the best model per task (recommended)", contextWindow: 0, recommended: true },
    { id: "opus", name: "Claude Opus", description: "Most capable Claude — complex refactors, architecture, deep reasoning", contextWindow: 1_000_000 },
    { id: "sonnet", name: "Claude Sonnet", description: "Balanced speed and capability", contextWindow: 1_000_000 },
    { id: "gpt", name: "GPT", description: "OpenAI GPT — strong reasoning for multi-file work", contextWindow: 1_000_000 },
    { id: "swe", name: "SWE", description: "Cognition SWE — fast and cheap for straightforward edits and questions", contextWindow: 1_000_000 },
    { id: "codex", name: "Codex", description: "OpenAI Codex — code-focused", contextWindow: 1_000_000 },
    { id: "gemini", name: "Gemini", description: "Google Gemini", contextWindow: 1_000_000 },
    { id: "glm-5.2", name: "GLM 5.2", description: "GLM open-source model (free tier available)", contextWindow: 200_000 },
  ];

  async listModels(): Promise<ModelInfo[]> {
    return DevinProvider.COMMON_MODELS;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const devinPath = Deno.env.get("DEVIN_PATH") || "devin";
      const cmd = new Deno.Command(devinPath, { args: ["version"], stdout: "null", stderr: "null" });
      const { success } = await cmd.output();
      return success;
    } catch {
      return false;
    }
  }
}
