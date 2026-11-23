# Part 6: Tickets linked both ways. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Requirements record the tickets that implement them, in any tracker, and tickets name their REQ ids.
At release time, Groundwork can say which planned requirements are ready to ship from ticket status. The release
report lists each introduced requirement's tickets.

**Architecture:**
- A new optional `tickets` field on `Requirement` (`src/core/types.ts`, shared with the web app, additive).
- Core ops in `src/core/ops.ts` link, unlink and update tickets. Three MCP tools wrap them.
- A helper, `ticketsOf(r)`, also presents the legacy single-Linear `delivery` field as a ticket, so nothing is lost.
- Groundwork never calls a tracker. The agent uses whatever tracker tool the workflow has, and reports the results
  back.

**Tech Stack:** TypeScript, zod 4, @modelcontextprotocol/sdk, vitest.

**Spec:** `docs/superpowers/specs/2026-11-22-product-catalogue-releases-design.md`. The parts that apply:
- Goals §5 and §6 (step 3);
- "Tickets";
- "Releasing" (proposing `shipped` from ticket states);
- "Release report" ("each with its tickets");
- "Tracker-agnostic tickets" under "Claude's calls";
- the anti-goal "a release record that can be quietly changed afterwards".

## Global Constraints

- **`Ticket`:** `{ tracker: string; key: string; url?: string; title?: string; state?: string; done?: boolean; linkedAt: string; linkedBy: string; syncedAt?: string }`.
  - `tracker` is lowercase free text (`linear`, `jira`, `github`, …).
  - `key` is the tracker's id (`CLN-142`, `#57`).
  - `state` is the tracker's own status name.
  - `done` is the agent's reading of it: done, closed or merged mean `true`.
  - A ticket is identified by `tracker` plus `key`, ignoring case.
- **Link and unlink tickets only through the tools.** `tickets` isn't in `requirementInput`, so `update_item`
  rejects it.
- **The release record stays fixed:**
  - a release report lists only the tickets linked at or before the version's `releasedAt`;
  - a ticket linked before the requirement's release can't be unlinked;
  - tickets linked after the release (e.g. a later bug fix under that requirement) can be added to and removed
    from a released requirement;
  - `update_tickets` may change `state`, `done` and `syncedAt` at any time, because the report doesn't show
    states.
- **Legacy `delivery`** (one Linear issue, set by the web app) is shown as a ticket by `ticketsOf`:
  - `{ tracker: "linear", key: identifier, url, state: state.name, done: state.type === "completed", linkedAt: sentAt }`;
  - it's never written back as a `tickets` entry.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. The same ticket linked twice to a requirement, or with different casing (`cln-142` vs `CLN-142`): stored once.
   Linking one ticket to several requirements in one call works.
2. `update_tickets` for a ticket that isn't linked anywhere: reported in `notLinked`, not an error. The others are
   still updated.
3. A requirement that has only the legacy `delivery`: `get_item`, `get_release` readiness and the report all show it
   as a ticket.
4. A ticket linked after the requirement was released: shown on the requirement, not in that version's report, and
   it can be unlinked. A ticket linked before can't be unlinked.
5. A planned requirement with no tickets: in `get_release` it's under `noTickets`, never under `ready`, so it isn't
   proposed as shipped on ticket status alone.

---

### Task 1: The tickets field, the ops and the tools

**Files:**
- Modify: `src/core/types.ts` (`Ticket`, `Requirement.tickets?: Ticket[]`)
- Modify: `src/core/requirements.ts` (`ticketsOf`, `sameTicket`)
- Modify: `src/core/ops.ts` (`linkTickets`, `unlinkTickets`, `updateTickets`)
- Modify: `src/mcp/server.ts`:
  - the `link_tickets`, `unlink_tickets` and `update_tickets` tools;
  - `textOf` for requirements includes the ticket keys, so `search_items "CLN-142"` finds them;
  - the tool list test.
- Modify: `src/store/validate.ts` (a ticket missing `tracker` or `key` → error; the same ticket twice → warning)
- Test: `test/tickets.test.ts` (new), `test/mcp.test.ts`

**Interfaces:**
- Produces:
  - `ticketsOf(r: Requirement): Ticket[]`: the `tickets` field, plus `delivery` mapped as above when no ticket has
    the same key.
  - `sameTicket(a: Pick<Ticket, "tracker" | "key">, b: Pick<Ticket, "tracker" | "key">): boolean`
  - `linkTickets(s: Collections, c: Ctx, ids: string[], ticket: Omit<Ticket, "linkedAt" | "linkedBy">): Change<boolean>`.
    It adds the ticket to each requirement, unless it's already there. If it is, `url`, `title`, `state` and `done`
    are updated from the input when given. New tickets get `linkedAt: c.now` and `linkedBy: c.actor`.
  - `unlinkTickets(s: Collections, c: Ctx, ids: string[], ticket: Pick<Ticket, "tracker" | "key">): Change<boolean>`
  - `updateTickets(s: Collections, c: Ctx, updates: { tracker: string; key: string; state?: string; done?: boolean; title?: string }[]): Change<{ updated: number; notLinked: { tracker: string; key: string }[] }>`.
    It sets `syncedAt: c.now` on each updated ticket.
