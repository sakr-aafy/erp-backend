import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Types } from 'mongoose';
import { AppError } from '../../utils/errors.js';

/** Stockage sécurisé des justificatifs : hors webroot, nom aléatoire, mode 0600, extension + signature vérifiées. */
export const UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads');
export const ALLOWED_EXT = ['.pdf', '.png', '.jpg', '.jpeg'] as const;
export async function storeFile(companyId: Types.ObjectId, scope: string, file: { originalname: string; buffer: Buffer; size: number }) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!(ALLOWED_EXT as readonly string[]).includes(ext)) throw AppError.badRequest(`Type de fichier non autorisé (${ALLOWED_EXT.join(', ')})`);
  const head = file.buffer.subarray(0, 4).toString('latin1');
  if ((ext === '.pdf' && !head.startsWith('%PDF')) || (ext === '.png' && !file.buffer.subarray(1, 4).toString('latin1').startsWith('PNG')) || ((ext === '.jpg' || ext === '.jpeg') && file.buffer[0] !== 0xff)) throw AppError.badRequest('Contenu du fichier incohérent avec son extension');
  const dir = path.join(UPLOAD_ROOT, companyId.toString(), scope); await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const storedName = `${crypto.randomBytes(16).toString('hex')}${ext}`; await fs.promises.writeFile(path.join(dir, storedName), file.buffer, { mode: 0o600 });
  return { storedName, ext, originalName: path.basename(file.originalname).slice(0, 120), size: file.size };
}
export const filePath = (companyId: Types.ObjectId, scope: string, storedName: string) => path.join(UPLOAD_ROOT, companyId.toString(), scope, path.basename(storedName));
export const removeFile = (companyId: Types.ObjectId, scope: string, storedName: string) => fs.promises.rm(filePath(companyId, scope, storedName), { force: true });
