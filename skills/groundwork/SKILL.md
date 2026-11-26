---
name: groundwork
description: Use when planning or building a change to a product whose requirements and risks are kept in Groundwork — a new feature, a change in behaviour, or a fix — and when the user shares or works with product evidence or decisions — interview notes, support tickets, survey results, analytics, experiment results, PRDs, specs or requirements — or asks what the team knows, believes or has decided, or why something is being built. Records and looks up insights, hypotheses, experiments, findings and requirements in the project's groundwork/ folder through the groundwork MCP tools (get_workspace, search_items, add_insights, …).
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
| Creating tickets or user stories from requirements, or asking which requirement a ticket implements | Put the REQ ids in the ticket, then `link_tickets`; `search_items` with a ticket key finds its requirements |
| Releasing a version, or asking what a version contains ("Release Clinicare 1.1", "what's in 1.0?") | `get_release`, then `release_version` once the user agrees on what shipped (see "Releasing") |
| Asking to document, reverse-engineer or baseline what an existing product does | See "Reverse-engineering an existing product" |
| Planning a task (plan mode, a written plan, an autonomous workflow) | Follow "Working in code: plan → build → PR" |
| Bringing in requirements the team already has (a tender, a spec, a spreadsheet, a Jira or Linear export) | The `groundwork-write-requirement` skill, "Bring in requirements the team already has" |
| Planning what to build, or writing a PRD, spec or tickets | Write requirements before building, in two layers (see below, and the `groundwork-write-requirement` skill). Search existing requirements and findings first, and link findings when there are any |
| Asking "what do we know about X?" or "why are we building Y?" | `search_items` and `get_item`, and answer with the item ids and files |

## Requirements in two layers

1. **Stakeholder requirements** (`kind: "stakeholder"`): who needs what and why, as a user story.
   > As a medical secretary I want a view of the calendars of all practitioners in the clinic with their unbooked slots highlighted so that I can find them and book appointments easily.
2. **Solution requirements** (`kind: "solution"`): the qualities and behaviour the solution must have to meet those needs, as "shall" statements. Each one lists the stakeholder requirements it fulfils in `stakeholderIds`. This is required.
   > The appointment view used by medical secretaries shall show the calendars of the selected practitioners with the free slots highlighted. It shall be possible to click a free slot to start the booking flow. It shall be possible to add or remove practitioners in the view.

Add the stakeholder requirements first, then the solution requirements in a second `add_requirements` call that references their ids. One stakeholder requirement is usually fulfilled by several solution requirements. If a tool returns `warnings` about wording, rewrite the story with `update_item`. Before you start building, check that every stakeholder requirement is fulfilled: `get_item` shows `fulfilledBy`, and `groundwork validate` lists the gaps.

## Working in code: plan → build → PR

Groundwork's records are made while you work, not afterwards. Nobody should have to write them by hand. This is the same loop as the Groundwork web app's agents follow, so it carries over if the team moves there.

**1. Start.** Call `get_workspace` once. Find the product this repository builds: AGENTS.md or CLAUDE.md names it ("Groundwork product: …"); otherwise ask.

**2. Plan, before writing code.**
- Classify the task:
  - *New need*: something users can't do today. "Let's add a feature to book appointments."
  - *Change*: existing behaviour that should work differently. "Booking slots should be 15 minutes, not 30."
  - *Fix*: restores intended behaviour. "This path is broken, fix it." Refactors and dependency bumps count as fixes.
- Call `trace_code` on the files in scope, and `search_items` for related requirements and risks.
- Add a **Groundwork** section to the plan, listing what you'll record:
  - stakeholder and solution requirements to add (stakeholder first). An approved requirement is never edited: add one that replaces it (`replaces`), and say which. A draft is updated in place.
  - risks the change introduces or affects: hazard, harm, probability and severity on the risk matrix, the requirements that mitigate them, and the residual score (the `groundwork-risk` skill).
  - the version they're planned for.
  - the tests that will verify each solution requirement: tests in the repository, and cases in the team's test-management tool (Qase, TestRail, …) if it uses one.
  - tickets to create in the team's tracker, if its tools are connected.
  - a fix lists none of these: name the requirement it restores, by id ("Bug fix under REQ-0007; no requirement changes").
  - in a modernization of an existing product, new or changed behaviour gets new solution requirements (in the new product, or the next version) with `replaces` naming the baseline requirement. Never edit baseline items.
