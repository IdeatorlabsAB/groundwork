# Part 1: Agent planning guidance and approvals on someone's behalf. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two things, using the features that exist today:
- Agents that plan work decide whether a task is a new need, a change or a fix. They write or update requirements
  before building, and they build tickets from requirements.
- A developer can record an approval a PM gave verbally.

**Architecture:**
- The guidance is text: the MCP server's `INSTRUCTIONS` (`src/mcp/server.ts`) and the plugin skill
  (`skills/groundwork/SKILL.md`). There's no new tool.
- Approval on someone's behalf extends the existing core op `approveRequirement` (`src/core/ops.ts`) and the
  `approve_requirement` tool.
- The new fields are optional and additive, because the core ops are shared with the hosted web app.

**Tech Stack:** TypeScript, zod 4, @modelcontextprotocol/sdk, vitest.

**Spec:** `docs/superpowers/specs/2026-11-22-product-catalogue-releases-design.md`. The parts this plan covers:
- Goals §6 and "Agent workflow guidance": the guidance;
- "Added after the developer review", second bullet: approvals on someone's behalf.

Parts 2–6 (branch-safe ids, catalogue, versions, releases, tickets) get their own plans.

**Base branch:**
- This builds on PR #8 (two-layer requirements), which isn't merged yet.
- Create `agent-planning-guidance` from `two-layer-requirements`:
  `git checkout two-layer-requirements && git checkout -b agent-planning-guidance`.
- Rebase onto `main` after #8 merges.

## Global Constraints

- New requirement fields are optional, and stored items without them stay valid (SPEC: "Unknown fields are kept").
- People are only ever added to `config.yml` by hand. Tools may reference people, never create them.
- Viewers can't write at all. That's enforced already by `refusal()` in `src/mcp/server.ts`, so keep it that way.
- Use the examples from the spec exactly:
  - new need: "Let's add a feature to book appointments";
  - fix: "This path is broken, fix it";
  - plan lines: *"New need: adds 2 stakeholder and 4 solution requirements"* and *"Bug fix under REQ-0007; no
    requirement changes"*.
- The guidance must work for any agent (Claude Code, Codex, autonomous workflows). Don't mention Claude-Code-only
  features as requirements.
- The guidance uses only what exists after PR #8. No versions, releases or `link_tickets` yet: tickets are recorded
  by putting REQ ids in the ticket, and recording them in Groundwork comes in part 6.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. `approvedBy` names a person who is a viewer: refused, because a viewer can't approve. The error names them.
2. `approvedBy` is an id that isn't in `config.yml`: refused, with an error pointing at `config.yml` people.
3. Recording an approval for a requirement that's already approved, in delivery or obsolete: refused, with its
   status in the message.
4. `approvedBy` equals the acting person: a normal approval. No `recordedBy` is stored.
5. A draft that was never submitted, approved verbally: allowed when `approvedBy` is given. `approver` is set to
   the approver if it was unset, so the record reads consistently.

---

### Task 1: Record an approval on someone's behalf

**Files:**
- Modify: `src/core/types.ts` (the `Requirement` interface, next to `approvedBy`/`approvedAt`)
- Modify: `src/core/ops.ts` (`approveRequirement`)
- Modify: `src/mcp/server.ts` (the `approve_requirement` tool)
- Modify: `SPEC.md` (requirement fields)
- Test: `test/ops.test.ts`, `test/mcp.test.ts`

**Interfaces:**
- Produces:
  - `Requirement.recordedBy?: string`: the person who entered an approval given by someone else.
  - `Requirement.approvalNote?: string`: how or where it was approved.
  - `approveRequirement(s: Collections, c: Ctx, id: string, by?: { approvedBy: string; note?: string }): Change<boolean>`.

- [ ] **Step 1: Write the failing ops tests** in `test/ops.test.ts`, inside `describe("requirement status rules")`:

```ts
it("records an approval given by someone else", () => {
  const s = apply(workspace(), ops.approveRequirement(workspace(), ctx(), ID.stakeholderReq, { approvedBy: OTHER_USER, note: "Verbal, sprint planning" }));
  expect(s.requirements.find((r) => r.id === ID.stakeholderReq)).toMatchObject({
    status: "approved", approvedBy: OTHER_USER, recordedBy: USER, approvalNote: "Verbal, sprint planning", approver: OTHER_USER,
  });
});

it("doesn't store recordedBy when you approve yourself", () => {
  const s = apply(workspace(), ops.approveRequirement(workspace(), ctx(), ID.solutionReq, { approvedBy: USER }));
  const r = s.requirements.find((x) => x.id === ID.solutionReq)!;
  expect(r.approvedBy).toBe(USER);
  expect(r.recordedBy).toBeUndefined();
});
```

(`ctx()` acts as `USER`, `ID.stakeholderReq` is a draft with no approver, `ID.solutionReq` is awaiting `USER`.
All three are in `test/fixtures.ts`.)

- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run test/ops.test.ts -t "approval"`
Expected: FAIL. `recordedBy`, `approvalNote` and `approver` are missing.

- [ ] **Step 3: Add the two fields to `Requirement`, and extend `approveRequirement`**
- Add `recordedBy` and `approvalNote` to `Requirement` in `src/core/types.ts`, each with a one-line doc comment.
- Extend `approveRequirement` in `src/core/ops.ts`:
  - `approvedBy` = `by?.approvedBy ?? c.actor`;
  - set `recordedBy: c.actor` only when `approvedBy !== c.actor`;
  - set `approvalNote` when `by?.note` is given;
  - set `approver` to `approvedBy` when the requirement has none;
  - the activity text is `approved "<title>" for <approvedBy>` when recorded for someone else.

  The status guard stays the same.

- [ ] **Step 4: Run the ops tests and check they pass**

Run: `npx vitest run test/ops.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Write the failing MCP tests** in `test/mcp.test.ts`, in a new `describe("approval on someone's behalf")`.

Setup: the shared `beforeEach` gives people `sam` (owner, acting) and `alex` (editor). For the viewer case, add
`{ id: "vic", name: "Vic", role: "viewer" }` with `writeConfig`, the way the "refused for a viewer" test does.
Create one stakeholder requirement with `add_requirements` (`kind: "stakeholder"`, a valid user story). Then:

```ts
it("records a verbal approval of a draft", async () => {
  const { data } = await call(c, "approve_requirement", { id, approvedBy: "alex", note: "Approved by Alex in sprint planning" });
  expect(data.approved.status).toBe("approved");
  expect(load(root).items.requirements[0]).toMatchObject({ approvedBy: "alex", recordedBy: "sam", approvalNote: "Approved by Alex in sprint planning" });
});
it("refuses an approver who isn't in config.yml", async () => {
  expect((await call(c, "approve_requirement", { id, approvedBy: "nobody" })).error).toMatch(/isn't in groundwork\/config.yml/);
});
it("refuses a viewer as approver", async () => {
  expect((await call(c, "approve_requirement", { id, approvedBy: "vic" })).error).toMatch(/Vic is a viewer/);
});
it("refuses a requirement that's already approved", async () => {
  await call(c, "approve_requirement", { id, approvedBy: "alex" });
  expect((await call(c, "approve_requirement", { id, approvedBy: "alex" })).error).toMatch(/is approved/);
});
it("without approvedBy, a draft still needs submitting first and points at approvedBy", async () => {
  expect((await call(c, "approve_requirement", { id })).error).toMatch(/approvedBy/);
});
```

The existing test "runs the approval flow with people from config.yml" must keep passing unchanged: approval
without `approvedBy` still requires the acting person to be the named approver.

- [ ] **Step 6: Run them and check they fail**

Run: `npx vitest run test/mcp.test.ts -t "on someone's behalf"`
Expected: FAIL, because the input schema rejects `approvedBy`.

