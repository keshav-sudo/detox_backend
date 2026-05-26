# DetoxOS Node Backend

Standalone Node.js backend that mirrors the DetoxOS API surface used by the React app.

## Run

1. Set `MONGO_URL` and optionally `DB_NAME`, `JWT_SECRET`, `PORT`, `CORS_ORIGINS`.
2. From this directory, install dependencies with `npm install`.
3. Start the server with `npm start`.

The frontend already points at `REACT_APP_BACKEND_URL`, so if this server runs on `http://localhost:8000` the existing DetoxOS client can use it without code changes.
