import { describe, expect, it } from "vitest";
import { dateDue, dueDayWindow, nextScheduleTime, zonedParts, zonedToUtc } from "../../src/shared/schedule";

const iso = (ms: number) => new Date(ms).toISOString();
const at = (s: string) => Date.parse(s);

describe("time zones", () => {
  it("converts a wall clock time to UTC", () => {
    expect(iso(zonedToUtc(2026, 10, 13, 9, 0, "Asia/Shanghai"))).toBe("2026-10-13T01:00:00.000Z");
    expect(iso(zonedToUtc(2026, 7, 1, 9, 0, "America/New_York"))).toBe("2026-07-01T13:00:00.000Z");
  });

  it("moves a time skipped by DST to the same clock time after the change", () => {
    expect(iso(zonedToUtc(2026, 3, 8, 2, 30, "America/New_York"))).toBe("2026-03-08T07:30:00.000Z");
    expect(iso(zonedToUtc(2026, 3, 8, 3, 30, "America/New_York"))).toBe("2026-03-08T07:30:00.000Z");
  });

  it("takes the first of two repeated times", () => {
    expect(iso(zonedToUtc(2026, 11, 1, 1, 30, "America/New_York"))).toBe("2026-11-01T05:30:00.000Z");
    expect(iso(zonedToUtc(2026, 10, 25, 1, 30, "Europe/London"))).toBe("2026-10-25T00:30:00.000Z");
  });

  it("reads local parts", () => {
    expect(zonedParts(Date.UTC(2026, 9, 12, 23, 30), "Asia/Tokyo")).toEqual({ y: 2026, m: 10, d: 13, hh: 8, mm: 30, wd: 2 });
  });
});

describe("next schedule time", () => {
  it("runs daily at the local time", () => {
    const t = { type: "schedule" as const, every: "day" as const, at: "09:00", tz: "Asia/Shanghai" };
    expect(iso(nextScheduleTime(t, at("2026-10-13T00:00:00Z")))).toBe("2026-10-13T01:00:00.000Z");
    expect(iso(nextScheduleTime(t, at("2026-10-13T01:00:00Z")))).toBe("2026-10-14T01:00:00.000Z");
  });

  it("runs weekly on the weekday", () => {
    const t = { type: "schedule" as const, every: "week" as const, weekday: 1, at: "08:00", tz: "UTC" };
    expect(iso(nextScheduleTime(t, at("2026-10-13T12:00:00Z")))).toBe("2026-10-19T08:00:00.000Z");
  });

  it("runs monthly, on the last day when the month is shorter", () => {
    const t = { type: "schedule" as const, every: "month" as const, monthday: 31, at: "10:00", tz: "UTC" };
    expect(iso(nextScheduleTime(t, at("2026-02-01T00:00:00Z")))).toBe("2026-02-28T10:00:00.000Z");
    expect(iso(nextScheduleTime(t, at("2028-02-01T00:00:00Z")))).toBe("2028-02-29T10:00:00.000Z");
    expect(iso(nextScheduleTime(t, at("2026-02-28T10:00:00Z")))).toBe("2026-03-31T10:00:00.000Z");
  });

  it("runs every N hours from local midnight", () => {
    const t = { type: "schedule" as const, every: "hour" as const, interval: 6, at: "00:15", tz: "UTC" };
    expect(iso(nextScheduleTime(t, at("2026-10-13T06:15:00Z")))).toBe("2026-10-13T12:15:00.000Z");
  });

  it("still runs once on a spring-forward day", () => {
    const t = { type: "schedule" as const, every: "day" as const, at: "02:30", tz: "America/New_York" };
    expect(iso(nextScheduleTime(t, at("2026-03-08T00:00:00Z")))).toBe("2026-03-08T07:30:00.000Z");
    expect(iso(nextScheduleTime(t, at("2026-03-08T07:30:00Z")))).toBe("2026-03-09T06:30:00.000Z");
  });
});

describe("date triggers", () => {
  it("uses the trigger's time for date-only cells", () => {
    expect(iso(dateDue("2026-10-20", { offsetMinutes: -1440, at: "09:00", tz: "Asia/Shanghai" })!)).toBe("2026-10-19T01:00:00.000Z");
    expect(iso(dateDue("2026-10-20", { offsetMinutes: 0, tz: "UTC" })!)).toBe("2026-10-20T09:00:00.000Z");
  });

  it("uses the instant of date-and-time cells", () => {
    expect(iso(dateDue("2026-10-20T15:00:00.000Z", { offsetMinutes: -60, tz: "UTC" })!)).toBe("2026-10-20T14:00:00.000Z");
  });

  it("ignores empty or invalid cells", () => {
    expect(dateDue(undefined, { offsetMinutes: 0, tz: "UTC" })).toBeNull();
    expect(dateDue("soon", { offsetMinutes: 0, tz: "UTC" })).toBeNull();
  });

  it("widens the day window by two days on each side", () => {
    expect(dueDayWindow(at("2026-10-13T00:00:00Z"), at("2026-10-14T00:00:00Z"), -1440)).toEqual(["2026-10-12", "2026-10-17"]);
  });
});
