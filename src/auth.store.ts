import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { Pool } from "pg";

export type User = { id: number; email: string; createdAt: string };
type StoredUser = Omit<User, "createdAt"> & { createdAt: Date };
type UserRow = StoredUser & { passwordHash: string };
function publicUser(row: StoredUser): User {
  return {
    id: row.id,
    email: row.email,
    createdAt: row.createdAt.toISOString(),
  };
}
export const SESSION_MS = 8 * 60 * 60 * 1000;

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

export async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await derive(password, salt)).toString("hex")}`;
}

async function passwordMatches(
  password: string,
  stored: string,
): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  const actual = await derive(password, salt);
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

@Injectable()
export class AuthStore implements OnModuleDestroy, OnModuleInit {
  private readonly db: Pool;
  private readonly dummy = passwordHash(randomBytes(32).toString("hex"));

  constructor() {
    if (!process.env.DATABASE_URL)
      throw new Error(
        "DATABASE_URL is required. Copy .env.example to .env and start PostgreSQL.",
      );
    const schema = process.env.DATABASE_SCHEMA || "public";
    if (!/^[a-z][a-z0-9_]*$/.test(schema))
      throw new Error("Invalid DATABASE_SCHEMA");
    this.db = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema}`,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    `);
  }

  async register(email: string, password: string): Promise<User | null> {
    const hash = await passwordHash(password);
    const result = await this.db.query<StoredUser>(
      `INSERT INTO users(email, password_hash) VALUES ($1, $2)
      ON CONFLICT(email) DO NOTHING RETURNING id, email, created_at AS "createdAt"`,
      [email, hash],
    );
    return result.rows[0] ? publicUser(result.rows[0]) : null;
  }

  async login(email: string, password: string): Promise<User | null> {
    const result = await this.db.query<UserRow>(
      'SELECT id, email, password_hash AS "passwordHash", created_at AS "createdAt" FROM users WHERE email = $1',
      [email],
    );
    const row = result.rows[0];
    const valid = await passwordMatches(
      password,
      row?.passwordHash ?? (await this.dummy),
    );
    return row && valid ? publicUser(row) : null;
  }

  async session(user: User): Promise<string> {
    await this.db.query("DELETE FROM sessions WHERE expires_at <= NOW()");
    const token = randomBytes(32).toString("hex");
    await this.db.query(
      "INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
      [digest(token), user.id, new Date(Date.now() + SESSION_MS)],
    );
    return token;
  }

  async current(token: unknown): Promise<User | null> {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
    const result = await this.db.query<StoredUser>(
      `SELECT users.id, email, created_at AS "createdAt" FROM sessions
      JOIN users ON users.id = sessions.user_id WHERE token_hash = $1 AND expires_at > NOW()`,
      [digest(token)],
    );
    return result.rows[0] ? publicUser(result.rows[0]) : null;
  }

  async revoke(token: unknown): Promise<void> {
    if (typeof token === "string")
      await this.db.query("DELETE FROM sessions WHERE token_hash = $1", [
        digest(token),
      ]);
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.end();
  }
}
