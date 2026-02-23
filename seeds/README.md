# Seeds

Seed templates live here as JSON. Use the script in `scripts/seed_templates.js` to load them.

- `monthly_expenses.json` contains user-provided monthly essentials.

Fields per template:
- `name` (required)
- `category`
- `amount_default`
- `due_day`
- `match_payee_key`
- `match_amount_tolerance`

Defaults applied by the seeder:
- `autopay: false`
- `essential: true`
- `active: true`
- `default_note: null`
