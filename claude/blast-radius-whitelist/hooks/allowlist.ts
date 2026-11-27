// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Modified by leotsaiCode, 2026: settings-based rm allowlist; rewritten in TypeScript.
//
// rm allowlist from ~/.claude/settings.json. Pure functions, no `$`.
//
// Where the rules come from:
//   - `blastRadiusAllow` (an array) when it is set: it replaces permissions.allow.
//   - otherwise `permissions.allow`.
// Both take the permission-rule form `Bash(rm -rf /abs/path/*)`.
//
// Claude Code's own `*` in a permission rule matches spaces too, so a rule is
// never matched as a glob over the whole command. Instead each rm target is
// resolved to an absolute, lexically normalised path and matched on its own,
// where `*` matches anything but whitespace.

import type { Risk } from "./classify.js";

// ---- Types ----------------------------------------------------------------

export type RmRule = {
  /** Comparable flag key, see flagKey. */
  flags: string;
  pattern: string;
  /** The literal folder the rule lives under, which it never allows by itself. */
  prefix: string;
  regex: RegExp;
};

/** What classify needs to judge an rm segment. */
export type Allowlist = {
  rules: RmRule[];
  /** The session folder, absolute. */
  cwd: string;
};

type SettingsShape = {
  blastRadiusAllow?: unknown;
  permissions?: { allow?: unknown };
};

// A target or folder made only of these can't expand to something else in the
// shell (no ~, $, `, quotes, braces, ?, [ ], redirects, & or spaces).
const SAFE_PATH = /^[A-Za-z0-9._@%+,:=*\/-]+$/;

// ---- Reading rules --------------------------------------------------------

/** The usable rm rules in a settings.json text. Never throws. */
export function parseRmAllowRules(text: string): RmRule[] {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return [];
  }
  const rules: RmRule[] = [];
  for (const entry of pickAllowEntries(settings)) {
    const rule = typeof entry === "string" ? parseRmRule(entry) : null;
    if (rule !== null) {
      rules.push(rule);
    }
  }
  return rules;
}

/** `blastRadiusAllow` when it is an array (even empty), otherwise `permissions.allow`. */
function pickAllowEntries(settings: unknown): unknown[] {
  const s = settings as SettingsShape | null;
  if (Array.isArray(s?.blastRadiusAllow)) {
    return s.blastRadiusAllow;
  }
  const allow = s?.permissions?.allow;
  return Array.isArray(allow) ? allow : [];
}

/** One `Bash(rm ... /abs/path)` rule, or null when it is not a usable rm rule. */
function parseRmRule(entry: string): RmRule | null {
  const m = /^Bash\((.*)\)$/s.exec(entry.trim());
  if (m === null) {
    return null;
  }
  let body = (m[1] ?? "").trim();
  if (body.endsWith(":*")) {
    body = `${body.slice(0, -2)}*`; // legacy prefix form: `rm -rf /path:*` is `/path*`
  }

  const words = body.split(/\s+/);
  if (words[0] !== "rm") {
    return null;
  }
  const flags: string[] = [];
  let i = 1;
  while (i < words.length && words[i]!.startsWith("-")) {
    flags.push(words[i]!);
    i += 1;
  }
  if (words.length !== i + 1) {
    return null; // exactly one path, after the flags
  }

  const raw = words[i]!;
  if (!SAFE_PATH.test(raw) || !raw.startsWith("/") || raw.endsWith("/")) {
    return null;
  }
  const parts = raw.split("/").slice(1);
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    return null; // only an already normalised path is anchored
  }
  const pattern = aliasPrivate(raw);
  // Anchored: the first component is literal and there is a second one.
  if (!/^\/[^/*]+\/./.test(pattern)) {
    return null;
  }

  // The text before the first `*` (`/a/b/*` -> /a/b), or an exact rule's parent.
  const star = pattern.indexOf("*");
  const prefix = star === -1
    ? pattern.slice(0, pattern.lastIndexOf("/"))
    : pattern.slice(0, star).replace(/\/+$/, "");
  const source = pattern
    .split("*")
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^\\s]*");
  return { flags: flagKey(flags), pattern, prefix, regex: new RegExp(`^${source}$`) };
}

// ---- Matching -------------------------------------------------------------

/** Whether every target of an rm segment is allowed by some rule. */
export function isAllowlistedRm(risk: Risk, allow: Allowlist): boolean {
  if (risk.kind !== "rm" || !risk.isBareRm || risk.targets.length === 0) {
    return false;
  }
  let base = allow.cwd;
  if (risk.dir !== null) {
    if (!isSafePathWord(risk.dir) || risk.dir === "-") {
      return false; // `cd ~`, `cd $X`, `cd -`: can't be resolved by text
    }
    base = risk.dir.startsWith("/") ? risk.dir : `${allow.cwd}/${risk.dir}`;
  }

  const flags = flagKey(risk.flags);
  return risk.targets.every((target) => {
    if (!isSafePathWord(target)) {
      return false;
    }
    const absolute = target.startsWith("/") ? target : `${base}/${target}`;
    const path = aliasPrivate(normalizeAbsolute(absolute));
    return allow.rules.some((rule) => rule.flags === flags && path !== rule.prefix && rule.regex.test(path));
  });
}

/** rm flags as one comparable key: `-rf`, `-fr`, `-r -f` and `--recursive --force` are equal. */
function flagKey(flags: string[]): string {
  const keys = new Set<string>();
  for (const f of flags) {
    if (f === "--recursive") {
      keys.add("r");
    } else if (f === "--force") {
      keys.add("f");
    } else if (/^-[A-Za-z]+$/.test(f)) {
      for (const c of f.slice(1)) {
        keys.add(c === "R" ? "r" : c);
      }
    } else {
      keys.add(f); // any other flag (`--`, `--dir`) must be spelled the same
    }
  }
  return [...keys].sort().join(" ");
}

/** macOS: /tmp and /var are links into /private, so both spellings compare equal. */
function aliasPrivate(path: string): string {
  return /^\/(tmp|var)(\/|$)/.test(path) ? `/private${path}` : path;
}

/** An absolute path with `.`, `..` and repeated slashes resolved by text alone. */
function normalizeAbsolute(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      out.pop();
    } else {
      out.push(part);
    }
  }
  return `/${out.join("/")}`;
}

/** Whether a word can be resolved by text: no shell expansion beyond `*`, which can't make `..`. */
function isSafePathWord(word: string): boolean {
  return word !== ""
    && SAFE_PATH.test(word)
    && !word.endsWith("/")
    // `.*` can expand to `..` in some shells
    && !word.split("/").some((p) => p.startsWith(".") && p.includes("*"));
}
