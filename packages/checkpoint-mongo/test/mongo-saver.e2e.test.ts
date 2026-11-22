/**
 * Required test (approvals and durable runs depend on it): our MongoDB checkpointer passes
 * LangGraph's official conformance suite (@langchain/langgraph-checkpoint-validation), against
 * the Docker MongoDB. One optional-optimisation case is excluded in vitest.e2e.config.ts
 * (ADR 0030). Each test set gets a fresh database, dropped afterwards.
 */
import { randomUUID } from 'node:crypto';

import { validate } from '@langchain/langgraph-checkpoint-validation';
import { type Db, MongoClient } from 'mongodb';

import { MongoSaver } from '../src/mongo-saver.js';

const uri = process.env.MONGO_URI;
if (!uri) throw new Error('MONGO_URI is not set (copy .env.example to .env).');
const client = new MongoClient(uri);
const databases = new Map<MongoSaver, Db>();

validate<MongoSaver>({
  checkpointerName: 'MongoSaver',
  beforeAll: async () => {
    await client.connect();
  },
  afterAll: async () => {
    await client.close();
  },
  createCheckpointer: async () => {
    const db = client.db(`checkpoint_validation_${randomUUID().slice(0, 8)}`);
    const saver = new MongoSaver({ db });
    await saver.setup();
    databases.set(saver, db);
    return saver;
  },
  destroyCheckpointer: async (saver) => {
    await databases.get(saver)?.dropDatabase();
    databases.delete(saver);
  },
});
