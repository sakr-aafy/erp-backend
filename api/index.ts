// Point d'entrée serverless pour Vercel : réutilise l'application Express et garde la connexion MongoDB entre les appels.
import type { IncomingMessage, ServerResponse } from 'node:http';

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;
let app: Handler | undefined;
let ready: Promise<void> | undefined;

const REQUIRED = ['MONGO_URI', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'CORS_ORIGIN', 'APP_URL'];

function fail(res: ServerResponse, code: string, detail: string): void {
  res.statusCode = 500; res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: { code, message: detail } }));
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Diagnostic : la validation de l'environnement arrête le processus ; on signale d'abord les variables absentes (noms seulement, jamais les valeurs).
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) return fail(res, 'ENV_MISSING', `Variables d'environnement absentes : ${missing.join(', ')}`);
  try {
    if (!app) {
      // La validation de l'environnement appelle console.error puis process.exit(1) : on capture le message pour le renvoyer au lieu d'un 500 muet.
      const realExit = process.exit; const realError = console.error; const lines: string[] = [];
      console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); realError(...a); };
      process.exit = ((code?: number) => { throw new Error(lines.join(' | ').replace(/\s+/g, ' ') || `process.exit(${code})`); }) as typeof process.exit;
      try { await loadApp(); } finally { process.exit = realExit; console.error = realError; }
    }
    await ready;
  } catch (e) {
    app = undefined; ready = undefined;
    return fail(res, 'STARTUP_FAILED', e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 600) : 'erreur de démarrage');
  }
  if (!app) return fail(res, 'STARTUP_FAILED', 'application non initialisée');
  app(req, res);
}

async function loadApp(): Promise<void> {
  const [{ createApp }, { connectDb }] = await Promise.all([import('../src/app.js'), import('../src/config/db.js')]);
  app = createApp() as Handler;
  ready = connectDb().catch((e) => { ready = undefined; throw e; });
}
