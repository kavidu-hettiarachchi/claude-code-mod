import type { Register, EngineInterface } from "claude-code";

type Stage = "requirements" | "plan" | "build" | "review" | "ship";
type TaskStatus = "pending" | "running" | "done" | "blocked";
type Task = { id: string; title: string; group: string; status: TaskStatus; weight?: number; worker?: "A" | "B"; message?: string };
type Card = {
  id: string; title: string; requirement: string; stage: Stage; planVersion: number;
  tasks: Task[]; updatedAt: string; message?: string;
};

const STORE_KEY = "active-card";
const PANE_ID = "agent-card";
let activeCard: Card | undefined;
const builders = new Map<string, { cardId: string; version: number }>();
const planners = new Map<string, { card: Card; version: number }>();

const now = () => new Date().toISOString();
const makeId = () => `CARD-${String(Date.now() % 10000).padStart(4, "0")}`;

async function load($: any): Promise<Card | undefined> {
  if (activeCard) return activeCard;
  const value = await $.store.get(STORE_KEY);
  if (value && typeof value === "object") activeCard = value as Card;
  return activeCard;
}
async function save($: any, card: Card) {
  activeCard = { ...card, updatedAt: now() };
  await $.store.set(STORE_KEY, activeCard);
  $.ui.invalidate("ui.render");
  updateStatus($, activeCard);
}
function updateStatus($: any, card?: Card) {
  if (!card) return $.ui.status(undefined);
  const done = card.tasks.filter(t => t.status === "done").length;
  const total = card.tasks.length;
  const pct = progress(card);
  $.ui.status(`${card.id} • ${card.stage.toUpperCase()} • ${pct}% • ${done}/${total || 0}`);
}
function progress(card: Card) {
  if (!card.tasks.length) return 0;
  const total = card.tasks.reduce((n,t) => n + (t.weight ?? 1), 0);
  const done = card.tasks.reduce((n,t) => n + (t.status === "done" ? (t.weight ?? 1) : t.status === "running" ? (t.weight ?? 1) * .5 : 0), 0);
  return Math.min(100, Math.round(done / total * 100));
}
function stageGlyph(card: Card, stage: Stage) {
  const order: Stage[] = ["requirements","plan","build","review","ship"];
  const current = order.indexOf(card.stage), pos = order.indexOf(stage);
  return pos < current ? "✓" : pos === current ? "●" : "○";
}
function taskGlyph(s: TaskStatus) { return s === "done" ? "✓" : s === "running" ? "●" : s === "blocked" ? "⚠" : "□"; }

