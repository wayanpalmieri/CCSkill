# CCSkill

Local web app to view, toggle, install, and audit your Claude Code skills.

<img width="1536" height="1024" alt="skills" src="https://github.com/user-attachments/assets/70a3a136-3b0a-4de6-9650-a627afb0863c" />

Runs entirely locally. No cloud, no telemetry, no network access except
optional best-effort reads from skills.sh and optional outbound calls made by
the install CLI or the Cisco scanner you opt into.

## Run

```bash
bun install
bun start
```

Requires [Bun](https://bun.sh/) 1.2+. Tested on macOS. Linux should work; Windows
support is best-effort (see [Cross-platform](#cross-platform)).

## What it does

### Scopes

- **User** — `~/.claude/skills/`
- **Project** — `<path>/.claude/skills/` — supply a project folder in the Project
  bar, or a parent folder to auto-scan a **workspace** of projects (stops at 3
  levels deep, skips `node_modules`, `.git`, `dist`, etc.)
- **Plugin** — `~/.claude/plugins/marketplaces/**/skills/` — read-only, managed
  by the plugin lifecycle

### Viewing

- Left sidebar: scope filters (All / User / Project / Plugin) with live counts,
  plus On / Off status toggles
- Middle pane: collapsible groups per scope + per project, with bulk on/off per
  group
- Detail pane: SKILL.md preview, file tree, metadata (version, author, license,
  modified time, symlink target, provenance), skills.sh registry lookup with
  third-party audit badges, Reveal in Finder (macOS) / Explorer (Windows) /
  file manager (Linux)

### Toggling

Disabling renames `foo` → `.disabled.foo`. Claude Code's scanner skips
dot-prefixed directories, so the skill becomes invisible to Claude while
remaining on disk. Re-enabling renames it back. Symlinks: the symlink itself
is renamed; the target is untouched. **No file contents are ever edited.**

### Installing

Click **+ Install** (top-right). Paste any of:
- `owner/repo`
- `https://github.com/owner/repo`
- `npx skills add https://github.com/owner/repo --skill foo` (full command pasted
  from skills.sh — parsed automatically)

Choose **User (global)** or **Project** scope. For project, use **Browse…** to
pick a folder with the native macOS file picker (or zenity on Linux, PowerShell
`FolderBrowserDialog` on Windows).

The modal shows the exact `npx --yes skills add …` that will run. On completion
the new skill is auto-scanned by the built-in heuristic (post-install). Install
rejects paths under `/tmp`, `/etc`, `/var`, `/usr`, and other system roots.

### Scanning

Three scans are available, in increasing rigor:

1. **Built-in heuristic** (always available, zero-install) — regex-based
   pattern linter. ~22 rules across HIGH / MED / LOW severities. Fast
   (~100 ms for ~90 skills). High false-positive rate on documentation skills
   that pedagogically mention dangerous patterns.

2. **Cisco Deep scan** (optional, `pip install cisco-ai-skill-scanner`) —
   [cisco-ai-defense/skill-scanner](https://github.com/cisco-ai-defense/skill-scanner)
   — purpose-built for AI agent skills. YARA rules, AST dataflow, bytecode
   verification, optional LLM-as-judge. Python 3.10+ required. Much slower
   (seconds per skill).

3. **skills.sh third-party audits** (read-only) — when a skill resolves to a
   listing on [skills.sh](https://skills.sh) by `<owner>/<repo>`, CCSkill
   surfaces the PASS/WARN/FAIL statuses reported there by Socket, Snyk, and
   Gen Agent Trust Hub. Scraped from the rendered page (no public API), cached
   for 1 hour.

#### Cisco scanner options

The Deep scan panel in each skill's detail pane exposes the following flags
(also used by Scan All for the Cisco portion):

| Option | Flag | Default | What it does |
|---|---|---|---|
| Policy | `--policy strict\|balanced\|permissive` | balanced | Severity thresholds — strict flags more |
| Meta filter | `--enable-meta` | on | Cisco's false-positive filter — dramatically cleaner results |
| Behavioral | `--use-behavioral` | off | AST dataflow analysis — slower but deeper |
| Lenient | `--lenient` | off | Tolerates non-standard skill layouts (e.g. plugins) |
| Verbose | `--verbose` | off | Includes rule fingerprints + metadata in findings |

#### Scan all

**Scan all** (top-right button) opens a full-screen overlay that runs both the
built-in heuristic and Cisco deep scan on every installed skill.

- **Live streaming**: per-skill results arrive via NDJSON as they complete.
  A progress bar, percentage counter, and live severity totals update in
  real time. The last 5 scanned skills are shown in a "most recent" feed.
- **Trigger conflict check** (on by default): after per-skill scans finish,
  runs `skill-scanner scan-all --check-overlap` across your user skills to
  detect skills whose descriptions overlap enough to fight for the same
  invocation trigger. Results shown as pairs with overlap scores.
- Cisco is silently skipped per skill if `skill-scanner` isn't installed.
- Filters: search by name, filter by scope or severity.
- Click any row to expand findings; **Open** jumps to that skill's detail pane.

### Saved reports & export

Scan reports persist across close/reopen of the Scan All overlay within a
session. For longer-term storage:

- **Save** — writes the current report to `~/.claude/ccskill/reports/`.
  Persists across page reloads, server restarts, and browser switches.
- **JSON** — downloads the raw report as a `.json` file.
- **MD** — downloads a Markdown report with per-skill findings tables,
  readable in any markdown viewer or GitHub.
- **Saved reports** section (collapsible, top of the overlay body) — lists
  all previously saved reports. Click to restore, or delete to clean up.

Reports are stored as JSON files at `~/.claude/ccskill/reports/` with
ISO-timestamped filenames.

## Keyboard

| Key | Action |
|---|---|
| `⌘K` / `⌃K` | Command palette (fuzzy search + toggle) |
| `/` | Focus search |
| `j` / `↓` · `k` / `↑` | Move between skills |
| `space` / `enter` | Toggle focused skill |
| `1` / `2` / `3` / `4` | Scope filter: All · User · Project · Plugin |
| `s` | Run built-in security scan on selected skill |
| `o` | Reveal selected skill in the native file manager |
| `r` | Refresh |
| `?` | Toggle shortcut overlay |
| `esc` | Close overlays |

## Cross-platform

Paths resolve via `path.resolve()` + segment-aware checks, so Windows
backslash paths are handled the same as POSIX. Native integrations:

| | macOS | Linux | Windows |
|---|---|---|---|
| Reveal in file manager | `open -R` | `xdg-open` (parent dir) | `explorer.exe /select,` |
| Folder picker | AppleScript | `zenity --file-selection --directory` | PowerShell `FolderBrowserDialog` |

CCSkill has been primarily developed and tested on macOS. Linux/Windows support
is written to be correct but lightly tested — open an issue if something breaks.

## How the server is secured

Server binds to `127.0.0.1` only (IPv4 explicit — avoids IPv6-only bind issues
some browsers hit with `localhost`). Every path-accepting endpoint goes through
`resolveAllowed()`: the input is normalized with `path.resolve()`, then accepted
only if it (a) lives under a well-known root (`~/.claude/skills/`,
`~/.claude/plugins/`, `~/.agents/skills/`) or (b) has `.claude` and `skills` as
adjacent path segments (project-scope tree). Path-escape attempts like
`/etc/.claude/skills/../../etc/passwd` return HTTP 400.

Subprocesses (`npx skills add`, `osascript`, `skill-scanner`, `explorer.exe`,
etc.) are invoked with `Bun.spawn(argv, …)` — argv arrays, no shell
interpolation. User-supplied strings are regex-validated before they reach a
subprocess boundary.

## Disclaimer — use skills at your own risk

Claude Code skills are arbitrary code and prompts that execute inside your
Claude sessions. Anyone can publish one. There is no official registry,
review process, code signing, or sandbox.

**Before enabling a skill you did not write yourself:**

- Read the `SKILL.md` and every file in the skill directory.
- Know what shell commands, network calls, and file operations it will ask
  Claude to run. A skill's instructions are effectively what *you* are
  telling Claude to do.
- Verify the source (who wrote it, where you got it from).
- Keep backups of `~/.claude/` and any project you point Claude at.

**About the built-in security scan:**

CCSkill's built-in "Security scan" is a *heuristic pattern linter*, not a
malware scanner, not a sandbox, and not a security audit. It flags a small
set of obviously suspicious patterns (remote pipe-to-shell, credential reads,
destructive deletes, obfuscated base64, shell-init persistence, etc.). It
will miss anything the author bothered to obfuscate, any novel technique,
and any purely-prompt-based attack that lives in natural language. A clean
scan means "no obvious red flags," **not** "this skill is safe."

**About the Cisco Deep scan integration:**

CCSkill invokes `cisco-ai-defense/skill-scanner` as a separate process when
installed. Findings are *their* findings, surfaced here for convenience.
CCSkill normalizes the JSON output best-effort; if their schema changes, the
raw report is shown instead of structured findings. **CCSkill will not
install the scanner for you** — doing so runs a Python package install on
your machine, which should be your explicit choice.

**About the skills.sh integration:**

For published skills, CCSkill also surfaces third-party audit results
(Socket, Snyk, Gen Agent Trust Hub) and install/star stats from
[skills.sh](https://skills.sh). skills.sh has no public JSON API, so this
data is scraped best-effort from the rendered page and cached for one
hour. It can silently become unavailable if the site is restyled; the
"View on skills.sh" link remains as a fallback. A PASS from a third-party
audit is their opinion, not ours, and does not substitute for reading the
skill yourself.

CCSkill is provided as-is, with no warranty. You are solely responsible for
the skills you enable and for any consequences of running them. The authors
of CCSkill accept no liability for damage, data loss, credential exposure,
or any other harm arising from skills you choose to run.

## License

[MIT](LICENSE).
