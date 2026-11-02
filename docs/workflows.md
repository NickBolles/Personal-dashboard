# Workflows

A workflow is a reusable, named way of working with Jarvis: its own instructions, a capture shape, start/mid/end forms with
smart defaults, routing (area, agent profile, model tier) and triggers (`/slug` in the palette, share, area page, schedule).
W1 ships the definition format, validation, the gallery (`/workflows`), import/export and starting a workflow from the
palette. The run screen, form sheets and outputs land in W2–W4 (spec: `jarvis-workflows-spec.md`).

## Where things live

| Piece                     | Path                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format + validation (zod) | `lib/workflows/definition.ts` (`definitionSchema`, `validateDefinition`, `canonicalDefinition`)                                                       |
| Parsers                   | `lib/workflows/scripture.ts`, `lib/workflows/smart-dates.ts`, `lib/workflows/palette-args.ts`                                                         |
| Example fixture           | `lib/workflows/fixtures/teaching-notes.json`                                                                                                          |
| Store / start / HTTP      | `server/workflows/{store,start,http}.ts`                                                                                                              |
| Tables (migration 0026)   | `workflows`, `workflow_versions`, `saved_places`, `remembered_field_values`                                                                           |
| API                       | `GET/POST /api/workflows`, `GET/PUT/PATCH /api/workflows/:id`, `POST /api/workflows/import`, `GET /api/workflows/export`, `POST /api/workflows/start` |
| UI                        | `app/(shell)/workflows` + `components/workflows/WorkflowsGallery.tsx`; palette row in `SearchDialog`                                                  |

All routes need `work.use`; `start` also needs `hermes.chat`. Every write is per user and audited, and each change stores a
new row in `workflow_versions`.

## Definition format (`jarvis-workflow@1`)

A definition is a JSON object, at most 32 KB. Unknown keys are rejected (every object is `strict`).

