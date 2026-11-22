# Changelog

## Unreleased

- **Product catalogue.** Each product is a file in `groundwork/products/` (`PRD-0001-…md`) holding its areas and versions, kept in the repo next to the code. Area ids are unique across products. A solution requirement's `product` is the product id.
- `add_products` creates product files. `add_product_areas` adds areas to one, and the new `add_product_versions` adds planned versions. `get_workspace` returns each product with its areas and versions.
- `groundwork migrate [--dry-run]` moves a project's products and areas from `config.yml` into product files and points requirements at product ids. Projects that haven't migrated keep working as before.
- `validate` checks area ids across products, duplicate versions, and requirements that name a product by title instead of id.
- `renumber` covers product files and requirements' `product` links.
- **Breaking:** `config.yml` is now `schemaVersion: 2` for new projects and after `migrate`. Older groundwork-mcp versions refuse such a folder and say to update.

## 0.5.0

- `groundwork validate --against <base>` also reports ids that the branch shares with a different item on the base branch. Everyone numbers new items on their own clone, so two branches can both create `REQ-0012`.
- `groundwork renumber --against <base>` fixes this on the branch. The branch's items get the next free ids, their files are renamed, and links to them are rewritten in the files the branch changed. Ids on the base never change. Notes that mention an old id are reported, not rewritten.
- The duplicate-id error points at `renumber`. The README's CI example checks against the base branch.

## 0.4.0

- Requirements in two layers. Stakeholder requirements are user stories ("As a … I want … so that …"). Solution requirements are "shall" statements, and each must fulfil at least one stakeholder requirement through `stakeholderIds`. The tools refuse a solution requirement without one, and won't delete the only stakeholder requirement a solution requirement fulfils.
- `add_requirements` and `update_item` return `warnings` when a story doesn't fit its layer. `get_item` on a stakeholder requirement lists the solution requirements that fulfil it (`fulfilledBy`).
- `validate` reports an active solution requirement without stakeholder links as an error. It warns about stakeholder requirements that nothing fulfils yet, and about wording.
- Requirements no longer need `findingIds` or an `origin`, so they can be written before building.
- **Breaking:** `add_requirements` requires `kind`. Existing solution requirements without `stakeholderIds` now fail `groundwork validate`. Link them to a stakeholder requirement with `link_items`.
- The acme example now has a stakeholder requirement behind every solution requirement.
- When agents plan work, they classify the task as a new need, a change or a fix, and state that in the plan. For a new need or a change, they record requirements before writing code, and they build tickets from requirements with the REQ ids in them.
- Recording insights, hypotheses, experiment results or requirements directly isn't planning work, so agents record what a product manager asks for without the new need / change / fix call.
- `approve_requirement` can record an approval given outside Groundwork, such as a PM approving verbally. It takes `approvedBy` and a `note`, and stores who entered it as `recordedBy`.
- Setup instructions for Codex in the README, the skill and the CLI's messages (`--help`, `init`, `import`).

## 0.3.0

- `add_product_areas` and `add_products`: agents can add product areas and products to `config.yml`. Add-only: existing ones are skipped.
- `add_requirements` matches a product name regardless of case and stores the spelling from `config.yml`.

## 0.2.0

- `groundwork import --to <web app>`: move a project into the Groundwork web app. Checks the files first, supports `--dry-run`, and is safe to run again (items already there are skipped unless `--overwrite`). Afterwards `config.yml` says `migrated:`, and local tools only read.

## 0.1.0

First release.

- Local MCP server (`groundwork-mcp`) with 17 tools to read, add, link and update insights, hypotheses, experiments, findings and requirements, run experiments and the requirement approval flow.
- Items stored as Markdown files with YAML frontmatter under `groundwork/`, with readable ids (`INS-0001`). See SPEC.md.
- `groundwork` CLI: `init`, `validate`, `trace`, `list`, `mcp`.
- Claude Code plugin with a skill.
