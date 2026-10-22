// Grid cells of AI fields while they are queued, running or failed: the current value dimmed with a status line.
import { GridCellKind, type CustomCell, type CustomRenderer, type GridCell } from "@glideapps/glide-data-grid";
import type { AiCellState } from "../../shared/ai";

export interface AiData {
  kind: "rf-ai";
  state: AiCellState["s"];
  text: string;
  error?: string;
}
export type AiCell = CustomCell<AiData>;

export function aiCell(base: GridCell, state: AiCellState): GridCell {
  const text = "displayData" in base && typeof base.displayData === "string" ? base.displayData : "copyData" in base && typeof base.copyData === "string" ? base.copyData : "";
  if (state.s === "edited") return { ...base, themeOverride: { bgCell: "#fff8e6" } } as GridCell;
  // Text, number and URL cells stay editable in the grid: a person may type over a waiting or failed cell.
  if (base.kind === GridCellKind.Text || base.kind === GridCellKind.Number || base.kind === GridCellKind.Uri) {
    const label = state.s === "error" ? `! ${state.e ?? "Failed"}` : AI_STATE_TEXT[state.s];
    return { ...base, displayData: label, contentAlign: undefined, themeOverride: { textDark: state.s === "error" ? "#b42318" : "#8a837b" } } as GridCell;
  }
  return { kind: GridCellKind.Custom, data: { kind: "rf-ai", state: state.s, text, error: state.e }, copyData: text, allowOverlay: false, readonly: true } as AiCell;
}

/** Cuts text to the width with "...", instead of squeezing it. */
function fit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let lo = 0, hi = Math.min(text.length, 400);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + "...").width <= width) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "...";
}

export const aiRenderer: CustomRenderer<AiCell> = {
  kind: GridCellKind.Custom,
  isMatch: (c): c is AiCell => (c.data as AiData | undefined)?.kind === "rf-ai",
  draw: (args, cell) => {
    const { ctx, rect, theme } = args;
    const pad = theme.cellHorizontalPadding;
    const cy = rect.y + rect.height / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    ctx.textBaseline = "middle";
    ctx.font = `12.5px ${theme.fontFamily}`;
    const failed = cell.data.state === "error";
    const label = failed ? `! ${cell.data.error ?? "Failed"}` : cell.data.state === "running" ? "Generating..." : "Waiting...";
    const room = rect.width - 2 * pad;
    ctx.fillStyle = failed ? "#b42318" : theme.textLight;
    ctx.fillText(fit(ctx, label, room), rect.x + pad, cell.data.text ? cy - 7 : cy);
    if (cell.data.text) {
      ctx.fillStyle = theme.textMedium;
      ctx.fillText(fit(ctx, cell.data.text.replace(/\s+/g, " "), room), rect.x + pad, cy + 8);
    }
    ctx.restore();
    return true;
  },
};

/** Header icon of AI fields (a sparkle), registered with the grid's headerIcons. */
export const AI_HEADER_ICONS = {
  ai: (p: { fgColor: string; bgColor: string }) =>
    `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="22" height="22" rx="5" fill="${p.bgColor}"/><path d="M11 4l1.9 5.1L18 11l-5.1 1.9L11 18l-1.9-5.1L4 11l5.1-1.9zM18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z" fill="${p.fgColor}"/></svg>`,
};

export const AI_STATE_TEXT: Record<AiCellState["s"], string> = { queued: "Waiting...", running: "Generating...", error: "Failed", edited: "Edited by hand" };
