import type { ChatFileView } from "@/lib/chat-files";
import { chatVisual, visualNow } from "./chat-alerts";

/** 96×72 sky/ground picture: a fixed thumbnail for visual snapshots. */
export const PHOTO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABICAYAAAAJZ/BjAAABOElEQVR4Ae3BMZUdVhQEMM07twqSxWQIBmQyAZItwsWm4F9NM1J+/Pr/dxAEQRAEQRAEQRAEQRAEQRAEQRAEQRAEQRAEQRAEQRAEQRAEQRAEQRAEQRAEQRAEQRAEQRAEQRAEQRAEQRAEQRAEQRAEQRAEJ6boxBSdmKITU3Riik5M0YkpOjFFJ6boxBSdmKITU3Riik5M0YkpOjFFJ6boxBSdmKITU3Riik5M0YkpOjFFJ6boxBSdmKITU3Riik5M0YkpOjFFJ6boxBSdmKITU3Riik5M0Ykpun/+/elv/cZ/PvPlM98+8+Uz3z7z5TPfPvNM1TNVz1Q9U/VM1TNVz1Q9U/VM1TNVz1Q9U/VM1TNVz1Q9U/VM1TNVz1Q9U/VM1TNVz1Q9U/VM1TNVz1Q9U/VM1TNVz1T9AQ6JCjaPXbNxAAAAAElFTkSuQmCC",
  "base64",
);

const file = (id: string, name: string, kind: ChatFileView["kind"], mime: string, bytes: number, extra: Partial<ChatFileView> = {}): ChatFileView => ({
  id,
  sessionId: "sess_files",
  name,
  mime,
  kind,
  bytes,
  width: kind === "image" ? 96 : null,
  height: kind === "image" ? 72 : null,
  textStatus: kind === "image" ? null : "ok",
  sentAt: visualNow,
  createdAt: visualNow,
  locationRemoved: kind === "image",
  ...extra,
});

export const filesVisual: ChatFileView[] = [
  file("cf_visual_photo1", "garage-shelf.jpg", "image", "image/jpeg", 482_000),
  file("cf_visual_photo2", "receipt.png", "image", "image/png", 131_000),
  file("cf_visual_notes1", "shelf-measurements.txt", "text", "text/plain", 1_800),
];

export const chatFilesVisual = {
  ...chatVisual,
  session: { ...chatVisual.session, id: "sess_files", title: "Garage shelf" },
  timeline: [
    {
      kind: "user" as const,
      id: "files-user",
      text: "Which shelf fits this corner?\n\n---\nContext from Jarvis:\njarvis-file:cf_visual_photo1\njarvis-file:cf_visual_photo2\njarvis-file:cf_visual_notes1",
      at: visualNow,
    },
    {
      kind: "assistant" as const,
      id: "files-assistant",
      text: "I can see 2 pictures. The 36-inch unit fits the corner with room for the door.",
      at: visualNow,
    },
  ],
};
