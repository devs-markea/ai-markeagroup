import type { IncomingMessage, ServerResponse } from "node:http";
import { setCorsHeaders } from "../lib/cors";
import { sendJson } from "../lib/http";
import { SERVERS } from "../servers/registry";

/** GET /health — lists the MCP servers in this hub (public, no secrets). */
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  setCorsHeaders(req, res, "GET, OPTIONS");
  sendJson(res, 200, {
    status: "ok",
    servers: Object.values(SERVERS).map(({ id, name, version, description, path }) => ({
      id, name, version, description, path,
    })),
  });
}
