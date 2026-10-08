# Architecture

The Mod is event-driven. Slash commands trigger workflow transitions. Claude receives orchestration prompts and reports structured progress back through three plugin tools: `set_plan`, `task_update`, and `stage_update`. The pane renders from persistent plugin store state.

Parallelism is plan-driven: tasks may be assigned worker A/B, but `/build` explicitly requires dependency and likely write-set checks before spawning concurrent subagents. Integration remains with the main agent.

Lifecycle: Requirements → Plan → Build → Review → Ship.
