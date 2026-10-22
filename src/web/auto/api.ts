// HTTP calls for the automations editor, Button fields and the run log.
import { get, post } from "../api";
import type { Automation, AutomationOp, AutomationRun, RunStatus } from "../../shared/automations";

export interface AutomationList {
  automations: Automation[];
  usage: { used: number; limit: number; per: "base" | "workspace" };
  origin: string;
}

export const listAutomations = (baseId: string) => get<AutomationList>(`/api/bases/${baseId}/automations`);

export const automationOp = (baseId: string, op: AutomationOp) => post<{ id?: string; automations: Automation[] }>(`/api/bases/${baseId}/automations`, op);

export function listRuns(baseId: string, id: string, q: { status?: string; before?: number } = {}) {
  const p = new URLSearchParams();
  if (q.status) p.set("status", q.status);
  if (q.before) p.set("before", String(q.before));
  return get<AutomationRun[]>(`/api/bases/${baseId}/automations/${id}/runs?${p}`);
}

export const testRun = (baseId: string, id: string, input: { recordId?: number; body?: unknown }) => post<AutomationRun>(`/api/bases/${baseId}/automations/${id}/test`, input);

export const runButton = (baseId: string, id: string, recordId: number, tableId: string) => post<{ id: number; status: RunStatus; error: string | null }>(`/api/bases/${baseId}/automations/${id}/run`, { recordId, tableId });

export const retryRun = (baseId: string, runId: number) => post<{ runId: number }>(`/api/bases/${baseId}/runs/${runId}/retry`, {});

export const webhookUrl = (origin: string, baseId: string, token: string) => `${origin}/api/hooks/${baseId}/${token}`;
