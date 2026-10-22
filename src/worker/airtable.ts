// Direct import from Airtable through its Web API, run as a resumable job from the base's alarm.
// Phases: schema (tables + plain fields) -> records (pages of 100) -> links -> computed fields -> done.
import type { Env } from "./env";
import type { Actor, BaseStore, FieldInput } from "./base/store";
import { UserError } from "./base/store";
import type { Attachment, FieldOptions, FieldType } from "../shared/types";
import { COLORS } from "../shared/types";
import { rollupFnFromAirtable } from "../shared/rollup";
import { newAttachmentId, newChoiceId } from "../shared/ids";

export interface AirtableImportInput {
  token: string;
  airtableBaseId: string;
}

interface AtField {
  id: string;
  name: string;
  type: string;
  options?: Record<string, any>;
}

interface AtTable {
  id: string;
  name: string;
  primaryFieldId: string;
  fields: AtField[];
}

interface State {
  phase: "schema" | "records" | "links" | "linkfill" | "computed" | "done";
  cursor?: number;
  token: string;
  atBase: string;
  tables: AtTable[];
  tableMap: Record<string, string>; // airtable table id -> rowflare table id
  fieldMap: Record<string, string>; // airtable field id -> rowflare field id
  tableIndex: number;
  offset?: string;
  imported: number;
  actor: Actor;
  baseId: string;
}

const API = "https://api.airtable.com/v0";

const PLAIN: Record<string, FieldType> = {
  singleLineText: "text",
  email: "email",
  url: "url",
  phoneNumber: "phone",
  multilineText: "longText",
  richText: "longText",
  number: "number",
  currency: "number",
  percent: "number",
  rating: "number",
  duration: "number",
  count: "number",
  singleSelect: "singleSelect",
  multipleSelects: "multiSelect",
  date: "date",
  dateTime: "date",
  checkbox: "checkbox",
  multipleAttachments: "attachment",
  createdTime: "createdTime",
  lastModifiedTime: "modifiedTime",
  autoNumber: "autonumber",
  singleCollaborator: "text",
  multipleCollaborators: "text",
  createdBy: "text",
  lastModifiedBy: "text",
  barcode: "text",
  button: "text",
};

export class AirtableImporter {
  constructor(private store: BaseStore, private env: Env) {}

