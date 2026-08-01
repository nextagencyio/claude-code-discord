/**
 * Shared process plumbing for the CLI-backed providers (agy, codex, opencode).
 *
 * Each of those CLIs works the same way: spawn it in the channel's working
 * directory, read stdout as it arrives, and parse structured output to stream
 * progress back to Discord. Only the argument list and the parsing differ, so
 * the spawn/stream/cancel machinery lives here once.
 *
 * Devin is NOT built on this — it streams by polling an ATIF export file
 * rather than by reading stdout, so it keeps its own loop.
 *
 * @module providers/cli-runner
 */

export interface RunCliOptions {
  bin: string;
  args: string[];
  cwd: string;
  controller: AbortController;
  /** Called for each complete stdout line, as it arrives. */
  onStdoutLine?: (line: string) => void;
  /** Called for each stderr chunk, as it arrives. */
  onStderrChunk?: (chunk: string) => void;
}

export interface RunCliResult {
  code: number;
  success: boolean;
  stdout: string;
  stderr: string;
  /** True when the run ended because the caller aborted it. */
  cancelled: boolean;
  /** Wall-clock duration in ms. */
  duration: number;
}

/**
 * Spawn a CLI and stream its output. Never throws on a non-zero exit — the
 * caller decides what a failure means (some CLIs exit non-zero on a refusal
 * that still produced a usable answer). Throws only if the binary can't be
 * spawned at all.
 */
export async function runCli(opts: RunCliOptions): Promise<RunCliResult> {
  const started = Date.now();

  const cmd = new Deno.Command(opts.bin, {
    args: opts.args,
    cwd: opts.cwd,
    stdout: "piped",
    stderr: "piped",
    signal: opts.controller.signal,
  });

  const child = cmd.spawn();

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  // Read stdout line-by-line. JSONL output arrives in arbitrary chunk
  // boundaries, so hold a partial line until its newline shows up — parsing a
  // half-written JSON object would drop the event.
  const stdoutPromise = (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        stdoutChunks.push(text);
        if (!opts.onStdoutLine) continue;

        buffer += text;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.trim()) opts.onStdoutLine(line);
        }
      }
      // Flush a trailing line with no newline (single-object JSON output).
      if (buffer.trim() && opts.onStdoutLine) opts.onStdoutLine(buffer);
    } catch {
      // Stream closed mid-read (typically a cancel) — the status check below
      // reports the real outcome.
    }
  })();

  const stderrPromise = (async () => {
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        stderrChunks.push(text);
        opts.onStderrChunk?.(text);
      }
    } catch {
      // As above.
    }
  })();

  let code = -1;
  let success = false;
  try {
    const [status] = await Promise.all([child.status, stdoutPromise, stderrPromise]);
    code = status.code;
    success = status.success;
  } catch (error) {
    // An aborted signal surfaces here on some platforms and resolves normally
    // on others, so cancellation is detected from the controller either way.
    if (!opts.controller.signal.aborted && (error as Error)?.name !== "AbortError") {
      throw error;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }

  return {
    code,
    success,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    cancelled: opts.controller.signal.aborted,
    duration: Date.now() - started,
  };
}

/** Parse a line as JSON, returning null instead of throwing on non-JSON. */
export function tryParseJson<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

/**
 * Is this CLI on the PATH? Every provider's isAvailable() runs a cheap
 * version/help probe; a non-zero exit or a missing binary both mean "no".
 */
export async function probeCli(bin: string, args: string[]): Promise<boolean> {
  try {
    const cmd = new Deno.Command(bin, { args, stdout: "null", stderr: "null" });
    const { success } = await cmd.output();
    return success;
  } catch {
    return false;
  }
}
