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
