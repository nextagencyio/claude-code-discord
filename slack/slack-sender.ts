/**
 * slack-sender.ts — a `DiscordSender` implementation that posts into a Slack
 * thread. This lets the Slack agent REUSE the whole transport-agnostic
 * `createClaudeSender` formatting logic (assistant text, image attachments)
 * and only translate the resulting `MessageContent` (Discord embeds) into
 * Slack Block Kit sections. Note that sender drops all tool_use messages, so
 * the Slack thread carries conversation only — same as Discord.
 */
import type { DiscordSender } from "../claude/index.ts";
import type { MessageContent, EmbedData } from "../discord/types.ts";
import { postMessage } from "./slack-web.ts";

const MAX_BLOCK_TEXT = 2900; // Slack section text limit is 3000

/** Discord markdown → Slack mrkdwn (bold `**x**` → `*x*`). */
function toMrkdwn(s: string): string {
  return s.replace(/\*\*([^*]+)\*\*/g, "*$1*");
}

function clip(s: string): string {
  return s.length > MAX_BLOCK_TEXT ? s.slice(0, MAX_BLOCK_TEXT - 1) + "…" : s;
}

function embedToText(e: EmbedData): string {
  const parts: string[] = [];
  if (e.title) parts.push(`*${e.title}*`);
  if (e.description) parts.push(toMrkdwn(e.description));
  if (e.fields) for (const f of e.fields) parts.push(`*${f.name}*\n${toMrkdwn(f.value)}`);
  return clip(parts.join("\n"));
}

/**
 * Build a `DiscordSender` that posts each streamed `MessageContent` as a Slack
 * message in the given thread. Buttons/files are dropped (not needed while
 * streaming progress); the final PDF/email share-back is handled separately.
 */
export function createSlackThreadSender(botToken: string, channel: string, threadTs: string): DiscordSender {
  return {
    async sendMessage(content: MessageContent) {
      // deno-lint-ignore no-explicit-any
      const blocks: any[] = [];
      if (content.content) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: clip(toMrkdwn(content.content)) } });
      }
      for (const e of content.embeds ?? []) {
        const text = embedToText(e);
        if (text) blocks.push({ type: "section", text: { type: "mrkdwn", text } });
      }
      if (blocks.length === 0) return;
      const fallback = content.embeds?.[0]?.title || content.content || "update";
      await postMessage(botToken, { channel, thread_ts: threadTs, text: fallback, blocks });
    },
  };
}
