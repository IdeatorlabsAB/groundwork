---
name: groundwork
description: Use when planning or building a change to a product whose requirements and risks are kept in Groundwork — a new feature, a change in behaviour, or a fix — and when the user shares or works with product evidence or decisions (interview notes, support tickets, experiment results, specs, requirements) or asks what the team knows or why something is built. Records requirements, risks, code references, tests, tickets and release tags through the groundwork MCP tools as part of plan → build → PR, so nobody has to document by hand.
---

<!-- Generated from src/lib/agent-workflow.ts and src/lib/ai/skills/groundwork.ts by `npm run skills:build`. Don't edit by hand. -->

# Groundwork

Groundwork is the team's record of product evidence and decisions, **insight → hypothesis → experiment → finding → requirement**, and of what each release contains: requirements, risks, tests and tickets. It's connected as the `groundwork` MCP server. If its tools are missing, tell the user to connect it from Groundwork → Settings → Connect an agent.

Write requirements with the `groundwork-write-requirement` skill, and analyse risks with the `groundwork-risk` skill.

## Working in code: plan → build → PR

Groundwork's records are made while you work, not afterwards. Nobody should have to write them by hand.

**1. Start.** Call get_workspace once. Find the product this repository builds: AGENTS.md or CLAUDE.md names it ("Groundwork product: …"); otherwise ask.

**2. Plan, before writing code.**
- Classify the task:
  - *New need*: something users can't do today.
  - *Change*: existing behaviour that should work differently.
  - *Fix*: restores intended behaviour. Refactors and dependency bumps count as fixes.
- Call trace_code on the files in scope, and search_items for related requirements and risks.
- Add a **Groundwork** section to the plan, listing what you'll record:
  - stakeholder and solution requirements to add (stakeholder first). An approved requirement is never edited: add one that replaces it, and say which.
  - risks the change introduces or affects: hazard, harm, probability and severity on the workspace matrix, the requirements that mitigate them, and the residual score (groundwork-risk skill).
  - the release they're new in.
  - the tests that will verify each solution requirement: tests in the repository, and cases in the team's test-management tool (Qase, TestRail, …) if it uses one.
  - tickets to create in the team's tracker, if its tools are connected.
  - a fix lists none of these: name the requirement it restores, by key.
- The user approving the plan approves the Groundwork section: record it without asking again. With nobody to approve the plan, follow your own classification and keep the section in your summary as the record.
- Requirements written from a request in this session, with no finding or hypothesis behind them, get origin customer-need and an originNote saying who asked (a role, never a name).

**3. Build, recording as you go.**
- add_requirements (stakeholder requirements first, then the solution requirements that fulfil them), add_risks, and link_items for mitigations and release tags.
- Once the code exists, set codeRefs on the requirements and risks it implements (update_item).
- After writing tests, link_code_tests, with the requirement's key in each test's name (e.g. "import > REQ-0042 keeps templates").
- In the team's own tools, when they're connected: create the tickets and link_tickets them; write cases in the test-management tool from the verification criteria and link_test_cases them (tool, id, title, project, url). If a tool isn't connected, skip that step and say so. Never claim it was done.
- If the work turns out different from the plan, propose the change to the Groundwork section in one short list before recording it.
- Pass context on every change: the branch, then the PR and commit once they exist.

**4. Open the PR.**
- End the PR description, and each commit message, with a trailer naming what it implements or restores: `Groundwork: REQ-0042, RSK-0007`. CI reads it: on merge, the solution requirements and risks it names are tagged to the product's collecting release.
- After opening it, link_tickets the PR to its solution requirements: { tracker: "github", key: "owner/repo#57", url }.
- Call check_release for the release and tell the user what still blocks it.

**5. Never** approve requirements, accept a residual risk, or sign a release off. Those are people's decisions, made in the Groundwork app.

## Product evidence

| The user is… | Do this |
|---|---|
| Pasting interview notes, support tickets, survey answers or call transcripts | Offer to log the distinct pains and needs as insights (`add_insights`), one per pain, each with its verbatim quote |
| Proposing a feature or bet | Look for supporting insights (`search_items`), then offer to draft a hypothesis linked to them (`add_hypotheses`) |
| Planning a test, pilot or A/B test | `add_experiment` for that hypothesis, with a primary metric, baseline and target |
| Sharing results | `record_experiment_results`, then offer a finding (`add_findings`) linked to the experiment and hypothesis |
| Confident in a hypothesis, or it's rated "Build it now" | Skip the experiment: write stakeholder and solution requirements from it with `hypothesisIds` (the `groundwork-write-requirement` skill). Groundwork marks it high confidence |
| Asking "what do we know about X?" or "why are we building Y?" | `search_items` and `get_item`, and answer with links |

Quotes are evidence: keep them verbatim. Use a role ("Finance manager") and an optional ref like P07, never full names, emails or other personal details. Outside a plan, show the user what you're about to log as a short list, and log it once they agree; logging something they explicitly asked for needs no extra check.

## Always
1. Call get_workspace first: it gives the products, product areas, members (for approvers), the risk matrix and releases.
2. Before creating anything, search_items for duplicates and for evidence to link. Prefer linking to existing items over near-duplicates.
3. Always link evidence: hypotheses to insights, experiments to a hypothesis, findings to experiments, hypotheses or insights, requirements to findings.
4. When a new requirement duplicates or contradicts an existing one, show the user both and ask whether to replace, reuse or reshape. Never decide for them.
5. Ask before deleting items or approving requirements, unless the user already told you to.
6. Items have short keys (REQ-0042, RSK-0007, REL-0003) that never change, and every tool takes a key wherever it takes an id. Write keys, not ids, in plans, PRs, commits, tickets and test names.
7. Every result includes a url: share it so the user can open the item in Groundwork.
