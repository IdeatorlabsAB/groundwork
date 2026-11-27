# Groundwork

**Traceability for software built with agents, kept in your repository.**

Your coding agent writes the code. Groundwork has it also keep the record of why the code exists and how you know it works. Before it builds, it records the requirements. While it builds, it records the risks, the tickets, the code and the tests that verify each requirement. Before a version ships, Groundwork checks the chain end to end and signs the release off in a frozen report.

```
why ──▶ requirements ──▶ tickets ──▶ code ──▶ tests ──▶ risks ──▶ CI results ──▶ release report
```

Everything is plain Markdown and JSON in a `groundwork/` folder next to your code, written through an MCP server any agent can use (Claude Code, Codex, …).

- **No account, no server, no API keys.** Your agent does the thinking. Groundwork keeps the data valid, the links intact and the rules applied.
- **Reviewable like code.** Requirements, risks and release records are files: diff them, review them in pull requests, keep them as long as you need.
- **Release evidence, not just docs.** `groundwork check release` tells you what blocks a version: unmitigated high risks, unapproved requirements, tests that are missing, failing or haven't run. Releasing freezes a sign-off record and a traceability report you can hand to an auditor, e.g. for EU MDR technical documentation.
- **Built for regulated teams, useful for any team.** Medical devices, healthcare, finance: anywhere a release has to show what shipped, why, and how it was checked.
- **Grows with you.** When the team needs review inboxes, roles and PDFs, move to the [Groundwork web app](#moving-to-the-web-app) with nothing lost and every id unchanged.

## Quickstart

### Claude Code

Install the plugin. It adds the MCP server and the skills that teach Claude when to use it:

```
/plugin marketplace add IdeatorlabsAB/groundwork
/plugin install groundwork@groundwork
```

Or add only the MCP server, in your project folder:

```sh
claude mcp add groundwork -- npx -y groundwork-mcp
```

### Codex

```sh
codex mcp add groundwork -- npx -y groundwork-mcp
```

To teach Codex when to use it, copy the skills into your repository:

```sh
for s in groundwork groundwork-risk groundwork-write-requirement; do
  mkdir -p .agents/skills/$s
  curl -fsSL https://raw.githubusercontent.com/IdeatorlabsAB/groundwork/main/skills/$s/SKILL.md -o .agents/skills/$s/SKILL.md
done
```

Start `codex` in your project folder, so Groundwork finds the project.

### Then talk to your agent

> Set up Groundwork for the Clinicare web app, with areas Scheduling and Prescriptions, and a first version 1.0.
>
> Let's add a feature to book appointments. *(In plan mode, the agent writes the requirements and risks first.)*
>
> Here's our tender spec (docs/tender.pdf). Turn its requirements into Groundwork requirements.
>
> Maria approved REQ-0004 in sprint planning. Record it.
>
> What's blocking 1.0?
>
> Release 1.0.

Groundwork writes files like `groundwork/requirements/REQ-0004-book-an-appointment.md`. Commit them like any other file. [examples/acme](examples/acme) is a small sample project.

## How it works

Groundwork follows the way you already build with an agent:

1. **Plan.** Before any code, the agent decides what kind of task it is and says so in one line: *"New need: adds 2 stakeholder and 4 solution requirements, 1 risk"*, or *"Bug fix under REQ-0007; no requirement changes"*. For a new need or a change, the plan records the requirements and the risks they bring. Approving the requirements stays a person's decision.
2. **Build.** While it works, the agent records where each requirement lives in the code (`codeRefs`), the tests that verify it, and the tickets that deliver it. Before changing files, it asks `trace_code` which requirements and risks they touch.
3. **Pull request.** The PR ends with a trailer such as `Groundwork: REQ-0042, RSK-0007`. In CI, the [GitHub Action](#pull-requests-and-ci) comments with what the PR names or touches and the traceability gaps.
4. **CI results.** On your default branch, CI records the test results of linked tests in the repository, as evidence.
5. **Release.** Groundwork checks the version, and an owner signs it off. The sign-off record and its report never change afterwards.

Agents are told never to approve requirements, accept a risk or sign a release off on their own: people decide, and Groundwork records who and when. Locally, tools act as the person in `GROUNDWORK_USER` (or your git user), so make your own decisions yourself. The web app enforces it with roles.

## Requirements

Requirements come in two linked layers:

- **Stakeholder requirements** say who needs what and why, as user stories: *"As a medical secretary, I want to see when each practitioner is available, so that I can book patients quickly."*
- **Solution requirements** say what the system shall do, one capability each: *"The system shall show free and booked slots of each practitioner's calendar in distinct colours."*

Every solution requirement fulfils at least one stakeholder requirement, and Groundwork refuses one that doesn't. Each rests on something: a finding, a hypothesis the team is confident in, or an origin decided elsewhere (a tender, regulation, contract or customer need, with a note saying exactly where). Before saving, the agent checks for duplicates and conflicts and asks you what to do about each. New requirements are drafts until someone approves them.

**Versions.** Each product is a file in `groundwork/products/` with its areas and versions. An approved solution requirement is planned for a version. To change one, the agent adds a new requirement that `replaces` it. The old one stays valid until the new one ships, so Groundwork never calls something obsolete while the released product still behaves that way.

### Bring in the requirements you already have

Most teams don't start from nothing: there's a tender, a contract, a spec in Word, a spreadsheet or a Jira backlog. Give it to your agent. It lists what the source contains first, so you can drop clauses that aren't about the product. Then it rewrites the rest about 20 at a time: needs become stories, behaviour becomes "shall" statements, and each keeps the exact place it came from ("Region North tender 2026, §4.2"). It shows you each batch and records it only once you agree. The `groundwork-write-requirement` skill describes the workflow.

### Start from a product that already exists

Modernizing an existing product? Tell your agent *"Reverse-engineer the requirements of this codebase into a 4.x baseline"*. It reads the code and tests one product area at a time, drafts the needs and "shall" statements with links to the code, asks you about suspected bugs and dead code, and records each area with `record_baseline`, including the risks the product already carries and the requirements that control them. You start with a requirement repository instead of a blank page. New behaviour then gets new requirements that replace baseline ones.

## Risks

Risks (`RSK-0001`) record a hazard, the harm it can cause, and its probability and severity on a 5×5 matrix (or 3×3, set in `config.yml`). Requirements that mitigate a risk are linked to it, and a residual score says what's left once they're in. The level (low, medium, high) is always derived from the scores, never typed in.

The `groundwork-risk` skill has the agent spot risks while it plans, so a feature that handles patient data comes with its risks and mitigations in the same plan. A high risk blocks a release until its mitigations are approved and its residual level is no longer high.

```sh
npx -p groundwork-mcp groundwork list risk
#   RSK-0001 Imports attributed to the wrong person (medium, residual low)
```

## Tests and results

A solution requirement records the tests that verify it, both kinds:

- **Automated tests,** as a file and the test's full name: `link_code_tests`.
- **Cases in your test-management tool,** such as Qase, TestRail or Xray: `link_test_cases`.

**Results from CI.** On each run on your default branch, CI records the JUnit results of the linked tests and commits them to a `groundwork-results` branch, so your main branch's history stays clean:

```yaml
# in your test job, after the tests
- if: ${{ !cancelled() && github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}
  run: npx -p groundwork-mcp groundwork results add "reports/*.xml" --push
```

The job needs `permissions: contents: write`, and a ruleset that covers every branch must allow `groundwork-results`. The [GitHub Action](#pull-requests-and-ci) does this step for you. Runs from a laptop are recorded but don't count as evidence.

**Results from a test-management tool.** Your agent records a run for a product version with `record_test_results`. `get_item` on a requirement shows whether its tests passed.

## Pull requests and CI

The [Groundwork Action](action/README.md#without-a-groundwork-account-local-mode) needs no account in `mode: local`:

- **On a pull request** it comments with the requirements and risks the PR names in its `Groundwork:` trailer or touches through their `codeRefs`, and the gaps: requirements without tests, approved requirements changed without being named, high risks without mitigation, failed or missing test runs. `fail-on-gaps` fails the check.
- **On the default branch** it records the JUnit results, as above.

```yaml
- uses: IdeatorlabsAB/groundwork/action@v0.9.0
  if: ${{ !cancelled() }}
  with:
    mode: local
    junit: junit.xml
```

[`action/README.md`](action/README.md) has the full workflow. Also run `validate` on pull requests, to catch broken links and ids that clash with the branch they merge into:

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0 # so the base branch is there to compare with
- run: npx -y -p groundwork-mcp groundwork validate --against origin/${{ github.base_ref }}
```

## Releasing

Ask *"What's blocking 1.1?"*, or run `groundwork check release 1.1`. It lists, with the web app's rules:

- high risks without approved mitigations, or still high after them, and risks that aren't scored;
- requirements that aren't approved;
- tests that are missing, failed, or haven't run on the default branch.

Then tell your agent *"Release 1.1"*. It lists what was planned. With a tracker it refreshes the tickets and proposes the requirements whose tickets are done; without one, it asks you what shipped. What didn't ship moves to the next version, so nothing is dropped. Releasing signs the version off in a frozen record in `groundwork/releases/`. If anything blocks it, only an owner can release it, with a written justification that goes in the record.

```sh
npx -p groundwork-mcp groundwork check release 1.1      # exits 1 if anything blocks it
npx -p groundwork-mcp groundwork release 1.1 --shipped REQ-0012,REQ-0014 --move-rest 1.2
npx -p groundwork-mcp groundwork report release 1.1     # the traceability report, as Markdown
npx -p groundwork-mcp groundwork report release 1.1 --format csv > traceability.csv
npx -p groundwork-mcp groundwork report release 1.1 --format csv --table risks > risk-register.csv
```

The report shows what the version introduced and made obsolete, how far each stakeholder need is met, each requirement's tickets, tests and results, the risks and their mitigations, and the readiness at sign-off. It's read from the sign-off record, so it says the same thing next year.

**A signed-off version is locked.** To correct it, an owner withdraws the sign-off with a reason (`groundwork release 1.1 --withdraw --reason "…"`), corrects the release (`--correct`, with its own reason), and signs it off again. Both stay on the record. Versions released before Groundwork had sign-off records can be signed off with `--sign-off`.

## Discovery evidence

Groundwork can also hold the evidence behind a requirement, from customer interviews to experiments:

```
insight ──▶ hypothesis ──▶ experiment ──▶ finding ──▶ requirement
```

> Here are my notes from three customer interviews. Log the pains as insights.
>
> The pilot finished: activation went from 38% to 61%. Record it and write up the finding.
>
> Why are we building the guided import?

Groundwork computes experiment verdicts from the results, and `groundwork trace` shows the chain behind any item:

```
REQ-0002 Guided CSV import (solution, approved)
├─ finding FND-0001 Guided import lifts activation
│  ├─ experiment EXP-0001 Guided import pilot (completed, validated)
│  │  └─ hypothesis HYP-0001 Guided import (validated)
│  │     ├─ insight INS-0001 Setup takes too long
│  │     └─ insight INS-0002 Import errors are unclear
│  ├─ hypothesis HYP-0001 Guided import (validated) (shown above)
│  └─ insight INS-0001 Setup takes too long (shown above)
└─ requirement REQ-0001 Get set up without help (stakeholder, draft)
   └─ finding FND-0001 Guided import lifts activation (shown above)
```

It's optional: requirements can rest on an origin instead, such as a tender or a regulation.

## Working on branches

Everyone works on their own clone, so two branches can both create `REQ-0012`, each meaning something different. Groundwork catches this before you merge:

```sh
npx -p groundwork-mcp groundwork validate --against origin/main   # error: REQ-0012 is also used by … on origin/main
npx -p groundwork-mcp groundwork renumber --against origin/main   # REQ-0012 → REQ-0015, links updated
```

`renumber` gives the branch's clashing items the next free ids and updates links to them in the files the branch changed. Ids already on `main` never change, so documents that cite them stay valid. Agents run it for you when `validate` reports a clash.

## Setup

`groundwork/config.yml` holds the project's name, its people and their roles. The first write creates it. People are added by hand, because roles decide who can approve and sign off:

```yaml
schemaVersion: 2
name: Clinicare
people:
  - { id: maria, name: Maria, role: owner }
  - { id: sam, name: Sam, role: editor }
```

Products, areas and versions are files in `groundwork/products/`, which your agent creates (`add_products`, `add_product_areas`, `add_product_versions`). Groundwork finds the project by looking for `groundwork/config.yml` in the current folder and the folders above it. Set `GROUNDWORK_DIR` to point elsewhere, and `GROUNDWORK_USER` to choose who you act as.

Projects from before 0.6 keep products in `config.yml`. Run `groundwork migrate --dry-run` to see the change, then `groundwork migrate`.

[SPEC.md](SPEC.md) has the full file format, every field and the rules.

## Reference

### Command line

```sh
npx -p groundwork-mcp groundwork <command>
```

| Command | What it does |
|---|---|
| `init`, `migrate` | Create `groundwork/config.yml`; move older projects to product files |
| `validate [--against <base>]` | Check every item and link, and ids that clash with a branch. Exits 1 on errors |
| `renumber --against <base>` | Fix those clashes on this branch |
| `list [kind]`, `trace <id>` | List items; show the chain behind one |
| `check release <version>` | What blocks a version. Exits 1 if anything does |
| `release <version> --shipped …` | Release and sign off a version |
| `release <version> --sign-off` / `--withdraw` / `--correct` | Sign off an older release; withdraw a sign-off; correct a release |
| `report release <version>` | The traceability report, as Markdown or CSV, or the risk register |
| `results add <junit>… [--push]` | Record a CI run's results for linked tests |
| `ci pr --input <pr.json>` | The pull request report, for the GitHub Action |
| `import --to <url>` | Move the project into the web app |

`groundwork --help` lists every option.

### MCP tools

| Area | Tools |
|---|---|
| Read | `get_workspace`, `search_items`, `get_item`, `trace_code`, `get_release`, `check_release` |
| Products | `add_products`, `add_product_areas`, `add_product_versions` |
| Evidence | `add_insights`, `add_hypotheses`, `add_experiment`, `start_experiment`, `record_experiment_results`, `add_findings` |
| Requirements | `add_requirements`, `record_baseline`, `submit_requirement_for_approval`, `approve_requirement`, `send_back_requirement`, `plan_requirements`, `obsolete_requirement` |
| Risks | `add_risks` (mitigations with `link_items`) |
| Delivery | `link_tickets`, `unlink_tickets`, `update_tickets`, `link_code_tests`, `unlink_code_tests`, `link_test_cases`, `unlink_test_cases`, `record_test_results` |
| Releases | `release_version`, `release_requirements`, `correct_release`, `sign_off_release`, `withdraw_release` |
| Any item | `update_item`, `link_items`, `delete_item` |

## Privacy

Insights hold what customers said, and these files end up in git. Groundwork tells agents to record a role ("Finance manager") and an optional reference ("P07"), never names or contact details. Check quotes before you commit them, and keep the repository private if they're sensitive.

## Moving to the web app

The [Groundwork web app](https://groundwork.ideatorlabs.com) is the hosted version for teams: a **Review** inbox where people approve what agents recorded, grouped by pull request; an **Activity** log filtered by agent; roles; and traceability reports and risk registers as PDF. It's a separate product. This project is and stays open source.

When you're ready, an owner creates an agent token in the web app (**Settings → Connect an agent**) and runs:

```sh
export GROUNDWORK_TOKEN=gw_…
npx -p groundwork-mcp groundwork import --to https://your-groundwork-app --dry-run   # see what would happen
npx -p groundwork-mcp groundwork import --to https://your-groundwork-app
```

Everything moves, with its links: the evidence; requirements, the baseline included, with their tickets, tests and cases; risks with their mitigations and scores; versions, as releases; CI and test-tool results; and sign-off records, word for word. The web app's own release check then gives every version the same verdict as `groundwork check release`.

- **Ids stay the same.** `REQ-0042` stays `REQ-0042`, so the `Groundwork:` trailers in your git history still point at the right items. If the workspace already has one of those keys, the import refuses and lists them; import into a new workspace.
- **Older releases stay honest.** A version released before Groundwork had sign-off records arrives released and locked, marked as never verified.
- **Owners only, when there are releases,** because only owners sign releases off in the web app.
- **Safe to repeat.** Running it again skips what's already there and finishes an import that stopped half-way. `--overwrite` replaces items, never signed-off releases.

Afterwards `config.yml` says `migrated:`, so the local tools only read, and the command prints how to point your agent at the web app. With Claude Code, install the `groundwork-cloud` plugin instead of `groundwork` (`/plugin install groundwork-cloud@groundwork`) and put the token in each repository's `.claude/settings.local.json`, which git ignores: `{ "env": { "GROUNDWORK_TOKEN": "gw_…" } }`. Add `"GROUNDWORK_URL"` there for any address but `https://groundwork.ideatorlabs.com`. With Codex, run `codex mcp remove groundwork` and add to `~/.codex/config.toml`:

```toml
[mcp_servers.groundwork]
url = "https://your-groundwork-app/api/mcp"
bearer_token_env_var = "GROUNDWORK_TOKEN"
```

In CI, the Action's default mode works with the web app: it also tags merged work to the release and uploads test results. A workspace owner creates its token under **Settings → Connect CI**; see [`action/README.md`](action/README.md).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[Apache-2.0](LICENSE)
