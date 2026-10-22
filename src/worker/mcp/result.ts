// Tool result helpers: every tool returns JSON as structuredContent plus the same JSON as text.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpError } from "../access";
import type { ApiRecord } from "../records";

export const TEXT_LIMIT = 2000;
/** Lists in one cell (lookups, links, multiple selects) are cut at this many items. */
export const LIST_LIMIT = 100;
/** About this many characters of records per tool answer; models handle larger answers poorly. */
export const RESPONSE_BUDGET = 150_000;

export function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

export function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Runs a tool body; user-correctable errors become tool errors with their message so the model can retry. */
export function guard<A>(fn: (args: A) => Promise<Record<string, unknown>>): (args: A) => Promise<CallToolResult> {
  return async args => {
    try {
      return ok(await fn(args));
    } catch (e) {
      if (e instanceof HttpError) return fail(e.message);
      console.error(e);
      return fail("Internal error");
    }
  };
}

export function truncateRecord(rec: ApiRecord, max = TEXT_LIMIT): ApiRecord {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec.fields)) fields[k] = typeof v === "string" && v.length > max ? `${v.slice(0, max)}… [truncated, ${v.length} chars]` : v;
  return { ...rec, fields: capLists(fields) };
}

function capLists(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = Array.isArray(v) && v.length > LIST_LIMIT ? [...v.slice(0, LIST_LIMIT), `[${v.length - LIST_LIMIT} more]`] : v;
  return out;
}

/** The records that fit the response budget (at least one, cut to fit), and the rest. */
export function withinBudget(records: ApiRecord[]): { kept: ApiRecord[]; rest: ApiRecord[] } {
  const kept: ApiRecord[] = [];
  let size = 0;
  for (const [i, r0] of records.entries()) {
    const r = { ...r0, fields: capLists(r0.fields) };
    const n = JSON.stringify(r).length;
    if (size + n > RESPONSE_BUDGET) {
      if (!kept.length) kept.push(truncateRecord(r));
      return { kept, rest: records.slice(kept.length === 1 && i === 0 ? 1 : i) };
    }
    kept.push(r);
    size += n;
  }
  return { kept, rest: [] };
}
