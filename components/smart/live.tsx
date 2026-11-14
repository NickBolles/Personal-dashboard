"use client";

import { createContext, type ReactNode } from "react";

/**
 * Sends text into the conversation the smart block belongs to, as the owner's reply (a questionnaire Form's Submit).
 * Resolves true once sent. Null where the block isn't inside a conversation that can take a reply.
 */
export const SmartReply = createContext<((text: string) => Promise<boolean>) | null>(null);

/**
 * Draws an open D-n decision as the live decision block (one answer flow, Undo). Returns null when it can't be drawn
 * here (not open, not known), and the static card is shown instead. Provided by the coordinator thread.
 */
export const LiveDecision = createContext<((ref: string) => ReactNode | null) | null>(null);
