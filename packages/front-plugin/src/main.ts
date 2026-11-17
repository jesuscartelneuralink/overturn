import Front, { HttpVerbsEnum } from "@frontapp/plugin-sdk";
import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  type ConversationSnapshot,
  createDraftDetector,
  type DraftState,
  decideOnSend,
  type FrontComment,
  type FrontMessage,
  inScope,
  observeSend,
  quickReasons,
  settingsFromQuery,
  statusLine,
  type PendingSend,
} from "./capture";

/** Minimal surface of a singleConversation context we use (mocked in tests via capture helpers). */
interface FrontConversationCtx {
  type: "singleConversation";
  conversation: {
    id: string;
    subject?: string;
    draftId?: string;
    recipient?: { name?: string; handle?: string };
    tags: ReadonlyArray<{ id: string; name: string }>;
    customFieldAttributes?: ReadonlyArray<{ id: string; name: string; value: unknown }>;
  };
  teammate?: { email?: string; name?: string };
  fetchDraft: (draftId: string) => Promise<
    | { id: string; content?: { body: string; type: "html" | "text" }; subject?: string }
    | undefined
  >;
  listMessages: () => Promise<{
    results: ReadonlyArray<{
      id: string;
      status: "inbound" | "outbound" | string;
      content?: { body: string; type: "html" | "text" };
      from?: { name?: string; handle?: string };
      date?: Date;
    }>;
  }>;
  listComments: () => Promise<{
    results: ReadonlyArray<{
      id: string;
      content: { body: string };
      author?: { name?: string; email?: string };
      createdAt?: Date;
    }>;
  }>;
  relayHttp: (req: {
    verb: HttpVerbsEnum;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  }) => Promise<{ status: number; body: unknown }>;
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

const parseBody = (body: unknown): unknown => {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
};

type Transport = {
  get: <T>(url: string) => Promise<T>;
  post: <T>(url: string, body: unknown) => Promise<T>;
};

function transportFor(settings: AppSettings, ctxRelay: FrontConversationCtx["relayHttp"] | null): Transport {
  if (settings.apiKey) {
    const call = async <T>(url: string, init: RequestInit): Promise<T> => {
      const r = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
      if (!r.ok) throw new HttpError(r.status);
      return (await r.json()) as T;
    };
    return {
      get: (url) => call(url, { method: "GET" }),
      post: (url, body) => call(url, { method: "POST", body: JSON.stringify(body) }),
    };
  }
  const relay = ctxRelay;
  if (!relay) {
    return {
      get: async () => {
        throw new HttpError(0);
      },
      post: async () => {
        throw new HttpError(0);
      },
    };
  }
  const via = async <T>(verb: HttpVerbsEnum, url: string, body?: unknown): Promise<T> => {
    const r = await relay({
      verb,
      url,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body }),
    });
    if (r.status < 200 || r.status >= 300) throw new HttpError(r.status);
    return parseBody(r.body) as T;
  };
  return {
    get: (url) => via(HttpVerbsEnum.GET, url),
    post: (url, body) => via(HttpVerbsEnum.POST, url, body),
  };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function main(): void {
  const settings = settingsFromQuery(location.search);
  const root = document.getElementById("app")!;
  const status = el("div", { class: "status", role: "status" }, "Open a conversation");
  const quick = el("div", { class: "quick", role: "radiogroup", "aria-label": "Why did you change it?" });
  const chips: HTMLButtonElement[] = [];
  const reason = el("textarea", {
    class: "reason",
    rows: "2",
    placeholder: "Anything else? Optional.",
  }) as HTMLTextAreaElement;
  const mark = el("button", { type: "button", class: "link" }, "Use the current text as the draft");
  const note = el("div", { class: "note" }, "");
  const controls = el("div");
  controls.append(quick, reason, mark);
  root.append(status, controls, note);

  let reasonCode: string | null = null;
  let lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
  let detector = createDraftDetector({ minDraftChars: settings.minDraftChars });
  let watching = false;
  let draftFields: Record<string, unknown> = {};
  let held: { body: CaptureCreate; changedFields: string[] } | null = null;
  let knownIds = new Set<string>();
  let armedDraftId: string | undefined;
  let lastComposer = "";
  let currentCtx: FrontConversationCtx | null = null;
  let busy = false;

  for (const q of quickReasons(settings)) {
    const b = el("button", { type: "button", class: "chip", "data-code": q.code }, q.label) as HTMLButtonElement;
    b.addEventListener("click", () => {
      reasonCode = reasonCode === q.code ? null : q.code;
      for (const c of chips) c.classList.toggle("on", c.dataset.code === reasonCode);
      void flushHeld();
    });
    chips.push(b);
    quick.appendChild(b);
  }

  const render = (): void => {
    if (!currentCtx) {
      status.textContent = "Open a conversation";
      controls.hidden = true;
      return;
    }
    if (!watching) {
      status.textContent = `Not watching: no "${settings.scopeTag}" tag`;
      controls.hidden = true;
      return;
    }
    controls.hidden = false;
    if (held) {
      status.textContent = `Pick a reason to save this correction${
        held.changedFields.length ? ` (${held.changedFields.join(", ")})` : ""
      }`;
      return;
    }
    status.textContent = statusLine(detector.current(), lastResult);
  };

  const readFields = (ctx: FrontConversationCtx): Record<string, unknown> => {
    if (settings.decisionFields.length === 0) return {};
    const attrs = ctx.conversation.customFieldAttributes ?? [];
    const out: Record<string, unknown> = {};
    for (const f of settings.decisionFields) {
      const match = attrs.find((a) => a.id === f.id || a.name === f.label || a.name === f.id);
      out[f.label] = match?.value ?? null;
    }
    return out;
  };

  const transport = (): Transport =>
    transportFor(settings, currentCtx ? (req) => currentCtx!.relayHttp(req) : Front.relayHttp.bind(Front));

  const snapshot = async (ctx: FrontConversationCtx): Promise<ConversationSnapshot> => {
    const [msgs, cmts] = await Promise.all([
      ctx.listMessages().catch(() => ({ results: [] as const })),
      ctx.listComments().catch(() => ({ results: [] as const })),
    ]);
    const messages: FrontMessage[] = [...msgs.results]
      .map((m) => ({
        id: m.id,
        status: m.status,
        body: m.content?.body ?? "",
        fromHandle: m.from?.handle ?? null,
        fromName: m.from?.name ?? null,
        date: m.date ? m.date.toISOString() : null,
      }))
      .reverse(); // Front returns newest-first; capture wants oldest-first
    const comments: FrontComment[] = [...cmts.results]
      .map((c) => ({
        id: c.id,
        body: c.content.body,
        authorName: c.author?.name ?? null,
        authorEmail: c.author?.email ?? null,
        createdAt: c.createdAt ? c.createdAt.toISOString() : null,
      }))
      .reverse();
    return {
      id: ctx.conversation.id,
      subject: ctx.conversation.subject ?? null,
      recipientHandle: ctx.conversation.recipient?.handle ?? null,
      recipientName: ctx.conversation.recipient?.name ?? null,
      messages,
      comments,
      fields: readFields(ctx),
      url: `https://app.frontapp.com/open/${ctx.conversation.id}`,
    };
  };

  const postCapture = async (body: CaptureCreate): Promise<void> => {
    try {
      const r = await transport().post<CaptureResult>(`${settings.baseUrl}/v1/capture`, body);
      lastResult = { kind: r.kind, changed: r.changed, dedup: r.deduplicated };
      note.textContent = r.changed && r.case ? `Case: ${r.case.title}` : "";
      reason.value = "";
      reasonCode = null;
      for (const c of chips) c.classList.remove("on");
      detector.set(null);
      held = null;
      armedDraftId = undefined;
      knownIds = new Set();
    } catch (e) {
      // Never block the teammate's work on our failure.
      note.textContent = `Overturn could not save this correction (${
        e instanceof HttpError ? e.status : "network"
      }).`;
    }
    render();
  };

  const flushHeld = async (): Promise<void> => {
    if (!held || !reasonCode) return;
    const body = { ...held.body, reasonCode, reason: reason.value.trim() || null };
    held = null;
    await postCapture(body);
  };

  const applySend = async (send: PendingSend): Promise<void> => {
    const ctx = currentCtx;
    const draft: DraftState | null = detector.current();
    if (!ctx || !draft) return;
    const conversation = await snapshot(ctx);
    // Attach current decision-field values to the send.
    send = { ...send, fields: conversation.fields };
    const decision = decideOnSend({
      conversation,
      draft,
      draftFields,
      send,
      reasonCode,
      reason: reason.value,
      actor: ctx.teammate?.email ?? ctx.teammate?.name ?? null,
      settings,
      now: Date.now(),
    });
    if (decision.action === "skip") {
      detector.set(null);
      armedDraftId = undefined;
      render();
      return;
    }
    if (decision.action === "need-reason") {
      // Front cannot veto native Send. Hold the payload until a reason chip is picked.
      // Rebuild with requireReason off so we have a CaptureCreate to stash (reasonCode filled later).
      const unlocked = decideOnSend({
        conversation,
        draft,
        draftFields,
        send,
        reasonCode: null,
        reason: reason.value,
        actor: ctx.teammate?.email ?? ctx.teammate?.name ?? null,
        settings: { ...settings, requireReason: false },
        now: Date.now(),
      });
      if (unlocked.action === "capture") {
        held = {
          body: { ...unlocked.body, reasonCode: null },
          changedFields: decision.changedFields,
        };
      }
      chips[0]?.focus();
      render();
      return;
    }
    await postCapture(decision.body);
  };

  const lookupRecorded = async (ctx: FrontConversationCtx): Promise<void> => {
    if (detector.current()) return;
    try {
      const found = await transport().get<{
        items: Array<{ id: string; output: unknown; agent: string; model?: string | null }>;
      }>(
        `${settings.baseUrl}/v1/runs?externalId=${encodeURIComponent(`fr:${ctx.conversation.id}`)}&agent=${encodeURIComponent(settings.agent)}&limit=1`,
      );
      const run = found.items[0];
      if (run && typeof run.output === "string" && run.output.trim()) {
        detector.set({
          text: run.output,
          origin: "recorded",
          runId: run.id,
          model: run.model ?? null,
          at: Date.now(),
        });
      }
    } catch {
      // no recorded draft; the composer is watched instead
    }
  };

  const armBaseline = async (ctx: FrontConversationCtx): Promise<void> => {
    const snap = await snapshot(ctx);
    knownIds = new Set([...snap.messages.map((m) => m.id), ...snap.comments.map((c) => c.id)]);
    draftFields = snap.fields;
    armedDraftId = ctx.conversation.draftId;
  };

  const pollOnce = async (): Promise<void> => {
    const ctx = currentCtx;
    if (!ctx || !watching || busy || held) return;
    busy = true;
    try {
      const draftId = ctx.conversation.draftId;
      let body = "";
      if (draftId) {
        try {
          const d = await ctx.fetchDraft(draftId);
          body = d?.content?.body ?? "";
        } catch {
          body = "";
        }
      }
      const appeared = detector.onComposer(body || "");
      if (appeared && draftId) {
        await armBaseline(ctx);
      } else if (detector.current() && draftId && !armedDraftId) {
        await armBaseline(ctx);
      }

      if (body.trim()) lastComposer = body;
      const snap = await snapshot(ctx);
      const observed = observeSend({
        hadDraftId: Boolean(armedDraftId),
        currentDraftId: draftId,
        currentDraftBody: body,
        draft: detector.current(),
        knownIds,
        messages: snap.messages,
        comments: snap.comments,
        lastComposerText: lastComposer,
      });
      if (observed) {
        await applySend(observed.sent);
      } else {
        render();
      }
    } finally {
      busy = false;
    }
  };

  mark.addEventListener("click", () => {
    void (async () => {
      const ctx = currentCtx;
      if (!ctx?.conversation.draftId) return;
      try {
        const d = await ctx.fetchDraft(ctx.conversation.draftId);
        const text = d?.content?.body ?? "";
        if (!text.trim()) return;
        detector.set({ text, origin: "manual", at: Date.now() });
        lastResult = null;
        await armBaseline(ctx);
        render();
      } catch {
        note.textContent = "Could not read the current draft.";
      }
    })();
  });

  reason.addEventListener("input", () => {
    if (held) void flushHeld();
  });

  Front.contextUpdates.subscribe((raw) => {
    void (async () => {
      if (raw.type !== "singleConversation") {
        currentCtx = null;
        watching = false;
        detector = createDraftDetector({ minDraftChars: settings.minDraftChars });
        held = null;
        armedDraftId = undefined;
        render();
        return;
      }
      const ctx = raw as unknown as FrontConversationCtx;
      const same = currentCtx?.conversation.id === ctx.conversation.id;
      currentCtx = ctx;
      watching = inScope(
        ctx.conversation.tags.map((t) => t.name),
        settings,
      );
      if (!same) {
        detector = createDraftDetector({ minDraftChars: settings.minDraftChars });
        held = null;
        lastResult = null;
        reasonCode = null;
        for (const c of chips) c.classList.remove("on");
        reason.value = "";
        note.textContent = "";
        armedDraftId = undefined;
        knownIds = new Set();
        if (watching) await lookupRecorded(ctx);
      }
      await pollOnce();
      render();
    })();
  });

  // Front does not emit context updates while the teammate types, so re-read the draft on a timer.
  setInterval(() => void pollOnce(), 1500);
}

main();
