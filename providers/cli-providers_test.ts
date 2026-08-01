/**
 * End-to-end test for the stdout-streaming CLI providers: agy, codex, opencode.
 *
 * Exercises each adapter against the REAL CLI — no Discord needed:
 *   - isAvailable() detects the installed CLI
 *   - sendPrompt() returns the model's text
 *   - a session ID comes back, and resuming with it keeps context
 *   - cancellation aborts the run
 *
 * A provider whose CLI is not installed is SKIPPED, not failed — these are
 * optional backends and the host may only have some of them.
 *
 * Run: deno run --allow-all providers/cli-providers_test.ts [name ...]
 */
import type { AIProvider } from "./types.ts";
import type { ClaudeMessage } from "../claude/types.ts";
import { AgyProvider } from "./agy.ts";
import { CodexProvider } from "./codex.ts";
import { OpencodeProvider } from "./opencode.ts";

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(cond: boolean, label: string) {
  if (cond) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

async function testProvider(provider: AIProvider) {
  console.log(`\n=== ${provider.displayName} (${provider.name}) ===`);

  if (!(await provider.isAvailable())) {
    console.log(`  ⏭️  SKIPPED — ${provider.name} CLI not installed`);
    skipped++;
    return;
  }
  assert(true, "isAvailable() reports the CLI is installed");

  const workDir = await Deno.makeTempDir({ prefix: `${provider.name}-test-` });

  // --- First turn: a fact the model can only repeat back if it answered. ---
  const messages: ClaudeMessage[] = [];
  const controller = new AbortController();
  const first = await provider.sendPrompt({
    workDir,
    prompt: "Remember the word BANANA. Reply with exactly: FIRST_OK",
    controller,
    onMessage: (m) => messages.push(m),
  });

  console.log(`  response: ${JSON.stringify(first.response.slice(0, 120))}`);
  console.log(`  sessionId: ${first.sessionId}`);
  assert(first.response.includes("FIRST_OK"), "first turn returns the model's text");
  assert(messages.some((m) => m.type === "text"), "streamed at least one text message");
  assert(!!first.sessionId, "a session ID came back for resuming");

  // --- Resume: the CLI should still have the earlier turn in context. ---
  if (first.sessionId) {
    const second = await provider.sendPrompt({
      workDir,
      prompt: "What word did I ask you to remember? Reply with just that word.",
      controller: new AbortController(),
      sessionId: first.sessionId,
    });
    console.log(`  resumed response: ${JSON.stringify(second.response.slice(0, 120))}`);
    assert(
      second.response.toUpperCase().includes("BANANA"),
      "resuming with the session ID preserves context",
    );
  }

  // --- Cancellation: abort shortly after start. ---
  const cancelController = new AbortController();
  setTimeout(() => cancelController.abort(), 1500);
  const cancelled = await provider.sendPrompt({
    workDir,
    prompt: "Count slowly from 1 to 500, one number per line.",
    controller: cancelController,
  });
  assert(cancelled.response === "Request was cancelled", "aborting returns the cancelled sentinel");

  await Deno.remove(workDir, { recursive: true }).catch(() => {});
}

async function main() {
  const all: AIProvider[] = [new AgyProvider(), new CodexProvider(), new OpencodeProvider()];
  const only = Deno.args.filter((a) => !a.startsWith("-"));
  const selected = only.length ? all.filter((p) => only.includes(p.name)) : all;

  for (const provider of selected) {
    try {
      await testProvider(provider);
    } catch (error) {
      console.log(`  ❌ threw: ${error instanceof Error ? error.message : String(error)}`);
      failed++;
    }
  }

  console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
  if (failed > 0) Deno.exit(1);
}

if (import.meta.main) await main();
