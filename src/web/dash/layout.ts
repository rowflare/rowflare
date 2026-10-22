// Grid sizes for dashboards and the conversions between widgets and react-grid-layout items.
import type { Widget } from "../../shared/types";
import type { LayoutItemInput } from "../../shared/widgets";

export const ROW_H = 80;
export const MOBILE_BREAK = 768;

export interface GridItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

/** Reading order for the one-column phone layout. */
export function stackOrder(ws: Widget[]): Widget[] {
  return [...ws].sort((a, b) => a.y - b.y || a.x - b.x);
}

export function layoutOf(ws: Widget[]): GridItem[] {
  return ws.map(w => ({ i: w.id, x: w.x, y: w.y, w: w.w, h: w.h, minW: 2, minH: w.type === "text" || w.type === "metric" ? 1 : 2 }));
}

/** Widgets whose position differs in a new layout, as setLayout items. */
export function changedPositions(ws: Widget[], layout: readonly GridItem[]): LayoutItemInput[] {
  const byId = new Map(ws.map(w => [w.id, w]));
  return layout.filter(l => {
    const w = byId.get(l.i);
    return w && (w.x !== l.x || w.y !== l.y || w.w !== l.w || w.h !== l.h);
  }).map(l => ({ id: l.i, x: l.x, y: l.y, w: l.w, h: l.h }));
}
