# Groundwork

**Your product evidence, in your repo, written by your own agent.**

Groundwork lets Claude Code (or any MCP agent) keep customer insights, hypotheses, experiments, findings and requirements as linked Markdown files in a `groundwork/` folder. Every requirement traces back to the findings, experiments and customer quotes behind it.

```
insight ──▶ hypothesis ──▶ experiment ──▶ finding ──▶ requirement
"I gave up    "Guided import   pilot, 10      "activation    "Guided CSV
 after 20      will lift        accounts:      61% vs 38%"    import"
 minutes"      activation"      validated"
```

- **No account, no API keys, no server.** Your agent does the thinking. Groundwork checks the data, keeps links valid and computes experiment verdicts.
- **Plain files.** Read them, diff them, review them in pull requests, and keep them as long as you like.
- **Traceability.** Ask "why are we building this?" and get the full evidence chain, or check it in CI with `groundwork validate`.

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

Groundwork writes files like `groundwork/insights/INS-0001-setup-takes-too-long.md`. Commit them like any other file.

## Requirements in two layers

Write requirements before you build, and keep them in two linked layers:

- **Stakeholder requirements** say who needs what and why, as user stories: *"As a medical secretary I want a view of all practitioners' calendars with their unbooked slots highlighted so that I can find them and book appointments easily."*
- **Solution requirements** say what the solution must do to meet those needs, as "shall" statements: *"The appointment view shall show the calendars of the selected practitioners with the free slots highlighted. It shall be possible to click a free slot to start the booking flow."*

Every solution requirement fulfils at least one stakeholder requirement, and Groundwork refuses one that doesn't. `groundwork validate` warns about stakeholder requirements that no solution requirement fulfils yet, and about stories that don't fit their layer. Linking findings is optional, so you can write requirements before there's any experiment behind them.

### Planning with Groundwork

When your agent plans a task, it first decides what kind of task it is. "Let's add a feature to book appointments" is a new need. "This path is broken, fix it" is a fix. It states the call in one line of the plan, such as *"New need: adds 2 stakeholder and 4 solution requirements"* or *"Bug fix under REQ-0007; no requirement changes"*. For a new need or a change, the plan records the requirements before any code. Tickets the workflow creates carry the REQ ids they implement. When a PM approves a requirement verbally, tell the agent and it records the approval on their behalf, noting who entered it.

## The CLI

```sh
npx -p groundwork-mcp groundwork init        # create groundwork/config.yml
npx -p groundwork-mcp groundwork validate    # check every item and link; exits 1 on errors
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

Run `validate` in CI to block pull requests with broken links:

```yaml
# .github/workflows/groundwork.yml
on: pull_request
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx -y -p groundwork-mcp groundwork validate
```

## Setup

`groundwork/config.yml` holds your product areas, products and people (for approvals). The first write creates it if it's missing. Fill it in so agents can tag items by area and send requirements for sign-off. Agents can also add product areas and products themselves, with `add_product_areas` and `add_products`; people are always added by hand:

```yaml
name: Acme
productAreas:
  - { id: onboarding, label: Onboarding }
products: [Acme app]
people:
  - { id: sam, name: Sam, role: owner, email: sam@acme.example }
```

Groundwork finds the project by looking for `groundwork/config.yml` in the current folder and the folders above it. Set `GROUNDWORK_DIR` to point somewhere else, and `GROUNDWORK_USER` to choose who you're acting as.

The full format, every field and the rules are in [SPEC.md](SPEC.md). See [examples/acme](examples/acme) for a sample project.

## Tools

| Read | Write | Lifecycle |
|---|---|---|
| `get_workspace` | `add_insights` | `start_experiment` |
| `search_items` | `add_hypotheses` | `record_experiment_results` |
| `get_item` | `add_experiment` | `submit_requirement_for_approval` |
| | `add_findings` | `approve_requirement` |
| | `add_requirements` | `send_back_requirement` |
| | `update_item`, `link_items` | `obsolete_requirement` |
| | `delete_item` | |
| | `add_product_areas`, `add_products` | |

## Privacy

Insights hold what customers said, and these files usually end up in git. Groundwork tells agents to record a role ("Finance manager") and an optional reference ("P07"), never names or contact details. Check quotes before you commit them, and keep the repo private if they're sensitive.

## Groundwork for teams

The Groundwork web app adds dashboards, reports, a visual evidence graph, approvals with an audit trail and Linear sync for people who don't live in a terminal. It's a separate, paid product; this project is and stays open source.

To move a project into it, create an agent token in the web app (**Settings → Connect an agent**), then:

```sh
export GROUNDWORK_TOKEN=gw_…
npx -p groundwork-mcp groundwork import --to https://your-groundwork-app --dry-run   # see what would happen
npx -p groundwork-mcp groundwork import --to https://your-groundwork-app
```

Every item keeps its links, and its original id (`INS-0001`) is stored with it. Running the import again skips items already there (`--overwrite` replaces them). Afterwards `groundwork/config.yml` says `migrated:`, so local tools only read the files and the web app is where changes go. The command prints how to point your agent at the web app's MCP server. For Codex, run `codex mcp remove groundwork` and add this to `~/.codex/config.toml`:

```toml
[mcp_servers.groundwork]
url = "https://your-groundwork-app/api/mcp"
bearer_token_env_var = "GROUNDWORK_TOKEN"
```

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[Apache-2.0](LICENSE)
