---
name: groundwork-write-requirement
description: Use when writing stakeholder or solution requirements in Groundwork — from a finding, from a hypothesis the team is confident in or has rated "Build it now", or from a decision made elsewhere (tender, regulation, contract, customer need). Writes stakeholder requirements as user stories and solution requirements as "The system shall …" statements, links every solution requirement to the stakeholder requirements it fulfils, checks existing requirements for duplicates and conflicts, and asks the user what to do about each before saving.
---

<!-- Generated from src/lib/ai/skills/write-requirement.ts by `npm run skills:build`. Don't edit by hand. -->

# Write requirements in Groundwork

Groundwork keeps two layers of requirements: stakeholder requirements (user stories) and solution requirements (shall statements). Write both, stakeholder first, so every solution requirement can point at the needs it fulfils.

## Stakeholder requirements

A STAKEHOLDER requirement states what a group of stakeholders needs, in their own terms.
- Write it as a user story: "As a [stakeholder], I want [need], so that [benefit]." Example: "As a medical secretary, I want to see when each practitioner is available, so that I can book patients quickly."
- It holds no solution: no screens, buttons, integrations or technology.
- Name who has the need (a role or group, never a person's name).
- Add 1-2 measures that tell when the need is met.
- Give it a MoSCoW priority: must, should or could.

## Solution requirements

A SOLUTION requirement states one capability or quality the system must have to fulfil one or more stakeholder requirements.
- Write it as exactly one shall statement: "The system shall [capability or quality] [to/so that purpose, or under which condition]." Examples:
  - "The system shall provide a view for medical secretaries to view calendars of practitioners to enable them to find available slots easily."
  - "The system shall show booked and free time slots of each practitioner's calendar in a visually distinctive way using colors."
- One requirement per shall statement: two capabilities are two solution requirements.
- It is verifiable and has one interpretation: no "TBD", no placeholders, no "etc.", no "and/or".
- Give it 1-3 verification criteria, each a pass/fail check a tester can run.
- Give it a MoSCoW priority: must, should or could.
- Consider safety, compliance and user trust where they matter.

## How they link

Stakeholder and solution requirements are always linked.
- Every solution requirement fulfils at least one stakeholder requirement, and says which.
- One stakeholder requirement can be fulfilled by one or more solution requirements.
- Write the stakeholder requirements first, so solution requirements have something to fulfil. If no existing stakeholder requirement fits, write a new one.
- A stakeholder requirement that no solution requirement fulfils yet is incomplete: say so.

## What a requirement rests on

Every requirement rests on one of:
- findings: what an experiment or research taught the team,
- a committed hypothesis: the team is confident enough in a hypothesis to build it without an experiment (it is then marked high confidence), or
- an origin: a tender, regulation, contract or a widely raised customer need, decided outside discovery.

## Check for duplicates and conflicts before saving

Before new requirements are saved, compare each one with the existing requirements of the same kind (stakeholder with stakeholder, solution with solution).
- A DUPLICATE asks for substantially the same need or capability, even in other words.
- A CONFLICT cannot be true at the same time as the new one (e.g. one says invoices send automatically, the other says a manager must approve them first).
- Requirements that are merely in the same area are neither. Most new requirements have no overlap.
- Obsolete requirements don't count.

## When something overlaps: ask

When a new requirement duplicates or conflicts with an existing one, never decide on the user's behalf. Show both, say in one sentence what overlaps or contradicts, and ask which of these to do:
- Replace: the new one becomes the truth. An approved existing requirement is made obsolete by the new one; an existing draft is updated in place.
- Reuse: keep the existing requirement, drop the new one, and add the new evidence to the existing one.
- Reshape: rewrite the new one so it keeps only what the existing ones don't already capture, and no longer contradicts them.

## Scope

New requirements are always saved as drafts. Approving them, making requirements obsolete without being asked, and creating tickets for them in the team's tracker are separate steps the user takes.

## With the Groundwork MCP tools

**From a hypothesis the user is confident in** (no experiment needed; also when it sits in the "Build it now" quadrant):
1. `get_item` the hypothesis, and the insights it links to.
2. Draft 1-2 stakeholder requirements and 2-3 solution requirements from its statement, success metric, guardrail and evidence.
3. `search_items` with kind `requirement` for each draft's key words, and read the close matches with `get_item`.
4. If any draft duplicates or conflicts with an existing requirement, show the user the pairs and ask: replace, reuse or reshape. Wait for an answer for each.
5. `add_requirements` with `hypothesisIds: [<hypothesis id>]`: first the stakeholder ones, then, in a second call, the solution ones with `stakeholderIds` set to the ids the first call returned (or to existing stakeholder requirements they fulfil). A solution requirement without `stakeholderIds` is refused. Groundwork marks the hypothesis as committed with high confidence.
   - Replace: `obsolete_requirement` (approved) or `update_item` (draft) on the existing one.
   - Reuse: don't add the draft; `link_items` the existing requirement to the hypothesis instead.
6. Share each requirement's `url`.

**From a finding:** the same, with `findingIds` instead of `hypothesisIds`.
**Decided elsewhere:** the same, with an `origin` (tender, regulation, contract, customer-need) and an `originNote`.
