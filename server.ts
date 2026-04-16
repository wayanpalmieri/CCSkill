import { homedir, platform } from "node:os";
import { join, dirname, sep, resolve as pathResolve } from "node:path";
import index from "./public/index.html";
import { stat } from "node:fs/promises";
import {
  scanUserSkills,
  scanProjectSkills,
  scanPluginSkills,
  scanWorkspace,
  toggleSkill,
} from "./lib/skills.ts";
import { getSkillDetail } from "./lib/detail.ts";
import { scanSkill } from "./lib/scan.ts";
import { lookup as registryLookup } from "./lib/registry.ts";
import { installSkill, type InstallScope } from "./lib/install.ts";
import { deepScanSkill, checkOverlap, type Policy, type DeepScanOpts } from "./lib/deep-scan.ts";

function parseDeepOpts(url: URL): DeepScanOpts {
  const policyRaw = url.searchParams.get("policy");
  const policy: Policy | undefined =
    policyRaw === "strict" || policyRaw === "permissive" || policyRaw === "balanced"
      ? (policyRaw as Policy)
      : undefined;
  return {
    behavioral: url.searchParams.get("behavioral") === "1",
    // meta defaults ON unless explicitly disabled.
    meta: url.searchParams.get("meta") !== "0",
    policy,
    lenient: url.searchParams.get("lenient") === "1",
    verbose: url.searchParams.get("verbose") === "1",
  };
}

const PORT = Number(process.env.PORT ?? 4173);

const HOME = homedir();
const ALLOWED_PREFIXES = [
  join(HOME, ".claude", "skills") + sep,
  join(HOME, ".claude", "plugins") + sep,
  join(HOME, ".agents", "skills") + sep,
];

function isAllowed(path: string, extra: string[] = []): boolean {
  return [...ALLOWED_PREFIXES, ...extra].some((p) => path.startsWith(p));
}

/**
 * Resolve + normalize a user-supplied path and confirm it is either:
 *   (a) under one of the hardcoded skill/plugin roots, or
 *   (b) a project-scope path that has `.claude/skills` as *distinct segments*.
 *
 * Returns the resolved absolute path on success, or null if the path is
 * unsafe / outside allowed roots. Resolving via path.resolve() eliminates
 * `..` tricks; checking segments (not `String.includes`) prevents paths
 * like `/evil/.claude/skills/../../etc` from slipping past.
 */
function resolveAllowed(input: string): string | null {
  if (!input) return null;
  const abs = pathResolve(input);

  // Branch (a): under a well-known root.
  if (ALLOWED_PREFIXES.some((p) => abs === p.slice(0, -1) || abs.startsWith(p))) {
    return abs;
  }

  // Branch (b): project skills tree — require `.claude` / `skills` to appear
  // as adjacent distinct segments (not a substring).
  const segs = abs.split(sep);
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i] === ".claude" && segs[i + 1] === "skills") return abs;
  }
  return null;
}

const PLAT = platform();

/** Open a "reveal this file/folder in the native file manager" action. */
async function revealInFileManager(path: string): Promise<void> {
  if (PLAT === "darwin") {
    await Bun.spawn(["open", "-R", path]).exited;
  } else if (PLAT === "win32") {
    // explorer.exe treats everything after "/select," as the path. A path
    // containing a comma breaks this into multiple args. We refuse such
    // paths rather than risk opening an attacker-specified location.
    if (path.includes(",")) throw new Error("path contains comma; reveal refused");
    await Bun.spawn(["explorer.exe", `/select,${path}`]).exited;
  } else {
    // linux / bsd — xdg-open opens the containing directory; there's no
    // portable "select this file" across Linux file managers.
    await Bun.spawn(["xdg-open", dirname(path)]).exited;
  }
}

