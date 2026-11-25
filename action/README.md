# Groundwork GitHub Action

A safety net for what coding agents forget to record in [Groundwork](https://groundwork.ideatorlabs.com). It doesn't block anything unless you ask it to.

- **On a pull request** it comments with the requirements and risks the PR names in its `Groundwork:` trailer, or touches through their code references. It also lists the traceability gaps:
  - a named solution requirement with no tests;
  - an approved requirement whose code changed, but the PR doesn't name it;
  - a high risk with no mitigation.
- **On a merge to the default branch** it tags the solution requirements and risks the PR names to their product's collecting release, and links the PR to them as a ticket with its merge commit. Signed-off releases are never changed.
- **With `junit`** it uploads your test reports for the commit and matches them to the code tests linked to requirements.

Groundwork never calls GitHub. The Action posts the comment with the workflow's own token.

## Set up

1. A workspace owner creates a CI token in Groundwork → **Settings → Connect CI**. Save it as the repository secret `GROUNDWORK_CI_TOKEN`.
2. Mark the release that collects merged work on its page in Groundwork ("Collect merged work"). Each product has one.
3. Add the workflow:

```yaml
# .github/workflows/groundwork.yml
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
  pull-requests: write
jobs:
  groundwork:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npx vitest run --reporter=junit --outputFile=junit.xml
      - uses: IdeatorlabsAB/groundwork/action@main
        if: always()
        with:
          token: ${{ secrets.GROUNDWORK_CI_TOKEN }}
          junit: junit.xml
```

Leave out the test steps and `junit` if you only want the comment and the merge tagging.

| Input | Default | |
| --- | --- | --- |
| `token` | | A Groundwork CI token. Required. |
| `url` | `https://groundwork.ideatorlabs.com` | Your Groundwork address. |
| `junit` | | JUnit report file patterns, one per line. |
| `fail-on-gaps` | `false` | Fail the check when the PR has gaps. |
| `github-token` | `${{ github.token }}` | Reads the PR and writes its comment. |

Output: `gaps`, the number of gaps on the pull request.

If Groundwork can't be reached, or the token is missing (for example on a pull request from a fork), the Action writes a warning and the job carries on.

## Block merges with failing tests

With `junit`, the pull request comment also lists the requirements the PR names whose linked tests failed or didn't run in that pull request's tests. To stop such a pull request from merging:

1. Set `fail-on-gaps: true`, so the Groundwork check fails when there are gaps.
2. In GitHub, go to **Settings → Branches** (or **Rules**) for your default branch and make the workflow's job a **required status check**.

This matters most when every merge deploys: the release sign-off judges the tests on the default branch, which is after the merge.

## Which test results count

- **Release readiness** counts results uploaded from the default branch: on a push, a schedule or a manual run. Each linked test counts its result from the newest such run that includes it. A test that a newer run of its file no longer has (deleted or renamed) stops counting.
- **The pull request comment** uses the results that job sent, and only reports on the test files in them. If your tests run in several jobs, run the Action once, in a job that runs after all of them (`needs:`), with every report. With one Action per job, the single comment shows whichever job finished last.

## GitLab CI and other CI

The Action only wraps three HTTP calls, so any CI can make them with `curl`. Each one takes a JSON body and `Authorization: Bearer <CI token>`:

| Endpoint | Body | Returns |
| --- | --- | --- |
| `POST /api/ci/pr` | `{ prBody, commitMessages[], changedPaths[] }` | `{ named, touched, unknownKeys, gaps, markdown }` |
| `POST /api/ci/merge` | `{ prBody, commitMessages[], repo, number, title, url, mergeSha }` | `{ keys, tagged, ignored, ticketLinked, changed }` |
| `POST /api/ci/test-results` | `{ commitSha, ref?, defaultBranch?, junit: string \| string[] }` | `{ id, totals, matched }` |

Only test results sent with `defaultBranch: true` count towards a release being ready, so send it only from runs on the default branch. Pull-request runs show up in the pull request comment instead.

For example, uploading test results and recording merged merge requests in GitLab CI:

```yaml
groundwork:
  stage: .post
  image: alpine:3.20
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  before_script:
    - apk add --no-cache curl jq
  script:
    - |
      jq -n --arg sha "$CI_COMMIT_SHA" --arg ref "$CI_COMMIT_REF_NAME" --rawfile junit junit.xml \
        '{commitSha: $sha, ref: $ref, defaultBranch: true, junit: $junit}' |
      curl -sf -X POST "https://groundwork.ideatorlabs.com/api/ci/test-results" \
        -H "Authorization: Bearer $GROUNDWORK_CI_TOKEN" -H "Content-Type: application/json" --data @- || true
    - |
      # GitLab's merge commits end with "See merge request group/project!12". No such line: not a merge, nothing to record.
      IID=$(printf '%s' "$CI_COMMIT_MESSAGE" | sed -n 's/.*See merge request .*!\([0-9][0-9]*\).*/\1/p' | tail -n 1)
      if [ -n "$IID" ]; then
        jq -n --arg msg "$CI_COMMIT_MESSAGE" --arg repo "$CI_PROJECT_PATH" --arg title "$CI_COMMIT_TITLE" \
          --arg sha "$CI_COMMIT_SHA" --argjson iid "$IID" --arg url "$CI_PROJECT_URL/-/merge_requests/$IID" \
          '{commitMessages: [$msg], repo: $repo, number: $iid, title: $title, url: $url, mergeSha: $sha}' |
        curl -sf -X POST "https://groundwork.ideatorlabs.com/api/ci/merge" \
          -H "Authorization: Bearer $GROUNDWORK_CI_TOKEN" -H "Content-Type: application/json" --data @- || true
      fi
```

This needs the project's merge method to be **Merge commit**, which writes the "See merge request" line. The keys are read from the merge commit message, so put the `Groundwork:` trailer there. Add `%{description}` to the project's merge commit template, or write the trailer in the merge request's title or a commit. The ticket is recorded as `group/project#12`.
