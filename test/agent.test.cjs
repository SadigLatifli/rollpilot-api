// Provider behavior tests opt in; calls use mocked provider adapters.
process.env.CLOUD_AI_ENABLED = 'true';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { AppModule } = require('../dist/app.module.js');
const { AiAnalysisService, validateAnalysis, withBusyFallback } = require('../dist/ai-analysis.service.js');

test('Gemini busy response uses fallback while key errors remain visible', async () => {
  const attempted = [];
  const result = await withBusyFallback(['primary', 'fallback'], async model => { attempted.push(model); if (model === 'primary') throw { status: 503 }; return 'ok'; });
  assert.equal(result, 'ok');
  assert.deepEqual(attempted, ['primary', 'fallback']);
  await assert.rejects(withBusyFallback(['primary', 'fallback'], async () => { throw { status: 403 }; }), error => error.status === 403);
  const retries = [];
  await assert.rejects(withBusyFallback(['primary', 'fallback'], async model => { retries.push(model); throw { status: 503 }; }, async () => {}), error => error.status === 503);
  assert.deepEqual(retries, ['primary', 'fallback', 'fallback']);
});

test('Gemini plans use known assets and cleanup returns only reviewed IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rollpilot-agent-'));
  process.env.DATA_FILE = join(directory, 'state.json');
  const original = AiAnalysisService.prototype.analyze;
  AiAnalysisService.prototype.analyze = async () => ({ kind: 'cleanup', groups: [{ title: 'Review these', assetIds: ['asset-1'] }] });
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
    AiAnalysisService.prototype.analyze = original;
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Gemini rejects thumbnails without consent before sending them', async () => {
  process.env.GEMINI_API_KEY = 'test-only';
  try {
    const gemini = new AiAnalysisService();
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

test('Gemini is the default provider', async () => {
  const originalProvider = process.env.AI_PROVIDER;
  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.AI_PROVIDER;
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(new AiAnalysisService().analyze({ command: 'Find cats', cloudImagesAllowed: false, candidates: [] }), /Gemini is not configured/);
  } finally {
    if (originalProvider === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = originalProvider;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalKey;
  }
});

test('OpenAI is an optional provider and does not store photo plans', async () => {
  const originalFetch = global.fetch;
  const originalProvider = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'test-only';
  let sent;
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ kind: 'find', groups: [{ title: 'Cats', assetIds: ['a'] }] }) }] }] }) };
  };
  try {
    const result = await new AiAnalysisService().analyze({ command: 'Find cats', cloudImagesAllowed: false, candidates: [{ assetId: 'a', description: 'cat, sleeping' }] });
    assert.equal(result.groups[0].assetIds[0], 'a');
    assert.equal(sent.store, false);
    assert.equal(sent.text.format.type, 'json_schema');
    assert.deepEqual(sent.input[0].content.map(item => item.type), ['input_text', 'input_text']);
  } finally {
    global.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = originalProvider;
    delete process.env.OPENAI_API_KEY;
  }
});

test('visual search forwards real image content and enforces attribute binding in the prompt', async () => {
  const originalFetch = global.fetch;
  const originalProvider = process.env.AI_PROVIDER;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.AI_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'test-only';
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  let sent;
  global.fetch = async (_, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ kind: 'find', groups: [] }) }] }] }) };
  };
  try {
    await new AiAnalysisService().analyze({ command: 'green pants', cloudImagesAllowed: true,
      candidates: [{ assetId: 'a', thumbnail: { mimeType: 'image/jpeg', data: jpeg } }] });
    assert.deepEqual(sent.input[0].content.map(item => item.type), ['input_text', 'input_text', 'input_image']);
    assert.equal(sent.input[0].content[2].image_url, `data:image/jpeg;base64,${jpeg}`);
    assert.match(sent.instructions, /pants themselves are green/);
    assert.equal(sent.store, false);
  } finally {
    global.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = originalProvider;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  }
});

test('a configured retired Gemini model can use the explicit supported fallback', async () => {
  const calls = [];
  const result = await withBusyFallback(['retired', 'supported'], async model => {
    calls.push(model); if (model === 'retired') throw { status: 404 }; return 'ok';
  }, async () => {});
  assert.equal(result, 'ok');
  assert.deepEqual(calls, ['retired', 'supported']);
});
