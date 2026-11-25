import path from 'node:path';
import { Readable } from 'node:stream';
import mongoose, { type Types } from 'mongoose';
import { AppError } from '../../utils/errors.js';

/**
 * Stockage des documents clients dans MongoDB (GridFS) : persistant, sauvegardé avec la base, indépendant du disque du serveur.
 * Contrôles à l'envoi : extension autorisée, signature (octets magiques) cohérente avec l'extension, taille, jamais d'exécutable.
 */
export const MAX_DOC_BYTES = 10 * 1024 * 1024;
export const CUSTOMER_BUCKET = 'customerFiles'; export const PRODUCT_BUCKET = 'productFiles';

interface Kind { mime: string; inline: boolean; check: (b: Buffer) => boolean }
const startsWith = (b: Buffer, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ZIP = (b: Buffer) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]);
export const ALLOWED: Record<string, Kind> = {
  '.pdf': { mime: 'application/pdf', inline: true, check: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46]) },
  '.png': { mime: 'image/png', inline: true, check: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  '.jpg': { mime: 'image/jpeg', inline: true, check: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  '.jpeg': { mime: 'image/jpeg', inline: true, check: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  '.webp': { mime: 'image/webp', inline: true, check: (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8) },
  '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', inline: false, check: ZIP },
  '.xlsx': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', inline: false, check: ZIP },
};
export const ALLOWED_EXTENSIONS = Object.keys(ALLOWED);
/** Extensions jamais acceptées, même combinées (« contrat.pdf.exe », « .php.pdf »…). */
const DANGEROUS = /\.(exe|dll|bat|cmd|com|msi|scr|sh|bash|js|mjs|jar|php\d?|phtml|py|rb|pl|ps1|vbs|html?|svg|xml|hta|lnk|apk)(\.|$)/i;

const bucket = (name: string) => new mongoose.mongo.GridFSBucket(mongoose.connection.db!, { bucketName: name });

export function inspect(file: { originalname: string; buffer: Buffer }) {
  const name = [...path.basename(file.originalname)].filter((ch) => ch.charCodeAt(0) > 31).join('');
  const ext = path.extname(name).toLowerCase();
  const kind = ALLOWED[ext];
  if (DANGEROUS.test(name) || !kind) throw AppError.badRequest(`Type de fichier non autorisé (${ALLOWED_EXTENSIONS.join(', ')})`);
  if (!file.buffer.length) throw AppError.badRequest('Fichier vide');
  if (!kind.check(file.buffer)) throw AppError.badRequest('Contenu du fichier incohérent avec son extension');
  return { name: name.slice(0, 150), ext, mime: kind.mime, inline: kind.inline };
}

export async function putFile(companyId: Types.ObjectId, ownerId: Types.ObjectId, name: string, mime: string, buffer: Buffer, bucketName = CUSTOMER_BUCKET): Promise<Types.ObjectId> {
  const up = bucket(bucketName).openUploadStream(name, { metadata: { companyId, customerId: ownerId, ownerId, mime } });
  await new Promise<void>((resolve, reject) => { up.once('finish', () => resolve()); up.once('error', reject); Readable.from(buffer).pipe(up); });
  return up.id as Types.ObjectId;
}
export const openFile = (fileId: Types.ObjectId, bucketName = CUSTOMER_BUCKET) => bucket(bucketName).openDownloadStream(fileId);
export async function deleteFile(fileId: Types.ObjectId, bucketName = CUSTOMER_BUCKET) { try { await bucket(bucketName).delete(fileId); } catch { /* fichier déjà absent */ } }
