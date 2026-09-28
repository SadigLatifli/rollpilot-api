const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { AppModule } = require('../dist/app.module.js');
const { GeminiService, validateAnalysis } = require('../dist/gemini.service.js');

test('Gemini plans use known assets and cleanup returns only reviewed IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rollpilot-agent-'));
  process.env.DATA_FILE = join(directory, 'state.json');
  const original = GeminiService.prototype.analyze;
  GeminiService.prototype.analyze = async () => ({ kind: 'cleanup', groups: [{ title: 'Review these', assetIds: ['asset-1'] }] });
  let app;
  try {
    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    const post = async (path, token, body) => {
      const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    const token = (await post('/v1/sessions', null, {})).data.token;
    const request = { command: 'Find old screenshots to review', cloudImagesAllowed: true, candidates: [{ assetId: 'asset-1', description: 'QR screenshot', previewKey: 'qr', thumbnail: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }] };
    const created = await post('/v1/agent/analyze', token, request);
    assert.equal(created.status, 201);
    assert.deepEqual(created.data.plan.groups[0].assetIds, ['asset-1']);
    assert.equal(created.data.plan.groups[0].coverAssetId, 'asset-1');
    assert.equal(created.data.plan.scanned, '1 candidate photo considered');
    assert.equal((await post(`/v1/plans/${created.data.plan.id}/confirm`, token, { selectedAssetIds: ['other'] })).status, 400);
    const reviewed = await post(`/v1/plans/${created.data.plan.id}/confirm`, token, { selectedAssetIds: ['asset-1'] });
    assert.equal(reviewed.data.count, 1);
    assert.deepEqual(reviewed.data.selectedAssetIds, ['asset-1']);
    assert.equal((await readFile(process.env.DATA_FILE, 'utf8')).includes('iVBORw0KGgo='), false);
  } finally {
    GeminiService.prototype.analyze = original;
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Gemini rejects thumbnails without consent before sending them', async () => {
  process.env.GEMINI_API_KEY = 'test-only';
  try {
    const gemini = new GeminiService();
    await assert.rejects(gemini.analyze({ command: 'Find cats', cloudImagesAllowed: false, candidates: [{ assetId: 'a', thumbnail: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }] }), error => error.status === 400);
  } finally {
    delete process.env.GEMINI_API_KEY;
  }
});

test('Gemini output cannot introduce or duplicate asset IDs', () => {
  const ids = new Set(['asset-1']);
  assert.throws(() => validateAnalysis({ kind: 'cleanup', groups: [{ title: 'Old', assetIds: ['other'] }] }, ids), error => error.status === 502);
  assert.throws(() => validateAnalysis({ kind: 'cleanup', groups: [{ title: 'Old', assetIds: ['asset-1', 'asset-1'] }] }, ids), error => error.status === 502);
  assert.deepEqual(validateAnalysis({ kind: 'find', groups: [{ title: 'Matches', assetIds: ['asset-1'] }] }, ids).groups[0].assetIds, ['asset-1']);
});
