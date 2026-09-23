import type { TextContent } from "../../lib/tools";

// ---------------------------------------------------------------------------
// Fal.ai REST helpers
// ---------------------------------------------------------------------------

const FAL_RUN   = "https://fal.run";
const FAL_QUEUE = "https://queue.fal.run";
const FAL_REST  = "https://rest.alpha.fal.ai";
const FAL_MCP   = "https://mcp.fal.ai/mcp";

function falKey(): string {
  const key = process.env.FAL_API_KEY;
  if (!key) throw new Error("FAL_API_KEY is not configured");
  return key;
}

function falHeaders(): Record<string, string> {
  return { Authorization: `Key ${falKey()}`, "Content-Type": "application/json" };
}

/** Synchronous model run — waits for the result. */
export async function falRun(endpointId: string, input: unknown): Promise<unknown> {
  const res = await fetch(`${FAL_RUN}/${endpointId}`, {
    method: "POST",
    headers: falHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Fal.ai ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Async queue submit — returns request_id immediately. */
export async function falQueueSubmit(endpointId: string, input: unknown): Promise<unknown> {
  const res = await fetch(`${FAL_QUEUE}/${endpointId}`, {
    method: "POST",
    headers: falHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Fal.ai queue ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Check job status or fetch result using the pre-built URLs returned by submit.
 * Fal.ai provides status_url and response_url in the submit response — use them
 * directly with GET instead of reconstructing the path (which requires endpoint_id).
 *
 * The URL comes from the client and the request carries FAL_API_KEY, so it must
 * point at Fal's queue host — otherwise the key would be sent to any server.
 */
export async function falQueueCheck(url: string): Promise<unknown> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.host !== new URL(FAL_QUEUE).host) {
    throw new Error(`Refusing to call ${parsed.origin}: only ${FAL_QUEUE} URLs returned by submit_job are allowed`);
  }

  const res = await fetch(parsed, {
    method: "GET",
    headers: falHeaders(),
  });
  if (!res.ok) throw new Error(`Fal.ai queue ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Files end up public on Fal's CDN under our account, so only accept the media
 * types models actually consume (not HTML, scripts, executables…). SVG is
 * excluded because it can embed scripts.
 */
const ALLOWED_UPLOAD_TYPES = /^(image\/(?!svg)|video\/|audio\/)[\w.+-]+$/i;

/** Get a presigned PUT URL (upload_url) and the resulting CDN URL (file_url). */
export async function falInitiateUpload(
  contentType: string,
  fileSize: number
): Promise<{ upload_url: string; file_url: string }> {
  if (!ALLOWED_UPLOAD_TYPES.test(contentType)) {
    throw new Error(`Unsupported content type "${contentType}": only image/* (except SVG), video/* and audio/* are allowed`);
  }

  const res = await fetch(`${FAL_REST}/storage/upload/initiate`, {
    method: "POST",
    headers: falHeaders(),
    body: JSON.stringify({ content_type: contentType, file_size: fileSize }),
  });
  if (!res.ok) throw new Error(`Storage initiate ${res.status}: ${await res.text()}`);
  return (await res.json()) as { upload_url: string; file_url: string };
}

/**
 * Upload bytes to Fal.ai CDN.
 * Two-step: initiate → get presigned URL, then PUT the bytes.
 * Returns the public CDN URL.
 */
export async function falStorageUpload(data: Buffer, contentType: string): Promise<string> {
  const { upload_url, file_url } = await falInitiateUpload(contentType, data.byteLength);

  const putRes = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: data,
  });
  if (!putRes.ok) throw new Error(`Storage PUT ${putRes.status}: ${await putRes.text()}`);

  return file_url;
}

// ---------------------------------------------------------------------------
// Minimal Fal.ai MCP client — used for tools without a direct REST equivalent
// (get_model_schema, get_pricing, search_docs)
// ---------------------------------------------------------------------------

export async function proxyToFalMcp(
  toolName: string,
  args: Record<string, unknown>
): Promise<TextContent> {
  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${falKey()}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  // 1) initialize
  const initRes = await fetch(FAL_MCP, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "fal-mcp-proxy", version: "1.0.0" },
      },
    }),
  });
  if (!initRes.ok) {
    throw new Error(`Fal.ai MCP init ${initRes.status}: ${await initRes.text()}`);
  }
  await initRes.text(); // consume body

  const sessionId = initRes.headers.get("Mcp-Session-Id");
  const hdrs: Record<string, string> = { ...baseHeaders };
  if (sessionId) hdrs["Mcp-Session-Id"] = sessionId;

  // 2) initialized notification
  await fetch(FAL_MCP, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  // 3) tools/call
  const callRes = await fetch(FAL_MCP, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  if (!callRes.ok) {
    throw new Error(`Fal.ai MCP ${toolName} ${callRes.status}: ${await callRes.text()}`);
  }

  // Handle both JSON and SSE responses
  const ct = callRes.headers.get("content-type") ?? "";
  let result: { content?: TextContent; isError?: boolean } | undefined;

  if (ct.includes("text/event-stream")) {
    const text = await callRes.text();
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ") && !line.includes("[DONE]")) {
        try {
          const msg = JSON.parse(line.slice(6)) as { result?: { content?: TextContent } };
          if (msg.result) { result = msg.result; break; }
        } catch { /* skip */ }
      }
    }
  } else {
    const msg = (await callRes.json()) as { result?: { content?: TextContent }; error?: { message: string } };
    if (msg.error) throw new Error(msg.error.message);
    result = msg.result;
  }

  if (!result?.content) throw new Error(`No result content from Fal.ai MCP for ${toolName}`);
  return result.content;
}
