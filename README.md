# Groundwork

**Your product evidence, in your repo, written by your own agent.**

Groundwork lets Claude Code (or any MCP agent) keep customer insights, hypotheses, experiments, findings and requirements as linked Markdown files in a `groundwork/` folder, next to your code. It's where your team keeps the *why*: who needs what, what the solution shall do, and the evidence behind it. Your agent writes requirements before it builds, and every requirement traces back to the stakeholder needs, findings and customer quotes behind it.

```
insight ──▶ hypothesis ──▶ experiment ──▶ finding ──▶ requirement
"I gave up    "Guided import   pilot, 10      "activation    "Guided CSV
 after 20      will lift        accounts:      61% vs 38%"    import"
 minutes"      activation"      validated"
```

- **No account, no API keys, no server.** Your agent does the thinking. Groundwork checks the data, keeps links valid and computes experiment verdicts.
- **Plain files.** Read them, diff them, review them in pull requests, and keep them as long as you like.
- **Traceability.** Ask "why are we building this?" and get the full evidence chain, or check it in CI with `groundwork validate`.
- **Works with your branches.** Everyone works on their own clone, and Groundwork catches and fixes id clashes before you merge.

Working in a regulated industry, or need people to review and sign off what agents record? See [Groundwork for teams](#groundwork-for-teams): the same workflow, kept in a web app with CI, risk registers and release sign-off.

## Quickstart (2 minutes)

### Claude Code

In your project folder:

```sh
claude mcp add groundwork -- npx -y groundwork-mcp
```

Or install the plugin, which adds the MCP server and a skill that teaches Claude when to use it:

```
/plugin marketplace add IdeatorlabsAB/groundwork
/plugin install groundwork@groundwork
```

### Codex

```sh
codex mcp add groundwork -- npx -y groundwork-mcp
```

Or add it to `~/.codex/config.toml` by hand:

```toml
[mcp_servers.groundwork]
command = "npx"
args = ["-y", "groundwork-mcp"]
```

To teach Codex when to use it, copy the skill into your repo:

```sh
mkdir -p .agents/skills/groundwork
curl -fsSL https://raw.githubusercontent.com/IdeatorlabsAB/groundwork/main/skills/groundwork/SKILL.md -o .agents/skills/groundwork/SKILL.md
```

Start `codex` in your project folder, so Groundwork finds the project.

### Then

Talk to your agent as you normally would:

> Here are my notes from three customer interviews. Log the pains as insights.
>
> Draft a hypothesis from the onboarding insights, with a success metric.
>
> The pilot finished: activation went from 38% to 61%, support tickets stayed at 11 a week. Record it and write up the finding.
>
> Why are we building the guided import?
>
> Let's add a feature to book appointments. *(In plan mode, the agent writes the requirements first.)*
>
> Maria approved REQ-0004 in sprint planning. Record it.

Groundwork writes files like `groundwork/insights/INS-0001-setup-takes-too-long.md`. Commit them like any other file.

## Requirements in two layers

Write requirements before you build, and keep them in two linked layers:

- **Stakeholder requirements** say who needs what and why, as user stories: *"As a medical secretary I want a view of all practitioners' calendars with their unbooked slots highlighted so that I can find them and book appointments easily."*
- **Solution requirements** say what the solution must do to meet those needs, as "shall" statements: *"The appointment view shall show the calendars of the selected practitioners with the free slots highlighted. It shall be possible to click a free slot to start the booking flow."*

Every solution requirement fulfils at least one stakeholder requirement, and Groundwork refuses one that doesn't. `groundwork validate` warns about stakeholder requirements that no solution requirement fulfils yet, and about stories that don't fit their layer. Linking findings is optional, so you can write requirements before there's any experiment behind them.

### Planning with Groundwork

When your agent plans a task, it first decides what kind of task it is. "Let's add a feature to book appointments" is a new need. "This path is broken, fix it" is a fix. It states the call in one line of the plan, such as *"New need: adds 2 stakeholder and 4 solution requirements"* or *"Bug fix under REQ-0007; no requirement changes"*. For a new need or a change, the plan records the requirements before any code. Tickets the workflow creates carry the REQ ids they implement. When a PM approves a requirement verbally, tell the agent and it records the approval on their behalf, noting who entered it.

**Tickets, linked both ways.** When the workflow creates tickets or user stories in Linear, Jira, GitHub Issues or any other board, each ticket names the REQ ids it implements. The agent records the ticket on those requirements with `link_tickets`. Groundwork never calls your tracker; the agent uses the tracker tool your workflow already has. A bug fix under an existing requirement is linked to it too, so the fix traces back to what it restores. Ask *"which requirement is CLN-142?"* and the agent finds it.

## Releasing

When a version goes out, record it: tell your agent *"Release Clinicare 1.1"*, or use the CLI. Groundwork lists what was planned for 1.1. If your workflow has a tracker, the agent refreshes the tickets' status (`update_tickets`) and proposes the requirements whose tickets are all done. It asks you about the rest; requirements without tickets are never shipped on ticket status alone. Without a tracker, it asks you what shipped. Planned requirements that didn't make it move to the next version you name, so nothing is dropped. A replaced requirement becomes obsolete once all its replacements have shipped. Groundwork records who released the version and when.

```sh
npx -p groundwork-mcp groundwork release 1.1 --shipped REQ-0012,REQ-0014 --move-rest 1.2
npx -p groundwork-mcp groundwork report release 1.1     # the release report, as Markdown
```

The release report lists what the version introduced, what it made obsolete and how far each stakeholder need is met, e.g. from [examples/acme](examples/acme):

```markdown
# Acme app 1.0: release report

Released 2026-11-22 by sam. Product PRD-0001.

## Introduced

- **REQ-0002** Guided CSV import: The CSV import shall guide the user step by step through uploading a file, …
  - Meets: REQ-0001 Get set up without help
  - Tickets: linear ACME-12

## Made obsolete

Nothing.

## Stakeholder requirements

- **REQ-0001** Get set up without help: fully met (1 of 1 solution requirements released)
```

Put it in your release documentation, e.g. the technical documentation for an EU MDR medical device. A released version changes only through a correction, which needs a reason and shows in the report: *"Correct 1.1: REQ-0014 didn't ship, move it to 1.2. Reason: feature flag was off in the build"*, or `groundwork release 1.1 --correct --remove REQ-0014 --move-rest 1.2 --reason "…"`. For teams that ship continuously, `release_requirements` records requirements that shipped later in an already released version.

## Starting from an existing product

If you are modernizing a product that already exists, tell your agent *"Reverse-engineer the requirements of this codebase into a Legacy 4.x baseline"*. It reads the code and tests one product area at a time, drafts the needs and "shall" statements with links to the code (`codeRefs`), and shows you each list. It asks you about suspected bugs and dead code, and who approves. Then it records the area with `record_baseline`: the requirements are approved and already released in that version, so you start with a requirement repository instead of a blank page. New or changed behaviour then gets new requirements with `replaces: [baseline id]`. When they ship, the baseline items become obsolete. Never edit the baseline. `groundwork report release <version>` prints it as a baseline report with a count per area.

## Test results from CI

Groundwork keeps test evidence in your repository. On each push to your default branch, CI records the JUnit results of the tests your requirements link to and commits them to a `groundwork-results` branch, so your main branch's history stays clean:

```yaml
# .github/workflows/test.yml
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: write      # to push to groundwork-results
    steps:
      - uses: actions/checkout@v5          # keep the default credentials
      - run: npm ci && npm test -- --reporter=junit --outputFile=reports/junit.xml
      # !cancelled(): record the results when tests fail too, or a regression would leave the last pass standing.
      - if: ${{ !cancelled() && github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}
        run: npx -p groundwork-mcp groundwork results add "reports/*.xml" --push
```

If a ruleset protects every branch, allow `groundwork-results`. Results from a laptop are written but don't count as evidence. Your agent records runs from a test-management tool (Qase, TestRail, …) with `record_test_results`, and `get_item` shows whether a requirement's tests passed.

## Working on branches

Everyone works on their own clone of the repo: developers writing requirements while they plan, and product managers logging insights and results. Groundwork numbers new items on each clone as one more than the highest id it can see. So two branches can both create `REQ-0012`, each meaning something different.

Groundwork catches this before you merge:

```sh
npx -p groundwork-mcp groundwork validate --against origin/main   # error: REQ-0012 is also used by … on origin/main
npx -p groundwork-mcp groundwork renumber --against origin/main   # REQ-0012 → REQ-0015, links updated
```

`renumber` gives the branch's clashing items the next free ids and renames their files. It also updates links to them in the files your branch added or changed. Ids already on `main` never change, so links and documents that cite them stay valid. Your notes (the Markdown under an item's frontmatter) are never rewritten: if they mention an old id, `renumber` tells you, so you can fix it by hand. Agents run it for you when `validate` reports a clash.

