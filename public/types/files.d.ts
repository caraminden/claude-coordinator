// Artifacts and the shared folder.
// Part of the page's shapes: the rules and the shared core are in ../types.d.ts.

/** A file a minion showed (src/routes/files.ts artifactView). */
export interface ArtifactFile {
  id: number;
  project_id: number;
  ticket_id: number;
  path: string;
  size: number;
  mtime: number;
  created_at: number;
  pinned_at: number | null;
  pinned_by: string | null;
  missing: number;
  name: string;
  display_path: string;
  abs: string;
  kind: 'markdown' | 'text' | 'canvas' | 'html' | 'pdf' | 'image' | 'video' | 'audio' | 'download';
  ticket_title: string;
  ticket_kind: string;
  ticket_number: number | null;
}

/** A file in the scheme's shared folder (src/http.ts SharedFile). */
export interface SharedFile {
  path: string;
  name: string;
  kind: string;
  display_path: string;
  size: number;
  mtime: number;
  pinned_at: number | null;
  pinned_by: string | null;
  missing: number;
}
