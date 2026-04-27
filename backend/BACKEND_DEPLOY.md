# Deploying the autonomous backend agent

This deploys a **Cloudflare Worker** that polls 9 RSS feeds every 6 hours, classifies each item with Claude, and exposes the results at a public URL — no human in the loop, no API key in the browser. This is what closes the Option B requirement that the index "autonomously update over time" and is "hosted publicly so others can track its updates."

Total time: ~10 minutes. Cost on Cloudflare's free tier: $0 (well under the 100k req/day limit). API cost: a few cents per day on Haiku at this volume.

---

## What you'll need

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- Node.js 18+ on your machine (for the `wrangler` CLI)
- An Anthropic API key from [console.anthropic.com](https://console.anthropic.com/settings/keys)

---

## Step 1 — Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

This opens a browser to authorize Wrangler against your Cloudflare account.

---

## Step 2 — Create a KV namespace

The worker needs somewhere to persist its results between cron runs. From the `backend/` folder:

```bash
wrangler kv namespace create UAS_STORE
```

You'll see output like:

```
🌀 Creating namespace with title "uas-latency-agent-UAS_STORE"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
[[kv_namespaces]]
binding = "UAS_STORE"
id = "abc123def456..."
```

Copy the `id` value, open `wrangler.toml`, and replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with it. Keep the binding name as `STORE` (the worker code references `env.STORE`, not `env.UAS_STORE`).

---

## Step 3 — Set secrets

The Anthropic key and admin token are stored as encrypted secrets, not in the toml file:

```bash
wrangler secret put ANTHROPIC_API_KEY
# paste sk-ant-... when prompted

wrangler secret put ADMIN_TOKEN
# paste any random string — used to authorize manual /api/run calls
```

### Optional but recommended: ACLED structured data source

The worker can also pull from the **Armed Conflict Location & Event Data Project (ACLED)**, which provides geocoded, hand-curated incident records. Items from ACLED come pre-structured (event type, lat/lon, country, notes), so the worker skips the Claude classification step for them — saving tokens and giving you accurate coordinates.

1. **Register for a free academic API key** at [acleddata.com/access-acled-api](https://acleddata.com/access-acled-api/). The form takes 1–2 days to approve.
2. Once approved, you'll receive a key by email.
3. Add the credentials as Worker secrets:

   ```bash
   wrangler secret put ACLED_API_KEY
   # paste the key from your ACLED email

   wrangler secret put ACLED_EMAIL
   # paste the email address you registered with — ACLED requires both
   ```

4. Redeploy: `wrangler deploy`. The next sweep will include ACLED items alongside RSS items.

**Rate limits:** ACLED's free tier allows **1,000 requests per day**. The worker makes one ACLED call per sweep, so at the default 6-hour cron you use 4 requests/day — well within quota.

**Citation requirement:** ACLED's academic license requires that any public-facing use of the data cite them. If you display ACLED data on a deployed site, include this line in your footer or about page:

> "Conflict event data sourced from the Armed Conflict Location & Event Data Project (ACLED); Raleigh, C., Kishi, R., & Linke, A. (2023). Political instability patterns are obscured by conflict dataset scope conditions, sources, and coding rules."

### Optional: GDELT (no auth)

GDELT 2.0's Doc API is also queried automatically — it requires no key. Items are geocoded by the news outlet's home country (a rough but usable proxy). Articles whose `sourcecountry` isn't in the worker's small centroid map are skipped. No setup needed; this just works.

---

## Step 4 — Deploy

```bash
wrangler deploy
```

Wrangler prints the public URL, something like:

```
Published uas-latency-agent (1.2 sec)
  https://uas-latency-agent.<your-subdomain>.workers.dev
Current Deployment ID: ...
```

That URL **is your public benchmark** — the thing you submit for the assignment.

---

## Step 5 — Trigger the first sweep

The cron runs every 6 hours, so KV is empty until either it fires or you trigger one manually:

```bash
curl -X POST https://uas-latency-agent.<your-subdomain>.workers.dev/api/run \
  -H "x-admin-token: <the ADMIN_TOKEN you set above>"
```

You'll get back a JSON payload with the classified items and an internal log of every feed fetch and Claude call. After this completes, the public endpoint is live:

```bash
curl https://uas-latency-agent.<your-subdomain>.workers.dev/api/items
```

This endpoint is **public, no auth, no API key required from the caller**. Anyone can read it. That's exactly what Option B asks for.

---

## What's running on a schedule

The cron is configured as `0 */6 * * *` in `wrangler.toml` — every 6 hours at the top of the hour. You can change it (e.g. `0 */1 * * *` for hourly) but be mindful of:

- Each sweep makes ~5 Claude API calls (one per chunk of ~18 items)
- At Haiku rates, ~$0.001 per sweep
- Hourly sweeps = ~$0.025/day

Cloudflare's free tier allows 100,000 worker requests/day and unlimited cron invocations, so cost is bounded entirely by your Anthropic spend.

---

## Endpoints exposed by the worker

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Tiny landing page describing the agent |
| GET | `/api/items` | Latest sweep — full JSON of classified items + the internal log |
| GET | `/api/history` | List of historical sweep timestamps (kept for last 30 sweeps) |
| GET | `/api/history/:timestamp` | A specific historical sweep |
| POST | `/api/run` | Force a sweep immediately (requires `x-admin-token` header) |

---

## Wiring the front-end to the backend (optional)

If you want your hosted HTML app to read from the backend instead of asking each visitor for an API key, edit the front-end's `runSweep` to fetch from `/api/items` first and fall back to live classification only when the backend is unreachable. Tell Claude (or me, in the build conversation) to wire this up — it's a one-block edit.

---

## Why this satisfies Option B

> "The student should use agentic AI tools (Claude Code, Google's Antigravity, OpenAI Codex, etc.) to build an indicator that can autonomously update over time. This project should be hosted publicly (on a mini website, an app, or a public codebase) so that others can track its updates."

- ✓ Autonomous: cron-triggered, no human required after deploy
- ✓ Updates over time: every 6 hours, with a 30-sweep history retained
- ✓ Publicly hosted: the workers.dev URL is anonymously accessible
- ✓ Tracking: `/api/history` exposes the evolving record
- ✓ Built with agentic tools: this whole worker was generated and iterated through a Claude conversation, transcript downloadable from the front-end
