# Contributing to Groundwork

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Before you start

- **Bugs:** open an issue with what you did, what you expected and what happened. A copy of the affected `groundwork/` files helps a lot; remove anything sensitive first.
- **Bigger changes**, especially to the file format in [SPEC.md](SPEC.md): open an issue first so we can agree on the approach. The format is a contract other tools rely on, so changes to it need care.

## Development

You need Node.js 22 or newer.

```sh
npm install
npm test           # Vitest
npm run typecheck
npm run build      # dist/ via tsup
```

Try your build with Claude Code in a scratch folder:

```sh
claude mcp add groundwork-dev -- node /path/to/groundwork/dist/mcp.js
```

## Layout

| Path | What it is |
|---|---|
| `src/core/` | Types, input schemas and the rules (`ops.ts`): pure functions, no I/O |
| `src/store/` | Reading and writing `groundwork/` files, `config.yml`, validation |
| `src/mcp/` | The MCP server and its tools |
| `src/cli.ts` | The `groundwork` command |
| `skills/`, `.claude-plugin/`, `.mcp.json` | The Claude Code plugin |

Keep rules in `src/core/ops.ts`, not in the tools, so every client applies them the same way.

## Pull requests

- Add or update tests for what you change.
- Keep the tool names and inputs stable. Agents and the hosted Groundwork server depend on them.
- `npm test` and `npm run typecheck` must pass.
- By contributing, you agree that your contribution is licensed under the Apache License 2.0.
