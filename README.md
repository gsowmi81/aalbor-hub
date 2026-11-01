# Aalbor Hub

Production planning and, from Phase 2, stock control for Aalbor Kitchens, Botany. Replaces Jobman for those two jobs.

- Putting it live (Render, email, domain, backups): [docs/setup.md](docs/setup.md)
- How it's built and how to maintain it: [CLAUDE.md](CLAUDE.md)
- Approved build plan: [docs/build-plan.html](docs/build-plan.html) (phone copy: https://claude.ai/artifact/MNiU6BvSXjJ8dj8GHgw1AW)
- Build brief, 28 Oct 2026: https://claude.ai/artifact/Y6n8ZD3JvPcS8CiHcQuD88
- Approved mock-up: https://claude.ai/artifact/HBbUtp5Vc858fJDH2RnK1K

```
npm install && npm run migrate:dev && npm run dev
npm run typecheck && npm test && npm run build
```

## Suggestions API (for the Buildertrend bot)

A bot (Grokbot) compares the hub with Buildertrend each weekday and posts suggested changes. Nothing in a job changes until an Editor accepts on the **Suggestions** screen. The bot can add and read suggestions and read jobs; Postgres refuses anything else from its token.

**Token.** An owner makes one in Settings → API tokens. It is shown once; the hub keeps only its SHA-256 hash. Revoke it there too. Send it on every call:

```
Authorization: Bearer hub_…
```

Limits: 60 calls a minute per token (then `429`), 500 suggestions per POST, 2 MB body. Every call is logged (Settings → API tokens → Recent API calls).

### GET /api/jobs

Live and on-hold jobs (`?status=all` for every job) with every stage. `end_date` equals `start_date` for one-day stages. Use these values as `current_value`.

```json
{ "stages": [{ "key": "check_measure", "label": "Check measure" }, …],
  "jobs": [{ "id": 4, "job_number": "260923", "client_name": "Nicole Delaat", "suburb": "…", "status": "live",
             "door_finish": "melamine", "has_painting": false, "has_stone": true, "site_start": "2026-09-23", "notes": "",
             "stages": [{ "key": "install", "label": "Install cabinets", "start_date": "2026-11-16", "end_date": "2026-11-16",
                          "confirmed": true, "status": "not_done", "extra": false, … }] }] }
```

Stage keys: `contract_drafting`, `check_measure`, `production_drawings`, `materials_ordered`, `materials_in`, `factory`, `doors_to_painting`, `doors_back`, `delivery`, `install`, `stone_measure`, `stone_install`. Extra named steps come back with `"key": null` and can't be the subject of a suggestion.

### POST /api/suggestions

```bash
curl -X POST https://hub.aalborkitchens.com.au/api/suggestions \
  -H "Authorization: Bearer $HUB_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "batch_id": "2026-11-02-am",
    "source": "Grokbot",
    "suggestions": [
      { "job_number": "260923", "stage_key": "install", "type": "update_date", "field": "start_date",
        "current_value": "2026-11-16", "proposed_value": "2026-11-23",
        "reason": "Buildertrend has install on 23 Nov", "priority": "urgent" },
      { "job_number": "260923", "stage_key": "check_measure", "type": "tick_confirmed",
        "current_value": "false", "proposed_value": "true", "reason": "Same date in Buildertrend" },
      { "job_number": "260916", "type": "update_status", "current_value": "live", "proposed_value": "on_hold",
        "reason": "Job paused in Buildertrend", "priority": "normal" },
      { "job_number": "260916", "stage_key": "materials_in", "type": "update_status",
        "current_value": "not_done", "proposed_value": "done", "reason": "Delivery docket logged" },
      { "job_number": "261120", "type": "add_job", "priority": "normal", "reason": "Contract signed",
        "payload": { "client_name": "Jo Bloggs", "suburb": "Botany", "brand": "Aalbor", "template": "kitchen_melamine",
                     "site_start": "2026-11-20",
                     "stages": { "check_measure": { "start_date": "2026-11-24" },
                                 "install": { "start_date": "2026-12-14", "end_date": "2026-12-16" } } } },
      { "job_number": "260909", "type": "note", "proposed_value": "Change order for extra pantry shelves", "priority": "info" }
    ]
  }'
```

Reply (`201` if anything was saved, `400` if nothing was):

```json
{ "batch_id": "2026-11-02-am",
  "created": [{ "index": 0, "id": 41 }, { "index": 1, "id": 42 }, …,
              { "index": 4, "id": 45, "warnings": ["suburb kept as \"Botany\" (no street address)"] }],
  "errors":  [{ "index": 3, "job_number": "260916", "error": "Job 260916 has no Materials in stage …" }] }
```

| type | needs | `current_value` / `proposed_value` | Accepting it |
|---|---|---|---|
| `update_date` | `stage_key`, `field` = `start_date` (default) or `end_date` | `YYYY-MM-DD`, or empty for no date | sets the date and ticks the stage Confirmed. A new start keeps the stage's length if the old end would be before it. |
| `tick_confirmed` | `stage_key` | `true` / `false` | ticks or unticks Confirmed |
| `update_status` | no `stage_key` | `live`, `on_hold`, `complete`, `cancelled` | sets the job status |
| `update_status` | `stage_key` | `done` / `not_done` | ticks the stage done (or unticks it) |
| `add_job` | `payload.client_name`; job number not already in the hub | — | adds the job; stages not in `payload.stages` start with no date; given dates come in Confirmed |
| `note` | text in `proposed_value` or `reason` | — | nothing changes; it is marked accepted (read) |

- `priority`: `urgent`, `normal` (default) or `info`. `batch_id` is optional (the hub makes one); `source` defaults to the token's name.
- A newer suggestion for the same job, stage, field and type replaces an older waiting one (`superseded`, with `superseded_by`). Notes never replace each other.
- On Accept the hub checks it still shows `current_value`. If not, the suggestion is marked `failed` with the reason and nothing changes. Empty and missing count as the same.
- Street addresses, phone numbers and email addresses stay in Buildertrend: `add_job` keeps only `client_name, suburb, brand, scope, template, door_finish, has_painting, has_stone, site_start, factory_days, install_days, notes, stages`; a street address in `suburb` is cut to the suburb; phone numbers and emails in text become `[removed]`.
- One email goes to the address in Settings → Suggestions email (default design@aalborkitchens.com.au) for the first POST of each `batch_id` that has an urgent or normal suggestion. Info-only batches send nothing.

### GET /api/suggestions

`?status=pending|accepted|declined|bt_wrong|superseded|failed|all` (default all), `?since=2026-11-01T00:00:00Z` (created or decided since), `?job_number=260923`. Each row has `status`, `decided_by`, `decided_at`, `decision_note` and `failure`, so the bot can learn which Buildertrend entries Editors marked wrong (`bt_wrong`).

```bash
curl -H "Authorization: Bearer $HUB_API_TOKEN" "https://hub.aalborkitchens.com.au/api/suggestions?status=bt_wrong&since=2026-11-01"
```

Try it locally: `npm run seed:suggestions:dev` adds example suggestions (it refuses to run in production).
