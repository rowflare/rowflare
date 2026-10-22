// Small UI primitives shared by every screen.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { dismiss, useToasts } from "./toast";
import type { FieldType } from "../shared/types";

const PATHS: Record<string, string> = {
  bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  branch: "M6 3v18M18 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM15 9c0 6-9 3-9 9",
  braces: "M8 4c-2 0-2 2-2 4s-1 4-3 4c2 0 3 2 3 4s0 4 2 4M16 4c2 0 2 2 2 4s1 4 3 4c-2 0-3 2-3 4s0 4-2 4",
  play: "M7 4l13 8-13 8z",
  button: "M3 8h18v8H3zM8 12h8",
  plus: "M12 5v14M5 12h14",
  chart: "M4 20V11M10 20V5M16 20v-8M21 20H3",
  x: "M6 6l12 12M18 6L6 18",
  chevron: "M6 9l6 6 6-6",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5",
  filter: "M3 5h18l-7 8v6l-4 2v-8z",
  sort: "M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  grid: "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18",
  kanban: "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z",
  form: "M5 3h14v18H5zM8 8h8M8 12h8M8 16h5",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v5M16 3v5M8 14h3M13 14h3M8 17h3",
  timeline: "M4 6h9M8 12h12M6 18h8M4 3v18",
  gallery: "M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z",
  expand: "M4 14v6h6M20 10V4h-6M4 20l7-7M20 4l-7 7",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  undo: "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
  redo: "M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3",
  download: "M12 4v12M7 11l5 5 5-5M5 20h14",
  upload: "M12 20V8M7 13l5-5 5 5M5 4h14",
  link: "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  back: "M15 18l-6-6 6-6",
  settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 12l2-1-2-4-2 .5-1.5-1L15 4h-4l-.5 2.5L9 7.5 7 7 5 11l2 1v0l-2 1 2 4 2-.5 1.5 1L11 20h4l.5-2.5 1.5-1 2 .5 2-4z",
  check: "M5 12l5 5 9-10",
  text: "M5 6h14M12 6v13",
  longText: "M4 6h16M4 10h16M4 14h10M4 18h7",
  number: "M9 4L7 20M17 4l-2 16M4 9h16M3 15h16",
  singleSelect: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM9 12l2 2 4-4",
  multiSelect: "M4 6h3M4 12h3M4 18h3M10 6h10M10 12h10M10 18h10",
  date: "M4 6h16v14H4zM4 10h16M8 3v5M16 3v5",
  checkbox: "M4 4h16v16H4zM8 12l3 3 5-6",
  attachment: "M15 7l-7 7a2.5 2.5 0 0 0 3.5 3.5l7.5-7.5a4.5 4.5 0 0 0-6.5-6.5L5 11",
  lookup: "M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM20 20l-5.5-5.5",
  rollup: "M5 4h14l-7 8 7 8H5",
  formula: "M14 4h-2a3 3 0 0 0-3 3v13M6 10h7M15 13l5 6M20 13l-5 6",
  user: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21a8 8 0 0 1 16 0",
  email: "M3 6h18v12H3zM3 7l9 6 9-6",
  url: "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1",
  phone: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z",
  createdTime: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4l3 2",
  modifiedTime: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4l3 2",
  autonumber: "M4 9h16M4 15h16M10 3L8 21M16 3l-2 18",
  table: "M3 4h18v16H3zM3 10h18M3 15h18M9 10v10",
  import: "M12 3v12M7 10l5 5 5-5M4 21h16",
  copy: "M8 8h12v12H8zM4 16V4h12",
  user2: "M9 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM3 20a6 6 0 0 1 12 0M17 8a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.7",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11",
  menu: "M4 6h16M4 12h16M4 18h16",
  sparkle: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  refresh: "M20 11a8 8 0 0 0-14.9-4M4 4v4h4M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4",
  rowHeight: "M4 4h16M4 20h16M12 8v8M9 11l3-3 3 3M9 13l3 3 3-3",
};

export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg className={"icon " + (className ?? "")} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.text} />
    </svg>
  );
}

export function FieldIcon({ type, size = 14 }: { type: FieldType; size?: number }) {
  return <Icon name={type} size={size} />;
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M1.5 9h21M1.5 15h21M9 1.5v21" stroke="currentColor" strokeWidth="1.2" opacity="0.45" />
      <rect x="9" y="9" width="13.5" height="6" fill="var(--accent)" />
    </svg>
  );
}

export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "default"; icon?: string; small?: boolean }) {
  const { variant = "default", icon, small, className, children, ...rest } = props;
  return (
    <button type="button" className={`btn btn-${variant}${small ? " btn-sm" : ""} ${className ?? ""}`} {...rest}>
      {icon && <Icon name={icon} size={small ? 14 : 16} />}
      {children}
    </button>
  );
}

export function Modal({ title, onClose, children, width = 560, footer }: { title?: ReactNode; onClose: () => void; children: ReactNode; width?: number; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog" aria-modal="true">
        {title !== undefined && (
          <div className="modal-head">
            <div className="modal-title">{title}</div>
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <Icon name="x" />
            </button>
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** A floating panel anchored to an element or a rectangle; closes on outside click or Escape. */
export function Popover({ anchor, onClose, children, width, align = "start", className }: {
  anchor: HTMLElement | DOMRect | null;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  align?: "start" | "end";
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number }>({ left: -9999, top: -9999, maxHeight: 400 });
  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
    const el = ref.current;
    const w = el?.offsetWidth ?? width ?? 280;
    let left = align === "end" ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 4;
    const h = el?.offsetHeight ?? 200;
    if (top + h > window.innerHeight - 8 && r.top - h - 4 > 8) top = r.top - h - 4;
    setPos({ left, top, maxHeight: window.innerHeight - top - 12 });
  }, [anchor, width, align, children]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (anchor instanceof HTMLElement && anchor.contains(t)) return;
      // Clicks inside nested portals (menus opened from this popover) do not close it.
      if ((t as HTMLElement).closest?.(".popover")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const id = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);
  if (!anchor) return null;
  return createPortal(
    <div ref={ref} className={"popover " + (className ?? "")} style={{ left: pos.left, top: pos.top, width, maxHeight: pos.maxHeight }}>
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export function Menu({ anchor, items, onClose }: { anchor: HTMLElement | DOMRect | null; items: (MenuItem | "sep")[]; onClose: () => void }) {
  return (
    <Popover anchor={anchor} onClose={onClose} className="menu">
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            className={"menu-item" + (it.danger ? " danger" : "")}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            {it.icon && <Icon name={it.icon} size={15} />}
            <span>{it.label}</span>
          </button>
        ),
      )}
    </Popover>
  );
}

export function Toasts() {
  const list = useToasts();
  return createPortal(
    <div className="toasts" role="status" aria-live="polite">
      {list.map(t => (
        <div key={t.id} className={"toast toast-" + t.kind}>
          <span>{t.text}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="icon-btn" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function Avatar({ name, color, size = 26, title }: { name: string; color?: string; size?: number; title?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(s => s[0]!.toUpperCase())
    .join("");
  return (
    <span className="avatar" title={title ?? name} style={{ width: size, height: size, background: color ?? "var(--accent-bg)", fontSize: size * 0.42 }}>
      {initials || "?"}
    </span>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children}
    </div>
  );
}

export function confirmDialog(message: string): boolean {
  return window.confirm(message);
}

export function copyText(text: string) {
  navigator.clipboard?.writeText(text).catch(() => undefined);
}
