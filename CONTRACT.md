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
- `GET /api/v1/actions?limit=50&status=pending|ok|error` (action audit list)
- `GET /api/v1/actions/:id` (action audit/status lookup)

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
- In-progress duplicate action id: HTTP `409`
- Unauthorized (owner endpoints): HTTP `401`
- Rate limited (public share lookup): HTTP `429`

## Compatibility

- Contract version: `v1`
- Local app is source of truth.
- Web static app mirrors core behavior via adapter and supports the same `/api/v1/*` read/actions shape for local browser storage mode.

## Share Contract (Cross-Platform Read-Only)

Used by both web and local app when `share_base_url` is configured.

### Owner key

- Owner operations use header: `X-AJL-Share-Owner: <ownerKey>`
- `ownerKey` is returned by `POST /api/shares` and should be stored client-side.

### Endpoints

- `GET /api/shares` (owner key required): returns latest active share for owner.
- `POST /api/shares`: creates a share link and returns `shareToken`, `shareUrl`, `ownerKey`, `expires_at`.
- `PATCH /api/shares/:token`: update share (`isActive`, `mode`, `owner_label`, `expires_at`).
- `POST /api/shares/:token/regenerate`: revokes old token and returns new token/url.
- `POST /api/shares/:token/publish`: publish read-only payload (`payload.items[]` required).
- `POST /api/shares/:token/publish-current`: server builds + publishes payload from current or supplied `{year,month}`.
- `GET /api/shares/:token`: public read-only lookup (token only, rate-limited).

Viewer URL strategy:
- canonical web viewer link: `https://aujourlejour.xyz/?share=<token>`
- `/s/<token>` is also accepted and redirected to the query form on static hosting.

Expiry:
- `expires_at` is optional ISO-8601.
- if set, it must be a future timestamp.
- expired links return HTTP `410` and are automatically marked inactive.

### Share payload (published data)

```json
{
  "schema_version": "1",
  "period": "YYYY-MM",
  "owner_label": "string|null",
  "generated_at": "ISO-8601",
  "privacy": {
    "include_amounts": true,
    "include_notes": true,
    "include_categories": true
  },
  "items": [
    {
      "id": "uuid",
      "template_id": "uuid",
      "year": 2026,
      "month": 2,
      "name_snapshot": "string",
      "category_snapshot": "string|null",
      "amount": 100,
      "due_date": "YYYY-MM-DD",
      "status": "pending|partial|paid|skipped",
      "paid_date": "YYYY-MM-DD|null",
      "amount_paid": 25,
      "amount_remaining": 75,
      "essential_snapshot": true,
      "autopay_snapshot": false,
      "note": "string|null"
    }
  ],
  "categories": ["string"]
}
```

Validation limits:
- maximum items per payload: `3000`
- maximum serialized payload size: `~2 MB`
- required item fields: `id`, `name_snapshot`, `due_date`
- allowed item `status`: `pending | partial | paid | skipped`
