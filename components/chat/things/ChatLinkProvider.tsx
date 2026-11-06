"use client";
import type { ReactNode } from "react";
import { MarkdownLinkRenderer } from "@/components/markdown/Markdown";
import { ARTIFACT_HOST, classifyUrl } from "@/lib/chat-links";
import { isFinanceContext } from "@/lib/chat-context";
import { isFailingLink } from "@/lib/chat/things";
import type { PanelLink } from "@/server/chat/links";
import { ThingIcon } from "./SummaryChip";

export function ChatLinkProvider({ links, children }: { links: PanelLink[]; children: ReactNode }) {
  return (
    <MarkdownLinkRenderer.Provider value={(href, label) => <ChatInlineLink href={href} label={label} links={links} />}>
      {children}
    </MarkdownLinkRenderer.Provider>
  );
}
function ChatInlineLink({ href, label, links }: { href: string; label: ReactNode; links: PanelLink[] }) {
  const internal = href.startsWith("/") || href.startsWith("#");
  const classified = classifyUrl(/^\/(a|v)\//.test(href) ? `https://${ARTIFACT_HOST}${href}` : href);
  const artifact = classified?.kind === "artifact" || /^\/(a|v)\/[\w.-]+/.test(href);
  const item = /^\/(areas|work)(?:\?|\/).*\bitem[=/]/.test(href);
  const github = classified?.kind === "github";
  const chip = !isFinanceContext({ url: href }) && (artifact || item || github);
  const known = links.find((l) => l.url === (classified?.url ?? href));
  const dot = known && isFailingLink(known) ? "red" : known?.state === "merged" ? "yellow" : null;
  return (
    <a
      href={href}
      target={internal ? undefined : "_blank"}
      rel={internal ? undefined : "noopener noreferrer nofollow"}
      className={chip ? "chat-inline-chip no-underline!" : undefined}
      title={chip ? `${known?.state ? `${known.state} · ` : ""}${href}` : undefined}
    >
      {chip ? (
        <>
          <ThingIcon kind={artifact ? "Artifacts" : github ? "PRs" : "Outline"} />
          {known?.state ? <span className={dot ? "chat-attention-dot" : "chat-inline-state-dot"} data-dot={dot ?? undefined} data-state={known.state} /> : null}
          <span>
            {known?.title ??
              (typeof label === "string" && /^https?:/.test(label) ? (classified?.slug ?? (classified?.number ? `#${classified.number}` : label)) : label)}
          </span>
        </>
      ) : (
        label
      )}
    </a>
  );
}