/** Show a native folder picker. Returns absolute POSIX-style path, or null if cancelled. */
async function pickFolderNative(): Promise<string | null> {
  const CANCEL = "__CCSKILL_CANCELLED__";

  if (PLAT === "darwin") {
    const proc = Bun.spawn([
      "osascript",
      "-e", "try",
      "-e", 'POSIX path of (choose folder with prompt "Select a project folder")',
      "-e", "on error",
      "-e", `"${CANCEL}"`,
      "-e", "end try",
    ]);
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    if (!out || out === CANCEL) return null;
    return out.replace(/\/+$/, "");
  }

  if (PLAT === "win32") {
    const ps = `
      Add-Type -AssemblyName System.Windows.Forms
      $d = New-Object System.Windows.Forms.FolderBrowserDialog
      $d.Description = "Select a project folder"
      if ($d.ShowDialog() -eq "OK") { $d.SelectedPath } else { "${CANCEL}" }
    `;
    const proc = Bun.spawn([
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      ps,
    ]);
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    if (!out || out === CANCEL) return null;
    return out;
  }

  // linux: try zenity (most common GTK picker)
  const proc = Bun.spawn([
    "zenity",
    "--file-selection",
    "--directory",
    "--title=Select a project folder",
  ]);
  const out = (await new Response(proc.stdout).text()).trim();
  const code = await proc.exited;
  if (code !== 0 || !out) return null;
  return out;
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  // /api/scan-all with Cisco deep scan takes minutes for large skill
  // libraries. Bun's default idleTimeout (10s) otherwise drops the response
  // mid-stream and the browser reports "Failed to fetch". 255 is the
  // hard maximum Bun allows; see scan-all handler below for extra safety
  // (concurrency bump) to keep full runs under this budget.
  idleTimeout: 255,
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/": index,

    "/api/skills": async (req) => {
      const url = new URL(req.url);
      const projectPath = url.searchParams.get("project") ?? "";

      // Auto-detect: if <projectPath>/.claude/skills exists → single project.
      // Otherwise treat as a workspace and walk subdirs for projects.
      let project: Awaited<ReturnType<typeof scanProjectSkills>> = [];
      let workspaceProjects: string[] = [];
      let mode: "none" | "project" | "workspace" = "none";

      if (projectPath) {
        let isProject = false;
        try {
          const s = await stat(join(projectPath, ".claude", "skills"));
          isProject = s.isDirectory();
        } catch {
          /* not a project */
        }
        if (isProject) {
          mode = "project";
          project = await scanProjectSkills(projectPath);
        } else {
          mode = "workspace";
          const r = await scanWorkspace(projectPath);
          project = r.skills;
          workspaceProjects = r.projects;
        }
      }

      const [user, plugin] = await Promise.all([
        scanUserSkills(),
        scanPluginSkills(),
      ]);
      return Response.json({
        user,
        project,
        plugin,
        projectPath,
        mode,
        workspaceProjects,
      });
    },

    "/api/detail": async (req) => {
      const url = new URL(req.url);
      const raw = url.searchParams.get("path") ?? "";
      const path = resolveAllowed(raw);
      if (!path) return Response.json({ error: "path not allowed" }, { status: 400 });
      return Response.json(await getSkillDetail(path));
    },

    "/api/scan": async (req) => {
      const url = new URL(req.url);
      const raw = url.searchParams.get("path") ?? "";
      const path = resolveAllowed(raw);
      if (!path) return Response.json({ error: "path not allowed" }, { status: 400 });
      return Response.json(await scanSkill(path));
    },

    "/api/scan-all": async (req) => {
      const url = new URL(req.url);
      const deep = url.searchParams.get("deep") === "1";
      const projectPath = url.searchParams.get("project") ?? "";
      const deepOpts = parseDeepOpts(url);

      // Streaming response: emit NDJSON messages as each skill completes so
      // the UI can show a progress bar and the connection never idles out.
      //   {"type":"start", total, deep, startedAt}
      //   {"type":"entry", index, total, entry}     (one per skill)
      //   {"type":"done",  summary, finishedAt}
      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder();
          const emit = (obj: unknown) =>
            controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));

          try {
            const [user, plugin, project] = await Promise.all([
              scanUserSkills(),
              scanPluginSkills(),
              projectPath
                ? (async () => {
                    try {
                      const s = await stat(join(projectPath, ".claude", "skills"));
                      if (s.isDirectory()) return scanProjectSkills(projectPath);
                    } catch { /* workspace */ }
                    const r = await scanWorkspace(projectPath);
                    return r.skills;
                  })()
                : Promise.resolve([]),
            ]);

            const skills = [...user, ...project, ...plugin];
            const startedAt = new Date().toISOString();

            emit({
              type: "start",
              total: skills.length,
              deep,
              startedAt,
            });

            // Concurrency limits: built-in is cheap, deep spawns Python.
            const CONCURRENCY = deep ? 4 : 8;
            const summary = {
              builtin: { high: 0, med: 0, low: 0 },
              deep: deep ? { high: 0, med: 0, low: 0 } : null,
            };

            let cursor = 0;
            let completed = 0;

            async function scanOne(s: (typeof skills)[number]) {
              let builtin:
                | { ok: true; report: Awaited<ReturnType<typeof scanSkill>> }
                | { ok: false; error: string };
              try {
                builtin = { ok: true, report: await scanSkill(s.path) };
              } catch (e: any) {
                builtin = { ok: false, error: e?.message ?? String(e) };
              }

              let deepR: Awaited<ReturnType<typeof deepScanSkill>> | undefined;
              if (deep) {
                try {
                  deepR = await deepScanSkill(s.path, deepOpts);
                } catch (e: any) {
                  deepR = {
                    installed: true,
                    installCommand: "pip install cisco-ai-skill-scanner",
                    ran: false,
                    error: e?.message ?? String(e),
                  };
                }
              }

              if (builtin.ok) {
                for (const f of builtin.report.findings) {
                  if (f.severity === "high") summary.builtin.high++;
                  else if (f.severity === "med") summary.builtin.med++;
                  else summary.builtin.low++;
                }
              }
              if (summary.deep && deepR?.findings) {
                for (const f of deepR.findings) {
                  if (f.severity === "high") summary.deep.high++;
                  else if (f.severity === "med") summary.deep.med++;
                  else summary.deep.low++;
                }
              }

              completed++;
              emit({
                type: "entry",
                index: completed,
                total: skills.length,
                entry: {
                  id: s.id,
                  name: s.name,
                  scope: s.scope,
                  path: s.path,
                  enabled: s.enabled,
                  readOnly: s.readOnly,
                  root: s.root,
                  description: s.description,
                  builtin,
                  deep: deepR,
                },
              });
            }

            // Defensive wrapper: a bug in scanOne must not kill the whole
            // stream. Catch per-iteration so other workers keep going.
            await Promise.all(
              Array.from(
                { length: Math.min(CONCURRENCY, skills.length) },
                async () => {
                  while (cursor < skills.length) {
                    const s = skills[cursor++];
                    try {
                      await scanOne(s);
                    } catch (e: any) {
                      completed++;
                      emit({
                        type: "entry",
                        index: completed,
                        total: skills.length,
                        entry: {
                          id: s.id,
                          name: s.name,
                          scope: s.scope,
                          path: s.path,
                          enabled: s.enabled,
                          readOnly: s.readOnly,
                          root: s.root,
                          description: s.description,
                          builtin: { ok: false, error: e?.message ?? String(e) },
                        },
                      });
                    }
                  }
                },
              ),
            );

            emit({
              type: "done",
              summary,
              finishedAt: new Date().toISOString(),
            });
          } catch (e: any) {
            emit({ type: "error", error: e?.message ?? String(e) });
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "application/x-ndjson",
          "cache-control": "no-cache",
          "x-accel-buffering": "no",
        },
      });
    },

    "/api/deep-scan": async (req) => {
      const url = new URL(req.url);
      const raw = url.searchParams.get("path") ?? "";
      const path = resolveAllowed(raw);
      if (!path) return Response.json({ error: "path not allowed" }, { status: 400 });
      return Response.json(await deepScanSkill(path, parseDeepOpts(url)));
    },

    "/api/overlap": async (req) => {
      // Runs `skill-scanner scan-all <root> --check-overlap`. The root must
      // be one of the allowed skill trees. We default to ~/.claude/skills.
      const url = new URL(req.url);
      const scope = url.searchParams.get("scope") ?? "user";
      let root: string;
      if (scope === "user") {
        root = join(HOME, ".claude", "skills");
      } else if (scope === "project") {
        const p = url.searchParams.get("path");
        const resolved = p ? resolveAllowed(p) : null;
        if (!resolved) return Response.json({ error: "invalid or missing project path" }, { status: 400 });
        root = resolved;
      } else {
        return Response.json({ error: "scope must be 'user' or 'project'" }, { status: 400 });
      }
      return Response.json(await checkOverlap(root, parseDeepOpts(url)));
    },

    "/api/registry": async (req) => {
      const url = new URL(req.url);
      const owner = url.searchParams.get("owner") ?? "";
      const name = url.searchParams.get("name") ?? "";
      if (!owner || !name) {
        return Response.json({ error: "owner and name required" }, { status: 400 });
      }
      // Allow any public owner/name — we only do outbound fetches to skills.sh.
      if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
        return Response.json({ error: "invalid owner or name" }, { status: 400 });
      }
      const data = await registryLookup(owner, name);
      return Response.json(data);
    },

    "/api/install": {
      POST: async (req) => {
        let body: {
          source?: string;
          skillName?: string;
          scope?: InstallScope;
          projectPath?: string;
          agents?: string;
        };
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "invalid json" }, { status: 400 });
        }
        if (!body.source) return Response.json({ error: "source required" }, { status: 400 });
        if (body.scope !== "user" && body.scope !== "project") {
          return Response.json({ error: "scope must be 'user' or 'project'" }, { status: 400 });
        }
        try {
          const result = await installSkill({
            source: body.source,
            skillName: body.skillName,
            scope: body.scope,
            projectPath: body.projectPath,
            agents: body.agents,
          });
          return Response.json(result, { status: result.ok ? 200 : 502 });
        } catch (err: any) {
          return Response.json(
            { error: err?.message ?? String(err) },
            { status: 400 },
          );
        }
      },
    },

    "/api/pick-folder": {
      POST: async () => {
        try {
          const path = await pickFolderNative();
          if (!path) return Response.json({ cancelled: true });
          return Response.json({ path });
        } catch (err: any) {
          // Most likely cause on Linux: zenity not installed.
          return Response.json(
            {
              error:
                err?.message ??
                (PLAT === "linux"
                  ? "Folder picker requires 'zenity'. Install it or paste the path manually."
                  : "Folder picker unavailable."),
              platform: PLAT,
            },
            { status: 500 },
          );
        }
      },
    },

    "/api/reveal": {
      POST: async (req) => {
        const body = (await req.json()) as { path: string };
        const path = resolveAllowed(body.path);
        if (!path) return Response.json({ error: "path not allowed" }, { status: 400 });
        try {
          await revealInFileManager(path);
          return Response.json({ ok: true, platform: PLAT });
        } catch (err: any) {
          return Response.json(
            { error: err?.message ?? "reveal failed", platform: PLAT },
            { status: 500 },
          );
        }
      },
    },

    "/api/toggle": {
      POST: async (req) => {
        const body = (await req.json()) as {
          root: string;
          name: string;
          enable: boolean;
          readOnly?: boolean;
        };
        if (body.readOnly) {
          return Response.json({ error: "read-only scope" }, { status: 400 });
        }
        try {
          const newPath = await toggleSkill(body.root, body.name, body.enable);
          return Response.json({ ok: true, path: newPath });
        } catch (err: any) {
          return Response.json(
            { error: err?.message ?? String(err) },
            { status: 500 },
          );
        }
      },
    },
  },

  fetch() {
    return new Response("Not found", { status: 404 });
  },
});

console.log(`\n  CCSkill  →  http://127.0.0.1:${server.port}\n`);
