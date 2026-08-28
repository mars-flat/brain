/**
 * External-service cards (W1.4+): for each SaaS the system leans on —
 * which account signs in, the official console, what credentials exist
 * and when they die, and a live probe where the console can run one
 * without new secrets. Probes degrade to config-only truth; a dead
 * upstream never breaks the page. These are SaaS dependencies, NOT MCP
 * servers — those have their own section (dashboard.ts).
 *
 * Live probes and what they need:
 *   azure   ARM read via the VM's managed identity (IMDS), falling back
 *           to the az CLI on a dev laptop; needs `subscription` in config.
 *           VM roster + power state, retail-rate estimate, budgets+spend.
 *   oidc    unauthenticated OIDC discovery of the console's own issuer.
 *   openai  GET /v1/models with OPENAI_API_KEY if the env carries it.
 *   vercel  GET /v2/user with VERCEL_API_TOKEN if the env carries it.
 */

import type { ServiceEntry, ServiceToken } from "./config.ts";
import { esc } from "./html.ts";

export type Grade = "ok" | "warn" | "bad";

export function gradeDays(days: number): Grade {
  return days < 7 ? "bad" : days < 21 ? "warn" : "ok";
}

/** Sorted, urgency-graded credential rows; shared by tiles and cards. */
export function tokenRows(tokens: ServiceToken[], now: Date): { html: string; worst: Grade } {
  let worst: Grade = "ok";
  const rows = tokens
    .slice()
    .sort((a, b) => (a.expires ?? "9999").localeCompare(b.expires ?? "9999"))
    .map((t) => {
      if (!t.expires)
        return `<li><span class="muted">no expiry</span> ${esc(t.name)}${t.note ? ` <span class="muted">— ${esc(t.note)}</span>` : ""}</li>`;
      const days = Math.floor((Date.parse(t.expires) - now.getTime()) / 86_400_000);
      const cls = gradeDays(days);
      if (cls === "bad" || (cls === "warn" && worst === "ok")) worst = cls;
      return `<li><span class="${cls}">${days < 0 ? "EXPIRED" : `${days}d`}</span>
        ${esc(t.name)} <span class="muted">${esc(t.expires)}${t.note ? ` — ${esc(t.note)}` : ""}</span></li>`;
    });
  return { html: rows.join(""), worst };
}

// ── azure ────────────────────────────────────────────────────────────────

const ARM = "https://management.azure.com";

/** IMDS on the VM (managed identity), else the az CLI on a dev laptop. */
async function armToken(): Promise<{ token: string; via: string } | null> {
  try {
    const res = await fetch(
      "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fmanagement.azure.com%2F",
      { headers: { Metadata: "true" }, signal: AbortSignal.timeout(3000) },
    );
    if (res.ok) {
      const token = ((await res.json()) as { access_token?: string }).access_token;
      if (token) return { token, via: "managed identity" };
    }
  } catch {}
  try {
    const az = Bun.spawnSync([
      "az",
      "account",
      "get-access-token",
      "--resource",
      "https://management.azure.com",
      "--query",
      "accessToken",
      "-o",
      "tsv",
    ]);
    const token = az.exitCode === 0 ? az.stdout.toString().trim() : "";
    if (token) return { token, via: "az cli" };
  } catch {}
  return null;
}

async function arm<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${ARM}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`ARM ${res.status} on ${path.split("?")[0]}`);
  return (await res.json()) as T;
}

/** Public retail-rate lookup (no auth); cached long — prices don't move. */
const priceCache = new Map<string, { at: number; monthly: number | null }>();

