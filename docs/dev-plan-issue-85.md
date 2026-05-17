# Dev Plan: Settings Panel + Actions Button Separation (#85)

## Summary

Split the gear icon into two entry points: gear opens a new Settings modal (model price table + fast multiplier editor), "Actions" text button opens the existing Actions modal. Add backend API for reading/writing settings.

## Scope

**In scope (from issue decisions):**
- Gear icon → Settings modal
- "Actions" text button → Actions modal (replaces gear for actions)
- Settings modal: model price table (editable inline), fast mode multiplier
- Built-in models (opus/sonnet/haiku) not deletable, only editable + can add new
- Move fast multiplier from hardcoded to config
- `GET /api/settings` — returns editable config (whitelist, no auth fields)
- `PUT /api/settings` — validates, writes config.json, updates in-memory config
- No restart needed after save
- Wrap info-bar buttons in `.info-bar-buttons` container (Jinglever's layout suggestion)

**Out of scope:**
- Refresh interval, retention, theme settings
- Per-model fast multiplier
- Settings as a separate tab/page

## Development Checklist

- [ ] 1. Add `fastMultiplier` to config defaults (config.js), replace hardcoded `6` in conversation-collector
- [ ] 2. Add `GET /api/settings` endpoint — returns `{ modelPrices, fastMultiplier }` (whitelist only)
- [ ] 3. Add `PUT /api/settings` endpoint — validate input, merge into config.json, update runtime config object
- [ ] 4. Frontend: create Settings modal (price table + fast multiplier input + Save/Cancel)
- [ ] 5. Frontend: change gear button to open Settings modal
- [ ] 6. Frontend: add "Actions" text button next to gear, wrap both in `.info-bar-buttons`
- [ ] 7. Frontend: Settings save calls `PUT /api/settings`, shows success/error feedback
- [ ] 8. CSS: style Settings modal table, `.info-bar-buttons` layout, "Actions" button

## Test Checklist

- [ ] Unit: `GET /api/settings` returns modelPrices + fastMultiplier, NOT auth/password
- [ ] Unit: `PUT /api/settings` writes to config.json and updates in-memory config
- [ ] Unit: `PUT /api/settings` rejects invalid input (negative prices, non-numeric, missing fields)
- [ ] Unit: `PUT /api/settings` preserves non-editable config fields (auth, port, etc.)
- [ ] Unit: fast multiplier from config is used in cost calculation (not hardcoded)
- [ ] Regression: existing tests still pass (96 tests)
- [ ] Manual: gear opens Settings, "Actions" opens Actions
- [ ] Manual: edit a price, save, verify new cost calculations use updated price
- [ ] Manual: add a new model entry, save, verify it persists
- [ ] Manual: cannot delete built-in models

## Acceptance Checklist

- [ ] Gear icon opens Settings modal with correct price data
- [ ] "Actions" button opens Actions modal (unchanged behavior)
- [ ] Price table shows all models with editable fields
- [ ] Save writes to config.json and takes effect immediately (no restart)
- [ ] Built-in models cannot be deleted
- [ ] New models can be added
- [ ] Fast multiplier is editable
- [ ] No auth/sensitive fields exposed in Settings API
- [ ] Browser screenshot: Settings modal with price table
- [ ] Browser screenshot: Info bar with both buttons
- [ ] `npm test` passes
- [ ] No regressions in Cost card data
