# JobPilot-web

A hosted, multi-user version of JobPilot. Anyone can open the site, create an account, tell it about
their experience, and get AI-tailored resumes and cover letters on their own dashboard. Each person
brings their own Anthropic API key, so the operator pays nothing.

**It drafts; you apply.** JobPilot never submits an application for anyone — it prepares everything
and the user reviews, edits, approves, and applies themselves. That's deliberate (it keeps humans in
control and avoids violating any job board's terms).

## How it works for a user

1. **Create an account** (name, email, password) or **log in** — everything is saved to your account,
   so your API key, all your profiles, and your application history are there next time. No lost links.
2. **Make one or more profiles.** Each profile is a separate search with its own résumé facts and
   application history — e.g. one for backend roles, one for management. Switch between them from the
   dashboard; the pipeline runs against whichever is active.
3. Fill in a profile (the only source the AI is allowed to use — it can't make anything up).
   You don't have to type it all: **Smart-fill** reads your uploaded **CV** (PDF/text), or you can
   **paste your LinkedIn profile text / data export**, or **describe an update in plain English**
   ("just moved to a Staff role at Stripe") — Claude structures it into the editable form and you
   review + Save. (We never log into LinkedIn for you — that risks your account.) Update it anytime.
4. Add target companies / paste a job, hit **Find & draft jobs**, and review the drafts on your dashboard.
5. Approve the ones you like, apply on the employer's site, mark them submitted to track — per profile.

## Privacy & isolation

- **Accounts are fully isolated.** Every row is scoped to a workspace id and every query binds it;
  there is no code path that returns another account's data. Enforced and tested
  (`test/isolation.test.mjs` — two accounts + two profiles, proven unable to read each other).
- **Login.** Email + password (scrypt-hashed); a signed, HttpOnly session cookie remembers you for
  45 days. The account is also reachable by its unguessable id as a fallback.
- **Bring-your-own-key.** Each account stores its own Anthropic key **encrypted at rest**, used only
  for its own runs, never shown back, never shared. The operator's account is never billed.
- The `no-referrer` policy prevents the account URL leaking to employer sites via apply links.

> Note: solid for a share-with-friends tool. Before opening to the general public at scale, see
> "Hardening" for the remaining items (managed DB, CSRF tokens, distributed rate limiting).

## Run locally

```bash
npm install
npm test          # includes the isolation guarantee test
npm start         # http://localhost:4400
```

## Deploy (Render, free)

**One click:**

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/hamid-a11y/jobpilot-web)

It reads `render.yaml`, builds, and gives you a public `https://<name>.onrender.com` URL to share.
(Or do it manually: render.com → **New + → Blueprint → connect this repo → Apply**.)

> **Set `JOBPILOT_SECRET` after the first deploy** (Render → your service → Environment → add a
> 64-hex-char value — generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
> Without it, the auto-generated key-encryption secret is lost on each restart and stored API keys
> can't be decrypted.

**Free-plan caveat:** the filesystem is ephemeral, so the SQLite database resets on restart/redeploy.
Fine for trying it out. For data that persists, upgrade the service to Starter ($7/mo) and uncomment
the `disk:` block in `render.yaml`. (Railway and Fly.io are good alternatives with free volumes.)

**Custom domain (e.g. `jobpilot.djalphire.com`):** in Render → Settings → Custom Domains, add the
subdomain; Render gives you a target. Add a `CNAME` record for `jobpilot` → that target in your DNS
provider (for djalphire.com that's Google Cloud DNS). Render issues HTTPS automatically.

## Hardening

Already in place:
- ✅ **Real accounts** — email + password (scrypt-hashed, never stored plaintext) with a signed
  HttpOnly session cookie; duplicate-email and wrong-password both rejected.
- ✅ **API keys encrypted at rest** (AES-256-GCM; server key from `JOBPILOT_SECRET`
  env, or auto-generated to `<data>/.secret`). Decrypted only in memory at call time.
- ✅ **Security headers** — Content-Security-Policy (blocks all scripts; app has none),
  `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `X-Powered-By` removed.
- ✅ **Rate limiting** — 5 new workspaces/IP/hour, 12 pipeline runs/workspace/hour.
- ✅ **Per-workspace monthly spend cap** — hard-stops runs over `JOBPILOT_WS_MONTHLY_CAP`
  (default $20) so a runaway loop can't drain someone's key.

Still recommended before opening to the general public at scale:
- Email verification + password reset (login exists; reset needs an email provider).
- Managed Postgres instead of local SQLite; per-workspace row-level security.
- CSRF tokens on the POST forms (SameSite=Lax cookies mitigate but don't eliminate CSRF).
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
