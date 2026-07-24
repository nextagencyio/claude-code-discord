/**
 * partner-check.ts — defense-in-depth partner firewall for the Slack agent.
 *
 * Mirrors web/lib/partner-guard.ts's workspace scan (which the Deno bot can't
 * import — it's a Node module under web/): the rfpbids Slack app is
 * Simple-Spark-only, so Promet/Provus/Axelerant proposals must never be edited
 * or shared here. Scans a proposal workspace's notes + TOKENS for stack markers.
 */
const PARTNER_MARKERS: RegExp[] = [
  /prometdemo\.cloud/i,
  /promet-canvas/i,
  /\bpromet\b/i,
  /\bprovus\b/i,
  /\baxelerant\b/i,
  /stack\s*=\s*(promet|provus|promet-canvas)/i,
];

/** True if the proposal workspace looks like a partner (non-Simple-Spark) project. */
export async function isPartnerWorkspace(proposalDir: string): Promise<boolean> {
  const candidates: string[] = [];
  try {
    for await (const entry of Deno.readDir(`${proposalDir}/notes`)) {
      if (entry.isFile && entry.name.endsWith(".md")) {
        candidates.push(`${proposalDir}/notes/${entry.name}`);
      }
    }
  } catch {
    // no notes dir — fall through
  }
  candidates.push(`${proposalDir}/proposal-alt/TOKENS.md`);
  candidates.push(`${proposalDir}/README.md`);

  for (const path of candidates) {
    try {
      const text = await Deno.readTextFile(path);
      // Ignore negated clauses like "not Axelerant" / "not a Promet build".
      const stripped = text.replace(/\bnot\s+(a\s+)?(promet|provus|axelerant)/gi, "");
      if (PARTNER_MARKERS.some((re) => re.test(stripped))) return true;
    } catch {
      // unreadable/missing — skip
    }
  }
  return false;
}
