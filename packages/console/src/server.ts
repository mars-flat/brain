/**
 * The console service (W1): auth middleware in front of the vault viewer
 * and the dashboard. Loopback-bound; TLS and network exposure are the
 * front proxy's problem (§3.1) — this process assumes the network already
 * kept strangers out and still verifies identity anyway.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { BrainStore, openDb } from "@brain/brainstore";
import { architecturePage } from "./architecture.ts";
import { type ConsoleConfig, loadVaultConsoleConfig } from "./config.ts";
import { clearTileCache, dashboardPage } from "./dashboard.ts";
import { graphJson, graphPage } from "./graph.ts";
import { esc, page } from "./html.ts";
import { buildAuthRequest, discover, exchangeCode, type OidcClient } from "./oidc.ts";
import { clearProbeCache } from "./services.ts";
import { cookieHeader, openSession, readCookie, type Session, sealSession } from "./session.ts";
import { nodePage, searchPage, vaultPage } from "./vault-view.ts";

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

  // Manual dashboard refresh throttle: at most one forced cache drop per
  // minute, whatever the button-mashing rate — upstream APIs stay calm.
  let lastForcedRefresh = 0;

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

      if (path === "/logout") {
        // Clear the session and STOP — bouncing straight to /login would
        // let the IdP's SSO cookie sign the owner right back in, which
        // makes the logout button a no-op. Ending the IdP session too is
        // offered as an explicit second step.
        const idpLogout = await discover(client.issuer)
          .then((m) => m.end_session_endpoint)
          .catch(() => undefined);
        return html(
          page(
            "signed out",
            `<h1>signed out</h1>
             <p>your console session is gone.</p>
             <ul class="plain">
               <li><a href="/login">sign back in</a></li>
               ${idpLogout ? `<li><a href="${esc(idpLogout)}" rel="noreferrer">also sign out at the identity provider</a> <span class="muted">— otherwise its single-sign-on session survives</span></li>` : ""}
             </ul>`,
            { authed: false },
          ),
          200,
          { "set-cookie": cookieHeader(SESSION_COOKIE, "", 0, secure) },
        );
      }

      // ── everything below requires identity ─────────────────────────────
      const session = openSession(readCookie(req, SESSION_COOKIE), cfg.sessionSecret, Date.now());
      if (!session) return redirect("/login");
      if (cfg.allowedSubs.length > 0 && !cfg.allowedSubs.includes(session.sub))
        return html(errorPage("session identity is not the pinned owner"), 403);

      // The graph is the front door; the vault (with its episodes view)
      // is the second tab. Old bookmarks land where the content went.
      if (path === "/") return html(graphPage(store));
      if (path === "/vault")
        return html(
          vaultPage(store, url.searchParams.get("view") === "episodes" ? "episodes" : "nodes"),
        );
      if (path === "/episodes") return redirect("/vault?view=episodes");
      if (path === "/graph") return redirect("/");
      if (path === "/graph.json")
        return new Response(graphJson(store), {
          headers: { "content-type": "application/json" },
        });
      if (path === "/graph.js")
        return new Response(Bun.file(join(import.meta.dir, "graph-client.js")), {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      if (path === "/search") return html(searchPage(store, url.searchParams.get("q") ?? ""));
      if (path.startsWith("/node/")) {
        const id = decodeURIComponent(path.slice("/node/".length));
        if (!/^[a-z0-9-]+$/.test(id)) return html(errorPage("bad node id"), 400);
        const rendered = nodePage(store, id);
        return rendered ? html(rendered) : html(errorPage(`no node “${esc(id)}”`), 404);
      }
      if (path === "/dashboard/refresh" && req.method === "POST") {
        const wait = 60_000 - (Date.now() - lastForcedRefresh);
        if (wait > 0)
          return new Response(null, {
            status: 303,
            headers: { location: `/dashboard?throttled=${Math.ceil(wait / 1000)}` },
          });
        lastForcedRefresh = Date.now();
        clearTileCache();
        clearProbeCache();
        return new Response(null, {
          status: 303,
          headers: { location: "/dashboard?refreshed=1" },
        });
      }
      if (path === "/dashboard") {
        const vaultCfg = loadVaultConsoleConfig(cfg.vaultPath);
        const throttled = Number(url.searchParams.get("throttled"));
        const notice =
          url.searchParams.get("refreshed") === "1"
            ? `<p class="ok">refreshed — every card refetched live</p>`
            : Number.isFinite(throttled) && throttled > 0
              ? `<p class="warn">throttled — next refresh in ${Math.min(Math.ceil(throttled), 60)}s</p>`
              : "";
        return html(await dashboardPage(cfg, vaultCfg, store, db, session.sub, notice));
      }
      if (path === "/architecture") return html(architecturePage());
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