## The CLI

```sh
npx -p groundwork-mcp groundwork init        # create groundwork/config.yml
npx -p groundwork-mcp groundwork validate    # check every item and link; exits 1 on errors
npx -p groundwork-mcp groundwork validate --against origin/main   # also catch ids that clash with main
npx -p groundwork-mcp groundwork renumber --against origin/main   # fix those clashes on this branch
npx -p groundwork-mcp groundwork migrate --dry-run   # move products and areas from config.yml into product files
npx -p groundwork-mcp groundwork release 1.1 --shipped REQ-0012 --move-rest 1.2   # release a version
npx -p groundwork-mcp groundwork report release 1.1   # its release report
npx -p groundwork-mcp groundwork trace REQ-0002
npx -p groundwork-mcp groundwork list hypothesis
npx -p groundwork-mcp groundwork import --to <web app>   # see "Groundwork for teams"
```

`trace` shows the chain behind an item (from [examples/acme](examples/acme)):

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

Run `validate` in CI to block pull requests with broken links or ids that clash with the branch they merge into:

```yaml
# .github/workflows/groundwork.yml
on: pull_request
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # so the base branch is there to compare with
      - run: npx -y -p groundwork-mcp groundwork validate --against origin/${{ github.base_ref }}
```

## Setup

`groundwork/config.yml` holds the project's name and its people (for approvals). The first write creates it if it's missing. People are always added by hand:

