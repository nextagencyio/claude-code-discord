/**
 * agent.ts — the rfpbids Slack proposal agent (Phase 0).
 *
 * Lets an allow-listed user (Josh/Jay) drive proposal edits + email drafts by
 * replying to a dedicated `rfpbids-agent` Slack app in a pursuit channel. It
 * runs the AI CLI against that proposal's workspace and streams progress back
 * into the thread — the Slack analogue of this repo's Discord relay.
 *
 * Self-contained: it reuses the transport-agnostic Claude layer
 * (sendToClaudeCode + convertToClaudeMessages + createClaudeSender) and manages
 * its own per-thread sessions + per-slug serialization. index.ts only calls
 * startSlackAgent() — a no-op unless SLACK_APP_TOKEN + SLACK_AGENT_BOT_TOKEN
 * are set, so the Discord path is untouched.
 *
 * Scope (Phase 0): proposal edits + submission-email drafting/revision only.
 * No PDF share-back and no email sending here — delivery stays human-gated.
 */
import { convertToClaudeMessages, createClaudeSender, sendToClaudeCode } from "../claude/index.ts";
import { authTest, lookupUserByEmail, openSocketConnection, postMessage } from "./slack-web.ts";
import { createSlackThreadSender } from "./slack-sender.ts";
import { loadPursuitMap, type PursuitMap } from "./pursuit-map.ts";
import { isPartnerWorkspace } from "./partner-check.ts";

interface SlackSession {
  slug: string;
  sessionId?: string;
}

interface SlugState {
  busy: boolean;
  queue: Array<() => Promise<void>>;
}

function buildScopedPrompt(slug: string, proposalDir: string, userText: string): string {
  return [
    `[rfpbids proposal agent — scoped Slack session]`,
    `You are working ONLY inside the proposal workspace: ${proposalDir} (slug: ${slug}).`,
    `Allowed work, and nothing else:`,
    `  (a) edits to THIS proposal's files (deck source, notes, etc.);`,
    `  (b) drafting or revising its submission email at notes/submission-email.md.`,
    `If the deck source changed and it's clearly wanted, you may rebuild the PDF with`,
    `proposal-alt/build-deck.mjs (env CHROME_PATH=/usr/bin/google-chrome, node on PATH).`,
    `HARD LIMITS — refuse and briefly explain if asked to do any of these:`,
    `  - touch other proposals or files outside this workspace;`,
    `  - send email, run "git push"/commit, or post to Slack or any external service.`,
    `Delivery (sending the email, sharing the PDF) is handled by the operator, not you.`,
    `If the request concerns the submission email: after writing/revising`,
    `notes/submission-email.md, paste the full current draft (subject line + body) in`,
    `your final reply so the team can read it right here in the thread.`,
    `Keep replies concise — this is a Slack thread.`,
    ``,
    `Request from the team:`,
    userText.trim() || "(no text provided — ask what they'd like changed)",
  ].join("\n");
}

