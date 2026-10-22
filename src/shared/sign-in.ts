// Sign-in helpers shared by the web client and a hosting's own sign-in routes.

/** The path to open after signing in: only a path inside the app, else "/". Control characters and backslashes are refused because browsers drop or rewrite them, which can turn "/\t/x" into "//x". */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || /[\u0000-\u001f\u007f\\]/.test(next)) return "/";
  return next;
}

/** Errors a sign-in can come back with, as `?error=<code>` on the sign-in page. Only these texts are shown, never text from the address. */
export const SIGN_IN_ERRORS: Record<string, string> = {
  cancelled: "Sign-in was cancelled.",
  expired: "Sign-in took too long or started in another browser. Please try again.",
  unverified: "That account has no verified email address. Use one that has, or sign in with an email code.",
  unavailable: "The sign-in service could not be reached. Please try again.",
  "invite-only": "Sign up is invite-only on this instance.",
  invite: "This invite link is invalid or expired.",
};

export function signInErrorText(code: string | null | undefined): string | null {
  if (!code) return null;
  return Object.hasOwn(SIGN_IN_ERRORS, code) ? SIGN_IN_ERRORS[code] : "Sign-in did not work. Please try again.";
}
