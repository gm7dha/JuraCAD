/**
 * The version history (CHANGELOG.md) read into versions and their changes,
 * for the "What's new" window. Only the parts that matter to someone using
 * JuraCAD are kept: the version, its title and its list of changes.
 */

export interface ChangelogVersion {
  /** "0.15" */
  version: string;
  /** "Replace face, conics, Group and Width mates" */
  title: string;
  /** Each change, as written (may contain **bold**). */
  changes: string[];
}

export function parseChangelog(text: string): ChangelogVersion[] {
  const out: ChangelogVersion[] = [];
  let current: ChangelogVersion | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const head = /^##\s+v?(\d+(?:\.\d+)*)\s*(?:[—–-]\s*(.*))?$/.exec(raw.trim());
    if (head) {
      // Drop the "· commit `abc1234`" note from the title.
      const title = (head[2] ?? "").replace(/\s*·\s*commit\s*`[^`]*`\s*$/i, "").trim();
      current = { version: head[1], title, changes: [] };
      out.push(current);
      continue;
    }
    if (!current) continue;
    if (/^#/.test(raw.trim())) {
      current = null;
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (bullet) current.changes.push(bullet[1].trim());
    else if (raw.trim() && current.changes.length && /^\s+/.test(raw)) {
      // A bullet carried on over the next line.
      current.changes[current.changes.length - 1] += ` ${raw.trim()}`;
    }
  }
  return out;
}

/** The entry for a version such as "0.15.0" or "0.15" (trailing ".0"s ignored), or undefined. */
export function changesFor(versions: ChangelogVersion[], version: string): ChangelogVersion | undefined {
  const short = (v: string) => v.replace(/^v/, "").replace(/(\.0)+$/, "");
  return versions.find((v) => short(v.version) === short(version));
}

/** Split text with **bold** parts into plain and bold pieces. */
export function boldPieces(text: string): { text: string; bold: boolean }[] {
  return text
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((t) => (t.startsWith("**") && t.endsWith("**") ? { text: t.slice(2, -2), bold: true } : { text: t.replace(/`/g, ""), bold: false }));
}