- **MCP tools:**
  - `link_tickets({ requirementIds: REQ[] (1–50), ticket: { tracker, key, url?, title?, state?, done? } })`. It
    refuses a stakeholder requirement: tickets implement solution requirements; link the solution requirement that
    fulfils it.
  - `unlink_tickets({ requirementIds, ticket: { tracker, key } })`. It refuses a ticket whose `linkedAt` is at or
    before the requirement's `releasedAt`, with the message
    `CLN-142 was linked when "<title>" shipped in 1.0, so it's part of that release's record.`
  - `update_tickets({ tickets: [{ tracker, key, state?, done?, title? }] (1–200) })`. It returns
    `{ updated, notLinked }`.
  - `get_item` on a requirement includes `tickets: ticketsOf(r)`.

- [ ] **Step 1: Write the failing tests.**
  - **In `test/tickets.test.ts`** (pure ops, on the `workspace()` fixture):
    - linking `{ tracker: "Linear", key: "cln-142" }` to `solutionReq` and `approvedReq` stores it on both, with
      `tracker: "linear"` and `linkedBy: USER`;
    - linking `CLN-142` again doesn't duplicate it;
    - `updateTickets` with `done: true` for `CLN-142` and one unknown key → `updated: 2` (two requirements), and
      the unknown key is in `notLinked`;
    - `ticketsOf` on a requirement with only `delivery` (identifier `MER-1`, state type `completed`) →
      `[{ tracker: "linear", key: "MER-1", done: true, … }]`.
  - **In `test/mcp.test.ts`:**
    - `link_tickets` on a stakeholder requirement → refused;
    - `search_items` with query `CLN-142` finds the requirement;
    - `update_item` with a `tickets` patch → refused.
- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run test/tickets.test.ts test/mcp.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement it.** Normalise `tracker` to lowercase on input. Store `key` as given, but compare it
  ignoring case.
- [ ] **Step 4: Run the full suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit** with the message `Tickets on requirements: link_tickets, unlink_tickets, update_tickets`.

### Task 2: Tickets in releases

**Files:**
- Modify: `src/store/release.ts`. `pendingRelease` gains `ready` (all tickets done, at least one), `notReady`
  (some ticket not done) and `noTickets`. The report's `introduced[].tickets` are the tickets linked by the
  version's `releasedAt`. `renderReleaseReport` adds `  - Tickets: linear CLN-142, CLN-150` under each
  requirement.
- Modify: `src/mcp/server.ts`. `get_release` for a planned version returns `ready`, `notReady` and `noTickets`, each
  as summaries with their tickets.
- Modify: `src/mcp/server.ts` `INSTRUCTIONS` and `skills/groundwork/SKILL.md`, in the Releasing steps:
  1. Refresh the planned requirements' tickets from the tracker with `update_tickets`.
  2. Propose `ready` as shipped.
  3. Ask about `notReady` and `noTickets`; never ship those on ticket status alone.
- Test: `test/release.test.ts`, `test/mcp.test.ts`

**Interfaces:**
- Consumes: `ticketsOf` from Task 1.
- `pendingRelease(...)` returns `{ planned, ready, notReady, noTickets, replacedBy, removals }`, where `ready`,
  `notReady` and `noTickets` partition `planned`.

- [ ] **Step 1: Write the failing tests:**
  - `pendingRelease` with A (tickets all done), B (one ticket not done) and C (no tickets) → `ready: [A]`,
    `notReady: [B]`, `noTickets: [C]`.
  - A requirement with only `delivery` (`completed`) is `ready`.
  - Release A with `releasedAt: NOW`, then link a ticket to A with a later `linkedAt` → the 1.0 report's A tickets
    exclude it, and the Markdown shows only the earlier ticket.
  - MCP:
    - `get_release` returns the three groups;
    - `unlink_tickets` of a ticket linked before the release → refused;
    - a ticket linked after the release can be unlinked.
- [ ] **Step 2: Run them and check they fail**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the full suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit** with the message `Release readiness from ticket status; tickets in the release report`.

### Task 3: Creating tickets from requirements: guidance, example and docs

**Files:**
- Modify: `src/mcp/server.ts` `INSTRUCTIONS`, step 7 of "When you plan work". After creating a ticket:
  - call `link_tickets` with the requirement ids, tracker, key and URL;
  - for a fix under an existing requirement ("Bug fix under REQ-0007"), link the fix ticket to that requirement
    too.
- Modify: `skills/groundwork/SKILL.md`: the same, in "When you plan work", and a table row for "creating tickets or
  user stories".
- Modify: `examples/acme/groundwork/requirements/REQ-0002-guided-csv-import.md`:
  - add `tickets: [{ tracker: linear, key: ACME-12, url: https://linear.app/acme/issue/ACME-12, state: Done, done: true, linkedAt: <before 1.0's releasedAt>, linkedBy: sam }]`;
  - the report then shows it.
- Docs:
  - `README.md`: "Tickets" in Planning with Groundwork, and the report sample;
  - `SPEC.md`: the `tickets` field and its rules;
  - `CHANGELOG.md`: under Unreleased.
- Test: the guidance test in `test/mcp.test.ts` asserts that the instructions contain `link_tickets`.

- [ ] **Step 1: Write the failing guidance test, and check it fails.**
- [ ] **Step 2: Update the guidance, the example and the docs.**
- [ ] **Step 3: Check**

Run: `npm test && npm run typecheck && npm run build && (cd examples/acme && node ../../dist/cli.js validate && node ../../dist/cli.js report release 1.0 | grep "ACME-12")`
Expected: green, valid, and the ticket in the report.

- [ ] **Step 4: Commit** with the message `Guide agents to link tickets they create; acme ticket; document tickets`.
