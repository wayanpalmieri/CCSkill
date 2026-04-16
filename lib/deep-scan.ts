// Cisco AI Defense skill-scanner integration.
//
// Requires the external `skill-scanner` CLI (pip install cisco-ai-skill-scanner).
// If not installed, /api/deep-scan returns { installed: false }.
//
// We invoke with `--format json --output <tmp-file>` and parse the file. The
// exact JSON schema is not documented in their README, so we do best-effort
// normalization into the same {severity, message, file, line, rule} shape as
// our built-in heuristic scanner. Unknown schemas are returned in `raw` so the
// UI can still show something useful.

import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export type Severity = "high" | "med" | "low";

export interface DeepFinding {
  severity: Severity;
  rule: string;
  message: string;
  file: string;
  line: number;
  snippet?: string;
}

export interface DeepScanReport {
  installed: boolean;
  installCommand: string;
  version?: string;
  ran: boolean;
  ok?: boolean;
  exitCode?: number;
  command?: string;
  findings?: DeepFinding[];
  raw?: unknown;            // the parsed JSON from the CLI, if we couldn't normalize
  stderr?: string;
  durationMs?: number;
  error?: string;
}

export type Policy = "strict" | "balanced" | "permissive";

export interface DeepScanOpts {
  /** Enable AST dataflow analyzer. Slower. */
  behavioral?: boolean;
  /** Enable meta-analyzer (false-positive filter). Default true. */
  meta?: boolean;
  /** Preset policy. Default "balanced". */
  policy?: Policy;
  /** Tolerate non-standard skill layouts. */
  lenient?: boolean;
  /** Include fingerprints + metadata in findings. */
  verbose?: boolean;
}

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const STDERR_CAP = 16_000;

async function run(
  bin: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return await new Promise((resolve) => {
    const proc = spawn(bin, args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
    }, TIMEOUT_MS);
    proc.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
    proc.stderr.on("data", (b) => { stderr += b.toString("utf8"); });
    proc.on("close", (code) => {
      clearTimeout(killTimer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    proc.on("error", () => {
      clearTimeout(killTimer);
      resolve({ code: 127, stdout, stderr, timedOut });
    });
  });
}

async function isInstalled(): Promise<{ installed: boolean; version?: string }> {
  try {
    const r = await run("skill-scanner", ["--version"]);
    if (r.code === 0) {
      return { installed: true, version: r.stdout.trim() || undefined };
    }
  } catch {
    /* fall through */
  }
  return { installed: false };
}

/** Map arbitrary severity strings to our 3-level taxonomy. */
function normalizeSeverity(input: unknown): Severity {
  const s = String(input ?? "").toLowerCase();
  if (s.includes("crit") || s === "high" || s === "error") return "high";
  if (s === "med" || s.startsWith("medium") || s === "warn" || s === "warning") return "med";
  return "low";
}

function toStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (v == null) return "";
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Best-effort normalization from the CLI's JSON into DeepFinding[]. */
function normalizeFindings(root: unknown, skillPath: string): DeepFinding[] | null {
  if (!root || typeof root !== "object") return null;

  // Common schema shapes we probe, in order:
  //   { findings: [...] }
  //   { issues: [...] }
  //   { results: [...] }
  //   { vulnerabilities: [...] }
  //   [...]                        (top-level array)
  let arr: unknown = null;
  const obj = root as Record<string, unknown>;
  for (const k of ["findings", "issues", "results", "vulnerabilities", "items"]) {
    if (Array.isArray(obj[k])) { arr = obj[k]; break; }
  }
  if (!arr && Array.isArray(root)) arr = root;
  if (!Array.isArray(arr)) return null;

  const out: DeepFinding[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const f = raw as Record<string, unknown>;

    const severity = normalizeSeverity(
      f.severity ?? f.level ?? f.risk ?? f.impact,
    );

    const rule = toStr(
      f.rule_id ?? f.ruleId ?? f.rule ?? f.id ?? f.type ?? f.check ?? "cisco",
    );

    const message = toStr(
      f.message ?? f.title ?? f.description ?? f.summary ?? f.name ?? rule,
    );

    // File path — try many conventions. Prefer paths relative to the skill.
    let file = toStr(
      f.file ?? f.path ?? f.filename ?? f.location ?? f.source ?? "",
    );
    if (file.startsWith(skillPath)) file = file.slice(skillPath.length).replace(/^[/\\]+/, "");

    const line = Number(
      f.line ?? f.lineno ?? f.line_number ?? f.start_line ?? 0,
    ) || 0;

    const snippet = f.snippet != null ? toStr(f.snippet) : undefined;

    out.push({ severity, rule, message, file, line, snippet });
  }

  // Sort: high → med → low, then by file.
  const order: Record<Severity, number> = { high: 0, med: 1, low: 2 };
  out.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file));
  return out;
}

const INSTALL_COMMAND = "pip install cisco-ai-skill-scanner";

function deepArgs(subcommand: "scan" | "scan-all", path: string, outFile: string, opts: DeepScanOpts): string[] {
  const args = [subcommand, path, "--format", "json", "--output", outFile];
  if (opts.behavioral) args.push("--use-behavioral");
  if (opts.meta !== false) args.push("--enable-meta");
  if (opts.policy && opts.policy !== "balanced") args.push("--policy", opts.policy);
  if (opts.lenient) args.push("--lenient");
  if (opts.verbose) args.push("--verbose");
  return args;
}

