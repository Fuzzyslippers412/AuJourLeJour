# Au Jour Le Jour

Local-first essentials tracker. Runs fully offline with a local SQLite file.

## Run

```sh
cd /path/to/au-jour-le-jour
./start.sh
```

Open `http://localhost:6709` or `http://<your-ip>:6709` on your local network.

Requirements:
- Node.js 18+ (start.sh will install dependencies automatically if missing)

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

AJL owns its own data. Integrations must use the v1 contract (no direct DB access).

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
- `LLM_MODEL` (default `qwen2.5-coder:7b-instruct`) — used by Ollama
- `LLM_DISABLED=1` to turn LLM off
- `LLM_TIMEOUT_MS` (default `15000`)
- `LLM_MAX_RETRIES` (default `1`)
- `LLM_MAX_TOKENS` (default `512`)
- `LLM_TEMPERATURE` (default `0.2`)

Qwen OAuth (recommended):
- Open the app → **Nudges** → **Start login** to authorize via web.
- Uses Qwen device flow at `https://chat.qwen.ai/authorize`.

Qwen Code CLI (optional):
- `QWEN_CLI_BIN` (default `qwen`)
- `QWEN_CLI_MODEL` (optional, uses your CLI default model)

Ollama (optional fallback):
- `OLLAMA_URL` (default `http://127.0.0.1:11434`)

## Notes

- Month generation is idempotent (no duplicates).
- Template edits only affect future months unless you apply them to the current month.
- “Free for the month — essentials covered.” appears when remaining essentials are 0 and nothing is overdue.
- Partial payments are supported via payment events; totals update live.
- Cash on hand is stored per month and decreases as payments are logged.
