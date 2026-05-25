// Maps file extensions to MIME types so muninn-mirror/chunker.ts (which keys
// on MIME) can be invoked from Huginn (which keys on extension).

const EXT_TO_MIME: Record<string, string> = {
  ".pdf":  "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt":  "text/plain",
};

export function extensionToMime(extension: string): string {
  const lower = extension.toLowerCase();
  const normalized = lower.startsWith(".") ? lower : `.${lower}`;
  return EXT_TO_MIME[normalized] ?? "text/plain";
}
