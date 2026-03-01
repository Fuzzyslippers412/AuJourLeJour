# Security Policy

## Reporting a vulnerability

If you discover a security issue, open a private report with:

- impact summary
- reproduction steps
- affected version/commit
- suggested mitigation (if available)

Do not publish exploit details before a fix is available.

## Security posture

Au Jour Le Jour is local-first and tracker-only:

- no bank connection flows
- no payment execution flows
- no analytics/tracking dependencies in core app

## Data model boundaries

- Local app stores data in SQLite.
- Web static app stores data in browser storage.
- External integrations must use the API contract (`CONTRACT.md`), not direct DB access.

## Hardening practices in this repo

- Automated QA via `npm run qa:strict` (Janitor)
- Web/local asset sync verification
- API response hardening checks (headers, validation, rate limits)
- Share token entropy and format validation checks

## Supported versions

Security fixes are applied to `main`.

