# AJL Agent Bridge (Fly.io)

Lightweight relay for:
- Qwen OAuth + LLM proxy
- Cross-platform read-only share links (web + local)

## Run locally

```sh
cd bridge
npm install
npm start
```

## Deploy (Fly.io)

```sh
cd bridge
fly launch --name ajl-agent --no-deploy
fly volumes create ajl_agent_data --size 1 --region ord
fly deploy
```

DNS:
- `agent.aujourlejour.xyz` → CNAME `ajl-agent.fly.dev`

Then configure client apps:
```html
<script>
  window.AJL_LLM_BASE_URL = "https://agent.aujourlejour.xyz";
  window.AJL_SHARE_BASE_URL = "https://agent.aujourlejour.xyz";
</script>
```

## Environment

- `ALLOWED_ORIGINS`: comma-separated list of allowed web origins
- `COOKIE_SECURE`: set to `false` for local HTTP testing
- `DATA_DIR` / `DB_FILE`: storage paths (default `./data/bridge.sqlite`)
- `SHARE_VIEWER_BASE_URL`: canonical viewer URL base (default `https://aujourlejour.xyz`)
  - published links use `?share=<token>` for static-host compatibility
- `BRIDGE_LLM_TIMEOUT_MS`: route-level timeout for advisor relay requests (default `22000`)

## Share API (relay)

- `GET /api/shares` (requires `X-AJL-Share-Owner`)
- `POST /api/shares`
- `PATCH /api/shares/:token`
- `POST /api/shares/:token/regenerate`
- `POST /api/shares/:token/publish`
- `GET /api/shares/:token` (public read-only)
- supports `ETag` / `If-None-Match` for `304 Not Modified` shared-view polling

Ops:
- `GET /api/health`
- `GET /api/metrics`

Payload guardrails:
- max `3000` items per publish
- max serialized payload size `~2 MB`
- each item must include `id`, `name_snapshot`, `due_date`
- optional `expires_at` for share links (must be future ISO-8601)
