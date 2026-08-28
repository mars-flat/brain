/**
 * Stateless HMAC-signed session cookie. No server-side store: the console
 * restarts freely (deploys!) without logging anyone out, and there is one
 * user. Payload is visible-but-tamperproof; nothing secret rides in it.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface Session {
  sub: string;
  email?: string;
  /** Unix ms. */
  exp: number;
}

const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");

function sig(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function sealSession(session: Session, secret: string): string {
  const payload = b64u(JSON.stringify(session));
  return `${payload}.${sig(payload, secret)}`;
}

export function openSession(
  cookie: string | undefined,
  secret: string,
  now: number,
): Session | null {
  if (!cookie) return null;
  const dot = cookie.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = cookie.slice(0, dot);
  const given = cookie.slice(dot + 1);
  const want = sig(payload, secret);
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
    if (typeof session.sub !== "string" || typeof session.exp !== "number") return null;
    if (session.exp <= now) return null;
    return session;
  } catch {
    return null;
  }
}

export function cookieHeader(
  name: string,
  value: string,
  maxAgeS: number,
  secure: boolean,
): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}
