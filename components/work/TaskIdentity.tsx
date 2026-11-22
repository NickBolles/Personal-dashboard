"use client";

import { useEffect, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ChipButton } from "@/components/ui";

/**
 * The canonical task id is visible and copyable without changing the task's route or opening a conversation.
 * When clipboard access is unavailable, the full selectable id remains as the manual-copy fallback.
 */
export function TaskIdentity({ id }: { id: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  // WorkView keeps this component mounted while selecting a different task.
  useEffect(() => setCopyState("idle"), [id]);

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard is unavailable");
      await navigator.clipboard.writeText(id);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <span className="ip-task-id" data-testid="task-identity">
      <span className="ip-task-id-label">Task ID</span>
      <code className="ip-task-id-value" tabIndex={0} data-testid="task-id-value">
        {id}
      </code>
      <ChipButton
        aria-label="Copy task ID"
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          event.preventDefault();
          event.stopPropagation();
          void copy();
        }}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          void copy();
        }}
        data-testid="copy-task-id"
      >
        {copyState === "copied" ? "Copied" : "Copy"}
      </ChipButton>
      {copyState === "copied" ? (
        <span className="sr-only" role="status">
          Task ID copied.
        </span>
      ) : null}
      {copyState === "failed" ? (
        <span className="ip-task-id-fallback" role="status">
          Copy unavailable — select the ID above.
        </span>
      ) : null}
    </span>
  );
}
