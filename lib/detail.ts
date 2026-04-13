import { readFile, readdir, stat, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

export interface FileNode {
  name: string;
  rel: string;
  size: number;
  isDir: boolean;
  isText: boolean;
}

export interface SkillDetail {
  name: string;
  path: string;
  exists: boolean;
  frontmatter: Record<string, string>;
  version?: string;
  author?: string;
  license?: string;
  body: string;            // SKILL.md body (without frontmatter), capped
  bodyTruncated: boolean;
  files: FileNode[];
  totalBytes: number;
  modifiedAt: string | null;  // ISO
  symlinkTarget: string | null;
  provenance: { source: string; owner?: string; repo?: string };
}

const MAX_BODY = 16000;
const MAX_SCAN_DEPTH = 4;

/**
 * Minimal YAML-ish frontmatter parser.
 *
 * Supports:
 *   - `key: value` (top-level)
 *   - Nested single level via indentation (spaces/tabs):
 *       metadata:
 *         version: 1.1.0
 *     The nested field is flattened to `metadata.version` AND stored as a
 *     multiline blob under `metadata` for backward compatibility.
 *
 * Unsupported (on purpose — skills don't need it): arrays, anchors, flow
 * style `{}`/`[]`, multiline `|`/`>` scalars, deeper nesting.
 */
function parseFrontmatter(src: string): { fm: Record<string, string>; body: string } {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: src };
  const out: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);

  let currentTopKey: string | null = null;
  let topBuf: string[] = [];

  const flushTop = () => {
    if (currentTopKey !== null) {
      const joined = topBuf.join("\n").trim();
      if (joined !== "") out[currentTopKey] = joined;
    }
    currentTopKey = null;
    topBuf = [];
  };

  for (const rawLine of lines) {
    const indented = /^(\s+)/.test(rawLine);
    if (!indented) {
      flushTop();
      const kv = rawLine.match(/^([A-Za-z_][A-Za-z0-9_.-]*):\s?(.*)$/);
      if (kv) {
        currentTopKey = kv[1];
        topBuf = [kv[2]];
      }
    } else if (currentTopKey) {
      // Nested child of the current top-level key.
      const child = rawLine.replace(/^\s+/, "");
      const ckv = child.match(/^([A-Za-z_][A-Za-z0-9_.-]*):\s?(.*)$/);
      if (ckv) {
        // Flatten: parent.child
        out[`${currentTopKey}.${ckv[1]}`] = ckv[2].trim();
      }
      // Keep the original indented line under the parent for backward compat.
      topBuf.push(rawLine);
    }
  }
  flushTop();
  return { fm: out, body: src.slice(m[0].length) };
}

function isLikelyText(name: string): boolean {
  return /\.(md|markdown|txt|json|yaml|yml|toml|js|mjs|cjs|ts|tsx|jsx|py|rb|sh|bash|zsh|fish|go|rs|java|c|cc|cpp|h|hpp|cs|swift|kt|php|pl|lua|r|html|htm|css|scss|sass|xml|sql|env|ini|conf|cfg|gitignore|editorconfig|lock)$/i.test(
    name,
  ) || !/\./.test(name);
}

async function walk(
  root: string,
  rel = "",
  depth = 0,
  out: FileNode[] = [],
): Promise<FileNode[]> {
  if (depth > MAX_SCAN_DEPTH) return out;
  let entries;
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rp = rel ? `${rel}/${e.name}` : e.name;
    const abs = join(root, rp);
    try {
      const s = await stat(abs);
      if (s.isDirectory()) {
        out.push({ name: e.name, rel: rp, size: 0, isDir: true, isText: false });
        await walk(root, rp, depth + 1, out);
      } else {
        out.push({
          name: e.name,
          rel: rp,
          size: s.size,
          isDir: false,
          isText: isLikelyText(e.name),
        });
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

function provenance(path: string): { source: string; owner?: string; repo?: string } {
  const home = homedir();
  const mp = `${home}/.claude/plugins/marketplaces/`;
  if (path.startsWith(mp)) {
    const rest = path.slice(mp.length).split("/");
    return { source: "plugin", owner: rest[0], repo: rest[1] };
  }
  if (path.startsWith(`${home}/.claude/skills/`)) return { source: "user" };
  if (path.includes("/.agents/skills/")) return { source: "user (agents)" };
  return { source: "project" };
}

export async function getSkillDetail(dirPath: string): Promise<SkillDetail> {
  let skillMd = "";
  let mtime: Date | null = null;
  let exists = true;
  try {
    skillMd = await readFile(join(dirPath, "SKILL.md"), "utf8");
    const s = await stat(join(dirPath, "SKILL.md"));
    mtime = s.mtime;
  } catch {
    exists = false;
  }

  const { fm, body } = parseFrontmatter(skillMd);
  const files = await walk(dirPath);
  const totalBytes = files.reduce((n, f) => n + f.size, 0);

  let symlinkTarget: string | null = null;
  try {
    const raw = await readlink(dirPath);
    // readlink returns the link's stored target verbatim (often relative).
    // Resolve against the parent so the UI shows an absolute path.
    symlinkTarget = isAbsolute(raw) ? raw : resolve(dirname(dirPath), raw);
  } catch {
    /* not a symlink */
  }

  const truncatedBody = body.length > MAX_BODY;

  return {
    name: fm.name ?? dirPath.split("/").pop()!,
    path: dirPath,
    exists,
    frontmatter: fm,
    version: fm["metadata.version"] ?? fm.version,
    author: fm.author ?? fm["metadata.author"],
    license: fm.license ?? fm["metadata.license"],
    body: truncatedBody ? body.slice(0, MAX_BODY) : body,
    bodyTruncated: truncatedBody,
    files: files.sort((a, b) => a.rel.localeCompare(b.rel)),
    totalBytes,
    modifiedAt: mtime ? mtime.toISOString() : null,
    symlinkTarget,
    provenance: provenance(dirPath),
  };
}
