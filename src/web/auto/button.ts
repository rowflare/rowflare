// Runs the automation behind a Button field for one record and reports the outcome.
import type { Field } from "../../shared/types";
import type { BaseClient } from "../base/client";
import { toast, toastError } from "../toast";
import { runButton } from "./api";

export async function runButtonField(client: BaseClient, field: Field, recordId: number) {
  const id = field.options.automationId;
  const info = client.schema.buttons?.find(b => b.id === id);
  if (!id || !info) return toast("This button has no automation yet. Choose one in the field settings.", "error");
  if (!info.enabled) return toast(`The automation "${info.name}" is turned off`, "error");
  if (info.tableId !== field.tableId) return toast(`The automation "${info.name}" runs on another table. Choose another one in the field settings.`, "error");
  const key = `${field.id}:${recordId}`;
  if (client.buttonBusy.has(key)) return;
  client.buttonBusy.add(key);
  client.emit();
  try {
    const r = await runButton(client.baseId, id, recordId, field.tableId);
    if (r.status === "succeeded") toast(`${info.name}: done`);
    else toast(`${info.name}: ${r.error ?? r.status}`, "error");
  } catch (e) {
    toastError(e);
  } finally {
    client.buttonBusy.delete(key);
    client.emit();
  }
}
