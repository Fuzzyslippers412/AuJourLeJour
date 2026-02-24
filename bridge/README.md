# AJL Agent Bridge (Fly.io)

Lightweight OAuth + LLM proxy for the web PWA. Stores Qwen OAuth tokens per browser session and never touches the ledger.

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

Then set in `docs/app/index.html`:
```html
<script>
  window.AJL_LLM_BASE_URL = "https://agent.aujourlejour.xyz";
</script>
```

## Environment

- `ALLOWED_ORIGINS`: comma-separated list of allowed web origins
- `COOKIE_SECURE`: set to `false` for local HTTP testing
- `DATA_DIR` / `DB_FILE`: storage paths (default `./data/bridge.sqlite`)