```yaml
schemaVersion: 2
name: Clinicare
people:
  - { id: maria, name: Maria, role: owner, email: maria@clinicare.example }
```

### Products, areas and versions

Each product is a file in `groundwork/products/`, with its areas and versions, kept in the repo next to your code:

```yaml
# groundwork/products/PRD-0001-clinicare-web-application.md
---
id: PRD-0001
title: Clinicare Web Application
areas:
  - { id: settings-and-configuration, label: Settings and configuration }
  - { id: scheduling, label: Scheduling }
  - { id: prescriptions, label: Prescriptions }
  - { id: medical-records, label: Medical Records }
  - { id: patient-data-protection, label: Patient Data Protection }
versions:
  - { version: "1.0", status: planned }
---
```

Ask your agent: *"Set up Groundwork for Clinicare Web Application, with areas Settings and configuration, Scheduling, Prescriptions, Medical Records and Patient Data Protection, and a first version 1.0."* It uses `add_products`, `add_product_areas` and `add_product_versions`. Insights, hypotheses, findings and requirements are tagged with an area, and solution requirements name their product (`product: PRD-0001`). Area ids are unique across products, so an area always points to one product.

**Projects from before 0.6** keep their areas and products as lists in `config.yml`, and keep working as they are. To give products versions, run `npx -p groundwork-mcp groundwork migrate --dry-run` to see what would change, then `groundwork migrate`. It creates the product files, points requirements at product ids and updates `config.yml`. After migrating, everyone needs Groundwork 0.6 or later: older versions refuse the folder and say to update.

**Planning requirements for a version.** When a solution requirement is approved, it's planned for one of its product's planned versions, e.g. *"Approve REQ-0012 for 1.1"*. If work slips, `plan_requirements` moves it to 1.2. To change an approved requirement, the agent adds a new one that `replaces` it. The old one stays valid until the version the new one ships in, so Groundwork never says "obsolete" while the released product still behaves the old way.

Groundwork finds the project by looking for `groundwork/config.yml` in the current folder and the folders above it. Set `GROUNDWORK_DIR` to point somewhere else, and `GROUNDWORK_USER` to choose who you're acting as.

The full format, every field and the rules are in [SPEC.md](SPEC.md). See [examples/acme](examples/acme) for a sample project.

## Tools

| Read | Write | Lifecycle |
|---|---|---|
| `get_workspace` | `add_insights` | `start_experiment` |
| `search_items` | `add_hypotheses` | `record_experiment_results` |
| `get_item`, `trace_code` | `add_experiment` | `submit_requirement_for_approval` |
| | `add_findings` | `approve_requirement` |
| | `add_requirements` | `send_back_requirement` |
| | `update_item`, `link_items` | `obsolete_requirement` |
| | `delete_item` | |
| | `link_tickets`, `unlink_tickets`, `update_tickets` | |
| | `add_risks` | |
| | `link_code_tests`, `unlink_code_tests`, `link_test_cases`, `unlink_test_cases` | `record_test_results` |
| | `record_baseline` | |
| `get_release` | `add_products`, `add_product_areas`, `add_product_versions` | `plan_requirements`, `release_version`, `release_requirements`, `correct_release` |

