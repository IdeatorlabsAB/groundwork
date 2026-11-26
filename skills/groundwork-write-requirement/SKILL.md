---
name: groundwork-write-requirement
description: Use when writing stakeholder or solution requirements in Groundwork — from a finding, from a hypothesis the team is confident in, or from a decision made elsewhere (tender, regulation, contract, customer need) — and when the team brings requirements it already has (documents, tender texts, tickets, spreadsheets) to rewrite as Groundwork requirements. Writes stakeholder requirements as user stories and solution requirements as "The system shall …" statements, links every solution requirement to the stakeholder requirements it fulfils, checks existing requirements for duplicates and conflicts, and asks the user what to do about each before saving.
---

<!-- Ported from centropic-prototype src/lib/ai/skills/write-requirement.ts. The rules are the web app's; the recipes use the local tools. Keep the two in step. -->

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
- a committed hypothesis: the team is confident enough in a hypothesis to build it without an experiment, or
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

Reshape a new requirement so it captures only what the existing ones don't already cover, and no longer contradicts them. Keep its wording and its format (a user story for a stakeholder requirement, one "The system shall ..." statement for a solution requirement) where you can. Drop criteria that are already covered. If nothing new remains, say so.

## Scope

New requirements are saved as drafts. Approving them is a person's decision, and so are making requirements obsolete without being asked and creating tickets for them in the team's tracker. The one exception: when the user tells you a requirement was already approved, and by whom, you record that approval (see step 6 below).

## With the Groundwork tools

**From a hypothesis the team is confident in** (no experiment needed):
1. `get_item` the hypothesis, and the insights it links to.
2. Draft 1-2 stakeholder requirements and 2-3 solution requirements from its statement, success metric, guardrail and evidence.
3. `search_items` with kind `requirement` for each draft's key words, and read the close matches with `get_item`.
4. If any draft duplicates or conflicts with an existing requirement, show the user the pairs and ask: replace, reuse or reshape. Wait for an answer for each.
5. `add_requirements` with `hypothesisIds` set to the hypothesis: first the stakeholder ones, then, in a second call, the solution ones with `stakeholderIds` set to the ids the first call returned (or to existing stakeholder requirements they fulfil). A solution requirement without `stakeholderIds` is refused. When there's more than one product, set `product` on each solution requirement.
   - Replace: an approved existing one is replaced by adding the new one with `replaces` naming it (it becomes obsolete when the new one ships); a draft is updated in place with `update_item`.
   - Reuse: don't add the draft; `link_items` the existing requirement to the hypothesis instead.
6. Mention each requirement's file, so the user can open it.

**From a finding:** the same, with `findingIds` instead of `hypothesisIds`.
**Decided elsewhere:** the same, with an `origin` (tender, regulation, contract, customer-need) and an `originNote` saying where, e.g. "Region North tender 2026, §4.2".

## Bring in requirements the team already has

Teams often have requirements already: a tender or contract, a spec in Word or PDF, an Excel sheet, a backlog in Jira or Linear. Rewrite them in Groundwork's two layers, traceable back to where they came from, and record them once the team agrees.

1. **Read the source** with the tools you have. A PDF reads in page ranges (about 20 pages at a time). Convert a .docx to text first (`textutil -convert txt` on macOS, or `pandoc`). Parse a CSV export with a short script rather than by eye: its fields often span lines. A connected tracker can be read with its own tools.
2. **Inventory first.** Before rewriting anything, list the source's items: its own reference (section, row or ticket key), a one-line summary, and whether it states a need, a behaviour, or isn't a product requirement at all. Clauses about the bidder or supplier ("The supplier shall provide three references") are not product requirements. Show the inventory and let the user drop what doesn't belong. For a long source, inventory one chapter or about 50 rows at a time.
3. **Place each item.** `get_workspace` for the products and areas. Propose a product area for each item; offer to add missing areas with `add_product_areas`.
4. **Rewrite, about 20 items at a time.** For each source item, propose:
   - a stakeholder story when it states a need;
   - one or more shall statements when it states behaviour, one capability each. Every solution requirement needs a stakeholder requirement to fulfil: link an existing one that truly fits, or propose the missing story, marked "(proposed)", and ask. The same for a story's "so that …" when the source doesn't give one;
   - both, linked, when it mixes the two. "Secretaries need a calendar view showing free slots in colour" becomes the story "As a medical secretary, I want to see each practitioner's free slots, so that I can book patients quickly" and the statement "The system shall show free and booked slots of each practitioner's calendar in distinct colours", which fulfils it;
   - verification criteria from the source. Mark any you add yourself "(proposed)";
   - a priority. A tender's mandatory requirements are must, evaluated ones should;
   - an `origin` (tender, regulation, contract, customer-need) and an `originNote` with the source and the exact place: "Region North tender 2026, §4.2", "Jira ACME-142", "Requirements.xlsx, row 37".
5. **Check overlaps** against existing requirements and within the batch. Search each draft's key nouns and their synonyms ("retain records" and "keep log"), not only its exact words. Search by the source reference too, as the document's name plus the clause ("tender NW-2026-07 §4.2", not just "4.2"), one clause at a time, so an import that was interrupted resumes without duplicates. Show duplicates and conflicts with the choices above.
6. **Show the batch** as a numbered table: source ref, kind, title, statement, origin, overlaps. Offer the criteria on request rather than printing them all. Ask what to change. Record the batch only once the user agrees: `add_requirements`, stakeholder first, then solution with `stakeholderIds`. If the user says an item was already approved elsewhere, and who accepted it:
   - `approvedBy` is that person, from config.yml people (the person in your team who accepted it, not the customer), and the note names the signed document;
   - if it's the user themselves, `submit_requirement_for_approval` to them first, then `approve_requirement`;
   - if the product has planned versions, ask which one it's planned for and pass `plannedFor`, or leave it a draft.
7. **Tickets.** A source ticket for work still to do: `link_tickets` it to the solution requirements it becomes, without `done`. A ticket that's already done describes what the product does today, so it isn't a new draft. In a product with no releases yet it belongs in a baseline (`record_baseline`, which needs its own version). In a product that already has releases, ask the user which released version it shipped in, or whether to leave it out. A ticket that becomes only a stakeholder story isn't linked; its key is in the `originNote`.
8. **Report** what you recorded (ids and files), what you skipped and why, and the open questions: items that were unclear, or contradicted each other. A clause you reused (it duplicated an existing requirement) isn't recorded anywhere by the tools: list it in the report as "§4.3 → REQ-0002", and offer to note it under the existing requirement's Markdown body, which is the user's own. Then carry on with the next batch.

**Never** record before the team agrees, drop a source item without saying so, put people's names in stories, invent a source reference, or guess at an item that's unclear. Ask instead.
