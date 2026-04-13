# CCSkill

Local web app to view and toggle Claude Code skills.

## Run

```bash
bun install
bun start
```

Then open http://localhost:4173.

## What it does

- Lists skills from three scopes:
  - **user** — `~/.claude/skills/`
  - **project** — `<path>/.claude/skills/` (enter a path in the UI)
  - **plugin** — `~/.claude/plugins/marketplaces/**/skills/` (read-only)
- Search, filter by scope / enabled state.
- Toggle a skill on/off.

## How disable works

Disabling renames the folder `foo` → `.disabled.foo`. Claude Code's skill
scanner skips dot-prefixed directories, so the skill is invisible to Claude
while on disk. Re-enabling renames it back. Works on symlinks too — the
symlink itself is renamed; its target is untouched.

No file contents are ever edited.

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

CCSkill's "Security scan" is a *heuristic pattern linter*, not a malware
scanner, not a sandbox, and not a security audit. It flags a small set of
obviously suspicious patterns (remote pipe-to-shell, credential reads,
destructive deletes, obfuscated base64, shell-init persistence, etc.). It
will miss anything the author bothered to obfuscate, any novel technique,
and any purely-prompt-based attack that lives in natural language. A clean
scan means "no obvious red flags," **not** "this skill is safe."

**About the skills.sh integration:**

For published skills, CCSkill also surfaces third-party audit results
(Socket, Snyk, Gen Agent Trust Hub, etc.) and install/star stats from
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
