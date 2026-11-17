import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** One part of an Intercom conversation, as the REST API / webhooks return it. */
export interface IntercomPart {
  id?: string;
  /** `comment` is a reply, `note` an internal note; assignments, closes etc. carry no body. */
  part_type?: string;
  body?: string | null;
  author?: { type?: string; id?: string; name?: string | null; email?: string | null } | null;
  /** Unix seconds. */
  created_at?: number | null;
}

/** What the app knows about the conversation. */
export interface ConversationSnapshot {
  id: string;
  subject: string | null;
  contactEmail: string | null;
  contactName: string | null;
  /** The opening message, then every part, oldest first. */
  parts: IntercomPart[];
  /** Conversation attributes the admin chose as decision fields, by label. */
  fields: Record<string, unknown>;
  url: string | null;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Hold a changed reply's capture until the teammate picks a reason (Intercom's send is never held). */
  requireReason: boolean;
  captureInternalNotes: boolean;
  /** `attr_name:label` pairs → conversation custom attributes that are the decision. */
  decisionFields: Array<{ id: string; label: string }>;
  minDraftChars: number;
  reasonPack: ReasonPack;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  captureInternalNotes: false,
  decisionFields: [],
  minDraftChars: 80,
  reasonPack: "support",
};

/** Parses settings from environment-style keys (same names as the Zendesk app's parameters). */
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
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    captureInternalNotes: bool("capture_internal_notes", DEFAULT_SETTINGS.captureInternalNotes),
    decisionFields: fields,
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    reasonPack: reasonPackFrom(str("reason_pack")),
  };
}

/**
 * Who wrote the draft, as far as we were told. `ai`: a Fin / Copilot assist or a drafting agent
 * that recorded its run; `manual`: the teammate says they typed it; `unknown`: nobody said.
 * Guessing is worse than unknown, so nothing here is inferred from the text.
 */
export type DraftOrigin = "ai" | "manual" | "unknown";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  runId?: string;
  model?: string | null;
  /** ms epoch, when the draft was put in front of the teammate. */
  at: number;
}

/** A draft must be reply-sized; a typed greeting is not a draft. */
export function acceptDraft(
  text: string,
  origin: DraftOrigin,
  settings: AppSettings,
  at: number,
): DraftState | null {
  if (stripHtml(text).length < settings.minDraftChars) return null;
  return { text, origin, at };
}

export function originFrom(raw: unknown): DraftOrigin {
  return raw === "ai" || raw === "manual" ? raw : "unknown";
}

/** Intercom bodies are HTML; the case wants the text the human read. */
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

function role(p: IntercomPart): CaptureMessage["role"] {
  if (p.part_type === "note") return "note";
  const t = p.author?.type;
  if (t === "admin" || t === "team") return "agent";
  if (t === "bot") return "system";
  return "customer";
}

/** The thread the teammate saw, oldest first, as capture context. Event-only parts are dropped. */
export function contextFrom(c: ConversationSnapshot): CaptureMessage[] {
  return c.parts
    .filter((p) => p.body && stripHtml(p.body))
    .map((p) => ({
      role: role(p),
      author: p.author?.email ?? p.author?.name ?? null,
      content: stripHtml(p.body ?? ""),
      at: typeof p.created_at === "number" ? new Date(p.created_at * 1000).toISOString() : null,
    }));
}

export interface PendingSend {
  text: string;
  type: "reply" | "note";
  fields: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/** What to do with a reply the teammate sent. Pure: the Intercom glue only forwards the answer. */
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
  if (send.type === "note" && !settings.captureInternalNotes) return { action: "skip", why: "internal-note" };
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
    source: "intercom",
    externalId: `ic:${conversation.id}`,
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
    // No `draft:*` tag at all for unknown: the API then reports the origin as unknown.
    tags: [
      ...(draft.origin === "unknown" ? [] : [`draft:${draft.origin}`]),
      send.type === "note" ? "internal-note" : "public-reply",
    ],
    metadata: { contact: conversation.contactEmail ?? conversation.contactName ?? null },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/** Short status line for the panel. */
export function statusLine(
  d: DraftState | null,
  lastResult: { changed: boolean; dedup: boolean } | null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  return `Draft inserted · ${stripHtml(d.text).split(/\s+/).filter(Boolean).length} words`;
}

export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}

/** Decision-field values from Intercom's `custom_attributes`, by label. */
export function fieldsFrom(
  attrs: Record<string, unknown> | null | undefined,
  settings: AppSettings,
): Record<string, unknown> {
  if (settings.decisionFields.length === 0) return {};
  return Object.fromEntries(settings.decisionFields.map((f) => [f.label, attrs?.[f.id] ?? null]));
}
