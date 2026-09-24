// ---------------------------------------------------------------------------
// TEMPORARY diagnostic tool for the appsecret_proof mismatch. Reports only
// metadata (length, format, masked ends) — never the actual secret value.
// Remove this file and its registration once the Meta auth issue is resolved.
// ---------------------------------------------------------------------------

function inspect(name: string): string {
  const raw = process.env[name];
  if (raw === undefined) return `${name}: NOT SET`;

  const trimmed = raw.trim();
  const hasWhitespace = trimmed !== raw;
  const mask = raw.length <= 10
    ? "*".repeat(raw.length)
    : `${raw.slice(0, 4)}…${raw.slice(-4)}`;

  const notes: string[] = [];
  if (hasWhitespace) notes.push(`⚠ has leading/trailing whitespace (raw length ${raw.length} vs trimmed ${trimmed.length})`);
  if (/\n|\r/.test(raw)) notes.push("⚠ contains a newline character");

  return `${name}: length=${raw.length} value≈${mask}${notes.length ? " — " + notes.join("; ") : ""}`;
}

export function debugEnvReport(): string {
  const lines = [
    inspect("META_APP_SECRET"),
    inspect("META_SYSTEM_USER_TOKEN"),
    inspect("META_GRAPH_VERSION"),
  ];
  // Meta app secrets are exactly 32 lowercase hex characters.
  const secret = process.env.META_APP_SECRET?.trim();
  if (secret) {
    const validFormat = /^[0-9a-f]{32}$/i.test(secret);
    lines.push(`META_APP_SECRET format check: ${validFormat ? "OK (32 hex chars)" : "UNEXPECTED — Meta app secrets are normally exactly 32 hex characters"}`);
  }
  return lines.join("\n");
}
