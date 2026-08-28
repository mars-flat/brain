/**
 * The Google REST substrate: refresh→access exchange with in-process expiry
 * caching (the deliver.ts pattern, minus the disk cache — this server is
 * long-lived), and an authed request helper with a single forced-refresh
 * retry on 401. Base URLs are injectable so tests run against a fake
 * (§8.2 — no real APIs or identity in CI).
 */

export interface GoogleClientOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUrl?: string;
  gmailBase?: string;
  driveBase?: string;
  uploadBase?: string;
  fetchFn?: typeof fetch;
  /** Unix milliseconds. */
  now?: () => number;
}

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 60s skew: never present a token that dies mid-request. */
const EXPIRY_SKEW_S = 60;

export class GoogleClient {
  readonly gmailBase: string;
  readonly driveBase: string;
  readonly uploadBase: string;
  private readonly tokenUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(private readonly opts: GoogleClientOptions) {
    this.tokenUrl = opts.tokenUrl ?? "https://oauth2.googleapis.com/token";
    this.gmailBase = opts.gmailBase ?? "https://gmail.googleapis.com/gmail/v1";
    this.driveBase = opts.driveBase ?? "https://www.googleapis.com/drive/v3";
    this.uploadBase = opts.uploadBase ?? "https://www.googleapis.com/upload/drive/v3";
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async accessToken(force = false): Promise<string> {
    if (!force && this.cached && this.cached.expiresAt - EXPIRY_SKEW_S * 1000 > this.now())
      return this.cached.token;
    const res = await this.fetchFn(this.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.opts.refreshToken,
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      const hint = body.includes("invalid_grant")
        ? " — refresh token revoked/expired; re-consent with scripts/google-auth.ts"
        : "";
      throw new GoogleApiError(res.status, `token refresh failed (${res.status})${hint}: ${body}`);
    }
    const tok = (await res.json()) as { access_token: string; expires_in?: number };
    this.cached = {
      token: tok.access_token,
      expiresAt: this.now() + (tok.expires_in ?? 300) * 1000,
    };
    return tok.access_token;
  }

  /** Authed fetch with one forced token refresh on 401 (revocation-safe). */
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const attempt = async (force: boolean) =>
      this.fetchFn(url, {
        ...init,
        headers: {
          ...((init.headers as Record<string, string>) ?? {}),
          authorization: `Bearer ${await this.accessToken(force)}`,
        },
      });
    let res = await attempt(false);
    if (res.status === 401) res = await attempt(true);
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { message?: string; status?: string } };
        if (body.error?.message) message = `${message} — ${body.error.message}`;
      } catch {
        // non-JSON error body: status alone is the message
      }
      throw new GoogleApiError(res.status, message);
    }
    return res;
  }

  async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(url, init);
    // DELETE and some PATCHes return 204/empty bodies.
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
}