async function monthlyRate(sku: string, region: string): Promise<number | null> {
  const key = `${sku}/${region}`;
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.monthly;
  let monthly: number | null = null;
  try {
    const filter = `serviceName eq 'Virtual Machines' and armRegionName eq '${region}' and armSkuName eq '${sku}' and priceType eq 'Consumption'`;
    const res = await fetch(
      `https://prices.azure.com/api/retail/prices?currencyCode='CAD'&$filter=${encodeURIComponent(filter)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (res.ok) {
      const data = (await res.json()) as {
        Items?: Array<{ retailPrice: number; productName: string; meterName: string }>;
      };
      const linux = (data.Items ?? []).find(
        (i) =>
          !i.productName.includes("Windows") &&
          !i.meterName.includes("Spot") &&
          !i.meterName.includes("Low Priority"),
      );
      if (linux) monthly = linux.retailPrice * 730;
    }
  } catch {}
  priceCache.set(key, { at: Date.now(), monthly });
  return monthly;
}

interface ArmVm {
  id: string;
  name: string;
  location: string;
  properties?: { hardwareProfile?: { vmSize?: string } };
}

export async function azureProbe(subscription: string): Promise<{ html: string; cls: Grade }> {
  const auth = await armToken();
  if (!auth)
    return {
      html: `<span class="warn">no ARM credential</span> <span class="muted">— needs the VM's managed identity (or az login in dev); showing config only</span>`,
      cls: "warn",
    };

  const vms = await arm<{ value: ArmVm[] }>(
    auth.token,
    `/subscriptions/${subscription}/providers/Microsoft.Compute/virtualMachines?api-version=2024-07-01`,
  );
  const rows = await Promise.all(
    vms.value.slice(0, 6).map(async (vm) => {
      const size = vm.properties?.hardwareProfile?.vmSize ?? "?";
      const [state, rate] = await Promise.all([
        arm<{ statuses?: Array<{ code: string }> }>(
          auth.token,
          `${vm.id}/instanceView?api-version=2024-07-01`,
        )
          .then(
            (iv) =>
              iv.statuses
                ?.find((s) => s.code.startsWith("PowerState/"))
                ?.code.slice("PowerState/".length) ?? "?",
          )
          .catch(() => "?"),
        monthlyRate(size, vm.location),
      ]);
      const stateCls = state === "running" ? "ok" : "warn";
      return `<tr><td>${esc(vm.name)}<br><span class="muted">${esc(vm.location)}</span></td>
        <td>${esc(size.replace(/^Standard_/, ""))}</td>
        <td><span class="${stateCls}">${esc(state)}</span></td>
        <td>${rate ? `~$${rate.toFixed(0)}/mo` : `<span class="muted">?</span>`}</td></tr>`;
    }),
  );
  const vmTable = rows.length
    ? `<div class="scroll"><table class="slim"><tr><th>vm</th><th>size</th><th>state</th><th>rate (CAD)</th></tr>${rows.join("")}</table></div>`
    : `<p class="muted">no VMs</p>`;

  let budgetHtml = "";
  let cls: Grade = "ok";
  let totalSpend = 0;
  try {
    const budgets = await arm<{
      value: Array<{
        name: string;
        properties: {
          amount: number;
          timeGrain: string;
          currentSpend?: { amount: number; unit: string };
        };
      }>;
    }>(
      auth.token,
      `/subscriptions/${subscription}/providers/Microsoft.Consumption/budgets?api-version=2023-05-01`,
    );
    budgetHtml = `<ul class="plain">${budgets.value
      .map((b) => {
        const spent = b.properties.currentSpend?.amount ?? 0;
        totalSpend += spent;
        const pct = b.properties.amount > 0 ? (spent / b.properties.amount) * 100 : 0;
        const bCls: Grade = pct >= 90 ? "bad" : pct >= 60 ? "warn" : "ok";
        if (bCls === "bad" || (bCls === "warn" && cls === "ok")) cls = bCls;
        return `<li><span class="${bCls}">${pct.toFixed(0)}%</span> ${esc(b.name)}
          <span class="muted">$${spent.toFixed(2)} of $${b.properties.amount} ${esc(b.properties.timeGrain.toLowerCase())}</span></li>`;
      })
      .join("")}</ul>${
      totalSpend === 0
        ? `<p class="muted">all zero is the sponsorship quirk — credit burn can lag or not count as "spend" here; the portal's Cost Management is authoritative</p>`
        : ""
    }`;
  } catch (e) {
    budgetHtml = `<p class="warn">budgets unavailable: ${esc(e instanceof Error ? e.message : String(e))}</p>`;
    cls = "warn";
  }

  return {
    html: `<span class="ok">ARM live</span> <span class="muted">via ${auth.via}</span>
      ${vmTable}
      <p class="sect"><strong>budgets</strong></p>${budgetHtml}`,
    cls,
  };
}

// ── the simpler probes ───────────────────────────────────────────────────

async function oidcProbe(issuer: string): Promise<{ html: string; cls: Grade }> {
  const res = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`discovery HTTP ${res.status}`);
  const meta = (await res.json()) as { issuer?: string };
  return {
    html: `<span class="ok">issuer reachable</span> <span class="muted">${esc(meta.issuer ?? issuer)}</span>`,
    cls: "ok",
  };
}

/**
 * Month-to-date OpenAI spend. The costs endpoint needs the org-level
 * `api.usage.read` scope, which regular API keys lack (verified: 403) —
 * only an Admin API key carries it, so this is a separate optional env.
 */
async function openaiSpend(): Promise<string> {
  const admin = process.env.OPENAI_ADMIN_KEY;
  if (!admin)
    return ` · <span class="muted">spend needs OPENAI_ADMIN_KEY (admin key, api.usage.read)</span>`;
  const now = new Date();
  const start = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
  const res = await fetch(
    `https://api.openai.com/v1/organization/costs?start_time=${start}&limit=31`,
    { headers: { authorization: `Bearer ${admin}` }, signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) return ` · <span class="warn">spend unavailable: HTTP ${res.status}</span>`;
  const data = (await res.json()) as {
    data?: Array<{ results?: Array<{ amount?: { value?: number; currency?: string } }> }>;
  };
  let total = 0;
  let currency = "usd";
  for (const bucket of data.data ?? [])
    for (const r of bucket.results ?? []) {
      total += r.amount?.value ?? 0;
      currency = r.amount?.currency ?? currency;
    }
  return ` · <strong>$${total.toFixed(2)}</strong> <span class="muted">${esc(currency.toUpperCase())} this month</span>`;
}

async function openaiProbe(): Promise<{ html: string; cls: Grade }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key)
    return {
      html: `<span class="muted">no OPENAI_API_KEY in console env — config only</span>`,
      cls: "ok",
    };
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(6000),
  });
  if (res.status === 401) return { html: `<span class="bad">API key rejected</span>`, cls: "bad" };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { data?: unknown[] };
  return {
    html: `<span class="ok">API key live</span> <span class="muted">· ${data.data?.length ?? 0} models visible</span>${await openaiSpend()}`,
    cls: "ok",
  };
}

