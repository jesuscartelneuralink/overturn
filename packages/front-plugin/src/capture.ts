import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** One message of a Front conversation, as `listMessages` returns it. */
export interface FrontMessage {
  id: string;
  /** Front: `inbound` came from the customer, `outbound` was sent from Front. */
  status: "inbound" | "outbound" | string;
  body: string;
  fromHandle?: string | null;
  fromName?: string | null;
  date?: string | null;
}

/** One internal comment on the conversation, as `listComments` returns it. */
export interface FrontComment {
  id: string;
  body: string;
  authorName?: string | null;
  authorEmail?: string | null;
  createdAt?: string | null;
}

/** What the plugin knows about the conversation, read through the plugin SDK. */
export interface ConversationSnapshot {
  id: string;
  subject: string | null;
  recipientHandle: string | null;
  recipientName: string | null;
  /** Oldest first. */
  messages: FrontMessage[];
  comments: FrontComment[];
  /** Custom fields the admin chose as decision fields, by label. */
  fields: Record<string, unknown>;
  url: string | null;
}

export interface AppSettings {
  baseUrl: string;
  /**
   * A project API key in the plugin URL. Leave it out to post through Front's relay
   * (`relayHttp`), which attaches the key configured on the Front app server-side.
   */
  apiKey: string | null;
  agent: string;
  /**
   * Hold a changed reply's capture until the teammate picks a reason.
   * Front has no pre-send veto, so this never blocks the native Send button —
   * it only gates posting to Overturn.
   */
  requireReason: boolean;
  /** Also capture internal comments, not only outbound messages. */
  captureInternalNotes: boolean;
  /** `coverage, cf_123:reserve` → conversation custom fields (by name or id) that are the decision. */
  decisionFields: Array<{ id: string; label: string }>;
  /** Replies shorter than this never count as a draft (a typed greeting is not a draft). */
  minDraftChars: number;
  /** When set, the plugin watches only conversations carrying this tag. */
  scopeTag: string | null;
  /** Which quick-pick reasons the teammate sees. */
  reasonPack: ReasonPack;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  apiKey: null,
  agent: "support-reply",
  requireReason: true,
  captureInternalNotes: false,
  decisionFields: [],
  minDraftChars: 80,
  scopeTag: null,
  reasonPack: "support",
};

