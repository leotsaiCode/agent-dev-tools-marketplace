// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Modified by leotsaiCode, 2026: settings-based rm allowlist; rewritten in
// TypeScript. Forked from claude-code/mods/blast-radius 0.1.0 of
// anthropics/claude-code-playground.
//
// Blast Radius: holds a risky Bash command and shows what it would change.
//
// Files:
//   register.ts   hooks, the hold loop, and everything that calls `$`
//   classify.ts   what counts as risky (by command text)
//   allowlist.ts  rm allowlist rules from ~/.claude/settings.json
//   draw.ts       the pane
//
// Allowlist (this fork): an `rm` segment is not held when every one of its
// targets is allowed by an `rm` rule in ~/.claude/settings.json. The rules come
// from `blastRadiusAllow` when it is set (it replaces permissions.allow), else
// from `permissions.allow`. The file is read on every call that would be held,
// so edits apply at once. Only `rm` is ever allowlisted.
//
// tool.call (Bash): if the command is risky, work out its blast radius, open a
// pane with Proceed and Cancel, and hold the call until one is pressed.
// ui.render (Pane): draws the report. If the surface won't place the pane (a
// narrow terminal), the same report is drawn in the AbovePrompt band instead.
//
// Holding: a hook has 10 s of its own time, but time spent inside a `$` call is
// free. So the hold loop waits on a short `$.process.run(["sleep", ...])` until
// a button's onPress sets the decision.
//
// The host reads `on(...)` and `$.noun.method(...)` from source, so they are
// spelled literally, and helpers that take `$` are top-level functions in this
// file (the host refuses `$` passed into another file).

import type { EngineInterface, Register } from "claude-code";
import { parseRmAllowRules, type Allowlist } from "./allowlist.js";
import { classify, type GitRisk, type MigrateRisk, type MigrationTool, type Risk, type RmRisk } from "./classify.js";
import { draw, paneRows, size, type Decision, type Held, type Report } from "./draw.js";

type Engine = EngineInterface;

const PANE_ID = "blast-radius-whitelist";
const POLL_SECONDS = "0.25";
const HOLD_LIMIT_MS = 10 * 60 * 1000;
const LIST_MAX = 10;

const DENY_REASONS: Record<Decision, string> = {
  proceed: "",
  cancel: "the user pressed Cancel",
  timeout: "no answer within 10 minutes",
  interrupted: "the turn was interrupted",
  error: "Blast Radius hit an error while holding it",
};

// The call being held, or null. One at a time: Bash calls in a turn run in order.
let held: Held | null = null;

export const register: Register = (on) => {
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const command = String(e.command ?? "");
    const risk = await findRisk($, command);
    if (risk === null) {
      return next(e);
    }

    // One hold at a time. If another risky call is already held (a subagent's,
    // say), wait until it is answered. `held` is claimed with no await between
    // the check and the claim, so two waiting calls can't both get through.
    while (held !== null) {
      if (next.signal.aborted) {
        return { deny: "Blast Radius held this command and did not run it: the turn was interrupted. Do not retry it unless the user asks you to." };
      }
      await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
    }
    const mine: Held = { command, risk, report: null, decision: null, where: "pane" };
    held = mine;

    let opened = { isPlaced: false };
    let summary = risk.label;
    try {
      mine.report = await measureWhereItRuns($, risk);
      summary = mine.report.summary;

      opened = await $.ui.open({ id: PANE_ID, title: "Blast Radius", focus: true, rows: paneRows(mine.report) });
      if (!opened.isPlaced) {
        mine.where = "band";
      }
      $.ui.invalidate("ui.render");

      const startedAt = await $.clock.now();
      while (mine.decision === null) {
        if (next.signal.aborted) {
          mine.decision = "interrupted";
          break;
        }
        if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) {
          mine.decision = "timeout";
          break;
        }
        await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
      }
    } catch {
      mine.decision = "error"; // anything unexpected refuses the command
    } finally {
      // Close this call's pane before releasing the hold, so the next call's
      // pane can't be the one that gets closed.
      try {
        if (opened.isPlaced) {
          await $.ui.close({ id: PANE_ID });
        }
      } catch {
        // the pane is already gone
      }
      if (held === mine) {
        held = null;
      }
      $.ui.invalidate("ui.render");
    }

    if (mine.decision === "proceed") {
      $.ui.toast("Blast Radius: running it");
      return next(e);
    }
    const why = mine.decision === null ? "no answer was recorded" : DENY_REASONS[mine.decision];
    return {
      deny: `Blast Radius held this command and did not run it: ${why}. It would have: ${summary}. Do not retry it unless the user asks you to.`,
    };
  });

  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== PANE_ID || held === null || held.report === null) {
      return next(e);
    }
    return draw($.ui.resolve(e), held, held.report);
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (held === null || held.report === null || held.where !== "band") {
      return next(e);
    }
    return draw($.ui.resolve(e), held, held.report);
  });
};

