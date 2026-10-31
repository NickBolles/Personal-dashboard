/**
 * Links side panel: every URL that appears in a conversation (user, assistant
 * and tool messages), classified and deduped. Pure — shared by client + server.
 */
import type { TimelineItem } from "@/lib/hermes";

export const ARTIFACT_HOST = "artifacts.ai.nickbolles.com";

export type LinkKind = "artifact" | "github" | "web";

export type ExtractedLink = {
  /** Canonical URL (dedupe key). */
  url: string;
  kind: LinkKind;
  /** Hostname without `www.`. */
  domain: string;
  /** Artifact slug (`/v/<slug>/…` or `/a/<slug>/…`). */
  slug?: string;
  /** GitHub `owner/repo`, number and type. */
  repo?: string;
  number?: number;
  ghType?: "pull" | "issue";
  /** Where it was first seen. */
  source: TimelineItem["kind"];
  firstSeenAt?: string;
};

// Stop at whitespace, quotes, angle brackets and markdown/link punctuation.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`()[\]{}|\\^]+/gi;
const TRAILING = /[.,;:!?*_~]+$/;

/** All http(s) URLs in a string, trailing punctuation trimmed. */
export function findUrls(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    let u = m[0].replace(TRAILING, "");
    // Balanced parens inside wiki-style URLs are rare; a dangling ")" was already excluded.
    if (u.endsWith("&gt") || u.endsWith("&lt")) u = u.slice(0, -3);
    if (u.length > 8) out.push(u);
  }
  return out;
}

/** Canonical form: lowercase host, no fragment/`www.`, no trailing slash (except artifacts keep path). */
export function canonicalUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null; // never surface credentials
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  // Drop common tracking params.
  for (const k of [...u.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/i.test(k)) u.searchParams.delete(k);
  let s = u.toString();
  if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
  if (u.pathname === "/" && !u.search) s = s.replace(/\/$/, "");
  return s;
}

/** Classify a canonical URL. */
export function classifyUrl(url: string): Omit<ExtractedLink, "source" | "firstSeenAt"> | null {
  const c = canonicalUrl(url);
  if (!c) return null;
  const u = new URL(c);
  const domain = u.hostname;
  if (domain === ARTIFACT_HOST) {
    const m = u.pathname.match(/^\/(v|a)\/([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (m) {
      // `/a/<slug>/file.png` and `/v/<slug>/` are the same artifact: dedupe on the slug view.
      return { url: `https://${ARTIFACT_HOST}/v/${m[2]}/`, kind: "artifact", domain, slug: m[2] };
    }
  }
  if (domain === "github.com") {
    const m = u.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/);
    if (m) {
      const ghType = m[3] === "pull" ? "pull" : "issue";
      return {
        url: `https://github.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`,
        kind: "github",
        domain,
        repo: `${m[1]}/${m[2]}`,
        number: Number(m[4]),
        ghType,
      };
    }
  }
  return { url: c, kind: "web", domain };
}

function itemTexts(it: TimelineItem): string[] {
  switch (it.kind) {
    case "tool":
      return [it.summary, it.detail ?? ""];
    default:
      return [it.text];
  }
}

/** Every link in a timeline, deduped by canonical URL, in first-seen order. */
export function extractLinks(timeline: TimelineItem[], max = 200): ExtractedLink[] {
  const seen = new Map<string, ExtractedLink>();
  for (const it of timeline) {
    for (const text of itemTexts(it)) {
      for (const raw of findUrls(text)) {
        const c = classifyUrl(raw);
        if (!c || seen.has(c.url)) continue;
        seen.set(c.url, { ...c, source: it.kind, firstSeenAt: it.at });
        if (seen.size >= max) return [...seen.values()];
      }
    }
  }
  return [...seen.values()];
}

/** Short label for a link row when no title is known yet. */
export function linkFallbackTitle(l: Pick<ExtractedLink, "kind" | "slug" | "repo" | "number" | "ghType" | "url" | "domain">) {
  if (l.kind === "artifact") return l.slug ?? "Artifact";
  if (l.kind === "github") return `${l.repo}#${l.number}`;
  try {
    const u = new URL(l.url);
    const path = u.pathname === "/" ? "" : decodeURIComponent(u.pathname).replace(/\/$/, "");
    return `${l.domain}${path.length > 40 ? path.slice(0, 39) + "…" : path}`;
  } catch {
    return l.domain;
  }
}
