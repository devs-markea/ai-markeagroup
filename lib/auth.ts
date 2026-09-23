import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ServerMeta } from "../servers/registry";
import { header, queryParam } from "./http";

export type AuthConfig = Pick<ServerMeta, "tokenEnv"> & Partial<Pick<ServerMeta, "urlTokenEnv">>;

/**
 * Token check shared by every endpoint. Two independent tokens per server:
 *
 * - Header token — `Authorization: Bearer <token>`, for Claude Code and scripts.
 *   Expected value: the server's tokenEnv (e.g. MCP_TOKEN_FAL), falling back to
 *   the global MCP_BEARER_TOKEN.
 * - URL token — `?token=<token>`, only for clients that can't set headers
 *   (claude.ai connectors). Expected value: the server's urlTokenEnv
 *   (e.g. MCP_URL_TOKEN_FAL), with no fallback: if it's not set, `?token=` is
 *   disabled for that server. Keeping it separate means a leaked connector URL
 *   can be rotated without touching header clients.
 *
 * If no token is configured at all, requests are rejected (fail closed) unless
 * MCP_ALLOW_OPEN=true is set explicitly.
 */
export function isAuthorized(req: IncomingMessage, config: AuthConfig): boolean {
  const headerExpected = process.env[config.tokenEnv] || process.env.MCP_BEARER_TOKEN || "";
  const urlExpected = (config.urlTokenEnv && process.env[config.urlTokenEnv]) || "";

  if (!headerExpected && !urlExpected) {
    if (process.env.MCP_ALLOW_OPEN === "true") return true;
    console.error(`[auth] No token configured (${config.tokenEnv} / MCP_BEARER_TOKEN) — rejecting request`);
    return false;
  }

  const auth = header(req, "authorization");
  if (auth) {
    return !!headerExpected && auth.startsWith("Bearer ") && safeEqual(auth.slice(7), headerExpected);
  }

  const urlToken = queryParam(req, "token");
  return !!urlExpected && !!urlToken && safeEqual(urlToken, urlExpected);
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
