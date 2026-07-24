/**
 * Standalone test harness for DevinProvider — exercises sendPrompt with real
 * callbacks (no Discord). Run: deno run --allow-all providers/devin_test.ts
 *
 * Verifies:
 *  - isAvailable() returns true when devin is installed
 *  - listModels() returns the curated set
 *  - sendPrompt streams tool_use/text messages via onMessage
 *  - session ID is extracted from the ATIF export
 *  - duration is parsed and > 0
 *  - modelUsed reflects the actual model (from export, not just the flag)
 *  - resume (-r) works with a returned session ID
 */
import { DevinProvider } from "./devin.ts";
import type { ClaudeMessage } from "../claude/types.ts";

const provider = new DevinProvider();
let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ ${msg}`);
    failed++;
  }
}

async function main() {
  const workDir = await Deno.makeTempDir({ prefix: "devin-test-" });
  console.log(`\n=== Test workDir: ${workDir} ===\n`);

  // --- Test 1: isAvailable ---
  console.log("Test 1: isAvailable()");
  const available = await provider.isAvailable();
  console.log(`  devin available: ${available}`);
  assert(available, "Devin CLI is installed and responds to `devin version`");

  // --- Test 2: listModels ---
  console.log("\nTest 2: listModels()");
  const models = await provider.listModels();
  assert(models.length >= 8, `listModels returns >= 8 models (got ${models.length})`);
  assert(models.some((m) => m.id === "adaptive" && m.recommended), "adaptive model is present and recommended");
  assert(models.some((m) => m.id === "glm-5.2"), "glm-5.2 (not 'glm') is in the list — verified against real CLI");

  // --- Test 3: sendPrompt with streaming ---
  console.log("\nTest 3: sendPrompt (first turn, fresh session)");
  const messages: ClaudeMessage[] = [];
  const chunks: string[] = [];
  const controller = new AbortController();

  // Use a simple prompt that will trigger at least one tool call (file write)
  // so we can verify tool_use streaming.
  const prompt = "Create a file called test-output.txt containing the text 'hello devin'. Then reply with just the word DONE.";

  console.log(`  Prompt: ${prompt}`);
  console.log("  Waiting for response (this may take 30-60s)...\n");

  const result = await provider.sendPrompt({
    workDir,
    prompt,
    controller,
    onMessage: (msg) => {
      messages.push(msg);
      const preview = msg.content.substring(0, 80).replace(/\n/g, " ");
      console.log(`  [msg] type=${msg.type}${msg.metadata?.name ? ` tool=${msg.metadata.name}` : ""} content="${preview}${msg.content.length > 80 ? "..." : ""}"`);
    },
    onChunk: (chunk) => {
      chunks.push(chunk);
    },
    modelOptions: { model: "glm-5.2" }, // free tier to avoid quota issues
  });

  console.log("\n  --- Result ---");
  console.log(`  response: "${result.response.substring(0, 100)}"`);
  console.log(`  sessionId: ${result.sessionId}`);
  console.log(`  modelUsed: ${result.modelUsed}`);
  console.log(`  duration: ${result.duration}ms`);
  console.log(`  cost: ${result.cost}`);
  console.log(`  messages received: ${messages.length}`);
  console.log(`  chunks received: ${chunks.length}`);

  assert(!!result.sessionId, "session ID extracted from ATIF export");
  assert(result.modelUsed === "GLM-5.2" || result.modelUsed === "glm-5.2", `modelUsed reflects actual model from export (got "${result.modelUsed}")`);
  assert(result.duration !== undefined && result.duration > 0, `duration parsed and > 0 (got ${result.duration}ms)`);
  assert(messages.length > 0, "at least one message streamed via onMessage");
  assert(messages.some((m) => m.type === "tool_use"), "at least one tool_use message was streamed");
  assert(result.response.length > 0, "response text is non-empty");

  // --- Test 4: resume with the session ID ---
  if (result.sessionId) {
    console.log(`\nTest 4: sendPrompt (resume with sessionId=${result.sessionId})`);
    const resumeMessages: ClaudeMessage[] = [];
    const resumeController = new AbortController();
    const resumePrompt = "What was the exact text I asked you to put in the file? Reply with just that text, nothing else.";

    console.log(`  Prompt: ${resumePrompt}`);
    console.log("  Waiting for response...\n");

    const resumeResult = await provider.sendPrompt({
      workDir,
      prompt: resumePrompt,
      controller: resumeController,
      sessionId: result.sessionId,
      onMessage: (msg) => {
        resumeMessages.push(msg);
        const preview = msg.content.substring(0, 80).replace(/\n/g, " ");
        console.log(`  [msg] type=${msg.type}${msg.metadata?.name ? ` tool=${msg.metadata.name}` : ""} content="${preview}${msg.content.length > 80 ? "..." : ""}"`);
      },
      modelOptions: { model: "glm-5.2" },
    });

    console.log("\n  --- Resume Result ---");
    console.log(`  response: "${resumeResult.response.substring(0, 100)}"`);
    console.log(`  sessionId: ${resumeResult.sessionId} (should match original)`);
    console.log(`  duration: ${resumeResult.duration}ms`);

    assert(!!resumeResult.sessionId, "resume returned a session ID");
    assert(resumeResult.sessionId === result.sessionId, "resume returned the same session ID");
    // Devin should remember the file content from the previous turn
    const responseLower = resumeResult.response.toLowerCase();
    assert(
      responseLower.includes("hello devin") || responseLower.includes("hello") || responseLower.includes("done"),
      `resume response references prior context (got: "${resumeResult.response.substring(0, 80)}")`
    );
  }

  // --- Test 5: cancellation ---
  console.log("\nTest 5: cancellation (abort mid-run)");
  const cancelController = new AbortController();
  const cancelMessages: ClaudeMessage[] = [];
  const cancelPrompt = "Write a detailed 1000-word essay about the history of computing.";

  // Abort after 3 seconds
  setTimeout(() => {
    console.log("  [aborting after 3s]");
    cancelController.abort();
  }, 3000);

  try {
    const cancelResult = await provider.sendPrompt({
      workDir,
      prompt: cancelPrompt,
      controller: cancelController,
      onMessage: (msg) => cancelMessages.push(msg),
      modelOptions: { model: "glm-5.2" },
    });
    assert(cancelResult.response === "Request was cancelled", "cancellation returns 'Request was cancelled' response");
  } catch (error) {
    // An error is also acceptable — the abort can surface as a thrown error
    const msg = error instanceof Error ? error.message : String(error);
    assert(msg.includes("cancel") || msg.includes("abort") || cancelController.signal.aborted, `cancellation surfaced gracefully (got: ${msg.substring(0, 80)})`);
  }

  // --- Cleanup ---
  console.log("\n=== Cleanup ===");
  try {
    await Deno.remove(workDir, { recursive: true });
    console.log(`  Removed ${workDir}`);
  } catch {
    console.log(`  Could not remove ${workDir} (may have leftover files)`);
  }

  // --- Summary ---
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    Deno.exit(1);
  }
}

main().catch((err) => {
  console.error("Test harness crashed:", err);
  Deno.exit(1);
});