// agent.spawn resolves at start; only its matching turn.complete supplies the plan.
async function plan($: EngineInterface, card: Card, changes?: string): Promise<string> {
  try {
    const started = await $.agent.spawn({
      subagentType: "general-purpose",
      description: "Analyse repository and plan Agent Card",
      prompt: `Agent Card requirement: ${card.requirement}
${changes ? `Revise the existing plan ${JSON.stringify(card.tasks)} with: ${changes}` : ""}
Inspect the actual repository using read/search tools before planning. Discover relevant installed skills. Do not implement or modify files. Do not use /plan or enter built-in plan mode.
Return ONLY a JSON object with title (string), analysis (string describing repository findings with actual file paths), and tasks (nonempty array of {id,title,group,weight?,worker?}). Make tasks dependency-aware and order prerequisites first. Assign worker A/B only for independent file write sets; otherwise omit worker. Do not call set_plan; the plugin consumes your final JSON report.`
    });
    if (started.deny || !started.agentId) throw new Error(started.deny ?? "Planner did not start");
    planners.set(started.agentId, { card, version: card.planVersion });
    return `${card.id}: Analysing requirement and repository…`;
  } catch (error) {
    card.message = `Planning failed: ${String(error)}`;
    if (activeCard === card || activeCard?.id === card.id) await save($, card);
    return card.message;
  }
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "requirement", description: "Capture a requirement and create an implementation plan", argumentHint: "<requirement>" });
    await $.command.register({ name: "plan-open", description: "Open the current implementation plan" });
    await $.command.register({ name: "plan-updates", description: "Update the current implementation plan", argumentHint: "<changes>" });
    await $.command.register({ name: "build", description: "Start dependency-aware parallel development" });
    await $.command.register({ name: "card", description: "Open the live Agent Card pane", immediate: true });
    await $.command.register({ name: "ship", description: "Review, commit, push, open a PR, and watch CI" });

    await $.tool.register({
      name: "set_plan",
      description: "Set the Agent Card implementation plan after repository analysis. Use this when Agent Card asks you to plan. Tasks must be dependency-aware and split into two parallel feature streams when safely possible.",
      inputSchema: { type:"object", required:["title","tasks"], properties:{
        title:{type:"string"},
        tasks:{type:"array", items:{type:"object", required:["id","title","group"], properties:{ id:{type:"string"}, title:{type:"string"}, group:{type:"string"}, weight:{type:"number"}, worker:{type:"string",enum:["A","B"]} }}}
      }}
    });
    await $.tool.register({
      name: "task_update",
      description: "Update one Agent Card task as work progresses. Call when starting, completing, or blocking a planned task.",
      inputSchema: { type:"object", required:["id","status"], properties:{ id:{type:"string"}, status:{type:"string",enum:["pending","running","done","blocked"]}, message:{type:"string"} } }
    });
    await $.tool.register({
      name: "stage_update",
      description: "Update Agent Card lifecycle stage. Valid stages are plan, build, review, ship.",
      inputSchema: { type:"object", required:["stage"], properties:{ stage:{type:"string",enum:["plan","build","review","ship"]}, message:{type:"string"} } }
    });

    await $.agent.register({
      name: "builder",
      description: "Implement the saved Agent Card plan and report live task progress",
      permissionMode: "default",
      disallowedTools: ["EnterPlanMode", "ExitPlanMode"],
      prompt: "You implement an approved Agent Card plan. Inspect the repository and supplied tasks, implement only the requirement, verify the result, and update Agent Card tasks through its tools. Do not enter built-in plan mode. Do not return while delegated work is still running. If existing files already satisfy a task, verify them before marking it done. If permission or verification blocks work, mark the affected task blocked and explain why. Never mark unverified work done."
    });

    const card = await load($); updateStatus($, card);
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const build = e.agentId ? builders.get(e.agentId) : undefined;
    if (build) {
      builders.delete(e.agentId!);
      const card = await load($);
      if (!card || card.id !== build.cardId || card.planVersion !== build.version) return next(e);
      const complete = e.reason === "answer" && card.tasks.every(t => t.status === "done");
      if (complete) {
        card.stage = "review"; card.message = "Build complete; ready for review";
      } else {
        for (const task of card.tasks) if (task.status !== "done") task.status = "blocked";
        card.message = card.tasks.find(t => t.status === "blocked" && t.message)?.message ?? `Build stopped (${e.reason}); unfinished tasks need attention`;
      }
      await save($, card);
      await next(e);
      return { text: `${card.message}\n${e.answer}` };
    }
    const pending = e.agentId ? planners.get(e.agentId) : undefined;
    if (!pending) return next(e);
    planners.delete(e.agentId!);
    const { card, version } = pending;
    let text: string;
    try {
      if (activeCard?.id !== card.id || activeCard.planVersion !== version) {
        return next(e);
      }
      if (e.reason !== "answer") throw new Error(`Planner ended: ${e.reason}`);
      const report = JSON.parse(e.answer.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
      if (typeof report.title !== "string" || typeof report.analysis !== "string" || !report.analysis.trim() || !Array.isArray(report.tasks) || !report.tasks.length) throw new Error("Planner returned no repository analysis or tasks");
      const ids = new Set<string>();
      card.tasks = report.tasks.map((t: any) => {
        if (![t.id, t.title, t.group].every(v => typeof v === "string" && v.trim()) || ids.has(t.id)) throw new Error("Planner returned invalid or duplicate tasks");
        ids.add(t.id);
        return { id:t.id, title:t.title, group:t.group, status:"pending" as const, weight:typeof t.weight === "number" && t.weight > 0 ? t.weight : 1, worker:t.worker === "A" || t.worker === "B" ? t.worker : undefined };
      });
      card.title = report.title; card.stage = "plan"; card.message = "Plan ready";
      await save($, card);
      text = `${card.id}: Plan v${card.planVersion} ready with ${card.tasks.length} tasks.\n${report.analysis}\n${card.tasks.map(t => `${t.id}: ${t.title}`).join("\n")}`;
    } catch (error) {
      card.message = `Planning failed: ${String(error)}`;
      await save($, card);
      text = card.message;
    }
    await next(e);
    return { text };
  });

  on("command.run", { command: "card" }, async ($) => {
    const card = await load($);
    if (!card) return { text: "No active card. Start with /requirement <your requirement>." };
    const opened = await $.ui.open({ id: PANE_ID, title: card.id, focus: true, columns: 54 });
    return opened.isPlaced === true ? {} : { text: `Card opened but is waiting for pane space: ${opened.reason}` };
  });

  on("command.run", { command: "requirement" }, async ($, e) => {
    const requirement = e.args.trim();
    if (!requirement) {
      await $.prompt.fill({ text: "/requirement ", mode: "replace" });
      return { text: "Type the requirement after /requirement and submit it." };
    }
    const card: Card = { id: makeId(), title: requirement.split(/[.!?\n]/)[0].slice(0,72), requirement, stage:"requirements", planVersion:1, tasks:[], updatedAt:now(), message:"Analysing requirement and repository" };
    await save($, card);
    await $.ui.open({ id:PANE_ID, title:card.id, columns:54 });
    return { text: await plan($, card) };
  });

  on("command.run", { command: "plan-open" }, async ($) => {
    const card = await load($); if (!card) return { text:"No active card." };
    await $.ui.open({ id:PANE_ID, title:card.id, focus:true, columns:54 });
    return { text: card.tasks.length ? `Plan v${card.planVersion}: ${card.tasks.length} tasks. Card opened.` : "Plan is still being prepared." };
  });

  on("command.run", { command: "plan-updates" }, async ($, e) => {
    const card = await load($); if (!card) return { text:"No active card." };
    const changes = e.args.trim();
    if (!changes) { await $.prompt.fill({ text:"/plan-updates ", mode:"replace" }); return { text:"Type the requested plan changes after /plan-updates." }; }
    card.planVersion += 1; card.stage = "plan"; card.message = "Updating plan"; await save($, card);
    return { text: await plan($, card, changes) };
  });

  on("command.run", { command: "build" }, async ($) => {
    const card = await load($); if (!card) return { text:"No active card." }; if (!card.tasks.length) return { text:"Plan is not ready yet." };
    if ([...builders.values()].some(b => b.cardId === card.id)) return { text:"Build is already running." };
    const previousStage = card.stage;
    card.stage="build"; card.message="Starting build agent"; await save($,card); await $.ui.open({id:PANE_ID,title:card.id,columns:54});
    try {
      const started = await $.agent.spawn({
        subagentType:"agent-card:builder",
        description:`Build ${card.id}`,
        prompt:`Implement Agent Card ${card.id}, plan v${card.planVersion}.
Requirement: ${card.requirement}
Complete saved task list: ${JSON.stringify(card.tasks)}
Follow the plan's dependencies and verify likely file write overlap before parallel work. Parallelise only independent tasks assigned worker A/B; otherwise work sequentially. Do not add optional scope without approval. Keep integration here and wait for all delegated work to finish.
Call mcp__agent-card__task_update with each exact saved task id when starting, completing, or blocking it. Check existing implementation first: verify and complete tasks already satisfied. Run appropriate verification and review the combined diff. Do not commit, push, ship, or use built-in /plan. Return a concise report of implementation and checks; the plugin advances to review only when all saved tasks are done.`
      });
      if (started.deny || !started.agentId) throw new Error(started.deny ?? "Build agent did not start");
      builders.set(started.agentId, {cardId:card.id, version:card.planVersion});
      card.message="Build agent running"; await save($,card);
      return {text:"Build agent started with the saved plan. Task progress will update live."};
    } catch (error) {
      card.stage=previousStage; card.message=`Build failed to start: ${String(error)}`; await save($,card);
      return {text:card.message};
    }
  });

  on("command.run", { command: "ship" }, async ($) => {
    const card = await load($); if (!card) return { text:"No active card." };
    card.stage="ship"; card.message="Shipping"; await save($,card); await $.ui.open({id:PANE_ID,title:card.id,columns:54});
    void $.prompt.submit({ text:`Ship Agent Card ${card.id}. First perform a final requirement and diff review and run the relevant test/lint/typecheck gates. If any gate fails, fix it before shipping. Then create an appropriate commit without Co-Authored-By trailers, push the current feature branch, and open a pull request using the repository's normal GitHub workflow. Do not merge the PR. Report the PR and CI state, and call mcp__agent-card__stage_update with stage ship and a concise status.`, asUser:true });
    return { text:"Ship workflow started: final gate → commit → push → PR. The PR will not be merged automatically." };
  });

  on("tool.call", { tool:"mcp__agent-card__set_plan" }, async ($, e:any) => {
    const card = await load($); if (!card) return { result:JSON.stringify({ok:false,error:"No active card"}) };
    card.title = String(e.title ?? card.title); card.stage="plan";
    card.tasks = Array.isArray(e.tasks) ? e.tasks.map((t:any) => ({ id:String(t.id), title:String(t.title), group:String(t.group), status:"pending" as const, weight:typeof t.weight === "number" ? t.weight : 1, worker:t.worker === "A" || t.worker === "B" ? t.worker : undefined })) : [];
    card.message="Plan ready"; await save($,card); return { result:JSON.stringify({ok:true,cardId:card.id,tasks:card.tasks.length}) };
  });

  on("tool.call", { tool:"mcp__agent-card__task_update" }, async ($, e:any) => {
    const card = await load($); if (!card) return { result:JSON.stringify({ok:false,error:"No active card"}) };
    const task = card.tasks.find(t => t.id === String(e.id)); if (!task) return { result:JSON.stringify({ok:false,error:`Unknown task ${e.id}`}) };
    task.status=e.status; if (e.message) { task.message=String(e.message); card.message=task.message; } await save($,card); return { result:JSON.stringify({ok:true}) };
  });

  on("tool.call", { tool:"mcp__agent-card__stage_update" }, async ($, e:any) => {
    const card = await load($); if (!card) return { result:JSON.stringify({ok:false,error:"No active card"}) };
    card.stage=e.stage; if(e.message) card.message=String(e.message); await save($,card); return { result:JSON.stringify({ok:true}) };
  });

  on("ui.render", { component:"Pane", requestId:PANE_ID }, async ($, e:any) => {
    const card = await load($);
    const { Box, Text } = $.ui.resolve(e);

    if (!card) {
      return Box({
        flexDirection:"column", paddingX:2, paddingY:1,
        borderStyle:"round", borderColor:"subtle",
        children:[
          Text({bold:true, color:"claude", children:"AGENT CARD"}),
          Text({dimColor:true, children:"No active card"}),
          Text({dimColor:true, children:"Use /requirement <requirement> to begin."})
        ]
      });
    }

    const groups = [...new Set(card.tasks.map(t => t.group))];
    const pct = progress(card);
    const done = card.tasks.filter(t => t.status === "done").length;
    const running = card.tasks.filter(t => t.status === "running");
    const blocked = card.tasks.filter(t => t.status === "blocked").length;
    const stages: Stage[] = ["requirements","plan","build","review","ship"];
    const stageLabel: Record<Stage,string> = {requirements:"REQUIREMENT",plan:"PLAN",build:"BUILD",review:"REVIEW",ship:"SHIP"};
    const stageColor = card.stage === "build" ? "warning" : card.stage === "review" ? "planMode" : card.stage === "ship" ? "claude" : "success";
    const barWidth = Math.max(12, Math.min(30, Math.floor((e.props?.bodyColumns ?? 54) - 18)));
    const filled = Math.round((pct / 100) * barWidth);
    const blockedTask = card.tasks.find(t => t.status === "blocked");
    const nextTask = blockedTask ?? running[0] ?? card.tasks.find(t => t.status === "pending");
    const allDone = card.tasks.length > 0 && done === card.tasks.length;
    const nextColor = blockedTask ? "error" : nextTask ? "claude" : allDone ? "success" : "subtle";
    const nextLabel = blockedTask ? "BLOCKED  ⚠" : nextTask ? "UP NEXT  →" : allDone ? "READY  ✓" : "PLANNING  ●";

    const stageNodes:any[] = [];
    stages.forEach((s, i) => {
      const order = stages.indexOf(card.stage), pos = stages.indexOf(s);
      const complete = pos < order, current = pos === order;
      stageNodes.push(Text({
        bold: current || complete,
        color: complete ? "success" : current ? stageColor : "subtle",
        children: `${complete ? "✓" : current ? "●" : "○"} ${s === "requirements" ? "Req" : s[0].toUpperCase()+s.slice(1)}`
      }));
      if (i < stages.length - 1) stageNodes.push(Text({dimColor:true, children:" ─ "}));
    });

    const children:any[] = [
      Box({justifyContent:"space-between", alignItems:"center", children:[
        Text({bold:true, color:"subtle", children:card.id}),
        Box({borderStyle:"round", borderColor:stageColor, paddingX:1, children:
          Text({bold:true, color:stageColor, children:`● ${stageLabel[card.stage]}`})
        })
      ]}),
      Text({bold:true, wrap:"truncate", children:card.title}),
      Box({marginTop:1, flexDirection:"row", flexWrap:"wrap", children:stageNodes}),
      Box({marginTop:1, borderStyle:"round", borderColor:"subtle", paddingX:1, paddingY:0, flexDirection:"column", children:[
        Box({justifyContent:"space-between", children:[
          Text({dimColor:true, children:"PROGRESS"}),
          Text({bold:true, color:pct >= 100 ? "success" : stageColor, children:`${pct}%`})
        ]}),
        Text({color:pct >= 100 ? "success" : "claude", children:`${"█".repeat(filled)}${"░".repeat(Math.max(0,barWidth-filled))}`}),
        Box({justifyContent:"space-between", children:[
          Text({children:`TASKS  ${done}/${card.tasks.length}`}),
          Text({children:`PLAN  v${card.planVersion}`}),
          Text({color:blocked ? "error" : "success", children:blocked ? `BLOCKED ${blocked}` : "GATE  Fresh"})
        ]})
      ]})
    ];

    for (const g of groups) {
      const ts = card.tasks.filter(t => t.group === g);
      const gd = ts.filter(t => t.status === "done").length;
      const gr = ts.some(t => t.status === "running");
      const gb = ts.some(t => t.status === "blocked");
      children.push(Box({
        marginTop:1, borderStyle:"round",
        borderColor: gb ? "error" : gr ? "warning" : gd === ts.length && ts.length ? "success" : "subtle",
        paddingX:1, flexDirection:"column",
        children:[
          Box({justifyContent:"space-between", children:[
            Text({bold:true, color:gb?"error":gr?"warning":"text", children:`${gr ? "●" : gd === ts.length && ts.length ? "✓" : "▾"} ${g}`}),
            Text({bold:true, color:gd === ts.length && ts.length ? "success" : "subtle", children:`${gd}/${ts.length}`})
          ]}),
          ...ts.map(t => Box({
            key:`task-${t.id}`,
            backgroundColor:t.status === "running" ? "suggestion" : undefined,
            paddingX:t.status === "running" ? 1 : 0,
            justifyContent:"space-between",
            children:[
              Text({
                bold:t.status === "running",
                color:t.status === "done" ? "success" : t.status === "blocked" ? "error" : t.status === "running" ? "warning" : "subtle",
                wrap:"truncate",
                children:`${taskGlyph(t.status)} ${t.id} ${t.title}`
              }),
              t.worker ? Text({bold:true, color:t.worker === "A" ? "claude" : "planMode", children:`[${t.worker}]`}) : Text({children:""})
            ]
          }))
        ]
      }));
    }

    if (card.stage === "build" && card.tasks.some(t => t.worker)) {
      const workerNodes:any[] = [];
      for (const worker of ["A","B"] as const) {
        const wt = card.tasks.filter(t => t.worker === worker);
        if (!wt.length) continue;
        const wr = wt.find(t => t.status === "running");
        const wd = wt.filter(t => t.status === "done").length;
        workerNodes.push(Box({justifyContent:"space-between", children:[
          Text({color:wr ? "warning" : wd === wt.length ? "success" : "subtle", children:`${wr ? "●" : wd === wt.length ? "✓" : "○"} Worker ${worker}`}),
          Text({dimColor:true, children:`${wd}/${wt.length}`})
        ]}));
        workerNodes.push(Text({dimColor:!wr, color:wr?"warning":"subtle", wrap:"truncate", children:`   ${wr ? "↳ "+wr.title : wd === wt.length ? "Complete" : "Waiting"}`}));
      }
      children.push(Box({marginTop:1, borderStyle:"round", borderColor:"subtle", paddingX:1, flexDirection:"column", children:[
        Text({bold:true, color:"subtle", children:"WORKERS"}), ...workerNodes
      ]}));
    }

    children.push(Box({
      marginTop:1, borderStyle:"round", borderColor:nextColor, paddingX:1, flexDirection:"column",
      children:[
        Text({bold:true, color:nextColor, children:nextLabel}),
        Text({bold:!!nextTask, children:nextTask ? `${nextTask.id}  ${nextTask.title}` : (card.message ?? "Preparing the implementation plan")}),
        ...(blockedTask ? [Text({color:"error", children:blockedTask.message ?? card.message ?? "This task needs attention before work can continue."})] : [])
      ]
    }));

    if (card.message) children.push(Text({dimColor:true, wrap:"truncate", children:`${card.message}  •  ${new Date(card.updatedAt).toLocaleTimeString()}`}));

    return Box({flexDirection:"column", paddingX:1, paddingY:1, children});
  });
};
