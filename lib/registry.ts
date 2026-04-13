// skills.sh registry integration — best-effort HTML scrape.
//
// There is no public JSON API for skills.sh as of 2026-04. This module
// fetches the rendered page and extracts a small set of fields with
// anchored regexes. If they restyle the page the parse will silently
// degrade to "unavailable" and the UI falls back to a plain link.

export type AuditStatus = "pass" | "warn" | "fail";
export interface Audit {
  provider: string;
  status: AuditStatus;
}

export interface RegistryEntry {
  found: boolean;
  url: string;
  owner: string;
  name: string;
  installs?: string;       // formatted, e.g. "993.7K"
  stars?: string;          // formatted, e.g. "13.9K"
  firstSeen?: string;      // e.g. "Jan 26, 2026"
  installCommand?: string; // e.g. "npx skills add ..."
  audits: Audit[];
  fetchedAt: string;       // ISO
  source: "skills.sh";
}

const TTL_MS = 60 * 60 * 1000; // 1h
const cache = new Map<string, { at: number; data: RegistryEntry }>();

function norm(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function parseAudits(html: string): Audit[] {
  const audits: Audit[] = [];
  const rx = /truncate">([^<]+)<\/span><span class="text-xs font-mono uppercase[^"]*(green|amber|red|yellow|orange)[^"]*">(Pass|Warn|Fail)<\/span>/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(html))) {
    audits.push({
      provider: norm(m[1]),
      status: m[3].toLowerCase() as AuditStatus,
    });
  }
  return audits;
}

function pluck(html: string, re: RegExp): string | undefined {
  const m = html.match(re);
  return m ? norm(m[1]) : undefined;
}

export async function lookup(owner: string, name: string): Promise<RegistryEntry> {
  const key = `${owner}/${name}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.data;

  const url = `https://skills.sh/${encodeURIComponent(owner)}/skills/${encodeURIComponent(name)}`;
  const entry: RegistryEntry = {
    found: false,
    url,
    owner,
    name,
    audits: [],
    fetchedAt: new Date().toISOString(),
    source: "skills.sh",
  };

  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": "CCSkill/0.1 (+local tool)",
        accept: "text/html",
      },
      // @ts-expect-error Bun supports signal
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      cache.set(key, { at: now, data: entry });
      return entry;
    }
    const html = await res.text();

    // Presence heuristic — the "Weekly Installs" label is on every skill page.
    if (!/Weekly Installs/.test(html)) {
      cache.set(key, { at: now, data: entry });
      return entry;
    }

    entry.found = true;
    entry.installs = pluck(
      html,
      /Weekly Installs<\/span><\/div><div[^>]*>([^<]+)</s,
    );
    entry.firstSeen = pluck(
      html,
      /First Seen<\/span><\/div><div[^>]*>([^<]+)</s,
    );
    entry.installCommand = pluck(html, /(npx skills add [^<]{5,240})/);
    const starsMatch = html.match(
      /GitHub Stars<\/span><\/div>[\s\S]*?<\/svg>\s*<span>([^<]+)<\/span>/,
    );
    if (starsMatch) entry.stars = norm(starsMatch[1]);
    entry.audits = parseAudits(html);
  } catch {
    // network error, timeout, etc. — treat as "not found", cache briefly
  }

  cache.set(key, { at: now, data: entry });
  return entry;
}

/** Resolve a likely (owner, name) for skills.sh from what we know locally. */
export function resolveOwner(opts: {
  provenance?: { source: string; owner?: string; repo?: string };
  symlinkTarget?: string | null;
  skillName: string;
  frontmatter?: Record<string, string>;
}): { owner?: string; name: string } {
  const { provenance, symlinkTarget, skillName, frontmatter } = opts;

  // 1. Plugin skills: provenance already has owner/repo
  if (provenance?.owner) {
    return { owner: provenance.owner, name: skillName };
  }

  // 2. Frontmatter hint (author like "org/repo" or "org")
  const fmAuthor = frontmatter?.author ?? frontmatter?.["metadata.author"];
  if (fmAuthor) {
    const m = fmAuthor.match(/([A-Za-z0-9_-]+)(?:\/[A-Za-z0-9_.-]+)?/);
    if (m) return { owner: m[1], name: skillName };
  }

  // 3. Symlink target may reveal a github-style path
  if (symlinkTarget) {
    const m = symlinkTarget.match(
      /(?:github\.com\/|marketplaces\/|\.agents\/skills\/)([A-Za-z0-9_-]+)/,
    );
    if (m) return { owner: m[1], name: skillName };
  }

  return { owner: undefined, name: skillName };
}
