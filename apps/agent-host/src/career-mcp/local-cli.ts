#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLocalCareerMcpServer } from "./local-stdio-server.js";

function parseArgs(argv: string[]) {
  let resumeFilePath = process.env.BETTERME_RESUME_FILE;
  let opportunitiesFilePath = process.env.BETTERME_OPPORTUNITIES_FILE;
  let draftsDir = process.env.BETTERME_DRAFTS_DIR;
  let includeContact = process.env.BETTERME_MCP_INCLUDE_CONTACT === "true";
  let showHelp = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") showHelp = true;
    else if (arg === "--resume" && argv[i + 1]) resumeFilePath = argv[++i];
    else if (arg === "--opportunities" && argv[i + 1]) opportunitiesFilePath = argv[++i];
    else if (arg === "--drafts-dir" && argv[i + 1]) draftsDir = argv[++i];
    else if (arg === "--include-contact") includeContact = true;
  }

  return { resumeFilePath, opportunitiesFilePath, draftsDir, includeContact, showHelp };
}

const config = parseArgs(process.argv.slice(2));

if (config.showHelp) {
  process.stderr.write(
    [
      "BetterMe Local MCP Server (stdio)",
      "",
      "Usage:",
      "  pnpm mcp:start -- --resume <better-me-backup.json> [--opportunities <opportunities.json>] [--drafts-dir <dir>]",
      "",
      "Options:",
      "  --resume <path>         Path to a BetterMe JSON backup or FactBase JSON (env: BETTERME_RESUME_FILE)",
      "  --opportunities <path>  Path to an exported Opportunity Library JSON (env: BETTERME_OPPORTUNITIES_FILE)",
      "  --drafts-dir <dir>      Optional directory for save_tailored_draft outputs (env: BETTERME_DRAFTS_DIR)",
      "  --include-contact       Opt-in to expose email/phone/links (redacted by default)",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const server = createLocalCareerMcpServer({
  resumeFilePath: config.resumeFilePath,
  opportunitiesFilePath: config.opportunitiesFilePath,
  draftsDir: config.draftsDir,
  includeContact: config.includeContact,
});

const transport = new StdioServerTransport();
await server.connect(transport);
