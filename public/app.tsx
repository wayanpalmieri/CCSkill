import { createRoot } from "react-dom/client";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";

// ============================================================
// types
// ============================================================
type Scope = "user" | "project" | "plugin";

interface Skill {
  id: string;
  scope: Scope;
  name: string;
  enabled: boolean;
  path: string;
  root: string;
  description: string;
  readOnly: boolean;
  isSymlink: boolean;
}
interface SkillsResponse {
  user: Skill[];
  project: Skill[];
  plugin: Skill[];
  projectPath: string;
  mode: "none" | "project" | "workspace";
  workspaceProjects: string[];
}
interface FileNode {
  name: string;
  rel: string;
  size: number;
  isDir: boolean;
  isText: boolean;
}
interface SkillDetail {
  name: string;
  path: string;
  exists: boolean;
  frontmatter: Record<string, string>;
  version?: string;
  author?: string;
  license?: string;
  body: string;
  bodyTruncated: boolean;
  files: FileNode[];
  totalBytes: number;
  modifiedAt: string | null;
  symlinkTarget: string | null;
  provenance: { source: string; owner?: string; repo?: string };
}
type Severity = "high" | "med" | "low";
interface Finding {
  severity: Severity;
  rule: string;
  message: string;
  file: string;
  line: number;
  snippet: string;
}
interface ScanReport {
  ok: true;
  scanned: number;
  skipped: number;
  totalBytes: number;
  findings: Finding[];
  truncated: boolean;
}
type AuditStatus = "pass" | "warn" | "fail";
interface RegistryAudit { provider: string; status: AuditStatus }
interface RegistryEntry {
  found: boolean;
  url: string;
  owner: string;
  name: string;
  installs?: string;
  stars?: string;
  firstSeen?: string;
  installCommand?: string;
  audits: RegistryAudit[];
  fetchedAt: string;
  source: "skills.sh";
}

// ============================================================
// small utilities
// ============================================================
const SCOPE_DOT: Record<Scope, string> = {
  user: "bg-sky-400",
  project: "bg-emerald-400",
  plugin: "bg-amber-400",
};

function usePersisted<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    if (typeof localStorage === "undefined") return initial;
    return (localStorage.getItem(key) as T) ?? initial;
  });
  const set = (n: T) => {
    setV(n);
    localStorage.setItem(key, n);
  };
  return [v, set];
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function fuzzyScore(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const s = q.toLowerCase();
  if (t.includes(s)) return 100 + (t.startsWith(s) ? 50 : 0) - t.indexOf(s);
  let ti = 0;
  for (const ch of s) {
    const idx = t.indexOf(ch, ti);
    if (idx < 0) return 0;
    ti = idx + 1;
  }
  return 10;
}

// ============================================================
// toast
// ============================================================
interface Toast { id: number; text: string; tone: "ok" | "err" }
function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = (text: string, tone: "ok" | "err" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2400);
  };
  return { toasts, push };
}
function ToastStack({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`pointer-events-auto rounded-lg border px-3 py-2 text-[13px] shadow-xl backdrop-blur ${
            t.tone === "ok"
              ? "border-[var(--border-2)] bg-[var(--panel-2)] text-[var(--text)]"
              : "border-red-900/60 bg-red-950/70 text-red-200"
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ============================================================
// toggle
// ============================================================
function Toggle({
  enabled,
  disabled,
  onChange,
  label,
  size = "sm",
}: {
  enabled: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  label: string;
  size?: "sm" | "md";
}) {
  const dim = size === "sm"
    ? "h-[18px] w-[32px]"
    : "h-[22px] w-[40px]";
  const thumb = size === "sm"
    ? "h-[14px] w-[14px]"
    : "h-[18px] w-[18px]";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`${enabled ? "Disable" : "Enable"} ${label}`}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!enabled);
      }}
      className={`relative inline-flex ${dim} shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/60 focus:ring-offset-2 focus:ring-offset-[var(--bg)] disabled:cursor-not-allowed disabled:opacity-40 ${
        enabled ? "bg-[var(--accent)]" : "bg-[var(--border-2)]"
      }`}
    >
      <span
        className={`absolute left-0.5 inline-block ${thumb} transform rounded-full bg-white shadow-sm transition-transform ${
          enabled ? (size === "sm" ? "translate-x-[14px]" : "translate-x-[18px]") : "translate-x-0"
        }`}
      />
    </button>
  );
}

// ============================================================
// command palette
// ============================================================
function CommandPalette({
  open, skills, onClose, onToggle, onSelect,
}: {
  open: boolean;
  skills: Skill[];
  onClose: () => void;
  onToggle: (s: Skill, next: boolean) => void;
  onSelect: (s: Skill) => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) { setQ(""); setSel(0); setTimeout(() => inputRef.current?.focus(), 0); }
  }, [open]);

  const results = useMemo(() => {
    return skills
      .map((s) => ({ s, score: Math.max(fuzzyScore(q, s.name), fuzzyScore(q, s.description) * 0.3) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((x) => x.s);
  }, [q, skills]);

  useEffect(() => { if (sel >= results.length) setSel(0); }, [results, sel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/60 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[640px] max-w-[92vw] overflow-hidden rounded-xl border border-[var(--border-2)] bg-[var(--panel)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-[var(--border)] px-4 py-3">
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              else if (e.key === "Enter") {
                const s = results[sel];
                if (!s) return;
                if (e.metaKey || e.ctrlKey) { onSelect(s); onClose(); }
                else if (!s.readOnly) onToggle(s, !s.enabled);
              }
            }}
            placeholder="Search skills…"
            className="w-full bg-transparent text-[15px] text-[var(--text)] placeholder-[var(--dim)] focus:outline-none"
          />
        </div>
        <ul className="max-h-[50vh] overflow-y-auto">
          {results.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-[var(--dim)]">No matches.</li>
          )}
          {results.map((s, i) => (
            <li
              key={s.id}
              onMouseEnter={() => setSel(i)}
              onClick={() => (s.readOnly ? onSelect(s) : onToggle(s, !s.enabled))}
              className={`flex cursor-pointer items-center gap-3 px-4 py-2.5 ${
                i === sel ? "bg-[var(--panel-2)]" : ""
              }`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${SCOPE_DOT[s.scope]}`} />
              <span className={`font-medium ${s.enabled ? "text-[var(--text)]" : "text-[var(--muted)]"}`}>
                {s.name}
              </span>
              <span className="truncate text-[13px] text-[var(--dim)]">{s.description}</span>
              <span className="ml-auto shrink-0 text-[11px]">
                {s.readOnly ? (
                  <span className="text-[var(--dim)]">read-only</span>
                ) : s.enabled ? (
                  <span className="text-[var(--muted)]">on → off</span>
                ) : (
                  <span className="text-[var(--accent)]">off → on</span>
                )}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between border-t border-[var(--border)] bg-[var(--panel-2)]/60 px-4 py-2 text-[11px] text-[var(--dim)]">
          <span><kbd>↵</kbd> toggle &nbsp; <kbd>⌘↵</kbd> open &nbsp; <kbd>↑↓</kbd> move &nbsp; <kbd>esc</kbd> close</span>
          <span>{results.length} result{results.length === 1 ? "" : "s"}</span>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// help overlay
// ============================================================
function HelpOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  const rows: [string, string][] = [
    ["⌘K  /  ⌃K", "Command palette"],
    ["/", "Focus search"],
    ["j  /  ↓", "Next skill"],
    ["k  /  ↑", "Previous skill"],
    ["space  /  enter", "Toggle selected"],
    ["1  2  3  4", "Scope: all · user · project · plugin"],
    ["s", "Run security scan"],
    ["o", "Reveal in Finder"],
    ["r", "Refresh"],
    ["?", "Toggle this help"],
    ["esc", "Close overlays"],
  ];
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[480px] max-w-[92vw] rounded-xl border border-[var(--border-2)] bg-[var(--panel)] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
          Keyboard
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-sm">
          {rows.map(([k, v]) => (
            <Fragment key={k}>
              <dt className="font-mono text-[var(--muted)]">{k}</dt>
              <dd className="text-[var(--text)]">{v}</dd>
            </Fragment>
          ))}
        </dl>
      </div>
    </div>
  );
}

