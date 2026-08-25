/**
 * Generates examples/vault-example/ — the synthetic vault (§8.5): ~80 nodes
 * around a fictional persona ("Casey Rivera"), no personal data, safe to
 * publish. Output is committed; rerun after editing the data below:
 *
 *   bun scripts/gen-example-vault.ts
 *
 * Deliberate test structures the eval set leans on:
 *   - a 3-link supersedes chain (jquery → react → htmx)
 *   - two contradicts pairs (local-first vs server-authoritative,
 *     vert-first vs flat-base-first)
 *   - cross-cluster mentioned_with edges (weak ties, pruned first)
 *   - alias-only hits ("boris"), and a deliberately unanswerable query
 *
 * Every node is validated against @brain/contracts before rendering, so the
 * example vault can never drift from the schema.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderNote } from "@brain/brainstore";
import {
  EDGE_RELATIONS,
  type NodeFrontmatter,
  validateNodeFrontmatter,
} from "@brain/contracts";

const OUT = join(import.meta.dir, "..", "examples", "vault-example");

type NodeSpec = NodeFrontmatter & { body: string };

const link = (id: string) => `[[${id}]]`;

// ── Episodes (six, spread over ten months for recency variance) ────────────

interface EpisodeSpec {
  basename: string; // YYYY-MM-DD-slug — globally unique, links resolve to it
  episode_id: string;
  started_at: string;
  ended_at: string;
  surface: string;
  harness: string;
  trust: string;
  labels: string[];
  transcript: string;
}

const EPISODES: EpisodeSpec[] = [
  {
    basename: "2026-03-14-disk-failure-postmortem",
    episode_id: "ep_01HRXDISKFA1LURE0000000001",
    started_at: "2026-03-14T19:02:00Z",
    ended_at: "2026-03-14T19:40:00Z",
    surface: "cli",
    harness: "claude-code",
    trust: "high",
    labels: ["home-lab"],
    transcript: `**user** — The single ext4 disk in the mini PC just died and took the media library metadata with it. I want to never be in this position again.

**assistant** — Two independent changes: local redundancy (a ZFS mirror across two disks) and an offsite copy (restic snapshots to Backblaze B2). The mirror handles disk death; restic handles fat-fingered deletes and house-level risk.

**user** — Agreed on both. Order the second disk, and let's do nightly restic with a 90-day retention.`,
  },
  {
    basename: "2026-05-20-ankle-sprain-reassessment",
    episode_id: "ep_01HZANKLESPRA1N0000000002",
    started_at: "2026-05-20T14:00:00Z",
    ended_at: "2026-05-20T14:25:00Z",
    surface: "discord",
    harness: "agent-runtime",
    trust: "medium",
    labels: ["trail-running"],
    transcript: `**user** — Rolled the ankle on the talus field descent yesterday. Grade one, probably two weeks easy.

**assistant** — Noted. Do you want a structural limit while it heals?

**user** — Yes — cap weekly joint load. Marta suggested keeping hard descents under thirty minutes a week until it stops complaining.`,
  },
  {
    basename: "2026-06-02-garden-tracker-frontend-rewrite",
    episode_id: "ep_01J0FRONTENDREWR1TE000003",
    started_at: "2026-06-02T21:10:00Z",
    ended_at: "2026-06-02T22:05:00Z",
    surface: "cli",
    harness: "claude-code",
    trust: "high",
    labels: ["garden-tracker"],
    transcript: `**user** — The React SPA is 40k of node_modules to show four tables. I'm done. What's the boring option?

**assistant** — Server-rendered templates with htmx for the interactive bits. You keep one deploy artifact, forms work without JS, and the watering dashboard stays a partial swap.

**user** — Do it. This is the second frontend rewrite — jquery to React was the first — so let's make it the last.`,
  },
  {
    basename: "2026-07-18-training-block-planning",
    episode_id: "ep_01J2TRA1N1NGBLOCK00000004",
    started_at: "2026-07-18T12:00:00Z",
    ended_at: "2026-07-18T12:38:00Z",
    surface: "discord",
    harness: "agent-runtime",
    trust: "medium",
    labels: ["trail-running"],
    transcript: `**user** — Twelve weeks to the ridge traverse. Marta wants vert-first: climbing volume before flat mileage. Sam swears by the opposite — big flat base first, hills late.

**assistant** — Those are genuinely incompatible orderings for the same block. Recording both positions; you'll need to pick one to structure weeks 1–6.

**user** — Also switch me fully to heart-rate zones. Pace targets are meaningless on 20% grades.`,
  },
  {
    basename: "2026-08-09-bake-schedule-experiment",
    episode_id: "ep_01J3BAKESCHEDULE00000005",
    started_at: "2026-08-09T16:00:00Z",
    ended_at: "2026-08-09T16:20:00Z",
    surface: "cli",
    harness: "claude-code",
    trust: "high",
    labels: ["sourdough"],
    transcript: `**user** — Same-day bakes keep losing to my calendar — shaping at 11pm again. Moving to overnight fridge retard: mix and shape in the evening, bake before work.

**assistant** — Logged. The cold proof also buys flavor and an easier score. Boris gets fed the night before instead of at dawn.`,
  },
  {
    basename: "2026-08-21-home-lab-review",
    episode_id: "ep_01J4HOMELABREV1EW0000006",
    started_at: "2026-08-21T18:30:00Z",
    ended_at: "2026-08-21T19:15:00Z",
    surface: "cli",
    harness: "claude-code",
    trust: "high",
    labels: ["home-lab", "garden-tracker"],
    transcript: `**user** — Quarterly review. Caddy has renewed certificates untouched for six months; keep. Uptime Kuma caught the compose typo before I did; keep.

**assistant** — Garden tracker is still deployed on the lab box via the shared compose stack — fits the self-hosting preference and costs nothing.

**user** — Keep all of it. The boring stack keeps winning.`,
  },
];

// ── Nodes ──────────────────────────────────────────────────────────────────

const NODES: NodeSpec[] = [
  // ---- cross-cutting (7) ----
  {
    id: "me",
    type: "person",
    title: "Casey Rivera (owner)",
    aliases: ["owner", "casey"],
    tags: ["identity"],
    created: "2025-11-02",
    updated: "2026-08-21",
    status: "active",
    confidence: "high",
    summary:
      "The vault's single principal. Software developer, self-hosts everything feasible, trains for mountain ultras, bakes on weekends. Prefers boring, inspectable technology over novel dependencies.",
    body: "Seed node from `brain init`. Most preference nodes attribute to this node via `authored_by`.",
  },
  {
    id: "prefers-boring-tech",
    type: "preference",
    title: "Prefer boring, proven technology",
    aliases: ["boring tech", "choose boring technology"],
    tags: ["engineering", "philosophy"],
    created: "2025-11-02",
    updated: "2026-06-02",
    status: "active",
    confidence: "high",
    authored_by: [link("me")],
    summary:
      "Given two options, take the one with fewer moving parts and a decade of operational history: SQLite over Postgres containers, server-rendered HTML over SPAs, cron over orchestrators. Novelty budget is spent only where it pays rent.",
    body: "Repeatedly reinforced: the garden tracker frontend rewrite, the database choice, and the home-lab stack all cite this.",
  },
  {
    id: "self-hosting-preference",
    type: "preference",
    title: "Self-host anything that touches personal data",
    aliases: ["self hosting"],
    tags: ["privacy", "infra"],
    created: "2025-11-02",
    updated: "2026-08-21",
    status: "active",
    authored_by: [link("me")],
    about: [link("home-lab")],
    summary:
      "Personal data lives on hardware Casey controls. Third-party SaaS is acceptable only for encrypted blobs (offsite backups) or public data. Motivates the home-lab project and the garden tracker deploying locally.",
    body: "",
  },
  {
    id: "privacy-first-preference",
    type: "preference",
    title: "Default to the private option",
    tags: ["privacy"],
    created: "2025-11-02",
    updated: "2026-01-10",
    status: "active",
    authored_by: [link("me")],
    summary:
      "Telemetry off, public exposure minimized, data egress explicit. When a service wants an open port, the first question is whether it can ride the mesh VPN instead.",
    body: "",
  },
  {
    id: "least-privilege",
    type: "concept",
    title: "Least privilege",
    tags: ["security"],
    created: "2025-12-01",
    updated: "2025-12-01",
    status: "active",
    summary:
      "Every component gets the minimum access it needs and nothing more. In the home lab this shows up as per-service API tokens, read-only mounts, and the guest network for IoT devices.",
    body: "",
  },
  {
    id: "morning-focus-blocks",
    type: "preference",
    title: "Deep work happens before noon",
    aliases: ["morning person"],
    tags: ["schedule"],
    created: "2026-01-05",
    updated: "2026-01-05",
    status: "active",
    authored_by: [link("me")],
    summary:
      "Mornings are for focused work and training; meetings, admin, and baking chores go after lunch. Anything that wants a recurring morning slot competes with runs.",
    body: "",
  },
  {
    id: "budget-conscious-hosting",
    type: "constraint",
    title: "Hosting spend stays under 15 a month",
    tags: ["money", "infra"],
    created: "2025-12-15",
    updated: "2026-03-14",
    status: "active",
    about: [link("home-lab")],
    summary:
      "All recurring infrastructure cost — offsite storage, domains, the odd VPS — stays under fifteen dollars a month. Pushes toward owned hardware with high upfront cost and near-zero marginal cost.",
    body: "",
  },

  // ---- home-lab (21) ----
  {
    id: "home-lab",
    type: "project",
    title: "Home lab on the mini PC",
    aliases: ["homelab", "the lab", "lab box"],
    tags: ["infra", "self-hosting"],
    created: "2025-11-20",
    updated: "2026-08-21",
    status: "active",
    confidence: "high",
    sources: [link("2026-08-21-home-lab-review")],
    summary:
      "A fanless mini PC running a Docker Compose stack: reverse proxy, home automation, monitoring, media, and the garden tracker. Design goals: no open inbound ports, everything reproducible from one git repo, total cost of ownership near zero.",
    body: "The organizing project for all infrastructure decisions. Quarterly reviews happen in August, November, February, May.",
  },
  {
    id: "beelink-mini-pc",
    type: "entity",
    title: "Beelink SER5 mini PC",
    aliases: ["mini pc", "lab hardware"],
    tags: ["hardware"],
    created: "2025-11-20",
    updated: "2026-03-14",
    status: "active",
    part_of: [link("home-lab")],
    summary:
      "Ryzen 5 mini PC, 32 GB RAM, two NVMe slots, passively cooled in an Akasa case. Hosts the entire compose stack. Thermal ceiling is the binding constraint on what it can run.",
    body: "",
  },
  {
    id: "unifi-gateway-router",
    type: "entity",
    title: "UniFi gateway and switch",
    tags: ["hardware", "network"],
    created: "2025-11-20",
    updated: "2025-11-20",
    status: "active",
    part_of: [link("home-lab")],
    summary:
      "Handles routing, VLANs, and the IoT guest network. IoT devices are isolated from the lab VLAN per least-privilege; only the home automation bridge crosses, one port, one direction.",
    body: "",
  },
  {
    id: "fanless-case-thermal-limit",
    type: "constraint",
    title: "Fanless case caps sustained CPU load",
    tags: ["hardware"],
    created: "2025-12-05",
    updated: "2025-12-05",
    status: "active",
    about: [link("beelink-mini-pc")],
    summary:
      "The passive case throttles above roughly 70% sustained CPU. Batch jobs are staggered at night and transcoding is capped to one stream. Any new service must state its steady-state CPU cost.",
    body: "",
  },
  {
    id: "single-public-ip",
    type: "constraint",
    title: "One dynamic residential IP, CGNAT-adjacent",
    tags: ["network"],
    created: "2025-11-25",
    updated: "2025-11-25",
    status: "active",
    about: [link("home-lab")],
    summary:
      "The ISP hands out one dynamic IPv4 that changes monthly and sits behind carrier-grade NAT half the time. Inbound port forwarding is unreliable, which pushed all remote access onto an outbound mesh VPN.",
    body: "",
  },
  {
    id: "no-open-inbound-ports",
    type: "constraint",
    title: "No open inbound ports, ever",
    tags: ["security", "network"],
    created: "2025-11-25",
    updated: "2026-02-01",
    status: "active",
    about: [link("home-lab")],
    caused_by: [link("privacy-first-preference")],
    summary:
      "A security stance, distinct from the ISP reality: even if port forwarding worked, nothing listens publicly. Every service is reached over the mesh VPN or not at all. Removes the entire inbound attack surface.",
    body: "",
  },
  {
    id: "wireguard-mesh-access",
    type: "decision",
    title: "Remote access via WireGuard mesh",
    aliases: ["mesh vpn", "wireguard"],
    tags: ["network", "security"],
    created: "2026-02-01",
    updated: "2026-02-01",
    status: "active",
    confidence: "high",
    about: [link("home-lab")],
    caused_by: [link("single-public-ip"), link("no-open-inbound-ports")],
    summary:
      "Phones and laptops join a WireGuard mesh; every lab service is reachable only over mesh addresses. No dynamic DNS, no port forwards, no TLS-on-the-WAN. Survives the ISP address rotation transparently.",
    body: "",
  },
  {
    id: "caddy-reverse-proxy",
    type: "decision",
    title: "Caddy terminates TLS for all lab services",
    aliases: ["caddy", "reverse proxy choice"],
    tags: ["infra"],
    created: "2026-01-15",
    updated: "2026-08-21",
    status: "active",
    confidence: "high",
    about: [link("home-lab")],
    supersedes: [link("nginx-reverse-proxy")],
    caused_by: [link("automatic-https-requirement"), link("prefers-boring-tech")],
    depends_on: [link("docker-compose-stacks")],
    sources: [link("2026-08-21-home-lab-review")],
    summary:
      "Caddy fronts every lab service with automatic internal-CA certificates and a 20-line config, replacing nginx and its hand-managed cert renewal scripts. Six months in it has needed zero touches.",
    body: "The nginx setup wasn't broken, but cert renewal was a cron job with a failure mode discovered only when browsers complained.",
  },
  {
    id: "nginx-reverse-proxy",
    type: "decision",
    title: "nginx as the lab reverse proxy",
    tags: ["infra"],
    created: "2025-11-22",
    updated: "2026-01-15",
    status: "superseded",
    about: [link("home-lab")],
    summary:
      "The original proxy: nginx with manually templated vhosts and a certbot renewal cron. Worked, but every new service meant editing config in two places. Replaced by Caddy in January 2026.",
    body: "",
  },
  {
    id: "automatic-https-requirement",
    type: "constraint",
    title: "Certificates must renew without human attention",
    tags: ["infra", "security"],
    created: "2026-01-10",
    updated: "2026-01-10",
    status: "active",
    about: [link("home-lab")],
    summary:
      "Any TLS in the lab must be provisioned and renewed with zero manual steps — a renewal that needs remembering is a renewal that fails on vacation. Directly caused the move to Caddy's internal CA.",
    body: "",
  },
  {
    id: "zfs-mirror-pool",
    type: "decision",
    title: "Storage is a two-disk ZFS mirror",
    aliases: ["zfs mirror", "storage redundancy"],
    tags: ["infra", "storage"],
    created: "2026-03-14",
    updated: "2026-03-14",
    status: "active",
    confidence: "high",
    about: [link("home-lab")],
    supersedes: [link("single-disk-ext4")],
    caused_by: [link("disk-failure-march-2026")],
    sources: [link("2026-03-14-disk-failure-postmortem")],
    summary:
      "Both NVMe slots populated, mirrored with ZFS: any single disk can die without data loss, scrubs catch bit rot, and snapshots make restic's job atomic. Bought with the March disk failure fresh.",
    body: "",
  },
  {
    id: "single-disk-ext4",
    type: "decision",
    title: "Single ext4 disk for lab storage",
    tags: ["infra", "storage"],
    created: "2025-11-20",
    updated: "2026-03-14",
    status: "superseded",
    about: [link("home-lab")],
    summary:
      "The launch configuration: one NVMe, ext4, no redundancy. Died in March 2026 taking the media metadata with it. Superseded by the ZFS mirror the same week.",
    body: "",
  },
  {
    id: "disk-failure-march-2026",
    type: "event",
    title: "Primary lab disk failed, March 2026",
    aliases: ["the disk failure"],
    tags: ["incident", "storage"],
    created: "2026-03-14",
    updated: "2026-03-14",
    status: "active",
    about: [link("home-lab")],
    sources: [link("2026-03-14-disk-failure-postmortem")],
    mentioned_with: [link("restic-offsite-backups")],
    summary:
      "The original NVMe died without SMART warning. Compose stack was reproducible from git, but media metadata and two weeks of sensor history were lost. Direct cause of the ZFS mirror and the offsite backup routine.",
    body: "",
  },
  {
    id: "restic-offsite-backups",
    type: "decision",
    title: "Nightly restic snapshots to offsite storage",
    aliases: ["offsite backups", "restic"],
    tags: ["infra", "storage", "backup"],
    created: "2026-03-14",
    updated: "2026-03-14",
    status: "active",
    confidence: "high",
    about: [link("home-lab")],
    caused_by: [link("disk-failure-march-2026")],
    depends_on: [link("backblaze-b2")],
    sources: [link("2026-03-14-disk-failure-postmortem")],
    summary:
      "Encrypted restic snapshots run nightly to Backblaze B2 with 90-day retention and a monthly restore drill. Covers what the mirror cannot: deletion mistakes, ransomware, and the house itself.",
    body: "",
  },
  {
    id: "backblaze-b2",
    type: "entity",
    title: "Backblaze B2 bucket for backups",
    tags: ["service", "backup"],
    created: "2026-03-14",
    updated: "2026-03-14",
    status: "active",
    summary:
      "The one third-party service holding lab data — acceptable under the self-hosting rule because everything in it is client-side encrypted. Costs about a dollar a month at current volume.",
    body: "",
  },
  {
    id: "docker-compose-stacks",
    type: "concept",
    title: "Everything runs as Docker Compose stacks",
    aliases: ["compose stack"],
    tags: ["infra"],
    created: "2025-11-20",
    updated: "2026-08-21",
    status: "active",
    about: [link("home-lab")],
    example_of: [link("infrastructure-as-code")],
    summary:
      "One compose file per service group, all in a single git repo. Rebuild-from-scratch is `git clone` plus `docker compose up`. No service is installed on the host directly, which is what made the disk failure survivable.",
    body: "",
  },
  {
    id: "infrastructure-as-code",
    type: "concept",
    title: "Infrastructure as code",
    aliases: ["iac"],
    tags: ["infra", "philosophy"],
    created: "2025-11-20",
    updated: "2025-11-20",
    status: "active",
    summary:
      "State that matters lives in version control; hosts are cattle. In the lab this is compose files plus a bootstrap script — deliberately not Kubernetes or Terraform, per the boring-tech preference.",
    body: "",
  },
  {
    id: "uptime-kuma-monitoring",
    type: "decision",
    title: "Uptime Kuma for service monitoring",
    aliases: ["uptime kuma", "monitoring"],
    tags: ["infra", "monitoring"],
    created: "2026-04-02",
    updated: "2026-08-21",
    status: "active",
    about: [link("home-lab")],
    sources: [link("2026-08-21-home-lab-review")],
    summary:
      "Self-hosted Uptime Kuma pings every service over the mesh and alerts to the phone. Caught a compose typo within minutes during the August review period. Chosen over hosted monitors to keep probes inside the network.",
    body: "",
  },
  {
    id: "home-assistant-instance",
    type: "entity",
    title: "Home Assistant instance",
    aliases: ["home assistant", "hass"],
    tags: ["home-automation"],
    created: "2025-12-10",
    updated: "2026-07-30",
    status: "active",
    part_of: [link("home-lab")],
    mentioned_with: [link("zigbee-sensors")],
    summary:
      "Runs automations and logs every sensor in the house, including the kitchen temperature sensors the sourdough schedule leans on. Bridges the isolated IoT VLAN through a single allowed port.",
    body: "",
  },
  {
    id: "zigbee-sensors",
    type: "entity",
    title: "Zigbee temperature and door sensors",
    aliases: ["zigbee"],
    tags: ["home-automation", "hardware"],
    created: "2025-12-10",
    updated: "2026-02-20",
    status: "active",
    part_of: [link("home-lab")],
    summary:
      "A mesh of battery Zigbee sensors: temperature and humidity in the kitchen and office, door contacts on the entry doors. The kitchen units double as fermentation instrumentation on bake days.",
    body: "",
  },
  {
    id: "compose-stacks-repo",
    type: "artifact",
    title: "Git repo of all compose stacks",
    aliases: ["lab repo"],
    tags: ["infra", "artifact"],
    created: "2025-11-20",
    updated: "2026-08-21",
    status: "active",
    about: [link("home-lab")],
    example_of: [link("infrastructure-as-code")],
    summary:
      "The single source of truth for the lab: compose files, Caddyfile, bootstrap script, and a README with the restore runbook. Cloning this repo onto fresh hardware rebuilds the lab in under an hour.",
    body: "",
  },

  // ---- garden-tracker (20) ----
  {
    id: "garden-tracker",
    type: "project",
    title: "Garden tracker web app",
    aliases: ["garden app", "the tracker"],
    tags: ["software", "garden"],
    created: "2025-12-01",
    updated: "2026-08-21",
    status: "active",
    confidence: "high",
    summary:
      "A small self-hosted web app tracking beds, plantings, watering, and harvests for the backyard garden. One user plus one beta tester. Deliberately boring stack: server-rendered pages, htmx, SQLite, deployed on the home lab.",
    body: "",
  },
  {
    id: "htmx-server-rendered-ui",
    type: "decision",
    title: "Frontend is server-rendered HTML with htmx",
    aliases: ["htmx frontend", "frontend choice"],
    tags: ["software", "frontend"],
    created: "2026-06-02",
    updated: "2026-06-02",
    status: "active",
    confidence: "high",
    about: [link("garden-tracker")],
    supersedes: [link("react-spa-frontend")],
    caused_by: [link("prefers-boring-tech")],
    example_of: [link("progressive-enhancement")],
    sources: [link("2026-06-02-garden-tracker-frontend-rewrite")],
    summary:
      "Templates render on the server; htmx swaps partials for the interactive dashboard bits. One deploy artifact, forms that work without JavaScript, and roughly a tenth of the previous bundle surface. The third and intended-final frontend.",
    body: "Second rewrite: jquery prototype → React SPA → this. The lesson recorded: interactivity needs were overestimated from the start.",
  },
  {
    id: "react-spa-frontend",
    type: "decision",
    title: "React single-page app frontend",
    tags: ["software", "frontend"],
    created: "2026-02-10",
    updated: "2026-06-02",
    status: "superseded",
    about: [link("garden-tracker")],
    supersedes: [link("jquery-prototype-ui")],
    summary:
      "The middle frontend: a React SPA with a JSON API. Brought a build pipeline, node_modules churn, and hydration bugs to an app with four tables. Superseded by the htmx rewrite in June 2026.",
    body: "",
  },
  {
    id: "jquery-prototype-ui",
    type: "decision",
    title: "jQuery prototype UI",
    tags: ["software", "frontend"],
    created: "2025-12-05",
    updated: "2026-02-10",
    status: "superseded",
    about: [link("garden-tracker")],
    summary:
      "The original weekend prototype: server pages with jQuery sprinkles. Replaced by the React SPA when the dashboard felt clunky — a rewrite later judged unnecessary. Start of the frontend supersedes chain.",
    body: "",
  },
  {
    id: "sqlite-single-file-db",
    type: "decision",
    title: "SQLite as the only database",
    aliases: ["sqlite choice", "database choice"],
    tags: ["software", "storage"],
    created: "2025-12-05",
    updated: "2026-04-15",
    status: "active",
    confidence: "high",
    about: [link("garden-tracker")],
    supersedes: [link("postgres-container-db")],
    caused_by: [link("prefers-boring-tech")],
    summary:
      "One SQLite file, WAL mode, backed up by the lab's restic run like any other file. Replaced the Postgres container after realizing the app has one writer and reads measured per minute, not per second.",
    body: "",
  },
  {
    id: "postgres-container-db",
    type: "decision",
    title: "Postgres in a container for the tracker",
    tags: ["software", "storage"],
    created: "2026-02-10",
    updated: "2026-04-15",
    status: "superseded",
    about: [link("garden-tracker")],
    summary:
      "Postgres arrived with the React rewrite because 'real apps use Postgres'. Added a container, credentials, and backup complexity for a single-user workload. Superseded by SQLite in April 2026.",
    body: "",
  },
  {
    id: "progressive-enhancement",
    type: "concept",
    title: "Progressive enhancement",
    tags: ["software", "frontend"],
    created: "2026-06-02",
    updated: "2026-06-02",
    status: "active",
    summary:
      "Pages work as plain HTML first; JavaScript upgrades the experience rather than gatekeeping it. The htmx frontend is the working example: every form submits fine with scripts disabled.",
    body: "",
  },
  {
    id: "server-side-rendering",
    type: "concept",
    title: "Server-side rendering",
    aliases: ["ssr"],
    tags: ["software", "frontend"],
    created: "2026-06-02",
    updated: "2026-06-02",
    status: "active",
    about: [link("garden-tracker")],
    summary:
      "HTML is produced on the server per request. In the tracker this pairs with htmx partial swaps, keeping state authoritative in one place and the client thin.",
    body: "",
  },
  {
    id: "server-authoritative-state",
    type: "decision",
    title: "The server is the single source of truth",
    tags: ["software", "architecture"],
    created: "2026-06-02",
    updated: "2026-06-02",
    status: "active",
    about: [link("garden-tracker")],
    contradicts: [link("local-first-sync")],
    summary:
      "All state lives in the server's SQLite; clients hold no durable data. Simple, consistent, and honest about the app being unusable offline. Standing tension with the local-first idea for garden visits beyond cell coverage.",
    body: "",
  },
  {
    id: "local-first-sync",
    type: "concept",
    title: "Local-first data with background sync",
    aliases: ["local first", "offline first"],
    tags: ["software", "architecture"],
    created: "2026-06-20",
    updated: "2026-06-20",
    status: "active",
    about: [link("garden-tracker")],
    contradicts: [link("server-authoritative-state")],
    summary:
      "The appealing alternative: the phone keeps a replica so watering can be logged from the far beds with no signal, syncing later. Directly contradicts the server-authoritative decision — unresolved, revisit if offline logging keeps hurting.",
    body: "",
  },
  {
    id: "plant-watering-model",
    type: "concept",
    title: "Watering model from moisture and weather",
    aliases: ["watering model"],
    tags: ["garden", "software"],
    created: "2026-03-01",
    updated: "2026-07-10",
    status: "active",
    about: [link("garden-tracker")],
    summary:
      "Each bed gets a watering recommendation from soil moisture readings, recent rainfall, and the forecast: skip, light, or deep. Tuned all season; over-watering dropped visibly after the June calibration.",
    body: "",
  },
  {
    id: "soil-moisture-sensors",
    type: "entity",
    title: "Capacitive soil moisture sensors",
    aliases: ["moisture sensors"],
    tags: ["garden", "hardware"],
    created: "2026-03-01",
    updated: "2026-03-01",
    status: "active",
    about: [link("garden-tracker")],
    mentioned_with: [link("zigbee-sensors")],
    summary:
      "Six capacitive probes across the raised beds reporting every ten minutes over the same Zigbee mesh as the house sensors. Feed the watering model; drift is checked monthly against a manual meter.",
    body: "",
  },
  {
    id: "alex-chen-beta-tester",
    type: "person",
    title: "Alex Chen — beta tester",
    aliases: ["alex"],
    tags: ["people", "garden"],
    created: "2026-04-20",
    updated: "2026-07-25",
    status: "active",
    about: [link("garden-tracker")],
    summary:
      "Neighbor with a bigger garden and stronger opinions; the tracker's only other user. Source of the CSV export request and most bug reports. Prefers email over chat for anything longer than a sentence.",
    body: "",
  },
  {
    id: "csv-export-request",
    type: "event",
    title: "Alex requested CSV export of harvest data",
    aliases: ["csv export"],
    tags: ["garden", "feature"],
    created: "2026-07-25",
    updated: "2026-07-25",
    status: "active",
    about: [link("garden-tracker")],
    authored_by: [link("alex-chen-beta-tester")],
    summary:
      "Alex wants harvest logs as CSV to graph yields in a spreadsheet. Scoped as a single export endpoint reusing the report query. Parked behind the watering-model tuning; revisit in September.",
    body: "",
  },
  {
    id: "weather-api-integration",
    type: "decision",
    title: "Forecasts come from the national weather API",
    aliases: ["weather api"],
    tags: ["garden", "software"],
    created: "2026-03-05",
    updated: "2026-03-05",
    status: "active",
    about: [link("garden-tracker")],
    summary:
      "Rain and frost forecasts are pulled hourly from the free national weather service API and cached locally — no key, no quota drama, station data three miles away. The only external call the tracker makes.",
    body: "",
  },
  {
    id: "frost-date-alerts",
    type: "decision",
    title: "Push alerts before frost nights",
    aliases: ["frost alerts"],
    tags: ["garden"],
    created: "2026-03-10",
    updated: "2026-03-10",
    status: "active",
    about: [link("garden-tracker")],
    depends_on: [link("weather-api-integration")],
    summary:
      "When the overnight forecast crosses the frost threshold, the tracker pushes a cover-the-beds alert the afternoon before. Saved the tomato seedlings twice in April.",
    body: "",
  },
  {
    id: "tomato-blight-2026",
    type: "event",
    title: "Early blight hit the tomato bed, July 2026",
    aliases: ["the blight"],
    tags: ["garden", "incident"],
    created: "2026-07-10",
    updated: "2026-07-10",
    status: "active",
    about: [link("garden-tracker")],
    mentioned_with: [link("plant-watering-model")],
    summary:
      "Early blight took out half the tomato bed in a wet week. Post-mortem: overhead evening watering left leaves wet overnight. The watering model now prefers morning slots and drip lines for solanums.",
    body: "",
  },
  {
    id: "raised-bed-layout",
    type: "artifact",
    title: "Raised bed layout diagram",
    tags: ["garden", "artifact"],
    created: "2026-01-20",
    updated: "2026-05-01",
    status: "active",
    about: [link("garden-tracker")],
    summary:
      "SVG plan of the eight raised beds with sun exposure bands and the drip line runs, kept in the tracker repo and rendered on the app's home page. Updated each season after rotation planning.",
    body: "",
  },
  {
    id: "perennial-database-schema",
    type: "artifact",
    title: "Schema for beds, plantings, and harvests",
    aliases: ["tracker schema"],
    tags: ["garden", "software", "artifact"],
    created: "2025-12-05",
    updated: "2026-06-02",
    status: "active",
    about: [link("garden-tracker")],
    depends_on: [link("sqlite-single-file-db")],
    summary:
      "Five tables — beds, plantings, events, harvests, sensors — with plantings as the spine. Survived all three frontends unchanged, which is the quiet argument that the data model was the real design.",
    body: "",
  },
  {
    id: "deploy-on-home-lab",
    type: "decision",
    title: "The tracker deploys on the home lab",
    tags: ["garden", "infra"],
    created: "2026-01-05",
    updated: "2026-08-21",
    status: "active",
    about: [link("garden-tracker")],
    depends_on: [link("docker-compose-stacks")],
    caused_by: [link("self-hosting-preference"), link("budget-conscious-hosting")],
    sources: [link("2026-08-21-home-lab-review")],
    summary:
      "The tracker is one more compose stack on the lab box behind Caddy, reached over the mesh. Zero marginal hosting cost and the garden data stays home. Re-confirmed at the August review.",
    body: "",
  },

  // ---- trail running (19) ----
  {
    id: "trail-running",
    type: "project",
    title: "Trail running and the 2026 ultra build",
    aliases: ["running", "ultra training"],
    tags: ["training"],
    created: "2026-01-08",
    updated: "2026-07-18",
    status: "active",
    summary:
      "The year's athletic focus: build from spring base to the Ridge Traverse 50k in October. Coached by Marta, long runs with Sam, structured around heart-rate zones after the July switch.",
    body: "",
  },
  {
    id: "ridge-traverse-ultra-2026",
    type: "event",
    title: "Ridge Traverse 50k — October 2026",
    aliases: ["the ultra", "ridge traverse"],
    tags: ["training", "race"],
    created: "2026-01-08",
    updated: "2026-07-18",
    status: "active",
    about: [link("trail-running")],
    summary:
      "The A race: a 50k with about 2800m of climbing, technical talus above the treeline, October 10th. Everything in the training block backs out from this date.",
    body: "",
  },
  {
    id: "heart-rate-zone-training",
    type: "decision",
    title: "Training intensity is prescribed by heart-rate zones",
    aliases: ["hr zones", "zone training"],
    tags: ["training"],
    created: "2026-07-18",
    updated: "2026-07-18",
    status: "active",
    confidence: "high",
    about: [link("trail-running")],
    supersedes: [link("pace-based-training")],
    caused_by: [link("aerobic-base-deficit")],
    sources: [link("2026-07-18-training-block-planning")],
    summary:
      "All sessions are prescribed and reviewed by heart-rate zone rather than pace — pace is meaningless on 20% grades and technical descents. Zone 2 discipline is the core of the aerobic rebuild.",
    body: "",
  },
  {
    id: "pace-based-training",
    type: "decision",
    title: "Pace-based training targets",
    tags: ["training"],
    created: "2026-01-08",
    updated: "2026-07-18",
    status: "superseded",
    about: [link("trail-running")],
    summary:
      "The road-running habit carried onto trails: min/km targets per session. Fell apart on real terrain — every climb read as failure, every descent as sandbagging. Superseded by heart-rate zones in July.",
    body: "",
  },
  {
    id: "zone-two-discipline",
    type: "concept",
    title: "Zone 2 discipline",
    aliases: ["zone 2"],
    tags: ["training"],
    created: "2026-07-18",
    updated: "2026-07-18",
    status: "active",
    part_of: [link("heart-rate-zone-training")],
    summary:
      "Most weekly volume stays genuinely easy — conversational, nasal-breathing easy — so hard days can be actually hard. The watch alerts on zone ceiling breaches during base runs.",
    body: "",
  },
  {
    id: "aerobic-base-deficit",
    type: "concept",
    title: "The aerobic base is the limiter",
    tags: ["training"],
    created: "2026-07-01",
    updated: "2026-07-18",
    status: "active",
    about: [link("trail-running")],
    summary:
      "Years of medium-hard running built speed but a shallow aerobic base: heart rate drifts badly after 90 minutes. Named by Marta from the June test week; the reason the block is zone-2 heavy.",
    body: "",
  },
  {
    id: "coach-marta",
    type: "person",
    title: "Marta — running coach",
    aliases: ["marta"],
    tags: ["people", "training"],
    created: "2026-06-15",
    updated: "2026-07-18",
    status: "active",
    about: [link("trail-running")],
    summary:
      "Remote coach since June; plans arrive Sundays, reviewed against watch data Thursdays. Diagnosed the aerobic deficit, prescribed the zone switch, and argues for vert-first block structure.",
    body: "",
  },
  {
    id: "sam-training-partner",
    type: "person",
    title: "Sam — Saturday training partner",
    aliases: ["sam"],
    tags: ["people", "training"],
    created: "2026-02-01",
    updated: "2026-07-18",
    status: "active",
    about: [link("trail-running")],
    mentioned_with: [link("saturday-long-runs")],
    summary:
      "Long-run partner most Saturdays and veteran of five ultras. Skeptical of coaches generally and of vert-first specifically — swears by a big flat base. Good company above the treeline.",
    body: "",
  },
  {
    id: "saturday-long-runs",
    type: "preference",
    title: "Long runs happen Saturday mornings",
    tags: ["training", "schedule"],
    created: "2026-02-01",
    updated: "2026-02-01",
    status: "active",
    authored_by: [link("me")],
    about: [link("trail-running")],
    summary:
      "The long run owns Saturday morning, leaving Sunday for family and recovery. Protected slot: garden chores and bakes schedule around it, not over it.",
    body: "",
  },
  {
    id: "morning-runs-only",
    type: "preference",
    title: "Runs happen before work, full stop",
    tags: ["training", "schedule"],
    created: "2026-01-08",
    updated: "2026-01-08",
    status: "active",
    authored_by: [link("me")],
    summary:
      "Evening runs get eaten by the day; morning runs happen. All weekday training is scheduled before 8am, which also keeps it inside the morning-focus rhythm.",
    body: "",
  },
  {
    id: "low-drop-trail-shoes",
    type: "preference",
    title: "Low-drop, wide-toebox trail shoes",
    aliases: ["shoe preference"],
    tags: ["training", "gear"],
    created: "2026-02-15",
    updated: "2026-05-20",
    status: "active",
    authored_by: [link("me")],
    about: [link("trail-running")],
    summary:
      "4–6mm drop, wide toebox, aggressive lugs; two pairs in rotation. The ankle sprain reinforced preferring ground feel over stack height on technical terrain.",
    body: "",
  },
  {
    id: "ankle-sprain-may-2026",
    type: "event",
    title: "Ankle sprain on the talus descent, May 2026",
    aliases: ["the sprain"],
    tags: ["training", "injury"],
    created: "2026-05-20",
    updated: "2026-05-20",
    status: "active",
    about: [link("trail-running")],
    mentioned_with: [link("talus-ridge-trail")],
    sources: [link("2026-05-20-ankle-sprain-reassessment")],
    summary:
      "Grade-one lateral sprain rolling the right ankle in the talus field. Two easy weeks, then a standing weekly cap on hard descent time. The proximate cause of the joint-load limit.",
    body: "",
  },
  {
    id: "joint-load-weekly-limit",
    type: "constraint",
    title: "Hard descent time capped per week",
    aliases: ["descent cap"],
    tags: ["training", "injury"],
    created: "2026-05-20",
    updated: "2026-05-20",
    status: "active",
    about: [link("trail-running")],
    caused_by: [link("ankle-sprain-may-2026")],
    sources: [link("2026-05-20-ankle-sprain-reassessment")],
    summary:
      "Until the ankle is fully quiet: at most thirty minutes of hard technical descending per week, counted from watch laps. Race-specific descent work waits for September.",
    body: "",
  },
  {
    id: "talus-ridge-trail",
    type: "entity",
    title: "Talus Ridge trail",
    aliases: ["the talus field"],
    tags: ["training", "place"],
    created: "2026-02-20",
    updated: "2026-05-20",
    status: "active",
    about: [link("trail-running")],
    summary:
      "The local technical benchmark: 900m of climbing to an exposed talus traverse that previews the race's crux. Site of the May sprain; treated with respect and fresh legs since.",
    body: "",
  },
  {
    id: "vert-before-volume",
    type: "decision",
    title: "Build climbing volume before flat mileage",
    aliases: ["vert first"],
    tags: ["training", "planning"],
    created: "2026-07-18",
    updated: "2026-07-18",
    status: "active",
    confidence: "medium",
    about: [link("trail-running")],
    contradicts: [link("flat-mileage-base-first")],
    sources: [link("2026-07-18-training-block-planning")],
    summary:
      "Marta's block structure: front-load climbing adaptation in weeks 1–6 while the ankle limits descents anyway, then convert to volume. Adopted for this block, but the opposing view is recorded and unresolved.",
    body: "",
  },
  {
    id: "flat-mileage-base-first",
    type: "decision",
    title: "Big flat aerobic base before hill work",
    aliases: ["base first"],
    tags: ["training", "planning"],
    created: "2026-07-18",
    updated: "2026-07-18",
    status: "active",
    confidence: "medium",
    about: [link("trail-running")],
    contradicts: [link("vert-before-volume")],
    sources: [link("2026-07-18-training-block-planning")],
    summary:
      "Sam's counter-position from five ultra builds: establish a large flat aerobic base first and add vert late, or the climbing work compounds fatigue on a weak foundation. Kept active as the standing counter-argument.",
    body: "",
  },
  {
    id: "garmin-forerunner-watch",
    type: "entity",
    title: "Garmin Forerunner watch",
    aliases: ["the watch"],
    tags: ["training", "gear"],
    created: "2026-01-08",
    updated: "2026-07-18",
    status: "active",
    about: [link("trail-running")],
    summary:
      "Records every session; zone alerts enforce the easy-day ceiling and descent laps feed the weekly joint-load count. Weekly export lands in the training spreadsheet Marta reviews.",
    body: "",
  },
  {
    id: "race-nutrition-plan",
    type: "artifact",
    title: "Ridge Traverse fueling plan",
    aliases: ["fueling plan"],
    tags: ["training", "race", "artifact"],
    created: "2026-07-25",
    updated: "2026-07-25",
    status: "active",
    about: [link("ridge-traverse-ultra-2026")],
    summary:
      "The race-day sheet: 70g carbs per hour from gels plus real food at the two crewed aid stations, 500ml fluids per hour scaled to temperature, caffeine from kilometer 35. Rehearsed on every long run until race day.",
    body: "",
  },
  {
    id: "gel-every-thirty-minutes",
    type: "decision",
    title: "One gel every thirty minutes while racing",
    tags: ["training", "race"],
    created: "2026-07-25",
    updated: "2026-07-25",
    status: "active",
    part_of: [link("race-nutrition-plan")],
    summary:
      "The metronome rule underneath the fueling plan: a gel on every half hour from the gun, watch-alarmed, non-negotiable regardless of appetite. Gut-trained on Saturday runs since late July.",
    body: "",
  },

  // ---- sourdough (14) ----
  {
    id: "sourdough-baking",
    type: "project",
    title: "Weekly sourdough practice",
    aliases: ["sourdough", "baking"],
    tags: ["baking"],
    created: "2025-11-10",
    updated: "2026-08-09",
    status: "active",
    summary:
      "A loaf most weeks from the rye starter, aiming for consistent open crumb at high hydration. Current method: overnight fridge retard, dutch-oven bake before work. The kitchen sensors log fermentation temperature.",
    body: "",
  },
  {
    id: "rye-starter-boris",
    type: "entity",
    title: "Boris, the rye starter",
    aliases: ["boris", "the starter"],
    tags: ["baking"],
    created: "2025-11-10",
    updated: "2026-08-09",
    status: "active",
    about: [link("sourdough-baking")],
    summary:
      "A 100% rye starter, alive since late 2025, kept at 100% hydration in the fridge between bakes. Fed the evening before a bake under the retard schedule; doubles in about five hours at room temperature.",
    body: "",
  },
  {
    id: "high-hydration-preference",
    type: "preference",
    title: "Bake at 78–82% hydration",
    aliases: ["high hydration"],
    tags: ["baking"],
    created: "2026-01-15",
    updated: "2026-01-15",
    status: "active",
    authored_by: [link("me")],
    about: [link("sourdough-baking")],
    summary:
      "The open-crumb range worth the sticky handling: 78–82% depending on flour. Below that the crumb tightens; above it the loaf spreads unless the shaping is perfect.",
    body: "",
  },
  {
    id: "fridge-retard-schedule",
    type: "decision",
    title: "Overnight fridge retard, morning bake",
    aliases: ["retard schedule", "overnight proof"],
    tags: ["baking", "schedule"],
    created: "2026-08-09",
    updated: "2026-08-09",
    status: "active",
    confidence: "high",
    about: [link("sourdough-baking")],
    supersedes: [link("same-day-bake-schedule")],
    caused_by: [link("weekday-time-constraint")],
    sources: [link("2026-08-09-bake-schedule-experiment")],
    summary:
      "Mix and bulk in the evening, shape, retard overnight in the fridge, bake before work. Decouples the bake from the calendar, improves flavor and scoring, and ends the 11pm shaping sessions.",
    body: "",
  },
  {
    id: "same-day-bake-schedule",
    type: "decision",
    title: "Same-day mix-to-bake schedule",
    tags: ["baking", "schedule"],
    created: "2025-11-10",
    updated: "2026-08-09",
    status: "superseded",
    about: [link("sourdough-baking")],
    summary:
      "The original rhythm: feed at dawn, mix midday, bake in the evening. Only works on empty weekend days and kept colliding with the calendar. Superseded by the overnight fridge retard in August 2026.",
    body: "",
  },
  {
    id: "weekday-time-constraint",
    type: "constraint",
    title: "Bakes must fit around work hours",
    tags: ["baking", "schedule"],
    created: "2026-08-09",
    updated: "2026-08-09",
    status: "active",
    summary:
      "No bake step may demand attention between 9am and 6pm on weekdays, and nothing food-related runs past 10pm. The forcing function behind the fridge-retard schedule.",
    body: "",
  },
  {
    id: "dutch-oven-steam-method",
    type: "decision",
    title: "Bake in a preheated dutch oven",
    aliases: ["dutch oven method"],
    tags: ["baking", "technique"],
    created: "2026-02-05",
    updated: "2026-02-05",
    status: "active",
    confidence: "high",
    about: [link("sourdough-baking")],
    supersedes: [link("oven-tray-steam-method")],
    summary:
      "The loaf bakes covered in a preheated cast-iron dutch oven for the first twenty minutes — the trapped steam does what the tray never reliably did. Oven spring became repeatable the first week.",
    body: "",
  },
  {
    id: "oven-tray-steam-method",
    type: "decision",
    title: "Steam from a water tray in the oven",
    tags: ["baking", "technique"],
    created: "2025-11-10",
    updated: "2026-02-05",
    status: "superseded",
    about: [link("sourdough-baking")],
    summary:
      "Ice cubes into a preheated tray under the stone. Leaky home ovens vent the steam in minutes; crust set too early and spring suffered. Superseded by the dutch oven in February 2026.",
    body: "",
  },
  {
    id: "autolyse-rest",
    type: "concept",
    title: "Autolyse before mixing",
    aliases: ["autolyse"],
    tags: ["baking", "technique"],
    created: "2026-01-20",
    updated: "2026-01-20",
    status: "active",
    about: [link("sourdough-baking")],
    summary:
      "Flour and water rest 45–60 minutes before salt and starter join: gluten develops on its own, mixing time drops, and extensibility at high hydration improves noticeably.",
    body: "",
  },
  {
    id: "fermentation-temperature-control",
    type: "concept",
    title: "Fermentation tracks temperature, not the clock",
    aliases: ["dough temperature"],
    tags: ["baking", "technique"],
    created: "2026-03-20",
    updated: "2026-08-09",
    status: "active",
    about: [link("sourdough-baking")],
    mentioned_with: [link("home-assistant-instance")],
    summary:
      "Bulk fermentation is judged by dough state at a known kitchen temperature — the Zigbee sensor logs it — not by elapsed time. A 21° kitchen and a 26° kitchen are different recipes wearing the same clock.",
    body: "",
  },
  {
    id: "thanksgiving-flat-loaf-2025",
    type: "event",
    title: "The flat Thanksgiving loaves, 2025",
    aliases: ["thanksgiving failure"],
    tags: ["baking", "incident"],
    created: "2025-11-28",
    updated: "2026-03-20",
    status: "active",
    about: [link("sourdough-baking")],
    mentioned_with: [link("fermentation-temperature-control")],
    summary:
      "Both holiday loaves came out flat: a cold house, a clock-based bulk, and dough that needed three more hours. The failure that led to judging fermentation by temperature and state instead of time.",
    body: "",
  },
  {
    id: "king-arthur-bread-flour",
    type: "entity",
    title: "King Arthur bread flour as the base",
    aliases: ["bread flour"],
    tags: ["baking", "ingredient"],
    created: "2026-01-15",
    updated: "2026-01-15",
    status: "active",
    about: [link("sourdough-baking")],
    summary:
      "The consistent base flour — strong enough for 80% hydration, available everywhere, boring on purpose. Specialty flours rotate through the 20% slot instead of replacing the base.",
    body: "",
  },
  {
    id: "crumb-photo-log",
    type: "artifact",
    title: "Crumb shot log with bake parameters",
    aliases: ["crumb log"],
    tags: ["baking", "artifact"],
    created: "2026-01-15",
    updated: "2026-08-09",
    status: "active",
    about: [link("sourdough-baking")],
    summary:
      "Every loaf gets a crumb photo tagged with hydration, bulk temperature, and schedule. The before/after around the dutch-oven switch and the retard schedule is visible in one scroll.",
    body: "",
  },
  {
    id: "weekly-bake-cadence",
    type: "preference",
    title: "One bake most weekends",
    tags: ["baking", "schedule"],
    created: "2025-11-10",
    updated: "2026-08-09",
    status: "active",
    authored_by: [link("me")],
    about: [link("sourdough-baking")],
    summary:
      "A loaf most weeks, skipped without guilt on race weekends. Enough cadence to hold skill and keep Boris vigorous, without becoming a second job.",
    body: "",
  },
];

// ── Rendering — the canonical renderer from @brain/brainstore ──────────────

function renderNode(spec: NodeSpec): string {
  const { body, ...fm } = spec;
  return renderNote(fm, body ? `## Detail\n\n${body}` : "");
}

function renderEpisode(ep: EpisodeSpec): string {
  return [
    "---",
    `episode_id: ${ep.episode_id}`,
    `started_at: ${ep.started_at}`,
    `ended_at: ${ep.ended_at}`,
    `surface: ${ep.surface}`,
    `harness: ${ep.harness}`,
    `trust: ${ep.trust}`,
    `labels: [${ep.labels.join(", ")}]`,
    "---",
    "",
    ep.transcript,
    "",
  ].join("\n");
}

// ── Main ───────────────────────────────────────────────────────────────────

const errors: string[] = [];
const ids = new Set<string>();
for (const spec of NODES) {
  const { body: _body, ...fm } = spec;
  const verdict = validateNodeFrontmatter(fm);
  if (!verdict.ok) errors.push(`${spec.id}: ${verdict.errors.join("; ")}`);
  if (ids.has(spec.id)) errors.push(`duplicate id: ${spec.id}`);
  ids.add(spec.id);
}
// Every wikilink must resolve to a node or an episode basename.
const episodeIds = new Set(EPISODES.map((e) => e.basename));
for (const spec of NODES) {
  for (const rel of [...EDGE_RELATIONS, "sources" as const]) {
    for (const l of (spec[rel] as string[] | undefined) ?? []) {
      const target = l.slice(2, -2);
      if (!ids.has(target) && !episodeIds.has(target))
        errors.push(`${spec.id}: ${rel} → unresolved ${l}`);
    }
  }
}
if (errors.length) {
  console.error("Example vault data is invalid:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

rmSync(join(OUT, "nodes"), { recursive: true, force: true });
rmSync(join(OUT, "episodes"), { recursive: true, force: true });

for (const spec of NODES) {
  const file = join(OUT, "nodes", spec.type, `${spec.id}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderNode(spec));
}
for (const ep of EPISODES) {
  const [y, m] = ep.basename.split("-");
  const file = join(OUT, "episodes", String(y), String(m), `${ep.basename}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderEpisode(ep));
}

console.log(`Wrote ${NODES.length} nodes and ${EPISODES.length} episodes to ${OUT}`);
