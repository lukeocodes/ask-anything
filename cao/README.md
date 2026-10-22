# Daily run

The scheduler setup for ADR-0026. The process the agent follows is the
"Daily run" section of `AGENTS.md`; the queue is `docs/goals.md`.

| File | What |
|---|---|
| `engineer.md` | Agent profile `ask-anything-engineer`, Claude Code provider. |
| `work.md` | Flow `ask-anything-work`, daily 08:00. One work turn. |
| `housekeeping.md` | Flow `ask-anything-housekeeping`, daily 12:00. Commit, push, PR body, ready + mention. |
| `guard.sh` | Pre-flight for housekeeping: skips while the work session is still processing, passes the open `daily` PR to the prompt. |

Register from the `main` checkout, once:

```bash
cao install cao/engineer.md --provider claude_code
cao schedule add cao/work.md
cao schedule add cao/housekeeping.md
gh label create daily --color 0e8a16 --description "Opened by the daily run"
gh label create needs-decision --color b60205 --description "Blocked on a maintainer decision"
```

Run by hand: `cao schedule run ask-anything-work`. Throttle: edit the cron
in the flow file, `cao schedule remove` and `add` again. More turns a day is
another flow file, not a longer prompt.
