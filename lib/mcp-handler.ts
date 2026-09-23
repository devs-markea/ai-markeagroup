import type { ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ServerMeta } from "../servers/registry";
import { isAuthorized } from "./auth";
import { setCorsHeaders } from "./cors";
import { sendJson, type VercelRequest } from "./http";

/**
 * Build a Vercel handler for one MCP server.
 *
 * Each invocation creates a fresh McpServer + transport (stateless mode):
 * Vercel may route every request to a different instance, so nothing can be
 * kept in memory between requests.
 */
export function createMcpHandler(createServer: () => McpServer, meta: ServerMeta) {
  return async function handler(req: VercelRequest, res: ServerResponse): Promise<void> {
    setCorsHeaders(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!isAuthorized(req, meta)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session IDs
      enableJsonResponse: true,      // return application/json directly
    });

    const server = createServer();

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.writableEnded) sendJson(res, 500, { error: "Internal server error" });
      console.error(`[mcp:${meta.id}]`, err);
    } finally {
      setImmediate(() => server.close().catch(() => {}));
    }
  };
}
