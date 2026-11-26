# PR 5: Bring in the team's own requirements; one plan → build → PR loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:**
- The local agent can take the team's own requirement documents (Word or PDF specs, tender texts, Jira, Linear or CSV exports, spreadsheets, Markdown), propose Groundwork-shaped requirements from them, check for duplicates, and record them once the team agrees.
- The local `groundwork` plugin teaches the same plan → build → PR loop as the web app's `groundwork-cloud` plugin.

**Architecture:** This PR is skill and instruction text, plus one guard test. There are no new tools.
- A new local skill, `skills/groundwork-write-requirement/SKILL.md`. It's ported from the web app's `src/lib/ai/skills/write-requirement.ts`, with an added "Bring in requirements the team already has" workflow.
- The local `skills/groundwork/SKILL.md` gets the web app's plan → build → PR text (`src/lib/agent-workflow.ts`), adapted to local tools and files.
- The cloud plugin's three skill files are re-copied from the web app's generated `integrations/claude-code/`, which is newer than the copies here.
- A test checks that every tool name a local skill or INSTRUCTIONS mentions exists.

**Spec:** `docs/superpowers/specs/2026-11-26-local-traceability-design.md`, section "Planning-workflow skill (PR 5)".

## Global Constraints

- Branch `planning-skill`, one PR. The user merges after CI passes.
- No new MCP tools and no new fields. If the workflow needs something the tools can't do, note it for later instead.
- **Local adaptations of the web app's text:**
  - results give a `file`, not a `url`, so the agent mentions the file;
  - version tags are set with `versions` on risks and `plannedFor` on approval, not with `link_items` to a release;
  - item ids (REQ-0042) are the keys;
  - nothing is "in the Groundwork app": people decide in conversation, and the agent records what they say.
- **Imported requirements are drafts by default.** The team may say a requirement was already approved elsewhere (a signed tender, a contract). Then the agent records that approval with `approve_requirement`, with `approvedBy` (a person in config.yml) and a note naming the source, and only when the user says who approved it.
- **Traceable back to the source.** Each imported requirement gets an `origin` (`tender`, `regulation`, `contract`, `customer-need`) and an `originNote` naming the source and place, e.g. `"Region North tender 2026, §4.2"` or `"Jira ACME-142"`. Imported tickets are also linked with `link_tickets`.
- **Never invent.** Acceptance criteria the source doesn't state are marked as proposed in the list shown to the user. The agent asks about items that are unclear or contradict each other, and doesn't guess.

## Review Focus

1. **A skill names a tool that doesn't exist** (or a web-app-only one, e.g. `add_releases`). A local agent would fail. Test: Task 1, `every tool a local skill names exists`.
2. **A 200-row spreadsheet.** The skill has the agent work in batches: propose about 20 at a time, and record each batch once it's agreed, so nothing is lost if the session ends. That's a skill instruction; the review checks the text says it.
3. **A source row that's both a need and a solution** ("Secretaries need a calendar view showing free slots in colour"). The skill splits it into a stakeholder story and a shall statement, linked. It's a worked example in the skill.

---

### Task 1: The guard test

**Files:** Create `test/skills.test.ts`.
- `every tool a local skill names exists`:
  - for each `skills/*/SKILL.md`, every backticked token matching `^[a-z]+(_[a-z]+)+$` must be a tool registered by `buildServer` (`client.listTools()`);
  - the same for the server's `INSTRUCTIONS`, with tool-shaped words matched as bare words;
  - allow-list config keys and environment variables that match the pattern by accident, and list them in the test.
- `every local skill has a name and description in its frontmatter`.
- `the cloud plugin's skills match the web app's generated files`. It's skipped when `../centropic-prototype` doesn't exist (CI), so it guards the copy locally only.

- [ ] Write the test, run it, and record what fails now. Expected: it passes or names real problems. Fix real problems in Task 2 or 3.
- [ ] Commit, with this plan: `"Test that skills only name tools that exist"`.

### Task 2: `groundwork-write-requirement`, with importing

