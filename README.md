# Wasipy — Your Easy AI Agent

Wasipy is an AI agent chatbot for websites. Each customer connects **their own
Google account**, and the agent works only in that customer's Calendar, Gmail,
Drive, Sheets, and Docs.

## How it works

- **Frontend:** `index.html` — ChatGPT-style clean chat UI (static, served by Vercel).
- **Backend:** `api/` — Vercel serverless functions (Node.js):
  - `api/auth/google.js` + `api/auth/google/callback.js` — Google OAuth sign-in
    and per-service connect (each service connects separately).
  - `api/auth/me.js`, `api/auth/logout.js` — session info / sign-out.
  - `api/connections.js` — list / disconnect services (disconnect revokes the
    token at Google too).
  - `api/chat.js` — the agent conversation.
  - `api/actions/confirm.js` — Yes/No confirmation for write actions.
  - `api/activity.js` — per-user activity log.
  - `api/_lib/` — MongoDB, signed-cookie sessions, AES-256-GCM token
    encryption, Google clients, AI agent (Gemini or OpenAI), tools.

## Data rule (never break this)

One MongoDB database (`wasipy`). **Every document carries its owner's
`userId`, and every query filters by `userId`.** Google refresh tokens are
stored encrypted (AES-256-GCM); access tokens are never stored. No user ever
sees another user's data.

Write actions (create event, send email, add sheet row, create doc) never run
from chat directly — the agent creates a pending action and the user must
confirm it (Yes/No card) before anything is written.

## Environment variables (Vercel → Settings → Environment Variables)

| Variable | Purpose | Status |
|---|---|---|
| `MONGODB_URI` | MongoDB Atlas connection string | set |
| `GOOGLE_CLIENT_ID` | Google OAuth client id | set |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret (also derives the app's encryption + session keys) | set |
| `GEMINI_API_KEY` | AI key — Google Gemini (free tier, recommended) | **owner adds** |
| `OPENAI_API_KEY` | AI key — OpenAI (used only if no Gemini key) | optional |

No other secrets are needed: encryption and session keys are derived from
`GOOGLE_CLIENT_SECRET` with HKDF.

## Deploy

The Vercel project is linked to this repo. Push to `main` and Vercel deploys
automatically. After adding/changing env vars, redeploy in the Vercel
dashboard (Deployments → ⋯ → Redeploy).

## OAuth setup (Google Cloud project "Xparrow Project Main")

- OAuth client: Web application "Wasipy"
- Redirect URI: `https://wasipy.vercel.app/api/auth/google/callback`
- Scopes (Data access): `calendar.events`, `gmail.readonly`, `gmail.send`,
  `drive.readonly`, `spreadsheets`, `documents` (+ `openid email profile` for sign-in)
- App is in test mode: only listed test users can sign in until Google verifies it.
