export function buildSafeObjectName(originalFileName: string): string {
  // Normalize and strip accents (e.g., "2º" -> "2o")
  const normalized = originalFileName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

  const lastDot = normalized.lastIndexOf(".");
  const hasExt = lastDot > 0 && lastDot < normalized.length - 1;
  const base = hasExt ? normalized.slice(0, lastDot) : normalized;
  const ext = hasExt ? normalized.slice(lastDot) : "";

  const safeBase = (base
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "file");

  const safeExt = ext.toLowerCase().replace(/[^a-z0-9.]/g, "");

  // Prefix UUID to avoid collisions and keep object keys ASCII-safe.
  return `${crypto.randomUUID()}-${safeBase}${safeExt}`;
}
