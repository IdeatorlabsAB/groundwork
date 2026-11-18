# Changelog

## Unreleased

- `add_product_areas` and `add_products`: agents can add product areas and products to `config.yml`. Add-only: existing ones are skipped.

## 0.2.0

- `groundwork import --to <web app>`: move a project into the Groundwork web app. Checks the files first, supports `--dry-run`, and is safe to run again (items already there are skipped unless `--overwrite`). Afterwards `config.yml` says `migrated:`, and local tools only read.

## 0.1.0

First release.

- Local MCP server (`groundwork-mcp`) with 17 tools to read, add, link and update insights, hypotheses, experiments, findings and requirements, run experiments and the requirement approval flow.
- Items stored as Markdown files with YAML frontmatter under `groundwork/`, with readable ids (`INS-0001`). See SPEC.md.
- `groundwork` CLI: `init`, `validate`, `trace`, `list`, `mcp`.
- Claude Code plugin with a skill.
