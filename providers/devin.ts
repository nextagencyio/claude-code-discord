import type { AIProvider, PromptOptions, ProviderResult, ModelInfo } from "./types.ts";
import type { ClaudeMessage } from "../claude/types.ts";

const SESSION_ID_PATTERN = /session[:\s]+([a-zA-Z0-9_-]+)/i;

// Minimum interval between export-file polls (ms). The file is rewritten in
// whole after each step, so polling too fast just burns CPU.
const POLL_INTERVAL_MS = 1500;

// deno-lint-ignore no-explicit-any
interface AtifStep {
  step_id: number;
  source: string;
  timestamp?: string;
  message?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    tool_call_id: string;
    function_name: string;
    // deno-lint-ignore no-explicit-any
    arguments: Record<string, any>;
  }>;
  observation?: {
    results: Array<{ source_call_id: string; content: string }>;
  };
  metrics?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
  };
}

// deno-lint-ignore no-explicit-any
interface AtifExport {
  session_id?: string;
  agent?: { model_name?: string };
  steps?: AtifStep[];
  final_metrics?: {
    total_prompt_tokens?: number;
    total_completion_tokens?: number;
    total_cached_tokens?: number;
    total_steps?: number;
  };
}

// (Devin tool names are added to HIGH_SIGNAL_TOOLS in claude/discord-sender.ts)

export class DevinProvider implements AIProvider {
  name = "devin";
  displayName = "Devin CLI";

