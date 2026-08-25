# System Overview

> Part of [`architecture/`](./README.md). Section numbers (§N) are stable across files — grep them.

## 2. System overview

```mermaid
flowchart TB
    subgraph Surfaces["Surface layer — pluggable"]
        DIS["Discord adapter<br/><b>built</b>"]
        WA["WhatsApp<br/><i>future</i>"]
        CLI["CLI adapter<br/><b>built</b>"]
    end

    subgraph Harness["Harness layer — pluggable"]
        CC["Claude Code<br/><b>built</b>"]
        HER["Hermes<br/><i>future</i>"]
    end

    ROUTER["Session Router<br/>surface identity to principal<br/>conversation continuity, trust tier"]

    subgraph Core["Private core"]
        GW["<b>Tool Gateway</b><br/>MCP 2026-07-28 resource server<br/>discovery, auth, policy, audit"]
        BMCP["<b>Brain MCP server</b><br/>recall, expand, note, pin"]
        CONS["<b>Consolidator</b><br/>episodes to nodes, single writer"]
        LINT["<b>Lint</b><br/>nightly graph health"]
    end

    subgraph Vault["Obsidian vault — separate local git repo"]
        NOTES[("nodes/ — markdown notes<br/>typed edges in properties")]
        EPS[("episodes/ — immutable transcripts")]
        IDX[("_index/brain.db<br/>SQLite FTS5, gitignored, derived")]
    end

    subgraph Upstream["Upstream MCP servers"]
        GH["GitHub"] 
        FS["Filesystem"] 
        MORE["...n more"]
    end

    DIS --> ROUTER
    CLI --> ROUTER
    WA -.-> ROUTER
    CC --> ROUTER
    HER -.-> ROUTER
    ROUTER --> GW

    GW -->|"MCP"| BMCP
    GW --> GH & FS & MORE

    BMCP --> NOTES & IDX
    ROUTER -->|"episode envelopes"| CONS
    CONS --> NOTES & EPS
    LINT --> NOTES
    NOTES -.->|"brain rebuild"| IDX

    OBS["Obsidian app<br/>graph view, editing, mobile"] --> NOTES
```

**Two durable assets, everything else replaceable.** The Tool Gateway and the Brain sit behind versioned contracts. Surfaces and harnesses are plugins. The vault is plain markdown that outlives every line of this code.

---

---

[← Index](./README.md)
