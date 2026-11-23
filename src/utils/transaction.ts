import mongoose, { type ClientSession } from 'mongoose';

/** Exécute `fn` dans une transaction MongoDB (retry automatique sur erreurs transitoires). */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => fn(session));
  } finally {
    await session.endSession();
  }
}
