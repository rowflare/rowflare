import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/web/router", () => ({ navigate: () => undefined }));
import { ApiError } from "../../src/web/api";
import { fmtUsage, limitOf, limitToast, setLimitContext } from "../../src/web/limits";

const err = new ApiError(402, "This plan allows 3 bases per workspace", { key: "bases", limit: 3, upgradeUrl: "https://example.com/up" });

describe("limit toasts", () => {
  it("owners get an Upgrade action", () => {
    setLimitContext("ws1", "owner");
    const t = limitToast(err as any);
    expect(t.text).toBe("This plan allows 3 bases per workspace");
    expect(t.action?.label).toBe("Upgrade");
  });

  it("other members are told to ask an owner", () => {
    setLimitContext("ws1", "editor");
    expect(limitToast(err as any)).toEqual({ text: "This plan allows 3 bases per workspace. Ask a workspace owner to upgrade." });
  });

  it("only 402 errors with a limit count", () => {
    expect(limitOf(new ApiError(400, "Bad"))).toBeUndefined();
    expect(limitOf(err)).toEqual(err.limit);
  });

  it("formats bytes for attachments", () => {
    expect(fmtUsage("attachments", 104_857_600)).toBe("104.9 MB");
    expect(fmtUsage("records", 1000)).toBe("1,000");
  });
});
