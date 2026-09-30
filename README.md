# RollPilot API

NestJS backend for on-device-first photo search. Originals remain in Apple Photos. With explicit consent, the app sends bounded JPEG previews to `/v1/agent/index` for reusable visual descriptions. Gemini 3.5 Flash-Lite handles initial classification; up to four ambiguous photos per batch are reviewed by Gemini 3.5 Flash. Facts are returned to the phone and persisted only in its SQLite index, never in backend plan/session storage. The legacy `/agent/analyze` route remains available. The local key returned HTTP 404 for Gemini 2.5 Flash-Lite on September 30, 2026; do not assume a model is usable merely because it appears in the model list.

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

The `heroku-postbuild` script compiles TypeScript and `Procfile` starts `dist/main.js`. Each session is stored as one document in MongoDB. Neither photo bytes nor provider keys are stored there. Use one web dyno for this TestFlight beta; rate limits are process-local (20 new sessions per IP per hour and 20 analyses per session per hour). A larger public release needs account authentication and shared rate limiting.

## API behaviour

- `POST /v1/sessions` returns a bearer token. The phone saves it in SecureStore; only its SHA-256 hash is persisted. A lost token cannot recover a session.
- `POST /v1/agent/analyze` accepts up to 30 candidates. The current phone UI submits descriptions only. The API still accepts an optional image of at most 200 KB when `cloudImagesAllowed` is true, but the current app never sends one. The response only refers to supplied candidate IDs.
- `POST /v1/plans/:id/confirm` saves collection or cleanup review metadata. It never alters Apple Photos; the phone invokes iOS album or delete APIs after the person confirms.
- Errors use normal HTTP status codes. Missing AI configuration returns 503, upstream AI failures return 502, and rate limits return 429. Gemini retries with `GEMINI_FALLBACK_MODEL` (default `gemini-3.5-flash-lite`) on a 503 or retired-model 404 before reporting that it is busy. Failed analyses do not consume the per-session analysis allowance.

Run `npm run typecheck`, `npm test`, and `npm audit --omit=dev` before redeploying.


## Visual index deployment

Deploy this backend before distributing the Search engine 2 app. `/v1/health` must return `searchVersion: 2` and `visualIndexVersion: 1`. Configure `GEMINI_API_KEY`; optional model overrides are `GEMINI_INDEX_MODEL` and `GEMINI_REVIEW_MODEL`. Existing `GEMINI_MODEL` overrides affect the legacy plan route only.

`POST /v1/agent/index` requires the normal session bearer token and `{ cloudImagesAllowed: true, candidates: [{ assetId, thumbnail: { mimeType, data } }] }`. Limits: 20 candidates, 200 KB per preview, 4 MB aggregate, and the existing shared 20 successful batches per session/hour. A batch must classify every supplied ID exactly once to be cached. Failed provider calls refund the request allowance; ambiguous stronger-review failures remain marked uncertain. Different queries reuse cached facts on the phone and need no additional image requests until an asset changes.

Run `npm test` for unit/API integration tests. A bounded live test is available through `scripts/evaluate-photo-index.cjs`; use `--public-only` with the documented public fixtures. Never supply personal/repository images without authorization to send those specific files to Gemini. The live test is opt-in and is not part of `npm test`.
