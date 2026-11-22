# Groundwork file format, version 1

This is the contract between your files, the `groundwork` tools and anything else that reads them, including the Groundwork web app's importer. Everything lives in one folder, `groundwork/`, at the root of your project.

```
groundwork/
  config.yml
  insights/INS-0001-setup-takes-too-long.md
  hypotheses/HYP-0001-guided-import.md
  experiments/EXP-0001-guided-import-pilot.md
  findings/FND-0001-guided-import-lifts-activation.md
  requirements/REQ-0001-guided-csv-import.md
```

## Items

Each item is one Markdown file: YAML frontmatter between `---` lines, then an optional body.

```markdown
---
id: INS-0001
title: Setup takes too long
quote: I gave up on the import after twenty minutes.
source: interview
persona: Ops lead
participant: P07
tags: [onboarding]
sentiment: negative
productArea: onboarding
createdAt: 2026-11-18T10:00:00.000Z
createdBy: sam
---

Anything you write here is yours. Groundwork reads it as the item's `notes` and never rewrites it.
```

- **Ids** are a kind prefix and a number of at least four digits: `INS`, `HYP`, `EXP`, `FND`, `REQ`. They never change, and an id is never reused within its kind. New items get one more than the highest id of their kind. Two branches can therefore give the same id to different items. The same id at a different file path is a different item. `groundwork validate --against <base>` reports this, and `groundwork renumber --against <base>` fixes it on the branch: the branch's item gets the next free id, its file is renamed (the slug stays), and links to it are rewritten in the files the branch added or changed. Ids on the base never change, and Markdown bodies are never rewritten.
- **File names** are `<id>-<slug>.md`. Only the id matters; the slug comes from the title at creation and stays when the title changes, so links to the file don't break. A file has to be in the folder for its kind.
- **Links** are lists of ids in fields such as `insightIds`. They point from an item to the evidence it builds on.
- **Unknown fields** are kept. Tools may add fields in later versions.
- **Times** are ISO 8601 strings. **People** are ids from `config.yml`.

### Fields by kind

Required fields are in bold.

**Insight** (`insights/`, `INS-`): evidence from a real person.
**`title`**, **`quote`** (what they said or did, verbatim), **`source`** (`interview` | `support` | `survey` | `analytics` | `observation`), **`persona`** (a role, never a name), `participant` (a reference such as P07), `tags`, `sentiment` (`negative` | `neutral` | `positive`), `productArea`, `createdAt`, `createdBy`.

**Hypothesis** (`hypotheses/`, `HYP-`): "We believe we will [outcome] if [forWhom] get [benefit] with [feature]."
**`title`**, **`outcome`**, **`forWhom`**, **`benefit`**, **`feature`**, **`status`** (`draft` | `testing` | `validated` | `invalidated`), `insightIds`, `successMetric` (`name`, `unit`, `baseline`, `target`, `direction`: `increase` | `decrease`, `timeframe`), `guardrail`, `knowWhen`, `alternatives`, `edge`, `riskiestAssumption`, `confidence` (0–100), `priority`, `productArea`, `owner`, `createdAt`, `updatedAt`.

**Experiment** (`experiments/`, `EXP-`): tests exactly one hypothesis.
**`title`**, **`hypothesisId`**, **`method`** (`pilot` | `ab-test` | `prototype-test` | `survey` | `fake-door` | `concierge`), **`description`**, **`primaryMetric`** (`name`, `unit`, `baseline`, `target`, `direction`, and `actual` once measured), **`status`** (`planned` | `running` | `completed`), `guardrails` (metrics that must not get worse), `sampleSize`, `durationWeeks`, `startDate`, `endDate`, `resultNotes`, `verdict` (`validated` | `invalidated` | `inconclusive`), `checkBackDate`, `owner`.

**Finding** (`findings/`, `FND-`): what was learned.
**`title`**, **`summary`**, `experimentIds`, `hypothesisIds`, `insightIds`, `confidence` (`low` | `medium` | `high`), `productArea`, `createdAt`.

