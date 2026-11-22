---
name: groundwork
description: Use when the user shares or works with product evidence or decisions — interview notes, support tickets, survey results, analytics, experiment results, PRDs, specs or requirements — or asks what the team knows, believes or has decided, or why something is being built. Records and looks up insights, hypotheses, experiments, findings and requirements in the project's groundwork/ folder through the groundwork MCP tools (get_workspace, search_items, add_insights, …).
---

# Groundwork

Groundwork keeps the product's evidence and decisions as linked Markdown files in `groundwork/`:
**insight → hypothesis → experiment → finding → requirement**. Every requirement can be traced back to the evidence behind it.

It's connected as the `groundwork` MCP server. If its tools are missing, tell the user to install it:
`claude mcp add groundwork -- npx -y groundwork-mcp` (or the `groundwork` plugin) in Claude Code, or
`codex mcp add groundwork -- npx -y groundwork-mcp` in Codex.

## When to reach for it

| The user is… | Do this |
|---|---|
| Pasting interview notes, support tickets, survey answers or call transcripts | Offer to log the distinct pains and needs as insights (`add_insights`), one per pain, each with its verbatim quote |
| Proposing a feature or bet | Look for supporting insights (`search_items`), then offer to draft a hypothesis linked to them (`add_hypotheses`) |
| Planning a test, pilot or A/B test | `add_experiment` for that hypothesis, with a primary metric, baseline and target |
| Sharing results | `record_experiment_results`, then offer a finding (`add_findings`) linked to the experiment and hypothesis |
| Planning a task (plan mode, a written plan, an autonomous workflow) | Classify it as new need, change or fix, and state that in the plan; for a new need or change, record requirements before code (see "When you plan work") |
| Planning what to build, or writing a PRD, spec or tickets | Write requirements before building, in two layers (see below). Search existing requirements and findings first, and link findings when there are any |
| Asking "what do we know about X?" or "why are we building Y?" | `search_items` and `get_item`, and answer with the item ids and files |

## Requirements in two layers

1. **Stakeholder requirements** (`kind: "stakeholder"`): who needs what and why, as a user story.
   > As a medical secretary I want a view of the calendars of all practitioners in the clinic with their unbooked slots highlighted so that I can find them and book appointments easily.
2. **Solution requirements** (`kind: "solution"`): the qualities and behaviour the solution must have to meet those needs, as "shall" statements. Each one lists the stakeholder requirements it fulfils in `stakeholderIds`. This is required.
   > The appointment view used by medical secretaries shall show the calendars of the selected practitioners with the free slots highlighted. It shall be possible to click a free slot to start the booking flow. It shall be possible to add or remove practitioners in the view.

Add the stakeholder requirements first, then the solution requirements in a second `add_requirements` call that references their ids. One stakeholder requirement is usually fulfilled by several solution requirements. If a tool returns `warnings` about wording, rewrite the story with `update_item`. Before you start building, check that every stakeholder requirement is fulfilled: `get_item` shows `fulfilledBy`, and `groundwork validate` lists the gaps.

## When you plan work

Before you plan a task, decide what kind it is. If you're unsure, search for related requirements first.

- **New need:** something users can't do today. "Let's add a feature to book appointments."
- **Change:** existing behaviour that should work differently. "Booking slots should be 15 minutes, not 30."
- **Fix:** restores intended behaviour. "This path is broken, fix it." Refactors and dependency bumps count as fixes.

State your call in one line of the plan, so the user can overrule it:
*"New need: adds 2 stakeholder and 4 solution requirements"*, or *"Bug fix under REQ-0007; no requirement changes"*.

- **New need:** the plan's first steps add the stakeholder requirements, then the solution requirements that fulfil them, before any code.
- **Change:** update the requirement if it's a draft. If it's approved, add a new one; once it's agreed, make the old one obsolete with `obsolete_requirement` and `replacedBy`.
- **Fix:** don't write requirements. Name the requirement the fix restores when you can tell.
- **No person reviewing the plan** (an autonomous workflow): follow your own call. The one-line call stays in the plan as the record.

Recording evidence or requirements directly isn't planning work. When a product manager (or anyone) asks you to log interview notes, draft hypotheses, record experiment results or write requirements, skip the new need / change / fix call and record what they ask for.

When the workflow creates tickets or user stories (Linear, Jira, GitHub Issues or any board), use the solution requirements, and the stakeholder stories they fulfil, as a source. Put the REQ ids and the requirement's file path in each ticket. By default, one ticket per solution requirement.

## Rules

- Call `get_workspace` once per session for the products (with their areas and versions) and people. If it reports file problems, mention them. If an area, product or version you need is missing, check for a close match first, then add it with `add_product_areas`, `add_products` or `add_product_versions`. If it says `catalogue: legacy`, products still live in `config.yml`: suggest the user runs `npx -p groundwork-mcp groundwork migrate --dry-run`, then `groundwork migrate`, before adding versions.
- Search before you create. Link to existing items rather than adding near-duplicates.
- Always link evidence: hypothesis → insights, experiment → hypothesis, finding → experiments, hypotheses or insights, solution requirement → the stakeholder requirements it fulfils, and requirement → findings when there are any.
- If `groundwork validate` reports that an id is also used on the base branch, run `npx -p groundwork-mcp groundwork renumber --against <base>` (e.g. `origin/main`). Tell the user which ids changed, and mention any notes it flags as still naming the old id.
- Write through the tools, not by editing the files: the tools keep ids unique and links valid. The Markdown body under an item's frontmatter is the user's notes; read it, never overwrite it.
- Quotes are evidence: keep them verbatim. Use a role ("Finance manager") and an optional ref like P07, never full names, emails or other personal details. These files usually end up in git.
- Show the user what you're about to log, as a short list, and log it once they agree. Logging something they've explicitly asked for needs no extra check.
- Never delete items or approve requirements unless the user asks for that specific action.
- When the user says someone approved a requirement outside Groundwork (e.g. verbally), record it with `approve_requirement`, passing `approvedBy` and a `note`. Only do this when the user names the approver.
- After writing, tell the user the ids and files you created (e.g. `REQ-0004`, `groundwork/requirements/REQ-0004-…md`). Suggest committing them.
