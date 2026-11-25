# agent-dev-tools-marketplace

Personal developer tools for coding agents, grouped by the agent that runs them.

| Folder | Agent | Contents |
|---|---|---|
| `claude/` | Claude Code | Plugins and mods, listed in `.claude-plugin/marketplace.json` |

Claude Code reads the marketplace file only from `.claude-plugin/` at the repository root, so it stays there and points into `claude/`.

## Plugins

| Plugin | Description |
|---|---|
| [blast-radius-whitelist](claude/blast-radius-whitelist/) | A fork of the `blast-radius` mod from [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground). It holds risky shell commands for confirmation, but lets `rm` commands through when every target is allowed by an `rm` rule in `~/.claude/settings.json` `permissions.allow`. |

## Install (Claude Code)

```bash
claude plugin marketplace add leotsaiCode/agent-dev-tools-marketplace
claude plugin install blast-radius-whitelist@agent-dev-tools-marketplace --scope user
```

## License

Each plugin carries its own license in its folder. `blast-radius-whitelist` is Apache-2.0, as is the upstream it was copied from.

Shared as-is; no support or maintenance is implied.