**Requirement** (`requirements/`, `REQ-`): what is needed before building, in two layers.
**`title`**, **`kind`** (`stakeholder` | `solution`; files without it are read as `solution`), **`story`**, **`acceptanceCriteria`** (a list), **`status`** (`draft` | `awaiting-approval` | `approved` | `in-delivery` | `obsolete`), `stakeholder` (stakeholder requirements: who has the need), `stakeholderIds` (solution requirements: **required**, the stakeholder requirements it fulfils), `product` (solution requirements), `priority` (`must` | `should` | `could`), `findingIds`, `insightIds`, `hypothesisIds`, `origin` (`tender` | `regulation` | `contract` | `customer-need`) and `originNote`, `approver`, `approvedBy`, `approvedAt`, `recordedBy` (who entered an approval given by someone else), `approvalNote`, `obsoletedBy`, `obsoletedAt`, `productArea`, `createdAt`, `updatedAt`.

The two layers:

- A **stakeholder requirement** says who needs what and why. Its `story` is a user story: "As a medical secretary I want a view of the calendars of all practitioners in the clinic with their unbooked slots highlighted so that I can find them and book appointments easily."
- A **solution requirement** describes the qualities and behaviour the solution must have to meet stakeholder needs. Its `story` is one or more "shall" statements: "The appointment view used by medical secretaries shall show the calendars of the selected practitioners with the free slots highlighted. It shall be possible to click a free slot to start the booking flow. It shall be possible to add or remove practitioners in the view."
- Every active solution requirement fulfils at least one stakeholder requirement (`stakeholderIds`). A stakeholder requirement is fulfilled by one or more solution requirements.

`findingIds`, `insightIds`, `hypothesisIds` and `origin` are optional: link them when the requirement rests on evidence or comes from a tender, regulation or contract.

### Links

| From | Field | To |
|---|---|---|
| hypothesis | `insightIds` | insights |
| experiment | `hypothesisId` | one hypothesis |
| finding | `experimentIds`, `hypothesisIds`, `insightIds` | experiments, hypotheses, insights |
| requirement | `findingIds`, `insightIds`, `hypothesisIds` | findings, insights, hypotheses |
| solution requirement | `stakeholderIds` | stakeholder requirements |
| requirement | `obsoletedBy` | the requirements that replaced it |

### Rules the tools apply

These rules live in the core library, so every Groundwork tool applies them the same way.

- Starting an experiment moves a `draft` hypothesis to `testing`.
- Recording results computes the verdict. It is **validated** when the primary metric reaches its target (`actual >= target` for `increase`, `<=` for `decrease`) and every guardrail holds. It is **invalidated** when either fails. The hypothesis moves to the same status.
- New hypotheses, findings and requirements without a `productArea` take the most common one among their linked evidence.
- A solution requirement can't be saved without at least one stakeholder requirement in `stakeholderIds`, and a stakeholder requirement can't have any. A stakeholder requirement can't be deleted while it is the only one a solution requirement fulfils. `validate` reports an active solution requirement without stakeholder links as an error.
- `validate` warns about an active stakeholder requirement that no solution requirement fulfils yet, and about a `story` that doesn't fit its layer: a stakeholder story without "As a … I want … so that …", or a solution requirement without "shall". The tools save these and return the same warnings.
- An approval given outside Groundwork (e.g. verbally) can be recorded with `approvedBy` and an optional note; the person recording it is stored as `recordedBy`.
- Requirements go from `draft` to `awaiting-approval` (with an `approver`) to `approved`. The approver can send one back to `draft`. Only `approved` requirements can become `obsolete`.
- Deleting an item removes links to it. Deleting a hypothesis also deletes its experiments.

## config.yml

```yaml
schemaVersion: 1
name: Acme
productAreas:
  - id: onboarding
    label: Onboarding
products:
  - Acme app
people:
  - id: sam            # used in createdBy, owner, approver
    name: Sam
    role: owner        # owner | editor | viewer
    email: sam@acme.example   # optional: matched against `git config user.email`
migrated: https://…    # set by the web app importer; local writes stop
```

`add_product_areas` and `add_products` append to `productAreas` and `products`. They skip entries already there (matched by label or name, ignoring case) and never rename, reorder or remove anything. Area ids are made from the label unless given. Rename or remove by editing the file.

The person acting is `$GROUNDWORK_USER` (a person id). Otherwise it's the person whose `email` matches git's, or the only person listed. If none of those apply, it's `me`.

## Versioning

`schemaVersion` changes only for changes that would break older readers. Tools refuse to write a version newer than they understand. Adding optional fields doesn't change the version.
