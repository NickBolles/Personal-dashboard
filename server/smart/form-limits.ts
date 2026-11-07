import "server-only";
import type { JarvisSpec, PropsOf } from "@/lib/jarvis-ui/catalog";
import { intentInSpec, intentKey, type Intent } from "@/lib/jarvis-ui/intents";
import { formIntents } from "@/lib/jarvis-ui/v2";
import { HttpError } from "@/server/http/errors";

/** Bind free-text creates to their form's title field and destination, not the whole batch. */
export function checkFormCreateLimits(spec: JarvisSpec, intents: Intent[], today: string) {
  const forms = Object.values(spec.elements)
    .filter((e) => e.type === "Form")
    .map((e) => e.props as PropsOf<"Form">);
  if (!forms.length) return;
  const otherSpec = { ...spec, elements: Object.fromEntries(Object.entries(spec.elements).filter(([, e]) => e.type !== "Form")) };
  const creates = intents.filter((i): i is Extract<Intent, { kind: "item.create" }> => i.kind === "item.create" && !intentInSpec(otherSpec, i, today));
  // Each slot belongs to one binding. Unused allowance on another parent/form cannot be borrowed.
  const slots = forms.flatMap((form) =>
    (form.submit.creates ?? []).flatMap((binding) => Array.from({ length: binding.maxItems ?? 1 }, () => ({ form, binding }))),
  );
  const eligible = creates.map((intent) =>
    slots.map(({ form, binding }) =>
      formIntents(
        { ...form, submit: { label: form.submit.label, creates: [{ ...binding, maxItems: 1 }] } },
        {
          [binding.titleField]: intent.title,
          ...(binding.parentField ? { [binding.parentField]: intent.parentRef } : {}),
        },
      ).some((offered) => intentKey(offered) === intentKey(intent)),
    ),
  );
  const assigned = new Map<number, number>();
  const assign = (index: number, seen: Set<number>): boolean => {
    for (let slot = 0; slot < slots.length; slot++) {
      if (!eligible[index][slot] || seen.has(slot)) continue;
      seen.add(slot);
      const previous = assigned.get(slot);
      if (previous === undefined || assign(previous, seen)) {
        assigned.set(slot, index);
        return true;
      }
    }
    return false;
  };
  if (creates.some((_, index) => !assign(index, new Set()))) throw new HttpError(400, "too_many", "Too many form items");
}
