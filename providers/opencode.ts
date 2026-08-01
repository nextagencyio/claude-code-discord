/**
 * opencode CLI provider (`opencode run`).
 *
 * Invocation: `opencode run --format json` streams JSONL events to stdout.
 * Confirmed shapes (opencode 1.18.11) — every event carries `sessionID`:
 *
 *   {"type":"step_start","sessionID":"ses_04…","part":{…}}
 *   {"type":"text","sessionID":"ses_04…","part":{"type":"text","text":"…"}}
 *   {"type":"tool","sessionID":"ses_04…","part":{"type":"tool","tool":"bash",…}}
 *   {"type":"step_finish","sessionID":"ses_04…",
 *    "part":{"tokens":{"input":…,"output":…,"cache":{"read":…}},"cost":0}}
 *
 * Resuming is `-s <sessionID>`. No model flag is passed — opencode uses the
 * default model from its own config.
 *
 * @module providers/opencode
 */
import type { AIProvider, PromptOptions, ProviderResult } from "./types.ts";
import { probeCli, runCli, tryParseJson } from "./cli-runner.ts";

interface OpencodeEvent {
  type: string;
  sessionID?: string;
  part?: {
    type?: string;
    text?: string;
    tool?: string;
    // deno-lint-ignore no-explicit-any
    state?: any;
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
    cost?: number;
  };
}

export class OpencodeProvider implements AIProvider {
  name = "opencode";
  displayName = "opencode CLI";

  async sendPrompt(opts: PromptOptions): Promise<ProviderResult> {
    const bin = Deno.env.get("OPENCODE_PATH") || "opencode";

    const args = ["run", "--format", "json", "--auto"];

    if (opts.continueMode) {
      args.push("--continue");
    } else if (opts.sessionId) {
      args.push("--session", opts.sessionId);
    }

    // `--dir` rather than relying on cwd alone: opencode resolves its project
    // context from this flag when it starts its local server.
    args.push("--dir", opts.workDir);

    args.push(opts.prompt);

    let sessionId: string | undefined;
    let responseText = "";
    let cost: number | undefined;
    let tokenUsage: ProviderResult["tokenUsage"];

    const result = await runCli({
      bin,
      args,
      cwd: opts.workDir,
      controller: opts.controller,
      onStdoutLine: (line) => {
        const evt = tryParseJson<OpencodeEvent>(line);
        if (!evt) return;

        if (evt.sessionID && !sessionId) sessionId = evt.sessionID;

        switch (evt.type) {
          case "text": {
            const text = evt.part?.text;
            if (text) {
              responseText += (responseText ? "\n" : "") + text;
              opts.onMessage?.({ type: "text", content: text });
              opts.onChunk?.(text + "\n");
            }
            break;
          }

          case "tool":
            // Dropped by the Discord sender; emitted for other consumers.
            opts.onMessage?.({
              type: "tool_use",
              content: "",
              metadata: { name: evt.part?.tool || "tool", input: evt.part?.state ?? {} },
            });
            break;

          case "step_finish": {
            const t = evt.part?.tokens;
            if (t) {
              tokenUsage = {
                promptTokens: t.input,
                completionTokens: t.output,
                cachedTokens: t.cache?.read,
              };
            }
            // Cost accumulates across steps rather than being reported once.
            if (typeof evt.part?.cost === "number") {
              cost = (cost ?? 0) + evt.part.cost;
            }
            break;
          }
        }
      },
    });

    if (result.cancelled) {
      return { response: "Request was cancelled", sessionId };
    }

    if (!result.success && !responseText) {
      throw new Error(
        `opencode CLI exited with code ${result.code}. stderr: ${result.stderr.substring(0, 1000)}`,
      );
    }

    return {
      response: responseText || "No response received",
      sessionId,
      cost,
      duration: result.duration,
      stderrOutput: result.stderr,
      tokenUsage,
    };
  }

  isAvailable(): Promise<boolean> {
    return probeCli(Deno.env.get("OPENCODE_PATH") || "opencode", ["--version"]);
  }
}
