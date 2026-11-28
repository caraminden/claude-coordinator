// A GitHub repo URL's owner/name, with no imports, so the MCP server's pinned copy can take it (src/turn-launch.ts pinnedCopy).
/** "owner/name" (lowercase) of a GitHub repo URL, https or git@; null for anything else. */
export function repoSlug(repoUrl: string | null): string | null {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(repoUrl ?? '');
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}
