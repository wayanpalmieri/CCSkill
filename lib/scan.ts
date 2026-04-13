import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export type Severity = "high" | "med" | "low";

export interface Finding {
  severity: Severity;
  rule: string;
  message: string;
  file: string;   // relative path
  line: number;
  snippet: string;
}

interface Rule {
  id: string;
  severity: Severity;
  message: string;
  re: RegExp;
  // optional per-line filter to reduce false positives
  guard?: (line: string) => boolean;
}

const RULES: Rule[] = [
  // --- HIGH: remote code execution / destructive ---
  {
    id: "curl-pipe-shell",
    severity: "high",
    message: "Downloads and executes remote code via shell pipe",
    re: /\b(curl|wget|fetch)\b[^\n`]*\|[^\n`]*\b(sh|bash|zsh|fish)\b/i,
  },
  {
    id: "bash-procsub-curl",
    severity: "high",
    message: "Runs remote script via bash process substitution",
    re: /\b(bash|sh|zsh)\b[^\n`]*<\s*\(\s*(curl|wget)/i,
  },
  {
    id: "rm-rf-root",
    severity: "high",
    message: "Destructive recursive delete of home/root",
    re: /\brm\s+-[rRf]+[rRf]*\s+(\/(\s|$)|~\/?|\$HOME\/?|\/\*)/,
  },
  {
    id: "ssh-privkey",
    severity: "high",
    message: "Reads SSH private keys",
    re: /~\/\.ssh\/(id_[a-z0-9_]+|[a-z0-9_]+_rsa|[a-z0-9_]+_ed25519)\b/i,
  },
  {
    id: "aws-creds",
    severity: "high",
    message: "Reads AWS credentials file",
    re: /~\/\.aws\/credentials\b/,
  },
  {
    id: "keychain-exfil",
    severity: "high",
    message: "Extracts secrets from macOS Keychain",
    re: /\bsecurity\s+(find-(generic|internet)-password|dump-keychain)\b/,
  },
  {
    id: "shell-rc-write",
    severity: "high",
    message: "Writes to shell init file (persistence)",
    re: /(>>?|tee\s+-a?)\s*~?\/?\.?(zshrc|bashrc|bash_profile|profile|zprofile|zshenv)\b/,
  },
  {
    id: "launchd-persist",
    severity: "high",
    message: "Installs a launch agent/daemon",
    re: /\blaunchctl\s+(load|bootstrap)\b|Library\/LaunchAgents\/|Library\/LaunchDaemons\//,
  },
  {
    id: "shell-true-python",
    severity: "high",
    message: "Python subprocess with shell=True (injection risk)",
    re: /\bsubprocess\.(Popen|call|run|check_output)\s*\([^)]*shell\s*=\s*True/,
  },
  {
    id: "eval-variable",
    severity: "high",
    message: "Uses eval on non-literal input",
    re: /\beval\s*\(\s*[A-Za-z_$]/,
  },
  {
    id: "base64-blob",
    severity: "high",
    message: "Long base64 string (possible obfuscated payload)",
    re: /([A-Za-z0-9+/=]{200,})/,
    guard: (line) => !/^\s*(#|\/\/|\*)/.test(line), // skip comments
  },
  {
    id: "modify-claude-settings",
    severity: "high",
    message: "Modifies Claude settings or hooks",
    re: /~?\/?\.claude\/(settings\.json|hooks\/|projects\/)/,
  },

  // --- MEDIUM ---
  {
    id: "sudo",
    severity: "med",
    message: "Uses sudo",
    re: /(^|\s)sudo\s+/,
  },
  {
    id: "chmod-777",
    severity: "med",
    message: "World-writable chmod",
    re: /\bchmod\s+-?R?\s*777\b/,
  },
  {
    id: "curl-outbound",
    severity: "med",
    message: "Outbound HTTP request",
    re: /\b(curl|wget|http(s)?\.get|fetch\()\b[^\n`]{0,80}https?:\/\/(?!localhost|127\.|0\.0\.0\.0)/i,
  },
  {
    id: "env-exfil",
    severity: "med",
    message: "Reads .env file",
    re: /\.env(\.[a-z0-9]+)?\b/,
    guard: (line) => /\b(cat|cp|read|open|fs\.|readFile|source)\b/.test(line),
  },
  {
    id: "child-process-exec",
    severity: "med",
    message: "Node child_process.exec (shell invocation)",
    re: /child_process\.exec(Sync)?\s*\(/,
  },
  {
    id: "os-system",
    severity: "med",
    message: "Python os.system (shell invocation)",
    re: /\bos\.system\s*\(/,
  },
  {
    id: "direct-ip",
    severity: "med",
    message: "Hardcoded non-local IPv4 in a URL",
    re: /https?:\/\/(?!127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
  },
  {
    id: "crypto-wallet",
    severity: "med",
    message: "References a crypto wallet path",
    re: /(~\/Library\/Application Support\/(Electrum|Exodus|MetaMask|Bitcoin|Ethereum)|wallet\.dat)\b/i,
  },

  // --- LOW ---
  {
    id: "hidden-unicode",
    severity: "low",
    message: "Invisible/bidi Unicode control character",
    re: /[\u202A-\u202E\u2066-\u2069\u200B-\u200F]/,
  },
];

const MAX_DEPTH = 4;
const MAX_FILE_BYTES = 512 * 1024;     // per-file cap
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_LINES = 5000;

function isScannable(name: string): boolean {
  return /\.(md|markdown|txt|json|yaml|yml|toml|js|mjs|cjs|ts|tsx|jsx|py|rb|sh|bash|zsh|fish|go|rs|java|c|cc|cpp|h|hpp|cs|swift|kt|php|pl|lua|r|html|htm|css|xml|sql|env|ini|conf|cfg)$/i.test(
    name,
  );
}

async function walk(dir: string, rel = "", depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > MAX_DEPTH) return out;
  let entries;
  try {
    entries = await readdir(join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rp = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(dir, rp, depth + 1, out);
    else if (isScannable(e.name)) out.push(rp);
  }
  return out;
}

export interface ScanReport {
  ok: true;
  scanned: number;
  skipped: number;
  totalBytes: number;
  findings: Finding[];
  truncated: boolean;
}

export async function scanSkill(dirPath: string): Promise<ScanReport> {
  const relFiles = await walk(dirPath);
  const findings: Finding[] = [];
  let total = 0;
  let scanned = 0;
  let skipped = 0;
  let truncated = false;

  for (const rel of relFiles) {
    const abs = join(dirPath, rel);
    let size = 0;
    try {
      size = (await stat(abs)).size;
    } catch {
      skipped++;
      continue;
    }
    if (size > MAX_FILE_BYTES) {
      skipped++;
      findings.push({
        severity: "low",
        rule: "large-file",
        message: `Skipped (>${MAX_FILE_BYTES / 1024}KB) — review manually`,
        file: rel,
        line: 0,
        snippet: "",
      });
      continue;
    }
    if (total + size > MAX_TOTAL_BYTES) {
      truncated = true;
      break;
    }
    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      skipped++;
      continue;
    }
    total += size;
    scanned++;

    const lines = content.split(/\r?\n/).slice(0, MAX_LINES);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const rule of RULES) {
        if (rule.guard && !rule.guard(line)) continue;
        const m = line.match(rule.re);
        if (m) {
          findings.push({
            severity: rule.severity,
            rule: rule.id,
            message: rule.message,
            file: rel,
            line: i + 1,
            snippet: line.trim().slice(0, 240),
          });
        }
      }
    }
  }

  // order: high → med → low, then by file
  findings.sort((a, b) => {
    const order: Record<Severity, number> = { high: 0, med: 1, low: 2 };
    return order[a.severity] - order[b.severity] || a.file.localeCompare(b.file);
  });

  return { ok: true, scanned, skipped, totalBytes: total, findings, truncated };
}
