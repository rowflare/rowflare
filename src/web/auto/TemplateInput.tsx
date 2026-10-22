// A text input for templates with an "Insert variable" menu that inserts {{...}} at the caret.
import { useRef, useState } from "react";
import { Icon, Popover } from "../ui";
import type { Variable } from "./flow";

export function TemplateInput({ value, onChange, variables, multiline, placeholder, ariaLabel }: { value: string; onChange: (v: string) => void; variables: Variable[]; multiline?: boolean; placeholder?: string; ariaLabel?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const insert = (tpl: string) => {
    const el = multiline ? area.current : input.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + tpl + value.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + tpl.length, start + tpl.length);
    });
  };
  const groups = [...new Set(variables.map(v => v.group))];
  return (
    <div className={"tpl-input" + (multiline ? " multi" : "")}>
      {multiline ? (
        <textarea ref={area} className="input tpl-area" rows={5} value={value} placeholder={placeholder} aria-label={ariaLabel} onChange={e => onChange(e.target.value)} />
      ) : (
        <input ref={input} className="input" value={value} placeholder={placeholder} aria-label={ariaLabel} onChange={e => onChange(e.target.value)} />
      )}
      <button type="button" className="icon-btn tpl-btn" title="Insert variable" aria-label="Insert variable" onClick={e => setAnchor(e.currentTarget)}>
        <Icon name="braces" size={14} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={300} align="end" className="menu tpl-menu">
          {groups.map(g => (
            <div key={g}>
              <div className="tpl-group">{g}</div>
              {variables.filter(v => v.group === g).map(v => (
                <button
                  key={v.template}
                  className="menu-item"
                  onClick={() => {
                    setAnchor(null);
                    insert(v.template);
                  }}
                >
                  <span>{v.label}</span>
                </button>
              ))}
            </div>
          ))}
        </Popover>
      )}
    </div>
  );
}
