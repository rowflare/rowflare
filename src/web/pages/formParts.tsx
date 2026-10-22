// Small form helpers shared by the settings pages.
import { useState, type ReactNode } from "react";
import { Spinner } from "../ui";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function Submit({ busy, children, disabled }: { busy: boolean; children: ReactNode; disabled?: boolean }) {
  return (
    <button type="submit" className="btn btn-primary" disabled={busy || disabled}>
      {busy && <Spinner size={14} />} {children}
    </button>
  );
}

export function ErrorLine({ error }: { error: string }) {
  return error ? <div className="page-err" role="alert">{error}</div> : null;
}
