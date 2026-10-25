"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, ErrorNote, Spinner } from "@/components/ui";
import { ChatIcon } from "@/components/icons";
import { WorkTree } from "@/components/work/WorkTree";
import { useWorkMutation } from "@/components/work/common";
import { useInbox } from "@/components/work/today";
import { useAskHermes } from "@/components/chat/useAskHermes";
import type { ItemsResponse } from "@/lib/work";

/**
 * The Areas pane beside a conversation (desktop /chat/*): the same secondary
 * nav as /areas — Today, Inbox, Chats and the one tree of work and
 * conversations — so chat and work never feel like two apps.
 */
export function AreasSidebar() {
  const path = usePathname();
  const router = useRouter();
  const sessionId = path.startsWith("/chat/") ? decodeURIComponent(path.slice(6)) : null;
  const items = useQuery({ queryKey: ["work", "items", false], queryFn: () => api.get<ItemsResponse>("/api/work/items") });
  const inbox = useInbox();
  const newChat = useAskHermes();
  const place = useWorkMutation((v: { id: string; parentId: string | null; index: number }) =>
    api.post(`/api/work/items/${encodeURIComponent(v.id)}/place`, { parentId: v.parentId, index: v.index }),
  );
  const list = items.data?.items ?? [];
  const node = sessionId ? list.find((i) => i.kind === "conversation" && i.sessionId === sessionId) : undefined;
  const count = inbox.data?.count;
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2 px-1 pt-1">
        <h2 className="text-[15px] leading-tight font-semibold tracking-tight">Areas</h2>
        <Button size="sm" variant="primary" busy={newChat.busy} onClick={() => newChat.start()}>
          New chat
        </Button>
      </div>
      <nav aria-label="Areas sections">
        <ul className="space-y-0.5">
          <li>
            <Link href="/areas" className="wk-side-nav">
              <span aria-hidden="true" className="w-4 text-center text-muted">
                ☀
              </span>
              <span>Today</span>
            </Link>
          </li>
          <li>
            <Link href="/areas?view=inbox" className="wk-side-nav">
              <span aria-hidden="true" className="w-4 text-center text-muted">
                ↓
              </span>
              <span>Inbox</span>
              {count ? (
                <span
                  className="ml-auto rounded-full bg-warn-soft px-1.5 text-[11.5px] leading-[18px] font-bold text-warn tabular-nums"
                  aria-label={`${count} waiting`}
                >
                  {count}
                </span>
              ) : null}
            </Link>
          </li>
          <li>
            <Link href="/chat" aria-current={path === "/chat" ? "page" : undefined} className="wk-side-nav">
              <ChatIcon className="h-4 w-4 shrink-0 text-muted" />
              <span>Chats</span>
            </Link>
          </li>
        </ul>
      </nav>
      <div className="min-h-0">
        <div className="flex items-center justify-between px-1 pt-1 pb-1.5">
          <h3 className="wk-label">Tree</h3>
        </div>
        {items.error ? <ErrorNote error={items.error} retry={() => items.refetch()} /> : null}
        {items.isPending ? (
          <Spinner label="Loading areas…" />
        ) : (
          <WorkTree
            items={list}
            linked={items.data?.linkedConversations}
            selected={node?.id ?? null}
            selectedSession={sessionId}
            onSelect={(id) => router.push(`/areas?item=${encodeURIComponent(id)}`)}
            onOpenConversation={(sid) => router.push(`/chat/${encodeURIComponent(sid)}`)}
            onPlace={(id, parentId, index) => place.mutate({ id, parentId, index })}
          />
        )}
      </div>
    </div>
  );
}
