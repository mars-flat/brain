/**
 * The console service (W1): auth middleware in front of the vault viewer
 * and the dashboard. Loopback-bound; TLS and network exposure are the
 * front proxy's problem (§3.1) — this process assumes the network already
 * kept strangers out and still verifies identity anyway.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { BrainStore, openDb } from "@brain/brainstore";
import { type ConsoleConfig, loadVaultConsoleConfig } from "./config.ts";
import { dashboardPage } from "./dashboard.ts";
import { esc, page } from "./html.ts";
import { buildAuthRequest, exchangeCode, type OidcClient } from "./oidc.ts";
import { cookieHeader, openSession, readCookie, type Session, sealSession } from "./session.ts";
import { episodesPage, indexPage, nodePage, searchPage } from "./vault-view.ts";

const SESSION_COOKIE = "console_session";
const OAUTH_COOKIE = "console_oauth";

export interface RunningConsole {
  url: string;
  stop(): void;
}

export function startConsole(cfg: ConsoleConfig): RunningConsole {
  const dbPath = join(cfg.vaultPath, "_index", "brain.db");
  if (!existsSync(dbPath))
    throw new Error(`console: no index at ${dbPath} — run \`brain rebuild\` first (§5.11)`);
  const db = openDb(dbPath);
  const store = new BrainStore(db);
  const secure = cfg.baseUrl.startsWith("https://");
  const client: OidcClient = {
    issuer: cfg.issuer,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    redirectUri: `${cfg.baseUrl}/callback`,
  };

  const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
    new Response(body, {
      status,
      headers: { "content-type": "text/html; charset=utf-8", ...headers },
    });
  const redirect = (to: string, headers: Record<string, string> = {}) =>
    new Response(null, { status: 302, headers: { location: to, ...headers } });

  const server = Bun.serve({
    port: cfg.port,
    hostname: cfg.host,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/healthz") return new Response("ok");

      if (path === "/login") {
        const auth = await buildAuthRequest(client);
        const state = sealSession(
          { sub: `${auth.state}:${auth.verifier}`, exp: Date.now() + 600_000 },
          cfg.sessionSecret,
        );
        return redirect(auth.url, {
          "set-cookie": cookieHeader(OAUTH_COOKIE, state, 600, secure),
        });
      }

      if (path === "/callback") {
        const stashed = openSession(readCookie(req, OAUTH_COOKIE), cfg.sessionSecret, Date.now());
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!stashed || !code || !state) return html(errorPage("login expired — try again"), 400);
        const [wantState, verifier] = stashed.sub.split(":");
        if (state !== wantState) return html(errorPage("state mismatch"), 400);
        const who = await exchangeCode(client, code, verifier ?? "");
        if (cfg.allowedSubs.length > 0 && !cfg.allowedSubs.includes(who.sub)) {
          // Show the sub: pinning the right identity requires knowing it.
          return html(
            errorPage(
              `this console is pinned to its owner. your identity: <code>${esc(who.sub)}</code>`,
            ),
            403,
          );
        }
        const session: Session = {
          sub: who.sub,
          email: who.email,
          exp: Date.now() + cfg.sessionTtlMs,
        };
        return redirect("/", {
          "set-cookie": cookieHeader(
            SESSION_COOKIE,
            sealSession(session, cfg.sessionSecret),
            Math.floor(cfg.sessionTtlMs / 1000),
            secure,
          ),
        });
      }

      if (path === "/logout")
        return redirect("/login", { "set-cookie": cookieHeader(SESSION_COOKIE, "", 0, secure) });

      // ── everything below requires identity ─────────────────────────────
      const session = openSession(readCookie(req, SESSION_COOKIE), cfg.sessionSecret, Date.now());
      if (!session) return redirect("/login");
      if (cfg.allowedSubs.length > 0 && !cfg.allowedSubs.includes(session.sub))
        return html(errorPage("session identity is not the pinned owner"), 403);

      if (path === "/") return html(indexPage(store));
      if (path === "/episodes") return html(episodesPage(store));
      if (path === "/search") return html(searchPage(store, url.searchParams.get("q") ?? ""));
      if (path.startsWith("/node/")) {
        const id = decodeURIComponent(path.slice("/node/".length));
        if (!/^[a-z0-9-]+$/.test(id)) return html(errorPage("bad node id"), 400);
        const rendered = nodePage(store, id);
        return rendered ? html(rendered) : html(errorPage(`no node “${esc(id)}”`), 404);
      }
      if (path === "/dashboard") {
        const vaultCfg = loadVaultConsoleConfig(cfg.vaultPath);
        return html(await dashboardPage(cfg, vaultCfg, store, db, session.sub));
      }
      return html(errorPage("not found"), 404);
    },
  });

  return {
    url: `http://${cfg.host}:${cfg.port}`,
    stop: () => server.stop(true),
  };
}

function errorPage(message: string): string {
  return page("console", `<h1>hm.</h1><p>${message}</p><p><a href="/">back</a></p>`, {
    authed: false,
  });
}