| Key                  | Required | Notes                                                                                                                                                                                                                              |
| -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`             | yes      | Always `"jarvis-workflow@1"`.                                                                                                                                                                                                      |
| `name`               | yes      | ≤ 60 chars.                                                                                                                                                                                                                        |
| `slug`               | yes      | Lowercase id, also the palette command (`/slug`).                                                                                                                                                                                  |
| `icon`               | yes      | One of `WORKFLOW_ICONS` (`book-open`, `notebook`, `list-checks`, `calendar`, …).                                                                                                                                                   |
| `hue`, `description` | no       | Card accent token; description ≤ 280 chars.                                                                                                                                                                                        |
| `routing`            | yes      | `{ area: "Faith" \| null, agentProfile?: string \| null, modelTier: "fast" \| "standard" \| "deep" }`. The area is matched by exact path; an unknown area falls back to Miscellaneous. Finance and AI-excluded areas are refused.  |
| `instructions`       | yes      | ≤ 4000 chars, sent with every run started from the workflow.                                                                                                                                                                       |
| `serviceTimes`       | no       | `HH:MM` list used by the `$serviceTime` default (D12 default 09:00 / 10:45).                                                                                                                                                       |
| `defaultPlace`       | no       | Used by the `workflowPlace` default of a `place` field.                                                                                                                                                                            |
| `capture`            | yes      | Named capture fields (≤ 40): a scalar type (`text`, `longtext`, `date`, `datetime`, `time`, `number`, `bool`, `scripture_ref`, `place`, `person`, `tags`; `?` = optional), `{ type: "object", fields }` or `{ type: "list", of }`. |
| `start`              | no       | `{ prompt?, args? }`: chat title template and the positional palette args (field ids).                                                                                                                                             |
| `forms`              | no       | `start` / `mid` / `end` forms: `{ title?, submit?, fields: [field \| "fieldId"], skipWhenComplete? }` (≤ 20 fields; mid/end can reuse start fields by id).                                                                         |
| `quickAdd`           | no       | ≤ 8 `{ label, field, prefix? }` chips; `field` must be a list capture.                                                                                                                                                             |
| `outputs`            | no       | `item` (`none`/`perRun`/`single`), `summary.instructions`, `exports` (`markdown`, `drive`, `items`).                                                                                                                               |
| `triggers`           | no       | `palette` (`command` must be `/<slug>`), `share`, `areaPage`, `schedule` (`cron` + `remind`/`start`).                                                                                                                              |
| `reflectionPrompts`  | no       | `off`, `onRequest`, `afterPoints`.                                                                                                                                                                                                 |
| `policy`             | no       | Fixed in v1: `{ settle: "manual", aiContext: "workflow_only" }`.                                                                                                                                                                   |

### Form fields

`{ id, bind, type, label, … }` where `type` is one of `text`, `longtext`, `select`, `chips`, `date`, `time`, `datetime`,
`place`, `person`, `scripture`, `tags`, `number`, `toggle`. `bind` is a capture path (`session.speaker`) or a list append
(`quotes/-`) and must exist in `capture`. Optional keys: `required`, `rememberLast`, `default` (`{ source: "last" |
"workflowPlace" | "$today" | "$now" | "$tomorrow" | "$nextSunday" | "$serviceTime", fallback? }`), `suggest`, `options`
(required for `select`/`chips`), `allowNew`, `geolocate: "matchSaved"`, `allowRange` / `mustParse` (scripture),
`min`/`max`/`step`/`unit`, `minLength`/`maxLength`, `pattern` (`email`, `slug`, `hhmm`), `dateRange`, `quick`
(`today`, `nextSunday`, `serviceTime`, `tomorrow`).

### Validation errors

`validateDefinition` returns `{ ok: false, issues: [{ path, code, message }] }` with codes such as `not_json`,
`too_large`, `invalid` (schema), `too_many_fields`, `finance_excluded`, `duplicate_field`, `bind_unknown_path`,
`unknown_field`, `options_required`, `bad_length`, `too_long`, `command_mismatch`, `layout_invalid`. Import shows them
per path and saves nothing.

## Example

A minimal workflow (the full Teaching notes example is `lib/workflows/fixtures/teaching-notes.json`):

```json
{
  "format": "jarvis-workflow@1",
  "name": "Standup notes",
  "slug": "standup",
  "icon": "list-checks",
  "routing": { "area": null, "modelTier": "fast" },
  "instructions": "Keep my standup notes as Yesterday / Today / Blockers. Don't add commentary.",
  "capture": {
    "session": { "type": "object", "fields": { "team": "text", "when": "datetime" } },
    "blockers": { "type": "list", "of": "text" }
  },
  "start": { "prompt": "Standup – {session.team}", "args": ["team"] },
  "forms": {
    "start": {
      "title": "New standup",
      "fields": [
        { "id": "team", "bind": "session.team", "type": "text", "label": "Team", "required": true, "rememberLast": true },
        { "id": "when", "bind": "session.when", "type": "datetime", "label": "When", "default": { "source": "$now" } }
      ]
    }
  },
  "quickAdd": [{ "label": "Blocker", "field": "blockers" }],
  "triggers": [{ "kind": "palette", "command": "/standup" }]
}
```

Import it from the gallery (**Import JSON** → pick the file; it arrives as a draft), press **Turn on**, then type `/standup Platform` in the
palette (Ctrl K): Jarvis starts a chat titled "Standup – Platform" with the workflow's instructions attached.

## Known W1 limits

- Import has no Undo; archive the workflow instead (#116).
- Area resolution is by exact path; there is no remap screen yet (#117).
- `saved_places` and `remembered_field_values` had tables but no API — added in W2 (#118, below).
- Palette start sends the instructions as run context (≤ 4000 chars), not as a session system prompt (#119).

## Runs (W2)

Starting a workflow from the palette (`/slug args`) opens its **start form** (always shown, prefilled, one tap Start — D7).
Defaults resolve server-side in the owner's timezone, in this order: palette arg ("From /slug") → remembered last value
("Last used"; on by default for person/place/select fields — D11) → literal / smart date (`$today`, `$nextSunday`,
`$serviceTime` = the workflow's `serviceTimes`, default Sunday 09:00 and 10:45 — D12) / workflow default place → empty.
The form is compiled from the definition into the closed `jarvis-ui@1.1` form parts (`lib/workflows/run-catalog.ts`:
Form, TextField, LongTextField, ChoiceField, DateTimeField, PlaceField, PersonField, ScriptureField, TagsField,
NumberField, ToggleField) — never authored by the model.

Submitting creates a `workflow_runs` row (migration 0027): pinned version, Hermes conversation id, optional work item,
`capture` (current state, ≤ 256 KB), `capture_log` (every change + its inverse op) and `proposals`.

**Place field (D9).** Options: workflow default place, saved places, recent places, typed text. _Use my location_ asks
the browser only on that tap and compares the position with **saved** places on the device (haversine, per-place radius,
default 300 m); the position is discarded and never sent to the server, the model, logs or analytics. No reverse
geocoding, no third-party API. Hidden when Settings → AI → Captures _strip location_ is on (then saved places keep no
coordinates either). Only the chosen label is stored.

**Agent capture (`jarvis-capture@1`, D2).** The run context tells the agent which capture paths exist. Each reply may
carry a fenced ` ```jarvis-capture ` block: a JSON list of `{op: add|replace|remove, path, value}`, or
`{propose: true, ops}` for form fields. The server validates every op against the pinned schema (declared paths only,
typed values, place values may not carry coordinates, ≤ 40 ops per turn) and applies them instantly with Undo; invalid
ops are dropped ("1 note not filed"). Proposed form values wait for Accept. Each assistant turn is read once.
Quick-add chips (Scripture · Point · Quote · Reflection …) file the next message straight into that section without the model.

**Run panel.** Header (live dot, title, Undo, **End session**), quick-add chips and the live outline over the capture
lists (remove = undoable). On phones the open keyboard collapses it to a one-line strip (section counts + last two
entries) above the composer (`html[data-kb=open]`, `lib/client/keyboard.ts`). End session never settles anything;
summary/exports are W4.

API (all owner-scoped, audited): `POST /api/workflows/form` · `GET|POST /api/workflows/runs` (`?conversationId=`) ·
`GET|PATCH /api/workflows/runs/:id` · `POST …/undo` · `POST …/proposals` · `POST …/end` · `GET|POST /api/workflows/places`
· `DELETE /api/workflows/places/:id` · `GET|DELETE /api/workflows/:id/remembered[?field=]` (forget remembered values).

Instructions still ride as run context (≤ 4000 chars) rather than a session system prompt (#119).