async function vercelProbe(): Promise<{ html: string; cls: Grade }> {
  const token = process.env.VERCEL_API_TOKEN;
  if (!token)
    return {
      html: `<span class="muted">no VERCEL_API_TOKEN in console env — config only</span>`,
      cls: "ok",
    };
  const res = await fetch("https://api.vercel.com/v2/user", {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(6000),
  });
  if (res.status === 403 || res.status === 401)
    return { html: `<span class="bad">token rejected</span>`, cls: "bad" };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { user?: { username?: string; email?: string } };
  return {
    html: `<span class="ok">token live</span> <span class="muted">· ${esc(data.user?.username ?? data.user?.email ?? "?")}</span>`,
    cls: "ok",
  };
}

// ── cards ────────────────────────────────────────────────────────────────

const probeCache = new Map<string, { at: number; value: { html: string; cls: Grade } }>();

async function runProbe(
  svc: ServiceEntry,
  issuer: string,
): Promise<{ html: string; cls: Grade } | null> {
  if (!svc.probe) return null;
  const hit = probeCache.get(svc.name);
  // Failures retry fast — a probe that failed once at container start
  // (e.g. IMDS before a fresh identity propagates) must not pin the card
  // to "unavailable" for the full success TTL.
  if (hit && Date.now() - hit.at < (hit.value.cls === "ok" ? 300_000 : 30_000)) return hit.value;
  const run = async (): Promise<{ html: string; cls: Grade }> => {
    switch (svc.probe) {
      case "azure":
        if (!svc.subscription) throw new Error("azure probe needs `subscription` in config");
        return azureProbe(svc.subscription);
      case "oidc":
        return oidcProbe(issuer);
      case "openai":
        return openaiProbe();
      case "vercel":
        return vercelProbe();
      default:
        throw new Error(`unknown probe "${svc.probe}"`);
    }
  };
  const value = await run().catch((e): { html: string; cls: Grade } => ({
    html: `<span class="warn">probe failed: ${esc(e instanceof Error ? e.message : String(e)).slice(0, 120)}</span>`,
    cls: "warn",
  }));
  probeCache.set(svc.name, { at: Date.now(), value });
  return value;
}

export async function serviceCards(
  services: ServiceEntry[],
  issuer: string,
  now = new Date(),
): Promise<string> {
  const cards = await Promise.all(
    services.map(async (svc) => {
      const probe = await runProbe(svc, issuer);
      const tokens = svc.tokens?.length ? tokenRows(svc.tokens, now) : null;
      const head = svc.console
        ? `<h3>${esc(svc.name)} <a href="${esc(svc.console)}" rel="noreferrer" class="muted" style="float:right;font-size:.8rem">open console ↗</a></h3>`
        : `<h3>${esc(svc.name)}</h3>`;
      return `<div class="card">${head}
        ${svc.account ? `<p><span class="muted">account:</span> ${esc(svc.account)}</p>` : ""}
        ${probe ? `<div>${probe.html}</div>` : ""}
        ${tokens ? `<p class="sect"><strong>credentials</strong></p><ul class="plain">${tokens.html}</ul>` : ""}
        ${svc.note ? `<p class="muted">${esc(svc.note)}</p>` : ""}</div>`;
    }),
  );
  return cards.join("");
}