**Files:** Create `skills/groundwork-write-requirement/SKILL.md`.
- The frontmatter description is the web app's, plus: "…and when the team brings requirements it already has: documents, tender texts, tickets or spreadsheets, to rewrite as Groundwork requirements."
- The body has the web app's sections, word for word: stakeholder, solution, links, justification, overlap, resolution, reshape, scope. Then a local "With the Groundwork tools" recipe, using `add_requirements` with `findingIds`, `hypothesisIds` or `origin`, `search_items`, `get_item`, `link_items`, `obsolete_requirement` and `update_item`, and mentioning files.
- **New section, "Bring in requirements the team already has":**
  1. Read the source with the tools at hand: files in the repository, an export the user gives, or a connected tracker.
  2. Find the product and product area each item belongs to (`get_workspace`). Propose missing areas.
  3. Per source item, propose:
     - a stakeholder story when the source states a need;
     - one or more shall statements when it states behaviour;
     - both, linked, when it mixes the two (worked example included);
     - acceptance criteria from the source, with any the agent adds marked "(proposed)";
     - `origin` and an `originNote` with the source and place;
     - the source's own id.
  4. Check each proposal against existing requirements and against the rest of the batch (overlap rules). Show duplicates and conflicts with the resolution choices.
  5. Show the user a numbered table (source ref, kind, title, statement, criteria, origin, overlaps) of about 20 items at a time, and ask what to change.
  6. Once they agree, record the batch (stakeholder first, then solution with `stakeholderIds`). If a source item is a ticket, `link_tickets` it to its solution requirements. If the user says an item was already approved elsewhere, and by whom, `approve_requirement` with `approvedBy` and a note naming the source.
  7. Report what was recorded (ids and files), what was skipped and why, and the open questions.
- **Never:** record before the team agrees, drop a source item silently, put people's names in stories, or invent a source reference.

### Task 3: One plan → build → PR loop

**Files:**
- Modify: `skills/groundwork/SKILL.md`. Its "When you plan work" section is replaced by the web app's "Working in code: plan → build → PR", adapted per the Global Constraints:
  - step 2's Groundwork section includes "the version they're planned for";
  - step 3 uses `link_items` for mitigations, `versions` on risks, and `link_code_tests`/`link_test_cases`;
  - step 4: the `Groundwork: REQ-0042, RSK-0007` trailer in PR descriptions and commits (the GitHub Action reads it; see PR 6), `link_tickets` for the PR, and `check_release`;
  - step 5, never: approve requirements, accept a residual risk, or write a release justification on someone's behalf.

  The skill's table entries on product evidence, baselines, releasing and tests stay. Point to `groundwork-write-requirement` for writing and importing requirements.
- Modify: `src/mcp/server.ts`, the "When you plan work" block of INSTRUCTIONS, to the same steps in short form. Keep the existing tested phrases, or update `test/mcp.test.ts` where the test checks them. Add one line: "Bringing in requirements the team already has (documents, tickets, spreadsheets): see the groundwork-write-requirement skill."
- Copy: `../centropic-prototype/integrations/claude-code/*/SKILL.md` to `plugins/groundwork-cloud/skills/*/SKILL.md`, byte for byte.

### Task 4: README, CHANGELOG, review, PR

- **README:** a short section, "Bring in the requirements you already have", with an example prompt: "Here's our tender spec (docs/tender.pdf). Turn its requirements into Groundwork requirements."
- **CHANGELOG:** an entry.
- **Verify:** `npm test && npx tsc --noEmit && npm run build`.
- **Then:** the final review (fresh reviewer: read both skills as a coding agent would, and try the import workflow on a sample spec), the fix pass, push, open the PR, watch CI.

---

## Revisions after the plan review (they override the tasks above)

1. **Approvals in the import workflow.**
   - **Approved by the user themselves:** `submit_requirement_for_approval` to themselves, then `approve_requirement`. `approvedBy` can't be the actor.
   - **The product has planned versions:** ask which version, and pass `plannedFor`, or leave the requirement as a draft.
   - **Product:** set `product` on every solution requirement when there's more than one.
   - **Who approves:** `approvedBy` is the internal person who accepted it, and the note names the signed document.
2. **The scope section is adapted, not copied.** "New requirements are drafts. Approving them is a person's decision. The one exception: recording an approval the user reports, with who gave it." Step 5 of the loop says the same.
3. **`search_items` also searches `originNote`**, so an import can be resumed and source references found. It's one line in `textOf`, with the test `search_items finds a requirement by its source reference`.
4. **Source tickets.** Only open work tickets are linked with `link_tickets`, without `done`. Done items describe existing behaviour and go to the baseline workflow (`record_baseline`, `origin: existing-product`). A ticket that becomes only a stakeholder story isn't linked; its key goes in the `originNote`.
5. **Large sources.**
   - Start with an inventory pass: section, a one-line summary, and need / behaviour / not a requirement. The user drops boilerplate before any rewriting.
   - Clauses about the bidder or supplier aren't product requirements.
   - A tender's mandatory maps to must, and evaluated to should.
   - PDFs are read in page ranges (20 pages per read), and .docx files are converted first (`textutil` or `pandoc`).
   - CSV exports are parsed with a small script, because their fields span lines.
   - The table in chat shows title and statement, with criteria on request.
6. **The guard test also checks:**
   - bare tool-shaped words in skills;
   - backticked camelCase words against every input-schema property, with an allow-list of result and stored fields.

   The cloud-copy test's name says it runs only when the web app is checked out next to this repo.
7. **Claims that don't hold locally are dropped:** "marks the hypothesis committed", "url", and "in the Groundwork app".

**Cut:** the cloud re-copy step (done in Task 1).
