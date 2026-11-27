# agent-dev-tools-marketplace

Personal developer tools for coding agents, grouped by the agent that runs them.

| Folder | Agent | Contents |
|---|---|---|
| `claude/` | Claude Code | Plugins and mods, listed in `.claude-plugin/marketplace.json` |

Claude Code reads the marketplace file only from `.claude-plugin/` at the repository root, so it stays there and points into `claude/`.

## Plugins

Each plugin's README covers what it does, how to configure it, and its limits.

| Plugin | Summary | Details |
|---|---|---|
| `blast-radius-whitelist` | Holds risky shell commands (`rm -rf`, `git reset --hard`, force push, migrations) and shows what they would change; lets `rm` through when an allowlist rule in `~/.claude/settings.json` covers every target. | [claude/blast-radius-whitelist/README.md](claude/blast-radius-whitelist/README.md) |

## Install (Claude Code)

```bash
claude plugin marketplace add leotsaiCode/agent-dev-tools-marketplace
claude plugin install blast-radius-whitelist@agent-dev-tools-marketplace --scope user
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Run `bun scripts/validate.ts` before you push; the GitHub Action runs the same script on every pull request and on `main`.

## License

Each plugin carries its own license in its folder. `blast-radius-whitelist` is Apache-2.0, as is the upstream it was copied from.

Shared as-is; no support or maintenance is implied.
