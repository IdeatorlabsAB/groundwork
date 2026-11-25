#!/bin/sh
# After `gh pr create`, remind Claude to finish the Groundwork steps for the PR.
# Silent in repositories without a token, and for every other command.
[ -n "${GROUNDWORK_TOKEN:-}" ] || exit 0
input=$(cat)
case "$input" in
  *"gh pr create"*) ;;
  *) exit 0 ;;
esac
cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"You just opened a pull request. For Groundwork: 1) make sure its description ends with a trailer naming what it implements or restores, e.g. 'Groundwork: REQ-0042, RSK-0007' (add it with gh pr edit if it's missing); 2) link_tickets the PR to its solution requirements with { tracker: \"github\", key: \"owner/repo#N\", url }; 3) call check_release for the release and tell the user what still blocks it."}}
JSON
