# BetterMe Local MCP Server (Claude Desktop / Cursor / Antigravity)

BetterMe ships a local-first **Model Context Protocol (MCP)** stdio server that lets external AI clients (**Claude Desktop**, **Cursor**, **Antigravity**, or any MCP-compatible host) safely query your verified **FactBase** and **Opportunity Library**, audit rewrites for fabricated numbers, and save isolated tailored drafts for human review.

## Privacy & Safety Guarantees

- **100% local stdio transport**: No cloud relay, no telemetry, no shell tool.
- **Contact PII redacted by default**: `email`, `phone`, `avatarUrl`, `links`, and private opportunity notes/contacts are stripped unless you explicitly pass `--include-contact`.
- **Zero fabrication enforced**: Unconfirmed metrics are withheld from `list_verified_claims`, and `check_rewrite_grounding` / `save_tailored_draft` automatically run the deterministic `_novel_numbers` guard on every bullet.
- **Read-only on master data**: No tool ever deletes data, auto-applies to jobs, sends emails, or overwrites your primary BetterMe JSON backup.

## 1. Export Your Local BetterMe Files

1. In BetterMe **Resume Studio** → `···` menu → **Download JSON backup** (e.g. `~/betterme-data/resume-backup.json`).
2. *(Optional)* In BetterMe **Opportunities** → **Back up** (e.g. `~/betterme-data/opportunities.json`).
3. *(Optional)* Create an empty drafts folder `~/betterme-data/drafts` if you want external clients to call `save_tailored_draft`.

## 2. Configure Your MCP Client

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "betterme": {
      "command": "pnpm",
      "args": [
        "--dir", "/path/to/better-me-agent-os",
        "mcp:start", "--",
        "--resume", "/path/to/betterme-data/resume-backup.json",
        "--opportunities", "/path/to/betterme-data/opportunities.json",
        "--drafts-dir", "/path/to/betterme-data/drafts"
      ]
    }
  }
}
```

### Cursor (`.cursor/mcp.json`) / Antigravity MCP Config

```json
{
  "mcpServers": {
    "betterme": {
      "command": "node",
      "args": [
        "--import", "tsx",
        "/path/to/better-me-agent-os/apps/agent-host/src/career-mcp/local-cli.ts"
      ],
      "env": {
        "BETTERME_RESUME_FILE": "/path/to/betterme-data/resume-backup.json",
        "BETTERME_OPPORTUNITIES_FILE": "/path/to/betterme-data/opportunities.json",
        "BETTERME_DRAFTS_DIR": "/path/to/betterme-data/drafts"
      }
    }
  }
}
```

## 3. Exposed MCP Tools & Resources

| Tool / Resource | Mode | Purpose |
| --- | --- | --- |
| `get_fact_base_summary` | Read-only | Anonymized profile headline, target roles, skills, and experience list |
| `list_verified_claims` | Read-only | Structured experience claims (withholds unconfirmed metric values) |
| `list_opportunities` | Read-only | Saved opportunities filtered by stage, market, or search (no private notes) |
| `check_rewrite_grounding` | Read-only | Deterministic `_novel_numbers` check flagging metrics not present in source text |
| `score_resume_against_jd` | Read-only | Deterministic JD alignment against FactBase, surfacing honest requirement gaps |
| `save_tailored_draft` | Draft-only | Saves a timestamped draft JSON under `--drafts-dir` with per-bullet grounding audit |
| `betterme://factbase/summary` | Resource | JSON summary of the FactBase |
| `betterme://opportunities/summary` | Resource | JSON summary of saved opportunities |
