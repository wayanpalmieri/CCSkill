# CCSkill — tasks & review

Local web app to view, toggle, install, and audit Claude Code skills across
user, project, and plugin scopes.

Shipped well past v1. This file is a running log of what's been built.

## Stack

- Runtime: Bun (single binary, native TS, built-in bundler & server)
- Frontend: React 18 via Bun's HTML imports (no separate build step)
- Styling: Tailwind via CDN
- No DB — filesystem is the source of truth

## What's implemented

### Viewing

- [x] User skills at `~/.claude/skills/`
- [x] Project skills at `<path>/.claude/skills/`
- [x] Plugin skills at `~/.claude/plugins/marketplaces/**/skills/` (read-only)
- [x] Workspace mode — parent folder auto-scan for multiple projects, depth-
  limited walk, skips `node_modules` / `.git` / etc.
- [x] Collapsible groups per scope + per project
- [x] Bulk on/off per group
- [x] SKILL.md frontmatter parsed with nested-YAML support (so `metadata.version`
  works, not just flat keys)
- [x] Symlink resolution to absolute path for display

### Toggling

- [x] Disable via `foo` → `.disabled.foo` rename
- [x] Works on symlinks (renames the link, not the target)
- [x] Path-escape guard (`path.resolve` + segment check)

### Installing

- [x] `+ Install` modal — accepts `owner/repo`, GitHub URL, or pasted
  `npx skills add …` command
- [x] User scope (global) and Project scope (honors cwd)
- [x] Native folder picker: macOS AppleScript, Linux zenity, Windows PowerShell
  FolderBrowserDialog
- [x] Denylist for system roots (`/tmp`, `/etc`, `/var`, `/usr`, etc.)
- [x] Post-install auto-scan (built-in heuristic)
- [x] Live command preview of exact `npx` invocation
- [x] Streamed output captured and rendered in modal

### Scanning

- [x] Built-in heuristic scan (`lib/scan.ts`) — ~22 rules across HIGH/MED/LOW
- [x] Cisco Deep scan (`lib/deep-scan.ts`) — wraps
  `cisco-ai-defense/skill-scanner` CLI, graceful "not installed" state
- [x] skills.sh registry lookup (`lib/registry.ts`) — best-effort HTML scrape,
  third-party audits (Socket / Snyk / Gen Agent Trust Hub), install/star stats,
  1h cache
- [x] **Scan all** — full-screen overlay, runs built-in + Cisco on every skill,
  streams NDJSON progress live with per-skill feed and running severity totals,
  AbortController-cancelable
- [x] Security scan action also invokable per-skill from detail pane

### Security hardening

- [x] Server binds to `127.0.0.1` (not dual-stack)
- [x] `resolveAllowed()` normalizes + segment-checks every user-supplied path
- [x] All subprocess spawns use argv arrays — no shell interpolation
- [x] Regex validation on install source / agents / skill name before subprocess
- [x] Install project-path denylist (no system roots, no `$HOME` as project)
- [x] Windows comma-in-path refused for `explorer.exe /select,` reveal
- [x] Scan-all stream catches per-skill errors so one failure doesn't kill the
  run

### UX

- [x] Command palette (⌘K) — fuzzy search, toggle from keyboard
- [x] Shortcuts: `/`, `j`/`k`, `space`, `1-4`, `s`, `o`, `r`, `?`, `esc`
- [x] Toasts for ok/err events
- [x] Scope sidebar with live counts
- [x] Visual polish: violet accent, accent-soft tints for active state, hover
  contrast bumped so active/focus states are visibly distinct
- [x] Skeleton loader on first load
- [x] Persistent state (scope, status, collapsed groups, project path) in
  localStorage
- [x] Top-bar description

### Cross-platform

- [x] Reveal: `open -R` (darwin) / `xdg-open` (linux) / `explorer.exe /select,`
  (win32)
- [x] Folder picker: AppleScript / zenity / PowerShell
- [x] Path separators: `path.relative` + `path.sep` — no hardcoded `/`

### Docs

- [x] README with current feature set, keyboard reference, security model,
  disclaimer covering both scanners and skills.sh
- [x] LICENSE (MIT)
- [x] `.gitignore`

## Still on the table (not implemented)

- [ ] Editing SKILL.md content
- [ ] Creating new skills from scratch
- [ ] Plugin enable/disable (lives in `enabledPlugins` in `settings.json` —
  different layer)
- [ ] Uninstall (current workflow: disable, then manually `rm -rf` if desired)
- [ ] Multi-project simultaneous scanning beyond the workspace parent walk
- [ ] Real-time streaming for deep-scan individual runs (currently captured +
  returned at completion)
- [ ] Export scan report to markdown / SARIF
- [ ] Dark/light theme toggle (currently dark-only)

## Known limitations

- **Heuristic scan false positives** on documentation skills that mention
  dangerous patterns pedagogically (e.g. hook-development skills, scanner-rule-
  writing skills). The Cisco scanner is more context-aware and is the right
  tool when signal matters.
- **skills.sh scrape is fragile** — if they restyle, the parse silently
  returns `found: false` and the fallback link takes over.
- **Cisco findings schema** isn't documented; we normalize tolerantly. If the
  schema shifts, raw JSON is shown in a collapsible.
