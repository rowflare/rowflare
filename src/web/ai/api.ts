// Client calls for AI services.
import { api, del, get, post } from "../api";
import type { AiServiceInfo } from "../../shared/ai";

export interface ServiceList {
  services: AiServiceInfo[];
  secretKey: boolean;
  workers: boolean;
}

export interface ServiceForm {
  name: string;
  kind: "anthropic" | "openai";
  baseUrl?: string;
  model: string;
  key?: string;
}

export const listWsServices = (ws: string) => get<ServiceList>(`/api/workspaces/${ws}/ai-services`);
export const listBaseServices = (baseId: string) => get<{ services: AiServiceInfo[] }>(`/api/bases/${baseId}/ai-services`);
export const addService = (ws: string, f: ServiceForm) => post<{ id: string }>(`/api/workspaces/${ws}/ai-services`, f);
export const saveService = (ws: string, id: string, f: ServiceForm) => api("PUT", `/api/workspaces/${ws}/ai-services/${id}`, f);
export const removeService = (ws: string, id: string) => del(`/api/workspaces/${ws}/ai-services/${id}`);
export const testService = (ws: string, f: Partial<ServiceForm> & { id?: string }) => post<{ answer: string }>(`/api/workspaces/${ws}/ai-services/test`, f);

export const KIND_LABELS: Record<AiServiceInfo["kind"], string> = { anthropic: "Anthropic", openai: "OpenAI-compatible", workers: "Workers AI" };
