import { describe, expect, it } from "vitest";
import { addDays, addMonths, atMinutes, axisTicks, clip, dayOf, dayToX, diffDays, fmtMinutes, minutesOf, monthGrid, overlaps, packRows, spanOf, startOfWeek, weekDays, withDay, xToDay } from "../../src/web/base/dates";

describe("day arithmetic", () => {
  it("adds and diffs days across years and leap days", () => {
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(diffDays("2026-01-01", "2026-03-01")).toBe(59);
    expect(diffDays("2026-03-01", "2026-01-01")).toBe(-59);
  });

  it("finds the Monday of a week", () => {
    expect(startOfWeek("2026-01-01")).toBe("2025-12-29");
    expect(startOfWeek("2026-01-05")).toBe("2026-01-05");
    expect(startOfWeek("2026-01-11")).toBe("2026-01-05");
    expect(weekDays("2026-03-11")).toEqual(["2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13", "2026-03-14", "2026-03-15"]);
  });

  it("adds months and clamps the day", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
  });

  it("builds a six-week month grid starting on Monday", () => {
    const g = monthGrid("2026-03-17");
    expect(g).toHaveLength(6);
    expect(g.every(w => w.length === 7)).toBe(true);
    expect(g[0][0]).toBe("2026-02-23");
    expect(g[5][6]).toBe("2026-04-05");
    expect(g.flat()).toContain("2026-03-01");
    expect(g.flat()).toContain("2026-03-31");
  });
});

describe("spans", () => {
  it("spanOf reads start, end and duration", () => {
    expect(spanOf("2026-03-08", "2026-03-12")).toEqual({ start: "2026-03-08", end: "2026-03-12" });
    expect(spanOf("2026-03-01", undefined, 15)).toEqual({ start: "2026-03-01", end: "2026-03-15" });
    expect(spanOf("2026-03-01", undefined, 0)).toEqual({ start: "2026-03-01", end: "2026-03-01" });
    expect(spanOf(undefined, "2026-03-12")).toBeNull();
    expect(spanOf("2026-03-10", null)).toEqual({ start: "2026-03-10", end: "2026-03-10" });
  });

  it("spanOf collapses a backwards span", () => {
    expect(spanOf("2026-03-20", "2026-03-01")).toEqual({ start: "2026-03-20", end: "2026-03-20" });
  });

  it("overlaps and clips at the window edges", () => {
    const s = { start: "2026-03-08", end: "2026-03-12" };
    expect(overlaps(s, "2026-03-12", "2026-03-20")).toBe(true);
    expect(overlaps(s, "2026-03-13", "2026-03-20")).toBe(false);
    expect(overlaps(s, "2026-03-01", "2026-03-08")).toBe(true);
    expect(clip(s, "2026-03-10", "2026-03-31")).toEqual({ start: "2026-03-10", end: "2026-03-12", cutStart: true, cutEnd: false });
    expect(clip(s, "2026-03-01", "2026-03-09")).toEqual({ start: "2026-03-08", end: "2026-03-09", cutStart: false, cutEnd: true });
    expect(clip(s, "2026-04-01", "2026-04-09")).toBeNull();
  });

  it("packs spans into the first free row", () => {
    const packed = packRows([
      { start: "2026-03-01", end: "2026-03-03", n: "a" },
      { start: "2026-03-02", end: "2026-03-04", n: "b" },
      { start: "2026-03-04", end: "2026-03-05", n: "c" },
      { start: "2026-03-06", end: "2026-03-06", n: "d" },
    ]);
    expect(Object.fromEntries(packed.map(p => [p.n, p.row]))).toEqual({ a: 0, b: 1, c: 0, d: 0 });
  });
});

describe("timeline scale", () => {
  it("converts between days and pixels", () => {
    expect(dayToX("2026-03-10", "2026-03-01", 16)).toBe(144);
    expect(xToDay(dayToX("2026-03-10", "2026-03-01", 16) + 5, "2026-03-01", 16)).toBe("2026-03-10");
    expect(xToDay(-1, "2026-03-01", 16)).toBe("2026-02-28");
  });

  it("labels the axis per scale", () => {
    const weeks = axisTicks("2026-01-01", "2026-02-15", "week");
    expect(weeks[0]).toEqual({ day: "2026-01-05", label: "Jan 5", major: true });
    expect(weeks[1]).toEqual({ day: "2026-01-12", label: "12", major: false });
    expect(weeks.find(t => t.day === "2026-02-02")).toEqual({ day: "2026-02-02", label: "Feb 2", major: true });
    const months = axisTicks("2025-11-10", "2026-02-01", "month");
    expect(months.map(t => t.day)).toEqual(["2025-12-01", "2026-01-01", "2026-02-01"]);
    expect(months[1]).toEqual({ day: "2026-01-01", label: "Jan 2026", major: true });
    const days = axisTicks("2026-03-08", "2026-03-10", "day");
    expect(days).toEqual([{ day: "2026-03-08", label: "8", major: false }, { day: "2026-03-09", label: "9", major: true }, { day: "2026-03-10", label: "10", major: false }]);
  });
});

describe("stored values", () => {
  it("reads days and minutes in any time zone", () => {
    expect(dayOf("2026-03-10")).toBe("2026-03-10");
    expect(dayOf("")).toBeNull();
    expect(dayOf("not a date")).toBeNull();
    expect(minutesOf("2026-03-10")).toBeNull();
    const v = atMinutes("2026-03-10", 570);
    expect(dayOf(v)).toBe("2026-03-10");
    expect(minutesOf(v)).toBe(570);
    expect(fmtMinutes(570)).toBe("9:30");
    expect(fmtMinutes(0)).toBe("0:00");
  });

  it("withDay keeps the time of day", () => {
    expect(withDay(undefined, "2026-03-10", false)).toBe("2026-03-10");
    const moved = withDay(atMinutes("2026-03-01", 615), "2026-03-10", true);
    expect(dayOf(moved)).toBe("2026-03-10");
    expect(minutesOf(moved)).toBe(615);
    expect(minutesOf(withDay(undefined, "2026-03-10", true))).toBe(540);
  });
});

describe("query window", () => {
  it("pads a day on each side so local datetimes near midnight are not lost to the UTC day split", async () => {
    const { queryWindow } = await import("../../src/web/base/dates");
    expect(queryWindow("2026-10-12", "2026-10-18")).toEqual({ from: "2026-10-11", to: "2026-10-19" });
  });
});