- The user approving the plan approves the Groundwork section: record it without asking again. With nobody to approve the plan (an autonomous workflow), follow your own classification and keep the section in your summary as the record.
- Requirements written from a request in this session, with no finding or hypothesis behind them, get origin customer-need and an `originNote` saying who asked (a role, never a name).
- Requirements the team brings from its own documents, tickets or spreadsheets: the `groundwork-write-requirement` skill, "Bring in requirements the team already has".

**3. Build, recording as you go.**
- `add_requirements` (stakeholder requirements first, then the solution requirements that fulfil them), `add_risks` with the `versions` they affect, and `link_items` from each risk to the requirements that mitigate it.
- Once the code exists, set `codeRefs` on the requirements and risks it implements (`update_item`).
- After writing tests, `link_code_tests`, with the requirement's id in each test's name (e.g. "import > REQ-0042 keeps templates").
- In the team's own tools, when they're connected: create the tickets (by default one per solution requirement, with its id, its file path and the stakeholder story it fulfils) and `link_tickets` them, so the link goes both ways. A fix ticket is linked to the requirement it restores; write cases in the test-management tool from the verification criteria and `link_test_cases` them (tool, id, title, project, url). If a tool isn't connected, skip that step and say so. Never claim it was done.
- If the work turns out different from the plan, propose the change to the Groundwork section in one short list before recording it.

**4. Open the PR.**
- End the PR description, and each commit message, with a trailer naming what it implements or restores: `Groundwork: REQ-0042, RSK-0007`. It ties the change to its requirements in the git history. The Groundwork GitHub Action reads it and comments on the PR with any traceability gaps.
- After opening it, `link_tickets` the PR to its solution requirements: { tracker: "github", key: "owner/repo#57", url }.
- Call `check_release` for the version and tell the user what still blocks it.

**5. Never** approve requirements, accept a residual risk, or write a release justification on someone's behalf. Those are people's decisions: record them only when the user tells you who made them.

Recording evidence or requirements directly isn't planning work. When a product manager (or anyone) asks you to log interview notes, draft hypotheses, record experiment results or write requirements, skip the new need / change / fix call and record what they ask for.

## Reverse-engineering an existing product

Use this when the user wants the existing behaviour of a product written down, for example before a rewrite. The result is a baseline: requirements that are already approved and already shipped, so new work can point at them with `replaces`.

1. `get_workspace`. Make sure the product exists, then agree the baseline version name with the user. Default to the product's current version number, else "legacy".
2. Survey the code: entry points, routes and screens, background jobs, integrations, the data model, permissions and roles. Propose product areas and add them with `add_product_areas`.
3. Take one area at a time. Read its code and tests. Draft the stakeholder needs (roles come from permissions and UI copy), "shall" statements of the behaviour you can see, and acceptance criteria from validation rules and tests. Give each requirement `codeRefs` (a repo path, optionally `#symbol` or `:line`). Add one hypothesis per major feature, with `origin: "inferred"` and an `originNote` saying what you inferred it from.
4. List the risks the area carries as it is (security, and domain harm such as patient safety), with the requirements that already control them (the `groundwork-risk` skill, "In a baseline").
5. Show the user the area's list. Raise suspected bugs, dead code and feature-flagged paths as questions. Don't bake them in. Ask who approves the baseline.
6. Call `record_baseline` for the area, with the version, the approver (`approvedBy`), the risks, and keys that link the new items. Repeat for each area. The version must hold only baseline work: it refuses one with other planned work or other shipped requirements. At the end, report the ids you created and the command `npx -p groundwork-mcp groundwork report release <version>`.

`record_baseline` makes the hypotheses validated and the requirements approved by the named person, and releases the solution requirements in the version. The approver must be a person who can approve, not a viewer. It takes no `findingIds` or `replaces`. It warns when a title matches a requirement or risk already in the area. Risks get `origin: existing-product` and are tagged for the baseline version. Without product files (`catalogue: legacy`), run `groundwork migrate` first.

## Tests

Every solution requirement should be verified by tests, and the links go both ways.

