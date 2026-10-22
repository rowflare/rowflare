import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
window.addEventListener("popstate", () => listeners.forEach(l => l()));

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search) return;
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  listeners.forEach(l => l());
}

export function useLocation(): string {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => location.pathname + location.search,
  );
}

/** Matches "/base/:id/:table?" style patterns; returns params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("?")[0].split("/").filter(Boolean);
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i];
    const optional = seg.endsWith("?");
    if (seg.startsWith(":")) {
      const name = seg.slice(1).replace(/\?$/, "");
      if (s[i] === undefined) {
        if (optional) continue;
        return null;
      }
      out[name] = decodeURIComponent(s[i]);
    } else if (seg !== s[i]) return null;
  }
  if (s.length > p.length) return null;
  return out;
}

export function Link(props: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const { to, onClick, ...rest } = props;
  return (
    <a
      href={to}
      onClick={e => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    />
  );
}
