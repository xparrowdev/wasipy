// MongoDB connection (cached across warm serverless invocations).
// Data rule: ONE database ("wasipy"), EVERY document carries its owner's
// userId, and EVERY query filters by userId. No user can ever see another
// user's data.
const { MongoClient, ObjectId } = require('mongodb');

let clientPromise = null;

function getClient() {
  if (!clientPromise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('Missing MONGODB_URI');
    const client = new MongoClient(uri, {
      // Fail fast (8s) instead of the driver's 30s default, so a blocked or
      // wrong database surfaces a clear error instead of a hung request.
      serverSelectionTimeoutMS: 8000,
    });
    clientPromise = client.connect();
  }
  return clientPromise;
}

async function getDb() {
  const client = await getClient();
  return client.db('wasipy');
}

async function logActivity(userId, text) {
  try {
    const db = await getDb();
    await db.collection('actionLog').insertOne({
      userId: String(userId),
      text,
      createdAt: new Date(),
    });
  } catch (e) {
    console.error('logActivity failed', e);
  }
}

module.exports = { getDb, getClient, logActivity, ObjectId };
