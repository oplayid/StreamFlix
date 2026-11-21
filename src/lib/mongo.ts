import { MongoClient, type Collection, type Db } from "mongodb";

/**
 * Server-only MongoDB access. NEVER import this from a client component.
 * The URI must be provided as a runtime environment variable (not VITE_*).
 */
let clientPromise: Promise<MongoClient> | undefined;

export function getMongoUri(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not configured");
  return uri;
}

export function getMongoClient(): Promise<MongoClient> {
  if (!clientPromise) {
    const client = new MongoClient(getMongoUri(), {
      serverSelectionTimeoutMS: 10_000,
    });
    clientPromise = client.connect().catch((err) => {
      clientPromise = undefined;
      throw err;
    });
  }
  return clientPromise;
}

export async function getDb(): Promise<Db> {
  const client = await getMongoClient();
  const configured = process.env.MONGODB_DB;
  if (configured) return client.db(configured);

  // Fall back to the database name in the connection string.
  const uri = getMongoUri();
  try {
    const parsed = new URL(uri);
    const name = parsed.pathname.replace(/^\//, "").split("?")[0];
    if (name) return client.db(decodeURIComponent(name));
  } catch {
    // ignore and use default below
  }
  // Legacy default kept on purpose: changing it would point at an empty database
  // for installations that rely on the fallback instead of MONGODB_DB/MONGODB_URI.
  return client.db("streamflix");
}

export async function collection<T extends Record<string, unknown> = Record<string, unknown>>(
  name: string,
): Promise<Collection<T>> {
  const db = await getDb();
  return db.collection<T>(name) as Collection<T>;
}

export function now(): Date {
  return new Date();
}