// ---- Deciding whether to hold ---------------------------------------------

/** The risk to hold for, or null to let the command run. */
async function findRisk($: Engine, command: string): Promise<Risk | null> {
  const risk = classify(command);
  if (risk === null) {
    return null;
  }
  // Only a call that would be held reads the allowlist, fresh each time.
  const allow = await loadRmAllowlist($);
  if (allow === null) {
    return risk;
  }
  try {
    return classify(command, allow);
  } catch {
    return risk; // a bug in the allowlist check keeps the hold on the first risky segment
  }
}

/**
 * { rules, cwd } for classify, or null when there is no usable rule. Never
 * throws: a missing or malformed settings file means no allowlist.
 */
async function loadRmAllowlist($: Engine): Promise<Allowlist | null> {
  try {
    const home = await $.env.get("HOME");
    if (typeof home !== "string" || !home.startsWith("/")) {
      return null;
    }
    const text = await $.fs.read(`${home}/.claude/settings.json`);
    const rules = parseRmAllowRules(String(text));
    if (rules.length === 0) {
      return null;
    }
    const cwd = await $.session.cwd();
    if (typeof cwd !== "string" || !cwd.startsWith("/")) {
      return null;
    }
    return { rules, cwd };
  } catch {
    return null;
  }
}

// ---- Where the command runs -----------------------------------------------

/**
 * Measures in the folder the command will run in: the session folder, moved by
 * any `cd dir &&` or `git -C dir` earlier on the same line.
 */
async function measureWhereItRuns($: Engine, risk: Risk): Promise<Report> {
  const sessionCwd = await $.session.cwd();
  const cwd = risk.dir ? await resolveDir($, sessionCwd, risk.dir) : sessionCwd;
  if (cwd === null) {
    return {
      summary: `${risk.label} in ${risk.dir}`,
      lines: [],
      note: `Couldn't find the folder ${risk.dir}, so I couldn't measure what this would change.`,
    };
  }
  return await measure($, risk, cwd);
}

// Resolves a `cd` target to an absolute folder, or null if it doesn't exist.
// The target is passed as an argument, never as source.
const CD_SCRIPT = `unset CDPATH; d="$1"; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/\${d#\\~/}";; esac; cd -- "$d" 2>/dev/null && pwd -P`;

async function resolveDir($: Engine, sessionCwd: string, dir: string): Promise<string | null> {
  if (dir === "-") {
    return null; // `cd -` depends on the shell's history
  }
  const run = await $.process.run(["bash", "-c", CD_SCRIPT, "blast-radius", dir], { cwd: sessionCwd, timeoutMs: 5000 });
  const out = run.stdout.trim();
  return run.exitCode === 0 && out !== "" ? out : null;
}

// ---- Measuring the blast radius -------------------------------------------