// ============================================================
// building blocks
// ============================================================
function Section({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-7">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
          {label}
        </h3>
        {hint && <span className="text-[11px] text-[var(--dim)]">{hint}</span>}
      </div>
      {children}
    </section>
  );
}
function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-[var(--muted)]">{k}</dt>
      <dd className="min-w-0 text-[var(--text)]">{children}</dd>
    </>
  );
}
function Dim({ children }: { children: React.ReactNode }) {
  return <span className="text-[var(--dim)]">{children}</span>;
}
function Chip({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "high" | "med" | "low" | "ok";
}) {
  const cls = {
    high: "bg-red-500/15 text-red-300 ring-red-500/30",
    med: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
    low: "bg-zinc-500/15 text-zinc-300 ring-zinc-500/30",
    ok: "bg-[var(--border)] text-[var(--muted)] ring-[var(--border-2)]",
  }[tone];
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${cls}`}>
      {children}
    </span>
  );
}


// ============================================================
// list row
// ============================================================
function ScopeSidebarButton({
  label,
  count,
  accent,
  active,
  onClick,
  compact,
}: {
  label: string;
  count: number;
  accent?: string;
  active: boolean;
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`group flex w-full items-center gap-2 rounded-md px-2.5 ${compact ? "py-1" : "py-1.5"} text-left text-[13px] transition-colors ${
        active
          ? "bg-[var(--accent-soft)] text-[var(--text)] ring-1 ring-inset ring-[var(--accent)]/30"
          : "text-[var(--muted)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]"
      }`}
    >
      {accent ? (
        <span className={`h-1.5 w-1.5 rounded-full ${accent} ${active ? "" : "opacity-60"}`} />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--border-2)]" />
      )}
      <span className="flex-1">{label}</span>
      <span className="font-mono text-[11px] tabular-nums text-[var(--dim)]">{count}</span>
    </button>
  );
}

// Derive the project folder name from a skill's root (`/path/to/proj/.claude/skills`).
function projectFolderName(root: string): string {
  const parts = root.split("/").filter(Boolean);
  // strip trailing ["", ".claude", "skills"] essentially
  const skillsIdx = parts.lastIndexOf("skills");
  if (skillsIdx >= 2 && parts[skillsIdx - 1] === ".claude") {
    return parts[skillsIdx - 2] ?? "project";
  }
  return parts[parts.length - 3] ?? "project";
}

interface Group {
  id: string;
  label: string;
  skills: Skill[];
}

function buildGroups(all: Skill[]): Group[] {
  const user: Skill[] = [];
  const plugin: Skill[] = [];
  const projectByRoot = new Map<string, Skill[]>();

  for (const s of all) {
    if (s.scope === "user") user.push(s);
    else if (s.scope === "plugin") plugin.push(s);
    else {
      const arr = projectByRoot.get(s.root) ?? [];
      arr.push(s);
      projectByRoot.set(s.root, arr);
    }
  }

  const groups: Group[] = [];
  if (user.length) groups.push({ id: "user", label: "User", skills: user });
  for (const [root, skills] of [...projectByRoot.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    groups.push({
      id: `project:${root}`,
      label: `Project · ${projectFolderName(root)}`,
      skills,
    });
  }
  if (plugin.length) groups.push({ id: "plugin", label: "Plugin", skills: plugin });
  return groups;
}

function GroupHeader({
  label,
  count,
  collapsed,
  onToggle,
  onBulk,
  bulkState,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onBulk?: (enable: boolean) => void;
  bulkState?: "all" | "none" | "mixed";
}) {
  return (
    <li
      onClick={onToggle}
      className="sticky top-0 z-10 flex cursor-pointer items-center gap-2 border-y border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)] backdrop-blur"
    >
      <span className={`inline-block w-3 text-center text-[9px] text-[var(--dim)] transition-transform ${collapsed ? "" : "rotate-90"}`}>
        ▸
      </span>
      <span className="flex-1">{label}</span>
      <span className="tabular-nums text-[var(--dim)]">{count}</span>
      {onBulk && (
        <div
          className="flex items-center gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => onBulk(true)}
            disabled={bulkState === "all"}
            className="rounded border border-[var(--border-2)] bg-[var(--panel-2)] px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-[var(--muted)] hover:bg-[var(--panel-3)] hover:text-[var(--text)] disabled:opacity-30"
            title="Enable all in this group"
          >
            on
          </button>
          <button
            onClick={() => onBulk(false)}
            disabled={bulkState === "none"}
            className="rounded border border-[var(--border-2)] bg-[var(--panel-2)] px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-[var(--muted)] hover:bg-[var(--panel-3)] hover:text-[var(--text)] disabled:opacity-30"
            title="Disable all in this group"
          >
            off
          </button>
        </div>
      )}
    </li>
  );
}

function ListRow({
  s,
  active,
  focused,
  busy,
  onClick,
  onToggle,
}: {
  s: Skill;
  active: boolean;
  focused: boolean;
  busy: boolean;
  onClick: () => void;
  onToggle: (next: boolean) => void;
}) {
  return (
    <li
      data-id={s.id}
      onClick={onClick}
      className={`group relative flex cursor-pointer flex-col gap-1.5 border-l-2 px-3.5 py-2.5 transition-colors ${
        active
          ? "border-[var(--accent)] bg-[var(--accent-soft)]"
          : focused
            ? "border-[var(--border-2)] bg-[var(--panel-3)]"
            : "border-transparent hover:bg-[var(--panel-3)]"
      }`}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${SCOPE_DOT[s.scope]} ${
            s.enabled ? "" : "opacity-30"
          }`}
        />
        <div className="min-w-0 flex-1">
          <div
            className={`truncate text-[13.5px] font-medium ${
              s.enabled ? "text-[var(--text)]" : "text-[var(--muted)]"
            }`}
          >
            {s.name}
          </div>
          <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-[1.45] text-[var(--dim)]">
            {s.description || <span className="italic">no description</span>}
          </p>
        </div>
        <Toggle
          enabled={s.enabled}
          disabled={s.readOnly || busy}
          onChange={onToggle}
          label={s.name}
        />
      </div>
      <div className="flex items-center gap-1.5 pl-[14px] text-[10px] text-[var(--dim)]">
        <span className="uppercase tracking-[0.08em]">{s.scope}</span>
        {!s.enabled && (
          <>
            <span>·</span>
            <span className="uppercase tracking-[0.08em]">off</span>
          </>
        )}
        {s.readOnly && (
          <>
            <span>·</span>
            <span className="uppercase tracking-[0.08em]">read-only</span>
          </>
        )}
        {s.isSymlink && (
          <>
            <span>·</span>
            <span className="uppercase tracking-[0.08em]">symlink</span>
          </>
        )}
      </div>
    </li>
  );
}

