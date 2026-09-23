// ---------------------------------------------------------------------------
// Server registry — metadata only (no imports of server code), so any endpoint
// can read it without bundling every MCP server.
//
// To add a server: add an entry here, create servers/<id>/server.ts and
// api/<path>/mcp.ts. See CLAUDE.md → "Agregar un MCP nuevo".
// ---------------------------------------------------------------------------

export interface ServerMeta {
  /** Short id, used in logs and as the servers/<id> folder name. */
  id: string;
  /** MCP server name reported to clients. */
  name: string;
  version: string;
  description: string;
  /** Public path of the MCP endpoint. */
  path: string;
  /** Env var with the header token (`Authorization: Bearer`); falls back to MCP_BEARER_TOKEN. */
  tokenEnv: string;
  /**
   * Env var with the URL token (`?token=`), for claude.ai connectors. Omit it for
   * servers that don't need connectors — `?token=` is then never accepted.
   */
  urlTokenEnv?: string;
}

export const SERVERS = {
  fal: {
    id: "fal",
    name: "fal-ai-proxy",
    version: "1.0.0",
    description: "Fal.ai — image/video/audio generation, async jobs, CDN uploads, model schemas and pricing",
    path: "/fal-ia/mcp",
    tokenEnv: "MCP_TOKEN_FAL",
    urlTokenEnv: "MCP_URL_TOKEN_FAL",
  },
} as const satisfies Record<string, ServerMeta>;
