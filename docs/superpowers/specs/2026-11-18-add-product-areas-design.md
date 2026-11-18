# Add product areas and products over MCP

## Why

An agent logging customer insights hit "Unknown product area … (none defined)" and had no tool to fix it: product
areas and products live only in `groundwork/config.yml`, and no MCP tool writes them. Items logged without an area
reach the web app untagged when the project is later moved with `groundwork import`, which already carries
`productAreas` and `products` from `config.yml`. So this both unblocks the agent and improves the data that gets
migrated.

## Goals

- An agent can add product areas and products itself, mid-task, without editing YAML.
- When an agent is told an area or product is unknown, the message points it at the tool.

## Non-goals

- Renaming or removing areas or products (still a hand edit to `config.yml`, checked by `groundwork validate`).
- Adding or changing people. People decide who can approve requirements, so they stay hand-edited.
- Creating areas implicitly when an item uses an unknown one.

## Anti-goals

- A call that drops or changes an existing area or product, leaving items tagged with something no longer configured.
- A messy taxonomy (near-duplicate areas) carried into the paid product.

## Approaches

1. **Two add-only tools, `add_product_areas` and `add_products`. Chosen.** It unblocks the agent and can't break
   existing items. The trade-off is no rename or remove over MCP.
2. One `update_workspace` tool that replaces the lists. More flexible, but one bad call can drop an area that items
   use, and those items then fail `validate` and block the import.
3. Create an area the first time an item uses it. Smoothest, but typos and near-duplicates become permanent and get
   migrated.

## Design

**`add_product_areas`**: input `areas: [{ label, id? }]`, 1–20 items.
- `id` defaults to a slug of the label (lowercase, non-alphanumerics → `-`, trimmed, max 40 chars), and must match
  the existing `slugId` rule in `config.ts`.
- An area whose label (case-insensitive) or id already exists is skipped, not an error. Two different labels that
  slug to the same id: the second is an error asking for an explicit `id`.
- Result: `{ added: [...], alreadyThere: [...], productAreas: <full list> }`.

**`add_products`**: input `products: string[]`, 1–20 items. A product that already exists (case-insensitive) is
skipped. Same result shape, with `products`.

**Both tools**
- Use the same guards as other writes: refused when `config.yml` says `migrated:`, and refused for viewers.
- Write `config.yml` through the existing `writeConfig`, keeping every other field. If there is no `config.yml` yet,
  create it from the default config (as the first write does today).
- Don't touch any item files.

**Messages and docs**
- The "Unknown product area" and "Unknown product" errors say to call `add_product_areas` / `add_products` (or
  leave the field out), instead of "Add it there first".
- The server instructions mention that an agent can add areas and products when the user asks for them or when
  logging needs one, and should check `get_workspace` for an existing match first so it doesn't add near-duplicates.
- README tools table, CHANGELOG (next version), SPEC.md config section, and the plugin skill if it lists tools.

**Tests** (in `test/mcp.test.ts`): adding new areas and products; skipping duplicates by label and id; slug collision
error; refused when migrated; refused for a viewer; other config fields and items unchanged; an item can be tagged
with a newly added area in the same session.

## Left to the builder

- Where the slug helper lives and the exact wording of descriptions and messages.
- Whether the write goes through the existing `write` wrapper or a small config-only variant of it (the wrapper is
  built around item state, so a config-only variant is likely cleaner).
