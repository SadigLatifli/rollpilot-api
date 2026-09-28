const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { AppModule } = require('../dist/app.module.js');

test('isolates sessions, validates plans, persists collections, and only records cleanup reviews', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rollpilot-api-'));
  process.env.DATA_FILE = join(directory, 'state.json');
  let app;
  const open = async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    return `http://127.0.0.1:${app.getHttpServer().address().port}`;
  };
  try {
    let base = await open();
    const call = async (path, method = 'GET', token, body) => {
      const response = await fetch(base + path, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, data: await response.json() };
    };
    assert.equal((await call('/v1/state')).status, 401);
    const first = (await call('/v1/sessions', 'POST')).data.token;
    const second = (await call('/v1/sessions', 'POST')).data.token;
    assert.notEqual(first, second);

    const plan = {
      kind: 'organize', command: 'Gather Milo photos', headline: 'Milo', detail: 'One collection', scanned: 'On-device index',
      groups: [{ id: 'milo', title: 'Milo', count: 3, photo: 'cat1', tint: '#E8C3A5' }],
    };
    assert.equal((await call('/v1/plans', 'POST', first, { ...plan, groups: [{ ...plan.groups[0], count: -1 }] })).status, 400);
    const created = await call('/v1/plans', 'POST', first, plan);
    assert.equal(created.status, 201);
    assert.equal((await call(`/v1/plans/${created.data.id}/confirm`, 'POST', first, {})).data.count, 3);
    assert.equal((await call('/v1/collections', 'GET', first)).data.length, 1);
    assert.deepEqual((await call('/v1/collections', 'GET', second)).data, []);
    assert.equal((await call(`/v1/plans/${created.data.id}/confirm`, 'POST', first, {})).status, 404);

    const cleanup = await call('/v1/plans', 'POST', first, { ...plan, kind: 'cleanup' });
    assert.equal((await call(`/v1/plans/${cleanup.data.id}/confirm`, 'POST', first, { selectedGroupIds: ['not-a-group'] })).status, 400);
    assert.equal((await call(`/v1/plans/${cleanup.data.id}/confirm`, 'POST', first, { selectedItemIds: ['milo:0'] })).data.count, 1);
    assert.equal((await call('/v1/collections', 'GET', first)).data.length, 1);
    assert.equal((await call('/v1/activity', 'GET', first)).data.length, 2);

    const raw = await readFile(process.env.DATA_FILE, 'utf8');
    assert.equal(raw.includes(first), false);
    assert.equal(raw.includes('image/jpeg'), false);
    await app.close();
    base = await open();
    assert.equal((await call('/v1/collections', 'GET', first)).data[0].title, 'Milo');
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
