// Persistent scan-report storage. Files live at ~/.claude/ccskill/reports/.
//
// Naming: `<ISO-date>_<slug>.json` — sortable, human-readable, filesystem-safe.
// Every path operation is constrained to the reports dir; `id` is never
// interpolated into a path until it's matched against the listing.

import { readdir, readFile, writeFile, stat, unlink, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".claude", "ccskill", "reports");

export interface SavedReportMeta {
  id: string;            // filename without .json
  savedAt: string;       // ISO, also embedded in filename
  label: string;         // user-facing title
  size: number;          // bytes on disk
  summary?: unknown;     // pulled from the payload if present
  scanTotal?: number;    // number of skills scanned, if present
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s.-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60) || "report";
}

async function ensureDir() {
  await mkdir(DIR, { recursive: true });
}

export async function saveReport(
  payload: unknown,
  opts: { label?: string } = {},
): Promise<SavedReportMeta> {
  await ensureDir();
  const now = new Date();
  const iso = now.toISOString().replace(/[:.]/g, "-");
  const label = opts.label?.trim() || "scan";
  const id = `${iso}_${slugify(label)}`;
  const filePath = join(DIR, `${id}.json`);
  const body = JSON.stringify(
    { savedAt: now.toISOString(), label, payload },
    null,
    2,
  );
  await writeFile(filePath, body, "utf8");
  const s = await stat(filePath);
  return {
    id,
    savedAt: now.toISOString(),
    label,
    size: s.size,
    summary: (payload as any)?.summary,
    scanTotal: (payload as any)?.total ?? (payload as any)?.entries?.length,
  };
}

export async function listReports(): Promise<SavedReportMeta[]> {
  await ensureDir();
  const names = await readdir(DIR).catch(() => []);
  const out: SavedReportMeta[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    const full = join(DIR, name);
    try {
      const s = await stat(full);
      let savedAt = s.mtime.toISOString();
      let label = id;
      let summary: unknown;
      let scanTotal: number | undefined;
      try {
        const text = await readFile(full, "utf8");
        const j = JSON.parse(text);
        if (j?.savedAt) savedAt = j.savedAt;
        if (j?.label) label = j.label;
        summary = j?.payload?.summary;
        scanTotal = j?.payload?.total ?? j?.payload?.entries?.length;
      } catch { /* corrupt or unreadable — fall through with filename */ }
      out.push({ id, savedAt, label, size: s.size, summary, scanTotal });
    } catch { /* vanished between readdir and stat */ }
  }
  // newest first
  out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return out;
}

function assertIdSafe(id: string) {
  // Must match our slug format, no path separators, no dotfiles, no spaces.
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("invalid report id");
  if (id.startsWith(".")) throw new Error("invalid report id");
}

export async function loadReport(id: string): Promise<unknown> {
  assertIdSafe(id);
  const full = join(DIR, `${id}.json`);
  const text = await readFile(full, "utf8");
  const j = JSON.parse(text);
  return j.payload;
}

export async function deleteReport(id: string): Promise<void> {
  assertIdSafe(id);
  const full = join(DIR, `${id}.json`);
  await unlink(full);
}

export const REPORTS_DIR = DIR;
