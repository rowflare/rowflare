// The flow of an automation: the trigger card, step cards with "+" between them, branch columns, and the settings panel.
import { Fragment, useState } from "react";
import { STEP_TYPES, type AutomationConfig, type AutomationRun, type Step, type StepLog, type StepType } from "../../shared/automations";
import type { BaseClient } from "../base/client";
import { Icon, Menu } from "../ui";
import { defaultStep, findStep, insertStep, moveStep, removeStep, replaceStep, schemaLite, STEP_ICONS, STEP_LABELS, stepSummary, TRIGGER_ICONS, TRIGGER_LABELS, triggerSummary, type Slot } from "./flow";
import { StepPanel, TriggerPanel } from "./Panels";

export function FlowEditor({ client, config, onChange, selected, onSelect, test, readOnly, webhookUrl }: {
  client: BaseClient;
  config: AutomationConfig;
  onChange: (c: AutomationConfig) => void;
  selected: string;
  onSelect: (id: string) => void;
  test: AutomationRun | null;
  readOnly: boolean;
  webhookUrl: string | null;
}) {
  const s = schemaLite(client.schema);
  const [adding, setAdding] = useState<{ anchor: HTMLElement; slot: Slot } | null>(null);
  const logs = new Map<string, StepLog>((test?.steps ?? []).map(l => [l.id, l]));
  const setSteps = (steps: Step[]) => onChange({ ...config, steps });
  const add = (slot: Slot, type: StepType) => {
    const st = defaultStep(type, config.steps, config.trigger, s);
    setSteps(insertStep(config.steps, slot, st));
    onSelect(st.id);
  };
  const plus = (slot: Slot) =>
    !readOnly && (
      <button className="flow-plus" aria-label="Add a step" onClick={e => setAdding({ anchor: e.currentTarget, slot })}>
        <Icon name="plus" size={13} />
      </button>
    );
  const status = (id: string) => {
    const l = logs.get(id);
    return l ? <span className={"flow-status " + l.status} title={l.error ?? "Succeeded in the last test"}><Icon name={l.status === "ok" ? "check" : "x"} size={12} /></span> : null;
  };
  const card = (st: Step) => (
    <button className={"flow-card" + (selected === st.id ? " selected" : "")} onClick={() => onSelect(st.id)}>
      <span className="flow-icon"><Icon name={STEP_ICONS[st.type]} size={15} /></span>
      <span className="flow-text">
        <span className="flow-title">{STEP_LABELS[st.type]} <span className="step-id">{st.id}</span></span>
        <span className="flow-sub">{stepSummary(st, s)}</span>
      </span>
      {status(st.id)}
    </button>
  );
  const list = (steps: Step[], parent?: { parentId: string; side: "then" | "else" }) => (
    <div className="flow-list">
      {steps.map((st, i) => (
        <Fragment key={st.id}>
          {plus({ ...parent, index: i })}
          {card(st)}
          {st.type === "branch" && (
            <div className="flow-branch">
              <div className="flow-side">
                <div className="flow-side-title">If the conditions hold</div>
                {list(st.then, { parentId: st.id, side: "then" })}
              </div>
              <div className="flow-side">
                <div className="flow-side-title">Otherwise</div>
                {list(st.else, { parentId: st.id, side: "else" })}
              </div>
            </div>
          )}
        </Fragment>
      ))}
      {plus({ ...parent, index: steps.length })}
    </div>
  );
  const step = selected === "trigger" ? undefined : findStep(config.steps, selected);
  return (
    <div className={"flow-wrap" + (readOnly ? " read-only" : "")}>
      <div className="flow">
        <button className={"flow-card trigger" + (selected === "trigger" ? " selected" : "")} onClick={() => onSelect("trigger")}>
          <span className="flow-icon"><Icon name={TRIGGER_ICONS[config.trigger.type]} size={15} /></span>
          <span className="flow-text">
            <span className="flow-title">{TRIGGER_LABELS[config.trigger.type]}</span>
            <span className="flow-sub">{triggerSummary(config.trigger, s)}</span>
          </span>
        </button>
        {list(config.steps)}
      </div>
      {!readOnly && (
        <aside className="flow-panel">
          {!step ? (
            <TriggerPanel client={client} config={config} onChange={onChange} webhookUrl={webhookUrl} />
          ) : (
            <StepPanel
              client={client}
              config={config}
              step={step}
              log={logs.get(step.id)}
              onChange={next => setSteps(replaceStep(config.steps, step.id, next))}
              onMove={dir => setSteps(moveStep(config.steps, step.id, dir))}
              onRemove={() => {
                setSteps(removeStep(config.steps, step.id));
                onSelect("trigger");
              }}
            />
          )}
        </aside>
      )}
      {adding && (
        <Menu
          anchor={adding.anchor}
          onClose={() => setAdding(null)}
          items={STEP_TYPES.filter(t => !(t === "branch" && adding.slot.parentId)).map(t => ({ label: STEP_LABELS[t], icon: STEP_ICONS[t], onClick: () => add(adding.slot, t) }))}
        />
      )}
    </div>
  );
}
