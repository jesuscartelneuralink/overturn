import { createHmac, timingSafeEqual } from "node:crypto";
import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  acceptDraft,
  type ConversationSnapshot,
  type DraftState,
  decideOnSend,
  fieldsFrom,
  type IntercomPart,
  originFrom,
  quickReasons,
  statusLine,
} from "./capture";

/** The Intercom conversation model, as far as this app reads it (webhook `data.item`, REST, Canvas Kit). */
export interface IntercomConversation {
  id: string;
  title?: string | null;
  source?: IntercomPart | null;
  conversation_parts?: { conversation_parts?: IntercomPart[] } | null;
  custom_attributes?: Record<string, unknown> | null;
  contacts?: { contacts?: Array<{ id?: string; email?: string | null; name?: string | null }> } | null;
}

/** What the app remembers per conversation between the panel and the reply webhook. */
export interface ConversationState {
  draft: DraftState | null;
  draftFields: Record<string, unknown>;
  reasonCode: string | null;
  reason: string;
  /** A changed reply that arrived before a reason was picked; posted once there is one. */
  held: { body: CaptureCreate; changedFields: string[] } | null;
  lastResult: { changed: boolean; dedup: boolean } | null;
  message: string;
}

export interface Store {
  get(id: string): Promise<ConversationState | undefined>;
  set(id: string, s: ConversationState): Promise<void>;
}

export function memoryStore(): Store {
  const m = new Map<string, ConversationState>();
  return {
    get: async (id) => m.get(id),
    set: async (id, s) => {
      m.set(id, s);
    },
  };
}

