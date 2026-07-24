/**
 * slack-web.ts — thin fetch wrappers for the Slack Web API used by the
 * rfpbids proposal agent (a separate `rfpbids-agent` Slack app running in
 * Socket Mode). Deliberately dependency-free (native fetch/WebSocket) so it
 * runs under Deno without npm interop.
 *
 * Two tokens are in play:
 *   - APP-level token (xapp-…)  → only apps.connections.open (Socket Mode)
 *   - BOT token       (xoxb-…)  → auth.test, users.lookupByEmail, chat.postMessage
 */

// deno-lint-ignore no-explicit-any
type Json = any;

async function callWeb(token: string, method: string, body: Record<string, unknown>): Promise<Json> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  return await res.json();
}

/** Returns the bot's own user id (for the self/loop guard). */
export async function authTest(botToken: string): Promise<{ ok: boolean; user_id?: string; error?: string }> {
  return await callWeb(botToken, "auth.test", {});
}

/**
 * Resolve an email to a Slack user id. users.lookupByEmail is a read method —
 * Slack read methods ignore JSON bodies, so params go on the query string.
 */
export async function lookupUserByEmail(botToken: string, email: string): Promise<string | null> {
  const res = await fetch(
    `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${botToken}` } },
  );
  const json = await res.json();
  return json.ok ? (json.user.id as string) : null;
}

export interface SlackPostMessage {
  channel: string;
  text?: string;
  // deno-lint-ignore no-explicit-any
  blocks?: any[];
  thread_ts?: string;
}

/** Post into a channel/thread. Returns the message ts, or null on failure. */
export async function postMessage(botToken: string, msg: SlackPostMessage): Promise<string | null> {
  const json = await callWeb(botToken, "chat.postMessage", {
    channel: msg.channel,
    ...(msg.text ? { text: msg.text } : {}),
    ...(msg.blocks ? { blocks: msg.blocks } : {}),
    ...(msg.thread_ts ? { thread_ts: msg.thread_ts } : {}),
    unfurl_links: false,
    unfurl_media: false,
  });
  if (!json.ok) {
    console.error(`[slack-agent] chat.postMessage failed: ${json.error}`);
    return null;
  }
  return json.ts as string;
}

/** Open a Socket Mode connection; returns the wss URL to dial. Uses the APP token. */
export async function openSocketConnection(appToken: string): Promise<string> {
  const json = await callWeb(appToken, "apps.connections.open", {});
  if (!json.ok) throw new Error(`apps.connections.open failed: ${json.error}`);
  return json.url as string;
}
