# Contributing

How to add or change a plugin in this marketplace.

## Add a plugin

Say the plugin is called `foo`.

### 1. Create the folder

```
claude/foo/
  .claude-plugin/
    plugin.json      # required
  README.md          # required: what it does, how to configure it, limits
  LICENSE            # required when the plugin is a fork or uses another license
  skills/            # optional: skills (triggered by the model)
  commands/          # optional: slash commands
  agents/            # optional: subagents
  hooks/hooks.json   # optional: hooks, or a mod's `modules`
  tests/             # optional: *.test.ts, run by `claude plugin test`
  .mcp.json          # optional: MCP servers
```

Every capability is optional, but a plugin needs at least one, or installing it does nothing.

The folder name, the `name` in `plugin.json`, and the `name` in `marketplace.json` must all be the same.

### 2. `claude/foo/.claude-plugin/plugin.json`

```json
{
  "name": "foo",
  "version": "0.1.0",
  "description": "One sentence on what the plugin does",
  "author": { "name": "Your name" },
  "keywords": ["..."]
}
```

### 3. List it in `.claude-plugin/marketplace.json`

```json
{
  "name": "foo",
  "source": "./claude/foo",
  "version": "0.1.0",
  "description": "One sentence, shown in the /plugin menu"
}
```

A folder that is not listed there cannot be installed.

### 4. Document it

- `claude/foo/README.md` holds the detailed docs: what it does, settings, requirements, limits.
- The root `README.md` gets one row in the Plugins table: a one-line summary and a link to the plugin's README. Keep the details out of the root README.

### 5. Validate

```bash
bun install            # once: types for the scripts check
bun scripts/validate.ts
```

It checks:

1. Every JSON file parses.
2. `marketplace.json` and each `plugin.json` agree on name and version; each plugin has a README, at least one capability, and every module its `hooks.json` names.
3. No folder under `claude/` is left out of `marketplace.json`.
4. `claude plugin validate` passes, `claude plugin test` when the plugin has `tests/`, and strict `tsc` when it has a `tsconfig.json`. Claude Code writes that `tsconfig.json` and the types it points at (`.claude-plugin/types/`) the first time it validates or loads a TypeScript mod; commit the `tsconfig.json`.
5. Strict `tsc` on `scripts/`, using the root `tsconfig.json` and the `@types/bun` that `bun install` puts in `node_modules/`.

It needs [Bun](https://bun.sh) and Claude Code on your `PATH`. Neither check needs a login. CI installs Claude Code 2.1.332; use the same version locally when a test passes for you and fails there.

Then try it in a real session:

```bash
claude --plugin-dir ./claude/foo
```

### 6. Open a pull request

The GitHub Action (`.github/workflows/validate.yml`) runs `bun scripts/validate.ts` on every pull request and on pushes to `main`.

## Change a plugin

- **Bump `version` with every change**, in `plugin.json` and `marketplace.json`, to the same value. Without a new version, `claude plugin update` may not see the change.
- Update the plugin's README in the same change when behavior or settings change.
- Don't write runtime state into the plugin folder (caches, logs, temp files). The installed copy lives under `~/.claude/plugins/cache/` and is replaced on update.
- Never commit credentials. Read them from the user's environment and say in the plugin's README how to set them.

## Mods written in TypeScript

- Claude Code loads `.ts` modules directly. There is no build step.
- Anything that calls `$` stays in the entry module (`hooks/register.ts`): Claude Code refuses `$` passed into another file. Pure helpers can live in other files.
- Claude Code writes the mod's type definitions to `.claude-plugin/types/` when it loads the mod. That folder is ignored by git.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), in English: `<type>(<scope>): <description>`, for example `feat(blast-radius-whitelist): add blastRadiusAllow setting`.
