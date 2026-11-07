// Multipart forms (photos on a flagged problem, George, 7 Nov 2026). Busboy reads the parts;
// files come back as buffers, capped so a phone photo can't fill the database.
import type { Request } from 'express';
import busboy from 'busboy';
import { UserError } from '../db/edits.js';

export interface UploadedFile {
  field: string;
  name: string;
  contentType: string;
  bytes: Buffer;
}

export const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
export const MAX_PHOTOS = 4;

/** Files on a job (George, 7 Nov 2026): plans and the like, bigger than a photo, any type. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface UploadLimits {
  maxFiles: number;
  maxBytes: number;
  /** Allowed content types, or null for any. */
  types: Set<string> | null;
  what: string;
}
const PHOTO_LIMITS: UploadLimits = { maxFiles: MAX_PHOTOS, maxBytes: MAX_PHOTO_BYTES, types: PHOTO_TYPES, what: 'photo' };
export const FILE_LIMITS: UploadLimits = { maxFiles: 1, maxBytes: MAX_FILE_BYTES, types: null, what: 'file' };

/** Reads a multipart request into fields and files. Plain forms (urlencoded) pass straight through. */
export function readMultipart(req: Request, limits: UploadLimits = PHOTO_LIMITS): Promise<{ fields: Record<string, string>; files: UploadedFile[] }> {
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('multipart/form-data')) return Promise.resolve({ fields: { ...(req.body as Record<string, string>) }, files: [] });
  const mb = Math.round(limits.maxBytes / 1024 / 1024);
  return new Promise((resolve, reject) => {
    const fields: Record<string, string> = {};
    const files: UploadedFile[] = [];
    let failed: Error | null = null;
    const bb = busboy({ headers: req.headers, limits: { files: limits.maxFiles, fileSize: limits.maxBytes, fields: 40, fieldSize: 20 * 1024 } });
    bb.on('field', (name, value) => { fields[name] = value; });
    bb.on('file', (field, stream, info) => {
      const chunks: Buffer[] = [];
      let tooBig = false;
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('limit', () => { tooBig = true; });
      stream.on('end', () => {
        if (tooBig) { failed = new UserError(`${info.filename || `A ${limits.what}`} is over ${mb} MB.${limits.what === 'photo' ? ' Take it again at a smaller size, or let the page shrink it.' : ' Save it smaller, or split it.'}`); return; }
        if (!chunks.length) return; // an empty file input
        if (limits.types && !limits.types.has(info.mimeType)) { failed = new UserError(`${info.filename || 'That file'} isn't a photo. Use a JPEG, PNG or HEIC.`); return; }
        files.push({ field, name: info.filename, contentType: info.mimeType || 'application/octet-stream', bytes: Buffer.concat(chunks) });
      });
    });
    bb.on('filesLimit', () => { failed = new UserError(limits.maxFiles === 1 ? 'One file at a time.' : `Up to ${limits.maxFiles} photos on one flag.`); });
    bb.on('error', (e: Error) => reject(e));
    bb.on('close', () => (failed ? reject(failed) : resolve({ fields, files })));
    req.pipe(bb);
  });
}
