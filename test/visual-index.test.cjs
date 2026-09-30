const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { VisualIndexService, validatePhotoFacts } = require('../dist/visual-index.service');
const data = Buffer.from([255, 216, 255, 217]).toString('base64');
const candidate = assetId => ({ assetId, thumbnail: { mimeType: 'image/jpeg', data } });
const facts = (assetId, uncertain = false) => ({ assetId, caption: 'A cat', text: '', objects: [{ name: 'cat', attributes: ['black'], confidence: 0.9 }], tags: [], uncertain });

test('only ambiguous classifications are sent to the stronger model, capped at four', async () => {
  const service = new VisualIndexService();
  const calls = [];
  service.generate = async (model, batch) => { calls.push({ model, ids: batch.map(p => p.assetId) }); return batch.map(p => facts(p.assetId, calls.length === 1 && p.assetId !== 'clear')); };
  const result = await service.describe({ cloudImagesAllowed: true, candidates: ['clear', 'a', 'b', 'c', 'd', 'e'].map(candidate) });
  assert.equal(calls.length, 2);
  assert.match(calls[0].model, /flash-lite/);
  assert.deepEqual(calls[1].ids, ['a', 'b', 'c', 'd']);
  assert.equal(result.reviewed, 4);
  assert.equal(result.photos.find(p => p.assetId === 'e').uncertain, true);
});
test('clear batches never invoke the expensive model; failed review preserves uncertainty', async () => {
  const service = new VisualIndexService();
  let calls = 0;
  service.generate = async (_, batch) => { calls++; return batch.map(p => facts(p.assetId)); };
  await service.describe({ cloudImagesAllowed: true, candidates: [candidate('a')] });
  assert.equal(calls, 1);
  calls = 0;
  service.generate = async (_, batch) => { if (++calls === 2) throw new Error('offline'); return batch.map(p => facts(p.assetId, true)); };
  const result = await service.describe({ cloudImagesAllowed: true, candidates: [candidate('a')] });
  assert.equal(result.photos[0].uncertain, true);
});
test('indexing requires explicit consent and valid bounded previews before any model call', async () => {
  const service = new VisualIndexService();
  service.generate = async () => assert.fail('must not call provider');
  await assert.rejects(service.describe({ cloudImagesAllowed: false, candidates: [candidate('a')] }), error => error.status === 400);
  await assert.rejects(service.describe({ cloudImagesAllowed: true, candidates: [{ assetId: 'a' }] }), error => error.status === 400);
  await assert.rejects(service.describe({ cloudImagesAllowed: true, candidates: [candidate('a'), candidate('a')] }), error => error.status === 400);
});
test('missing and hallucinated IDs or invalid confidence never enter the persistent index', () => {
  assert.throws(() => validatePhotoFacts({ photos: [] }, ['a']));
  assert.throws(() => validatePhotoFacts({ photos: [facts('b')] }, ['a']));
  assert.throws(() => validatePhotoFacts({ photos: [facts('a'), facts('a')] }, ['a', 'b']));
  const bad = facts('a'); bad.objects[0].confidence = 2;
  assert.throws(() => validatePhotoFacts({ photos: [bad] }, ['a']));
  assert.equal(validatePhotoFacts({ photos: [facts('a')] }, ['a']).length, 1);
});

test('index endpoint authenticates, persists no photo facts, and enforces the shared budget', async () => {
  const { mkdtemp, readFile, rm } = require('node:fs/promises');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const { NestFactory } = require('@nestjs/core');
  const { ValidationPipe } = require('@nestjs/common');
  const { AppModule } = require('../dist/app.module');
  const directory = await mkdtemp(join(tmpdir(), 'rollpilot-index-api-'));
  process.env.DATA_FILE = join(directory, 'state.json');
  const original = VisualIndexService.prototype.generate;
  VisualIndexService.prototype.generate = async (_, batch) => batch.map(p => ({ ...facts(p.assetId), caption: 'PRIVATE_FACT_NOT_FOR_SERVER_STORAGE' }));
  let app;
  try {
    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    const post = (route, body, token) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const payload = { cloudImagesAllowed: true, candidates: [candidate('a')] };
    assert.equal((await post('/v1/agent/index', payload)).status, 401);
    const token = (await (await post('/v1/sessions', {})).json()).token;
    assert.equal((await post('/v1/agent/index', { ...payload, cloudImagesAllowed: false }, token)).status, 400);
    for (let i = 0; i < 20; i++) {
      const response = await post('/v1/agent/index', payload, token);
      assert.equal(response.status, 201);
      assert.equal((await response.json()).photos[0].assetId, 'a');
    }
    assert.equal((await post('/v1/agent/index', payload, token)).status, 429);
    const disk = await readFile(process.env.DATA_FILE, 'utf8');
    assert.equal(disk.includes('PRIVATE_FACT_NOT_FOR_SERVER_STORAGE'), false);
    assert.equal(disk.includes(data), false);
  } finally {
    VisualIndexService.prototype.generate = original;
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
