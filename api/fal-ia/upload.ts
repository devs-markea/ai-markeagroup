import type { IncomingMessage, ServerResponse } from "node:http";
import { isAuthorized } from "../../lib/auth";
import { setCorsHeaders } from "../../lib/cors";
import { header, readBody, sendJson } from "../../lib/http";
import { parseMultipart } from "../../lib/multipart";
import { SERVERS } from "../../servers/registry";
import { falStorageUpload } from "../../servers/fal/client";

/**
 * POST /fal-ia/upload
 *
 * Accepts multipart/form-data with a single "file" field, or a raw binary body
 * with its real Content-Type. Uploads the bytes to Fal.ai CDN and returns { file_url }.
 *
 * Keeps binary data out of the MCP JSON layer (no base64 inflation). The body is
 * still buffered, so Vercel's ~4.5 MB request limit applies — for larger files
 * use the initiate_upload tool and PUT directly to Fal.ai.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCorsHeaders(req, res, "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  // Auth: Fal header token only — uploads come from HTTP clients that can set headers
  if (!isAuthorized(req, { tokenEnv: SERVERS.fal.tokenEnv })) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  try {
    const contentType = header(req, "content-type") || "application/octet-stream";
    const body = await readBody(req);

    let fileBytes: Buffer;
    let fileMime: string;

    if (contentType.includes("multipart/form-data")) {
      const boundary = contentType.split("boundary=")[1]?.trim();
      if (!boundary) throw new Error("Missing boundary in multipart content-type");

      const fileField = parseMultipart(body, boundary).find((p) => p.name === "file");
      if (!fileField) throw new Error("No 'file' field in multipart body");

      fileBytes = fileField.data;
      fileMime = fileField.contentType ?? "application/octet-stream";
    } else {
      // Raw binary POST — use content-type header directly
      fileBytes = body;
      fileMime = contentType.split(";")[0].trim();
    }

    const file_url = await falStorageUpload(fileBytes, fileMime);
    sendJson(res, 200, { file_url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: msg });
  }
}
