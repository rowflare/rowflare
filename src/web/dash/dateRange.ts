// Dashboard date range presets, computed from the viewer's local day.
import { addDays, addMonths, diffDays, startOfMonth, startOfWeek, type Day } from "../base/dates";

export type RangePreset = "all" | "week" | "month" | "quarter" | "year" | "last7" | "last30" | "custom";

export interface DayRange {
  from: Day;
  to: Day;
}

export const PRESET_LABELS: Record<RangePreset, string> = {
  all: "All time",
  week: "This week",
  month: "This month",
  quarter: "This quarter",
  year: "This year",
  last7: "Last 7 days",
  last30: "Last 30 days",
  custom: "Custom",
};

const startOfQuarter = (d: Day): Day => `${d.slice(0, 4)}-${String(Math.floor((+d.slice(5, 7) - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;

export function presetRange(p: RangePreset, today: Day, custom?: DayRange): DayRange | null {
  switch (p) {
    case "all":
      return null;
    case "week": {
      const s = startOfWeek(today);
      return { from: s, to: addDays(s, 6) };
    }
    case "month": {
      const s = startOfMonth(today);
      return { from: s, to: addDays(addMonths(s, 1), -1) };
    }
    case "quarter": {
      const s = startOfQuarter(today);
      return { from: s, to: addDays(addMonths(s, 3), -1) };
    }
    case "year":
      return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
    case "last7":
      return { from: addDays(today, -6), to: today };
    case "last30":
      return { from: addDays(today, -29), to: today };
    case "custom":
      if (!custom?.from || !custom.to) return null;
      // Dates entered the wrong way round mean the same days.
      return custom.from <= custom.to ? custom : { from: custom.to, to: custom.from };
  }
}

/** The period to compare with: the previous calendar period for calendar presets, else the same number of days just before. */
export function previousRange(p: RangePreset, r: DayRange): DayRange {
  const months = p === "month" ? 1 : p === "quarter" ? 3 : p === "year" ? 12 : 0;
  if (p === "week") return { from: addDays(r.from, -7), to: addDays(r.to, -7) };
  if (months) return { from: addMonths(r.from, -months), to: addDays(r.from, -1) };
  const n = diffDays(r.from, r.to) + 1;
  return { from: addDays(r.from, -n), to: addDays(r.from, -1) };
}
