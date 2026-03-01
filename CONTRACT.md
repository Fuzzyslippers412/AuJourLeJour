# AJL Integration Contract (v1)

Au Jour Le Jour exposes a stable contract for external agents (for example MyCasaPro) through explicit read endpoints and action-based writes.

Rules:
- External systems must not read/write the SQLite file directly.
- All mutations must go through `POST /api/v1/actions`.
- IDs are stable UUID strings.
- Responses are JSON.

## Read Endpoints

- `GET /api/v1/summary?year=YYYY&month=MM&essentials_only=true|false`
- `GET /api/v1/month?year=YYYY&month=MM&essentials_only=true|false`
- `GET /api/v1/templates`

## Write Endpoint

- `POST /api/v1/actions`

### Action payload base

```json
{
  "action_id": "uuid",
  "type": "ACTION_TYPE",
  "...": "action-specific fields"
}
```

### Supported action types

- `MARK_PAID`
- `MARK_PENDING`
- `SKIP_INSTANCE`
- `ADD_PAYMENT`
- `UNDO_PAYMENT`
- `UPDATE_INSTANCE_FIELDS`
- `CREATE_TEMPLATE`
- `UPDATE_TEMPLATE`
- `ARCHIVE_TEMPLATE`
- `DELETE_TEMPLATE`
- `APPLY_TEMPLATES`
- `SET_CASH_START`
- `CREATE_FUND`
- `UPDATE_FUND`
- `ARCHIVE_FUND`
- `DELETE_FUND`
- `ADD_SINKING_EVENT`
- `MARK_FUND_PAID`
- `GENERATE_MONTH`

## Error handling

- Invalid input: HTTP `400`
- Not found: HTTP `404`
- Unauthorized (owner endpoints): HTTP `401`
- Rate limited (public share lookup): HTTP `429`

## Compatibility

- Contract version: `v1`
- Local app is source of truth.
- Web static app mirrors core behavior via adapter and supports the same `/api/v1/*` read/actions shape for local browser storage mode.
