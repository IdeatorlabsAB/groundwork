# Product catalogue, releases, tickets and requirement-aware agent workflows

## Why

Groundwork should be where a development team keeps the *why* behind what it builds and how. Requirements are
written before building, in two layers (stakeholder user stories, solution "shall" statements, shipped in 0.4 /
PR #8). The next step is to tie requirements to the product they describe, to the releases that ship them and to
the tickets that implement them. Agents should also do this as a normal part of planning work.

The longer-term driver is regulated work, such as EU MDR technical documentation. A team has to show, per product
release, which requirements were introduced and which were made obsolete. Later it has to show traceability from
requirement to implementation, tests and risks. This design builds the foundation for that, not the full matrix.

## Goals

1. **Product catalogue in the repo.** A team keeps its product structure next to the code. Example: product
   *Clinicare Web Application*, with areas *Settings and configuration, Scheduling, Prescriptions, Medical Records,
   Patient Data Protection*, and a list of versions.
2. **Requirements attributed to product versions.** A solution requirement records the version it's planned for,
   the version it was released in and, if replaced or removed, the version that made it obsolete. Together these
   give the range of versions it's valid for.
3. **Release lifecycle.**
   - Approving a solution requirement puts it in a *planned* version.
   - It becomes part of a *released* version when the solution that fulfils it ships.
   - Releasing works with tracker automation (the agent reads ticket status) or as a manual step (a person says
     what shipped), for teams without automation.
4. **Release report.** For a product version, list the solution requirements it introduced and the ones it made
   obsolete, with their tickets and the stakeholder requirements they fulfil.
5. **Tickets linked both ways.** A requirement records its tickets (tracker, key, URL), and a ticket created from
   requirements names its REQ ids and links back. This works with any tracker.
6. **Requirement-aware agent workflows (guidance only).** When planning a task (Claude Code plan mode, Codex or an
   autonomous workflow), the agent judges what kind of task it is:
   - a **new need**: write stakeholder and solution requirements before building;
   - a **change** to existing behaviour: update the requirement, or replace it if it's approved;
   - a **fix** (or refactor): no requirement changes, but name the requirement it restores when that's clear.

   The agent states this call in one line of the plan. When the workflow creates tickets or user stories, it uses
   solution requirements as a source, puts the REQ ids in each ticket, and records the tickets in Groundwork.

## Non-goals

- Test cases, risks (ISO 14971) and traceability matrices. These are later work, but this design must not get in
  their way: products, versions and tickets need stable ids that tests and risks can link to.
- Groundwork calling tracker APIs (Linear, Jira, GitHub) itself. The agent uses whatever tracker tool the workflow
  has and tells Groundwork the result.
- Claude Code hooks that force the requirements step. Guidance only, for now.
- Versioning stakeholder requirements. Only solution requirements belong to releases. A stakeholder requirement's
  release state is derived from the solution requirements that fulfil it.
- Changes to the Groundwork web app. `groundwork import` must keep working (see Constraints), but the web app
  learning about products, versions and tickets is separate work.

## Anti-goals

- A requirement shown as obsolete while released software still behaves that way. Today a requirement becomes
  obsolete as soon as its replacement is approved. For MDR it must stay valid until the replacement ships.
- A release record that can be quietly changed afterwards. Once a version is released, its contents change only
  through an explicit, recorded action.
- Agents writing requirements for bug fixes and refactors, which fills Groundwork with noise.
- Two sources of truth for stakeholder progress, such as a hand-set "fulfilled in" that disagrees with its solution
  requirements.

## Constraints

- Plain files in git, reviewable in pull requests. No server and no account.
- `Collections` (`src/core/collections.ts`) and the core ops are shared with the hosted web app. New collections
  and fields must follow the same patterns, and stay additive and optional, so the web app can adopt them later.
- Existing projects keep loading. A `config.yml` with flat `productAreas` and `products` lists, and requirements
  with a free-text `product`, must still validate, with a migration path.
- `groundwork import` has to keep working for projects that use the new features. It may ignore what the web app
  can't take yet, but it must say so.
- Unknown fields are kept (SPEC rule). Users' Markdown bodies are never rewritten.

## Approaches

Three were considered.

- **A. Everything in `config.yml`, with release fields on each requirement.** Smallest change. But a release has no
  single record of who released it and when, the release report has to be assembled from many requirement files,
  and `config.yml` turns from settings into history.
- **B. Products as their own item files, with the release recorded on the version. Chosen.** Releasing a version is
  one change to the product file plus the requirement files it touches, so it shows up as a single reviewable
  diff. The product catalogue gets stable ids that tests, risks and matrices can link to later. The cost is a new
  item kind and a `config.yml` migration.
- **C. Work out releases from git tags.** No bookkeeping, but a tag only shows when a file appeared, not when the
  solution shipped. A requirement written in March for the June release would land in the wrong version. Dropped.

For the agent workflow: **guidance only** (skill plus server instructions), chosen because it works in every agent
and workflow. A Claude Code hook that checks plans was considered and deferred until guidance proves insufficient.

## Design

### Product files

The new kind is `product`, prefix `PRD`, stored in `groundwork/products/PRD-0001-clinicare-web-application.md`. It
follows the existing item-file rules (frontmatter, id, slug, the body is the user's notes).

```yaml
id: PRD-0001
title: Clinicare Web Application
areas:
  - { id: scheduling, label: Scheduling }
  - { id: prescriptions, label: Prescriptions }
  - { id: patient-data-protection, label: Patient Data Protection }
versions:
  - { version: "2.3", status: released, releasedAt: 2026-09-30T…, releasedBy: sam }
  - { version: "2.4", status: planned, plannedFor: 2026-12-15 }   # target date, optional
```

- Versions are strings in the order listed. The list order is the product's version order. No semver parsing.
- A version has a status: `planned`, then `released`. `released` is set only by the release action, which records
  `releasedAt` and `releasedBy`.
- Areas move from `config.yml` into their product. Item `productArea` fields keep referring to area ids.

### Requirement fields (solution requirements only)

| Field | Meaning |
|---|---|
| `product` | the product id (`PRD-0001`). Was free text: a name matching a product title is accepted and resolved on write |
| `plannedFor` | the planned version it's meant to ship in |
| `releasedIn` | the version it shipped in (set by the release action) |
| `obsoletedIn` | the version that made it obsolete (set by the release action) |
| `obsoletePlannedFor` | the planned version that will make it obsolete (replacement or removal) |
| `tickets` | `[{ tracker, key, url?, title?, state?, syncedAt? }]`, e.g. `{ tracker: linear, key: CLN-142 }` |

Status still drives the approval flow (`draft` → `awaiting-approval` → `approved` → `obsolete`). Being released is
shown by `releasedIn`, not by a new status, so approval and release stay independent and existing tooling keeps
working.

Rules:

- **Approval plans it.** `approve_requirement` on a solution requirement takes `plannedFor` (a planned version of
  its product). It's required when the product has at least one planned version.
- **Obsolete waits for the release.** Approving a requirement that replaces another, or calling
  `obsolete_requirement` with a version, sets `obsoletePlannedFor` on the old one. It stays approved and valid
  until that version is released. At release it gets `status: obsolete` and `obsoletedIn`.
  - The immediate form, with no version, stays for requirements that never shipped.
- **Stakeholder requirements are derived.** For each version: how many of its solution requirements are released,
  and the version in which the last one shipped ("fully met in 2.6"). Nothing is stored on the stakeholder
  requirement.

### Releasing

- **`get_release(product, version)`** returns the requirements planned to ship in it, the ones planned to become
  obsolete in it, and their tickets with the last known `state`. The agent can refresh ticket state through its
  tracker tool and record it with `update_tickets`, then call it again.
- **`release_version(product, version, shipped: REQ ids, moveTo?: version)`**:
  - marks the version released (`releasedAt`, `releasedBy` = the acting person);
  - sets `releasedIn` on the shipped requirements;
  - applies planned obsolescence for that version;
  - moves the requirements planned for it but not shipped to `moveTo`, which is required if any are left over;
  - returns the release report.

  In the automated flow, the agent proposes `shipped` from ticket states (all tickets done). In the manual flow, a
  person lists them. Both go through the same call.
- **`release_requirements(ids, version)`** marks individual requirements shipped in an already released version,
  for teams that ship continuously. It's recorded with who and when.
- **Who:** owners and editors in `config.yml`. Viewers can't release.
- **CLI:**
  - `groundwork release <product> <version> --shipped REQ-0012,REQ-0014 [--move-rest 2.5]` does the release;
  - `groundwork report release <product> <version>` prints the release report as Markdown, for compliance
    documents.

### Release report

Per product version, it lists:

- **Introduced:** solution requirements with `releasedIn` = this version, each with its tickets and the stakeholder
  requirements it fulfils.
- **Made obsolete:** requirements with `obsoletedIn` = this version, each with what replaced it.
- **Stakeholder requirements:** fully met in this version, or partly met (n of m released).

### Tickets

- **`link_tickets(requirementIds, ticket)`** records one ticket against one or more requirements. A ticket can
  cover several requirements, and a requirement can have several tickets.
- **`update_tickets([{ tracker, key, state }])`** refreshes ticket state everywhere that ticket appears.
- The existing single-Linear `delivery` field stays readable. On load it's also shown as a ticket, so nothing is
  lost.

### Tools and validation

- `add_products` now creates product files. `add_product_areas` takes a product. A new `add_product_versions` adds
  planned versions. `get_workspace` returns the catalogue.
- `validate` checks:
  - **Errors:** `product` refers to an existing product; `plannedFor`, `releasedIn` and `obsoletedIn` refer to that
    product's versions; `releasedIn` points to a released version; an approved solution requirement in a product
    with planned versions has `plannedFor`.
  - **Warnings:** a requirement planned for a version that's already released and not shipped in it.

### Migration

- On first write, the flat `config.yml` lists produce product files: each product name becomes a product, and the
  areas go to the single product if there is one.
- Requirement `product` names are resolved to ids. `config.yml` keeps `name` and `people`, and gets
  `schemaVersion: 2`.
- `groundwork migrate --dry-run` shows what would happen.
- The import bundle keeps sending `productAreas` and `products` (names) as before, so the current web app keeps
  working. Product files, versions and tickets are reported as "not imported yet".

### Agent workflow guidance

The skill (`skills/groundwork/SKILL.md`) and the server `INSTRUCTIONS` get a "When you plan work" section:

1. **Classify the task** as new need, change, fix or none, and state it in one line of the plan, e.g. *"New need:
   adds 2 stakeholder and 4 solution requirements"* or *"Bug fix under REQ-0007; no requirement changes"*.
   Examples: "Let's add a feature to book appointments" is a new need. "This path is broken, fix it" is a fix.
2. **New need or change:** the plan's first steps write or update requirements (stakeholder stories first, then
   "shall" statements linked to them, attributed to the product and planned version), before any code.
   - When a person is in the loop, they see this in the plan and can overrule it.
   - In an autonomous workflow, the agent follows its own call.
3. **When the workflow creates tickets or user stories,** use the solution requirements (and their stakeholder
   stories) as a source:
   - put the REQ ids and a link to each requirement file in the ticket;
   - afterwards call `link_tickets`;
   - one ticket per solution requirement is the default, and grouping is fine.
4. **When work ships,** offer to update ticket states, or to run the release step.

## Decided in conversation

- An agent judges whether a task is a new requirement. The two example cases above are the user's.
- The extra cases (change to existing behaviour, a fix that restores a requirement) and the one-line call in the
  plan were Claude's proposals; the user agreed.
- Tickets are linked both ways, to make traceability reports easier.
- MDR needs, per release, what was introduced and what was made obsolete.
- Product catalogue: product, then areas, then versions, maintained in the repo.
- A requirement joins a planned release when approved, and a released version when its solution ships.
- Manual release marking for teams without automation.
- Only solution requirements belong to releases. Stakeholder requirements are identified through the solution
  requirements' links.
- Approach B, with guidance only.

## Claude's calls (correct if wrong)

- Version order is list order, with no semver.
- A new `product` item kind, rather than extending `config.yml`.
- Release state is a field (`releasedIn`), not a new requirement status.
- Requirements planned but not shipped must be moved to another version at release time, not dropped silently.
- `obsolete_requirement` without a version stays, for requirements that never shipped.
- Tracker-agnostic tickets, and the old `delivery` field is kept readable.
- Owners and editors can release.
- The CLI gets `release`, `report release` and `migrate`.

### Settled after the builder check (Claude's calls)

- **Obsolescence follows its replacement.**
  - A requirement being replaced becomes obsolete in the version where its replacement ships. If the replacement
    is moved to a later version at release, the old requirement's `obsoletePlannedFor` moves with it.
  - A removal without a replacement is confirmed at release like a shipped requirement: `release_version` takes
    `removed: REQ ids`. Planned removals that aren't confirmed move to `moveTo`.
- **`replaces` field.**
  - A new requirement names what it replaces with `replaces: [REQ ids]`, which can be set while it's still a
    draft.
  - On approval, the old ones get `obsoletePlannedFor`. At release they get `obsoletedBy`, `obsoletedIn` and
    `status: obsolete`.
  - The derive-from-findings path (`applyRequirementChanges`) uses the same planned obsolescence when the product
    has versions. With no versions it works as today.
- **`in-delivery` stays.** The web app uses it, so it's kept unchanged. For planning, release and obsolescence it's
  treated like `approved`. `link_tickets` doesn't change status.
- **Who and when, per requirement.**
  - Each release action stores `releasedAt` and `releasedBy` on the requirement, and `obsoletedAt` and
    `obsoletedBy` (person) on obsolete ones, not only on the version. Git history is a second record, but squashed
    merges can lose it, so it isn't the only one.
  - `update_item` can't change `plannedFor`, `releasedIn`, `obsoletedIn`, `releasedAt` or `releasedBy`. These
    change only through the planning and release tools. `validate` errors when `releasedIn` points to a version
    that isn't released.
- **Migration is explicit.**
  - Old-style `config.yml` (flat lists) keeps working read-only as a catalogue: each product name is a product
    with no versions, and the areas are shared. Version and release features ask the user to run
    `groundwork migrate` first. Nothing migrates as a side effect of another write.
  - `migrate` writes product files and sets `schemaVersion: 2`. Older `groundwork-mcp` installs will then refuse
    the folder with the existing "update groundwork-mcp" message. That's intended, and it goes in the CHANGELOG.
  - The import bundle keeps its current shape (area and product names), so the web app importer is unaffected.
- **A version's permanent key is `(product id, version string)`.** A version string can't be renamed once
  anything refers to it. `validate` errors on a reference to a missing version.

### Answered by the user after the builder check

- **A released version can be corrected**, through an explicit step:
  - `correct_release(product, version, add?: REQ ids, remove?: REQ ids, reason)`, and on the CLI
    `groundwork release <product> <version> --correct … --reason "…"`.
  - A correction can add a requirement to the release, take one out (it goes back to planned, to a version given
    in the call), or do the same for obsolescence.
  - Each correction is stored on the version as `corrections: [{ at, by, reason, added, removed }]`. The reason is
    required.
  - The release report shows the corrections in their own section, never silently merged in.
- **One repo usually holds one product.** The design is built around a single product, which needs nothing extra.
  Several products are allowed, but area ids must be unique across all products in the repo (`validate` errors on
  a duplicate). That way an insight's, hypothesis's or finding's `productArea` always points to exactly one
  product, and those items don't get a product field. With one product, `add_product_areas` doesn't need a
  product argument.

### Added after the developer review

- **Ids stay safe across branches.**
  - The problem: new items are numbered "highest + 1", so two branches can both create `REQ-0012`, and it only
    shows at merge.
  - The fix keeps readable ids, which compliance documents need, and resolves clashes on the branch, before merge:
    - `groundwork validate --against <base>` (e.g. `origin/main`) errors when an id the branch adds is also used
      by a different item on the base branch.
    - `groundwork renumber --against <base>` gives the branch's clashing new items the next free ids. It renames
      their files and rewrites every reference to them in files the branch added or changed.
  - The CI example in the README runs `validate --against origin/${{ github.base_ref }}`, and its error message
    says to run `renumber`. The skill tells agents to run `renumber` when they see that error.
  - Ids that already exist on the base branch are never renumbered.
- **Approvals recorded on someone's behalf. Decided: no pull-request-backed sign-off.**
  - Approval often happens verbally: a PM approves, and the developer records it. Today `approve_requirement`
    refuses unless the acting person is the named approver.
  - `approve_requirement` gets an optional `approvedBy` (a person in `config.yml`) and `note` (e.g. "Approved by
    Maria in sprint planning, 2026-11-20").
  - When the person recording isn't the approver, Groundwork stores `approvedBy` (the approver), `recordedBy` (who
    entered it) and `approvalNote`. The record stays honest without a heavier approval process.
  - Viewers still can't record approvals.
- **Build order: agent guidance first.** It's cheap and mostly works with what exists today, and it shows early
  whether agents judge "new need / change / fix" well.

## Left to the builder

- Exact tool input shapes, error wording, and how `get_release` and the report are formatted.
- Splitting the work into PRs. Order:
  1. agent guidance, using the features that exist, including approval on someone's behalf;
  2. branch-safe ids;
  3. catalogue and migration;
  4. versions on requirements and the obsolete-at-release change;
  5. release tools, report and CLI;
  6. tickets.

  The guidance gains version, release and ticket wording as each later part lands.
- Whether trace output (`groundwork trace`) shows versions and tickets.
