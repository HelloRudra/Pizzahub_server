import { MongoClient } from 'mongodb';

let client;
let db;

export async function connectDB() {
  if (!db) {
    client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db(process.env.DB_NAME);
    console.log('MongoDB connected');
  }
  return db;
}

export function getDB() {
  if (!db) throw new Error('Database not connected');
  return db;
}