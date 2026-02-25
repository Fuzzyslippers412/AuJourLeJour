# Au Jour Le Jour

Local-first essentials tracker. Runs fully offline with a local SQLite file.

## Web + Local

Web app (static): [aujourlejour.xyz](https://aujourlejour.xyz)

Local app (recommended): run on your machine with SQLite and full features.

Built to plug into the **MyCasaPro Finance Agent (Mamdou)** later via a stable contract. AJL remains a standalone ledger and exposes a clean integration surface for the agent to read summaries and propose actions.

## Install Local (Recommended)

```sh
git clone https://github.com/Fuzzyslippers412/AuJourLeJour.git
cd AuJourLeJour
./start.sh
```

Open `http://localhost:6709` or `http://<your-ip>:6709` on your local network.

Requirements:
- Node.js 18+ (start.sh will install dependencies automatically if missing)

## Web vs Local (What’s Different)

Web (static, GitHub Pages):
- Runs in the browser only
- Data stays in your browser storage (localStorage/IndexedDB)
- No server required
- Best for quick access, but data is device/browser specific

Local (server + SQLite):
- Runs on your machine with SQLite persistence
- Full feature set and local network access
- Recommended for long-term use and reliability

## Web Build (Static)

The public web build lives in `docs/` and runs entirely in the browser.

If you deploy AJL publicly yourself, set `PUBLIC_BASE_URL` and point DNS to your host.

## Domain / Public URL

Public domain: [aujourlejour.xyz](https://aujourlejour.xyz)

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
