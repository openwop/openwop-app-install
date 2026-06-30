/** Read a File into base64 (no `data:` prefix) for upload bodies, plus a MIME
 *  inference fallback for browsers that hand back an empty `file.type` (common for
 *  .md / .csv). Used by the KB + notebook Sources file-upload pickers. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result);
      resolve(s.includes(',') ? s.slice(s.indexOf(',') + 1) : s);
    };
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.readAsDataURL(file);
  });
}

const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // PowerPoint / Excel / OpenDocument / RTF — extracted server-side via officeparser.
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  odt: 'application/vnd.oasis.opendocument.text',
  odp: 'application/vnd.oasis.opendocument.presentation',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  rtf: 'application/rtf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  xml: 'application/xml',
};

/** The file's MIME, falling back to an extension guess (then text/plain). */
export function inferContentType(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_MIME[ext] ?? 'text/plain';
}

/** The `accept` attribute for the KB/Sources file pickers — every type the
 *  server-side extractor (`kbService.extractTextFromBytes`) can tokenize. */
export const KB_UPLOAD_ACCEPT = [
  '.txt', '.md', '.markdown', '.csv', '.json', '.html', '.xml', '.rtf',
  '.pdf', '.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods',
  'text/*', 'application/pdf', 'application/rtf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.spreadsheet',
].join(',');

/** Client-side upload size cap (≈ the backend's 32 MiB decoded cap). Checked BEFORE
 *  `fileToBase64` so a huge file can't freeze/crash the tab base64-inflating in
 *  memory then 413 server-side. Applies to document + audio/video uploads. */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
export const MAX_UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));

/** True when the file is within the upload cap. */
export function withinUploadCap(file: File): boolean {
  return file.size <= MAX_UPLOAD_BYTES;
}
