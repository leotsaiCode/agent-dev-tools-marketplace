// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Modified by leotsaiCode, 2026: settings-based rm allowlist; rewritten in TypeScript.
//
// What counts as risky: reads a Bash command line by text and returns the
// first risky segment. Pure functions, no `$`.

import { isAllowlistedRm, type Allowlist } from "./allowlist.js";

// ---- Types ----------------------------------------------------------------

export type MigrationTool = "alembic" | "rails" | "prisma" | "django" | "unknown";

/** `dir` is where a `cd` earlier on the line moved to; null means the session folder. */
export type RmRisk = {
  kind: "rm";
  label: string;
  dir: string | null;
  targets: string[];
  flags: string[];
  /** A plain `rm ...` (no sudo, env, VAR=, /bin/rm): the only form the allowlist can pass. */
  isBareRm: boolean;
};

export type GitRisk = {
  kind: "git-reset" | "git-clean" | "git-push-force" | "git-checkout";
  label: string;
  dir: string | null;
  args: string[];
};

export type MigrateRisk = {
  kind: "migrate";
  label: string;
  dir: string | null;
  tool: MigrationTool;
};

export type Risk = RmRisk | GitRisk | MigrateRisk;

/** A folder change from `cd`, `pushd` or `popd`. null = the session folder, `"-"` = can't tell. */
type FolderChange = { cd: string | null };

type SegmentResult = Risk | FolderChange | null;

// ---- Word lists -----------------------------------------------------------

// sudo options that take a value, so the value isn't read as the command.
const SUDO_VALUE_OPTIONS = new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U"]);

// Commands that only read, so a bare word "migrate" in them isn't a migration.
const READ_ONLY = new Set(["ls", "cat", "echo", "printf", "grep", "rg", "find", "less", "head", "tail", "cd", "git"]);

