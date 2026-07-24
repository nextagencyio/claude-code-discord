/**
 * pursuit-map.ts — explicit Slack channel → proposal-workspace mapping.
 *
 * The naming convention `sales-<abbrev>` ⇄ `proposals/<abbrev>-<year>/` is
 * unreliable (e.g. channel `sales-mplp-ai` ⇄ workspace `mplp-2026`), so the
 * agent resolves channels through this explicit config instead. Stored in the
 * rfpbids repo so it lives with the proposals it points at.
 */
export interface PursuitEntry {
  /** Proposal workspace dir name under proposals/, e.g. "mplp-2026". */
  slug: string;
}

export type PursuitMap = Record<string, PursuitEntry>;

/** Load channel_id → { slug } from the JSON config. Missing/invalid → {}. */
export async function loadPursuitMap(configPath: string): Promise<PursuitMap> {
  try {
    const content = await Deno.readTextFile(configPath);
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") return parsed as PursuitMap;
    return {};
  } catch {
    return {};
  }
}
