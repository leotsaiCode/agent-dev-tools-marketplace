# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Claude Code plugin marketplace. `.claude-plugin/marketplace.json` must stay at the repo root (Claude Code only reads it there); each entry's `source` points into `claude/<plugin>/`. Currently one plugin: `claude/blast-radius-whitelist/`, a TypeScript mod forked from Anthropic's `blast-radius` (Apache-2.0).

## Commands

Requires Bun and Claude Code on `PATH`. There is no build step: Claude Code loads `.ts` mods directly.

```bash
bun install                                               # once: @types/bun for the scripts/ tsc check
bun scripts/validate.ts                                   # full check; same script CI runs
claude plugin validate ./claude/blast-radius-whitelist    # manifest/mod validation only
claude plugin test ./claude/blast-radius-whitelist        # run all tests/*.test.ts
bunx -p typescript@5.6.3 tsc -p ./claude/blast-radius-whitelist   # strict type check
claude --plugin-dir ./claude/blast-radius-whitelist       # try it in a live session
```

- `claude plugin test` has no filter flag: it runs every `*.test.ts(x)` under the given folder, each file in its own child process.
- `tsc` depends on `.claude-plugin/types/` (git-ignored), which Claude Code writes only when a session loads the mod (e.g. `claude --plugin-dir ./claude/blast-radius-whitelist`), not on `plugin validate`. `scripts/validate.ts` skips the plugin `tsc` check when they are missing, so CI does not type-check the mod.
- CI (`.github/workflows/validate.yml`) pins Claude Code **2.1.332** and Bun 1.4.5. If a test passes locally but fails in CI, match that Claude Code version.

## Invariants enforced by `scripts/validate.ts`

- Folder name, `plugin.json` `name`, and `marketplace.json` `name` are identical.
- `version` in `plugin.json` and `marketplace.json` match — **bump both on every change**, or `claude plugin update` may not pick it up.
- Every folder under `claude/` is listed in `marketplace.json`; each plugin has a `README.md` and at least one capability (`skills`, `commands`, `agents`, `hooks`, `.mcp.json`); every module named in `hooks/hooks.json` exists.

## blast-radius-whitelist architecture

`hooks/hooks.json` → `modules: ["./register.ts"]`. Flow for each Bash `tool.call`:

1. `register.ts` — entry module; owns every hook and **every `$` call** (Claude Code refuses `$` passed into another file, so other modules must stay pure). Reads `~/.claude/settings.json` on each potentially-held call, measures the blast radius via `$.process.run` (paths passed as argv, never via shell), and holds the call by looping on `$.process.run(["sleep","0.25"])` until a button sets a decision (hooks have a 10 s budget of their own code; time inside `$` calls doesn't count). Holds are queued one at a time; timeout 10 min, interrupt/error → deny.
2. `classify.ts` — pure: splits the command into segments (`&&`, `||`, `;`, `|`, newline), tracks `cd`/`pushd`/`popd`/`git -C`, and returns the first `Risk` (`rm` / `git` / `migrate`) or `null`.
3. `allowlist.ts` — pure: parses `Bash(rm <flags> /abs/path/pattern)` rules from `blastRadiusAllow` (replaces `permissions.allow` when it is an array) and decides whether every target of an `rm` segment is allowed. Matching is textual and deliberately conservative (see plugin README "rm allowlist").
4. `draw.ts` — pure: renders the report into a `Pane`, or the `AbovePrompt` band when the pane isn't placed (narrow terminal).

Tests (`tests/allowlist.test.ts`) use `claude-code/testing`: they stub `fs.read`, `session.cwd`, `process.run` and env via `on(...)` hooks beneath the plugin, then count whether the Bash call ran or was held.

## Conventions

- Plugin details go in the plugin's own README; the root README gets only one row in the Plugins table.
- Update the plugin README in the same change when behavior or settings change.
- Don't write runtime state into a plugin folder (installed copies under `~/.claude/plugins/cache/` are replaced on update).
- Commit `tsconfig.json`, not `.claude-plugin/types/`.
- Commit messages: Conventional Commits in English, `<type>(<scope>): <description>`, scope = plugin name.
