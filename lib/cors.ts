import type { IncomingMessage, ServerResponse } from "node:http";
import { header } from "./http";

const ALLOWED_ORIGINS = new Set(["https://claude.ai", "https://www.claude.ai"]);

/**
 * Only allowlisted browser origins get CORS headers; other websites can't call
 * the hub from a browser. Non-browser MCP clients don't send Origin and are
 * unaffected.
 */
export function setCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  methods = "GET, POST, DELETE, OPTIONS"
): void {
  res.setHeader("Vary", "Origin");
  const origin = header(req, "origin");
  if (!ALLOWED_ORIGINS.has(origin)) return;

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Accept");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}
