# Blast Radius (whitelist)

> **This is a fork.** `blast-radius-whitelist` is a modified copy of the `blast-radius` mod, version 0.1.0, from [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground), path `claude-code/mods/blast-radius`, licensed Apache-2.0.
>
> Modified by leotsaiCode, 2026: settings-based rm allowlist. An `rm` command is not held when every one of its targets is allowed by an `rm` rule in `~/.claude/settings.json` → `blastRadiusAllow`, or `permissions.allow` when that is not set. Rewritten in TypeScript. Everything else behaves as in the original. See [rm allowlist](#rm-allowlist-this-fork). The original's screenshots are not included.

A Claude Code mod that holds a risky shell command and shows you what it would change before it runs. We're sharing it as a small, complete example of a mod that pauses a tool call and asks you to decide.

## What this shows

When Claude calls Bash with one of the commands below, Blast Radius stops the call, works out what the command would touch, and opens a pane with two buttons: **Proceed** runs the command, **Cancel** refuses it. Claude sees the refusal and the reason.

| Command | What the pane shows |
|---|---|
| `rm -r`, `rm -f`, `rm -rf` | The files it would delete, with the count and total size. Globs and `~` are expanded. |
| `git reset --hard` | The files with uncommitted changes, from `git status --porcelain`, and `git diff --shortstat`. |
| `git checkout -- .`, `git restore .` | The files with unstaged changes. |
| `git clean` | The untracked paths it would remove, from `git clean -n` with the same flags. |
| `git push --force` (also `-f`, `--force-with-lease`, `+ref`) | The commits on the remote branch that your HEAD doesn't have, which the push would drop. |
| `manage.py migrate`, `db:migrate`, `alembic upgrade`, `prisma migrate` | The pending migrations, from the tool's own status command. |
| any other `migrate` | A note that it can't list the pending migrations for that tool. |

Every other command runs as normal. If the command line moves first, with `cd dir &&`, `pushd`/`popd` or `git -C dir`, Blast Radius measures in that folder. A `cd` inside `( ... )` only applies inside the parentheses, as in the shell.

The patterns it demonstrates:

- Holding a `tool.call` until the user answers, and returning `{ deny }` with a reason Claude can act on.
- Drawing the same report in a `Pane`, or in the `AbovePrompt` band when the terminal is too narrow for a pane.
- Measuring with `$.process.run`, passing paths as arguments so nothing in them runs as shell.

## rm allowlist (this fork)

Before holding a call, the mod reads `~/.claude/settings.json` (on every call that would be held, so an edit applies at once) and keeps the `permissions.allow` entries of the form `Bash(rm <flags> /absolute/path/pattern)`, or the legacy `Bash(rm <flags> /absolute/path:*)`. For example:

```json
"allow": [
  "Bash(rm -rf /private/tmp/claude-502/*/scratchpad/*)",
  "Bash(rm -f /private/tmp/claude-502/*/scratchpad/*)"
]
```

### A separate list: `blastRadiusAllow`

To keep the mod's allowlist apart from Claude Code's own permissions, set a top-level `blastRadiusAllow` array in the same `~/.claude/settings.json`. Its entries take the same form as above.

```json
{
  "permissions": { "allow": ["Bash(rm -rf /Users/me/project/build/*)"] },
  "blastRadiusAllow": [
    "Bash(rm -rf /private/tmp/claude-502/*/scratchpad/*)"
  ]
}
```

- When `blastRadiusAllow` is an array, it **replaces** `permissions.allow`: only its rules are used. In the example, `rm -rf /Users/me/project/build/x` is held.
- `"blastRadiusAllow": []` turns the allowlist off: every `rm -rf` is held.
- When the key is missing, or is not an array, `permissions.allow` is used as before.

Claude Code's own `*` in a rule also matches spaces, so the rules are never matched as a glob over the whole command line. Instead:

- The command is split into segments as before (`&&`, `||`, `;`, `|`, a line break). An `rm` segment is skipped only when **every** target matches some rule on its own; the segments after it are still checked, so `rm -rf <allowed> && rm -rf ~/x` is held.
- A target matches a rule when the flags are the same (`-rf`, `-fr`, `-r -f` and `--recursive --force` are equal; `-rfv` is not `-rf`), and the target, resolved against the segment's `cd` folder or the session's folder with `.` and `..` resolved by text, matches the rule's path, where `*` matches any characters except whitespace. `/tmp/…` and `/var/…` are treated as `/private/tmp/…` and `/private/var/…`.
- A target is never allowed when it holds `~`, `$`, a backtick, a quote, a space, a brace, `?`, `[ ]`, a redirect or `&`, ends with `/`, or has a `.*` part; nor when it is the rule's own literal folder (for `/a/b/*/c/*`, the folder `/a/b`).
- Rules with no anchored absolute path are ignored: `Bash(rm *)`, `Bash(rm:*)`, `Bash(rm -rf *)`, `Bash(rm -rf /*)`, a wildcard in the first path component, `~`, or `..`.
- Only a plain `rm` is allowed; `sudo rm`, `env … rm`, `VAR=x rm` and `/bin/rm` are held as before.
- A missing or malformed settings file means no allowlist: the hold works as in the original.
- `git reset --hard`, `git clean`, force pushes and migrations are never allowlisted.

The check is by text: a path that goes through a symbolic link inside an allowed folder (`<allowed>/link/x`) is judged by its spelling, not by where the link leads.

Tests: `claude plugin test ./blast-radius-whitelist` runs `tests/allowlist.test.ts`, which covers allowed and held commands against a stand-in settings file.

## How it was built

- **Model:** built with Claude in Claude Code. The original's test runs and screenshots (not included in this fork) used Claude Sonnet 5. The mod itself doesn't call a model.
- **Prompt(s):** the mod started as one of ten ideas Claude wrote for mods. This is the idea as written:

  > **Blast Radius.** _See what a command will touch, before it runs._ When Claude runs a risky shell command, like `rm`, `git reset`, or a migration, the mod opens a pane. The pane lists the files and branches the command would change. The developer presses Proceed, or Cancel. It uses `tool.call` to hold the call, and `ui.render` on `Pane`, with `Button` elements. It adds a safety check, and it doesn't remove any, so it's safe to show. _A bigger project,_ because each command needs its own dry run.

  The build prompt, which picked this idea and two others by number:

  > implement 1,2,7. give me zips for them. test them in claude code and get me screenshots of what they look like when used.

- **Transcript:** not shared. The build ran in an internal workspace.
- **Iterations:**
  - A hook has a 10-second budget for its own code, which is far too short to wait for a person. Time spent inside a `$` call doesn't count, so the hold is a loop that waits on `$.process.run(["sleep", "0.25"])` until a button's `onPress` sets the decision.
  - A pane needs room. In a narrow terminal Claude Code doesn't place it, so the mod checks `isPlaced` and draws the report in the `AbovePrompt` band instead.
  - Cancel has the focus when the pane opens, so pressing Enter refuses the command rather than running it.
  - An independent review before release found two problems in the measuring step, both fixed. A file named like a `find` action (for example `-delete`) that a glob matched could be read as an action while measuring, so relative paths now go to `find` with `./` in front. And a `cd` earlier on the command line was ignored, so the wrong folder was measured; the mod now follows `cd` and `git -C`. The same review led to smaller fixes: overlapping holds are queued, and the buttons always answer the command shown; an error while holding refuses the command; `git clean -e`, `src:dst` and `HEAD` force pushes are measured correctly; and sizes use `du -k`, which works on macOS as well as Linux.
  - Tested in Claude Code, before those fixes: `rm -rf build` was held for more than 30 seconds, Cancel kept the files and Proceed deleted them; `git reset --hard` listed the two changed files and Cancel kept them; `git clean -fdx` was held. Force pushes and migrations were checked against the command classifier only, not run. The fixes are covered by tests of the classifier, the measuring step and the hold queue, run with Node against a stand-in for Claude Code; they haven't been re-run in a live session.
  - This fork: the rm allowlist was added inside `classify`, per segment, with tests run by `claude plugin test` on Claude Code 2.1.332.
  - This fork, 0.2.0: rewritten in TypeScript and split into `register.ts` (hooks and every `$` call), `classify.ts`, `allowlist.ts` and `draw.ts`; added `blastRadiusAllow`. Tests run by `claude plugin test` on Claude Code 2.1.332; not re-run in a live session.

## Run it

**Requirements:**

- Claude Code 2.1.287 or later, where mods load by default. The mod was built and tested on 2.1.280, and `claude plugin validate` passes on 2.1.285.
- `bash`, `git`, `find` and `du` on your `PATH`. For migrations, the project's own tool (for example `python3 manage.py showmigrations`).
- For the side pane, a terminal about 144 columns wide or more. Narrower terminals get the band above the prompt.

No environment variables. The rm allowlist is read from `~/.claude/settings.json`: `blastRadiusAllow` when set, else `permissions.allow`. With no `rm` rules there, the mod behaves like the original.

**Steps:**

1. Clone this repository and go to this folder's parent:

   ```bash
   git clone https://github.com/leotsaiCode/agent-dev-tools-marketplace.git
   cd agent-dev-tools-marketplace/claude
   ```

2. Check the plugin:

   ```bash
   claude plugin validate ./blast-radius-whitelist
   claude plugin test ./blast-radius-whitelist
   ```

3. Try it for one session:

   ```bash
   claude --plugin-dir ./blast-radius-whitelist
   ```

   Or install it from this repository's marketplace:

   ```bash
   claude plugin marketplace add leotsaiCode/agent-dev-tools-marketplace
   claude plugin install blast-radius-whitelist@agent-dev-tools-marketplace --scope user
   ```

   Remove it with `claude plugin uninstall blast-radius-whitelist@agent-dev-tools-marketplace --scope user`. Do not run it alongside the original `blast-radius`, or the original still holds every allowlisted `rm`.

4. Ask Claude to run something risky in a throwaway repo, for example "delete the build folder with rm -rf build".

**Using the pane:**

- Press `1` for Proceed or `2` for Cancel. You can also click a button, or Tab to it and press Enter.
- In the band above the prompt, `1` or `2` works while the input is empty.
- If nobody answers within 10 minutes, the command is refused.
- If you interrupt the turn (Esc), the command is refused.

## Notes / limitations

- It reads the command text. It doesn't parse shell fully: `$(...)`, aliases, `eval`, `bash -c "..."`, `xargs rm`, `find -delete`, scripts that call `rm`, and wrappers such as `timeout 5 rm`, `doas rm`, `time -p rm` or `env -i rm` aren't caught.
- Only the first risky part of a command line is measured, and the pane shows the command on one line, cut off if it's long. Proceed runs the whole line as written.
- It follows `cd`, `pushd`, `popd` and `git -C` on the same line. `cd -`, and a folder that doesn't exist, can't be measured; the pane says so and still holds the command. Otherwise it starts from the session's working folder.
- In a narrow terminal the report is drawn in the band above the prompt, which only one mod can use at a time. If another mod that draws there (such as Replay Theater or Token Weather in this folder) takes the band, the Proceed and Cancel buttons may not show, and the command is refused after 10 minutes. Use a wider terminal, or turn the other mod off, when you rely on Blast Radius.
- One command is held at a time. A second risky call, from a subagent for example, waits until the first is answered.
- It only watches the Bash tool. File edits and other tools aren't held.
- The `rm` count is approximate: a path matched twice is counted twice, and a file name with a line break is not counted. The list shows the first 10 files. Counts come from `find` and sizes from `du -k`, so a size is the space on disk, to the nearest kilobyte. A very large tree can take a few seconds to measure.
- The force-push list uses your last fetch of the remote branch. Without one, it can't list the dropped commits, and it says so. When the push names no remote, it assumes `origin`.
- To list pending migrations, it runs the tool's own status command (for example `python3 manage.py showmigrations`), which loads your project's code before you choose Proceed or Cancel. If that fails, the pane says it couldn't list them.
- A few harmless commands are held too, such as a commit whose message contains `; rm -rf`.
- It checks one command at a time. It holds a call, but it doesn't sandbox it: after you press Proceed, the command runs as written.
- This is a safety net, not a permission system. Use [permission rules](https://code.claude.com/docs/en/settings) for a hard block.

## Dependencies

| Name | Version | License (SPDX) | Source |
| --- | --- | --- | --- |
| None | | | |

The mod has no packages to install. It calls tools that are already on the machine (listed under Requirements).

## Third-party notices

Git is a trademark of Software Freedom Conservancy. Python is a registered trademark of the Python Software Foundation. npm is a trademark of npm, Inc. Django is a registered trademark of the Django Software Foundation. Rails and Ruby on Rails are trademarks of David Heinemeier Hansson. Prisma is a trademark of Prisma Data, Inc. Alembic is an open-source project of the SQLAlchemy authors. Use of these names here is descriptive and implies no endorsement.

---

Shared as-is. Not an official Anthropic product; no support or maintenance is implied. Licensed under Apache-2.0, see [LICENSE](LICENSE).
