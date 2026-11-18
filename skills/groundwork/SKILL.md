---
name: groundwork
description: Use when the user shares or works with product evidence or decisions — interview notes, support tickets, survey results, analytics, experiment results, PRDs, specs or requirements — or asks what the team knows, believes or has decided, or why something is being built. Records and looks up insights, hypotheses, experiments, findings and requirements in the project's groundwork/ folder through the groundwork MCP tools (get_workspace, search_items, add_insights, …).
---

# Groundwork

Groundwork keeps the product's evidence and decisions as linked Markdown files in `groundwork/`:
**insight → hypothesis → experiment → finding → requirement**. Every requirement can be traced back to the evidence behind it.

It's connected as the `groundwork` MCP server. If its tools are missing, tell the user to install it:
`claude mcp add groundwork -- npx -y groundwork-mcp` (or the `groundwork` plugin).

## When to reach for it

| The user is… | Do this |
|---|---|
| Pasting interview notes, support tickets, survey answers or call transcripts | Offer to log the distinct pains and needs as insights (`add_insights`), one per pain, each with its verbatim quote |
| Proposing a feature or bet | Look for supporting insights (`search_items`), then offer to draft a hypothesis linked to them (`add_hypotheses`) |
| Planning a test, pilot or A/B test | `add_experiment` for that hypothesis, with a primary metric, baseline and target |
| Sharing results | `record_experiment_results`, then offer a finding (`add_findings`) linked to the experiment and hypothesis |
| Writing a PRD, spec or tickets | Search findings and requirements first; add requirements linked to findings, or with an origin (tender, regulation, contract, customer need) if decided elsewhere |
| Asking "what do we know about X?" or "why are we building Y?" | `search_items` and `get_item`, and answer with the item ids and files |

## Rules

- Call `get_workspace` once per session for product areas, products and people. If it reports file problems, mention them.
- Search before you create. Link to existing items rather than adding near-duplicates.
- Always link evidence: hypothesis → insights, experiment → hypothesis, finding → experiments, hypotheses or insights, requirement → findings.
- Write through the tools, not by editing the files: the tools keep ids unique and links valid. The Markdown body under an item's frontmatter is the user's notes; read it, never overwrite it.
- Quotes are evidence: keep them verbatim. Use a role ("Finance manager") and an optional ref like P07, never full names, emails or other personal details. These files usually end up in git.
- Show the user what you're about to log, as a short list, and log it once they agree. Logging something they've explicitly asked for needs no extra check.
- Never delete items or approve requirements unless the user asks for that specific action.
- After writing, tell the user the ids and files you created (e.g. `REQ-0004`, `groundwork/requirements/REQ-0004-…md`). Suggest committing them.
