# RollPilot API

NestJS backend for bounded AI analysis of phone-selected photos. The iPhone keeps full-size photos and controls all Apple Photos writes. This API receives at most 12 resized previews from the current app request, sends them to Gemini with `store: false`, and stores plan metadata, not image bytes.

## Local development

Requires Node.js 24. Set `GEMINI_API_KEY` in your shell or a local `.env` loader (Nest itself does not read `.env`), then run:

```sh
npm ci
npm run start:dev
```

The server listens on `127.0.0.1:3000` by default. Without `DATABASE_URL`, metadata is stored in `./data/rollpilot.json` for local use. `/v1/health` is public. All other routes require a session token from `POST /v1/sessions`. The Gemini key is required for production boot. An unset key in development makes AI requests return HTTP 503.

## Heroku deployment

Heroku's filesystem is ephemeral, so a deployed instance requires Postgres. `DATABASE_URL` switches the store to a Postgres transaction and loads prior state at boot. Use one web dyno for this TestFlight beta; rate limits are process-local (20 new sessions per IP per hour and 20 analyses per session per hour). A larger public release needs account authentication and shared rate limiting.

From this directory:

```sh
git init
git add .
git commit -m "Prepare RollPilot API for TestFlight"
heroku login
heroku create YOUR_UNIQUE_ROLLPILOT_API_NAME
heroku addons:create heroku-postgresql:essential-0 -a YOUR_UNIQUE_ROLLPILOT_API_NAME
heroku pg:wait -a YOUR_UNIQUE_ROLLPILOT_API_NAME
read -s ROLLPILOT_GEMINI_KEY
heroku config:set GEMINI_API_KEY="$ROLLPILOT_GEMINI_KEY" -a YOUR_UNIQUE_ROLLPILOT_API_NAME
unset ROLLPILOT_GEMINI_KEY
git push heroku HEAD:main
curl https://YOUR_UNIQUE_ROLLPILOT_API_NAME.herokuapp.com/v1/health
```

Heroku sets `DATABASE_URL`, `PORT`, and `NODE_ENV=production`. The `heroku-postbuild` script compiles TypeScript and `Procfile` starts `dist/main.js`. App metadata is persisted in Postgres. Neither photo bytes nor the Gemini key are stored there.

## API behaviour

- `POST /v1/sessions` returns a bearer token. The phone saves it in SecureStore; only its SHA-256 hash is persisted. A lost token cannot recover a session.
- `POST /v1/agent/analyze` accepts up to 30 candidates (the current phone UI submits up to 12), each with an optional image of at most 200 KB. `cloudImagesAllowed` must be true for thumbnails. The response only refers to supplied candidate IDs.
- `POST /v1/plans/:id/confirm` saves collection or cleanup review metadata. It never alters Apple Photos; the phone invokes iOS album or delete APIs after the person confirms.
- Errors use normal HTTP status codes. Missing AI configuration returns 503, upstream AI failures return 502, and rate limits return 429.

Run `npm run typecheck`, `npm test`, and `npm audit --omit=dev` before redeploying.
