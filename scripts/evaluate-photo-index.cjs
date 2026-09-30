// Manual, opt-in live model check. --public-only uses only downloaded public fixtures.
// Other fixture sets require explicit authorization to share those images with Gemini.
// npm run build && node --env-file=.env scripts/evaluate-photo-index.cjs /path/to/fixture-directory
const fs = require('node:fs');
const path = require('node:path');
require('reflect-metadata');
if (process.argv.includes('--debug-provider')) {
  const originalFetch = global.fetch;
  global.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (!response.ok) {
      const error = await response.clone().json().catch(() => ({}));
      const message = String(error.error?.message ?? '').replaceAll(process.env.GEMINI_API_KEY || '__unset__', '[redacted]').slice(0, 400);
      console.error('Provider status:', response.status, error.error?.status, message);
    }
    return response;
  };
}

const { VisualIndexService } = require('../dist/visual-index.service');
const directory = process.argv[2];
if (!directory) throw new Error('Provide the fixture directory containing cat.jpg, green-pants.jpg, red-dress.jpg, street.jpg and bag.jpg.');
const names = process.argv.includes('--public-only') ? ['public-cat', 'green-pants'] : ['cat', 'green-pants', 'red-dress', 'street', 'bag'];
const candidates = names.map((name, index) => {
  const data = fs.readFileSync(path.join(directory, name + '.jpg'));
  if (data.length > 200000) throw new Error('Resize fixture to <=200 KB first: ' + name);
  return { assetId: `photo_${index}`, thumbnail: { mimeType: 'image/jpeg', data: data.toString('base64') } };
});
new VisualIndexService().describe({ cloudImagesAllowed: true, candidates }).then(result => {
  fs.writeFileSync(path.join(directory, 'facts.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ version: result.version, model: result.model, reviewed: result.reviewed,
    photos: result.photos.map(p => ({ id: p.assetId, fixture: names[Number(p.assetId.slice(6))], objects: p.objects, uncertain: p.uncertain })) }, null, 2));
}).catch(error => { console.error(error.message); process.exitCode = 1; });
