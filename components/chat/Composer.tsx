"use client";

/**
 * The one message composer. The chat page and the Chief of staff (rail, phone sheet, area pane) both write here, so
 * `@` context, `#` pull requests, `/` commands, the model, drafts that survive a reload, a retry that never runs
 * twice, steering a run in flight and the compact row while an approval waits all behave the same wherever the
 * owner is typing.
 *
 * What differs per surface comes in through slots, never forks:
 * - `tray`: the status strip over the field (the chat page's "In this chat" line)
 * - `scope`: what the next message is about (the Chief of staff's D-n / R-n chip)
 * - `lead`: what rides along with it (the "Viewing: …" page context)
 * - `accessory`: shortcuts that fill the field (quick-action chips)
 * - `footer`: the surface's own row under the field
 *
 * The composer knows nothing about where a message goes: it hands the text and an idempotency key to `onSend`
 * (or the text to `onSteer` while a run is in flight) and clears itself when that resolves true.
 */
import { useEffect, useId, useImperativeHandle, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react";
import { newIdempotencyKey } from "@/lib/client/api";
import { kvDel, kvGet, kvSet } from "@/lib/client/idb";
import { isTerminal, type RunPhase } from "@/lib/hermes";
import { Button, ChipButton, Menu, Textarea, cx, useToast, type KMenuItem } from "@/components/ui";
import { PlusIcon, StopIcon } from "@/components/icons";
import { useModKey } from "@/lib/client/platform";
import { composerKey, isSendShortcut, SEND_KEYSHORTCUTS, sendHint } from "@/lib/client/composer-keys";
import { displayRef, encodeMessage, triggerAt, type CommandId, type Reference, type Trigger } from "@/lib/references";
import type { AgentResolution } from "@/lib/agents";
import { AgentChip } from "@/components/agents/AgentChip";
import { AttachButton, AttachmentChips, CameraButton, pastedFiles, type ChatAttachments } from "./Attachments";
import { TriggerPopover, useTriggerRows, type PickerRow } from "./ComposerPicker";
import "./composer.css";

/** The profile was asked for but another one answers (routing off, no route, missing key…): worth saying next to the composer. */
const agentNeedsNote = (agent: AgentResolution | null | undefined): agent is AgentResolution => !!agent && !agent.routed && !!agent.requested;

export type ComposerHandle = {
  focus: (caretAtEnd?: boolean) => void;
};

export type ComposerProps = {
  /** page: the chat page's dock, above the bottom bar. panel: inside the Chief of staff rail, sheet or an area pane. */
  surface: "page" | "panel";
  /** The conversation the draft and the retry key are kept under (on this device). null keeps nothing. */
  sessionId: string | null;
  /** The text, when the host writes into the composer itself (a quick action, "Ask about this page"). */
  text?: string;
  onText?: (text: string) => void;
  /** Who answers: "@profile", "Claude" or the assistant's name. */
  answerer: string;
  /** Says what the field is for when a `scope` changes it ("Steer R-3…"). */
  placeholder?: string;
  phase?: RunPhase;
  /** A clarify question is waiting: keep the composer one compact row, as for an approval (#185). */
  clarifying?: boolean;
  online: boolean;

  tray?: ReactNode;
  /** "Jump to latest", anchored to the dock so it always clears the composer. */
  jump?: ReactNode;
  scope?: ReactNode;
  lead?: ReactNode;
  accessory?: ReactNode;
  footer?: ReactNode;

  context: { label: string; ref: string }[];
  onRemoveContext: (ref: string) => void;
  /** Opens the context sheet (areas, items, people). */
  onAttach: () => void;
  attachments: ChatAttachments;

  /** Sends a new message. Resolves true once Hermes accepted it; the composer then clears. */
  onSend: (text: string, key: string) => Promise<boolean>;
  /** Adds guidance to the run in flight. Without it nothing can be sent while a run is going. */
  onSteer?: (text: string) => Promise<boolean>;
  onStop?: () => void;
  /** Runs a `/` command. Without it the field has no commands. */
  onCommand?: (id: CommandId) => void;
  /** The area's default repo (the `#` picker's scope). */
  repo: string | null;
  modelLabel?: string;
  onModel?: () => void;
  /** Composer focused: the surface scrolls the conversation to the latest message. */
  onFocus?: () => void;
  /** Who answers (Settings → Agents); shown when it has news. */
  agent?: AgentResolution | null;
  /** A send that failed elsewhere, put back with its key so the retry never runs twice. */
  restore?: { text: string; key: string; at: number };

  /** The scope can be sent with no words (Retry). */
  sendsEmpty?: boolean;
  /** Backspace in the empty field: the surface removes its scope chip. */
  onEmptyBackspace?: () => void;
  /** Names the send control when a send means something else ("Confirm answer"). */
  sendLabel?: string;
  /** Names the field when the surface knows better than "Message …" / "Guidance for the current run". */
  label?: string;
  /**
   * Asked, synchronously, before every send. False keeps the words and sends nothing: a send the surface wants
   * confirmed first (a risky answer arms on the first press) or cannot take yet.
   */
  canSend?: (text: string) => boolean;
  /** Prefix of the idempotency key, so the server's logs say which surface sent it. */
  keyPrefix?: string;
  /** The surface is busy sending through a path of its own (a control command, a recorded answer). */
  sending?: boolean;

  inputId?: string;
  /** The send control is not the view's primary action (another one is showing). */
  quietSend?: boolean;
  /** The `/` commands this surface can run. Without `onCommand` there are none. */
  commands?: readonly CommandId[];
  /**
   * Test ids. Two composers can be on one page (the chat page and the Chief of staff rail), so a panel names its
   * own; the defaults are the chat page's.
   */
  testIds?: { input?: string; send?: string; add?: string; file?: string; camera?: string; library?: string };
  ref?: Ref<ComposerHandle>;
};

export function Composer({
  surface,
  sessionId,
  text: hostText,
  onText,
  answerer,
  placeholder: placeholderProp,
  phase,
  clarifying,
  online,
  tray,
  jump,
  scope,
  lead,
  accessory,
  footer,
  context,
  onRemoveContext,
  onAttach,
  attachments,
  onSend,
  onSteer,
  onStop,
  onCommand,
  repo: areaRepo,
  modelLabel,
  onModel,
  onFocus,
  agent,
  restore,
  sendsEmpty,
  onEmptyBackspace,
  sendLabel,
  label,
  canSend,
  keyPrefix = "run",
  sending,
  inputId,
  quietSend,
  commands,
  testIds,
  ref,
}: ComposerProps) {
  const { toast } = useToast();
  const [ownText, setOwnText] = useState("");
  const text = hostText ?? ownText;
  const setText = onText ?? setOwnText;
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const pendingKey = useRef<string | undefined>(undefined);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const cameraInput = useRef<HTMLInputElement | null>(null);
  const autoId = useId();
  const fieldId = inputId ?? `${autoId}-field`;
  const listId = `${autoId}-picker`;
  const running = phase !== undefined && !isTerminal(phase);
  const canSteer = phase === "running" && !!onSteer;
  useImperativeHandle(ref, () => ({
    focus: (caretAtEnd) => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      if (caretAtEnd) el.setSelectionRange(el.value.length, el.value.length);
    },
  }));

  // @ / # / picker state: the trigger at the caret, the highlighted row, picked references.
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<Reference[]>([]);
  const [repo, setRepo] = useState<string | null>(areaRepo);
  const [seenRepo, setSeenRepo] = useState(areaRepo);
  if (areaRepo !== seenRepo) {
    setSeenRepo(areaRepo);
    setRepo(areaRepo);
  }
  const [seenRestore, setSeenRestore] = useState(restore);
  if (restore !== seenRestore) {
    setSeenRestore(restore);
    if (restore) setText(restore.text);
  }
  // Retry with the same key: if the first send did reach Hermes, it isn't run twice.
  useEffect(() => {
    if (restore) pendingKey.current = restore.key;
  }, [restore]);
  const found = useTriggerRows(trigger, repo);
  const { loading, partial, searched } = found;
  const rows = commands ? found.rows.filter((r) => r.row.kind !== "command" || commands.includes(r.row.id)) : found.rows;
  const activeIdx = Math.min(active, Math.max(0, rows.length - 1));

  // Drafts persist per conversation across refresh/navigation. What the host already wrote into the field (a quick
  // action that opened the panel) is newer than a stored draft and is kept.
  const latest = useRef({ text, setText });
  useEffect(() => {
    latest.current = { text, setText };
  });
  useEffect(() => {
    pendingKey.current = undefined;
    if (!sessionId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- no conversation yet: nothing stored to wait for
      setLoaded(true);
      return;
    }
    let stale = false;
    setLoaded(false);
    void Promise.all([kvGet<string>(`draft:${sessionId}`), kvGet<{ input: string; key: string }>(`pending:${sessionId}`)]).then(([draft, pending]) => {
      if (stale) return;
      const typed = latest.current.text;
      if (pending) {
        if (!typed || typed === pending.input) {
          latest.current.setText(pending.input);
          pendingKey.current = pending.key; // retry with the same idempotency key
        }
      } else if (!typed) latest.current.setText(draft ?? "");
      setLoaded(true);
    });
    return () => {
      stale = true;
    };
  }, [sessionId]);
  useEffect(() => {
    if (!loaded || !sessionId) return;
    const t = setTimeout(() => (text ? kvSet(`draft:${sessionId}`, text) : kvDel(`draft:${sessionId}`)), 200);
    return () => clearTimeout(t);
  }, [text, sessionId, loaded]);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);
  const mod = useModKey();

  const syncTrigger = (value: string, caret: number) => {
    const found = triggerAt(value, caret);
    // Without a command handler the surface has no commands: "/" is just a character there.
    const t = found?.sigil === "/" && !onCommand ? null : found;
    setTrigger(t);
    if (!t || t.sigil !== trigger?.sigil || t.query !== trigger?.query) setActive(0);
  };

  const replaceTrigger = (insert: string) => {
    if (!trigger) return;
    const next = text.slice(0, trigger.start) + insert + text.slice(trigger.end);
    setText(next);
    setTrigger(null);
    const caret = trigger.start + insert.length;
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(caret, caret);
    });
  };

  const pick = (row: PickerRow) => {
    if (!trigger) return;
    if (row.kind === "command") {
      replaceTrigger("");
      onCommand?.(row.id);
      return;
    }
    if (row.kind === "ref") {
      const r: Reference = { type: row.option.type, id: row.option.id, label: row.option.label };
      setPicked((p) => (p.some((x) => x.type === r.type && x.id === r.id) ? p : [...p, r]));
      replaceTrigger(`${displayRef(r)} `);
    }
  };

  const filterTo = (type: string) => {
    if (!trigger) return;
    const q = trigger.query.replace(/^[a-z]+:/i, "");
    const insert = `@${type}:${q}`;
    const next = text.slice(0, trigger.start) + insert + text.slice(trigger.end);
    setText(next);
    const caret = trigger.start + insert.length;
    setTrigger({ sigil: "@", query: `${type}:${q}`, start: trigger.start, end: caret });
    setActive(0);
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(caret, caret);
    });
  };

  const submit = async () => {
    const typed = text.trim();
    const hasFiles = attachments.drafts.length > 0;
    if ((!typed && !hasFiles && !sendsEmpty) || busy || sending || !online) return;
    if (attachments.uploading) {
      toast("Wait for the attachments to finish uploading", "danger");
      return;
    }
    if (hasFiles && running) {
      toast("Attachments go with a new message — wait for this reply to finish", "danger");
      return;
    }
    const input = typed || (hasFiles ? (attachments.drafts.some((d) => d.kind === "image") ? "What do you see in this?" : "Here's the attached file.") : "");
    // A bare command typed in full ("/fork") runs instead of sending.
    const cmd = input.match(/^\/([a-z]+)$/i)?.[1]?.toLowerCase();
    if (onCommand && cmd && rows.some((r) => r.row.kind === "command" && r.row.id === cmd)) {
      setText("");
      setTrigger(null);
      onCommand(cmd as CommandId);
      return;
    }
    const encoded = encodeMessage(input, picked).text;
    if (canSend && !canSend(encoded)) return;
    setBusy(true);
    let ok: boolean;
    if (running) {
      ok = canSteer ? await onSteer!(encoded) : false;
    } else {
      const key = pendingKey.current ?? newIdempotencyKey(keyPrefix);
      pendingKey.current = key;
      ok = await onSend(encoded, key);
      if (ok) pendingKey.current = undefined;
    }
    if (ok) {
      setText("");
      setPicked([]);
      setTrigger(null);
      if (sessionId) await kvDel(`draft:${sessionId}`);
    }
    setBusy(false);
  };

  const awaitingApproval = phase === "waiting_for_approval";
  // #185: an approval or clarify card needs the screen; at 320 px / 200 % text a stacked composer covers its buttons.
  const compact = awaitingApproval || !!clarifying;
  const placeholder = !online
    ? "Offline — drafts are saved, not sent"
    : awaitingApproval
      ? "Approve or deny first"
      : (placeholderProp ?? (running ? "Add guidance…" : `Message ${answerer}…`));
  const open = !!trigger && (rows.length > 0 || loading || trigger.sigil !== "@" || trigger.query.length > 0);
  const nothingToSend = !text.trim() && !attachments.readyIds.length && !sendsEmpty;
  const sendName = sendLabel ?? (running ? "Send guidance" : "Send");

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (open && rows.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % rows.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + rows.length) % rows.length);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        pick(rows[activeIdx]!.row);
        return;
      }
    }
    if (open && e.key === "Escape") {
      e.preventDefault();
      setTrigger(null);
      return;
    }
    // Enter is a newline (phone and desktop); Ctrl/⌘ + Enter or the Send button sends.
    if (isSendShortcut(composerKey(e))) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape" && running && onStop) {
      e.preventDefault();
      onStop();
    } else if (e.key === "Backspace" && !text && onEmptyBackspace) {
      e.preventDefault();
      onEmptyBackspace();
    }
  };

  return (
    <div
      className={cx(
        "cmp",
        surface === "page"
          ? "chat-dock safe-bottom sticky z-20 border-t border-line bg-bg px-2 py-1.5 sm:bg-bg/95 sm:px-6 sm:py-2 sm:backdrop-blur"
          : "cmp-panel",
      )}
      data-surface={surface}
    >
      {jump}
      {/* While an approval or a question waits the composer is one compact row on every surface: the card that needs
          the answer gets the screen, so the shortcuts, the page context and the footer step aside. */}
      {accessory && !compact ? <div className="cmp-accessory">{accessory}</div> : null}
      <div className="chat-composer-card cmp-card mx-auto rounded-xl border border-line bg-surface">
        {tray}
        {lead && !compact ? <div className="cmp-slot">{lead}</div> : null}
        <div className="chat-composer-context flex flex-wrap items-center gap-1 px-2" data-compact={compact || undefined}>
          {/* The header and the placeholder already name a routed agent; the chip appears only when it has news. */}
          {agentNeedsNote(agent) ? <AgentChip agent={agent} /> : null}
          {context.map((c) => (
            <ChipButton key={c.ref} onClick={() => onRemoveContext(c.ref)} aria-label={`Remove context ${c.label}`}>
              {c.label} ✕
            </ChipButton>
          ))}
        </div>
        <div className="cmp-files mx-auto">
          <AttachmentChips drafts={attachments.drafts} onRemove={attachments.remove} onRetry={attachments.retry} />
        </div>
        {scope ? <div className="cmp-slot">{scope}</div> : null}
        <form
          className="chat-comp relative flex flex-wrap items-end gap-1"
          onMouseDown={(e) => {
            // While typing, tapping a composer button (send, +, menu items) keeps the focus in the text field: the
            // keyboard stays up and the layout doesn't jump under the finger (which can swallow the tap).
            if (document.activeElement === ta.current && (e.target as HTMLElement).closest("button")) e.preventDefault();
          }}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {open ? (
            <TriggerPopover
              trigger={trigger!}
              rows={rows}
              active={activeIdx}
              loading={loading}
              partial={partial}
              repo={repo}
              searched={searched}
              onRepo={setRepo}
              onPick={pick}
              onHover={setActive}
              onFilter={filterTo}
              listId={listId}
            />
          ) : null}
          {/* Phones and panels: one "+" menu (context, files, camera, photos, model) so the text field gets the width. */}
          <ComposerAddMenu
            always={surface === "panel"}
            testIds={testIds}
            online={online}
            files={!compact}
            modelLabel={modelLabel}
            onContext={onAttach}
            onModel={onModel}
            onFile={() => fileInput.current?.click()}
            onCamera={() => cameraInput.current?.click()}
            onLibrary={attachments.add}
          />
          {surface === "page" ? (
            <Button
              variant="ghost"
              iconOnly
              icon={<PlusIcon className="h-5 w-5" />}
              onClick={onAttach}
              className="chat-add shrink-0 max-sm:hidden"
              data-density-skip
            >
              Attach context
            </Button>
          ) : null}
          {/* While an approval waits nothing can be sent: keep the composer one compact row, so on small phones at large
            text sizes it doesn't cover the approval card's buttons. In a panel the pickers stay mounted for the menu. */}
          {compact ? null : surface === "page" ? (
            <>
              <AttachButton onFiles={attachments.add} disabled={!online} buttonClassName="max-sm:hidden" inputRef={fileInput} />
              <CameraButton onFiles={attachments.add} disabled={!online} buttonClassName="max-sm:hidden" inputRef={cameraInput} />
            </>
          ) : (
            <span hidden>
              <AttachButton onFiles={attachments.add} disabled={!online} inputRef={fileInput} testId={testIds?.file} />
              <CameraButton onFiles={attachments.add} disabled={!online} inputRef={cameraInput} testId={testIds?.camera} />
            </span>
          )}
          <label htmlFor={fieldId} className="sr-only">
            {label ?? (running ? "Guidance for the current run" : `Message ${answerer}`)}
          </label>
          <Textarea
            id={fieldId}
            ref={ta}
            rows={1}
            maxLength={8000}
            value={text}
            placeholder={placeholder}
            data-testid={testIds?.input}
            data-autofocus={surface === "panel" || undefined}
            aria-controls={open ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={open && rows.length ? `${listId}-${activeIdx}` : undefined}
            onChange={(e) => {
              setText(e.target.value);
              syncTrigger(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              if (trigger) syncTrigger(el.value, el.selectionStart ?? el.value.length);
            }}
            onBlur={() => setTimeout(() => setTrigger(null), 150)}
            onFocus={onFocus}
            onPaste={(e) => {
              const files = pastedFiles(e);
              if (!files.length) return;
              e.preventDefault();
              attachments.add(files);
            }}
            onKeyDown={onKeyDown}
            className="cmp-input"
            // With Stop in the row a narrow phone needs two lines; without it the row fits.
            data-wrap={(running && !compact && !!onStop) || undefined}
          />
          {modelLabel && onModel && surface === "page" ? (
            <ChipButton
              className="chat-model shrink-0 self-end max-sm:hidden"
              onClick={onModel}
              aria-label={`Model: ${modelLabel}. Change`}
              data-testid="model-chip"
            >
              <span className="text-muted">Model</span> {modelLabel} <span aria-hidden="true">▾</span>
            </ChipButton>
          ) : null}
          {running && onStop ? (
            <Button
              variant="ghost"
              iconOnly
              icon={<StopIcon className="h-5 w-5" />}
              onClick={onStop}
              disabled={phase === "stopping"}
              className="chat-stop cmp-end shrink-0"
              data-density-skip
            >
              Stop the run (Escape)
            </Button>
          ) : null}
          <Button
            type="submit"
            variant={quietSend ? "secondary" : "primary"}
            iconOnly
            // Same send control everywhere: a small accent circle with an up arrow.
            icon={<span>↑</span>}
            loading={busy || sending}
            disabled={nothingToSend || !online || awaitingApproval || phase === "stopping" || (running && !canSteer)}
            title={`${sendName} (${sendHint(mod)})`}
            aria-keyshortcuts={SEND_KEYSHORTCUTS}
            data-density-skip
            data-testid={testIds?.send}
            className={cx("chat-send shrink-0", !(running && onStop) && "cmp-end")}
          >
            {sendName}
          </Button>
        </form>
        {footer && !compact ? <div className="cmp-foot">{footer}</div> : null}
        {!compact && surface === "page" ? (
          <p className="chat-composer-hint px-3 pb-2 text-xs text-muted" data-dynamic>
            @ context · # PR · / command · {mod === "⌘" ? "⌘" : "Ctrl"}+Enter send
          </p>
        ) : null}
      </div>
      {!online && text && surface === "page" ? <p className="mt-1 text-xs text-warn">Draft saved on this device. It has not been sent.</p> : null}
    </div>
  );
}

/**
 * The "+" menu of the composer: context, files, camera, photo library and the model. On the chat page it is the
 * phone's menu (wider screens show the controls in the row); in a panel it is always the way in.
 * Files and camera reuse the composer's own hidden inputs; the photo library has its own picker.
 */
function ComposerAddMenu({
  always,
  testIds,
  online,
  files,
  modelLabel,
  onContext,
  onModel,
  onFile,
  onCamera,
  onLibrary,
}: {
  always: boolean;
  testIds?: ComposerProps["testIds"];
  online: boolean;
  files: boolean;
  modelLabel?: string;
  onContext: () => void;
  onModel?: () => void;
  onFile: () => void;
  onCamera: () => void;
  onLibrary: (f: File[]) => void;
}) {
  const [open, setOpen] = useState(false);
  // Opened from the keyboard: focus the first item (WAI-ARIA menu). Opened by a tap: leave focus where it was,
  // so the on-screen keyboard stays up and nothing shifts under the finger.
  const [byKeyboard, setByKeyboard] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const library = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    // Escape closes the menu wherever the focus is: a tap opens it with the focus still in the text field.
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      const inMenu = root.current?.querySelector("[role=menu]")?.contains(document.activeElement);
      setOpen(false);
      if (inMenu) btn.current?.focus();
    };
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onEsc, true);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onEsc, true);
    };
  }, [open]);
  const items: KMenuItem[] = [
    { label: "Context", hint: "areas, items, people", onSelect: onContext },
    ...(files
      ? [
          { label: "Attach file", onSelect: onFile, disabled: !online },
          { label: "Camera", onSelect: onCamera, disabled: !online },
          { label: "Photo library", onSelect: () => library.current?.click(), disabled: !online },
        ]
      : []),
    ...(modelLabel && onModel ? [{ label: "Model", hint: modelLabel, onSelect: onModel }] : []),
  ];
  return (
    <div ref={root} className={cx("cmp-add relative shrink-0", !always && "sm:hidden")}>
      <Button
        ref={btn}
        variant="ghost"
        iconOnly
        icon={<PlusIcon className="h-5 w-5" />}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          setByKeyboard(e.detail === 0);
          setOpen((o) => !o);
        }}
        className="chat-add"
        data-density-skip
        data-testid={testIds?.add ?? "composer-add"}
      >
        Add to message
      </Button>
      {open ? (
        <Menu
          label="Add to message"
          items={items}
          autoFocus={byKeyboard}
          onClose={() => {
            const inMenu = root.current?.querySelector("[role=menu]")?.contains(document.activeElement);
            setOpen(false);
            if (inMenu) btn.current?.focus();
          }}
        />
      ) : null}
      <input
        ref={library}
        type="file"
        multiple
        accept="image/*"
        aria-label="Choose pictures from the photo library"
        data-testid={testIds?.library ?? "chat-library-input"}
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          onLibrary([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