- **Tests in the repository.** After writing them, call `link_code_tests` with each test's file and the full name the runner reports. Put the requirement's id in the test's name, e.g. `"import > REQ-0042 keeps templates"`, so anyone reading the test can trace it. When you rename or delete a test, unlink the old name and link the new one.
- **Cases in a test-management tool** (Qase, TestRail, Xray, …). When the tool is connected, write cases there from the requirement's acceptance criteria, then call `link_test_cases` with the tool, the case id as the tool shows it, the title, the project (when case ids restart per project) and the case's URL. When the tool isn't connected, skip this and say so. Never claim a case exists without the tool.
- **Results.** After a run in the test-management tool finishes, read its results there and call `record_test_results` with the version it tested, the run (tool, project, id, title, url) and each case's latest status mapped to `passed`, `failed`, `blocked`, `skipped`, `invalid` or `in_progress` (TestRail retest → failed, untested → in_progress), with its end time. It writes a file under `groundwork/results/tools/`: commit it with the work. CI records the code tests' results itself (`groundwork results add --push`). `get_item` on a requirement shows whether its tests passed.
- Only solution requirements take tests. A test linked before its requirement shipped is part of that release's record and can't be unlinked. New tests can always be linked, including to baseline requirements.

## Releasing

Only solution requirements belong to releases. Stakeholder needs count as met through the solution requirements that fulfil them.

1. `get_release` for the version shows what's planned to ship and what's planned to become obsolete. `check_release` shows what blocks it: unmitigated risks, unapproved requirements, and tests that are missing, failed or haven't run. Fix what you can, or explain each blocker. CI results are read as last fetched: suggest `git fetch` when they may be stale.
2. Work out what actually shipped. If you have a tracker tool (Linear, Jira, GitHub), check the planned requirements' tickets there, record their status with `update_tickets`, and call `get_release` again. Propose its `ready` list (all tickets done) as shipped, and ask the user about `notReady` and `noTickets`: never ship those on ticket status alone. A ticket counts as done only when its work was completed as delivered: canceled, won't do or duplicate tickets are not done, even when closed. Without a tracker, ask the user.
3. Show the user what ships, what becomes obsolete, which planned version the rest moves to, and any blockers. Call `release_version` only once they agree. It signs the version off in a frozen record in `groundwork/releases/`. With blockers, it needs an owner's `overrideJustification`, in their own words: never write one yourself.
4. A signed-off version can't change. To add a requirement that shipped later, or fix a mistake: `withdraw_release` (an owner, with the reason), then `release_requirements` or `correct_release`, then `sign_off_release`.
5. A version released before sign-off records, and a baseline once all its areas are recorded, are signed off with `sign_off_release`.
6. For documentation or an audit, `npx -p groundwork-mcp groundwork report release <version>` prints the traceability report: requirements with their tasks, tests and results, risks and mitigations, and readiness. Add `--format csv` for a spreadsheet, and `--table risks` for the risk register.

## Rules

- Call `get_workspace` once per session for the products (with their areas and versions) and people. If it reports file problems, mention them. If an area, product or version you need is missing, check for a close match first, then add it with `add_product_areas`, `add_products` or `add_product_versions`. If it says `catalogue: legacy`, products still live in `config.yml`: suggest the user runs `npx -p groundwork-mcp groundwork migrate --dry-run`, then `groundwork migrate`, before adding versions.
- Search before you create. Link to existing items rather than adding near-duplicates.
- Always link evidence: hypothesis → insights, experiment → hypothesis, finding → experiments, hypotheses or insights, solution requirement → the stakeholder requirements it fulfils, and requirement → findings when there are any.
- If `groundwork validate` reports that an id is also used on the base branch, run `npx -p groundwork-mcp groundwork renumber --against <base>` (e.g. `origin/main`). Tell the user which ids changed, and mention any notes it flags as still naming the old id.
- Write through the tools, not by editing the files: the tools keep ids unique and links valid. The Markdown body under an item's frontmatter is the user's notes; read it, never overwrite it.
- Quotes are evidence: keep them verbatim. Use a role ("Finance manager") and an optional ref like P07, never full names, emails or other personal details. These files usually end up in git.
- Show the user what you're about to log, as a short list, and log it once they agree. Logging something they've explicitly asked for needs no extra check.
- Never delete items or approve requirements unless the user asks for that specific action.
- When approving a solution requirement whose product has planned versions, pass `plannedFor`. Ask the user which version, unless there's only one planned version or they already said. If the plan for a version changes, use `plan_requirements`.
- When the user says someone approved a requirement outside Groundwork (e.g. verbally), record it with `approve_requirement`, passing `approvedBy` and a `note`. Only do this when the user names the approver.
- After writing, tell the user the ids and files you created (e.g. `REQ-0004`, `groundwork/requirements/REQ-0004-…md`). Suggest committing them.
