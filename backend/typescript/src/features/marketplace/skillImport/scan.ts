/**
 * ADR 1044 D4 — the install-lure scanner. Reads text, runs nothing.
 *
 * The ClawHavoc skills (341 on ClawHub, February 2026) were plain Markdown that
 * asked the user or the agent to run a "prerequisite" installer: a `curl | bash`,
 * a `base64 -D | bash`, or a password-protected zip carrying a macOS
 * infostealer. Those shapes BLOCK the import. Softer install instructions WARN
 * and need the admin's acknowledgement. Invisible Unicode blocks too: it can hide
 * an instruction from the human reviewing the file while the model still reads it.
 */

export type FindingSeverity = 'block' | 'warn';

export interface ScanFinding {
  severity: FindingSeverity;
  rule: string;
  file: string;
  line: number;
  excerpt: string;
}

interface Rule { id: string; severity: FindingSeverity; re: RegExp; why: string }

const SHELLS = String.raw`(?:sudo\s+)?(?:ba|z|da|k|fi)?sh|python[0-9.]*|node|perl|ruby|php|iex|Invoke-Expression|pwsh|powershell`;
const FETCHERS = String.raw`curl|wget|fetch|iwr|irm|Invoke-WebRequest|Invoke-RestMethod`;

export const LURE_RULES: readonly Rule[] = [
  { id: 'pipe-to-shell', severity: 'block', why: 'downloads a script and pipes it into a shell or interpreter',
    re: new RegExp(String.raw`\b(?:${FETCHERS})\b[^\n]*\|\s*(?:${SHELLS})\b`, 'i') },
  { id: 'process-substitution', severity: 'block', why: 'runs a downloaded script through process substitution',
    re: new RegExp(String.raw`\b(?:ba|z)?sh\s+<\(\s*(?:${FETCHERS})\b`, 'i') },
  { id: 'eval-download', severity: 'block', why: 'evaluates downloaded text',
    re: new RegExp(String.raw`\beval\s*["'(]?\s*\$\(\s*(?:${FETCHERS})\b`, 'i') },
  { id: 'encoded-exec', severity: 'block', why: 'decodes hidden text and runs it',
    re: new RegExp(String.raw`base64\s+(?:-d|-D|--decode)\b[^\n]*\|\s*(?:${SHELLS})\b|\|\s*base64\s+(?:-d|-D|--decode)\b|\b(?:pwsh|powershell)(?:\.exe)?\b[^\n]*\s-(?:e|ec|enc|encodedcommand)\s|FromBase64String|\beval\s*\(\s*atob\s*\(`, 'i') },
  { id: 'quarantine-bypass', severity: 'block', why: 'removes macOS Gatekeeper or quarantine protection',
    re: /\bxattr\s+(?:-[a-z]*[dcr][a-z]*\s+)+(?:[^\n]*quarantine|[^\n]*\.app)|\bxattr\s+-c\b|\bspctl\s+--master-disable\b|--no-quarantine\b/i },
  { id: 'credential-prompt', severity: 'block', why: 'asks for a system, admin or keychain password',
    re: /\b(?:enter|type|provide|paste|input)\s+(?:in\s+)?(?:your\s+)?(?:mac(?:os)?|system|admin(?:istrator)?|login|keychain|sudo|root|computer)\s+password\b|\bsecurity\s+(?:find|dump)-(?:generic|internet)-password\b|\bdump-keychain\b|\bdscl\s+\.\s+-authonly\b|\bosascript\b[^\n]*password/i },
  { id: 'download-and-run', severity: 'block', why: 'downloads a file, makes it executable and runs it',
    re: new RegExp(String.raw`\b(?:${FETCHERS})\b[^\n]*(?:chmod\s+\+?[0-7]*x|&&\s*\.\/|;\s*\.\/|&&\s*open\s)|chmod\s+\+x\s+[^\n]*&&\s*\.\/`, 'i') },
  { id: 'download-executable', severity: 'block', why: 'links to an executable or installer download',
    re: /https?:\/\/[^\s)>\]"']+\.(?:exe|scr|msi|dmg|pkg|app|sh|bash|command|ps1|bat|cmd|vbs|jar|apk|appimage|deb|rpm)(?:[?#][^\s)>\]"']*)?(?=$|[\s)>\]"'.,;])/i },
  { id: 'archive-password', severity: 'block', why: 'hands out a password for an archive (used to slip malware past scanners)',
    re: /\b(?:zip|rar|7z|archive)\b[^\n]{0,80}\bpass(?:word|code|wd)\b\s*[:=]|\bpass(?:word|code|wd)\b\s*[:=][^\n]{0,40}\b(?:zip|rar|7z|archive)\b|\b(?:zip|rar|7z|archive)\b[^\n]{0,40}\(\s*pass(?:word|code|wd)\b/i },
  { id: 'osascript-shell', severity: 'block', why: 'runs a shell command through AppleScript',
    re: /\bosascript\b[^\n]*do shell script/i },
  { id: 'package-install', severity: 'warn', why: 'asks to install a package',
    re: /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b|\bnpx\s+-?[\w@]|\bpip[0-9.]*\s+install\b|\bpipx\s+install\b|\buv\s+(?:pip\s+install|tool\s+install|add)\b|\bbrew\s+(?:install|tap)\b|\bapt(?:-get)?\s+install\b|\b(?:dnf|yum|pacman|apk|zypper)\s+(?:install|add|-S)\b|\bgo\s+install\b|\bcargo\s+install\b|\bgem\s+install\b|\b(?:choco|winget|scoop)\s+install\b/i },
  { id: 'sudo', severity: 'warn', why: 'asks to run a command as root',
    re: /(?:^|[\s`$;&|(])sudo\s+\S/ },
  { id: 'terminal-instruction', severity: 'warn', why: 'asks to run a command in a terminal',
    re: /\b(?:run|paste|execute|copy)\b[^\n]{0,40}\b(?:in(?:to)?|on)\s+(?:your|a|the)\s+(?:terminal|shell|command line|console|powershell)\b|\bopen\s+(?:the\s+)?terminal\s+and\b/i },
  { id: 'prerequisite-download', severity: 'warn', why: 'asks to download a prerequisite before using the skill',
    re: /\bprerequisites?\b[^\n]{0,120}\b(?:download|install|run)\b|\b(?:download|install)\b[^\n]{0,60}\b(?:before|first)\b[^\n]{0,40}\b(?:using|use|running)\b/i },
  { id: 'html-comment', severity: 'warn', why: 'contains an HTML comment, which hides text from rendered views',
    re: /<!--/ },
];

/** Bidi controls and zero-width characters (Trojan Source; hidden prompt text). */
const HIDDEN_UNICODE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}]/u;

const MAX_FINDINGS = 50;

function excerptOf(line: string): string {
  const t = line.trim();
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
}

/** Scan one text file. Line numbers are 1-based within the file. */
export function scanText(file: string, text: string, into: ScanFinding[] = []): ScanFinding[] {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && into.length < MAX_FINDINGS; i += 1) {
    const line = lines[i]!;
    if (HIDDEN_UNICODE.test(line)) {
      into.push({ severity: 'block', rule: 'hidden-unicode', file, line: i + 1,
        excerpt: excerptOf(line.replace(/[^\x20-\x7E]/g, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`)) });
    }
    for (const r of LURE_RULES) {
      if (into.length >= MAX_FINDINGS) break;
      if (r.re.test(line)) into.push({ severity: r.severity, rule: r.id, file, line: i + 1, excerpt: excerptOf(line) });
    }
  }
  return into;
}

/** Why a rule fires, for the refusal message and the preview. */
export function ruleReason(ruleId: string): string {
  if (ruleId === 'hidden-unicode') return 'contains invisible Unicode (bidi controls or zero-width characters)';
  return LURE_RULES.find((r) => r.id === ruleId)?.why ?? ruleId;
}
