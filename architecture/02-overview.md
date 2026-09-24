# System Overview

> Part of [`architecture/`](./README.md). Section numbers (§N) are stable across files — grep them.

## 2. System overview

```mermaid
flowchart TB
    subgraph Surfaces["Surface layer — pluggable (P6, none built)"]
        DIS["Discord adapter<br/><i>P6, deferred</i>"]
        WA["WhatsApp<br/><i>future</i>"]
        CLI["CLI surface adapter<br/><i>P6</i>"]
    end

    subgraph Harness["Harness layer — pluggable"]
        CC["Claude Code<br/><b>built</b> — tools via the gateway,<br/>SessionEnd hook delivers the episode"]
        HER["Hermes<br/><i>future</i>"]
    end

    ROUTER["Session Router<br/><i>P6, not built</i><br/>surface identity to principal,<br/>conversation continuity, trust tier"]

    subgraph Core["Private core"]
        GW["<b>Tool Gateway</b><br/>MCP resource server (SDK 1.30.0, protocol 2025-11-25)<br/>discovery, auth, policy, audit"]
        BMCP["<b>Brain MCP server</b><br/>recall, expand, neighbors, trace, timeline,<br/>note, pin, ingest"]
        CONS["<b>Consolidator</b><br/>episodes to nodes, single writer,<br/>15-minute batch cadence on the VM"]
        LINT["<b>Lint</b><br/><code>brain lint</code>, on demand"]
        CON["<b>Web console</b> (§15)<br/>vault viewer, dashboard, /tasks"]
    end

    subgraph Vault["Obsidian vault — separate git repo, the VM is the only writer"]
        NOTES[("nodes/ — markdown notes<br/>typed edges in properties")]
        EPS[("episodes/ — immutable transcripts")]
        IDX[("_index/brain.db<br/>SQLite FTS5, gitignored, derived")]
    end

    subgraph Upstream["Upstream MCP servers"]
        GH["Google mail + Drive<br/>(one instance per account)"]
        TK["tasks (§16)"]
        MORE["...n more"]
    end

    DIS -.-> ROUTER
    CLI -.-> ROUTER
    WA -.-> ROUTER
    HER -.-> ROUTER
    ROUTER -.-> GW
    CC --> GW

    GW -->|"MCP"| BMCP
    GW --> GH & TK & MORE

    BMCP --> NOTES & IDX
    BMCP -->|"brain.ingest enqueues<br/>the episode envelope"| CONS
    CONS --> NOTES & EPS
    LINT --> NOTES
    CON -.->|"read-only"| NOTES & IDX
    NOTES -.->|"brain rebuild"| IDX

    OBS["Obsidian app<br/>graph view, editing, mobile"] --> NOTES
```

**Two durable assets, everything else replaceable.** The Tool Gateway and the Brain sit behind versioned contracts. Surfaces and harnesses are plugins. The vault is plain markdown that outlives every line of this code.

*What the diagram shows as built is what runs today (2026-09-24):* the one harness is Claude Code, which reaches every tool through the gateway and hands its transcript to `brain.ingest` from a SessionEnd hook (§6.4); no surface adapter, session router, or agent loop exists until P6. Episodes therefore arrive at the consolidator through the brain MCP server, not through a router. Lint has no schedule — it is run by hand (§5.9).

---

---

[← Index](./README.md)
