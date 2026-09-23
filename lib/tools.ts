// ---------------------------------------------------------------------------
// Result helpers for MCP tool handlers
// ---------------------------------------------------------------------------

export type TextContent = Array<{ type: "text"; text: string }>;

export function textResult(text: string): { content: TextContent } {
  return { content: [{ type: "text", text }] };
}

/** Returns { isError: true } instead of throwing, so the client sees the message. */
export function toolError(err: unknown): { content: TextContent; isError: true } {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: msg }], isError: true };
}