// Words that can come before the real command without changing what it does.
const PREFIXES = new Set(["command", "exec", "env", "nohup", "time", "then", "do", "else", "!"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// ---- Command line ---------------------------------------------------------

/**
 * The first risky segment of a shell command, or null. With `allow`, an rm
 * segment whose every target the rules allow is passed over and the next
 * segments are still checked.
 */
export function classify(command: string, allow: Allowlist | null = null): Risk | null {
  let dir: string | null = null;
  const scopes: Array<string | null> = []; // dir to restore when a ( subshell ) closes
  const pushed: Array<string | null> = []; // pushd stack, for popd

  for (const raw of command.split(/&&|\|\||;|\||\n/)) {
    const opens = countSubshellOpens(raw);
    const closes = countSubshellCloses(raw);
    for (let k = 0; k < opens; k += 1) {
      scopes.push(dir);
    }

    const result = classifySegment(raw, dir, pushed);
    if (result !== null && "cd" in result) {
      dir = result.cd;
    } else if (result !== null) {
      const isAllowed = allow !== null && isAllowlistedRm(result, allow);
      if (!isAllowed) {
        return result;
      }
      // fully allowlisted rm: fall through, so the folder scopes still close
    }

    for (let k = 0; k < closes && scopes.length > 0; k += 1) {
      dir = scopes.pop() ?? null; // a cd inside ( ... ) doesn't outlive it
    }
  }
  return null;
}

function countSubshellOpens(segment: string): number {
  return segment.match(/^\s*\(+/)?.[0].trim().length ?? 0;
}

function countSubshellCloses(segment: string): number {
  // Trailing redirects and & don't hide a closing ) : `(cd sub && make) > log`.
  const tail = segment.replace(/(?:\s*(?:\d*>>?|&>>?|<)\s*\S+|\s*&)+\s*$/, "");
  return tail.match(/\)+\s*$/)?.[0].trim().length ?? 0;
}

// ---- One segment ----------------------------------------------------------

/** One segment: a risk, a folder change, or null. */
function classifySegment(segment: string, dir: string | null, pushed: Array<string | null>): SegmentResult {
  const words = tokenize(segment.trim().replace(/^[({]+\s*/, "").replace(/\s*[)}]+$/, ""));
  const isBareRm = words[0] === "rm" || words[0] === "\\rm";
  stripCommandPrefixes(words);

  const [first, ...args] = words;
  if (first === undefined) {
    return null;
  }
  const cmd = first.replace(/^\\/, ""); // \rm skips aliases; it's still rm

  if (cmd === "cd") {
    return { cd: args[0] === "-" ? "-" : joinDir(dir, args[0]) };
  }
  if (cmd === "pushd") {
    pushed.push(dir);
    return { cd: joinDir(dir, args[0]) };
  }
  if (cmd === "popd") {
    return { cd: pushed.length > 0 ? (pushed.pop() as string | null) : "-" };
  }
  if (cmd === "rm" || cmd.endsWith("/rm")) {
    const risk = classifyRm(args, dir, isBareRm);
    if (risk !== null) {
      return risk;
    }
  }
  if (cmd === "git") {
    const risk = classifyGit(args, dir);
    if (risk !== null) {
      return risk;
    }
  }
  return classifyMigration(cmd, args, words.join(" "), dir);
}

/** Drops leading VAR=value, sudo and its options, prefixes like `env`, and `nice`. Mutates `words`. */
function stripCommandPrefixes(words: string[]): void {
  while (words.length > 0 && ASSIGNMENT.test(words[0]!)) {
    words.shift();
  }
  if (words[0] === "sudo") {
    words.shift();
    while (words.length > 0 && words[0]!.startsWith("-")) {
      const option = words.shift()!;
      if (SUDO_VALUE_OPTIONS.has(option)) {
        words.shift();
      }
    }
  }
  while (words.length > 0 && (PREFIXES.has(words[0]!) || ASSIGNMENT.test(words[0]!))) {
    words.shift();
  }
  if (words[0] === "nice") {
    words.shift();
    const option = words[0] as string | undefined; // re-read: TS still narrows words[0] to "nice"
    if (option === "-n") {
      words.splice(0, 2);
    } else if (/^-\d+$/.test(option ?? "")) {
      words.shift();
    }
  }
}

function classifyRm(args: string[], dir: string | null, isBareRm: boolean): RmRisk | null {
  const flags = args.filter((a) => a.startsWith("-"));
  const isShortFlag = (f: string) => /^-[^-]/.test(f);
  const recursive = flags.some((f) => f === "--recursive" || (isShortFlag(f) && /[rR]/.test(f)));
  const force = flags.some((f) => f === "--force" || (isShortFlag(f) && f.includes("f")));
  if (!recursive && !force) {
    return null;
  }
  const targets = args.filter((a) => !a.startsWith("-") || a === "-");
  return { kind: "rm", label: `rm ${flags.join(" ")}`.trim(), targets, dir, flags, isBareRm };
}

function classifyGit(args: string[], dir: string | null): GitRisk | null {
  // Git's own options come before the subcommand; -C moves where it runs.
  let gitDir = dir;
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    if (args[i] === "-C" && i + 1 < args.length) {
      gitDir = joinDir(gitDir, args[i + 1]);
      i += 2;
    } else if (args[i] === "-c" && i + 1 < args.length) {
      i += 2;
    } else {
      i += 1;
    }
  }
  const sub = args[i];
  const rest = args.slice(i + 1);

  if (sub === "reset" && rest.includes("--hard")) {
    return { kind: "git-reset", label: "git reset --hard", args: rest, dir: gitDir };
  }
  if (sub === "clean") {
    return { kind: "git-clean", label: "git clean", args: rest, dir: gitDir };
  }
  const isForcePush = rest.some((a) => a === "--force" || a === "-f" || a.startsWith("--force-with-lease") || a.startsWith("+"));
  if (sub === "push" && isForcePush) {
    return { kind: "git-push-force", label: "git push --force", args: rest, dir: gitDir };
  }
  const isStagedOnly = sub === "restore" && rest.includes("--staged") && !rest.includes("--worktree") && !rest.includes("-W");
  if ((sub === "checkout" || sub === "restore") && rest.includes(".") && !isStagedOnly) {
    return { kind: "git-checkout", label: `git ${sub} -- .`, args: rest, dir: gitDir };
  }
  return null;
}

function classifyMigration(cmd: string, args: string[], joined: string, dir: string | null): MigrateRisk | null {
  const migrate = (tool: MigrationTool, label: string): MigrateRisk => ({ kind: "migrate", tool, label, dir });
  if (/\balembic\s+upgrade\b/.test(joined)) {
    return migrate("alembic", "alembic upgrade");
  }
  if (/\bdb:migrate(?!:status\b)/.test(joined)) {
    return migrate("rails", "db:migrate");
  }
  if (/\bprisma\s+migrate\b/.test(joined)) {
    return migrate("prisma", "prisma migrate");
  }
  if (/\bmanage\.py\s+migrate\b/.test(joined)) {
    return migrate("django", "manage.py migrate");
  }
  if (!READ_ONLY.has(cmd) && args.includes("migrate")) {
    return migrate("unknown", "migrate");
  }
  return null;
}

// ---- Helpers --------------------------------------------------------------

/** The folder a `cd arg` moves to, given the folder so far (null = the session folder). */
function joinDir(dir: string | null, arg: string | undefined): string {
  if (arg === undefined || arg === "~" || arg.startsWith("/") || arg.startsWith("~/")) {
    return arg ?? "~";
  }
  return dir ? `${dir}/${arg}` : arg;
}

/** Splits one segment into words, honouring quotes. Good enough to read flags and paths. */
function tokenize(text: string): string[] {
  const words: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    words.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return words;
}
