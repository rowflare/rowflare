// One Durable Object per base: owns the base's SQLite data, applies every write,
// pushes changes to connected clients (WebSocket Hibernation) and runs batch jobs from its alarm.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { BaseStore, UserError, type Actor, type FieldInput, type MutationResult, type QueryInput, type QueryResult, type RowInput } from "./base/store";
import type { Cells, ClientMessage, Field, FieldOptions, FieldType, Member, Presence, Row, Schema, ServerMessage, ViewConfig, ViewType } from "../shared/types";
import { COLORS } from "../shared/types";
import { applyTemplate } from "./templates";
import type { LayoutItemInput, WidgetInput, WidgetPatch } from "../shared/widgets";
import { AirtableImporter, type AirtableImportInput } from "./airtable";
import { benchCommand } from "./bench";
import { AutomationRepo, STALE_AFTER, baseQuota, toPublic, type RunQuota } from "./auto/repo";
import { AiQueue } from "./ai/queue";
import { AiEngine } from "./ai/engine";
import { AI_ACTOR, AI_LIMITS, parseAnswer, WORKERS_SERVICE_ID } from "../shared/ai";
import { clearPlanCache, planFor, type LimitInfo, type PlanInfo } from "./hosting";
import { addMonthlyUsage, monthlyUsage } from "./limits";
import { useDevHosting } from "./dev-hosting";
import { AiError, callModel, type ModelImage, type ModelRequest, type ModelService } from "./ai/providers";
import { addUsage, callDeps, loadService, markRejected, workersLeft } from "./ai/services";
import { detectTriggers } from "./auto/triggers";
import { AutomationEngine } from "./auto/engine";
import { NO_NET, StepError, type AiStepRequest, type Net } from "./auto/types";
import { createNet } from "./auto/net";
import { LIMITS, RECORD_SOURCES, type Automation, type AutomationOp, type AutomationRun, type RunStatus } from "../shared/automations";
import type { AggregateInput, AggregateResult, GroupKey } from "./base/aggregate";

export type RowOp =
  | { op: "create"; tableId: string; rows: RowInput[]; afterId?: number; beforeId?: number; typecast?: boolean; source?: "import" }
  | { op: "update"; tableId: string; updates: { id: number; cells: Cells }[]; typecast?: boolean }
  | { op: "delete"; tableId: string; ids: number[] }
  | { op: "move"; tableId: string; id: number; afterId: number | null; beforeId: number | null };

const isObj = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown) => Number.isInteger(v);
const optId = (v: unknown) => v === undefined || v === null || isId(v);

/** Requests come from the API as JSON; a wrong shape is a 400, not a crash. */
function checkRowOp(op: RowOp) {
  if (!isObj(op) || typeof op.tableId !== "string") throw new UserError("Invalid request: tableId is required");
  switch (op.op) {
    case "create":
      if (!Array.isArray(op.rows) || op.rows.some(r => !isObj(r) || (r.cells !== undefined && !isObj(r.cells)))) throw new UserError("Invalid request: rows must be a list of { cells }");
      if (!optId(op.afterId) || !optId(op.beforeId)) throw new UserError("Invalid request: afterId and beforeId must be record ids");
      return;
    case "update":
      if (!Array.isArray(op.updates) || op.updates.some(u => !isObj(u) || !isId(u.id) || !isObj(u.cells))) throw new UserError("Invalid request: updates must be a list of { id, cells }");
      return;
    case "delete":
      if (!Array.isArray(op.ids) || op.ids.some(id => !isId(id))) throw new UserError("Invalid request: ids must be a list of record ids");
      return;
    case "move":
      if (!isId(op.id) || !optId(op.afterId) || !optId(op.beforeId)) throw new UserError("Invalid request: id, afterId and beforeId must be record ids");
      return;
    default:
      throw new UserError("Unknown row operation");
  }
}

export type SchemaOp =
  | { op: "createTable"; name: string; fields?: FieldInput[]; emptyRows?: number }
  | { op: "updateTable"; tableId: string; name?: string; primaryFieldId?: string }
  | { op: "deleteTable"; tableId: string }
  | { op: "createField"; tableId: string; field: FieldInput }
  | { op: "updateField"; fieldId: string; patch: { name?: string; type?: FieldType; options?: FieldOptions; description?: string } }
  | { op: "deleteField"; fieldId: string }
  | { op: "createView"; tableId: string; view: { name: string; type: ViewType; config?: ViewConfig } }
  | { op: "updateView"; viewId: string; patch: { name?: string; config?: ViewConfig; replace?: boolean } }
  | { op: "deleteView"; viewId: string }
  | { op: "createDashboard"; name: string; widgets?: WidgetInput[] }
  | { op: "updateDashboard"; dashboardId: string; name?: string; ord?: string }
  | { op: "deleteDashboard"; dashboardId: string }
  | { op: "addWidget"; dashboardId: string; widget: WidgetInput }
  | { op: "updateWidget"; dashboardId: string; widgetId: string; patch: WidgetPatch }
  | { op: "removeWidget"; dashboardId: string; widgetId: string }
  | { op: "setLayout"; dashboardId: string; items: LayoutItemInput[] };


