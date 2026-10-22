// The run log of one automation: newest first, filtered by status, with each step's input and output.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Automation, AutomationRun, RunStatus, StepLog } from "../../shared/automations";
import type { BaseClient } from "../base/client";
import { Button, Icon, Spinner } from "../ui";
import { toast, toastError } from "../toast";
import { listRuns, retryRun } from "./api";
import { STEP_LABELS } from "./flow";

export const STATUS_LABELS: Record<RunStatus, string> = { queued: "Queued", running: "Running", waiting_retry: "Waiting to retry", succeeded: "Succeeded", failed: "Failed", skipped: "Skipped" };

export function StatusDot({ status }: { status: RunStatus }) {
  return <span className={"run-dot " + status} title={STATUS_LABELS[status]} />;
}

export function StepLogView({ log, title }: { log: StepLog; title?: string }) {
  return (
    <div className={"step-log " + log.status}>
      <div className="step-log-head">
        <Icon name={log.status === "ok" ? "check" : "x"} size={13} />
        <span>{title ?? `${STEP_LABELS[log.type]} ${log.id}`}</span>
        {log.error && <span className="run-error">{log.error}</span>}
        <span className="muted small">{log.ms} ms</span>
      </div>
      {log.input !== undefined && (
        <>
          <div className="muted small">Input</div>
          <pre className="auto-code">{JSON.stringify(log.input, null, 2)}</pre>
        </>
      )}
      {log.output !== undefined && (
        <>
          <div className="muted small">Output</div>
          <pre className="auto-code">{JSON.stringify(log.output, null, 2)}</pre>
        </>
      )}
    </div>
  );
}

function triggerText(r: AutomationRun, client: BaseClient): string {
  const t = r.trigger;
  if (r.test) return "Test run";
  switch (t.type) {
    case "schedule":
      return "Scheduled";
    case "webhook":
      return "Webhook call";
    case "button":
      return `Button on record ${t.recordId}, by ${client.memberName(t.by ?? "")}`;
    case "dateReached":
      return `Date reached on record ${t.recordId}`;
    default:
      return `Record ${t.recordId}` + (t.by ? `, by ${client.memberName(t.by)}` : "");
  }
}

export function RunsPanel({ client, automation }: { client: BaseClient; automation: Automation }) {
  const [status, setStatus] = useState("");
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const paged = useRef(false);
  // Only the newest request may fill the list, so a slow answer for an earlier filter cannot replace it.
  const seq = useRef(0);
  const load = useCallback(() => {
    const at = ++seq.current;
    return listRuns(client.baseId, automation.id, { status }).then(list => {
      if (at !== seq.current) return;
      paged.current = false;
      setRuns(list);
      setMore(list.length === 50);
    });
  }, [client.baseId, automation.id, status]);
  useEffect(() => {
    load().catch(toastError);
    // Runs finish in the background; refresh the first page while the log is open.
    const t = setInterval(() => {
      if (!paged.current) load().catch(() => undefined);
    }, 5000);
    return () => clearInterval(t);
  }, [load]);
  const older = () => {
    if (!runs?.length) return;
    const at = ++seq.current;
    listRuns(client.baseId, automation.id, { status, before: runs[runs.length - 1].id })
      .then(list => {
        if (at !== seq.current) return;
        paged.current = true;
        setRuns([...runs, ...list]);
        setMore(list.length === 50);
      })
      .catch(toastError);
  };
  const again = (r: AutomationRun) =>
    retryRun(client.baseId, r.id)
      .then(() => {
        toast("Running again from the step that failed");
        return load();
      })
      .catch(toastError);
  return (
    <div className="runs">
      <div className="runs-bar">
        <select className="input runs-filter" value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
          <option value="">All runs</option>
          {(["failed", "succeeded", "waiting_retry", "queued", "skipped"] as RunStatus[]).map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
        <Button small variant="ghost" icon="undo" onClick={() => load().catch(toastError)}>Refresh</Button>
      </div>
      {!runs ? (
        <Spinner />
      ) : runs.length === 0 ? (
        <p className="muted">No runs yet.</p>
      ) : (
        <div className="runs-list">
          {runs.map(r => (
            <div key={r.id} className={"run" + (open === r.id ? " open" : "")}>
              <button className="run-row" onClick={() => setOpen(open === r.id ? null : r.id)}>
                <StatusDot status={r.status} />
                <span className="run-status">{STATUS_LABELS[r.status]}</span>
                <span className="run-when muted small">{new Date(r.createdAt).toLocaleString()}</span>
                <span className="run-what small">{triggerText(r, client)}</span>
                {r.error && <span className="run-error small">{r.error}</span>}
              </button>
              {open === r.id && (
                <div className="run-detail">
                  {r.status === "waiting_retry" && r.nextAt && <p className="muted small">Next try at {new Date(r.nextAt).toLocaleTimeString()} (attempt {r.attempt + 1} of 4).</p>}
                  {r.steps.length === 0 && <p className="muted small">No steps ran.</p>}
                  {r.steps.map(l => <StepLogView key={l.id} log={l} />)}
                  {r.status === "failed" && !r.test && <Button small icon="play" onClick={() => again(r)}>Run again from the failed step</Button>}
                </div>
              )}
            </div>
          ))}
          {more && <Button small variant="ghost" onClick={older}>Older runs</Button>}
        </div>
      )}
    </div>
  );
}
