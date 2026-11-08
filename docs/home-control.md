# Home Assistant control policy

Owner decision, 2026-11-07: "Yes Jarvis should be able to modify garage door and home assistant devices."

Jarvis can operate Home Assistant devices from the House page, the smart garage card and (as proposals only) from agents. The rules live in one pure module, `lib/ha-policy.ts`, that both the server and the UI use.

## What can be called

| Domain                | Services                                                               | Risk                                   | Undo                                           |
| --------------------- | ---------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------- |
| `light`               | `turn_on` (+ `brightness_pct`), `turn_off`, `toggle`                   | low                                    | on↔off, previous brightness                    |
| `switch`              | `turn_on`, `turn_off`, `toggle`                                        | standard                               | on↔off                                         |
| `input_boolean`       | `turn_on`, `turn_off`, `toggle`                                        | low                                    | on↔off                                         |
| `fan`                 | `turn_on`, `turn_off`, `set_percentage`                                | low                                    | on↔off, previous speed                         |
| `climate`             | `set_temperature`, `set_hvac_mode`                                     | standard                               | previous target / mode                         |
| `media_player`        | `media_play`, `media_pause`, `media_stop`, `volume_set`, `turn_on/off` | low                                    | play↔pause, previous volume, on↔off            |
| `scene`, `script`     | `turn_on`                                                              | standard                               | none                                           |
| `vacuum`              | `start`, `return_to_base`                                              | low                                    | none                                           |
| `cover`               | `open_cover`, `close_cover`, `stop_cover`                              | standard; **opening a garage is high** | open↔close (garage Close/Open are mutual Undo) |
| `lock`                | `lock`, `unlock` (`open` = unlatch, opt-in only)                       | **high**                               | lock↔unlock                                    |
| `alarm_control_panel` | `alarm_arm_home`, `alarm_arm_away`, `alarm_arm_night`, `alarm_disarm`  | **high**                               | disarm → previous armed mode; arm → disarm     |

Nothing outside this table can run, whatever the allowlist says.

## Allowlist

The Settings → Connections → Home Assistant **Allowed controls** field accepts `entity_id: service, …` and `domain.*: service, …`. Its default (`HA_DEFAULT_CONTROLS`) is a wildcard line per domain above with all its services except `lock.open`. A stored value replaces the default, so the owner can narrow it (or re-add `lock.open`) without a deploy. Light switching keeps its own setting (all / allowlisted / view only).

## Rules for every write

- **Confirmed**: a low-risk tile tap is the confirmation (it runs at once and offers Undo); standard and high-risk actions open the confirm card first. Door controls, the garage card and agent proposals always use the confirm card.
- **Live state**: the request carries the state token the person saw; if Home Assistant reports something else, nothing is sent (409).
- **Readback**: success is reported only after Home Assistant reads back the expected state (or attribute: brightness, temperature, speed, volume). Scenes and scripts have no state, so the accepted call is the confirmation.
- **Undo**: the response carries the inverse call (`undo`) when one exists. Undo goes through the same rules (an Undo that is high-risk shows the confirm card again).
- **Never queued**: controls are disabled offline.
- **Audited**: every attempt writes `audit_log` `ha.<service>` (pending/ok/rejected/error, with risk).

## High-risk actions (locks, alarm, opening a garage)

- The confirm card names the device and its current state and needs an explicit tick ("I mean it: unlock Front door lock (now locked)") before the button enables; the server refuses without `highRiskConfirmed`.
- Rate-limited: 6 per 10 minutes per person (plus 60 device writes per minute overall).
- A shared household tablet may open and close a garage and lock and unlock a door (owner decision 2026-11-07), and arm the alarm, always through the same confirm card, readback, audit and rate limit. Disarming the alarm and a lock's Open (unlatch) stay blocked on the tablet: sign in as yourself.
- Never "low-risk" for autonomy, never executed by scheduled jobs or agents.

## Agents and scheduled jobs

`executeControl` refuses any call running as an agent or job (`withVia("agent:…" | "job:…" | "schedule:…")`). Agents use the MCP tool `jarvis_propose_device_change` (scope `decisions.write`): Jarvis validates the proposal against the policy and allowlist (no Home Assistant call) and raises a Needs-you decision on the item with a House link (`/home-control?entity=<id>&propose=<service>[&data=<json>]`). Opening the link shows the confirm card; nothing runs until the owner confirms. Scheduled jobs may only propose the `device_control` intent, which always becomes a decision.

## Tests

`test/ha-policy.test.ts` (matrix per domain, Undo mapping, gating, service data), `test/integration.test.ts` and `test/home-devices.test.ts` (mock HA: readback, Undo, rate limit, tablet), `test/ha-agent-proposals.test.ts` (MCP proposal → decision, agents refused), `e2e/home-control.spec.ts` (light + Undo, garage Open/Close, lock explicit confirm, agent proposal → confirm card). Tests and development only ever talk to the mock Home Assistant (`mock-upstreams/home-assistant.mjs`).