export type Result<T> = { ok: true; value: T } | { ok: false; error: string; status?: number; limit?: LimitInfo };

const STEPS_PER_ALARM = 4;

const monthOf = (now: number) => new Date(now).toISOString().slice(0, 7);

/** Runs per base per month before the plan is known (a base object outside a workspace): AUTOMATION_MONTHLY_RUNS, "0" for no limit. */
function defaultRuns(env: Env): number {
  const v = env.AUTOMATION_MONTHLY_RUNS;
  return v === undefined || v === "" ? LIMITS.monthlyRuns : Math.max(0, Number(v) || 0);
}

export class BaseDO extends DurableObject<Env> {
  store: BaseStore;
  private importer: AirtableImporter;
  automations: AutomationRepo;
  /** Monthly runs of this base, overriding the plan; only tests set it. */
  monthlyRuns?: number;
  engine: AutomationEngine;
  /** Network side of automation steps; tests replace it. */
  net: Net = NO_NET;
  ai: { queue: AiQueue; engine: AiEngine };
  /** Model calls; tests replace it. */
  aiCall = (s: ModelService, r: ModelRequest, timeoutMs?: number) => callModel(s, r, callDeps(this.env, timeoutMs));
  private svcCache = new Map<string, { at: number; v: Awaited<ReturnType<typeof loadService>> }>();
  /** Services of the base's workspace, cached for a minute; tests replace it. */
  aiService = async (id: string) => {
    const hit = this.svcCache.get(id);
    if (hit && Date.now() - hit.at < 60_000) return hit.v;
    const ws = await this.workspaceId();
    const v = ws ? await loadService(this.env, ws, id) : null;
    this.svcCache.set(id, { at: Date.now(), v });
    return v;
  };
  /** Workers AI calls left this month by the counts stored in D1; tests replace it. */
  aiWorkersStored = async () => {
    const ws = await this.workspaceId();
    if (!ws) return 0;
    await this.refreshPlan();
    return workersLeft(this.env, ws, Date.now(), this.plan?.limits.workersAiCalls);
  };
  aiWorkersLeft = () => this.aiWorkersStored();
  /** Workers AI calls made since the last write to D1; they count toward the quota too. */
  private aiWorkersPending = () => this.aiUsage.get(WORKERS_SERVICE_ID) ?? 0;
  aiRejected = async (id: string) => {
    this.svcCache.delete(id);
    const ws = await this.workspaceId();
    if (ws) await markRejected(this.env, ws, id);
  };
  private aiUsage = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    useDevHosting(env);
    this.store = new BaseStore(ctx.storage);
    this.importer = new AirtableImporter(this.store, env);
    const queue = new AiQueue(this.store);
    this.ai = {
      queue,
      engine: new AiEngine({
        store: this.store,
        queue,
        service: id => this.aiService(id),
        call: (s, r) => this.aiCall(s, r),
        images: files => this.readImages(files),
        canRun: () => this.canRun(),
        workersLeft: () => this.aiWorkersLeft(),
        workersPending: () => this.aiWorkersPending(),
        usage: id => void this.aiUsage.set(id, (this.aiUsage.get(id) ?? 0) + 1),
        rejected: id => this.aiRejected(id),
        publish: results => results.forEach(r => this.broadcastResult(r, AI_ACTOR)),
        publishStates: () => this.publishAiStates(),
      }),
    };
    this.store.rowStates = (tableId, ids) => this.ai.queue.states(tableId, ids);
    this.store.recordLimit = () => {
      const n = this.plan?.limits.recordsPerBase;
      return n === undefined ? undefined : { limit: n, upgradeUrl: this.plan?.upgradeUrl };
    };
    this.automations = new AutomationRepo(this.store);
    this.store.buttonsOf = () => this.automations.buttons();
    this.engine = new AutomationEngine({
      store: this.store,
      repo: this.automations,
      net: () => this.net,
      baseUrl: () => this.baseUrl(),
      quota: () => this.runQuota(),
      publish: results => {
        for (const r of results) this.broadcastResult(r);
      },
      canRun: () => this.canRun(),
      automationsChanged: () => {
        this.broadcast({ type: "schema", schema: this.store.schema() });
        this.broadcast({ type: "automations" });
      },
    });
    this.automations.onChange = (id, now) => this.engine.resetTimer(id, now);
    this.store.onWrite = w => {
      if (w.fire) detectTriggers(this.store, this.automations, w, Date.now(), this.runQuota());
      this.ai.queue.onWrite(w, Date.now());
      for (const tableId of new Set(w.rows.map(r => r.tableId))) this.engine.touchDates(tableId, w.rows.filter(r => r.tableId === tableId));
    };
    this.net = createNet(env, () => this.workspaceId(), { ai: (req, timeoutMs) => this.automationAi(req, timeoutMs) });
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  private safe<T>(fn: () => T): Result<T> {
    try {
      return { ok: true, value: fn() };
    } catch (e) {
      if (e instanceof UserError) return e.limit ? { ok: false, error: e.message, status: e.status, limit: e.limit } : { ok: false, error: e.message };
      throw e;
    }
  }