// ============================================================
// root app
// ============================================================
function App() {
  const [data, setData] = useState<SkillsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = usePersisted<Scope | "all">("ccskill:scope", "all");
  const [status, setStatus] = usePersisted<"all" | "enabled" | "disabled">("ccskill:status", "all");
  const [projectPath, setProjectPath] = useState<string>(() =>
    typeof localStorage !== "undefined" ? localStorage.getItem("ccskill:project") ?? "" : "",
  );
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    if (typeof localStorage === "undefined") return new Set();
    try {
      return new Set(JSON.parse(localStorage.getItem("ccskill:collapsed") ?? "[]"));
    } catch { return new Set(); }
  });
  const toggleCollapsed = (id: string) => {
    setCollapsed((c) => {
      const n = new Set(c);
      n.has(id) ? n.delete(id) : n.add(id);
      localStorage.setItem("ccskill:collapsed", JSON.stringify([...n]));
      return n;
    });
  };
  const { toasts, push } = useToasts();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const load = useCallback(async (pp = projectPath) => {
    setLoading(true);
    setError(null);
    try {
      const url = pp ? `/api/skills?project=${encodeURIComponent(pp)}` : "/api/skills";
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => { void load(); }, [load]);

  const all: Skill[] = useMemo(
    () => (data ? [...data.user, ...data.project, ...data.plugin] : []),
    [data],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((s) => {
      if (scope !== "all" && s.scope !== scope) return false;
      if (status === "enabled" && !s.enabled) return false;
      if (status === "disabled" && s.enabled) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
    });
  }, [all, query, scope, status]);

  // Group filtered skills for the left-pane render
  const groups = useMemo(() => buildGroups(filtered), [filtered]);

  // The "visible skills" list that keyboard nav actually walks — skips any
  // skills inside a collapsed group.
  const visibleSkills: Skill[] = useMemo(() => {
    const out: Skill[] = [];
    for (const g of groups) {
      if (collapsed.has(g.id)) continue;
      out.push(...g.skills);
    }
    return out;
  }, [groups, collapsed]);

  useEffect(() => {
    if (focusIdx >= visibleSkills.length) setFocusIdx(0);
  }, [visibleSkills, focusIdx]);

  // auto-select focused on filter change if nothing selected
  useEffect(() => {
    if (!selectedId && visibleSkills.length > 0) setSelectedId(visibleSkills[0].id);
  }, [visibleSkills, selectedId]);

  const selectedSkill = useMemo(
    () => all.find((s) => s.id === selectedId) ?? null,
    [all, selectedId],
  );

  const counts = useMemo(() => ({
    total: all.length,
    enabled: all.filter((s) => s.enabled).length,
    user: data?.user.length ?? 0,
    project: data?.project.length ?? 0,
    plugin: data?.plugin.length ?? 0,
  }), [all, data]);

  const onToggle = async (s: Skill, next: boolean) => {
    if (s.readOnly) { push("Plugin skills are read-only", "err"); return; }
    setBusy((b) => new Set(b).add(s.id));
    setData((d) => d ? {
      ...d,
      user: d.user.map((x) => x.id === s.id ? { ...x, enabled: next } : x),
      project: d.project.map((x) => x.id === s.id ? { ...x, enabled: next } : x),
    } : d);
    try {
      const r = await fetch("/api/toggle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root: s.root, name: s.name, enable: next, readOnly: s.readOnly }),
      });
      if (!r.ok) {
        const { error } = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
        throw new Error(error);
      }
      push(`${s.name} ${next ? "enabled" : "disabled"}`);
      await load();
    } catch (e: any) {
      push(e?.message ?? String(e), "err");
      await load();
    } finally {
      setBusy((b) => { const n = new Set(b); n.delete(s.id); return n; });
    }
  };

  const reveal = async (s: Skill) => {
    try {
      const r = await fetch("/api/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: s.path }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e: any) {
      push(e?.message ?? String(e), "err");
    }
  };

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inField = tag === "INPUT" || tag === "TEXTAREA";
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault(); setPaletteOpen(true); return;
      }
      if (e.key === "Escape") {
        if (paletteOpen) setPaletteOpen(false);
        else if (helpOpen) setHelpOpen(false);
        else if (document.activeElement === searchRef.current) searchRef.current?.blur();
        return;
      }
      if (inField) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus(); searchRef.current?.select();
      } else if (e.key === "?") {
        setHelpOpen((v) => !v);
      } else if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setFocusIdx((i) => {
          const next = Math.min(i + 1, visibleSkills.length - 1);
          const s = visibleSkills[next];
          if (s) setSelectedId(s.id);
          return next;
        });
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocusIdx((i) => {
          const next = Math.max(i - 1, 0);
          const s = visibleSkills[next];
          if (s) setSelectedId(s.id);
          return next;
        });
      } else if (e.key === " " || e.key === "Enter") {
        const s = visibleSkills[focusIdx];
        if (s && !s.readOnly) { e.preventDefault(); void onToggle(s, !s.enabled); }
      } else if (e.key === "r") {
        void load();
      } else if (e.key === "o") {
        if (selectedSkill) void reveal(selectedSkill);
      } else if (e.key === "s") {
        // scan shortcut — dispatch a custom event the detail pane listens for
        window.dispatchEvent(new Event("ccskill:scan"));
      } else if (["1", "2", "3", "4"].includes(e.key)) {
        const map = ["all", "user", "project", "plugin"] as const;
        setScope(map[parseInt(e.key, 10) - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSkills, focusIdx, paletteOpen, helpOpen, selectedSkill]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-id="${visibleSkills[focusIdx]?.id}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [focusIdx, visibleSkills]);

  const saveProject = () => {
    localStorage.setItem("ccskill:project", projectPath);
    void load(projectPath);
  };
  const clearProject = () => {
    setProjectPath("");
    localStorage.removeItem("ccskill:project");
    void load("");
  };

  return (
    <div className="flex h-screen flex-col">
      {/* top bar */}
      <header className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-5 py-3">
        <div className="flex items-baseline gap-2.5">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-[var(--accent)]" />
            <span className="text-[13px] font-semibold tracking-tight">CCSkill</span>
          </div>
          <span className="hidden text-[12px] text-[var(--muted)] md:inline">
            Browse, toggle, and audit Claude Code skills — view user, project, and plugin skills in one place.
          </span>
        </div>
        <div className="relative w-[320px]">
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 pr-8 text-[13px] placeholder-[var(--dim)] focus:border-[var(--accent)]/50 focus:outline-none"
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">/</kbd>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]"
          >
            <span>Search skills</span>
            <kbd>⌘K</kbd>
          </button>
          <button
            onClick={() => setHelpOpen(true)}
            className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]"
            title="Shortcuts (?)"
          >
            ?
          </button>
        </div>
      </header>

      {/* project bar */}
      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)]/60 px-5 py-2 text-[12px]">
        <span className="text-[var(--muted)]">Project</span>
        <input
          value={projectPath}
          onChange={(e) => setProjectPath(e.target.value)}
          placeholder="Project folder, or parent folder of multiple projects"
          className="flex-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-1 text-[12px] placeholder-[var(--dim)] focus:border-[var(--accent)]/50 focus:outline-none"
          onKeyDown={(e) => { if (e.key === "Enter") saveProject(); }}
        />
        <button
          onClick={async () => {
            try {
              const r = await fetch("/api/pick-folder", { method: "POST" });
              const j = await r.json();
              if (j.cancelled) return;
              if (j.path) {
                setProjectPath(j.path);
                localStorage.setItem("ccskill:project", j.path);
                void load(j.path);
              }
            } catch (e: any) {
              push(e?.message ?? String(e), "err");
            }
          }}
          className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]"
          title="Open macOS folder picker"
        >
          Browse…
        </button>
        <button
          onClick={saveProject}
          className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[12px] font-medium text-[#0a0a0b] hover:brightness-110"
        >
          Load
        </button>
        {projectPath && (
          <button
            onClick={clearProject}
            className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]"
          >
            Clear
          </button>
        )}
        <button
          onClick={() => load()}
          className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]"
          title="Refresh (r)"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="border-b border-red-900/40 bg-red-950/30 px-5 py-2 text-[12px] text-red-300">
          {error}
        </div>
      )}

      {/* main split */}
      <div className="flex min-h-0 flex-1">
        {/* scope sidebar */}
        <nav
          aria-label="Scope"
          className="flex w-[148px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--panel)]/40 p-2"
        >
          <ScopeSidebarButton
            label="All"
            count={counts.total}
            active={scope === "all"}
            onClick={() => setScope("all")}
          />
          <ScopeSidebarButton
            label="User"
            count={counts.user}
            accent={SCOPE_DOT.user}
            active={scope === "user"}
            onClick={() => setScope("user")}
          />
          <ScopeSidebarButton
            label="Project"
            count={counts.project}
            accent={SCOPE_DOT.project}
            active={scope === "project"}
            onClick={() => setScope("project")}
          />
          <ScopeSidebarButton
            label="Plugin"
            count={counts.plugin}
            accent={SCOPE_DOT.plugin}
            active={scope === "plugin"}
            onClick={() => setScope("plugin")}
          />

          <div className="mt-auto space-y-1 border-t border-[var(--border)] pt-2 text-[11px]">
            <div className="px-2 pb-1 uppercase tracking-[0.14em] text-[var(--dim)]">Status</div>
            <ScopeSidebarButton
              label="On"
              count={counts.enabled}
              active={status === "enabled"}
              onClick={() =>
                setStatus(status === "enabled" ? "all" : "enabled")
              }
              compact
            />
            <ScopeSidebarButton
              label="Off"
              count={counts.total - counts.enabled}
              active={status === "disabled"}
              onClick={() =>
                setStatus(status === "disabled" ? "all" : "disabled")
              }
              compact
            />
          </div>
        </nav>

        {/* list */}
        <aside className="flex w-[380px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--panel)]/60">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2 text-[11px] uppercase tracking-[0.14em] text-[var(--dim)]">
            <span>
              {filtered.length} skill{filtered.length === 1 ? "" : "s"}
            </span>
            {data?.mode === "workspace" && data.workspaceProjects.length > 0 && (
              <span className="normal-case tracking-normal text-[var(--muted)]">
                {data.workspaceProjects.length} project{data.workspaceProjects.length === 1 ? "" : "s"} found
              </span>
            )}
          </div>
          {loading && !data ? (
            <ListSkeleton />
          ) : (
            <ul ref={listRef} className="flex-1 overflow-y-auto">
              {filtered.length === 0 && (
                <li className="px-4 py-8 text-center text-[13px] text-[var(--dim)]">
                  No skills match.
                </li>
              )}
              {(() => {
                const nodes: React.ReactNode[] = [];
                let visibleIdx = 0;
                for (const g of groups) {
                  const isCollapsed = collapsed.has(g.id);
                  const writable = g.skills.filter((s) => !s.readOnly);
                  const enabledCount = writable.filter((s) => s.enabled).length;
                  const bulkState: "all" | "none" | "mixed" | undefined =
                    writable.length === 0
                      ? undefined
                      : enabledCount === writable.length
                        ? "all"
                        : enabledCount === 0
                          ? "none"
                          : "mixed";
                  nodes.push(
                    <GroupHeader
                      key={`h:${g.id}`}
                      label={g.label}
                      count={g.skills.length}
                      collapsed={isCollapsed}
                      onToggle={() => toggleCollapsed(g.id)}
                      onBulk={
                        writable.length
                          ? (enable) => {
                              // Fire toggles sequentially to keep filesystem ops predictable.
                              (async () => {
                                for (const s of writable) {
                                  if (s.enabled !== enable) await onToggle(s, enable);
                                }
                              })();
                            }
                          : undefined
                      }
                      bulkState={bulkState}
                    />,
                  );
                  if (!isCollapsed) {
                    for (const s of g.skills) {
                      const idx = visibleIdx++;
                      nodes.push(
                        <ListRow
                          key={s.id}
                          s={s}
                          active={selectedId === s.id}
                          focused={focusIdx === idx}
                          busy={busy.has(s.id)}
                          onClick={() => { setSelectedId(s.id); setFocusIdx(idx); }}
                          onToggle={(v) => onToggle(s, v)}
                        />,
                      );
                    }
                  } else {
                    // still advance visibleIdx? No — collapsed items are NOT
                    // part of visibleSkills, so the running index stays aligned.
                  }
                }
                return nodes;
              })()}
            </ul>
          )}
        </aside>

        {/* detail */}
        <main className="min-w-0 flex-1 bg-[var(--bg)]">
          <DetailPaneWrapper
            skill={selectedSkill}
            onToggle={onToggle}
            onReveal={reveal}
            busy={selectedSkill ? busy.has(selectedSkill.id) : false}
          />
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        skills={all}
        onClose={() => setPaletteOpen(false)}
        onToggle={(s, next) => void onToggle(s, next)}
        onSelect={(s) => { setSelectedId(s.id); const idx = filtered.findIndex((x) => x.id === s.id); if (idx >= 0) setFocusIdx(idx); }}
      />
      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
      <ToastStack toasts={toasts} />
    </div>
  );
}

