// Opt-in LIVE test, Node 24 + sibling rollpilot required. Only documented public fixtures.
// npm run build && node --env-file=.env scripts/evaluate-embeddings.cjs /tmp/public-fixtures --public-only
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const ts = require('typescript');
require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { AppModule } = require('../dist/app.module');
const directory = process.argv[2];
if (!directory || !process.argv.includes('--public-only')) throw new Error('Provide documented public cat.jpg/dog.jpg fixtures and --public-only.');
const previews = ['cat', 'dog'].map(name => {
  const bytes = fs.readFileSync(path.join(directory, name + '.jpg'));
  assert.ok(bytes.length <= 200000); return bytes.toString('base64');
});
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
global.__DEV__ = false;
(async () => {
  const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rollpilot-live-embedding-'));
  process.env.DATA_FILE = path.join(temporary, 'server.json');
  delete process.env.MONGODB_URI;
  const app = await NestFactory.create(AppModule, { logger: false });
  let sqlite;
  const originalFetch = global.fetch;
  try {
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useBodyParser('json', { limit: '1mb' });
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    process.env.EXPO_PUBLIC_API_URL = 'https://rollpilot-test.invalid';
    let uploads = 0;
    global.fetch = (url, options) => {
      if (String(url).startsWith(process.env.EXPO_PUBLIC_API_URL)) {
        if (String(url).endsWith('/embeddings/image')) uploads++;
        return originalFetch(String(url).replace(process.env.EXPO_PUBLIC_API_URL, base), options);
      }
      return originalFetch(url, options);
    };
    const dbPath = path.join(temporary, 'index.sqlite');
    sqlite = new DatabaseSync(dbPath);
    const db = {
      execAsync: async sql => sqlite.exec(sql),
      runAsync: async (sql, ...args) => sqlite.prepare(sql).run(...args),
      getFirstAsync: async (sql, ...args) => sqlite.prepare(sql).get(...args),
      getAllAsync: async (sql, ...args) => sqlite.prepare(sql).all(...args),
      withExclusiveTransactionAsync: async work => { sqlite.exec('BEGIN'); try { await work(db); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
    };
    const storage = new Map([['rollpilot-embedding-consent-v1', 'true']]);
    const assets = previews.map((_, i) => ({ id: `photo_${i}`, filename: 'IMG.jpg', uri: `ph://photo_${i}`, width: 512, height: 512, creationTime: 1, modificationTime: 1 }));
    const mocks = {
      'react-native': { Platform: { OS: 'ios' }, AppState: { currentState: 'active' } },
      '@react-native-async-storage/async-storage': { default: { getItem: async key => storage.get(key) ?? null, setItem: async (key, value) => storage.set(key, value) } },
      'expo-secure-store': { getItemAsync: async key => storage.get(key) ?? null, setItemAsync: async (key, value) => storage.set(key, value), deleteItemAsync: async key => storage.delete(key) },
      'expo-sqlite': { openDatabaseAsync: async () => db },
      'expo-media-library': { MediaType: { photo: 'photo' }, SortBy: { creationTime: 'creationTime' }, getPermissionsAsync: async () => ({ status: 'granted' }), getAssetsAsync: async () => ({ assets, totalCount: assets.length, hasNextPage: false }) },
      'expo-modules-core': { requireOptionalNativeModule: () => ({ photoThumbnail: async id => previews[Number(id.split('_')[1])], analyzeAsset: async () => ({ text: '', labels: [], bytes: 0, visualAnalyzed: true }) }) },
    };
    const load = Module._load;
    Module._load = function(id, ...args) { return mocks[id] ?? load.call(this, id, ...args); };
    let index, semantic, embeddings;
    try {
      index = require('../../rollpilot/services/photoIndex.ts');
      semantic = require('../../rollpilot/services/semanticSearch.ts');
      embeddings = require('../../rollpilot/services/embeddings.ts');
    } finally { Module._load = load; }
    const progress = await index.scanPhotoLibrary();
    if (progress.searchable !== 2) throw new Error(`Live indexing incomplete: ${await embeddings.lastAIError()}`);
    sqlite.close(); sqlite = new DatabaseSync(dbPath);
    await index.scanPhotoLibrary();
    assert.equal(uploads, 2, 'Unchanged assets must not upload twice.');
    const scores = [];
    for (const [query, expected] of [['cat', 'photo_0'], ['white dog', 'photo_1'], ['green pants', null]]) {
      const found = await index.searchIndexedPhotos(query, { onWarning: message => { throw new Error(message); } });
      assert.deepEqual(found.map(p => p.id), expected ? [expected] : [], 'Exact expected results: ' + query);
      const vector = await embeddings.embedQuery(query);
      scores.push({ query, results: found.map(p => p.id), scores: sqlite.prepare('SELECT id, vector FROM photo_embeddings').all().map(row => ({ id: row.id, similarity: semantic.cosine(vector, semantic.readVector(row.vector)) })) });
    }
    const diagnostic = await embeddings.backendDiagnostics();
    assert.equal(diagnostic.modelAvailable, true);
    console.log(JSON.stringify({ passed: true, model: diagnostic.model, dimensions: diagnostic.dimensions, searchable: progress.searchable, uploads, scores,
      scope: 'Real Gemini + HTTP + app indexing/search + disk SQLite. Native Photos/OCR simulated with public fixtures; device QA remains.' }, null, 2));
  } finally { global.fetch = originalFetch; sqlite?.close(); await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