/** The report for the pane. Never throws: a failed read is said, not hidden. */
async function measure($: Engine, risk: Risk, cwd: string): Promise<Report> {
  try {
    if (risk.kind === "rm") {
      return await measureRm($, risk, cwd);
    }
    if (risk.kind === "migrate") {
      return await measureMigrations($, risk, cwd);
    }
    if (risk.kind === "git-push-force") {
      return await measurePush($, risk, cwd);
    }
    if (risk.kind === "git-clean") {
      return await measureGitClean($, risk, cwd);
    }
    return await measureDiscardedChanges($, risk, cwd);
  } catch (error) {
    const message = String((error as Error | undefined)?.message ?? error).slice(0, 200);
    return { summary: `${risk.label} (could not measure it)`, lines: [], note: `Could not measure: ${message}` };
  }
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The first LIST_MAX items for the pane, and how many were cut. */
const listed = (items: string[]) => ({ lines: items.slice(0, LIST_MAX), more: Math.max(0, items.length - LIST_MAX) });

// The paths are passed to bash as arguments, never as source, so nothing in
// them runs. compgen -G expands a glob without command substitution.
// Prints "<files> <bytes> <paths found>", then up to LIST_MAX file names.
const RM_SCRIPT = `
shopt -s nullglob dotglob
paths=()
for p in "$@"; do
  case "$p" in "~"|"~/"*) p="$HOME\${p#\\~}";; esac
  if [[ "$p" == *[*?[]* ]]; then
    while IFS= read -r m; do paths+=("$m"); done < <(compgen -G "$p")
  elif [[ -e "$p" || -L "$p" ]]; then
    paths+=("$p")
  fi
done
if (( \${#paths[@]} == 0 )); then echo "0 0 0"; exit 0; fi
# A relative path gets ./ in front, so find never reads a name like -delete as an action.
for i in "\${!paths[@]}"; do case "\${paths[$i]}" in /*) ;; *) paths[$i]="./\${paths[$i]}";; esac; done
files=$(find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | wc -l | tr -d ' ')
kb=$(du -skc "\${paths[@]}" 2>/dev/null | tail -n1 | cut -f1)
echo "$files $(( \${kb:-0} * 1024 )) \${#paths[@]}"
find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | head -n ${LIST_MAX}
`;

async function measureRm($: Engine, risk: RmRisk, cwd: string): Promise<Report> {
  if (risk.targets.length === 0) {
    return { summary: "rm with no paths", lines: [], note: "No paths to expand." };
  }
  const run = await $.process.run(["bash", "-c", RM_SCRIPT, "blast-radius", ...risk.targets], { cwd, timeoutMs: 15000 });
  const [head, ...names] = run.stdout.split("\n").filter((l) => l !== "");
  const [files = 0, bytes = 0, found = 0] = (head ?? "0 0 0").split(" ").map(Number);
  const paths = risk.targets.join(" ");

  if (!found) {
    return { summary: `delete nothing: no file matches ${paths}`, lines: [], note: "The paths don't exist, so rm has nothing to remove." };
  }
  if (!files) {
    return {
      summary: `delete ${found} ${plural(found, "path", "paths")} with no files in ${plural(found, "it", "them")}`,
      lines: [],
      note: `Paths: ${paths}`,
    };
  }
  return {
    summary: `delete ${files} ${plural(files, "file", "files")} (about ${size(bytes)})`,
    lines: names.map((l) => l.replace(/^\.\//, "")),
    more: Math.max(0, files - names.length),
    note: `Paths: ${paths}`,
  };
}

async function measureGitClean($: Engine, risk: GitRisk, cwd: string): Promise<Report> {
  const { flags, paths } = gitCleanDryRunArgs(risk.args);
  const run = await $.process.run(["git", "clean", "-n", ...flags, "--", ...paths], { cwd, timeoutMs: 15000 });
  if (run.exitCode !== 0) {
    return { summary: "git clean (could not dry-run it)", lines: [], note: run.stderr.trim().slice(0, 200) };
  }
  const gone = run.stdout
    .split("\n")
    .filter((l) => l.startsWith("Would remove "))
    .map((l) => l.slice("Would remove ".length));
  return {
    summary: gone.length === 0
      ? "remove nothing: no untracked files match"
      : `remove ${gone.length} untracked ${plural(gone.length, "path", "paths")}`,
    ...listed(gone),
    note: "From git clean -n. Untracked files are not in git, so they can't be recovered.",
  };
}

/** The user's `git clean` args, made safe for a `git clean -n` dry run. */
function gitCleanDryRunArgs(args: string[]): { flags: string[]; paths: string[] } {
  const flags: string[] = [];
  const paths: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--") {
      paths.push(...args.slice(i + 1));
      break;
    }
    if (a === "-e" || a === "--exclude") {
      flags.push(a, args[i + 1] ?? "");
      i += 1;
    } else if (a.startsWith("--exclude=") || /^-e./.test(a)) {
      flags.push(a);
    } else if (/^-[a-zA-Z]+$/.test(a)) {
      const kept = a.replace(/[finq]/g, ""); // -n is added by the caller; -f, -i and -q would change the dry run
      if (kept !== "-") {
        flags.push(kept);
      }
    } else if (!a.startsWith("-")) {
      paths.push(a);
    }
  }
  return { flags, paths };
}

/** git reset --hard drops staged and unstaged changes; checkout/restore -- . drops unstaged ones. */
async function measureDiscardedChanges($: Engine, risk: GitRisk, cwd: string): Promise<Report> {
  const status = await $.process.run(["git", "status", "--porcelain"], { cwd, timeoutMs: 15000 });
  if (status.exitCode !== 0) {
    return { summary: `${risk.label} (not a git repo here?)`, lines: [], note: status.stderr.trim().slice(0, 200) };
  }
  const isReset = risk.kind === "git-reset";
  const rows = status.stdout.split("\n").filter((l) => l.length > 3 && !l.startsWith("??"));
  const lost = isReset ? rows : rows.filter((l) => l[1] !== " ");
  const stat = await $.process.run(["git", "diff", "--shortstat", isReset ? "HEAD" : "--"], { cwd, timeoutMs: 15000 });
  const shortstat = stat.stdout.trim();
  return {
    summary: lost.length === 0
      ? "discard nothing: no uncommitted changes"
      : `discard uncommitted changes in ${lost.length} ${plural(lost.length, "file", "files")}`,
    ...listed(lost.map((l) => `${l.slice(0, 2)} ${l.slice(3)}`)),
    note: shortstat !== "" ? `${shortstat}. Uncommitted changes can't be recovered.` : "From git status --porcelain.",
  };
}

async function measurePush($: Engine, risk: GitRisk, cwd: string): Promise<Report> {
  const positional = risk.args.filter((a) => !a.startsWith("-"));
  const remote = positional[0] ?? "origin";
  // A refspec is src:dst. With no colon, the local branch of the same name is pushed.
  const spec = (positional[1] ?? "").replace(/^\+/, "");
  let [source = "", branch = ""] = spec.includes(":") ? spec.split(":") : [spec, spec];
  branch = branch.replace(/^refs\/heads\//, "");
  // No branch, or `git push origin HEAD`: the current branch to its namesake.
  if (!branch || branch === "HEAD") {
    const head = await $.process.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 10000 });
    branch = head.stdout.trim();
    source = "HEAD";
  }
  source = source || "HEAD";

  const ref = `${remote}/${branch}`;
  const known = await $.process.run(["git", "rev-parse", "--verify", "--quiet", ref], { cwd, timeoutMs: 10000 });
  if (known.exitCode !== 0) {
    return { summary: `force-push to ${ref}`, lines: [], note: `No local copy of ${ref}, so I can't tell which commits the push would drop. Run git fetch first.` };
  }
  const log = await $.process.run(["git", "log", "--oneline", "--no-decorate", `${source}..${ref}`], { cwd, timeoutMs: 15000 });
  const dropped = log.stdout.split("\n").filter((l) => l !== "");
  return {
    summary: dropped.length === 0
      ? `force-push to ${ref}: drops no commits`
      : `force-push to ${ref}: drops ${dropped.length} ${plural(dropped.length, "commit", "commits")}`,
    ...listed(dropped),
    note: `Commits on ${ref} that ${source} doesn't have, as of the last fetch.`,
  };
}

