/** One source for the index and the persistent sub-page navigation. */
export function settingsSections(isAdmin: boolean, can: (cap: string) => boolean) {
  return [
    ...(isAdmin
      ? [{ href: "/settings/connections", label: "Connections", desc: "Hermes, todos, Home Assistant, Skylight, Paperclip, Daily Compass, Finance, GitHub" }]
      : []),
    ...(isAdmin ? [{ href: "/settings/people", label: "People", desc: "Family members, the kitchen tablet, and what each can use" }] : []),
    ...(isAdmin ? [{ href: "/settings/configuration", label: "Configuration transfer", desc: "Password-encrypted integration import and export" }] : []),
    { href: "/settings/home", label: "Home priorities", desc: "What Home shows first, hidden items, saved dates, your feedback" },
    { href: "/settings/notifications", label: "Notifications", desc: "Push on this device, quiet hours, categories" },
    { href: "/settings/phones", label: "Phones", desc: "Pair the Jarvis Android app, phone notifications" },
    ...(isAdmin ? [{ href: "/settings/ai", label: "AI", desc: "Budget, models and capture triage for background AI actions" }] : []),
    ...(isAdmin ? [{ href: "/settings/agents", label: "Agents", desc: "Which Hermes profile answers in each area" }] : []),
    { href: "/settings#appearance", label: "Appearance", desc: "Theme and density on this device" },
    ...(can("work.use")
      ? [
          { href: "/settings/tags", label: "Tags", desc: "Rename, merge and colour item tags" },
          { href: "/settings/places", label: "Saved places", desc: "Places workflows can pick or match by location" },
        ]
      : []),
    ...(isAdmin ? [{ href: "/settings/activity", label: "Activity log", desc: "Audit trail of consequential actions" }] : []),
  ];
}
