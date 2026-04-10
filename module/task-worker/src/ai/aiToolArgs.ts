export function requireStringArg(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`AI tool argument '${key}' must be a non-empty string`);
  }

  return value;
}

export function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function summarizeLine(line: string): string {
  const normalized = line.trim().replace(/\s+/g, " ");
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

export function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