/** Parses plugin settings (URL query params; same names as the Zendesk app's parameters). */
export function settingsFrom(raw: Record<string, unknown>): AppSettings {
  const str = (k: string): string | null => {
    const v = raw[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const bool = (k: string, d: boolean): boolean => {
    const v = raw[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v === "true" || v === "1";
    return d;
  };
  const fields = (str("decision_fields") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, label] = s.split(":").map((x) => x.trim());
      return { id: id!, label: label || id! };
    });
  const min = Number(str("min_draft_chars") ?? "");
  return {
    baseUrl: (str("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    apiKey: str("overturn_api_key"),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    captureInternalNotes: bool("capture_internal_notes", DEFAULT_SETTINGS.captureInternalNotes),
    decisionFields: fields,
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    scopeTag: str("scope_tag"),
    reasonPack: reasonPackFrom(str("reason_pack")),
  };
}

/** Parse Front plugin URL query string into a settings map. */
export function settingsFromQuery(search: string): AppSettings {
  const raw: Record<string, unknown> = {};
  const q = search.startsWith("?") ? search.slice(1) : search;
  for (const part of q.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = decodeURIComponent(eq < 0 ? part : part.slice(0, eq));
    const v = decodeURIComponent(eq < 0 ? "" : part.slice(eq + 1));
    if (k) raw[k] = v;
  }
  return settingsFrom(raw);
}

/**
 * Whether the plugin should watch this conversation at all. With no scope tag every conversation
 * is watched, but nothing is read beyond the draft until one appears.
 */
export function inScope(tags: readonly string[], settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tags.includes(settings.scopeTag);
}

/**
 * Where the draft came from. The composer is watched: the first time it goes from (nearly)
 * empty to a reply-sized text in one change, that text was inserted (an AI assist, a macro,
 * a paste), not typed, and it is the draft.
 */
export type DraftOrigin = "inserted" | "manual" | "recorded" | "preloaded";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  runId?: string;
  model?: string | null;
  at: number;
}

export interface DraftDetector {
  onComposer(text: string, now?: number): DraftState | null;
  current(): DraftState | null;
  set(d: DraftState | null): void;
}

export function createDraftDetector(opts: { minDraftChars: number; typingWindowMs?: number }): DraftDetector {
  const window = opts.typingWindowMs ?? 1500;
  let draft: DraftState | null = null;
  let last = { text: "", at: 0 };
  let seen = false;
  return {
    onComposer(text, now = Date.now()) {
      const prev = last;
      const firstSight = !seen;
      seen = true;
      last = { text, at: now };
      if (draft) return null;
      const grew = text.length - prev.text.length;
      const jump =
        grew >= opts.minDraftChars && (prev.text.length < opts.minDraftChars / 2 || now - prev.at > window);
      const first = firstSight && text.length >= opts.minDraftChars;
      if (jump || first) {
        draft = { text, origin: first ? "preloaded" : "inserted", at: now };
        return draft;
      }
      return null;
    },
    current: () => draft,
    set: (d) => {
      draft = d;
    },
  };
}

function messageRole(m: FrontMessage): CaptureMessage["role"] {
  return m.status === "outbound" ? "agent" : "customer";
}

/** The thread the teammate saw, oldest first, as capture context. */
export function contextFrom(conversation: ConversationSnapshot): CaptureMessage[] {
  const msgs: CaptureMessage[] = conversation.messages
    .filter((m) => m.body?.trim())
    .map((m) => ({
      role: messageRole(m),
      author: m.fromHandle ?? m.fromName ?? null,
      content: stripHtml(m.body),
      at: m.date ?? null,
    }));
  const notes: CaptureMessage[] = conversation.comments
    .filter((c) => c.body?.trim())
    .map((c) => ({
      role: "note" as const,
      author: c.authorEmail ?? c.authorName ?? null,
      content: stripHtml(c.body),
      at: c.createdAt ?? null,
    }));
  return [...msgs, ...notes];
}

/** Front may hand draft/message bodies back as HTML; the case wants the text the human read. */
export function stripHtml(html: string): string {
  return normalizeCaptureText(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

export interface PendingSend {
  text: string;
  /** `publicReply` for an outbound message; `internalNote` for a Front comment. */
  type: "publicReply" | "internalNote" | string;
  fields: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/** What to do when a send is observed. Pure: the Front glue only forwards the answer. */
export function decideOnSend(input: {
  conversation: ConversationSnapshot;
  draft: DraftState | null;
  draftFields: Record<string, unknown>;
  send: PendingSend;
  reasonCode: string | null;
  reason: string;
  actor: string | null;
  settings: AppSettings;
  now?: number;
}): SendDecision {
  const { conversation, draft, send, settings } = input;
  const sentText = stripHtml(send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (send.type === "internalNote" && !settings.captureInternalNotes)
    return { action: "skip", why: "internal-note" };
  if (!draft) return { action: "skip", why: "no-draft" };

  const hasFields = settings.decisionFields.length > 0;
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields ? { fields: input.draftFields } : {}),
  };
  const sentAnswer: CaptureAnswer = { text: sentText, ...(hasFields ? { fields: send.fields } : {}) };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;
  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const body: CaptureCreate = {
    source: "front",
    externalId: `fr:${conversation.id}`,
    agent: settings.agent,
    actor: input.actor,
    subject: conversation.subject,
    context: contextFrom(conversation),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: reason || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend: Math.max(0, Math.round(((input.now ?? Date.now()) - draft.at) / 100) / 10),
    draftRunId: draft.runId ?? null,
    draftModel: draft.model ?? null,
    url: conversation.url,
    tags: [`draft:${draft.origin}`, send.type === "internalNote" ? "internal-note" : "public-reply"],
    metadata: { recipient: conversation.recipientHandle ?? conversation.recipientName ?? null },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/** Short status line for the sidebar. Issue asks for `Draft inserted · N words`. */
export function statusLine(
  d: DraftState | null,
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  const words = d.text.trim().split(/\s+/).length;
  const from = {
    inserted: "inserted",
    manual: "marked by you",
    recorded: "recorded by your agent",
    preloaded: "found in the composer",
  }[d.origin];
  return `Draft ${from} · ${words} words`;
}

/** The chips the teammate clicks, for the installed pack. */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}

/**
 * Decide whether a polled composer change looks like a completed send.
 * Front has no pre-send hook: a send is inferred when the draft disappears and a new
 * outbound message (or comment) appears after the draft was armed.
 */
export function observeSend(input: {
  hadDraftId: boolean;
  currentDraftId: string | undefined;
  currentDraftBody: string;
  draft: DraftState | null;
  /** Message / comment ids known before the draft was armed. */
  knownIds: ReadonlySet<string>;
  messages: FrontMessage[];
  comments: FrontComment[];
  /** Last non-empty composer body seen before the draft disappeared (edited send). */
  lastComposerText?: string;
}): { sent: PendingSend; messageId: string } | null {
  if (!input.draft) return null;
  const draftGone =
    (input.hadDraftId && !input.currentDraftId) ||
    (input.hadDraftId && input.currentDraftId !== undefined && !input.currentDraftBody.trim());
  if (!draftGone) return null;

  const newOutbound = [...input.messages]
    .reverse()
    .find((m) => m.status === "outbound" && m.body?.trim() && !input.knownIds.has(m.id));
  if (newOutbound) {
    return {
      sent: { text: newOutbound.body, type: "publicReply", fields: {} },
      messageId: newOutbound.id,
    };
  }
  const newComment = [...input.comments]
    .reverse()
    .find((c) => c.body?.trim() && !input.knownIds.has(c.id));
  if (newComment) {
    return {
      sent: { text: newComment.body, type: "internalNote", fields: {} },
      messageId: newComment.id,
    };
  }
  // Draft cleared but listMessages has not caught up yet — prefer the last composer body
  // (may include edits) over the original draft text.
  const fallback = (input.lastComposerText ?? input.draft.text).trim();
  if (fallback) {
    return {
      sent: { text: fallback, type: "publicReply", fields: {} },
      messageId: `pending:${input.draft.at}`,
    };
  }
  return null;
}