export async function startSlackAgent(opts: { workDir: string }): Promise<void> {
  const appToken = Deno.env.get("SLACK_APP_TOKEN");
  const botToken = Deno.env.get("SLACK_AGENT_BOT_TOKEN");
  const allowlistSpec = Deno.env.get("SLACK_AGENT_ALLOWLIST") || "";

  // No-op unless explicitly configured — keeps the Discord bot unaffected.
  if (!appToken || !botToken) return;

  const { workDir } = opts;
  const rfpbidsDir = `${workDir}/rfpbids`;
  const pursuitConfigPath = `${rfpbidsDir}/config/slack-pursuits.json`;
  const sessionStatePath = `${workDir}/.slack-sessions.json`;

  // --- Identity + allow-list -------------------------------------------------
  const auth = await authTest(botToken);
  if (!auth.ok || !auth.user_id) {
    console.error(`[slack-agent] auth.test failed (${auth.error ?? "unknown"}) — not starting`);
    return;
  }
  const botUserId = auth.user_id;

  const allowedUserIds = new Set<string>();
  for (const item of allowlistSpec.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (item.startsWith("U") || item.startsWith("W")) {
      allowedUserIds.add(item);
    } else {
      const id = await lookupUserByEmail(botToken, item);
      if (id) allowedUserIds.add(id);
      else console.warn(`[slack-agent] could not resolve allow-list entry: ${item}`);
    }
  }
  if (allowedUserIds.size === 0) {
    console.warn("[slack-agent] allow-list empty (set SLACK_AGENT_ALLOWLIST) — refusing to start");
    return;
  }

  // --- Pursuit map + sessions ------------------------------------------------
  const pursuitMap: PursuitMap = await loadPursuitMap(pursuitConfigPath);
  const sessions = new Map<string, SlackSession>(); // threadKey -> session
  const slugLocks = new Map<string, SlugState>();

  try {
    const saved = JSON.parse(await Deno.readTextFile(sessionStatePath)) as Record<string, SlackSession>;
    for (const [k, v] of Object.entries(saved)) sessions.set(k, v);
  } catch {
    // fresh
  }
  const saveSessions = async () => {
    try {
      const obj: Record<string, SlackSession> = {};
      for (const [k, v] of sessions) obj[k] = v;
      await Deno.writeTextFile(sessionStatePath, JSON.stringify(obj, null, 2));
    } catch (e) {
      console.warn("[slack-agent] could not persist sessions:", e instanceof Error ? e.message : String(e));
    }
  };

  console.log(
    `[slack-agent] started — bot=${botUserId}, ${allowedUserIds.size} allowed user(s), ` +
      `${Object.keys(pursuitMap).length} mapped channel(s)`,
  );

  // --- Per-slug serialization (one Claude run per proposal at a time) --------
  const drainSlug = async (slug: string) => {
    const state = slugLocks.get(slug);
    if (!state || state.busy) return;
    const next = state.queue.shift();
    if (!next) return;
    state.busy = true;
    try {
      await next();
    } catch (e) {
      console.error(`[slack-agent] request error (${slug}):`, e instanceof Error ? e.message : String(e));
    } finally {
      state.busy = false;
    }
    void drainSlug(slug);
  };
  const enqueueForSlug = (slug: string, fn: () => Promise<void>) => {
    let state = slugLocks.get(slug);
    if (!state) {
      state = { busy: false, queue: [] };
      slugLocks.set(slug, state);
    }
    state.queue.push(fn);
    void drainSlug(slug);
  };

  // --- Handle one request ----------------------------------------------------
  const handleRequest = async (channel: string, threadTs: string, rawText: string) => {
    const entry = pursuitMap[channel];
    if (!entry) return; // unmapped — caller decides whether to reply
    const slug = entry.slug;
    const proposalDir = `${rfpbidsDir}/proposals/${slug}`;

    if (await isPartnerWorkspace(proposalDir)) {
      await postMessage(botToken, {
        channel,
        thread_ts: threadTs,
        text: `That proposal looks like a partner (Promet / Provus / Axelerant) project — I can't edit it from here.`,
      });
      return;
    }

    // Recognize the thread immediately so follow-up replies are picked up even
    // while this first request is still running.
    const threadKey = `${channel}:${threadTs}`;
    if (!sessions.has(threadKey)) sessions.set(threadKey, { slug });

    enqueueForSlug(slug, async () => {
      const session = sessions.get(threadKey)!;
      const controller = new AbortController();
      const sender = createClaudeSender(createSlackThreadSender(botToken, channel, threadTs));

      // Serialize streamed sends so thread order is preserved.
      let sendChain: Promise<void> = Promise.resolve();
      // deno-lint-ignore no-explicit-any
      const onStreamJson = (json: any) => {
        const msgs = convertToClaudeMessages(json);
        if (!msgs.length) return;
        sendChain = sendChain.then(() => sender(msgs)).catch((e) =>
          console.error("[slack-agent] send error:", e instanceof Error ? e.message : String(e))
        );
      };

      await postMessage(botToken, { channel, thread_ts: threadTs, text: `On it — working on *${slug}*…` });

      try {
        const result = await sendToClaudeCode(
          proposalDir, // cwd
          buildScopedPrompt(slug, proposalDir, rawText),
          controller,
          session.sessionId, // resume the thread's session
          undefined, // onChunk
          onStreamJson,
          false, // continueMode
          {}, // modelOptions (default)
          proposalDir, // workspaceRootDir — tight write guard (this proposal only)
          undefined, // mcpServers
        );
        await sendChain; // flush pending sends before the closer
        session.sessionId = result.sessionId;
        await saveSessions();
        await postMessage(botToken, {
          channel,
          thread_ts: threadTs,
          text: `Done. Reply in this thread to revise. (Nothing was sent or shared — that stays with the operator.)`,
        });
      } catch (e) {
        await sendChain.catch(() => {});
        await postMessage(botToken, {
          channel,
          thread_ts: threadTs,
          text: `Ran into a problem: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    });
  };

  // --- Event routing ---------------------------------------------------------
  const stripMention = (t: string) => t.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();

  // deno-lint-ignore no-explicit-any
  const onEvent = async (event: any) => {
    if (!event || typeof event !== "object") return;
    if (event.bot_id) return; // never react to bot posts (incl. our own)
    if (event.user === botUserId) return;
    if (event.subtype) return; // edits/joins/deletes/etc.
    const { type, channel, user } = event;
    if (type !== "app_mention" && type !== "message") return;
    if (!channel || !user) return;
    if (!allowedUserIds.has(user)) return; // Josh/Jay only

    if (type === "app_mention") {
      // Start (or continue) a thread rooted at the mention.
      const threadTs: string = event.thread_ts || event.ts;
      if (!pursuitMap[channel]) {
        await postMessage(botToken, {
          channel,
          thread_ts: threadTs,
          text: `I'm not mapped to a proposal for this channel yet — ask Jay to add it to slack-pursuits.json.`,
        });
        return;
      }
      await handleRequest(channel, threadTs, stripMention(event.text || ""));
      return;
    }

    // type === "message": only plain thread replies in a KNOWN agent thread.
    // Mentions are handled by app_mention above, so skip messages that mention us.
    const text: string = event.text || "";
    if (text.includes(`<@${botUserId}>`)) return;
    const threadTs: string | undefined = event.thread_ts;
    if (!threadTs) return; // not a thread reply
    const threadKey = `${channel}:${threadTs}`;
    if (!sessions.has(threadKey)) return; // not a thread we own
    if (!pursuitMap[channel]) return;
    await handleRequest(channel, threadTs, text);
  };

  // --- Socket Mode connection loop (auto-reconnect) --------------------------
  const connect = async () => {
    let url: string;
    try {
      url = await openSocketConnection(appToken);
    } catch (e) {
      console.error("[slack-agent] connection open failed — retrying in 5s:", e instanceof Error ? e.message : String(e));
      setTimeout(() => void connect(), 5000);
      return;
    }
    const ws = new WebSocket(url);
    ws.onopen = () => console.log("[slack-agent] socket connected");
    // deno-lint-ignore no-explicit-any
    ws.onerror = (e: any) => console.error("[slack-agent] socket error:", e?.message ?? "error");
    ws.onclose = () => {
      console.warn("[slack-agent] socket closed — reconnecting in 2s");
      setTimeout(() => void connect(), 2000);
    };
    ws.onmessage = (ev: MessageEvent) => {
      // deno-lint-ignore no-explicit-any
      let env: any;
      try {
        env = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (!env || typeof env !== "object") return;
      // Ack anything with an envelope_id immediately (Slack requires < 3s).
      if (env.envelope_id) {
        try {
          ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
        } catch {
          // socket already gone
        }
      }
      if (env.type === "disconnect") {
        console.warn(`[slack-agent] server asked to disconnect (${env.reason ?? "?"})`);
        try {
          ws.close();
        } catch {
          // ignore
        }
        return;
      }
      if (env.type === "events_api" && env.payload?.event) {
        void onEvent(env.payload.event);
      }
    };
  };

  await connect();
}
