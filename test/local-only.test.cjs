const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { EmbeddingService } = require('../dist/embedding.service');
const { AiAnalysisService } = require('../dist/ai-analysis.service');
const { RollpilotService } = require('../dist/rollpilot.service');

test('cloud AI is disabled by default even with saved provider keys; diagnostics never probe', async () => {
  const original = { ...process.env };
  const originalFetch = global.fetch;
  let calls = 0;
  delete process.env.CLOUD_AI_ENABLED;
  process.env.GEMINI_API_KEY = 'test-only';
  process.env.OPENAI_API_KEY = 'test-only';
  global.fetch = async () => { calls++; throw new Error('Provider must never be reached'); };
  const embeddings = new EmbeddingService();
  embeddings.generate = async () => { calls++; throw new Error('Provider must never be reached'); };
  const analysis = new AiAnalysisService();
  const service = new RollpilotService({}, analysis, embeddings);
  try {
    await assert.rejects(embeddings.image({ cloudImagesAllowed: true, thumbnail: {} }), { status: 503 });
    assert.throws(() => embeddings.text('jacket'), { status: 503 });
    await assert.rejects(new EmbeddingService().generate([{ text: 'jacket' }]), { status: 503 });
    for (const provider of ['gemini', 'openai']) {
      process.env.AI_PROVIDER = provider;
      await assert.rejects(analysis.analyze({ command: 'Find jackets', candidates: [], cloudImagesAllowed: true }), { status: 503 });
    }
    await assert.rejects(service.embed('session', { text: 'jacket' }), { status: 503 });
    await assert.rejects(service.analyze('session', { command: 'Find jackets', candidates: [] }), { status: 503 });
    assert.equal((await embeddings.diagnostics()).cloudAIEnabled, false);
    assert.equal(calls, 0);
  } finally {
    global.fetch = originalFetch;
    for (const key of ['CLOUD_AI_ENABLED', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER']) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
  }
});
