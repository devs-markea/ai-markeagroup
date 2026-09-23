import type { IncomingMessage, ServerResponse } from "node:http";

/** Vercel's Node runtime parses the body and attaches it to the request. */
export type VercelRequest = IncomingMessage & { body?: unknown };

/** Read a single header value (first one if repeated). */
export function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export function queryParam(req: IncomingMessage, name: string): string {
  return new URL(req.url ?? "/", "https://x").searchParams.get(name) ?? "";
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
