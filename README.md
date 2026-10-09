# SRISHTI

A single-page knowledge-exploration app. Name a topic (a "seed") and it unfolds into a 3D knowledge tree inside a dome, with a timeline (Kaal Chakra), problems (Parva), reasoning (Anumāna) and a question-and-answer search (Jigyāsa). Research and answers come from Google Gemini, called by the server so your API key never reaches the browser. Sign-in is Google only. Seeds, history and shared galaxies are stored on the server.

## Requirements

- Node.js 18 or newer (no npm packages needed)
- A Gemini API key (https://aistudio.google.com/apikey)
- A Google OAuth Web client ID for sign-in (https://console.cloud.google.com/apis/credentials)

## Quick start

```
cp .env.example .env
# edit .env: set GEMINI_API_KEY and GOOGLE_CLIENT_ID
node server.js
```

Open http://localhost:3000

### Google sign-in setup

1. In Google Cloud Console, create an OAuth client of type "Web application".
2. Under "Authorized JavaScript origins" add the exact origin you will open the app from, for example `http://localhost:3000` and your public `https://your-domain`.
3. Put the client ID in `GOOGLE_CLIENT_ID`. No client secret is needed.
4. To restrict who can sign in, set `ALLOWED_EMAILS=a@gmail.com,b@gmail.com`. Empty means any verified Google account.

### Trying it without Google sign-in

Set `DEV_LOGIN=1` and leave `GOOGLE_CLIENT_ID` empty. The sign-in dialog then asks only for a name. Use this on your own machine only, never on a public server.

## Settings (.env)

| Name | Meaning | Default |
|---|---|---|
| PORT | Port to listen on | 3000 |
| GEMINI_API_KEY | Gemini key. Without it research and Jigyāsa are disabled | none |
| GEMINI_MODEL | Gemini model name | gemini-2.5-flash |
| GEMINI_MAX_TOKENS | Max output tokens per call | 32768 |
| GEMINI_THINKING_BUDGET | Optional thinking budget (0 turns thinking off for speed) | model default |
| GOOGLE_CLIENT_ID | Google OAuth Web client ID | none |
| ALLOWED_EMAILS | Comma-separated allow-list | any |
| DEV_LOGIN | `1` enables name-only sign-in when no client ID is set | off |
| COOKIE_SECURE | `1` marks the session cookie Secure. Turn on behind HTTPS | off |
| RATE_MAX | Model calls per user per minute | 30 |
| DATA_FILE | Path of the JSON database | data/db.json |

## Share links

The black-hole icon under the ॐ button creates a link like `https://your-domain/#g-abc123…`. Anyone who opens it and signs in with Google sees the galaxy read-only and can save a copy to their own seeds. Only the creator can switch a link off ("Stop sharing"). Your Jigyāsa questions are never shared.

## Docker

```
docker build -t shrishti .
docker run -p 3000:3000 --env-file .env -v shrishti-data:/app/data shrishti
```

## How it is built

- `server.js`: dependency-free Node server. Serves `public/`, verifies Google ID tokens, keeps HttpOnly session cookies, proxies Gemini, and stores data in one JSON file with per-user access rules (private `data/users/<id>/…`, shared galaxies readable by signed-in users and writable only by their creator).
- `public/index.html`: the whole interface (Three.js loaded from cdnjs).
- `public/shim.js`: a small adapter that gives the page its model, user and storage interfaces over the server's `/api` routes, plus the Google sign-in dialog.
- `build-index.py`: regenerates `public/index.html` from the original single-file page (`python3 build-index.py shrishti.html public/index.html`). Only needed if you edit that source.

## Honesty and limits

- Gemini answers come from the model's own knowledge, with no live web sources. The app labels claims Known / Probable / Possible / Uncertain and says so when it cannot settle something. Check anything important against primary sources.
- The JSON-file database suits a small group of users. For heavy use, replace it with a real database.
- Run behind HTTPS in production and set `COOKIE_SECURE=1`.
- The three.js library is loaded from cdnjs, so the browser needs internet access for the 3D dome.
