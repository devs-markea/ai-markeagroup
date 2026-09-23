import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolError } from "../../lib/tools";
import { SERVERS } from "../registry";
import { CATALOG, type CatalogModel } from "./catalog";
import {
  falInitiateUpload,
  falQueueCheck,
  falQueueSubmit,
  falRun,
  falStorageUpload,
  proxyToFalMcp,
} from "./client";

const META = SERVERS.fal;

export function createFalServer(): McpServer {
  const server = new McpServer({ name: META.name, version: META.version });

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
          status_url?: string;
          response_url?: string;
        };
        const text = [
          `Job submitted successfully.`,
          `request_id:   ${result.request_id}`,
          `endpoint_id:  ${endpoint_id}`,
          ...(result.status_url   ? [`status_url:   ${result.status_url}`]   : []),
          ...(result.response_url ? [`response_url: ${result.response_url}`] : []),
          ``,
          `Use check_job with status_url to poll, or response_url once COMPLETED.`,
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
        "Poll the status or fetch the final result of an async Fal.ai job. " +
        "Pass status_url to check progress, or response_url to retrieve the final output once COMPLETED. " +
        "Both URLs are returned by submit_job.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        url: z.string().url().describe(
          "The status_url (to poll progress) or response_url (to get the result) returned by submit_job. Must be an https://queue.fal.run URL."
        ),
      },
    },
    async ({ url }) => {
      try {
        const data = await falQueueCheck(url);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── initiate_upload ───────────────────────────────────────────────────────
  // Returns a presigned PUT URL so the client can upload directly to Fal.ai CDN
  // without routing binary data through this proxy. Preferred for files > 1 MB.

  server.registerTool(
    "initiate_upload",
    {
      title: "Initiate Upload",
      description:
        "Get a presigned upload URL for Fal.ai CDN. Returns upload_url (PUT your bytes there) " +
        "and file_url (the resulting CDN URL to use in model inputs). " +
        "Preferred over upload_file for images/videos > 1 MB — no binary data goes through the proxy.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        content_type: z.string().describe("MIME type, e.g. 'image/jpeg', 'image/png', 'video/mp4'"),
        file_size: z.number().int().positive().describe("File size in bytes"),
      },
    },
    async ({ content_type, file_size }) => {
      try {
        const { upload_url, file_url } = await falInitiateUpload(content_type, file_size);
        const text = [
          `Upload initiated.`,
          `upload_url: ${upload_url}`,
          `file_url:   ${file_url}`,
          ``,
          `PUT your file bytes to upload_url with Content-Type: ${content_type}`,
          `Then use file_url as the input URL for run_model or submit_job.`,
          ``,
          `Alternatively, POST the file as multipart/form-data to /fal-ia/upload`,
          `(field name "file") to have the proxy handle the upload automatically.`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── upload_file ───────────────────────────────────────────────────────────
  // For small files only (< ~3 MB). Larger files should use initiate_upload
  // or POST directly to /fal-ia/upload to avoid Vercel's 4.5 MB body limit.

  server.registerTool(
    "upload_file",
    {
      title: "Upload File (small files)",
      description:
        "Upload a small file (< 3 MB) to Fal.ai CDN via base64. " +
        "For larger files use initiate_upload instead to avoid proxy size limits.",
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
    async ({ base64_data, content_type }) => {
      try {
        const cdnUrl = await falStorageUpload(Buffer.from(base64_data, "base64"), content_type);
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
