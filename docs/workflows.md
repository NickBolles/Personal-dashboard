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
- `saved_places` and `remembered_field_values` have tables but no API until W2 (#118).
- Palette start sends the instructions as run context (≤ 4000 chars), not as a session system prompt (#119).
