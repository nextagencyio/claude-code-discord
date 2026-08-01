/**
 * OpenAI Codex CLI provider (`codex exec`).
 *
 * Invocation: `codex exec --json` prints JSONL events to stdout. The shapes we
 * consume, confirmed against codex-cli 0.145.0:
 *
 *   {"type":"thread.started","thread_id":"019f…"}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
 *   {"type":"turn.completed","usage":{"input_tokens":…,"output_tokens":…}}
 *
 * `thread_id` is the session ID; resuming is `codex exec resume <thread_id>`.
 * No model flag is passed — codex uses whatever `~/.codex/config.toml` sets.
 *
 * @module providers/codex
 */
import type { AIProvider, PromptOptions, ProviderResult } from "./types.ts";
import type { ClaudeMessage } from "../claude/types.ts";
import { probeCli, runCli, tryParseJson } from "./cli-runner.ts";

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    // Tool-call items carry a command/name depending on the item type.
    command?: string;
    name?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
}

export class CodexProvider implements AIProvider {
  name = "codex";
  displayName = "Codex CLI";

  async sendPrompt(opts: PromptOptions): Promise<ProviderResult> {
    const bin = Deno.env.get("CODEX_PATH") || "codex";

    const args = ["exec"];

    // `codex exec resume <id>` continues a thread; `resume --last` picks the
    // most recent one. Both take the prompt after the subcommand.
    if (opts.continueMode) {
      args.push("resume", "--last");
    } else if (opts.sessionId) {
      args.push("resume", opts.sessionId);
    }

    args.push(
      "--json",
      // The bot's working directories are not always git repos (a channel gets
      // a bare WORK_DIR/channel-name/), and codex refuses to start outside one.
      "--skip-git-repo-check",
      // The host is the sandbox here: the bot already runs the other providers
      // with permissions bypassed, and codex cannot prompt in print mode.
      "--dangerously-bypass-approvals-and-sandbox",
    );

    args.push(opts.prompt);

    let sessionId: string | undefined;
    let responseText = "";
    let tokenUsage: ProviderResult["tokenUsage"];

    const result = await runCli({
      bin,
      args,
      cwd: opts.workDir,
      controller: opts.controller,
      onStdoutLine: (line) => {
        const evt = tryParseJson<CodexEvent>(line);
        if (!evt) return;

        switch (evt.type) {
          case "thread.started":
            if (evt.thread_id) sessionId = evt.thread_id;
            break;

          case "item.completed": {
            const item = evt.item;
            if (!item) break;
            if (item.type === "agent_message" && item.text) {
              responseText += (responseText ? "\n" : "") + item.text;
              emit(opts, { type: "text", content: item.text });
            } else if (item.type && item.type !== "agent_message") {
              // Tool calls, reasoning, file changes — the Discord sender drops
              // these, but emitting keeps non-Discord consumers informed.
              emit(opts, {
                type: "tool_use",
                content: "",
                metadata: { name: item.name || item.type, input: item.command ? { command: item.command } : {} },
              });
            }
            break;
          }

          case "turn.completed":
            if (evt.usage) {
              tokenUsage = {
                promptTokens: evt.usage.input_tokens,
                completionTokens: evt.usage.output_tokens,
                cachedTokens: evt.usage.cached_input_tokens,
              };
            }
            break;
        }
      },
    });

    if (result.cancelled) {
      return { response: "Request was cancelled", sessionId };
    }

    if (!result.success && !responseText) {
      throw new Error(
        `Codex CLI exited with code ${result.code}. stderr: ${result.stderr.substring(0, 1000)}`,
      );
    }

    return {
      response: responseText || "No response received",
      sessionId,
      duration: result.duration,
      stderrOutput: result.stderr,
      tokenUsage,
    };
  }

  isAvailable(): Promise<boolean> {
    return probeCli(Deno.env.get("CODEX_PATH") || "codex", ["--version"]);
  }
}

function emit(opts: PromptOptions, msg: ClaudeMessage): void {
  opts.onMessage?.(msg);
  if (msg.type === "text" && msg.content) opts.onChunk?.(msg.content + "\n");
}
