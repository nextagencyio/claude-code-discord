/**
 * Agency CLI provider (`agy`).
 *
 * Invocation: `agy --print --output-format json` emits ONE JSON object on
 * completion (not a stream). Confirmed shape:
 *
 *   {"conversation_id":"13a1…","status":"SUCCESS","response":"…",
 *    "duration_seconds":1.29,"num_turns":1,
 *    "usage":{"input_tokens":…,"output_tokens":…,"cache_read_tokens":…}}
 *
 * `conversation_id` is the session ID; resuming is `--conversation <id>`.
 * No model flag is passed — agy uses whatever its own config selects.
 *
 * GOTCHA: agy parses flags Go-style, so parsing STOPS at the first
 * non-flag argument. Every flag must precede the prompt or it is silently
 * ignored — a misplaced --dangerously-skip-permissions leaves the run
 * auto-denying tool permissions it cannot prompt for, and it exits with no
 * output at all.
 *
 * @module providers/agy
 */
import type { AIProvider, PromptOptions, ProviderResult } from "./types.ts";
import { probeCli, runCli, tryParseJson } from "./cli-runner.ts";

interface AgyResult {
  conversation_id?: string;
  status?: string;
  response?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
}

export class AgyProvider implements AIProvider {
  name = "agy";
  displayName = "Agency CLI";

  async sendPrompt(opts: PromptOptions): Promise<ProviderResult> {
    const bin = Deno.env.get("AGY_PATH") || "agy";

    // Flags FIRST — see the Go-flag gotcha above.
    const args: string[] = ["--dangerously-skip-permissions", "--output-format", "json"];

    if (opts.continueMode) {
      args.push("--continue");
    } else if (opts.sessionId) {
      args.push("--conversation", opts.sessionId);
    }

    // --print takes the prompt as its value, which also keeps the prompt from
    // being read as a bare positional that would terminate flag parsing early.
    args.push("--print", opts.prompt);

    const result = await runCli({
      bin,
      args,
      cwd: opts.workDir,
      controller: opts.controller,
    });

    if (result.cancelled) {
      return { response: "Request was cancelled" };
    }

    // agy buffers to a single JSON object, so there is nothing to stream —
    // parse the whole of stdout at the end.
    const parsed = tryParseJson<AgyResult>(result.stdout.trim());

    if (!parsed) {
      if (!result.success) {
        throw new Error(
          `Agency CLI exited with code ${result.code}. stderr: ${result.stderr.substring(0, 1000)}`,
        );
      }
      // Exit 0 but unparseable — hand back the raw text rather than nothing.
      return {
        response: result.stdout.trim() || "No response received",
        duration: result.duration,
        stderrOutput: result.stderr,
      };
    }

    const text = parsed.response?.trim() || "";
    if (text) {
      opts.onMessage?.({ type: "text", content: text });
      opts.onChunk?.(text + "\n");
    }

    if (parsed.status && parsed.status !== "SUCCESS" && !text) {
      throw new Error(
        `Agency CLI returned status ${parsed.status}. stderr: ${result.stderr.substring(0, 1000)}`,
      );
    }

    return {
      response: text || "No response received",
      sessionId: parsed.conversation_id,
      duration: parsed.duration_seconds !== undefined
        ? Math.round(parsed.duration_seconds * 1000)
        : result.duration,
      stderrOutput: result.stderr,
      tokenUsage: parsed.usage
        ? {
          promptTokens: parsed.usage.input_tokens,
          completionTokens: parsed.usage.output_tokens,
          cachedTokens: parsed.usage.cache_read_tokens,
        }
        : undefined,
    };
  }

  isAvailable(): Promise<boolean> {
    // agy has no --version flag; `models` is a cheap subcommand that exits 0
    // only when the CLI is installed and configured.
    return probeCli(Deno.env.get("AGY_PATH") || "agy", ["models"]);
  }
}
