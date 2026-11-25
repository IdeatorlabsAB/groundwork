#!/bin/sh
# Remind Claude, once per session, that this repository records its work in Groundwork.
# Silent in repositories without a token, so the plugin doesn't affect them.
[ -n "${GROUNDWORK_TOKEN:-}" ] || exit 0
cat >/dev/null
echo "Groundwork is connected for this repository (the groundwork MCP server). When you plan a new need, a change or a fix, follow the groundwork skill: add a Groundwork section to the plan, record what it lists while you build, and end the PR with a 'Groundwork:' trailer."