- [ ] **Step 7: Extend the `approve_requirement` tool in `src/mcp/server.ts`**
- Input: add `approvedBy: z.string().max(40).optional()` (described as "Who approved it, when they did so outside
  Groundwork, e.g. verbally. A person id from get_workspace.") and `note: z.string().trim().max(300).optional()`.
- With `approvedBy`:
  - the person must exist (otherwise: `${approvedBy} isn't in groundwork/config.yml people. Add them there
    first.`);
  - the person must not be a viewer (otherwise: `${name} is a viewer, so they can't approve.`);
  - the status must be `draft` or `awaiting-approval` (otherwise: `"${title}" is ${status}; only drafts and
    requirements awaiting approval can be approved.`);
  - then call `ops.approveRequirement(state, c, id, { approvedBy, note })`.
- Without `approvedBy`:
  - behaviour is unchanged;
  - but the "not awaiting approval" error for a draft adds: ` If someone approved it outside Groundwork, record it
    with approvedBy.`
- Description: add "If the approver signed off outside Groundwork (e.g. verbally), pass approvedBy and a note.
  Groundwork records who entered it."

- [ ] **Step 8: Run the full suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass, no type errors.

- [ ] **Step 9: Document the fields in `SPEC.md`**
- In the requirement field list after `approvedAt`, add `recordedBy` (who entered an approval given by someone
  else) and `approvalNote`.
- In "Rules the tools apply", add one line: an approval given outside Groundwork can be recorded with `approvedBy`
  and an optional note; the person recording it is stored as `recordedBy`.

- [ ] **Step 10: Commit**

```bash
git add src/core/types.ts src/core/ops.ts src/mcp/server.ts SPEC.md test/ops.test.ts test/mcp.test.ts
git commit -m "Record approvals given outside Groundwork, on the approver's behalf"
```

### Task 2: Planning guidance for agents

**Files:**
- Modify: `src/mcp/server.ts` (`INSTRUCTIONS`)
- Modify: `skills/groundwork/SKILL.md`
- Modify: `README.md`, `CHANGELOG.md` (Unreleased)
- Test: `test/mcp.test.ts` (the existing "lists the same tools…" test checks `getInstructions()`)

**Interfaces:**
- Consumes: the `approvedBy` and `note` inputs of `approve_requirement` from Task 1.

- [ ] **Step 1: Write the failing test.** Add a test next to the existing `getInstructions` assertion:

```ts
it("tells agents how to plan work with requirements", async () => {
  const text = (await connect()).getInstructions()!;
  for (const phrase of ["When you plan work", "New need", "Change", "Fix", "before writing code", "REQ ids", "approvedBy"]) {
    expect(text).toContain(phrase);
  }
});
```

- [ ] **Step 2: Run it and check it fails**

Run: `npx vitest run test/mcp.test.ts -t "plan work"`
Expected: FAIL.

- [ ] **Step 3: Add a "When you plan work" block to `INSTRUCTIONS`**, after "How to work". It covers, in this
  order, in the server's existing terse style:

1. **Classify the task before you plan it.**
   - **New need:** something users can't do today, e.g. "Let's add a feature to book appointments".
   - **Change:** existing behaviour that should work differently.
   - **Fix:** restores intended behaviour, e.g. "This path is broken, fix it". Refactors and dependency bumps
     count as fixes.
   - If unsure, `search_items` for related requirements first.
2. **State the call in one line of the plan**, e.g. "New need: adds 2 stakeholder and 4 solution requirements" or
   "Bug fix under REQ-0007; no requirement changes".
3. **New need:** the plan's first steps add stakeholder requirements, then the solution requirements that fulfil
   them, before writing code.
4. **Change:**
   - update the requirement if it's a draft (`update_item`);
   - if it's approved, add a new one and later make the old one obsolete with `obsolete_requirement` and
     `replacedBy`.
5. **Fix:** don't write requirements. Name the requirement the fix restores when you can tell.
6. **Without a person to review the plan** (an autonomous workflow), follow your own call. The one-line call stays
   in the plan as the record.
7. **When the workflow creates tickets or user stories:**
   - use the solution requirements, and the stakeholder stories they fulfil, as a source;
   - put the REQ ids and each requirement's file path in the ticket;
   - by default, one ticket per solution requirement.
8. **Approval given outside Groundwork** (e.g. verbally by a PM): record it with `approve_requirement`, passing
   `approvedBy` and a `note`. Only do it when the user tells you who approved it.

- [ ] **Step 4: Run the test and check it passes**

Run: `npx vitest run test/mcp.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Mirror the guidance in `skills/groundwork/SKILL.md`**
- Add a `## When you plan work` section after "Requirements in two layers". Same content, written for a reader:
  the three kinds with the two examples, the one-line call, what to do for each kind, and tickets from
  requirements.
- In the "When to reach for it" table, add a row: *Planning a task (plan mode, a written plan, an autonomous
  workflow)* → *Classify it as new need, change or fix, and state that in the plan; for a new need or change,
  record requirements before code.*
- In Rules, add one line about recording verbal approvals with `approvedBy` only when the user names the approver.

- [ ] **Step 6: Add a short "Planning with Groundwork" paragraph to `README.md`** under "Requirements in two
  layers". It uses the two examples and the one-line plan call.

- [ ] **Step 7: Add the CHANGELOG entries under "Unreleased"**
- Agents classify planned work as new need, change or fix, record requirements before code, and build tickets
  from requirements.
- `approve_requirement` can record an approval given outside Groundwork (`approvedBy`, `note`; stored with
  `recordedBy`).

- [ ] **Step 8: Run the full suite, the typecheck and the build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/mcp/server.ts skills/groundwork/SKILL.md README.md CHANGELOG.md test/mcp.test.ts
git commit -m "Guide agents to classify planned work and record requirements before code"
```

### Task 3: Check the guidance with a real agent

This checks behaviour, not code. It's the reason guidance goes first.

- [ ] **Step 1: Set up a scratch project**
- Make a folder outside the repo with a `groundwork/config.yml`: product "Clinicare Web Application", areas
  Scheduling and Medical Records, and people `pm` (owner) and `dev` (editor).
- Point Claude Code at the locally built server: `claude mcp add groundwork -- node <repo>/dist/mcp.js`.
- Copy `skills/groundwork/SKILL.md` into the scratch project's `.claude/skills/groundwork/`.
- [ ] **Step 2: Run three prompts in plan mode**, each in a new session:
  1. "Let's add a feature to book appointments";
  2. "This path is broken, fix it: /patients/:id returns 500";
  3. "Booking slots should be 15 minutes, not 30".
- [ ] **Step 3: Check the plans.** Expected:
  - prompt 1's plan starts with a "New need: …" line, and its first steps add requirements;
  - prompt 2 says "fix" and plans no requirements;
  - prompt 3 says "change" and plans to update or replace a requirement.

  Write the three plan lines and any misjudgements into the PR description. A misjudgement means tightening the
  wording in Task 2, not adding code.
- [ ] **Step 4: Open the PR** against `main` (after #8 merges), with the Task 3 findings in the description.
