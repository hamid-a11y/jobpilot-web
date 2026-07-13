# JobPilot-web

A hosted, multi-user version of JobPilot. Anyone can open the site, create a private workspace,
tell it about their experience, and get AI-tailored resumes and cover letters on their own
dashboard. Each person brings their own Anthropic API key, so the operator pays nothing.

**It drafts; you apply.** JobPilot never submits an application for anyone — it prepares everything
and the user reviews, edits, approves, and applies themselves. That's deliberate (it keeps humans in
control and avoids violating any job board's terms).

## How it works for a user

1. Open the site → **Create my workspace** (name + your own Anthropic key from console.anthropic.com).
2. You get a **private link** (an unguessable URL). Bookmark it — it's the only way back in, and it's
   your access key. Don't share it.
3. Fill in your **profile** (the only source the AI is allowed to use — it can't make anything up).
4. Add target companies / paste a job, hit **Find & draft jobs**, and review the drafts on your dashboard.
5. Approve the ones you like, apply on the employer's site, mark them submitted to track.

## Privacy & isolation

- **Workspaces are fully isolated.** Every row is scoped to a workspace id and every query binds it;
  there is no code path that returns another workspace's data. This is enforced and tested
  (`test/isolation.test.mjs` — two workspaces, proven unable to read each other).
- **Bring-your-own-key.** Each workspace stores its own Anthropic key, used only for its own runs,
  never shown back, never shared. The operator's account is never billed.
- **Access model.** A workspace is protected by its unguessable URL (like a private document link),
  not a password. Simple and appropriate for a small trusted group; anyone with a workspace's link
  can see and edit that workspace, so users should keep their link private.
- The `no-referrer` policy prevents the private URL leaking to employer sites when a user clicks an
  apply link.

> Note: this is a share-with-friends tool, not a hardened public SaaS. If you plan to open it to
> strangers at scale, add real accounts (email + password/OAuth), encrypt stored API keys at rest,
> add rate limiting, and move from SQLite to a managed database. See "Hardening" below.

## Run locally

```bash
npm install
npm test          # includes the isolation guarantee test
npm start         # http://localhost:4400
```

## Deploy (Render, free)

1. Push this repo to your GitHub (it's already set up if you cloned it from there).
2. On render.com: **New + → Blueprint → connect this repo → Apply**. `render.yaml` does the rest.
3. You get a public `https://<name>.onrender.com` URL to share.

**Free-plan caveat:** the filesystem is ephemeral, so the SQLite database resets on restart/redeploy.
Fine for trying it out. For data that persists, upgrade the service to Starter ($7/mo) and uncomment
the `disk:` block in `render.yaml`. (Railway and Fly.io are good alternatives with free volumes.)

## Hardening

Already in place:
- ✅ **API keys encrypted at rest** (AES-256-GCM; server key from `JOBPILOT_SECRET`
  env, or auto-generated to `<data>/.secret`). Decrypted only in memory at call time.
- ✅ **Security headers** — Content-Security-Policy (blocks all scripts; app has none),
  `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `X-Powered-By` removed.
- ✅ **Rate limiting** — 5 new workspaces/IP/hour, 12 pipeline runs/workspace/hour.
- ✅ **Per-workspace monthly spend cap** — hard-stops runs over `JOBPILOT_WS_MONTHLY_CAP`
  (default $20) so a runaway loop can't drain someone's key.

Still recommended before opening to the general public at scale:
- Real auth (email verification + password or OAuth) instead of secret-URL workspaces.
- Managed Postgres instead of local SQLite; per-workspace row-level security.
- CSRF tokens on the POST forms (the secret-URL model mitigates but doesn't eliminate CSRF).
- A distributed rate limiter (the current one is per-instance, in-memory).

## Configuration

| Env var | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | 4400 |
| `JOBPILOT_DATA_DIR` | SQLite + `.secret` location | `./data` |
| `JOBPILOT_SECRET` | 32-byte key (hex/base64) to encrypt API keys | auto-generated to `.secret` |
| `JOBPILOT_WS_MONTHLY_CAP` | $/workspace/month hard cap | 20 |
| `JOBPILOT_MODEL` | Anthropic model id | claude-sonnet-5 |

> On a host with an ephemeral disk (Render free), set `JOBPILOT_SECRET` explicitly —
> otherwise the auto-generated `.secret` is lost on restart and stored keys can't be decrypted.

## Relationship to JobPilot

This reuses JobPilot's core: compliant channel classification, the deterministic dealbreaker filter,
LLM ranking, and the tailoring **truthfulness gate** (every number and credential in a draft must
trace to the user's own verified profile). The single-user local original lives separately.
