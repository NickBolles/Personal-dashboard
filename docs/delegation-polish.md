# Delegation and action-menu polish

## Scope and adjacent-surface audit

- `ToolStep`: shared by persisted transcript and live tool activity; `DelegateDetails` handles delegate_task spawn (including task arrays), list, steer, stop, and returned result arrays. Input and Result remain separate. Long instructions disclose progressively. Original payloads remain in redacted Raw details with copy.
- Coordinator rail, tray/sheet and area thread previously discarded tool messages. Delegate rows now reuse ToolStep under the following assistant reply, or remain below the thread until that reply arrives. Existing detail-query updates rerender those rows; this does not introduce a second run stream.
- Chat composer + menu: explicit context/reference, paperclip, camera, image/gallery and model/chip SVGs. Coordinator's supported file/camera/context menu uses the same icons. No new menu actions or control mutations.
- Shared kit Menu: optional decorative icon gutter; showcased in the existing anchored-menu gallery. Run/status/action rows already use shared SVGs/StateWord/RowAction and were left unchanged. Header overflow already has its own iconography; navigation redesign and unrelated spacing changes are out of scope.
- Parallel shared-composer/timeline extractions (#294/#295) are complementary. Preserve the icon-bearing item definitions and shared ToolStep when integrating them; do not retain two tool renderers.

## Safety and regression coverage

Never infer finished/stopped from a returned call. `queued`, `dispatched` and `interrupt_requested` stay the actual returned words. A no-live steer remains failed, with a plain explanation that it may have finished, not a claim that it did. No automatic retries or unsupported controls. React text escaping, https-only explicit result URLs and existing tool-text redaction apply to both summaries and raw payloads.

Parser table covers all actions, success/error, multi-child results, empty lists, dispatch, malformed/stringified payloads, redaction, long ids and unsafe URLs. Component tests cover failed steer, raw retention, escaping, long-input disclosure, streaming rerender and accessible icon-menu keyboard navigation. Coordinator tests cover compact and area history parity. Browser tests exercise the synthetic failed-steer acceptance case, all five menu icons, Escape, light/dark, phone/desktop and 320/412 at 200% text. Owner screenshots are private acceptance references, not committed fixture data.

Evidence (authenticated, all images inline): https://artifacts.ai.nickbolles.com/v/jarvis-delegation-icons-20261116/
