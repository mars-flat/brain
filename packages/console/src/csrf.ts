/**
 * CSRF defence for the console's one write path (§16.4). SameSite=Lax on
 * the session cookie is most of the defence but not all of it — a top-level
 * navigation POST from another site still carries the cookie in some
 * browsers — so every mutating form carries a token bound to the session
 * (HMAC of sub + expiry under the session secret; nothing to store) and
 * every POST must also prove same-origin via the Origin/Referer header.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Session } from "./session.ts";

export function csrfToken(session: Session, secret: string): string {
  return createHmac("sha256", secret)
    .update(`csrf:${session.sub}:${session.exp}`)
    .digest("base64url");
}

export function csrfOk(given: string | undefined, session: Session, secret: string): boolean {
  if (!given) return false;
  const want = csrfToken(session, secret);
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Origin must match when present; else Referer; a POST with neither is refused. */
export function sameOrigin(req: Request, baseUrl: string): boolean {
  const base = new URL(baseUrl).origin;
  const origin = req.headers.get("origin");
  if (origin) return origin === base;
  const referer = req.headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === base;
  } catch {
    return false;
  }
}
