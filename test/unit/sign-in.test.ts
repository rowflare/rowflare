import { describe, expect, it } from "vitest";
import { safeNextPath, signInErrorText } from "../../src/shared/sign-in";

describe("safeNextPath", () => {
  it("keeps paths inside the app", () => {
    expect(safeNextPath("/settings/account?ws=1#x")).toBe("/settings/account?ws=1#x");
  });

  it("falls back to / for anything that could leave the app", () => {
    for (const bad of [undefined, null, "", "settings", "https://evil.example/", "//evil.example/", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", "/%09ok\r", "/\u007f"]) expect(safeNextPath(bad)).toBe("/");
  });
});

describe("signInErrorText", () => {
  it("maps known codes to fixed texts", () => {
    expect(signInErrorText("cancelled")).toBe("Sign-in was cancelled.");
    expect(signInErrorText("expired")).toBe("Sign-in took too long or started in another browser. Please try again.");
    expect(signInErrorText("invite-only")).toBe("Sign up is invite-only on this instance.");
  });

  it("never shows text from the address", () => {
    expect(signInErrorText("Your account is locked, call +1 555 0100")).toBe("Sign-in did not work. Please try again.");
    expect(signInErrorText(null)).toBeNull();
  });
});
