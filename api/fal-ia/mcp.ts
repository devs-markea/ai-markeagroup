import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Fal.ai REST helpers
// ---------------------------------------------------------------------------

const FAL_RUN   = "https://fal.run";
const FAL_QUEUE = "https://queue.fal.run";
const FAL_REST  = "https://rest.alpha.fal.ai";

function falHeaders(): Record<string, string> {
  const key = process.env.FAL_API_KEY;
  if (!key) throw new Error("FAL_API_KEY is not configured");
  return { Authorization: `Key ${key}`, "Content-Type": "application/json" };
}

/** Synchronous model run — waits for the result. */
async function falRun(endpointId: string, input: unknown): Promise<unknown> {
  const res = await fetch(`${FAL_RUN}/${endpointId}`, {
    method: "POST",
    headers: falHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Fal.ai ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Async queue submit — returns request_id immediately. */
async function falQueueSubmit(endpointId: string, input: unknown): Promise<unknown> {
  const res = await fetch(`${FAL_QUEUE}/${endpointId}`, {
    method: "POST",
    headers: falHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Fal.ai queue ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Check job status or fetch result. */
async function falQueueGet(url: string): Promise<unknown> {
  const headers = falHeaders();
  delete headers["Content-Type"];
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Fal.ai queue GET ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Upload raw binary (from base64) to Fal.ai CDN.
 * Two-step: initiate → get presigned URL, then PUT the bytes.
 * Returns the public CDN URL.
 */
async function falStorageUpload(
  base64Data: string,
  contentType: string,
  fileName: string
): Promise<string> {
  const buffer = Buffer.from(base64Data, "base64");

  // 1) Initiate upload — get presigned PUT URL
  const initRes = await fetch(`${FAL_REST}/storage/upload/initiate`, {
    method: "POST",
    headers: falHeaders(),
    body: JSON.stringify({ content_type: contentType, file_size: buffer.byteLength }),
  });
  if (!initRes.ok) {
    throw new Error(`Storage initiate ${initRes.status}: ${await initRes.text()}`);
  }
  const { upload_url, file_url } = (await initRes.json()) as {
    upload_url: string;
    file_url: string;
  };

  // 2) PUT the actual bytes
  const putRes = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: buffer,
  });
  if (!putRes.ok) {
    throw new Error(`Storage PUT ${putRes.status}: ${await putRes.text()}`);
  }

  void fileName; // available for logging if needed
  return file_url;
}

// ---------------------------------------------------------------------------
// Minimal Fal.ai MCP client — used for tools without a direct REST equivalent
// (get_model_schema, get_pricing, search_docs)
// ---------------------------------------------------------------------------

type McpContent = Array<{ type: "text"; text: string }>;

async function proxyToFalMcp(
  toolName: string,
  args: Record<string, unknown>
): Promise<McpContent> {
  const key = process.env.FAL_API_KEY;
  if (!key) throw new Error("FAL_API_KEY is not configured");

  const url = "https://mcp.fal.ai/mcp";
  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  // 1) initialize
  const initRes = await fetch(url, {
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
  await fetch(url, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  // 3) tools/call
  const callRes = await fetch(url, {
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
  let result: { content?: McpContent; isError?: boolean } | undefined;

  if (ct.includes("text/event-stream")) {
    const text = await callRes.text();
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ") && !line.includes("[DONE]")) {
        try {
          const msg = JSON.parse(line.slice(6)) as { result?: { content?: McpContent } };
          if (msg.result) { result = msg.result; break; }
        } catch { /* skip */ }
      }
    }
  } else {
    const msg = (await callRes.json()) as { result?: { content?: McpContent }; error?: { message: string } };
    if (msg.error) throw new Error(msg.error.message);
    result = msg.result;
  }

  if (!result?.content) throw new Error(`No result content from Fal.ai MCP for ${toolName}`);
  return result.content;
}

// ---------------------------------------------------------------------------
// Curated model catalog (search_models / recommend_model)
// ---------------------------------------------------------------------------

const CATALOG = [
  { id: "fal-ai/flux/dev",        name: "FLUX.1 Dev",           tags: ["text-to-image", "creative", "artistic", "general", "image"] },
  { id: "fal-ai/flux/schnell",    name: "FLUX.1 Schnell",        tags: ["text-to-image", "fast", "quick", "prototype", "image"] },
  { id: "fal-ai/flux-pro",        name: "FLUX Pro",              tags: ["text-to-image", "professional", "high-quality", "commercial", "image"] },
  { id: "fal-ai/flux-realism",    name: "FLUX Realism",          tags: ["text-to-image", "photorealistic", "photo", "portrait", "realistic", "image"] },
  { id: "fal-ai/stable-diffusion-xl", name: "Stable Diffusion XL", tags: ["text-to-image", "illustration", "stylized", "sdxl", "image"] },
  { id: "fal-ai/aura-flow",       name: "AuraFlow",              tags: ["text-to-image", "art", "painting", "creative", "image"] },
  { id: "fal-ai/kling-video/v1.6/pro/text-to-video", name: "Kling Video Pro", tags: ["text-to-video", "video", "animation", "cinematic"] },
  { id: "fal-ai/minimax-video",   name: "MiniMax Video",         tags: ["text-to-video", "video", "short-video"] },
  { id: "fal-ai/cogvideox-5b",    name: "CogVideoX-5B",          tags: ["text-to-video", "video", "realistic"] },
  { id: "fal-ai/whisper",         name: "Whisper",               tags: ["speech-to-text", "transcription", "audio", "stt"] },
  { id: "fal-ai/imageutils/rembg", name: "Remove Background",   tags: ["image-editing", "background-removal", "rembg"] },
  { id: "fal-ai/esrgan",          name: "ESRGAN Upscaler",       tags: ["image-upscaling", "upscale", "enhance", "super-resolution"] },
  { id: "fal-ai/controlnet-sdxl", name: "ControlNet SDXL",       tags: ["text-to-image", "controlnet", "pose", "depth", "guided"] },
  { id: "fal-ai/ip-adapter-face-id", name: "IP-Adapter FaceID", tags: ["image-to-image", "face", "portrait", "identity"] },
] as const;

type CatalogModel = (typeof CATALOG)[number];

// ---------------------------------------------------------------------------
// Error wrapper — returns { isError: true } instead of throwing
// ---------------------------------------------------------------------------

function toolError(err: unknown): { content: [{ type: "text"; text: string }]; isError: true } {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: msg }], isError: true };
}

// ---------------------------------------------------------------------------
// MCP server factory — one instance per request (stateless mode requirement)
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "fal-ai-proxy", version: "1.0.0" });

  // ── generate_image ────────────────────────────────────────────────────────
  // Convenience wrapper around run_model, tuned for text-to-image models.

  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image from a text prompt using any Fal.ai text-to-image model. " +
        "Returns direct image URLs. Default model: fal-ai/flux/dev.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        prompt: z.string().min(1).describe("Text description of the image"),
        model: z.string().optional().describe("Model endpoint ID (default: fal-ai/flux/dev)"),
        image_size: z
          .enum(["square_hd", "square", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9"])
          .optional()
          .describe("Output dimensions (default: landscape_16_9)"),
        num_images: z.number().int().min(1).max(4).optional().describe("How many images (1–4, default: 1)"),
        seed: z.number().int().optional().describe("Seed for reproducibility"),
        negative_prompt: z.string().optional().describe("What to exclude from the image"),
      },
    },
    async ({ prompt, model, image_size, num_images, seed, negative_prompt }) => {
      try {
        const endpointId = model ?? "fal-ai/flux/dev";
        const input: Record<string, unknown> = {
          prompt,
          image_size: image_size ?? "landscape_16_9",
          num_images: num_images ?? 1,
        };
        if (seed !== undefined) input.seed = seed;
        if (negative_prompt) input.negative_prompt = negative_prompt;

        const result = (await falRun(endpointId, input)) as {
          images?: Array<{ url: string; width: number; height: number }>;
          seed?: number;
        };

        if (!result.images?.length) {
          return { content: [{ type: "text", text: "Fal.ai returned no images." }], isError: true };
        }

        const lines = [
          `Generated ${result.images.length} image(s) via \`${endpointId}\`:`,
          ...result.images.map((img) => `• ${img.url}  (${img.width}×${img.height})`),
          ...(result.seed !== undefined ? [`\nSeed: ${result.seed}`] : []),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── run_model ─────────────────────────────────────────────────────────────

  server.registerTool(
    "run_model",
    {
      title: "Run Model",
      description:
        "Execute any Fal.ai model synchronously and wait for the result. " +
        "Use for models that complete in under 60 s. For longer tasks use submit_job.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        endpoint_id: z.string().describe("Fal.ai model endpoint, e.g. 'fal-ai/flux/dev'"),
        input: z
          .record(z.unknown())
          .describe("Model input as a JSON object. Check get_model_schema for required fields."),
      },
    },
    async ({ endpoint_id, input }) => {
      try {
        const result = await falRun(endpoint_id, input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── submit_job ────────────────────────────────────────────────────────────

  server.registerTool(
    "submit_job",
    {
      title: "Submit Async Job",
      description:
        "Submit a long-running Fal.ai model job to the queue. Returns a request_id immediately. " +
        "Use check_job to poll for status and retrieve the result.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        endpoint_id: z.string().describe("Fal.ai model endpoint, e.g. 'fal-ai/kling-video/v1.6/pro/text-to-video'"),
        input: z.record(z.unknown()).describe("Model input as a JSON object"),
      },
    },
    async ({ endpoint_id, input }) => {
      try {
        const result = (await falQueueSubmit(endpoint_id, input)) as {
          request_id: string;
        };

        // Construct URLs ourselves using the full endpoint_id.
        // Fal.ai's status_url/response_url in the response can be truncated
        // (missing sub-path variants like /o3/pro/reference-to-video/), so
        // we always build them from the endpoint_id we submitted with.
        const base = `${FAL_QUEUE}/${endpoint_id}/requests/${result.request_id}`;
        const status_url   = `${base}/status`;
        const response_url = base;

        const text = [
          `Job submitted successfully.`,
          `request_id:   ${result.request_id}`,
          `endpoint_id:  ${endpoint_id}`,
          `status_url:   ${status_url}`,
          `response_url: ${response_url}`,
          ``,
          `Pass status_url to check_job to poll progress.`,
          `Pass response_url to check_job (with fetch_result=true) to retrieve the final result.`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── check_job ─────────────────────────────────────────────────────────────

  server.registerTool(
    "check_job",
    {
      title: "Check Job",
      description:
        "Check the status of an async Fal.ai job, or fetch its final result. " +
        "Prefer passing status_url or response_url directly from submit_job output — " +
        "this avoids URL construction errors with complex endpoint paths.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        status_url: z
          .string()
          .optional()
          .describe("The status_url returned by submit_job (recommended — use this to check progress)"),
        response_url: z
          .string()
          .optional()
          .describe("The response_url returned by submit_job (use this to fetch the final result)"),
        endpoint_id: z
          .string()
          .optional()
          .describe("Fallback: the endpoint_id used in submit_job (only if status_url/response_url are unavailable)"),
        request_id: z
          .string()
          .optional()
          .describe("Fallback: the request_id returned by submit_job (only if status_url/response_url are unavailable)"),
        fetch_result: z
          .boolean()
          .optional()
          .describe("If true and using endpoint_id+request_id fallback, fetch result instead of status"),
      },
    },
    async ({ status_url, response_url, endpoint_id, request_id, fetch_result }) => {
      try {
        // Prefer direct URLs returned by submit_job — they contain the full endpoint path
        let url: string;
        if (fetch_result && response_url) {
          url = response_url;
        } else if (!fetch_result && status_url) {
          url = status_url;
        } else if (endpoint_id && request_id) {
          // Fallback: construct URL manually (may fail for multi-segment endpoint paths)
          const path = fetch_result ? "" : "/status";
          url = `${FAL_QUEUE}/${endpoint_id}/requests/${request_id}${path}`;
        } else {
          return toolError("Provide status_url (or response_url if fetching result), or both endpoint_id and request_id.");
        }

        const data = await falQueueGet(url);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── upload_file ───────────────────────────────────────────────────────────

  server.registerTool(
    "upload_file",
    {
      title: "Upload File",
      description:
        "Upload a file to Fal.ai's CDN and get back a URL you can pass to model inputs. " +
        "Provide the file content as a base64-encoded string. Max recommended size: 10 MB.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        base64_data: z
          .string()
          .describe("File content encoded as base64 (no data URI prefix, just the raw base64 string)"),
        content_type: z
          .string()
          .describe("MIME type of the file, e.g. 'image/jpeg', 'image/png', 'video/mp4'"),
        file_name: z
          .string()
          .optional()
          .describe("Optional filename hint (e.g. 'photo.jpg')"),
      },
    },
    async ({ base64_data, content_type, file_name }) => {
      try {
        const cdnUrl = await falStorageUpload(base64_data, content_type, file_name ?? "file");
        return {
          content: [
            {
              type: "text",
              text: `File uploaded successfully.\nCDN URL: ${cdnUrl}\n\nUse this URL as an input field in run_model or submit_job.`,
            },
          ],
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── get_model_schema ──────────────────────────────────────────────────────

  server.registerTool(
    "get_model_schema",
    {
      title: "Get Model Schema",
      description:
        "Retrieve the input and output parameter schema for any Fal.ai model. " +
        "Use this before run_model or submit_job to understand required fields.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        endpoint_id: z.string().describe("Fal.ai model endpoint, e.g. 'fal-ai/flux/dev'"),
      },
    },
    async ({ endpoint_id }) => {
      try {
        const content = await proxyToFalMcp("get_model_schema", { endpoint_id });
        return { content };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── get_pricing ───────────────────────────────────────────────────────────

  server.registerTool(
    "get_pricing",
    {
      title: "Get Pricing",
      description: "Check the per-run cost for a Fal.ai model before executing it.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        endpoint_id: z.string().describe("Fal.ai model endpoint, e.g. 'fal-ai/flux/dev'"),
      },
    },
    async ({ endpoint_id }) => {
      try {
        const content = await proxyToFalMcp("get_pricing", { endpoint_id });
        return { content };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── search_docs ───────────────────────────────────────────────────────────

  server.registerTool(
    "search_docs",
    {
      title: "Search Docs",
      description: "Search the Fal.ai documentation for guides, API references, and examples.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        query: z.string().min(1).describe("Search query, e.g. 'how to use ControlNet' or 'queue API'"),
      },
    },
    async ({ query }) => {
      try {
        const content = await proxyToFalMcp("search_docs", { query });
        return { content };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── search_models ─────────────────────────────────────────────────────────

  server.registerTool(
    "search_models",
    {
      title: "Search Models",
      description: "Search the Fal.ai model catalog by keyword or category.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        query: z.string().min(1).describe("Search term, e.g. 'flux', 'portrait', 'video', 'upscale'"),
        category: z
          .string()
          .optional()
          .describe("Filter by category: 'text-to-image', 'text-to-video', 'speech-to-text', 'image-editing', 'image-upscaling', 'image-to-image'"),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum results (default: 10)"),
      },
    },
    async ({ query, category, limit }) => {
      const maxResults = limit ?? 10;
      const q = query.toLowerCase();
      const cat = category?.toLowerCase();

      const results = (CATALOG as readonly CatalogModel[])
        .filter((m) => {
          const hit = m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || m.tags.some((t) => t.includes(q));
          const catHit = cat ? m.tags.some((t) => t.includes(cat)) : true;
          return hit && catHit;
        })
        .slice(0, maxResults);

      if (results.length === 0) {
        return {
          content: [{
            type: "text",
            text:
              `No models found for "${query}"` +
              (category ? ` in category "${category}"` : "") +
              `.\n\nAvailable categories: text-to-image, text-to-video, speech-to-text, image-editing, image-upscaling, image-to-image`,
          }],
        };
      }

      const lines = results.map((m) => `• \`${m.id}\` — ${m.name}\n  Tags: ${m.tags.join(", ")}`);
      return { content: [{ type: "text", text: `Found ${results.length} model(s) for "${query}":\n\n${lines.join("\n\n")}` }] };
    }
  );

  // ── recommend_model ───────────────────────────────────────────────────────

  server.registerTool(
    "recommend_model",
    {
      title: "Recommend Model",
      description: "Get ranked Fal.ai model recommendations for a given task.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        task: z.string().min(1).describe("Describe what you want to do, e.g. 'generate a photorealistic portrait' or 'create a short video'"),
        top_k: z.number().int().min(1).max(5).optional().describe("Number of recommendations (default: 3)"),
      },
    },
    async ({ task, top_k }) => {
      const k = top_k ?? 3;
      const t = task.toLowerCase();

      const scored = (CATALOG as readonly CatalogModel[])
        .map((m) => ({ ...m, score: m.tags.reduce((acc, tag) => acc + (t.includes(tag) ? 2 : 0), 0) }))
        .filter((m) => m.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k);

      if (scored.length === 0) {
        return {
          content: [{
            type: "text",
            text:
              `For: "${task}"\n\n` +
              "**Recommended:** `fal-ai/flux/dev` (FLUX.1 Dev)\n" +
              "Versatile text-to-image model for most creative tasks.\n\n" +
              "Use `generate_image` or `run_model` with this model ID.",
          }],
        };
      }

      const lines = scored.map((m, i) => `${i + 1}. \`${m.id}\` — **${m.name}**\n   Tags: ${m.tags.join(", ")}`);
      return {
        content: [{
          type: "text",
          text:
            `Best Fal.ai models for: "${task}"\n\n${lines.join("\n\n")}\n\n` +
            "Pass the chosen model ID to `run_model` or `generate_image`.",
        }],
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = new Set(["https://claude.ai", "https://www.claude.ai"]);

function setCorsHeaders(
  req: IncomingMessage & { headers: Record<string, string | string[] | undefined> },
  res: ServerResponse
): void {
  const origin =
    (Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin) ?? "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS.has(origin) ? origin : "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Accept");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Vary", "Origin");
}

// ---------------------------------------------------------------------------
// Vercel serverless handler
// Each invocation creates fresh McpServer + transport (stateless mode).
// ---------------------------------------------------------------------------

export default async function handler(
  req: IncomingMessage & { body?: unknown; headers: Record<string, string | string[] | undefined> },
  res: ServerResponse
): Promise<void> {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Auth: Bearer token from header OR ?token= query param.
  // If MCP_BEARER_TOKEN is not set, the endpoint is open (useful for claude.ai OAuth-less connectors).
  const expected = process.env.MCP_BEARER_TOKEN ?? "";
  if (expected) {
    const rawAuth = Array.isArray(req.headers.authorization)
      ? req.headers.authorization[0]
      : (req.headers.authorization ?? "");
    const headerToken = rawAuth.startsWith("Bearer ") ? rawAuth.slice(7) : "";

    // Also accept token as query param for clients that can't set custom headers
    const urlToken = new URL(req.url ?? "/", "https://x").searchParams.get("token") ?? "";

    const token = headerToken || urlToken;
    if (token !== expected) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session IDs
    enableJsonResponse: true,      // return application/json directly
  });

  const server = createMcpServer();

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.writableEnded) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
    console.error("[mcp-handler]", err);
  } finally {
    setImmediate(() => server.close().catch(() => {}));
  }
}
