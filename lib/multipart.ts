// ---------------------------------------------------------------------------
// Minimal multipart/form-data parser (no dependencies)
// ---------------------------------------------------------------------------

export interface Part {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

const CRLF2 = Buffer.from("\r\n\r\n");

export function parseMultipart(body: Buffer, boundary: string): Part[] {
  const sep = Buffer.from(`--${boundary}`);
  const parts: Part[] = [];
  let offset = 0;

  while (offset < body.length) {
    const start = body.indexOf(sep, offset);
    if (start === -1) break;
    offset = start + sep.length;

    // Skip CRLF after boundary
    if (body[offset] === 0x0d && body[offset + 1] === 0x0a) offset += 2;
    else if (body[offset] === 0x2d && body[offset + 1] === 0x2d) break; // --boundary--

    // Find end of headers (double CRLF)
    const headerEnd = body.indexOf(CRLF2, offset);
    if (headerEnd === -1) break;

    const headerStr = body.subarray(offset, headerEnd).toString("utf8");
    offset = headerEnd + 4;

    // Find next boundary
    const nextBoundary = body.indexOf(sep, offset);
    const dataEnd = nextBoundary === -1 ? body.length : nextBoundary - 2; // strip trailing CRLF
    const data = body.subarray(offset, dataEnd);
    offset = nextBoundary === -1 ? body.length : nextBoundary;

    // Parse headers
    const disposition = headerStr.match(/Content-Disposition:[^\r\n]*/i)?.[0] ?? "";
    const name = disposition.match(/name="([^"]+)"/i)?.[1] ?? "";
    const filename = disposition.match(/filename="([^"]+)"/i)?.[1];
    const contentType = headerStr.match(/Content-Type:\s*([^\r\n]+)/i)?.[1]?.trim();

    if (name) parts.push({ name, filename, contentType, data });
  }

  return parts;
}
