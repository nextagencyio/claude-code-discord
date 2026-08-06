/**
 * Seeds a new channel's folder with the notes shape the workspace convention
 * expects.
 *
 * A channel is a Claude session, and `WORK_DIR/<channel>/` is that session's
 * scratchpad — markdown notes, not a project checkout. The convention was
 * documented in CLAUDE.md and the README and then relied on every session
 * remembering to create the file, which is the least reliable way to establish
 * a convention. Seeding it means the shape exists before the first reply, and
 * a session that gets restarted mid-task finds a file to read rather than an
 * empty directory.
 *
 * NEVER overwrites. The seed is written only when no PROGRESS.md is present,
 * so a folder with real work in it — including the two legacy project folders
 * that still live under `workspace/` — is left exactly as it is.
 *
 * @module core/channel-notes
 */

/** Filename the convention is built around. Also what a resuming session reads first. */
export const PROGRESS_FILE = "PROGRESS.md";

/**
 * The starter file. Deliberately a template with empty sections rather than
 * prose: an empty heading invites filling in, while a paragraph explaining the
 * convention invites being deleted unread. The reminder of what this folder is
 * for sits at the BOTTOM, after the parts the session will actually edit.
 */
export function seedContent(channelName: string, nowISO: string): string {
  return `# ${channelName}

_Started ${nowISO.slice(0, 10)}. This file is how a restarted session picks up
where the last one left off — keep it current at real milestones, not every step._

## Task

<!-- What this channel is for, in a sentence or two. -->

## Decisions

<!-- Choices made and WHY, so they don't get relitigated or silently reversed. -->

## Done

## Next

## Key paths

<!-- Where the actual work lives — repo, branch, worktree, deploy target.
     This folder holds notes; the code is somewhere else. -->

---

**About this folder.** \`workspace/${channelName}/\` is this Claude session's
notes — markdown, screenshots, pasted context. The project you are working on
lives elsewhere on disk; \`cd\` there to do the work and keep the notes here.
See \`CLAUDE.md\` at the repo root for the routing table (most channels are
about \`~/nodejs/rfpbids\`).
`;
}

/**
 * Create the channel folder if needed and seed PROGRESS.md when absent.
 *
 * Never throws: a notes file is a convenience, and failing to write one must
 * not stop the session from answering. Returns whether a seed was written,
 * which is only used for the log line.
 */
export async function ensureChannelNotes(
  channelWorkDir: string,
  channelName: string,
): Promise<boolean> {
  try {
    await Deno.mkdir(channelWorkDir, { recursive: true });
  } catch {
    // Already exists — the common case after the first message.
  }

  const path = `${channelWorkDir}/${PROGRESS_FILE}`;
  try {
    await Deno.stat(path);
    return false; // Present already. Never overwrite.
  } catch {
    // Absent — fall through and seed it.
  }

  try {
    await Deno.writeTextFile(
      path,
      seedContent(channelName, new Date().toISOString()),
    );
    console.log(`[Session] Seeded ${path}`);
    return true;
  } catch (err) {
    console.error(`[Session] Could not seed ${path}: ${err}`);
    return false;
  }
}
