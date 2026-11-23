/** Initialise le replica set rs0 local (mono-nœud) puis vérifie qu'une transaction fonctionne. */
import { MongoClient } from 'mongodb';
import mongoose from 'mongoose';
import { env } from '../config/env.js';

const host = '127.0.0.1:27017';
const direct = new MongoClient(`mongodb://${host}/?directConnection=true`);
await direct.connect();
const admin = direct.db('admin');
try {
  await admin.command({ replSetGetStatus: 1 });
  console.log('Replica set déjà initialisé');
} catch {
  await admin.command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host }] } });
  console.log('Replica set rs0 initialisé');
}
await direct.close();

// Attente du PRIMARY puis test de transaction
await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 30000 });
const col = mongoose.connection.collection('_tx_check');
await col.deleteMany({});
const session = await mongoose.startSession();
await session.withTransaction(async () => { await col.insertOne({ ok: true }, { session }); });
await session.endSession();
console.log('Transaction OK, documents :', await col.countDocuments());
await col.drop();
await mongoose.disconnect();