  async sendPrompt(opts: PromptOptions): Promise<ProviderResult> {
    try {
      return await this.runDevin(opts);
    } catch (error) {
      // If Devin rejects the model ID (e.g. a Claude-specific ID like
      // "claude-opus-4-8" was passed to Devin which expects "claude-opus-4.8"),
      // retry once without --model so the request still succeeds.
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("Unknown model") && opts.modelOptions?.model) {
        console.warn(`[Devin] Model "${opts.modelOptions.model}" rejected, retrying without --model`);
        return await this.runDevin({ ...opts, modelOptions: undefined });
      }
      throw error;
    }
  }

  private async runDevin(opts: PromptOptions): Promise<ProviderResult> {
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

    // --export writes an ATIF JSON file that is updated incrementally after
    // each step. We poll it to stream intermediate progress (tool calls,
    // plan updates) to Discord, and parse final_metrics for cost/duration.
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
    const startTime = Date.now();

    const stderrChunks: string[] = [];
    const stdoutChunks: string[] = [];
    let sessionId: string | undefined;
    let lastSeenStepId = 0;
    let processExited = false;

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

        if (!sessionId) {
          const match = text.match(SESSION_ID_PATTERN);
          if (match) sessionId = match[1];
        }
      }
    })();

    // Read stdout — the final response text (print mode emits only the result)
    const stdoutReader = child.stdout.getReader();
    const stdoutPromise = (async () => {
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        stdoutChunks.push(text);
      }
    })();

    // Poll the export file for new steps and stream them as ClaudeMessages.
    // The file is rewritten in whole after each step, so we track the highest
    // step_id we've already emitted and only send new ones. Stops when the
    // process exits or the request is cancelled.
    const pollPromise = (async () => {
      while (!processExited && !opts.controller.signal.aborted) {
        await sleep(POLL_INTERVAL_MS);
        if (processExited || opts.controller.signal.aborted) break;

        let exportData: AtifExport | null = null;
        try {
          const content = await Deno.readTextFile(exportPath);
          exportData = JSON.parse(content) as AtifExport;
        } catch {
          // File doesn't exist yet or isn't valid JSON — try again next cycle
          continue;
        }

        if (!sessionId && exportData.session_id) {
          sessionId = exportData.session_id;
        }

        const steps = exportData.steps || [];
        for (const step of steps) {
          if (step.step_id <= lastSeenStepId) continue;
          lastSeenStepId = step.step_id;
          this.emitStep(step, opts);
        }
      }
    })();

    const statusPromise = child.status;

    let status: Deno.CommandStatus;
    try {
      [status] = await Promise.all([statusPromise, stdoutPromise, stderrPromise]);
      processExited = true;
      // Let the poll loop see the flag and exit; don't await it (it may be
      // mid-sleep). The final flush below catches any steps it missed.
      pollPromise.catch(() => {});

      // If the request was cancelled, the child was killed by the signal and
      // Promise.all resolves normally (streams close on kill). Detect that
      // here rather than relying on the catch path.
      if (opts.controller.signal.aborted) {
        return { response: "Request was cancelled", sessionId, modelUsed: opts.modelOptions?.model || "Default" };
      }
    } catch (error) {
      processExited = true;
      if (opts.controller.signal.aborted || (error as Error).name === "AbortError") {
        try { child.kill("SIGTERM"); } catch { /* already exited */ }
        return { response: "Request was cancelled", sessionId, modelUsed: opts.modelOptions?.model || "Default" };
      }
      throw error;
    }

    // Final flush: read the export file one last time to catch any steps
    // emitted between the last poll and process exit, plus final_metrics.
    let cost: number | undefined;
    let duration: number | undefined;
    let modelUsed = opts.modelOptions?.model || "Default";

    try {
      const exportContent = await Deno.readTextFile(exportPath);
      const exportData = JSON.parse(exportContent) as AtifExport;

      if (!sessionId) sessionId = exportData.session_id;
      if (exportData.agent?.model_name) modelUsed = exportData.agent.model_name;

      // Emit any steps we haven't seen yet
      const steps = exportData.steps || [];
      for (const step of steps) {
        if (step.step_id <= lastSeenStepId) continue;
        lastSeenStepId = step.step_id;
        this.emitStep(step, opts);
      }

      // Parse duration from step timestamps (first to last)
      if (steps.length >= 2) {
        const firstStep = steps[0];
        const lastStep = steps[steps.length - 1];
        try {
          const firstTs = new Date(firstStep?.timestamp || "").getTime();
          const lastTs = new Date(lastStep?.timestamp || "").getTime();
          if (firstTs && lastTs) duration = lastTs - firstTs;
        } catch { /* timestamps unavailable */ }
      }
      duration = duration ?? (Date.now() - startTime);

      // Cost: Devin doesn't expose dollar amounts in the export, only token
      // counts. We log token usage for observability; a real $ cost would
      // require pricing tables per model, which change frequently — left as
      // a future enhancement.
      const metrics = exportData.final_metrics;
      if (metrics) {
        const totalTokens = (metrics.total_prompt_tokens || 0) +
          (metrics.total_completion_tokens || 0) +
          (metrics.total_cached_tokens || 0);
        if (totalTokens > 0) {
          console.log(`[Devin] Token usage: ${totalTokens} (prompt: ${metrics.total_prompt_tokens}, completion: ${metrics.total_completion_tokens}, cached: ${metrics.total_cached_tokens})`);
        }
      }
    } catch {
      // Export file may not exist or may not be JSON
    }

    // Clean up export file
    try {
      await Deno.remove(exportPath);
    } catch {
      // File may not exist
    }

    const fullResponse = stdoutChunks.join("");

    if (!status.success && !opts.controller.signal.aborted) {
      const stderrOutput = stderrChunks.join("");
      throw new Error(`Devin CLI exited with code ${status.code}. stderr: ${stderrOutput.substring(0, 1000)}`);
    }

    return {
      response: fullResponse || "No response received",
      sessionId,
      cost,
      duration,
      modelUsed,
      stderrOutput: stderrChunks.join(""),
    };
  }

  /**
   * Convert a single ATIF step into ClaudeMessage(s) and emit via callbacks.
   * Devin tool names are passed through as-is. The Discord sender drops
   * tool_use messages entirely, so these surface only to onChunk/onMessage
   * consumers such as devin_test.ts.
   */
  private emitStep(step: AtifStep, opts: PromptOptions): void {
    // Agent steps with tool calls → tool_use messages
    if (step.tool_calls && step.tool_calls.length > 0) {
      for (const tc of step.tool_calls) {
        const msg: ClaudeMessage = {
          type: "tool_use",
          content: "",
          metadata: {
            name: tc.function_name,
            input: tc.arguments,
          },
        };
        opts.onMessage?.(msg);
        opts.onChunk?.(`[Tool: ${tc.function_name}]\n`);
      }
    }

    // Tool results → tool_result (sender skips these, but emit for completeness)
    if (step.observation?.results && step.observation.results.length > 0) {
      for (const result of step.observation.results) {
        const msg: ClaudeMessage = {
          type: "tool_result",
          content: result.content,
        };
        opts.onMessage?.(msg);
      }
    }

    // Thinking/reasoning → thinking (sender skips these)
    if (step.reasoning_content && step.reasoning_content.trim()) {
      const msg: ClaudeMessage = {
        type: "thinking",
        content: step.reasoning_content,
      };
      opts.onMessage?.(msg);
    }

    // Final text response → text message
    if (step.message && step.message.trim() && step.source === "agent") {
      const msg: ClaudeMessage = {
        type: "text",
        content: step.message,
      };
      opts.onMessage?.(msg);
      opts.onChunk?.(step.message + "\n");
    }
  }

  // Curated set of common Devin model aliases. Devin supports hundreds of
  // model variants (run `devin models list` for the full set); these short
  // aliases always resolve to the latest version in each family and cover
  // the vast majority of use-cases. Any string Devin accepts on `--model` works,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
