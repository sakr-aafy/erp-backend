// Point d'entrée serverless pour Vercel : réutilise l'application Express et garde la connexion MongoDB entre les appels.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../src/app.js';
import { connectDb } from '../src/config/db.js';

const app = createApp();
let ready: Promise<void> | undefined;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ready ??= connectDb().catch((e) => { ready = undefined; throw e; });
  await ready;
  app(req, res);
}