// Wrapper so the `s` shortcut can trigger a scan inside DetailPane
function DetailPaneWrapper(props: {
  skill: Skill | null;
  onToggle: (s: Skill, next: boolean) => void;
  onReveal: (s: Skill) => void;
  busy: boolean;
}) {
  // We re-use DetailPane but listen for the `ccskill:scan` event to kick off a scan.
  // DetailPane exposes its scan trigger via a ref-less pattern: re-render by key.
  const [scanNonce, setScanNonce] = useState(0);
  useEffect(() => {
    const h = () => setScanNonce((n) => n + 1);
    window.addEventListener("ccskill:scan", h);
    return () => window.removeEventListener("ccskill:scan", h);
  }, []);
  return <DetailPaneInner {...props} scanNonce={scanNonce} />;
}

function DetailPaneInner(props: {
  skill: Skill | null;
  onToggle: (s: Skill, next: boolean) => void;
  onReveal: (s: Skill) => void;
  busy: boolean;
  scanNonce: number;
}) {
  const { skill, scanNonce } = props;
  // Same implementation as DetailPane, but exposes `triggerScan` via scanNonce.
  // To keep the file compact, we inline by composing DetailPane with a scan trigger.
  // We'll re-implement scanning here because DetailPane above owns that state.
  return <DetailPaneBase {...props} key={skill?.id ?? "none"} externalScanNonce={scanNonce} />;
}

