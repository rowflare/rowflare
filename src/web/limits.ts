// Plan limit errors: owners get an Upgrade button, other members are told to ask an owner.
import { ApiError, getConfig, type LimitInfo } from "./api";
import { navigate } from "./router";
import type { Role } from "../shared/types";

let current: { workspaceId: string; role: Role } | null = null;
let billing = false;

/** The workspace the person is looking at; pages call it when they load one. */
export function setLimitContext(workspaceId: string, role: Role) {
  current = { workspaceId, role };
  getConfig().then(c => void (billing = c.billing)).catch(() => undefined);
}

export const limitOf = (e: unknown): LimitInfo | undefined => (e instanceof ApiError && e.status === 402 ? e.limit : undefined);

/** Where an owner upgrades: the hosting's page, or the Billing tab. */
export function upgradeTarget(limit: LimitInfo): (() => void) | null {
  if (limit.upgradeUrl) {
    const url = limit.upgradeUrl;
    return () => void window.open(url, "_blank", "noopener");
  }
  if (current && billing) {
    const ws = current.workspaceId;
    return () => navigate(`/settings/billing?ws=${ws}`);
  }
  return null;
}

/** Toast text and action for a limit error. */
export function limitToast(e: ApiError & { limit: LimitInfo }): { text: string; action?: { label: string; run: () => void } } {
  if (current && current.role !== "owner") return { text: `${e.message}. Ask a workspace owner to upgrade.` };
  const run = upgradeTarget(e.limit);
  return run ? { text: e.message, action: { label: "Upgrade", run } } : { text: e.message };
}

function fmtBytes(n: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${i ? (Math.round(n * 10) / 10).toLocaleString() : n.toLocaleString()} ${units[i]}`;
}

/** A usage number for people: bytes for attachments, plain counts otherwise. */
export const fmtUsage = (key: string, n: number) => (key === "attachments" ? fmtBytes(n) : n.toLocaleString());