  private async call(token: string, path: string): Promise<any> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 429) {
        // Airtable allows 5 requests per second per base and asks for a 30 s back-off.
        await new Promise(r => setTimeout(r, 30000));
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        throw new UserError(`Airtable API ${res.status}: ${body.slice(0, 200)}`);
      }
      return res.json();
    }
    throw new UserError("Airtable rate limit, try again later");
  }

  async start(actor: Actor, input: AirtableImportInput): Promise<number> {
    const token = input.token?.trim();
    const atBase = input.airtableBaseId?.trim().match(/app[A-Za-z0-9]{14}/)?.[0];
    if (!token || !atBase) throw new UserError("Paste a personal access token and a base id that starts with app");
    const meta = await this.call(token, `/meta/bases/${atBase}/tables`);
    const tables: AtTable[] = meta.tables ?? [];
    if (!tables.length) throw new UserError("No tables found in that base");
    const state: State = { phase: "schema", token, atBase, tables, tableMap: {}, fieldMap: {}, tableIndex: 0, imported: 0, actor, baseId: this.store.meta("baseId") ?? "" };
    this.store.enqueueJob("airtable", "Importing from Airtable", state, 0);
    return this.store.one<{ id: number }>("SELECT max(id) id FROM _jobs")!.id;
  }

  private save(jobId: number, state: State, label?: string) {
    this.store.sql.exec("UPDATE _jobs SET payload = ?, done = ?, label = coalesce(?, label) WHERE id = ?", JSON.stringify(state), state.imported, label ?? null, jobId);
  }

  async step(jobId: number, state: State): Promise<{ more: boolean; schemaChanged?: boolean; finished?: { tableId?: string } }> {
    try {
      switch (state.phase) {
        case "schema":
          this.createSchema(state);
          state.phase = "records";
          this.save(jobId, state, "Importing records");
          return { more: true, schemaChanged: true };
        case "records": {
          const done = await this.importPage(state);
          if (done) {
            state.tableIndex++;
            state.offset = undefined;
            if (state.tableIndex >= state.tables.length) {
              state.phase = "links";
              state.tableIndex = 0;
            }
          }
          this.save(jobId, state, `Importing records (${state.imported})`);
          return { more: true };
        }
        case "links":
          this.createLinks(state);
          state.phase = "linkfill";
          state.cursor = 0;
          this.save(jobId, state, "Linking records");
          return { more: true, schemaChanged: true };
        case "linkfill":
          if (this.fillLinks(state)) state.phase = "computed";
          this.save(jobId, state);
          return { more: true };
        case "computed":
          this.createComputed(state);
          this.store.sql.exec("DELETE FROM _jobs WHERE id = ?", jobId);
          this.store.sql.exec("DROP TABLE IF EXISTS _at_ids");
          this.store.sql.exec("DROP TABLE IF EXISTS _at_defer");
          return { more: this.store.hasJobs(), schemaChanged: true };
        default:
          this.store.sql.exec("DELETE FROM _jobs WHERE id = ?", jobId);
          return { more: this.store.hasJobs() };
      }
    } catch (e) {
      // Leave what was imported and report the error in the job label.
      this.store.sql.exec("DELETE FROM _jobs WHERE id = ?", jobId);
      this.store.setMeta("lastImportError", e instanceof Error ? e.message : String(e));
      return { more: this.store.hasJobs(), schemaChanged: true };
    }
  }

  private plainField(f: AtField): FieldInput {
    const type = PLAIN[f.type] ?? "text";
    const options: FieldOptions = {};
    const o = f.options ?? {};
    if (type === "singleSelect" || type === "multiSelect") {
      options.choices = (o.choices ?? []).map((c: { name: string }, i: number) => ({ id: newChoiceId(), name: c.name, color: COLORS[i % COLORS.length] }));
    }
    if (type === "number") {
      if (typeof o.precision === "number") options.precision = o.precision;
      if (f.type === "currency") { options.format = "currency"; options.symbol = o.symbol ?? "$"; }
      if (f.type === "percent") options.format = "percent";
    }
    if (f.type === "dateTime") options.includeTime = true;
    return { name: f.name, type, options };
  }

  private createSchema(state: State) {
    this.store.sql.exec("CREATE TABLE IF NOT EXISTS _at_ids (at TEXT PRIMARY KEY, tbl TEXT NOT NULL, id INTEGER NOT NULL)");
    // Values of fields created after the records (links, formulas), keyed by our row id.
    this.store.sql.exec("CREATE TABLE IF NOT EXISTS _at_defer (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, id INTEGER NOT NULL, field TEXT NOT NULL, val TEXT NOT NULL)");
    const existing = this.store.schema().tables;
    for (const t of state.tables) {
      const primary = t.fields.find(f => f.id === t.primaryFieldId) ?? t.fields[0];
      const deferred = new Set(["multipleRecordLinks", "lookup", "multipleLookupValues", "rollup", "formula"]);
      const primaryInput: FieldInput = deferred.has(primary.type) ? { name: primary.name, type: "text" } : this.plainField(primary);
      if (["attachment", "checkbox", "createdTime", "modifiedTime", "autonumber"].includes(primaryInput.type)) primaryInput.type = "text";
      const rest = t.fields.filter(f => f !== primary && !deferred.has(f.type)).map(f => this.plainField(f));
      const { tableId } = this.store.createTable(state.actor, { name: t.name, fields: [primaryInput, ...rest] });
      state.tableMap[t.id] = tableId;
      const created = this.store.fieldsOf(tableId);
      state.fieldMap[primary.id] = created[0].id;
      for (const f of t.fields) {
        if (f === primary || deferred.has(f.type)) continue;
        const match = created.find(x => x.name === f.name);
        if (match) state.fieldMap[f.id] = match.id;
      }
    }
    // A fresh base starts with an empty "Table 1"; drop it once real tables exist.
    if (existing.length === 1 && existing[0].rowCount === 3 && existing[0].name === "Table 1") {
      const rows = this.store.getRows(existing[0].id, this.store.query(existing[0].id, { limit: 10 }).ids);
      if (rows.every(r => Object.keys(r.cells).length === 0)) this.store.deleteTable(existing[0].id);
    }
  }

  private async importPage(state: State): Promise<boolean> {
    const t = state.tables[state.tableIndex];
    const tableId = state.tableMap[t.id];
    const q = new URLSearchParams({ pageSize: "100", returnFieldsByFieldId: "true" });
    if (state.offset) q.set("offset", state.offset);
    const page = await this.call(state.token, `/${state.atBase}/${t.id}?${q}`);
    const records: { id: string; createdTime: string; fields: Record<string, unknown> }[] = page.records ?? [];
    const inputs = [];
    const deferred: [number, string, unknown][] = [];
    for (const [i, rec] of records.entries()) {
      for (const f of t.fields) {
        const v = rec.fields[f.id];
        if (v !== undefined && (f.type === "multipleRecordLinks" || f.type === "formula")) deferred.push([i, f.id, v]);
      }
      const cells: Record<string, unknown> = {};
      for (const f of t.fields) {
        const target = state.fieldMap[f.id];
        const v = rec.fields[f.id];
        if (!target || v === undefined) continue;
        if (f.type === "multipleAttachments") cells[target] = await this.copyAttachments(state, v as any[]);
        else if (f.type === "singleCollaborator" || f.type === "createdBy" || f.type === "lastModifiedBy") cells[target] = (v as any)?.email ?? (v as any)?.name;
        else if (f.type === "multipleCollaborators") cells[target] = (v as any[]).map(x => x.email ?? x.name).join(", ");
        else if (f.type === "barcode") cells[target] = (v as any)?.text;
        else if (f.type === "button") cells[target] = (v as any)?.label;
        else cells[target] = v;
      }
      inputs.push({ cells, createdAt: Date.parse(rec.createdTime) || undefined });
    }
    if (inputs.length) {
      const result = this.store.createRows(state.actor, tableId, inputs, { typecast: true, noTriggers: true });
      const ids = result.changes.find(c => c.tableId === tableId)?.rows.map(r => r.id) ?? [];
      // createRows returns rows in insertion order.
      records.forEach((rec, i) => {
        if (ids[i] !== undefined) this.store.sql.exec("INSERT OR REPLACE INTO _at_ids (at, tbl, id) VALUES (?, ?, ?)", rec.id, tableId, ids[i]);
      });
      for (const [i, field, v] of deferred) {
        if (ids[i] !== undefined) this.store.sql.exec("INSERT INTO _at_defer (tbl, id, field, val) VALUES (?, ?, ?, ?)", tableId, ids[i], field, JSON.stringify(v));
      }
      this.store.sql.exec("UPDATE _jobs SET total = total + ? WHERE kind = 'airtable'", inputs.length);
    }
    state.imported += records.length;
    state.offset = page.offset;
    // Airtable allows 5 requests per second per base.
    await new Promise(r => setTimeout(r, 220));
    return !page.offset;
  }

  private async copyAttachments(state: State, list: { id: string; url: string; filename: string; size: number; type: string }[]): Promise<Attachment[]> {
    const out: Attachment[] = [];
    for (const a of list ?? []) {
      try {
        const res = await fetch(a.url);
        if (!res.ok || !res.body) continue;
        const id = newAttachmentId();
        const key = `${state.baseId}/${id}/${a.filename.replace(/[^\w.\- ]+/g, "_")}`;
        const obj = await this.env.FILES.put(key, res.body, { httpMetadata: { contentType: a.type } });
        this.store.noteFile(key, obj?.size ?? a.size, Date.now());
        out.push({ id, name: a.filename, size: a.size, type: a.type, key });
      } catch {
        // Skip attachments that can no longer be downloaded.
      }
    }
    return out;
  }

  private createLinks(state: State) {
    const done = new Set<string>();
    for (const t of state.tables) {
      for (const f of t.fields) {
        if (f.type !== "multipleRecordLinks" || done.has(f.id)) continue;
        const linkedAt = f.options?.linkedTableId as string;
        const linked = state.tableMap[linkedAt];
        const tableId = state.tableMap[t.id];
        if (!linked) continue;
        const { fieldId, schema } = this.store.createField(tableId, { name: f.name, type: "link", options: { linkedTableId: linked } });
        state.fieldMap[f.id] = fieldId;
        const inverseAt = f.options?.inverseLinkFieldId as string | undefined;
        const inv = schema.fields.find(x => x.id === fieldId)?.options.inverseFieldId;
        if (inverseAt && inv) {
          done.add(inverseAt);
          state.fieldMap[inverseAt] = inv;
          const invName = state.tables.find(x => x.id === linkedAt)?.fields.find(x => x.id === inverseAt)?.name;
          if (invName) this.store.updateField(inv, { name: invName });
        }
      }
    }
  }

  /** Writes link cells from the deferred Airtable record ids, one batch per call. Returns true when finished. */
  private fillLinks(state: State): boolean {
    const linkFields = new Set<string>();
    for (const t of state.tables) for (const f of t.fields) if (f.type === "multipleRecordLinks" && state.fieldMap[f.id]) linkFields.add(f.id);
    const batch = this.store.all<{ seq: number; tbl: string; id: number; field: string; val: string }>(
      "SELECT seq, tbl, id, field, val FROM _at_defer WHERE seq > ? ORDER BY seq LIMIT 500", state.cursor ?? 0,
    );
    const byTable = new Map<string, { id: number; cells: Record<string, unknown> }[]>();
    for (const d of batch) {
      state.cursor = d.seq;
      if (!linkFields.has(d.field)) continue;
      const ours = state.fieldMap[d.field];
      const field = this.store.field(ours);
      // Only the owning side is written; the inverse side follows automatically.
      if (field.options.linkSide !== "a") continue;
      const ids = (JSON.parse(d.val) as string[])
        .map(at => this.store.one<{ id: number }>("SELECT id FROM _at_ids WHERE at = ?", at)?.id)
        .filter((x): x is number => x !== undefined);
      const list = byTable.get(d.tbl) ?? [];
      list.push({ id: d.id, cells: { [ours]: ids } });
      byTable.set(d.tbl, list);
    }
    for (const [tableId, updates] of byTable) this.store.updateRows(state.actor, tableId, updates, { noTriggers: true });
    return batch.length < 500;
  }

  private createComputed(state: State) {
    for (const t of state.tables) {
      const tableId = state.tableMap[t.id];
      for (const f of t.fields) {
        if (state.fieldMap[f.id]) continue;
        const o = f.options ?? {};
        try {
          if (f.type === "lookup" || f.type === "multipleLookupValues") {
            const link = state.fieldMap[o.recordLinkFieldId], target = state.fieldMap[o.fieldIdInLinkedTable];
            if (link && target) state.fieldMap[f.id] = this.store.createField(tableId, { name: f.name, type: "lookup", options: { linkFieldId: link, targetFieldId: target } }).fieldId;
          } else if (f.type === "rollup") {
            const link = state.fieldMap[o.recordLinkFieldId], target = state.fieldMap[o.fieldIdInLinkedTable];
            const fn = rollupFnFromAirtable(String(o.formula ?? o.referencedFieldIds ?? "")) ?? "sum";
            if (link && target) state.fieldMap[f.id] = this.store.createField(tableId, { name: f.name, type: "rollup", options: { linkFieldId: link, targetFieldId: target, fn } }).fieldId;
          } else if (f.type === "formula") {
            // Airtable formulas reference fields by name or id; map ids to our names.
            let formula = String(o.formula ?? "");
            for (const [atId, ourId] of Object.entries(state.fieldMap)) formula = formula.split(`{${atId}}`).join(`{${ourId}}`);
            state.fieldMap[f.id] = this.store.createField(tableId, { name: f.name, type: "formula", options: { formula } }).fieldId;
          }
        } catch {
          // Unsupported formula: keep the column as text with Airtable's computed values.
          const id = this.store.createField(tableId, { name: f.name, type: "text" }).fieldId;
          state.fieldMap[f.id] = id;
          const vals = this.store.all<{ id: number; val: string }>("SELECT id, val FROM _at_defer WHERE tbl = ? AND field = ?", tableId, f.id);
          for (let i = 0; i < vals.length; i += 500) {
            this.store.updateRows(state.actor, tableId, vals.slice(i, i + 500).map(v => ({ id: v.id, cells: { [id]: JSON.parse(v.val) } })), { typecast: true, noTriggers: true });
          }
        }
      }
    }
  }
}
