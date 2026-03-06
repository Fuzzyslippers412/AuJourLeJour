# Au Jour Le Jour (Beta 1)

Private bill tracker for recurring essentials.  
No bank connections. No payment execution. Tracker only.

Web app: [aujourlejour.xyz](https://aujourlejour.xyz)  
Repo: [github.com/Fuzzyslippers412/AuJourLeJour](https://github.com/Fuzzyslippers412/AuJourLeJour)

## Core Features

- First-visit onboarding hero with guided setup
- Monthly template generation with persistent history snapshots
- Status workflow: `pending`, `partial`, `done`, `skipped`
- Partial updates reflected in monthly totals and summary math
- Action Queue (`Overdue`, `Due next 7 days`, `Later`)
- Sticky mini-summary + inline expanded summary panel (no modal required)
- Sinking funds (“Piggy Banks”) for non-monthly obligations
- Backup/export/import (`JSON` + month `CSV`)
- Cross-platform read-only sharing (web/local) with relay
- Fast-path local command parser for common Mamdou actions (low-latency fallback before LLM)
- Multi-provider Mamdou connection in local setup:
  - Qwen OAuth (default)
  - OpenAI API key
  - Anthropic API key

## Today / Review / Setup

- `Today`: action-first workflow, queue + list + sticky summary
- `Review`: activity and month-level review context
- `Setup`: templates, backups, storage controls, read-only preview mode

## Sharing (Web <-> Local)

Read-only share links work across both builds through the relay in `bridge/`.

Share controls include:
- live vs snapshot mode
- privacy toggles (amounts, notes, categories)
- optional owner display label
- optional expiry
- regenerate / disable link
- manual “Update now” publish

Viewer routes support both:
- `/?share=<token>`
- `/s/<token>` (rewritten via `404.html`)

## Web vs Local

| Capability | Web (static) | Local (SQLite) |
|---|---|---|
| Storage | Browser storage (device-specific) | SQLite file |
| Assistant (Mamdou) | Not available | Available |
| Mamdou provider options | N/A | Qwen OAuth, OpenAI key, Anthropic key |
| Offline | Browser-dependent | Full local operation |
| Backups | Export/import | Export/import + SQLite file backups |
| Sharing | Read-only relay links | Read-only relay links |
| Reliability | Depends on browser storage | Highest |

## Run Local (CLI)

```sh
git clone https://github.com/Fuzzyslippers412/AuJourLeJour.git
cd AuJourLeJour
npm install
PORT=4567 npm start
```

Use any port with `PORT=XXXX`.  
Open `http://localhost:PORT` or `http://<your-lan-ip>:PORT`.

Helper scripts:

```sh
PORT=4567 ./start.sh
PORT=4567 ./stop.sh
npm run ajl -- health --port 4567
npm run ajl -- doctor --port 4567
npm run ajl -- lan --port 4567
npm run ajl -- diagnostics --port 4567
npm run ajl -- janitor-status --port 4567
npm run ajl -- janitor --port 4567 --profile full --wait
npm run ajl -- janitor --port 4567 --profile llm-runtime --runtime-base http://127.0.0.1:6709 --runtime-required --wait
npm run ajl -- mamdou-status --port 4567
npm run ajl -- clear-llm-cache --port 4567
npm run ajl -- mamdou-login --port 4567 --open
npm run ajl -- mamdou-logout --port 4567
npm run ajl -- share-link --port 4567 --create --publish --copy --open
npm run ajl -- share-link --port 4567 --publish --year 2026 --month 3
npm run ajl -- share-link --port 4567 --regenerate
npm run ajl -- share-link --port 4567 --disable
npm run ajl -- actions --limit 20 --status ok
```

By default `start.sh` kills existing AJL server processes first (`KILL_EXISTING=1`).

## Mamdou Fast Commands (Local)

These commands are parsed locally first (before LLM) for faster response:

- `next month` / `previous month` / `march 2026`
- `show overdue` / `show due soon` / `show templates`
- `essentials on` / `essentials off`
- `export month` / `export backup`
- `mark all overdue done` / `mark all due soon done`
- `mark done internet, electric, trash`
- `mark pending internet, electric`
- `skip internet, subscriptions`
- `add cellphone for $170 monthly`
- `set template internet to 95 due 12`
- `archive template youtube tv` / `delete template subscriptions`
- multi-line bill list paste (e.g. `Name — $Amount` per line) to create templates in one confirmation
- `delete templates a, b, c` / `archive templates a, b, c`
- `open share` / `create share` / `refresh share` / `disable share`
- `open mamdou` / `connect mamdou`
- `connect mamdou with qwen`
- `connect mamdou with openai`
- `connect mamdou with anthropic`
- `remaining this month` / `overdue` / `due soon`
- `set bill internet amount to 95` / `set bill internet due to 2026-03-12`
- `set bill internet note to autopay pending`

All mutating commands remain two-step (proposal + explicit confirmation).
Read-only/navigation commands run immediately for lower latency.
If a name is ambiguous (multiple matches), Mamdou now returns a clarification prompt instead of applying to the wrong bill/template.

Optional relay env:

```sh
SHARE_RELAY_BASE_URL=https://agent.aujourlejour.xyz
SHARE_VIEWER_BASE_URL=https://aujourlejour.xyz
```

Optional local hardening env:

```sh
AJL_LOCAL_API_KEY=change_me
AJL_MUTATION_RATE_PER_MIN=240
AJL_BACKUP_RETENTION_DAYS=30
AJL_LLM_CACHE_TTL_MS=15000
AJL_LLM_ROUTE_TIMEOUT_MS=22000
```

## Web Build

The web build is served statically from `docs/` on GitHub Pages at [aujourlejour.xyz](https://aujourlejour.xyz).  
Data is stored in your browser, so regular export is strongly recommended.

## Data, Backup, and Recovery

Local SQLite:
- `data/au_jour_le_jour.sqlite`
- daily backup: `data/backups/au_jour_le_jour_YYYY-MM-DD.sqlite`

Recovery routes:
- Web reset: [aujourlejour.xyz/reset](https://aujourlejour.xyz/reset)
- Web safe mode: [aujourlejour.xyz/safe](https://aujourlejour.xyz/safe)
- Local reset: `http://localhost:PORT/reset`
- Local safe mode: `http://localhost:PORT/safe`

Diagnostics:
- `GET /api/metrics`
- `GET /api/system/diagnostics`

## Integration Contract (MyCasaPro-ready)

AJL is a standalone ledger service intended to plug into MyCasaPro Finance Agent via explicit contracts (no direct DB access).

See `CONTRACT.md`.

Core endpoints:
- `GET /api/v1/summary?year=YYYY&month=MM&essentials_only=true`
- `GET /api/v1/month?year=YYYY&month=MM&essentials_only=true`
- `GET /api/v1/templates`
- `GET /api/v1/actions?limit=50&status=pending|ok|error`
- `GET /api/v1/actions/:id`
- `POST /api/v1/actions`

## QA (Janitor)

Automated suite:

```sh
npm run janitor
```

Functional profile only:

```sh
npm run janitor:functional
```

Adversarial security profile only (Janitor adversarial):

```sh
npm run janitor:adversarial
```

Security report output:

```text
reports/janitor-security.json
```

Full consistency + QA:

```sh
npm run qa
```

Strict non-mutating checks:

```sh
npm run qa:strict
```

Web/docs sync check:

```sh
npm run sync:web:check
```

Janitor covers local API contracts, web adapter behavior, UI spec assertions, share relay lifecycle, and security/route regression checks.

Additional Janitor suites:

```sh
npm run janitor:property
npm run janitor:hygiene
npm run janitor:llm
npm run janitor:llm:runtime
npm run qa:runtime:required
```

`janitor:llm:runtime` probes your running local app (`http://127.0.0.1:4567` by default) and verifies live Mamdou connectivity + advisor response.  
It auto-detects local targets in this order: `PORT`, `6709`, `4567`.  
Override target with `AJL_JANITOR_TARGET_BASE`.
Set `AJL_JANITOR_RUNTIME_REQUIRED=1` to fail hard if runtime target is unreachable.
`qa:runtime:required` sets this automatically.

Generated reports:

```text
reports/janitor-functional.json
reports/janitor-security.json
reports/janitor-property.json
reports/janitor-hygiene.json
reports/janitor-llm.json
reports/janitor-llm-runtime.json
```

## License

MIT License. See `LICENSE`.
Provided “as is”, without warranty of any kind.

## Project Docs

- Integration contract: `CONTRACT.md`
- Contributing guide: `CONTRIBUTING.md`
- Security policy: `SECURITY.md`
