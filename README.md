# Au Jour Le Jour

Private bill tracker. Generates a clear monthly checklist and lets you mark items done. No bank connections.

Web app: [aujourlejour.xyz](https://aujourlejour.xyz)  
Repo: [github.com/Fuzzyslippers412/AuJourLeJour](https://github.com/Fuzzyslippers412/AuJourLeJour)

Tracker only: you pay outside the app.

## What It Does

- Generates monthly instances from templates
- Tracks status: pending, partial, done, skipped
- Due soon / overdue queues + monthly summary
- Sinking funds (non‑monthly obligations)
- Export/import (JSON + CSV)

## Web vs Local

| Capability | Web (static) | Local (SQLite) |
|---|---|---|
| Storage | Browser storage (device‑specific) | SQLite file |
| Assistant (Mamdou) | Not available | Available |
| Offline | Browser‑dependent | Always |
| Backups | Export/import | Export/import + SQLite file |
| Sharing | Read‑only preview only | Full local share flow |
| Reliability | Depends on browser storage | Highest |

## Install (Local CLI)

```sh
git clone https://github.com/Fuzzyslippers412/AuJourLeJour.git
cd AuJourLeJour
npm install
PORT=4567 npm start
```

You can use any port via `PORT=XXXX`.  
Open `http://localhost:PORT` or `http://<your-ip>:PORT` on your LAN.

Alternative (auto‑install deps, defaults to `PORT=6709`):

```sh
PORT=4567 ./start.sh
```

## Web Version

The web build is static and runs in your browser at [aujourlejour.xyz](https://aujourlejour.xyz).
Data lives only in your browser storage, so export backups regularly.

## Data & Backups

Local SQLite path: `data/au_jour_le_jour.sqlite`  
Daily backup: `data/backups/au_jour_le_jour_YYYY-MM-DD.sqlite`

Use **Backup/Export** to export/import JSON or CSV.

## Integration (MyCasaPro)

AJL is a standalone ledger designed to integrate with the MyCasaPro Finance Agent later.
Integration must use the contract endpoints (no direct DB access).

V1 endpoints:
- `GET /api/v1/summary?year=YYYY&month=MM&essentials_only=true`
- `GET /api/v1/month?year=YYYY&month=MM&essentials_only=true`
- `GET /api/v1/templates`
- `POST /api/v1/actions`

## QA (Janitor)

Run the automated suite:

```sh
npm run janitor
```

## License

MIT License. See `LICENSE` for the full text.
This software is provided “as is”, without warranty of any kind.
