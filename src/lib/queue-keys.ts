import type { Listing, ValidationIssue } from "@/db/schema";
import { validateListing } from "./listing-validator";

/** Keyboard map for the approval queue. Pure so it can be unit tested. */
export type QueueAction =
  | { type: "approve" } | { type: "reject" } | { type: "edit" }
  | { type: "next" } | { type: "prev" } | { type: "toggle" }
  | { type: "bulkApprove" } | { type: "bulkReject" }
  | { type: "selectReady" } | { type: "selectAll" } | { type: "clear" }
  | { type: "search" } | { type: "help" };

export type KeyInput = { key: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean };

export function queueAction(e: KeyInput): QueueAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null; // leave browser shortcuts alone
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.shiftKey) {
    if (k === "a") return { type: "bulkApprove" };
    if (k === "r") return { type: "bulkReject" };
    if (k === "s") return { type: "selectReady" };
    if (k === "?") return { type: "help" };
  }
  switch (k) {
    case "ArrowRight": case "a": return { type: "approve" };
    case "ArrowLeft": case "r": return { type: "reject" };
    case "ArrowDown": case "j": return { type: "next" };
    case "ArrowUp": case "k": return { type: "prev" };
    case "e": case "Enter": return { type: "edit" };
    case "x": case " ": return { type: "toggle" };
    case "Escape": return { type: "clear" };
    case "/": return { type: "search" };
    case "?": return { type: "help" };
    case "*": return { type: "selectAll" };
  }
  return null;
}

/** Index of the focused id after the visible list changes (decision, filter): stay on the same slot, clamp to the end. */
export function focusAfter(ids: number[], focusedId: number | null, previousIndex: number) {
  if (ids.length === 0) return null;
  if (focusedId != null && ids.includes(focusedId)) return focusedId;
  return ids[Math.min(Math.max(previousIndex, 0), ids.length - 1)];
}

export function step(ids: number[], focusedId: number | null, dir: 1 | -1) {
  if (ids.length === 0) return null;
  const i = focusedId == null ? -1 : ids.indexOf(focusedId);
  return ids[Math.min(Math.max(i + dir, 0), ids.length - 1)];
}

export const QUEUE_SHORTCUTS: [string, string][] = [
  ["→ / A", "Approve focused"], ["← / R", "Reject focused"], ["↓ / J", "Next"], ["↑ / K", "Previous"],
  ["E / Enter", "Edit"], ["X / Space", "Select focused"], ["Shift+S", "Select all ready (no errors)"], ["*", "Select all shown"],
  ["Shift+A", "Approve selected"], ["Shift+R", "Reject selected"], ["Esc", "Clear selection"], ["/", "Search"], ["?", "Shortcuts"],
];


/**
 * Issues as approval will see them: the stored stage result (supplier/mockup facts) plus a fresh run of the
 * same validator the server uses on approve, so listings drafted before a rule change show the new errors.
 */
export function currentIssues(l: Listing): ValidationIssue[] {
  const seen = new Set<string>();
  return [...validateListing(l).issues, ...l.validation].filter((i) => {
    const k = `${i.code}|${i.field}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
