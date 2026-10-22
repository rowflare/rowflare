import { useSyncExternalStore } from "react";
import { ApiError } from "./api";
import { limitOf, limitToast } from "./limits";

export interface Toast {
  id: number;
  text: string;
  kind: "error" | "info";
  action?: { label: string; run: () => void };
}

let toasts: Toast[] = [];
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function toast(text: string, kind: Toast["kind"] = "info", action?: Toast["action"]) {
  const t = { id: ++seq, text, kind, action };
  toasts = [...toasts.slice(-3), t];
  emit();
  setTimeout(() => dismiss(t.id), kind === "error" ? 6000 : 3500);
}

export function toastError(e: unknown) {
  if (limitOf(e)) {
    const t = limitToast(e as ApiError & { limit: NonNullable<ApiError["limit"]> });
    return toast(t.text, "error", t.action);
  }
  toast(e instanceof Error ? e.message : String(e), "error");
}

export function dismiss(id: number) {
  toasts = toasts.filter(t => t.id !== id);
  emit();
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => toasts,
  );
}
