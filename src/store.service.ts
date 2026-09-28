import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Database, Session } from './models';
import { Pool } from 'pg';

@Injectable()
export class StoreService implements OnModuleInit, OnModuleDestroy {
  private readonly file = resolve(process.env.DATA_FILE ?? './data/rollpilot.json');
  private readonly pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false, max: 5 }) : null;
  private db: Database = { version: 1, sessions: {} };
  private queue: Promise<unknown> = Promise.resolve();

  async onModuleInit() {
    if (this.pool) {
      await this.pool.query('CREATE TABLE IF NOT EXISTS rollpilot_state (id integer PRIMARY KEY, data jsonb NOT NULL)');
      await this.pool.query('INSERT INTO rollpilot_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING', [this.db]);
      const result = await this.pool.query<{ data: Database }>('SELECT data FROM rollpilot_state WHERE id = 1');
      this.db = result.rows[0].data;
      return;
    }
    try {
      const loaded: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (!loaded || typeof loaded !== 'object' || !('version' in loaded) || loaded.version !== 1 || !('sessions' in loaded) || !loaded.sessions || typeof loaded.sessions !== 'object') {
        throw new Error('Unsupported RollPilot data file');
      }
      this.db = loaded as Database;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async onModuleDestroy() { await this.pool?.end(); }

  hash(token: string) { return createHash('sha256').update(token).digest('hex'); }
  hasSession(hash: string) { return Object.hasOwn(this.db.sessions, hash); }
  getSession(hash: string): Session | undefined {
    const session = this.db.sessions[hash];
    return session && structuredClone(session);
  }

  async createSession() {
    const token = randomBytes(32).toString('base64url');
    const hash = this.hash(token);
    await this.mutate(db => {
      db.sessions[hash] = { onboarded: false, collections: [], activities: [], currentPlan: null };
    });
    return { token };
  }

  async updateSession<T>(hash: string, update: (session: Session) => T): Promise<T> {
    return this.mutate(db => update(db.sessions[hash]));
  }

  private async mutate<T>(update: (db: Database) => T): Promise<T> {
    const job = this.queue.then(async () => {
      if (this.pool) {
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          const current = await client.query<{ data: Database }>('SELECT data FROM rollpilot_state WHERE id = 1 FOR UPDATE');
          const next = structuredClone(current.rows[0].data);
          const result = update(next);
          await client.query('UPDATE rollpilot_state SET data = $1 WHERE id = 1', [next]);
          await client.query('COMMIT');
          this.db = next;
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
      const next = structuredClone(this.db);
      const result = update(next);
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(temporary, this.file);
      this.db = next;
      return result;
    });
    this.queue = job.catch(() => undefined);
    return job;
  }
}
