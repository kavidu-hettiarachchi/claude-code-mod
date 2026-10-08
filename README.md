# Agent Card v0.1.0

Claude Code Mod for a requirements → plan → parallel build → review → ship workflow with a live side pane.

## Commands
- `/requirement <text>` captures a requirement, asks Claude to inspect the repo/skills, and creates a plan.
- `/plan-open` opens the plan/card pane.
- `/plan-updates <changes>` asks Claude to revise the approved plan without coding.
- `/build` starts dependency-aware development; two worker streams are used only when safe.
- `/card` opens/focuses the live pane.
- `/ship` runs final gates, commits, pushes, and opens a PR. It does not merge.

## Install/test locally
From the plugin directory:

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

Then try:

```text
/requirement Add search filters to the orders list with backend filtering and frontend filter chips. Include tests.
```

Wait for planning to finish, then `/plan-open`, optionally `/plan-updates ...`, then `/build`, and finally `/ship`.

## v0.1 scope
This first milestone implements the real pane, persistent card, slash commands, model-facing plan/task/stage tools, and the orchestration prompts. It intentionally excludes Environment. CI watching and stronger write-set locking are next hardening steps after validation on Claude Code 2.1.292.


## v0.2.1 planning fix
`/requirement` now starts a dedicated background planning agent and consumes its `turn.complete` result directly. It no longer relies on a detached `$.prompt.submit()` to create the plan.