  // ---------- plan ----------

  /** The workspace's plan, refreshed at most once a minute before writes and in the alarm. */
  plan?: PlanInfo;
  private planAt = 0;

  private async refreshPlan(): Promise<void> {
    const ws = await this.workspaceId();
    if (!ws) return;
    if (!this.plan || Date.now() - this.planAt >= 60_000) {
      try {
        this.plan = await planFor(this.env, ws);
        this.planAt = Date.now();
      } catch (e) {
        // Keep working with the last plan while the hosting cannot answer; try again in 10 seconds.
        if (!this.plan) throw e;
        console.error("plan lookup failed, using the last plan", e);
        this.planAt = Date.now() - 50_000;
      }
    }
    // Other bases count runs into D1 too; a base with automations reads the total before each write that may queue runs.
    if (this.plan?.limits.automationRuns?.per === "workspace" && this.automations.anyEnabled()) {
      const month = monthOf(Date.now());
      try {
        this.wsRuns.used = await monthlyUsage(this.env, ws, "automationRuns", month);
        this.wsRuns.month = month;
      } catch (e) {
        console.error("run count lookup failed", e);
      }
    }
  }

  /**
   * Runs of the whole workspace this month: the count in D1 (read before writes, webhooks and alarms, and after each flush)
   * plus this base's runs not yet written. Runs other bases queued but have not written yet (about a second) are not seen.
   */
  private wsRuns = { month: "", used: 0, pending: new Map<string, number>() };

  private workspaceRuns(now: number): number {
    const month = monthOf(now);
    return (this.wsRuns.month === month ? this.wsRuns.used : 0) + (this.wsRuns.pending.get(month) ?? 0);
  }

  /** The run quota from the plan: counted in this base, or across the workspace. */
  runQuota(): RunQuota {
    if (this.monthlyRuns !== undefined) return baseQuota(this.automations, this.monthlyRuns);
    const limit = this.plan ? this.plan.limits.automationRuns : { per: "base" as const, n: defaultRuns(this.env) };
    if (!limit || limit.per === "base") return baseQuota(this.automations, limit?.n ?? 0);
    const n = limit.n;
    return {
      check: now => (n > 0 && this.workspaceRuns(now) >= n ? `This workspace used its ${n.toLocaleString("en-US")} automation runs for this month` : null),
      take: now => void this.wsRuns.pending.set(monthOf(now), (this.wsRuns.pending.get(monthOf(now)) ?? 0) + 1),
    };
  }

  /** Writes this base's workspace runs to D1; failed writes are kept for the next alarm. */
  private async flushRuns(): Promise<void> {
    if (!this.wsRuns.pending.size) return;
    const ws = await this.workspaceId();
    const pending = new Map(this.wsRuns.pending);
    this.wsRuns.pending.clear();
    if (!ws) return;
    for (const [month, n] of pending) {
      try {
        const total = await addMonthlyUsage(this.env, ws, "automationRuns", month, n);
        if (month === monthOf(Date.now())) Object.assign(this.wsRuns, { month, used: total });
      } catch (e) {
        console.error("run count write failed", e);
        this.wsRuns.pending.set(month, (this.wsRuns.pending.get(month) ?? 0) + n);
      }
    }
  }

  /** The hosting changed this workspace's plan (an upgrade or a downgrade); the next write reads it again. */
  async planChanged(): Promise<void> {
    const ws = await this.workspaceId();
    if (ws) clearPlanCache(ws);
    this.planAt = 0;
    this.plan = undefined;
  }

  /** Records in the base, its automation runs this month and its workspace runs not yet written to D1, for the usage page. */
  usageSummary(): { records: number; runs: number; pendingRuns: number } {
    const now = Date.now();
    return { records: this.store.totalRows(), runs: this.automations.usage(now), pendingRuns: this.wsRuns.pending.get(monthOf(now)) ?? 0 };
  }

  /** An uploaded file and the size R2 reported, so storage counts never trust sizes written into cells. */
  noteFile(key: string, size: number): void {
    this.store.noteFile(key, size, Date.now());
  }