export async function deepScanSkill(
  skillPath: string,
  opts: DeepScanOpts = {},
): Promise<DeepScanReport> {
  const inst = await isInstalled();
  if (!inst.installed) {
    return {
      installed: false,
      installCommand: INSTALL_COMMAND,
      ran: false,
    };
  }

  const outFile = join(tmpdir(), `ccskill-deep-${randomBytes(6).toString("hex")}.json`);
  const args = deepArgs("scan", skillPath, outFile, opts);

  const command = `skill-scanner ${args.join(" ")}`;
  const started = Date.now();
  const r = await run("skill-scanner", args);
  const durationMs = Date.now() - started;

  let findings: DeepFinding[] | null = null;
  let raw: unknown;
  try {
    const txt = await readFile(outFile, "utf8");
    if (txt.trim()) {
      raw = JSON.parse(txt);
      findings = normalizeFindings(raw, skillPath);
    }
  } catch {
    // no output file / bad JSON — fall through with error
  } finally {
    unlink(outFile).catch(() => { /* best effort */ });
  }

  // The CLI exits non-zero when findings at/above the fail threshold exist,
  // but we don't pass --fail-on-severity, so non-zero genuinely means an
  // error.
  const ok = r.code === 0 && (findings !== null || raw !== undefined);

  return {
    installed: true,
    installCommand: INSTALL_COMMAND,
    version: inst.version,
    ran: true,
    ok,
    exitCode: r.code,
    command,
    findings: findings ?? undefined,
    raw: findings ? undefined : raw,
    stderr: r.stderr.length > STDERR_CAP
      ? r.stderr.slice(0, STDERR_CAP) + "\n...[truncated]"
      : r.stderr,
    durationMs,
    error: !ok
      ? r.timedOut
        ? "scan timed out"
        : findings === null && raw === undefined
          ? "no parseable output"
          : `exit ${r.code}`
      : undefined,
  };
}

// --------------------------------------------------------------------------
// Overlap check — runs `skill-scanner scan-all <root> --check-overlap` to
// find skills whose descriptions collide. Result shape isn't documented;
// we try to surface pairs and fall back to raw JSON.
// --------------------------------------------------------------------------

export interface OverlapPair {
  a: string;
  b: string;
  score?: number;
  reason?: string;
}

export interface OverlapReport {
  installed: boolean;
  installCommand: string;
  ran: boolean;
  ok?: boolean;
  exitCode?: number;
  command?: string;
  pairs?: OverlapPair[];
  findings?: DeepFinding[];   // raw findings from scan-all (for context)
  raw?: unknown;               // untouched JSON when we couldn't normalize
  stderr?: string;
  durationMs?: number;
  error?: string;
}

function normalizeOverlapPairs(root: unknown): OverlapPair[] | null {
  if (!root || typeof root !== "object") return null;
  const obj = root as Record<string, unknown>;

  // Probe common shapes.
  let arr: unknown = null;
  for (const k of ["overlaps", "overlap", "pairs", "conflicts", "trigger_overlap", "description_overlap"]) {
    if (Array.isArray(obj[k])) { arr = obj[k]; break; }
  }
  // Or filter the top-level findings array for overlap-type entries.
  if (!arr && Array.isArray(obj.findings)) {
    arr = (obj.findings as any[]).filter(
      (f) =>
        typeof f === "object" &&
        /overlap|conflict|duplicate/i.test(
          String(f.rule ?? f.rule_id ?? f.type ?? f.check ?? ""),
        ),
    );
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;

  const out: OverlapPair[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const f = raw as Record<string, unknown>;
    // Try to pluck two skill names out of various field layouts.
    const a = toStr(f.a ?? f.skill_a ?? f.source ?? f.left ?? (Array.isArray(f.skills) ? (f.skills as any)[0] : ""));
    const b = toStr(f.b ?? f.skill_b ?? f.target ?? f.right ?? (Array.isArray(f.skills) ? (f.skills as any)[1] : ""));
    if (!a || !b) continue;
    out.push({
      a,
      b,
      score: typeof f.score === "number" ? f.score : typeof f.overlap === "number" ? f.overlap : undefined,
      reason: toStr(f.message ?? f.reason ?? f.description ?? "") || undefined,
    });
  }
  return out.length ? out : null;
}

export async function checkOverlap(
  rootPath: string,
  opts: DeepScanOpts = {},
): Promise<OverlapReport> {
  const inst = await isInstalled();
  if (!inst.installed) {
    return {
      installed: false,
      installCommand: INSTALL_COMMAND,
      ran: false,
    };
  }

  const outFile = join(tmpdir(), `ccskill-overlap-${randomBytes(6).toString("hex")}.json`);
  const args = deepArgs("scan-all", rootPath, outFile, opts);
  args.push("--check-overlap", "--recursive");
  const command = `skill-scanner ${args.join(" ")}`;

  const started = Date.now();
  const r = await run("skill-scanner", args);
  const durationMs = Date.now() - started;

  let pairs: OverlapPair[] | null = null;
  let findings: DeepFinding[] | null = null;
  let raw: unknown;
  try {
    const txt = await readFile(outFile, "utf8");
    if (txt.trim()) {
      raw = JSON.parse(txt);
      pairs = normalizeOverlapPairs(raw);
      findings = normalizeFindings(raw, rootPath);
    }
  } catch {
    /* fall through */
  } finally {
    unlink(outFile).catch(() => {});
  }

  const ok = r.code === 0 && (pairs !== null || findings !== null || raw !== undefined);

  return {
    installed: true,
    installCommand: INSTALL_COMMAND,
    ran: true,
    ok,
    exitCode: r.code,
    command,
    pairs: pairs ?? undefined,
    findings: findings ?? undefined,
    raw: pairs || findings ? undefined : raw,
    stderr: r.stderr.length > STDERR_CAP
      ? r.stderr.slice(0, STDERR_CAP) + "\n...[truncated]"
      : r.stderr,
    durationMs,
    error: !ok
      ? r.timedOut
        ? "overlap check timed out"
        : `exit ${r.code}`
      : undefined,
  };
}
