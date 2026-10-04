# RollPilot API

NestJS proxy for Gemini Embedding 2 photo search. Image and text requests use `gemini-embedding-2` with 768 dimensions. Bounded previews are processed in memory; returned vectors remain in the phone's SQLite index. Flash/Flash-Lite is reserved for reasoning over up to six selected candidates. The old full-library description endpoint returns 410.

## Local development

Requires Node.js 24. Set `GEMINI_API_KEY` in your shell or a local `.env` loader (Nest itself does not read `.env`), then run:

```sh
npm ci
npm run start:dev
```

The server listens on `127.0.0.1:3000` by default. Without `MONGODB_URI`, metadata is stored in `./data/rollpilot.json` for local use. `/v1/health` is public. All other routes require a session token from `POST /v1/sessions`. An unset provider key makes AI requests return HTTP 503 while local app search continues to work.

## Heroku Dashboard deployment from GitHub

The backend is a separate repository at `SadigLatifli/rollpilot-api`. Connect that repository to Heroku; the Expo app lives in a different directory and is not deployed by Heroku. Heroku's filesystem is ephemeral, so production requires a persistent MongoDB database. The app connects to the `rollpilot` database using `MONGODB_URI`; locally, it uses the JSON file unless a MongoDB URI is supplied.

1. Create a MongoDB Atlas project and cluster, then create a database user with read/write access to the `rollpilot` database.
2. In Atlas **Network Access**, allow connections from Heroku. Heroku dynos do not have a fixed outbound IP by default, so a broad `0.0.0.0/0` entry may be needed for this setup. It allows attempts from any IP; protect the database with a unique strong password and database-scoped user. Atlas IP access lists control which clients can connect.
3. In Atlas, choose **Connect → Drivers → Node.js** and copy the connection URI. In Heroku **Settings → Config Vars**, add it as `MONGODB_URI`; replace the URI placeholders with the database user's credentials. Also add `GEMINI_API_KEY`. Never commit either secret or `.env` to GitHub. Heroku supplies `PORT` and sets `NODE_ENV=production`.
4. In Heroku **Deploy → Deployment method**, choose **GitHub**. Connect `SadigLatifli/rollpilot-api`, select branch `main`, and enable **Automatic Deploys**. Leave **Wait for CI to pass** off unless you configure a GitHub CI check.
5. Use **Deploy Branch** once for the first deployment. After that, pushing a commit to `main` triggers a new deployment automatically.
6. Open `https://YOUR_HEROKU_APP.herokuapp.com/v1/health`; a healthy deployment returns `{"status":"ok"}`. If it does not, check **Activity** and **More → View logs** in Heroku Dashboard.
7. Set that exact HTTPS origin as `EXPO_PUBLIC_API_URL` in the EAS **production** environment before building the iPhone app. This is an app build setting, separate from Heroku's config vars.

The `heroku-postbuild` script compiles TypeScript and `Procfile` starts `dist/main.js`. Each session is stored as one document in MongoDB. Neither photo bytes nor provider keys are stored there. Use one web dyno for this TestFlight beta; rate limits are process-local (20 new sessions per IP per hour and separate embedding/reasoning budgets described below). A larger public release needs account authentication and shared rate limiting.

## API behavior

All routes except health/session creation require the existing SecureStore bearer session. Embedding requests never create plans or persist previews, text queries or vectors on the backend.

- `GET /v1/health`: `searchVersion: 3`, `embeddingModel: gemini-embedding-2`, `dimensions: 768`.
- `POST /v1/embeddings/image`: `{ cloudImagesAllowed: true, thumbnail: { mimeType: "image/jpeg", data: "BASE64" } }`. One image, JPEG/PNG <=200 KB, required consent. No asset identifier is needed server-side.
- `POST /v1/embeddings/text`: `{ text: "black Coke bottle" }`, 1–500 characters.
- Both return `{ model, dimensions, values }`, with exactly 768 finite normalized numbers. No fallback to a different embedding space/model. API keys remain server-only.
- `GET /v1/diagnostics`: backend reachability, model availability, model/dimensions, probe timestamp and last sanitized provider error. A real embedding probe is coalesced and cached for five minutes; configuration alone is not proof of availability.
- `POST /v1/agent/index`: 410, including older clients. Deploy together with the new app rollout.
- `POST /v1/agent/analyze`: optional small reasoning task, at most six candidates. Flash/Flash-Lite settings affect only this route. Purchases are one possible workflow, not the search engine.
- Existing plan, collection, onboarding and confirmation routes are retained. Apple Photos changes still happen on-device after user review.

Per-session/hour budgets are separate: 1,200 image attempts, 300 text attempts, and the existing 20 reasoning requests. Failed embedding attempts count to prevent retry storms. Provider 408/5xx errors retry once; 429/auth/model-access errors do not. Missing key/model access returns 503, invalid provider vectors 502, quota 429. No preview/query/vector content is logged. Limits are process-local; keep the existing single-dyno deployment or add shared enforcement before scaling.

`GEMINI_API_KEY` is required in production even when optional reasoning uses OpenAI. Embedding model/dimensions are deliberately fixed to match the mobile index. No new database or vector service is required.

## Validation and rollout

Use Node 24. Run `npm run typecheck` and `npm test` (integration tests bind localhost). The sibling app has SQLite migration, resumability and hybrid-search tests. The opt-in live check is:

```sh
npm run build
node --env-file=.env scripts/evaluate-embeddings.cjs /tmp/public-fixtures --public-only
```

Use only the documented public cat/dog fixtures, resized to <=200 KB. See the app's `SEARCH_VALIDATION.md` for fixture sources, measured scores and the physical-device QA still required. The test covers actual SDK/API calls, app indexing, disk SQLite/reopen, unchanged-photo reuse and local results; it simulates native Photos/OCR adapters.