export interface Overturn {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export interface Deps {
  settings: AppSettings;
  store: Store;
  overturn: Overturn;
  /** OAuth client secret: verifies `X-Body-Signature` (Canvas Kit) and `X-Hub-Signature` (webhooks). */
  clientSecret: string | null;
  /** Reads the full thread when a webhook only carries the newest part. Optional. */
  fetchConversation?: (id: string) => Promise<IntercomConversation>;
  /** Intercom workspace id, for the link back from the run page. */
  workspaceId?: string | null;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}
export interface HttpResponse {
  status: number;
  body: unknown;
}

const fresh = (): ConversationState => ({
  draft: null,
  draftFields: {},
  reasonCode: null,
  reason: "",
  held: null,
  lastResult: null,
  message: "",
});

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Canvas Kit signs the raw body with HMAC-SHA256 (hex); webhooks with HMAC-SHA1 as `sha1=<hex>`. */
export function verifySignature(req: HttpRequest, secret: string | null): boolean {
  if (!secret) return true;
  const canvas = req.headers["x-body-signature"];
  if (canvas) return safeEqual(createHmac("sha256", secret).update(req.body).digest("hex"), canvas);
  const hook = req.headers["x-hub-signature"];
  if (hook) return safeEqual(`sha1=${createHmac("sha1", secret).update(req.body).digest("hex")}`, hook);
  return false;
}

export function snapshotFrom(
  c: IntercomConversation,
  settings: AppSettings,
  workspaceId?: string | null,
): ConversationSnapshot {
  const parts = [...(c.source ? [c.source] : []), ...(c.conversation_parts?.conversation_parts ?? [])];
  const contact = c.contacts?.contacts?.[0];
  return {
    id: String(c.id),
    subject: c.title ? c.title : null,
    contactEmail: contact?.email ?? null,
    contactName: contact?.name ?? null,
    parts,
    fields: fieldsFrom(c.custom_attributes, settings),
    url: workspaceId ? `https://app.intercom.com/a/inbox/${workspaceId}/inbox/conversation/${c.id}` : null,
  };
}

/** The Canvas Kit UI for the conversation details panel. */
export function renderCanvas(
  s: ConversationState,
  settings: AppSettings,
): { canvas: { content: { components: unknown[] } } } {
  const components: unknown[] = [];
  const header = s.held
    ? `Pick why you changed the ${s.held.changedFields.length ? s.held.changedFields.join(", ") : "reply"}`
    : statusLine(s.draft, s.lastResult);
  components.push({ type: "text", id: "status", text: header, style: "header" });
  if (!s.draft && !s.held) {
    components.push(
      {
        type: "textarea",
        id: "draft",
        label: "Draft",
        placeholder: "The reply the assist put in the composer",
      },
      {
        type: "dropdown",
        id: "origin",
        label: "Who wrote it?",
        options: [
          { type: "option", id: "ai", text: "Fin / AI assist" },
          { type: "option", id: "manual", text: "I wrote it" },
          { type: "option", id: "unknown", text: "Not sure" },
        ],
        value: "unknown",
      },
      {
        type: "button",
        id: "save_draft",
        label: "Use as the draft",
        style: "secondary",
        action: { type: "submit" },
      },
    );
  }
  if (s.draft || s.held) {
    components.push(
      {
        type: "single-select",
        id: "reason_code",
        label: "Why did you change it?",
        options: quickReasons(settings).map((r) => ({ type: "option", id: r.code, text: r.label })),
        ...(s.reasonCode ? { value: s.reasonCode } : {}),
      },
      { type: "textarea", id: "note", label: "Anything else? Optional.", value: s.reason },
      {
        type: "button",
        id: "save_reason",
        label: s.held ? "Save the correction" : "Save reason",
        style: "primary",
        action: { type: "submit" },
      },
    );
    if (s.draft && !s.held) {
      components.push({
        type: "button",
        id: "clear_draft",
        label: "Not the draft",
        style: "link",
        action: { type: "submit" },
      });
    }
  }
  if (s.message) components.push({ type: "text", id: "message", text: s.message, style: "muted" });
  return { canvas: { content: { components } } };
}

export function createApp(deps: Deps): (req: HttpRequest) => Promise<HttpResponse> {
  const { settings, store, overturn } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const load = async (id: string): Promise<ConversationState> => (await store.get(id)) ?? fresh();

  const lookupRecorded = async (id: string, s: ConversationState): Promise<void> => {
    if (s.draft) return;
    try {
      const found = await overturn.get<{
        items: Array<{ id: string; output: unknown; model?: string | null }>;
      }>(
        `/v1/runs?externalId=${encodeURIComponent(`ic:${id}`)}&agent=${encodeURIComponent(settings.agent)}&limit=1`,
      );
      const run = found.items[0];
      if (run && typeof run.output === "string" && run.output.trim()) {
        // A drafting agent recorded this run: an AI draft, by definition.
        s.draft = { text: run.output, origin: "ai", runId: run.id, model: run.model ?? null, at: now() };
      }
    } catch {
      // no recorded draft; the teammate can paste it
    }
  };

  const post = async (id: string, s: ConversationState, body: CaptureCreate): Promise<void> => {
    try {
      const r = await overturn.post<CaptureResult>("/v1/capture", body);
      s.lastResult = { changed: r.changed, dedup: r.deduplicated };
      s.message = r.changed && r.case ? `Case: ${r.case.title}` : "";
      s.draft = null;
      s.held = null;
      s.reasonCode = null;
      s.reason = "";
    } catch (e) {
      // Never in the teammate's way: the reply already went out; say so in the panel.
      const status = (e as { status?: number }).status;
      log(`capture failed for ic:${id}: ${status ?? "network"}`);
      s.message = `Overturn could not save this correction (${status ?? "network"}).`;
      s.held = null;
    }
    await store.set(id, s);
  };

  const initialize = async (body: { conversation?: { id?: string | number } }): Promise<HttpResponse> => {
    const id = body.conversation?.id;
    if (id === undefined)
      return {
        status: 200,
        body: {
          canvas: {
            content: { components: [{ type: "text", text: "Open a conversation", style: "muted" }] },
          },
        },
      };
    const s = await load(String(id));
    await lookupRecorded(String(id), s);
    await store.set(String(id), s);
    return { status: 200, body: renderCanvas(s, settings) };
  };

  const submit = async (body: {
    conversation?: { id?: string | number; custom_attributes?: Record<string, unknown> };
    component_id?: string;
    input_values?: Record<string, unknown>;
  }): Promise<HttpResponse> => {
    const id = String(body.conversation?.id ?? "");
    if (!id) return { status: 400, body: { error: "no conversation" } };
    const s = await load(id);
    const v = body.input_values ?? {};
    s.message = "";
    if (body.component_id === "save_draft") {
      const d = acceptDraft(
        typeof v.draft === "string" ? v.draft : "",
        originFrom(v.origin),
        settings,
        now(),
      );
      if (d) {
        s.draft = d;
        s.draftFields = fieldsFrom(body.conversation?.custom_attributes, settings);
        s.lastResult = null;
      } else {
        s.message = `A draft is at least ${settings.minDraftChars} characters.`;
      }
    } else if (body.component_id === "clear_draft") {
      s.draft = null;
    } else if (body.component_id === "save_reason") {
      s.reasonCode = typeof v.reason_code === "string" && v.reason_code ? v.reason_code : null;
      s.reason = typeof v.note === "string" ? v.note : "";
      if (s.held && s.reasonCode) {
        await post(id, s, { ...s.held.body, reasonCode: s.reasonCode, reason: s.reason.trim() || null });
        return { status: 200, body: renderCanvas(s, settings) };
      }
    }
    await store.set(id, s);
    return { status: 200, body: renderCanvas(s, settings) };
  };

  /** `conversation.admin.replied` / `conversation.admin.noted`: the reply that went out. */
  const webhook = async (body: {
    topic?: string;
    data?: { item?: IntercomConversation };
  }): Promise<HttpResponse> => {
    const item = body.data?.item;
    const type =
      body.topic === "conversation.admin.replied"
        ? "reply"
        : body.topic === "conversation.admin.noted"
          ? "note"
          : null;
    if (!item || !type) return { status: 200, body: { ok: true, ignored: body.topic ?? null } };
    const id = String(item.id);
    const s = await store.get(id);
    // Nothing is read for a conversation that never had a draft.
    if (!s?.draft) return { status: 200, body: { ok: true, skipped: "no-draft" } };
    const parts = item.conversation_parts?.conversation_parts ?? [];
    const sentPart = [...parts]
      .reverse()
      .find((p) => (p.part_type === "comment" || p.part_type === "note") && p.author?.type === "admin");
    if (!sentPart?.body) return { status: 200, body: { ok: true, skipped: "no-part" } };
    let full: IntercomConversation = item;
    if (deps.fetchConversation) {
      try {
        full = await deps.fetchConversation(id);
      } catch {
        // the webhook's own parts are enough context
      }
    }
    const snap = snapshotFrom(full, settings, deps.workspaceId);
    // The context is the thread before the reply that was just sent.
    snap.parts = snap.parts.filter((p) => !(sentPart.id && p.id === sentPart.id) && p !== sentPart);
    const decision = decideOnSend({
      conversation: snap,
      draft: s.draft,
      draftFields: s.draftFields,
      send: { text: sentPart.body, type, fields: snap.fields },
      reasonCode: s.reasonCode,
      reason: s.reason,
      actor: sentPart.author?.email ?? sentPart.author?.name ?? null,
      settings,
      now: now(),
    });
    if (decision.action === "skip") return { status: 200, body: { ok: true, skipped: decision.why } };
    if (decision.action === "need-reason") {
      const open = decideOnSend({
        conversation: snap,
        draft: s.draft,
        draftFields: s.draftFields,
        send: { text: sentPart.body, type, fields: snap.fields },
        reasonCode: null,
        reason: s.reason,
        actor: sentPart.author?.email ?? sentPart.author?.name ?? null,
        settings: { ...settings, requireReason: false },
        now: now(),
      });
      if (open.action === "capture") s.held = { body: open.body, changedFields: decision.changedFields };
      await store.set(id, s);
      return { status: 200, body: { ok: true, held: true } };
    }
    await post(id, s, decision.body);
    return { status: 200, body: { ok: true, captured: true } };
  };

  return async (req) => {
    if (req.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
    if (!verifySignature(req, deps.clientSecret)) return { status: 401, body: { error: "bad signature" } };
    let body: unknown;
    try {
      body = JSON.parse(req.body || "{}");
    } catch {
      return { status: 400, body: { error: "invalid json" } };
    }
    try {
      if (req.path === "/initialize") return await initialize(body as Parameters<typeof initialize>[0]);
      if (req.path === "/submit") return await submit(body as Parameters<typeof submit>[0]);
      if (req.path === "/webhook") return await webhook(body as Parameters<typeof webhook>[0]);
    } catch (e) {
      log(`handler error: ${(e as Error).message}`);
      // A webhook must still be acknowledged, and the panel must still render.
      return { status: 200, body: req.path === "/webhook" ? { ok: false } : renderCanvas(fresh(), settings) };
    }
    return { status: 404, body: { error: "not found" } };
  };
}
