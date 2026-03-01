# MyCasa Pro Integration Notes (Mamadou / Finance)

These notes are based on a read-only review of a local `mycasa-pro` workspace. No changes were made to MyCasa Pro.

## Observed Agent System (MyCasa Pro)

- **Agent registry + naming**
  - `core/fleet_manager.py` defines default agents.
  - Finance agent id: `finance`
  - Finance agent name/label: **Mamadou** (note spelling)
- **Agent prompts/persona**
  - `core/llm.py` and `core/agent_prompts.py` define the Finance persona and system prompt.
- **Agent skills list**
  - `core/agent_skills.py` exposes the skill list shown for each agent.
- **Frontend agent labels/aliases**
  - `frontend/src/components/GlobalChat.tsx` contains:
    - `AGENT_NAMES` map (Finance → Mamadou)
    - `AGENT_ALIASES` map (includes `"mamadou"`)
    - `agentThemeFor(...)` for UI color labels
- **Finance agent implementation**
  - `agents/finance.py` is the Finance agent class; it already loads portfolio, budgets, bills, etc.
- **Agent entrypoints / chat**
  - `backend/api/main.py` has endpoints like:
    - `POST /api/agents/{agent_id}/chat`
    - `POST /agents/{agent_id}/execute`
  - Fleet endpoints are in `api/routes/fleet.py`

## What to Add on the MyCasa Pro Side (No Edits Done Here)

**1) Add AJL as a Finance skill**
- Update `core/agent_skills.py` to include an **“Essentials Ledger (AJL)”** capability under the `finance` skills list.

**2) Update Finance prompt to mention AJL**
- Add a short block in `core/agent_prompts.py` and/or `core/llm.py` for Finance:
  - “You can read the Essentials Ledger via AJL endpoints and propose actions, but never write to AJL without explicit user confirmation.”

**3) Optional alias tweak for naming alignment**
- AJL uses **Mamdou** in UI (per user instruction), while MyCasa uses **Mamadou**.
- If you want exact naming alignment in MyCasa UI:
  - Add `"mamdou"` to `AGENT_ALIASES.finance` in `frontend/src/components/GlobalChat.tsx`
  - Or change the visible name to “Mamdou” in `AGENT_NAMES` (optional)

**4) Add a small AJL connector or skill module**
Suggested pattern (similar to `backend/skills/polymarket_btc_15m/skill_interface.py`):
- New module, e.g. `backend/skills/au_jour_le_jour/skill_interface.py`
- Use AJL API base URL (env/config) and call:
  - `GET /api/v1/summary?year=YYYY&month=MM`
  - `GET /api/v1/month?year=YYYY&month=MM`
  - `GET /api/v1/templates`
  - `POST /api/v1/actions` (only with explicit confirmation)

**5) Add configuration**
- Store AJL base URL in MyCasa settings or env (e.g., `AJL_BASE_URL=http://localhost:6709` or `AJL_BASE_URL=https://aujourlejour.xyz`)
- Optionally include auth/token if you decide to add one later (AJL currently local-only)

## AJL Contract Reminder (for MyCasa integration)

AJL enforces a stable contract (local API):
- Summary: `GET /api/v1/summary?year=YYYY&month=MM&essentials_only=true`
- Month items: `GET /api/v1/month?year=YYYY&month=MM&essentials_only=true`
- Templates: `GET /api/v1/templates`
- Actions: `POST /api/v1/actions`

All AJL writes must be **explicit action calls**. No direct DB access.

---

If you want, I can also add a short “integration-ready” section in AJL `README.md` to point MyCasa developers to the exact endpoints.
