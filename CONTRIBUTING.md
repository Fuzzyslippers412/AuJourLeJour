# Contributing

Thanks for contributing to Au Jour Le Jour.

## Setup

```sh
git clone https://github.com/Fuzzyslippers412/AuJourLeJour.git
cd AuJourLeJour
npm install
```

Run local app:

```sh
PORT=4567 npm start
```

## Required checks before PR

Run full QA:

```sh
npm run qa
```

Run strict non-mutating QA (CI equivalent):

```sh
npm run qa:strict
```

## Web/docs sync rules

`docs/` is the web build for GitHub Pages.

- Source of truth:
  - `public/app.js`
  - `public/styles.css`
  - `public/index.html`
- Sync command:

```sh
npm run sync:web
```

If you modify `public/*`, run `npm run sync:web` before commit.

## Contract safety

Do not introduce breaking changes to:

- `GET /api/v1/summary`
- `GET /api/v1/month`
- `GET /api/v1/templates`
- `POST /api/v1/actions`

If a schema change is required:

- document it in `CONTRACT.md`
- preserve backward compatibility where possible
- add Janitor coverage

## Tracker-only language

The product is a tracker. It does not execute payments.

Avoid user-facing copy that implies account access or payment execution.