// ---- DetailPaneBase: the actual implementation (folded from DetailPane) ----
function DetailPaneBase({
  skill, onToggle, onReveal, busy, externalScanNonce,
}: {
  skill: Skill | null;
  onToggle: (s: Skill, next: boolean) => void;
  onReveal: (s: Skill) => void;
  busy: boolean;
  externalScanNonce: number;
}) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [scan, setScan] = useState<ScanReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [registry, setRegistry] = useState<RegistryEntry | null>(null);
  const [registryLoading, setRegistryLoading] = useState(false);

  // Look up skills.sh whenever detail resolves and we can guess an owner.
  useEffect(() => {
    setRegistry(null);
    if (!detail) return;
    const owner =
      detail.provenance.owner ??
      detail.frontmatter?.author?.split("/")[0] ??
      detail.frontmatter?.["metadata.author"]?.split("/")[0];
    if (!owner) return;
    let cancelled = false;
    setRegistryLoading(true);
    fetch(
      `/api/registry?owner=${encodeURIComponent(owner)}&name=${encodeURIComponent(detail.name)}`,
    )
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setRegistry(d); })
      .catch(() => { /* silent — fallback link still shown */ })
      .finally(() => { if (!cancelled) setRegistryLoading(false); });
    return () => { cancelled = true; };
  }, [detail]);

  useEffect(() => {
    setScan(null); setScanError(null);
    if (!skill) { setDetail(null); return; }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/detail?path=${encodeURIComponent(skill.path)}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch(() => { if (!cancelled) setDetail(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [skill?.id, skill?.path, skill?.enabled]);

  const runScan = useCallback(async () => {
    if (!skill) return;
    setScanning(true); setScanError(null); setScan(null);
    try {
      const r = await fetch(`/api/scan?path=${encodeURIComponent(skill.path)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setScan(await r.json());
    } catch (e: any) { setScanError(e?.message ?? String(e)); }
    finally { setScanning(false); }
  }, [skill]);

  // respond to `s` shortcut
  useEffect(() => {
    if (externalScanNonce > 0) void runScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalScanNonce]);

  if (!skill) {
    return (
      <div className="flex h-full items-center justify-center text-center">
        <div>
          <div className="text-[var(--dim)] text-sm">Select a skill</div>
          <div className="mt-1 text-[11px] text-[var(--dim)]">
            <kbd>↑</kbd> <kbd>↓</kbd> to move &nbsp;·&nbsp; <kbd>⌘K</kbd> to search
          </div>
        </div>
      </div>
    );
  }

  const highs = scan?.findings.filter((f) => f.severity === "high").length ?? 0;
  const meds = scan?.findings.filter((f) => f.severity === "med").length ?? 0;
  const lows = scan?.findings.filter((f) => f.severity === "low").length ?? 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-[var(--border)] px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`h-1.5 w-1.5 rounded-full ${SCOPE_DOT[skill.scope]}`} />
              <h2 className="truncate text-lg font-semibold text-[var(--text)]">
                {detail?.name ?? skill.name}
              </h2>
              {!skill.enabled && <span className="rounded bg-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">disabled</span>}
              {skill.readOnly && <span className="rounded bg-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">read-only</span>}
            </div>
            <p className="mt-1 line-clamp-3 text-[13px] leading-relaxed text-[var(--muted)]">{skill.description}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Toggle
              enabled={skill.enabled}
              disabled={skill.readOnly || busy}
              onChange={(v) => onToggle(skill, v)}
              label={skill.name}
              size="md"
            />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-1.5">
          <button
            onClick={runScan}
            disabled={scanning}
            className="rounded-md border border-[var(--border-2)] bg-[var(--panel-2)] px-2.5 py-1 text-[12px] text-[var(--text)] hover:border-[var(--accent)]/40 disabled:opacity-50"
            title="Run heuristic security scan (s)"
          >
            {scanning ? "Scanning…" : "Security scan"}
          </button>
          <button
            onClick={() => onReveal(skill)}
            className="rounded-md border border-[var(--border-2)] bg-[var(--panel-2)] px-2.5 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]"
            title="Reveal in Finder (o)"
          >
            Reveal in Finder
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {loading && (
          <div className="animate-pulse space-y-3">
            <div className="h-3 w-24 rounded bg-[var(--border)]" />
            <div className="h-3 w-64 rounded bg-[var(--border)]" />
            <div className="h-3 w-48 rounded bg-[var(--border)]" />
          </div>
        )}
        {!loading && detail && (
          <>
            <Section label="Metadata">
              <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 text-[13px]">
                <Row k="Source">
                  <span className="capitalize">{detail.provenance.source}</span>
                  {detail.provenance.owner && (
                    <span className="ml-1 text-[var(--dim)]">· {detail.provenance.owner}{detail.provenance.repo ? `/${detail.provenance.repo}` : ""}</span>
                  )}
                </Row>
                <Row k="Version">{detail.version ?? <Dim>—</Dim>}</Row>
                <Row k="Author">{detail.author ?? <Dim>—</Dim>}</Row>
                <Row k="License">{detail.license ?? <Dim>—</Dim>}</Row>
                <Row k="Modified">{timeAgo(detail.modifiedAt)}</Row>
                <Row k="Files">{detail.files.filter((f) => !f.isDir).length}<span className="ml-1 text-[var(--dim)]">· {formatBytes(detail.totalBytes)}</span></Row>
                {detail.symlinkTarget && (
                  <Row k="Symlink"><span className="font-mono text-[12px] text-[var(--muted)]">→ {detail.symlinkTarget}</span></Row>
                )}
              </dl>
            </Section>

            <Section
              label="skills.sh"
              hint={
                registry?.found
                  ? `Fetched ${timeAgo(registry.fetchedAt)} · cached 1h`
                  : "best-effort scrape — no public API"
              }
            >
              <RegistrySection
                detail={detail}
                registry={registry}
                loading={registryLoading}
              />
            </Section>

            <Section label="Security scan" hint="Heuristic — verify findings manually.">
              {!scan && !scanning && !scanError && (
                <div className="text-[13px] text-[var(--dim)]">Not run. Press <kbd>s</kbd> or click <span className="text-[var(--muted)]">Security scan</span>.</div>
              )}
              {scanning && <div className="text-[13px] text-[var(--muted)]">Scanning files…</div>}
              {scanError && <div className="text-[13px] text-red-300">Scan failed: {scanError}</div>}
              {scan && (
                <>
                  <div className="mb-3 flex gap-2 text-[12px]">
                    <Chip tone={highs ? "high" : "ok"}>{highs} high</Chip>
                    <Chip tone={meds ? "med" : "ok"}>{meds} medium</Chip>
                    <Chip tone={lows ? "low" : "ok"}>{lows} low</Chip>
                    <span className="ml-auto text-[var(--dim)]">{scan.scanned} file{scan.scanned === 1 ? "" : "s"} · {formatBytes(scan.totalBytes)}</span>
                  </div>
                  {scan.findings.length === 0 ? (
                    <div className="rounded-md border border-emerald-900/40 bg-emerald-950/20 px-3 py-2 text-[13px] text-emerald-300">
                      No suspicious patterns found.
                    </div>
                  ) : (
                    <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-md border border-[var(--border)]">
                      {scan.findings.map((f, i) => (
                        <li key={i} className="p-3">
                          <div className="flex items-center gap-2 text-[12px]">
                            <Chip tone={f.severity === "high" ? "high" : f.severity === "med" ? "med" : "low"}>{f.severity.toUpperCase()}</Chip>
                            <span className="font-medium text-[var(--text)]">{f.message}</span>
                            <span className="ml-auto font-mono text-[11px] text-[var(--dim)]">{f.file}:{f.line}</span>
                          </div>
                          {f.snippet && (
                            <pre className="mt-1.5 overflow-x-auto rounded bg-[var(--panel-2)] px-2 py-1 font-mono text-[11.5px] text-[var(--muted)]">{f.snippet}</pre>
                          )}
                          <div className="mt-1 text-[11px] text-[var(--dim)]">rule: {f.rule}</div>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </Section>

            <Section label={`Files (${detail.files.filter((f) => !f.isDir).length})`}>
              <ul className="space-y-0.5 font-mono text-[12px]">
                {detail.files.map((f) => (
                  <li key={f.rel} className={`flex items-center justify-between ${f.isDir ? "text-[var(--muted)]" : "text-[var(--text)]"}`}>
                    <span><span className="text-[var(--dim)]">{f.isDir ? "▸ " : "  "}</span>{f.rel}</span>
                    {!f.isDir && <span className="text-[var(--dim)]">{formatBytes(f.size)}</span>}
                  </li>
                ))}
              </ul>
            </Section>

            <Section label="SKILL.md">
              <pre className="whitespace-pre-wrap rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-4 font-mono text-[12.5px] leading-[1.55] text-[var(--muted)]">
                {detail.body || "(empty)"}
                {detail.bodyTruncated && <span className="text-[var(--dim)]">{"\n\n— truncated —"}</span>}
              </pre>
            </Section>

            <div className="mt-6 text-[11px] text-[var(--dim)]">
              <span className="font-mono">{detail.path}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RegistrySection({
  detail,
  registry,
  loading,
}: {
  detail: SkillDetail;
  registry: RegistryEntry | null;
  loading: boolean;
}) {
  // Guess owner for link purposes, even when no lookup fired.
  const guessedOwner =
    detail.provenance.owner ??
    detail.frontmatter?.author?.split("/")[0] ??
    detail.frontmatter?.["metadata.author"]?.split("/")[0];
  const guessedUrl = guessedOwner
    ? `https://skills.sh/${encodeURIComponent(guessedOwner)}/skills/${encodeURIComponent(detail.name)}`
    : `https://skills.sh/`;

  if (!guessedOwner) {
    const googleQuery = encodeURIComponent(`site:skills.sh ${detail.name}`);
    return (
      <div className="flex flex-wrap items-center gap-3 text-[13px] text-[var(--muted)]">
        <span>No publisher detected for this skill.</span>
        <a
          href={`https://www.google.com/search?q=${googleQuery}`}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[var(--accent)] hover:underline"
          title="Google site-search scoped to skills.sh"
        >
          Search Google for "{detail.name}" on skills.sh ↗
        </a>
        <a
          href="https://skills.sh/"
          target="_blank"
          rel="noreferrer noopener"
          className="text-[var(--dim)] hover:text-[var(--muted)] hover:underline"
        >
          or browse skills.sh ↗
        </a>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="animate-pulse space-y-2">
        <div className="h-3 w-40 rounded bg-[var(--border)]" />
        <div className="h-3 w-56 rounded bg-[var(--border)]" />
      </div>
    );
  }

  if (!registry || !registry.found) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <span className="text-[var(--muted)]">
          Not listed on skills.sh under{" "}
          <span className="font-mono text-[var(--text)]">{guessedOwner}/{detail.name}</span>.
        </span>
        <a
          href={guessedUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[var(--accent)] hover:underline"
        >
          Open link anyway ↗
        </a>
      </div>
    );
  }

  const toneFor = (s: AuditStatus) =>
    s === "pass" ? "ok-good" : s === "warn" ? "med" : "high";

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-[13px]">
        <a
          href={registry.url}
          target="_blank"
          rel="noreferrer noopener"
          className="font-medium text-[var(--accent)] hover:underline"
        >
          skills.sh/{registry.owner}/skills/{registry.name} ↗
        </a>
        {registry.installs && (
          <span className="text-[var(--muted)]">
            <span className="tabular-nums text-[var(--text)]">{registry.installs}</span> weekly installs
          </span>
        )}
        {registry.stars && (
          <span className="text-[var(--muted)]">
            <span className="tabular-nums text-[var(--text)]">★ {registry.stars}</span>
          </span>
        )}
        {registry.firstSeen && (
          <span className="text-[var(--dim)]">Listed {registry.firstSeen}</span>
        )}
      </div>

      {registry.audits.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-[var(--border)]">
          <div className="border-b border-[var(--border)] bg-[var(--panel-2)]/60 px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
            Third-party audits
          </div>
          <ul className="divide-y divide-[var(--border)]">
            {registry.audits.map((a) => (
              <li
                key={a.provider}
                className="flex items-center justify-between px-3 py-2 text-[13px]"
              >
                <span className="text-[var(--text)]">{a.provider}</span>
                <AuditBadge status={a.status} />
              </li>
            ))}
          </ul>
          <div className="border-t border-[var(--border)] bg-[var(--panel-2)]/40 px-3 py-1.5 text-[11px] text-[var(--dim)]">
            Audits are run by their respective providers; CCSkill surfaces them as reported by skills.sh.
          </div>
        </div>
      ) : (
        <div className="text-[13px] text-[var(--dim)]">No third-party audits reported.</div>
      )}

      {registry.installCommand && (
        <div className="mt-3">
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
            Install command
          </div>
          <pre className="overflow-x-auto rounded bg-[var(--panel-2)] px-2 py-1.5 font-mono text-[12px] text-[var(--text)]">
            {registry.installCommand}
          </pre>
        </div>
      )}
    </>
  );
}

function AuditBadge({ status }: { status: AuditStatus }) {
  const cls =
    status === "pass"
      ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30"
      : status === "warn"
        ? "bg-amber-500/15 text-amber-300 ring-amber-500/30"
        : "bg-red-500/15 text-red-300 ring-red-500/30";
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ring-inset ${cls}`}>
      {status}
    </span>
  );
}

function ListSkeleton() {
  return (
    <ul className="flex-1 overflow-hidden py-1">
      {Array.from({ length: 14 }).map((_, i) => (
        <li key={i} className="flex items-center gap-3 px-3 py-2">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--border)]" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-24 animate-pulse rounded bg-[var(--border)]" />
            <div className="h-2.5 w-48 animate-pulse rounded bg-[var(--panel-2)]" />
          </div>
          <div className="h-[18px] w-[32px] rounded-full bg-[var(--border)]" />
        </li>
      ))}
    </ul>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
