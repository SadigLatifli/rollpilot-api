import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Database, Session } from './models';
import { MongoClient, type Collection } from 'mongodb';

type StoredSession = { _id: string; session: Session };

@Injectable()
export class StoreService implements OnModuleInit, OnModuleDestroy {
  private readonly file = resolve(process.env.DATA_FILE ?? './data/rollpilot.json');
  private readonly client = process.env.MONGODB_URI ? new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 5 }) : null;
  private sessions: Collection<StoredSession> | null = null;
  private db: Database = { version: 1, sessions: {} };
  private queue: Promise<unknown> = Promise.resolve();

  async onModuleInit() {
    if (this.client) {
      await this.client.connect();
      this.sessions = this.client.db('rollpilot').collection<StoredSession>('sessions');
      const records = await this.sessions.find().toArray();
      this.db.sessions = Object.fromEntries(records.map(record => [record._id, record.session]));
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

  async onModuleDestroy() { await this.client?.close(); }

  hash(token: string) { return createHash('sha256').update(token).digest('hex'); }
  hasSession(hash: string) { return Object.hasOwn(this.db.sessions, hash); }
  getSession(hash: string): Session | undefined {
    const session = this.db.sessions[hash];
    return session && structuredClone(session);
  }

  async createSession() {
    const token = randomBytes(32).toString('base64url');
    const hash = this.hash(token);
    const session: Session = { onboarded: false, collections: [], activities: [], currentPlan: null };
    await this.enqueue(async () => {
      await this.persist(hash, session);
      this.db.sessions[hash] = session;
    });
    return { token };
  }

  async updateSession<T>(hash: string, update: (session: Session) => T): Promise<T> {
    return this.enqueue(async () => {
      const current = this.db.sessions[hash];
      if (!current) throw new Error('Session not found');
      const session = structuredClone(current);
      const result = update(session);
      await this.persist(hash, session);
      this.db.sessions[hash] = session;
      return result;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const job = this.queue.then(operation);
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async persist(hash: string, session: Session) {
    if (this.sessions) {
      await this.sessions.updateOne({ _id: hash }, { $set: { session } }, { upsert: true });
    } else {
      const next: Database = { ...this.db, sessions: { ...this.db.sessions, [hash]: session } };
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(temporary, this.file);
      this.db = next;
    }
  }
}
