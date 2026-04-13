# CCSkill — Claude Code Skill Manager

Local web app to view / enable / disable Claude Code skills across scopes.

## Stack
- Runtime: Bun (single binary, native TS, built-in bundler & server)
- Frontend: React 18 via Bun's HTML imports (no separate build step)
- Styling: Tailwind via CDN (Play CDN) — zero config, fine for a local tool
- No DB — filesystem is the source of truth

## Scopes
- **user** — `~/.claude/skills/*` (read/write)
- **project** — `<path>/.claude/skills/*` (read/write; user picks path)
- **plugin** — `~/.claude/plugins/marketplaces/**/skills/*` (read-only, informational)

## Disable mechanism
- Rename dir `foo` → `.disabled.foo` (Claude's scanner skips dot-prefixed).
- Re-enable = rename back. Works on symlinks too.
- Zero risk: reversible, no file content edits.

## Tasks
- [x] Plan
- [x] `package.json`, `tsconfig.json`
- [x] `lib/skills.ts` — scan dirs, parse SKILL.md frontmatter, toggle (rename)
- [x] `server.ts` — Bun.serve with routes: `/`, `/api/skills`, `/api/toggle`
- [x] `public/index.html` + `public/app.tsx` — React UI (search, scope filter, toggle)
- [x] Wire project-path input (persist in localStorage)
- [x] README with `bun install && bun start`
- [x] Smoke test: list skills, toggle one, verify rename on disk, toggle back

## Non-goals (v1)
- Editing SKILL.md content
- Creating new skills
- Plugin enable/disable (that lives in settings.json — separate feature)
- Multi-project auto-discovery

## Review

**Built.** `bun install && bun start` → http://localhost:4173.

Smoke tests passed:
- `GET /` serves bundled React HTML (955 bytes)
- `GET /api/skills` returns user + plugin skills with parsed frontmatter
- `POST /api/toggle` round-trip: `__ccskill_test__` → `.disabled.__ccskill_test__` → back. Verified on disk.

**Files:**
- [server.ts](server.ts) — 50 lines, routes only
- [lib/skills.ts](lib/skills.ts) — scan/parse/rename
- [public/app.tsx](public/app.tsx) — React UI (single component)
- [public/index.html](public/index.html) — Tailwind via CDN

**Design notes:**
- Dotfolder rename chosen over settings.json extension — zero coupling to Claude Code internals, filesystem is ground truth.
- Path-escape guard in `toggleSkill` (refuses any `name` that would resolve outside the passed `root`).
- Plugin scope is read-only — toggling plugins lives in `settings.json`, different feature.
- Optimistic UI update on toggle, then reload to confirm.

**Not done (v1 non-goals, listed above):** edit SKILL.md, create skills, plugin toggle, multi-project discovery.