type MigrationLister = {
  argv: string[];
  isPending: (line: string) => boolean;
  strip: (line: string) => string;
};

const MIGRATION_LISTERS: Partial<Record<MigrationTool, MigrationLister>> = {
  django: { argv: ["python3", "manage.py", "showmigrations", "--plan"], isPending: (l) => l.startsWith("[ ]"), strip: (l) => l.slice(4) },
  alembic: { argv: ["alembic", "history", "-r", "current:head"], isPending: (l) => l.includes("->"), strip: (l) => l },
  rails: { argv: ["bin/rails", "db:migrate:status"], isPending: (l) => /^\s*down\b/.test(l), strip: (l) => l.trim() },
  prisma: { argv: ["npx", "--no-install", "prisma", "migrate", "status"], isPending: (l) => /^\s{2}\S/.test(l), strip: (l) => l.trim() },
};

async function measureMigrations($: Engine, risk: MigrateRisk, cwd: string): Promise<Report> {
  const lister = MIGRATION_LISTERS[risk.tool];
  if (lister === undefined) {
    return { summary: "run migrations", lines: [], note: "I can't list the pending migrations for this tool, so the list is not shown." };
  }
  const listCommand = lister.argv.join(" ");
  let run: { exitCode: number; stdout: string };
  try {
    run = await $.process.run(lister.argv, { cwd, timeoutMs: 20000 });
  } catch {
    run = { exitCode: -1, stdout: "" };
  }
  if (run.exitCode !== 0) {
    return { summary: `run ${risk.label}`, lines: [], note: `Couldn't list pending migrations (${listCommand} failed).` };
  }
  const pending = run.stdout.split("\n").filter(lister.isPending).map(lister.strip);
  return {
    summary: pending.length === 0
      ? `run ${risk.label}: nothing pending`
      : `apply ${pending.length} pending ${plural(pending.length, "migration", "migrations")}`,
    ...listed(pending),
    note: `From ${listCommand}.`,
  };
}
