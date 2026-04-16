import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as pathResolve, sep } from "node:path";

export type InstallScope = "user" | "project";

export interface InstallRequest {
  source: string;           // "owner/repo" or "https://github.com/owner/repo"
  skillName?: string;        // optional -s <name> for monorepos
  scope: InstallScope;
  projectPath?: string;      // required when scope === "project"
  agents?: string;           // defaults to "claude"
}

export interface InstallResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  command: string;
}

// Strictly validated source formats. No shell metachars, no paths.
const SOURCE_RE =
  /^(?:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\.git)?)$/;
const NAME_RE = /^[A-Za-z0-9_.-]+$/;

const TIMEOUT_MS = 120_000;
const OUTPUT_CAP = 64_000;

// Strip ANSI color/escape sequences — NO_COLOR / FORCE_COLOR aren't always
// honored by CLIs that use custom color libs.
const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07?)/g;

function cap(s: string) {
  const stripped = s.replace(ANSI_RE, "");
  return stripped.length > OUTPUT_CAP
    ? stripped.slice(0, OUTPUT_CAP) + "\n...[output truncated]"
    : stripped;
}

// System roots we will never treat as a "project" — installing skills here
// would either pollute global space or create files the current user may not
// own. This is a denylist (not a strict allowlist) because users can legitimately
// put project dirs under many places (/Users/me/code, /Volumes/foo, etc.).
const DENIED_PROJECT_ROOTS = [
  "/", "/bin", "/boot", "/dev", "/etc", "/lib", "/opt", "/proc", "/root",
  "/sbin", "/srv", "/sys", "/usr", "/var",
  "/tmp", "/private/tmp", "/private/var",
  "/Applications", "/System", "/Library", "/Network",
];

/** Confirm a project path is safe and looks project-like. */
function ensureProjectPath(input: string): string {
  const abs = pathResolve(input);
  const parts = abs.split(sep).filter(Boolean);
  if (parts.length < 2) throw new Error("project path is too shallow");
  if (abs === homedir()) throw new Error("refusing to install into $HOME as 'project'");
  for (const deny of DENIED_PROJECT_ROOTS) {
    if (abs === deny || abs.startsWith(deny + "/")) {
      throw new Error(
        `refusing to install into ${deny} (system/temp directory — pick a user project folder instead)`,
      );
    }
  }
  return abs;
}

export async function installSkill(req: InstallRequest): Promise<InstallResult> {
  if (!SOURCE_RE.test(req.source)) {
    throw new Error("source must be 'owner/repo' or 'https://github.com/owner/repo'");
  }
  if (req.skillName && !NAME_RE.test(req.skillName)) {
    throw new Error("invalid --skill name");
  }
  // vercel-labs/skills uses `claude-code` (not `claude`) as the Claude Code
  // agent identifier. Other valid values: cursor, codex, gemini-cli, etc.,
  // or `*` for all agents.
  const agents = req.agents ?? "claude-code";
  if (agents !== "*" && !/^[A-Za-z0-9_,-]+$/.test(agents)) {
    throw new Error("invalid --agent value");
  }

  const args = ["skills", "add", req.source, "-y", "-a", agents];
  if (req.scope === "user") args.push("-g");
  if (req.skillName) args.push("-s", req.skillName);

  let cwd: string;
  if (req.scope === "project") {
    if (!req.projectPath) throw new Error("project scope requires projectPath");
    cwd = ensureProjectPath(req.projectPath);
    // Pre-create the target so the CLI consistently sees a project layout.
    await mkdir(join(cwd, ".claude", "skills"), { recursive: true });
  } else {
    cwd = homedir();
  }

  // The preview shown to the user — deliberately doesn't include cwd
  // to avoid echoing absolute paths.
  const command = `npx --yes ${args.join(" ")}`;

  const proc = Bun.spawn(["npx", "--yes", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
  });

  const killTimer = setTimeout(() => {
    try { proc.kill(); } catch { /* already gone */ }
  }, TIMEOUT_MS);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(killTimer);

  return {
    ok: exitCode === 0,
    exitCode,
    stdout: cap(stdout),
    stderr: cap(stderr),
    command,
  };
}
