---
name: ask-anything-housekeeping
schedule: "0 12 * * *"
agent_profile: ask-anything-engineer
provider: claude_code
script: ./guard.sh
---
Housekeeping turn for ask-anything. Repo: /Users/lukeocodes/Projects/lukeocodes/ask-anything

Read AGENTS.md, then its "Daily run" section. Open `daily` pull request:
[[pr]]. Commit anything uncommitted on its branch, push, make the draft PR
body match the branch, wait for CI. If stage 5 is ticked, finish stage 6:
update ADR Known gaps and docs/goals.md, mark the PR ready, comment
`@lukeocodes ready for review`. Otherwise leave it draft and stop.