  /** This base's share of the workspace's storage, and files no cell has used for a week (see BaseStore.storageScan). */
  storageScan(now: number): { bytes: number; sweep: string[] } {
    return this.store.storageScan(now);
  }

  filesSwept(keys: string[]): void {
    this.store.filesSwept(keys);
  }

  // ---------- lifecycle ----------

  async init(baseId: string, opts: { template?: string; members?: Member[]; actor?: Actor } = {}): Promise<Schema> {
    if (!this.store.initialized) {
      this.store.init(baseId);
      if (opts.members) this.store.setMembers(opts.members);
      applyTemplate(this.store, opts.template ?? "blank", opts.actor);
      await this.kickJobs();
    }
    return this.store.schema();
  }

  async destroy(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(1001, "Base deleted");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  setMembers(members: Member[]) {
    this.store.setMembers(members);
  }

  // ---------- reads ----------

  schema(): Schema {
    return this.store.schema();
  }

  query(tableId: string, q: QueryInput): Result<QueryResult> {
    return this.safe(() => this.store.query(tableId, q));
  }

  rows(tableId: string, ids: number[]): Result<Row[]> {
    return this.safe(() => this.store.getRows(tableId, ids));
  }

  aggregate(tableId: string, input: AggregateInput): Result<AggregateResult> {
    return this.safe(() => this.store.aggregate(tableId, input));
  }

  aggregateRecords(tableId: string, input: AggregateInput, key: GroupKey[]): Result<{ ids: number[]; truncated: boolean }> {
    return this.safe(() => this.store.aggregateRecords(tableId, input, key));
  }


  exportCsv(tableId: string, viewId?: string): Result<string> {
    return this.safe(() => this.store.exportCsv(tableId, viewId));
  }

  findTable(idOrName: string): { id: string; name: string } | null {
    const t = this.store.findTable(idOrName);
    return t ? { id: t.id, name: t.name } : null;
  }

  // ---------- writes ----------

  async rowOp(actor: Actor, op: RowOp, clientId?: string): Promise<Result<MutationResult>> {
    await this.refreshPlan();
    const res = this.safe(() => {
      checkRowOp(op);
      switch (op.op) {
        case "create":
          if (op.rows.length > 5000) throw new UserError("At most 5,000 records per request");
          return this.store.createRows(actor, op.tableId, op.rows, { afterId: op.afterId, beforeId: op.beforeId, typecast: op.typecast, noTriggers: op.source === "import" });
        case "update":
          if (op.updates.length > 5000) throw new UserError("At most 5,000 records per request");
          return this.store.updateRows(actor, op.tableId, op.updates, { typecast: op.typecast });
        case "delete":
          return this.store.deleteRows(actor, op.tableId, op.ids);
        case "move":
          return this.store.moveRow(actor, op.tableId, op.id, op.afterId, op.beforeId);
      }
    });
    if (res.ok) {
      this.broadcastResult(res.value, actor, clientId);
      this.publishAiStates();
      await this.kickJobs();
    }
    return res;
  }

  /** Whether `count` more records fit, so the app can refuse an import or paste before writing any of it. */
  async checkRoom(count: number): Promise<Result<true>> {
    await this.refreshPlan();
    return this.safe(() => {
      this.store.checkRoom(Math.max(0, Math.floor(Number(count) || 0)));
      return true as const;
    });
  }

  async schemaOp(actor: Actor, op: SchemaOp, clientId?: string): Promise<Result<{ schema: Schema; id?: string; result?: MutationResult }>> {
    await this.refreshPlan();
    const res = this.safe(() => {
      const s = this.store;
      switch (op.op) {
        case "createTable": {
          const { tableId, result } = s.createTable(actor, { name: op.name, fields: op.fields, emptyRows: op.emptyRows === 0 ? 0 : undefined });
          return { schema: result.schema!, id: tableId, result };
        }
        case "updateTable":
          return { schema: s.updateTable(op.tableId, op) };
        case "deleteTable":
          return { schema: s.deleteTable(op.tableId) };
        case "createField": {
          const r = s.createField(op.tableId, op.field);
          return { schema: r.schema, id: r.fieldId };
        }
        case "updateField":
          return { schema: s.updateField(op.fieldId, op.patch) };
        case "deleteField":
          return { schema: s.deleteField(op.fieldId) };
        case "createView": {
          const r = s.createView(op.tableId, op.view);
          return { schema: r.schema, id: r.viewId };
        }
        case "updateView":
          return { schema: s.updateView(op.viewId, op.patch) };
        case "deleteView":
          return { schema: s.deleteView(op.viewId) };
        case "createDashboard": {
          const r = s.createDashboard({ name: op.name, widgets: op.widgets });
          return { schema: r.schema, id: r.dashboardId };
        }
        case "updateDashboard":
          return { schema: s.updateDashboard(op.dashboardId, { name: op.name, ord: op.ord }) };
        case "deleteDashboard":
          return { schema: s.deleteDashboard(op.dashboardId) };
        case "addWidget": {
          const r = s.addWidget(op.dashboardId, op.widget);
          return { schema: r.schema, id: r.widgetId };
        }
        case "updateWidget":
          return { schema: s.updateWidget(op.dashboardId, op.widgetId, op.patch) };
        case "removeWidget":
          return { schema: s.removeWidget(op.dashboardId, op.widgetId) };
        case "setLayout":
          return { schema: s.setLayout(op.dashboardId, op.items) };

        default:
          throw new UserError("Unknown schema operation");
      }
    });
    if (res.ok) {
      if (op.op === "deleteField" || op.op === "updateField" || op.op === "deleteTable") this.ai.queue.prune();
      // A fixed prompt or a new service: cells that were waiting for the field run now.
      if (op.op === "updateField") this.ai.queue.resume(op.fieldId, Date.now());
      this.broadcast({ type: "schema", schema: res.value.schema, clientId });
      // Inline jobs may have rewritten rows of small tables; clients reload affected tables.
      if (op.op === "createField" || op.op === "updateField" || op.op === "deleteField") {
        const tableId = op.op === "createField" ? op.tableId : res.value.schema.fields.find(f => f.id === (op as { fieldId: string }).fieldId)?.tableId;
        for (const t of res.value.schema.tables) if (t.id === tableId || op.op !== "createField") this.broadcast({ type: "reload", tableId: t.id });
      }
      if (res.value.result) this.broadcastResult(res.value.result, actor, clientId);
      await this.kickJobs();
    }
    return res;
  }

  async startAirtableImport(actor: Actor, input: AirtableImportInput): Promise<Result<{ jobId: number }>> {
    try {
      const jobId = await this.importer.start(actor, input);
      await this.kickJobs();
      return { ok: true, value: { jobId } };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Load-test hooks; only reachable through the token-guarded /api/_bench routes. */
  async bench(cmd: string, args: Record<string, number>): Promise<unknown> {
    if (!this.env.BENCH_TOKEN) throw new Error("Bench disabled");
    return benchCommand(this.store, cmd, args, { repo: this.automations, engine: this.engine, ai: this.ai.queue });
  }

  // ---------- automations ----------

  async automationList(origin: string): Promise<{ automations: Automation[]; usage: { used: number; limit: number; per: "base" | "workspace" }; origin: string }> {
    await this.refreshPlan();
    this.store.setMeta("origin", origin);
    const now = Date.now();
    const plan = this.monthlyRuns !== undefined ? { per: "base" as const, n: this.monthlyRuns } : this.plan ? this.plan.limits.automationRuns : { per: "base" as const, n: defaultRuns(this.env) };
    const usage = plan?.per === "workspace" ? { used: this.workspaceRuns(now), limit: plan.n, per: plan.per } : { used: this.automations.usage(now), limit: plan?.n ?? 0, per: "base" as const };
    return { automations: this.automations.withLastRun(), usage, origin };
  }

  async automationOp(actor: Actor, op: AutomationOp, origin: string): Promise<Result<{ id?: string; automations: Automation[] }>> {
    this.store.setMeta("origin", origin);
    const res = this.safe(() => this.automations.apply(actor, op, Date.now()));
    if (!res.ok) return res;
    // Button stubs travel with the schema; editors refetch definitions on "automations".
    this.broadcast({ type: "schema", schema: this.store.schema() });
    this.broadcast({ type: "automations" });
    await this.wake();
    return { ok: true, value: { id: res.value.id, automations: this.automations.withLastRun() } };
  }

  automationRuns(id: string, q: { status?: string; before?: number; limit: number }): Result<AutomationRun[]> {
    return this.safe(() => {
      this.automations.get(id);
      return this.automations.runs(id, q);
    });
  }
  /** Times of webhook calls in the last minute (a sliding window, so no burst fits across a minute boundary). */
  private hookCalls: number[] = [];

  /** An incoming webhook call; answers right away and leaves the run to the alarm. */
  async webhook(token: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const a = this.automations.byToken(token);
    if (!a || !a.enabled) return { status: 404, body: { error: "Webhook not found" } };
    const t = Date.now();
    while (this.hookCalls.length && this.hookCalls[0] <= t - 60_000) this.hookCalls.shift();
    if (this.hookCalls.length >= LIMITS.webhookPerMinute) return { status: 429, body: { error: `At most ${LIMITS.webhookPerMinute} webhook calls per minute per base` } };
    this.hookCalls.push(t);
    await this.refreshPlan();
    const now = Date.now();
    const runId = this.automations.enqueue(a, { type: "webhook", body, at: now }, [a.id], now, this.runQuota());
    await this.wake();
    return { status: 202, body: { runId } };
  }

  /** A button click: runs right away so the person sees the result. Viewers get only the outcome, not the step log. */
  async runButton(actor: Actor, id: string, recordId: number, canEdit: boolean, tableId?: string): Promise<Result<{ id: number; status: RunStatus; error: string | null }>> {
    await this.refreshPlan();
    const a = this.automations.all().find(x => x.id === id);
    const t = a?.config.trigger;
    if (!a || t?.type !== "button") return { ok: false, error: "Automation not found", status: 404 };
    if (!canEdit && !t.viewerCanRun) return { ok: false, error: "You cannot run this automation", status: 403 };
    if (!a.enabled) return { ok: false, error: "This automation is turned off" };
    // A Button field keeps its automation after the automation's table changes; it must not run on another table's record of the same id.
    if (tableId !== undefined && tableId !== t.tableId) return { ok: false, error: "This button's automation runs on another table" };
    if (!this.store.maybeTable(t.tableId) || !this.store.getRows(t.tableId, [recordId]).length) return { ok: false, error: "Record not found", status: 404 };
    const now = Date.now();
    const runId = this.automations.enqueue(a, { type: "button", tableId: t.tableId, recordId, at: now, by: actor.userId }, [a.id], now, this.runQuota());
    const queued = this.automations.getRun(runId)!;
    // The run executes inline; an alarm for when it would count as cut off picks it up again after an eviction.
    if (queued.status === "queued") await this.wake(Date.now() + STALE_AFTER);
    const run = queued.status === "queued" ? await this.engine.execute(runId) : queued;
    await this.wake();
    return { ok: true, value: { id: run.id, status: run.status, error: run.error } };
  }

  /** Runs an automation once with a chosen record or sample body; writes are real, nothing else is triggered, nothing is counted. */
  async testRun(actor: Actor, id: string, input: { recordId?: number; body?: unknown }): Promise<Result<AutomationRun>> {
    await this.refreshPlan();
    const a = this.automations.all().find(x => x.id === id);
    if (!a) return { ok: false, error: "Automation not found", status: 404 };
    const t = a.config.trigger;
    const tableId = "tableId" in t ? t.tableId : undefined;
    let recordId: number | undefined;
    if (tableId && RECORD_SOURCES.has(t.type)) {
      recordId = Number(input?.recordId);
      if (!Number.isInteger(recordId) || !this.store.maybeTable(tableId) || !this.store.getRows(tableId, [recordId]).length) return { ok: false, error: "Choose a record to test with" };
    }
    const now = Date.now();
    const trigger = { type: t.type, tableId, recordId, body: t.type === "webhook" ? input?.body ?? {} : undefined, at: now, by: actor.userId };
    const runId = this.automations.insertRun({ automation: a, status: "running", test: true, trigger, chain: [a.id], now });
    return { ok: true, value: toPublic(await this.engine.execute(runId)) };
  }

  /** Puts a failed run back in the queue; it resumes at the step that failed. */
  async retryRun(runId: number): Promise<Result<{ runId: number }>> {
    const run = this.automations.getRun(runId);
    if (!run) return { ok: false, error: "Run not found", status: 404 };
    if (run.status !== "failed" || run.test) return { ok: false, error: "Only failed runs can be run again" };
    // Someone who fixed the automation expects the fix to apply; finished steps are matched by their stable ids.
    const a = this.automations.all().find(x => x.id === run.automationId);
    const snapshot = a ? { name: a.name, config: a.config } : undefined;
    this.automations.saveRun(runId, { status: "queued", attempt: 0, error: null, nextAt: null, finishedAt: null, snapshot });
    await this.wake();
    return { ok: true, value: { runId } };
  }

  baseUrl(): string {
    return `${this.env.APP_URL || this.store.meta("origin") || ""}/base/${this.store.meta("baseId") ?? ""}`;
  }
  /** Whether automations and AI may run for this workspace; always true in the app, tests replace it to pause them. */
  canRun = async (): Promise<boolean> => true;

  private wsId?: string | null;
  /** The base's workspace, for mail credentials; looked up once per object. */
  private async workspaceId(): Promise<string | null> {
    if (this.wsId === undefined) {
      const row = await this.env.DB.prepare("SELECT workspace_id FROM bases WHERE id = ?").bind(this.store.meta("baseId") ?? "").first<{ workspace_id: string }>();
      this.wsId = row?.workspace_id ?? null;
    }
    return this.wsId;
  }



  // ---------- AI fields ----------

  private async readImages(files: { key: string; type: string }[]): Promise<ModelImage[]> {
    const out: ModelImage[] = [];
    for (const f of files) {
      const obj = await this.env.FILES.get(f.key);
      if (!obj) continue;
      const bytes = new Uint8Array(await obj.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      out.push({ type: f.type, data: btoa(bin) });
    }
    return out;
  }

  private lastProgress = "";
  /** Pushes rows whose AI state changed and the per-field progress. */
  private publishAiStates() {
    for (const tableId of this.ai.queue.reload) {
      this.broadcast({ type: "reload", tableId });
      this.ai.queue.touched.delete(tableId);
    }
    this.ai.queue.reload.clear();
    for (const [tableId, ids] of this.ai.queue.touched) {
      const list = [...ids];
      if (this.store.maybeTable(tableId)) for (let i = 0; i < list.length; i += 500) this.broadcast({ type: "rows", tableId, rows: this.store.getRows(tableId, list.slice(i, i + 500)) });
    }
    this.ai.queue.touched.clear();
    const progress = this.ai.queue.progress();
    const text = JSON.stringify(progress);
    if (text !== this.lastProgress) {
      this.lastProgress = text;
      this.broadcast({ type: "aiProgress", progress });
    }
  }

  /** Services changed (a key was saved again): entries that were waiting look again now. */
  async aiWake(): Promise<void> {
    this.svcCache.clear();
    // Entries waiting for a service come back now; retries keep their back-off.
    this.store.sql.exec("UPDATE _ai_queue SET due_at = ? WHERE due_at > ? AND tries = 0", Date.now(), Date.now() + AI_LIMITS.debounce);
    await this.wake();
  }

  private aiField(tableId: string, fieldId: string) {
    const f = this.store.maybeField(fieldId);
    if (!f || f.tableId !== tableId) throw new UserError("Field not found");
    if (!f.options.ai) throw new UserError("This is not an AI field");
    return f;
  }

  async aiGenerate(tableId: string, fieldId: string, input: { rowIds?: number[]; missingOnly?: boolean }): Promise<Result<{ queued: number }>> {
    const res = this.safe(() => {
      this.aiField(tableId, fieldId);
      const now = Date.now();
      if (Array.isArray(input?.rowIds)) {
        if (input.rowIds.length > 5000) throw new UserError("At most 5,000 records per request");
        const ids = this.store.getRows(tableId, input.rowIds.filter(Number.isInteger)).map(r => r.id);
        this.ai.queue.enqueue(tableId, fieldId, ids, now, true);
        return { queued: ids.length };
      }
      return { queued: this.ai.queue.enqueueColumn(tableId, fieldId, !!input?.missingOnly, now) };
    });
    if (res.ok) {
      this.publishAiStates();
      await this.wake();
    }
    return res;
  }

  async aiStop(fieldId: string): Promise<Result<{ ok: true }>> {
    this.ai.queue.stop(fieldId);
    this.publishAiStates();
    return { ok: true, value: { ok: true } };
  }

  aiStatus(tableId: string, fieldId: string) {
    return this.safe(() => {
      const f = this.aiField(tableId, fieldId);
      return { ...this.ai.queue.status(tableId, fieldId), broken: this.store.aiBroken(f) };
    });
  }

  async aiPreview(tableId: string, rowId: number, field: { type: FieldType; options: FieldOptions }): Promise<Result<{ answer: string; value: unknown; error?: string; prompt: string; cut: boolean }>> {
    let draft: Field;
    const res = this.safe(() => {
      draft = this.store.draftField(tableId, field);
      const row = this.store.getRows(tableId, [rowId])[0];
      if (!row) throw new UserError("Record not found");
      return row;
    });
    if (!res.ok) return res;
    const svc = await this.aiService(draft!.options.ai!.serviceId);
    if (!svc) return { ok: false, error: "Choose an AI service" };
    const { req, cut } = await this.ai.engine.request(draft!, res.value);
    try {
      this.aiUsage.set(svc.id, (this.aiUsage.get(svc.id) ?? 0) + 1);
      const answer = await this.aiCall(svc, req);
      const parsed = parseAnswer(draft!, answer);
      return { ok: true, value: parsed.ok ? { answer, value: parsed.value, prompt: req.prompt, cut } : { answer, value: null, error: parsed.error, prompt: req.prompt, cut } };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      await this.wake(Date.now() + 1000);
    }
  }

  /** The AI step of automations: the base's services, usage and quota. */
  private async automationAi(req: AiStepRequest, timeoutMs: number): Promise<{ text: string }> {
    const svc = await this.aiService(req.serviceId);
    if (!svc) throw new StepError("The AI service no longer exists");
    if (svc.keyRejected) throw new StepError("The AI service's key was rejected");
    if (svc.kind === "workers" && (await this.aiWorkersLeft()) - this.aiWorkersPending() <= 0) throw new StepError("This month's Workers AI quota is used up");
    this.aiUsage.set(svc.id, (this.aiUsage.get(svc.id) ?? 0) + 1);
    try {
      return { text: await this.aiCall(svc, { system: req.system, prompt: req.prompt, images: [], model: req.model }, timeoutMs) };
    } catch (e) {
      if (e instanceof AiError) {
        if (e.kind === "auth") await this.aiRejected(svc.id);
        throw new StepError(e.message, e.kind === "retry");
      }
      throw e;
    }
  }

  // ---------- jobs ----------

  private async kickJobs() {
    if (this.store.hasJobs()) this.broadcast({ type: "jobs", jobs: this.store.jobs() });
    await this.wake();
  }

  /** Sets the alarm to the earliest pending work: background jobs, then automation runs and timers. */
  private async wake(also?: number) {
    let next = this.engine.nextWake();
    const ai = this.ai.engine.nextWake();
    if (ai !== null) next = Math.min(next ?? Infinity, ai);
    if (also !== undefined) next = Math.min(next ?? Infinity, also);
    if (this.store.hasJobs()) next = Math.min(next ?? Infinity, Date.now() + 10);
    if (this.wsRuns.pending.size) next = Math.min(next ?? Infinity, Date.now() + 1000);
    if (next === null) return;
    const at = Math.max(next, Date.now());
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  override async alarm() {
    await this.refreshPlan();
    if (this.store.hasJobs()) {
      for (let i = 0; i < STEPS_PER_ALARM; i++) {
        const job = this.store.peekJob();
        if (!job) break;
        let step: { more: boolean; result?: MutationResult; finished?: { tableId?: string }; schemaChanged?: boolean };
        if (job.kind === "airtable") {
          step = await this.importer.step(job.id, JSON.parse(job.payload));
          if (step.schemaChanged) this.broadcast({ type: "schema", schema: this.store.schema() });
        } else step = this.store.runJobStep();
        if (step.result) this.broadcastResult(step.result);
        if (step.finished?.tableId) this.broadcast({ type: "reload", tableId: step.finished.tableId });
        if (!step.more) break;
        // Imports wait on the network; give other requests a turn between batches.
        if (job.kind === "airtable") break;
      }
      const jobs = this.store.jobs();
      this.broadcast({ type: "jobs", jobs });
      if (!jobs.length) this.broadcast({ type: "schema", schema: this.store.schema() });
    }
    this.engine.enqueueDue(Date.now());
    await this.engine.drain();
    await this.ai.engine.drain();
    await this.flushRuns();
    if (this.aiUsage.size) {
      const counts = new Map(this.aiUsage);
      this.aiUsage.clear();
      const ws = await this.workspaceId();
      if (ws) await addUsage(this.env, ws, counts, Date.now()).catch(() => undefined);
    }
    await this.wake();
  }

  // ---------- realtime ----------

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const userId = req.headers.get("x-user-id") ?? "";
    const name = req.headers.get("x-user-name") ?? "Guest";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const sid = crypto.randomUUID().slice(0, 8);
    const color = COLORS[Math.abs(hash(userId)) % COLORS.length];
    this.ctx.acceptWebSocket(server, [userId]);
    server.serializeAttachment({ sid, userId, name, color } satisfies Presence);
    queueMicrotask(() => this.broadcastPresence());
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string" || message.length > 2000) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (msg.type === "cursor") {
      const p = ws.deserializeAttachment() as Presence;
      const next: Presence = { ...p, tableId: msg.tableId, rowId: msg.rowId, fieldId: msg.fieldId };
      ws.serializeAttachment(next);
      this.broadcast({ type: "cursor", user: next }, ws);
    }
  }

  override async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code, "closed");
    } catch {
      // Already closed.
    }
    this.broadcastPresence(ws);
  }

  override async webSocketError(ws: WebSocket) {
    this.broadcastPresence(ws);
  }

  private broadcastPresence(except?: WebSocket) {
    const users = this.ctx
      .getWebSockets()
      .filter(ws => ws !== except && ws.readyState === WebSocket.OPEN)
      .map(ws => ws.deserializeAttachment() as Presence);
    this.broadcast({ type: "presence", users }, except);
  }

  private broadcast(msg: ServerMessage, except?: WebSocket) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {
        // Socket is closing; presence is refreshed on close.
      }
    }
  }

  private broadcastResult(result: MutationResult, actor?: Actor, clientId?: string) {
    const plan = BaseStore.broadcastPlan(result);
    for (const c of plan.rows) if (c.rows.length) this.broadcast({ type: "rows", tableId: c.tableId, rows: c.rows, by: actor?.userId, clientId });
    for (const tableId of plan.reload) this.broadcast({ type: "reload", tableId });
    for (const d of result.deleted) this.broadcast({ type: "deleted", tableId: d.tableId, ids: d.ids, by: actor?.userId, clientId });
    if (result.schema) this.broadcast({ type: "schema", schema: result.schema, clientId });
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