## Privacy

Insights hold what customers said, and these files usually end up in git. Groundwork tells agents to record a role ("Finance manager") and an optional reference ("P07"), never names or contact details. Check quotes before you commit them, and keep the repo private if they're sensitive.

## Groundwork for teams

The [Groundwork web app](https://groundwork.ideatorlabs.com) is for teams, especially in regulated industries (medical devices, healthcare, finance), where every release has to show what shipped, why, and how it was checked. It's a separate hosted product; this project is and stays open source.

The agent keeps the records there too, and people make the decisions:

1. **Plan.** Before writing code, the agent adds a Groundwork section to its plan: the stakeholder and solution requirements, the risks with their scores and mitigations, the release, and the tests. Approving the plan approves that section.
2. **Build.** While it works, the agent records those items, where each lives in the code, the tests that verify it, and the tickets and pull request that deliver it. The pull request ends with a trailer such as `Groundwork: REQ-0042, RSK-0007`.
3. **CI.** The [GitHub Action](#ci-the-github-action) comments on each pull request with the requirements it touches and any gaps, tags merged work to the product's release, and uploads test results from the default branch.
4. **People decide.** In the app, the team approves what agents recorded in a **Review** inbox grouped by pull request, and sees every change, filtered by agent, under **Activity**. A release is ready when its high risks are mitigated, its requirements approved and every linked test passed on the default branch. An owner then signs it off, which freezes a printable release report. Each product also has a **traceability report** and a **risk register**, as PDF or CSV.

Agents never approve requirements, accept a residual risk or sign a release off.

To move a project from these files into the web app, create an agent token in the web app (**Settings → Connect an agent**), then:

```sh
export GROUNDWORK_TOKEN=gw_…
npx -p groundwork-mcp groundwork import --to https://your-groundwork-app --dry-run   # see what would happen
npx -p groundwork-mcp groundwork import --to https://your-groundwork-app
```

Every item keeps its links, and its original id (`INS-0001`) stays its key. Running the import again skips items already there (`--overwrite` replaces them). Afterwards `groundwork/config.yml` says `migrated:`, so local tools only read the files and the web app is where changes go. The command prints how to point your agent at the web app's MCP server. For Codex, run `codex mcp remove groundwork` and add this to `~/.codex/config.toml`:

```toml
[mcp_servers.groundwork]
url = "https://your-groundwork-app/api/mcp"
bearer_token_env_var = "GROUNDWORK_TOKEN"
```

### The groundwork-cloud plugin

To work against the web app from Claude Code, install the `groundwork-cloud` plugin instead of `groundwork`:

```
/plugin marketplace add IdeatorlabsAB/groundwork
/plugin install groundwork-cloud@groundwork
```

Then put your agent token in each repository's `.claude/settings.local.json` (git ignores it): `{ "env": { "GROUNDWORK_TOKEN": "gw_…" } }`. Add `"GROUNDWORK_URL"` for anything but `https://groundwork.ideatorlabs.com`.

The plugin connects the web app's MCP server, and its skills teach Claude to record requirements, risks, code references, tests, tickets and release tags while it plans, builds and opens pull requests: every plan gets a Groundwork section, and approving the plan approves it. Two hooks remind Claude of this when a session starts and after `gh pr create`. They do nothing in a repository without `GROUNDWORK_TOKEN`.

The plugin's skills are generated in the web app's repository; don't edit them here.

### CI: the GitHub Action

[`action/`](action/) is a GitHub Action for teams on the web app. It records what agents forget:

- On each pull request, it comments with the requirements and risks the PR names or touches, and any gaps.
- On merge, it tags the work the PR names to the product's collecting release, and records the PR as merged, with its merge commit and time, on the requirements it delivers.
- After your tests run, it uploads the JUnit results. Results from the default branch count towards release readiness; pull-request results show in the comment.

```yaml
- uses: IdeatorlabsAB/groundwork/action@main
  with:
    token: ${{ secrets.GROUNDWORK_CI_TOKEN }}
```

A workspace owner creates the CI token in the web app (**Settings → Connect CI**). [`action/README.md`](action/README.md) has the full workflow and a GitLab CI version. Like the plugin's skills, the Action is generated in the web app's repository; don't edit it here.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[Apache-2.0](LICENSE)
