import { readdir, rename, stat, readFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";

export type Scope = "user" | "project" | "plugin";

export interface Skill {
  id: string;              // `${scope}:${root}:${name}` — stable key
  scope: Scope;
  name: string;            // displayed name (without .disabled. prefix)
  enabled: boolean;
  path: string;            // actual dir on disk (may be .disabled.name)
  root: string;            // the skills/ dir this lives in
  description: string;
  readOnly: boolean;
  isSymlink: boolean;
}

const DISABLED_PREFIX = ".disabled.";

export const USER_SKILLS = join(homedir(), ".claude", "skills");

export function pluginSkillRoots(): string[] {
  // enumerated at request time; we discover them via glob-ish scan
  return []; // resolved dynamically in scanPluginSkills
}

async function listDirs(dir: string): Promise<{ name: string; path: string; isSymlink: boolean }[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { name: string; path: string; isSymlink: boolean }[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    // follow symlinks to check if target is a dir
    if (e.isDirectory() || e.isSymbolicLink()) {
      try {
        const s = await stat(p);
        if (s.isDirectory()) {
          out.push({ name: e.name, path: p, isSymlink: e.isSymbolicLink() });
        }
      } catch {
        /* broken symlink */
      }
    }
  }
  return out;
}

// Minimal YAML-ish frontmatter parser for the list scanner. Only reads top-
// level `name` and `description` — nested keys (`metadata: \n  version: …`)
// are tolerated without corrupting the parse but aren't surfaced here.
// For richer frontmatter (version, author, etc.), see lib/detail.ts.
function parseFrontmatter(src: string): Record<string, string> {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  let key: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (key !== null) {
      const val = buf.join("\n").trim();
      if (val !== "") out[key] = val;
    }
    key = null;
    buf = [];
  };
  for (const line of lines) {
    const indented = /^\s/.test(line);
    if (!indented) {
      flush();
      const kv = line.match(/^([A-Za-z_][A-Za-z0-9_.-]*):\s?(.*)$/);
      if (kv) { key = kv[1]; buf = [kv[2]]; }
    }
    // Intentionally skip indented lines — they belong to a nested object
    // whose content isn't needed for the list view.
  }
  flush();
  return out;
}

async function readSkillMeta(dir: string): Promise<{ name?: string; description?: string }> {
  try {
    const src = await readFile(join(dir, "SKILL.md"), "utf8");
    const fm = parseFrontmatter(src);
    return { name: fm.name, description: fm.description };
  } catch {
    return {};
  }
}

async function scanSkillRoot(
  root: string,
  scope: Scope,
  readOnly: boolean,
): Promise<Skill[]> {
  const dirs = await listDirs(root);
  const skills: Skill[] = [];
  for (const d of dirs) {
    const enabled = !d.name.startsWith(DISABLED_PREFIX);
    const name = enabled ? d.name : d.name.slice(DISABLED_PREFIX.length);
    const meta = await readSkillMeta(d.path);
    skills.push({
      id: `${scope}:${root}:${name}`,
      scope,
      name: meta.name ?? name,
      enabled,
      path: d.path,
      root,
      description: meta.description ?? "",
      readOnly,
      isSymlink: d.isSymlink,
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

export async function scanUserSkills(): Promise<Skill[]> {
  return scanSkillRoot(USER_SKILLS, "user", false);
}

export async function scanProjectSkills(projectPath: string): Promise<Skill[]> {
  const root = join(resolve(projectPath), ".claude", "skills");
  return scanSkillRoot(root, "project", false);
}

const WORKSPACE_IGNORE = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", ".next",
  ".nuxt", ".cache", ".turbo", "target", "vendor", ".venv", "venv",
  "__pycache__", ".idea", ".vscode", "out", "coverage", "tmp", ".parcel-cache",
  ".pnpm-store", ".yarn", ".gradle", ".expo", ".svelte-kit",
]);
const WORKSPACE_MAX_DEPTH = 3;
const WORKSPACE_MAX_PROJECTS = 80;

/** Walk a parent directory looking for subdirectories that contain .claude/skills/. */
export async function findProjectsWithSkills(basePath: string): Promise<string[]> {
  const base = resolve(basePath);
  const out: string[] = [];

  async function hasSkillsDir(dir: string): Promise<boolean> {
    try {
      const s = await stat(join(dir, ".claude", "skills"));
      return s.isDirectory();
    } catch {
      return false;
    }
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (out.length >= WORKSPACE_MAX_PROJECTS) return;
    if (depth > WORKSPACE_MAX_DEPTH) return;
    if (await hasSkillsDir(dir)) {
      out.push(dir);
      return; // don't recurse into a project
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= WORKSPACE_MAX_PROJECTS) return;
      if (!(e.isDirectory() || e.isSymbolicLink())) continue;
      if (e.name.startsWith(".")) continue;
      if (WORKSPACE_IGNORE.has(e.name)) continue;
      await walk(join(dir, e.name), depth + 1);
    }
  }

  await walk(base, 0);
  return out.sort();
}

/** Scan a parent dir for any projects with .claude/skills/ and return all their skills. */
export async function scanWorkspace(basePath: string): Promise<{
  skills: Skill[];
  projects: string[];
}> {
  const projects = await findProjectsWithSkills(basePath);
  const all: Skill[] = [];
  for (const p of projects) {
    const root = join(p, ".claude", "skills");
    const s = await scanSkillRoot(root, "project", false);
    all.push(...s);
  }
  return { skills: all, projects };
}

export async function scanPluginSkills(): Promise<Skill[]> {
  // Walk ~/.claude/plugins/marketplaces/*/**/skills/ up to a reasonable depth.
  const base = join(homedir(), ".claude", "plugins", "marketplaces");
  const roots = await findSkillRoots(base, 4);
  const all: Skill[] = [];
  for (const r of roots) {
    const batch = await scanSkillRoot(r, "plugin", true);
    all.push(...batch);
  }
  return all;
}

async function findSkillRoots(base: string, maxDepth: number): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = join(dir, e.name);
      if (e.name === "skills") {
        found.push(p);
        continue; // don't recurse into skill dirs
      }
      await walk(p, depth + 1);
    }
  }
  await walk(base, 0);
  return found;
}

/** Toggle a skill by renaming its directory. Returns new path. */
export async function toggleSkill(
  root: string,
  name: string,
  enable: boolean,
): Promise<string> {
  const enabledPath = join(root, name);
  const disabledPath = join(root, DISABLED_PREFIX + name);
  const from = enable ? disabledPath : enabledPath;
  const to = enable ? enabledPath : disabledPath;
  // Guardrails: refuse paths outside the expected root. Use path.relative
  // so this works on Windows (\) as well as POSIX (/).
  const guard = (p: string) => {
    const rel = relative(root, p);
    return rel && !rel.startsWith("..") && !isAbsolute(rel);
  };
  if (!guard(from) || !guard(to)) {
    throw new Error("path escape blocked");
  }
  try {
    await rename(from, to);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      // Already in the desired state — verify and no-op.
      try {
        await stat(to);
        return to;
      } catch {
        throw err;
      }
    }
    throw err;
  }
  return to;
}
