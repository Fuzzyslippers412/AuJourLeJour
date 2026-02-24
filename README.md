# Au Jour Le Jour

Local-first essentials tracker. Runs fully offline with a local SQLite file.

Built to plug into the **MyCasaPro Finance Agent (Mamdou)** later via a stable contract. AJL remains a standalone ledger and exposes a clean integration surface for the agent to read summaries and propose actions.

## Run

```sh
cd /path/to/au-jour-le-jour
./start.sh
```

Open `http://localhost:6709` or `http://<your-ip>:6709` on your local network.

## Domain / Public URL

Planned public domain: `https://aujourlejour.xyz`

If you deploy AJL publicly, set `PUBLIC_BASE_URL` and point DNS to your host.

Requirements:
- Node.js 18+ (start.sh will install dependencies automatically if missing)

## Web PWA (Browser-Only)

The public web version lives in `docs/` and runs entirely in the browser using IndexedDB.

- Launch (GitHub Pages): `https://aujourlejour.xyz/`
- Data stays on the user’s device (no accounts, no server).
- The local server version remains unchanged and is still the recommended full experience.

### Mamdou on Web (Agent Bridge)

To enable Mamdou on the web PWA, deploy the **Agent Bridge** (Fly.io). This is a thin OAuth + LLM proxy that never touches the ledger.

Steps (Fly.io):
1. `cd bridge`
2. `fly launch --name ajl-agent --no-deploy`
3. `fly volumes create ajl_agent_data --size 1 --region ord`
4. `fly deploy`
5. Add DNS:
   - `agent.aujourlejour.xyz` → CNAME `ajl-agent.fly.dev`
6. In `docs/index.html`, set:
   - `window.AJL_LLM_BASE_URL = "https://agent.aujourlejour.xyz"`

The PWA will then connect Mamdou via Qwen OAuth without storing ledger data on the server.

## Data

SQLite file path:
`data/au_jour_le_jour.sqlite`

Daily backup (auto-created on server start):
`data/backups/au_jour_le_jour_YYYY-MM-DD.sqlite`

## Backup

Use the **Backup/Export** button:
- Export current month CSV
- Export full backup JSON
- Import backup JSON

## Integration Contract (v1)

AJL owns its own data. Integrations (including MyCasaPro Finance Agent) must use the v1 contract (no direct DB access).

Endpoints:
- `GET /api/v1/summary?year=YYYY&month=MM&essentials_only=true`
- `GET /api/v1/month?year=YYYY&month=MM&essentials_only=true`
- `GET /api/v1/templates`
- `POST /api/v1/actions`

All v1 payloads include `app_version` and `schema_version`.

## Local LLM Advisory (Optional)

The advisory layer is read-only. It supports Qwen OAuth device login (web flow) by default, or Qwen CLI / Ollama.

Endpoints:
- `POST /internal/advisor/query`
- `GET /internal/behavior/features?year=YYYY&month=MM&window=3`

Environment variables:
- `LLM_PROVIDER` = `qwen-oauth` (default), `qwen-cli`, or `ollama`
- `LLM_MODEL` (default `qwen3-coder-plus`) — used by Ollama
- `LLM_DISABLED=1` to turn LLM off
- `LLM_TIMEOUT_MS` (default `15000`)
- `LLM_MAX_RETRIES` (default `1`)
- `LLM_MAX_TOKENS` (default `512`)
- `LLM_TEMPERATURE` (default `0.2`)

Qwen OAuth (recommended):
- Open the app → **Mamdou** → **Connect agent** to authorize via web.
- Uses Qwen device flow at `https://chat.qwen.ai/authorize`.
 - Default model: `qwen3-coder-plus` (override via `QWEN_OAUTH_MODEL`)

Qwen Code CLI (optional):
- `QWEN_CLI_BIN` (default `qwen`)
- `QWEN_CLI_MODEL` (optional, uses your CLI default model)

Ollama (optional fallback):
- `OLLAMA_URL` (default `http://127.0.0.1:11434`)

## Notes

- Month generation is idempotent (no duplicates).
- Template edits sync to the **selected month** immediately; history remains frozen unless you explicitly apply updates.
- “Free for the month — essentials covered.” appears when remaining essentials are 0 and nothing is overdue.
- Partial payments are supported via payment events; totals update live.
- Cash on hand is stored per month and decreases as payments are logged.
