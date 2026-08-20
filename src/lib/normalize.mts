/** Shared client-name normalization, used identically by the pipeline (write path,
 * for client resolution) and the MCP server (read path, for lookup) so they never
 * disagree about identity. */
export function normalizeClientName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}
