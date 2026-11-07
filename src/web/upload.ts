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

/** Reads a multipart request into fields and files. Plain forms (urlencoded) pass straight through. */
export function readMultipart(req: Request): Promise<{ fields: Record<string, string>; files: UploadedFile[] }> {
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('multipart/form-data')) return Promise.resolve({ fields: { ...(req.body as Record<string, string>) }, files: [] });
  return new Promise((resolve, reject) => {
    const fields: Record<string, string> = {};
    const files: UploadedFile[] = [];
    let failed: Error | null = null;
    const bb = busboy({ headers: req.headers, limits: { files: MAX_PHOTOS, fileSize: MAX_PHOTO_BYTES, fields: 40, fieldSize: 20 * 1024 } });
    bb.on('field', (name, value) => { fields[name] = value; });
    bb.on('file', (field, stream, info) => {
      const chunks: Buffer[] = [];
      let tooBig = false;
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('limit', () => { tooBig = true; });
      stream.on('end', () => {
        if (tooBig) { failed = new UserError(`${info.filename || 'A photo'} is over 4 MB. Take it again at a smaller size, or let the page shrink it.`); return; }
        if (!chunks.length) return; // an empty file input
        if (!PHOTO_TYPES.has(info.mimeType)) { failed = new UserError(`${info.filename || 'That file'} isn't a photo. Use a JPEG, PNG or HEIC.`); return; }
        files.push({ field, name: info.filename, contentType: info.mimeType, bytes: Buffer.concat(chunks) });
      });
    });
    bb.on('filesLimit', () => { failed = new UserError(`Up to ${MAX_PHOTOS} photos on one flag.`); });
    bb.on('error', (e: Error) => reject(e));
    bb.on('close', () => (failed ? reject(failed) : resolve({ fields, files })));
    req.pipe(bb);
  });
}
