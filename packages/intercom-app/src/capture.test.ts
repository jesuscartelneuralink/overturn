import { describe, expect, it } from "vitest";
import {
  acceptDraft,
  type ConversationSnapshot,
  contextFrom,
  DEFAULT_SETTINGS,
  decideOnSend,
  fieldsFrom,
  originFrom,
  quickReasons,
  settingsFrom,
  statusLine,
} from "./capture";

const draftText =
  "<p>Hi Dana,</p><p>Your refund for order #1042 was issued today and should land in 5 business days. Sorry for the wait.</p>";

const conversation: ConversationSnapshot = {
  id: "215469913",
  subject: "Where is my refund?",
  contactEmail: "dana@example.com",
  contactName: "Dana",
  parts: [
    {
      id: "1",
      part_type: "comment",
      body: "<p>I returned it two weeks ago.</p>",
      author: { type: "user", email: "dana@example.com" },
      created_at: 1759312800,
    },
    { id: "2", part_type: "assignment", body: null, author: { type: "admin", name: "Ray" } },
    {
      id: "3",
      part_type: "note",
      body: "<p>Return scanned Oct 3.</p>",
      author: { type: "admin", name: "Ray", email: "ray@shop.com" },
    },
    { id: "4", part_type: "comment", body: "<p>Hi! Let me check.</p>", author: { type: "bot", name: "Fin" } },
  ],
  fields: {},
  url: null,
};

const settings = { ...DEFAULT_SETTINGS, requireReason: false };
const base = {
  conversation,
  draftFields: {},
  reasonCode: null as string | null,
  reason: "",
  actor: "ray@shop.com",
  settings,
};

describe("settings", () => {
  it("support pack and require_reason by default", () => {
    expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.reasonPack).toBe("support");
    expect(quickReasons(DEFAULT_SETTINGS).map((r) => r.code)).toContain("should_escalate");
    expect(quickReasons(settingsFrom({ reason_pack: "claims" })).map((r) => r.code)).toContain(
      "missed_exclusion",
    );
  });
  it("parses fields and base url", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      decision_fields: "refund_status:status, tier",
      require_reason: "false",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.requireReason).toBe(false);
    expect(fieldsFrom({ refund_status: "issued" }, s)).toEqual({ status: "issued", tier: null });
  });
});

describe("draft origin", () => {
  it("only ai or manual when told; anything else is unknown", () => {
    expect(originFrom("ai")).toBe("ai");
    expect(originFrom("manual")).toBe("manual");
    expect(originFrom("fin?")).toBe("unknown");
    expect(originFrom(undefined)).toBe("unknown");
  });
  it("a short greeting is not a draft", () => {
    expect(acceptDraft("Hi Dana,", "ai", DEFAULT_SETTINGS, 1)).toBeNull();
    expect(acceptDraft(draftText, "ai", DEFAULT_SETTINGS, 1)?.origin).toBe("ai");
  });
});

describe("context", () => {
  it("keeps bodies, drops event parts, maps roles", () => {
    expect(contextFrom(conversation)).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "I returned it two weeks ago.",
        at: "2025-10-01T10:00:00.000Z",
      },
      { role: "note", author: "ray@shop.com", content: "Return scanned Oct 3.", at: null },
      { role: "system", author: "Fin", content: "Hi! Let me check.", at: null },
    ]);
  });
});

describe("decideOnSend", () => {
  const draft = { text: draftText, origin: "ai" as const, at: 1 };

  it("skips without a draft, on notes, and on empty sends", () => {
    expect(decideOnSend({ ...base, draft: null, send: { text: "x", type: "reply", fields: {} } })).toEqual({
      action: "skip",
      why: "no-draft",
    });
    expect(decideOnSend({ ...base, draft, send: { text: "x", type: "note", fields: {} } })).toEqual({
      action: "skip",
      why: "internal-note",
    });
    expect(decideOnSend({ ...base, draft, send: { text: "<p> </p>", type: "reply", fields: {} } })).toEqual({
      action: "skip",
      why: "empty",
    });
  });

  it("an unchanged send is an approve with source intercom and ic: externalId, tagged draft:ai", () => {
    const d = decideOnSend({ ...base, draft, send: { text: draftText, type: "reply", fields: {} } });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("intercom");
    expect(d.body.externalId).toBe("ic:215469913");
    expect(d.body.tags).toEqual(["draft:ai", "public-reply"]);
    expect(d.body.reasonCode).toBeNull();
    expect(d.body.context).toHaveLength(3);
  });

  it("a hand-written draft is draft:manual; an untold origin carries no draft tag", () => {
    const manual = decideOnSend({
      ...base,
      draft: { ...draft, origin: "manual" },
      send: { text: draftText, type: "reply", fields: {} },
    });
    if (manual.action !== "capture") throw new Error(manual.action);
    expect(manual.body.tags).toEqual(["draft:manual", "public-reply"]);
    const unknown = decideOnSend({
      ...base,
      draft: { ...draft, origin: "unknown" },
      send: { text: draftText, type: "reply", fields: {} },
    });
    if (unknown.action !== "capture") throw new Error(unknown.action);
    expect(unknown.body.tags).toEqual(["public-reply"]);
  });

  it("a changed reply carries the reason; require_reason holds it without one", () => {
    const sent = draftText.replace("5 business days", "10 business days");
    const ok = decideOnSend({
      ...base,
      draft,
      reasonCode: "wrong_amount_or_date",
      reason: "Bank takes 10",
      send: { text: sent, type: "reply", fields: {} },
    });
    if (ok.action !== "capture") throw new Error(ok.action);
    expect(ok.changed).toBe(true);
    expect(ok.body.reasonCode).toBe("wrong_amount_or_date");
    expect(ok.body.reason).toBe("Bank takes 10");
    const strict = { ...base, settings: DEFAULT_SETTINGS };
    expect(decideOnSend({ ...strict, draft, send: { text: sent, type: "reply", fields: {} } })).toEqual({
      action: "need-reason",
      changedFields: [],
    });
    expect(
      decideOnSend({ ...strict, draft, reason: "note only", send: { text: sent, type: "reply", fields: {} } })
        .action,
    ).toBe("need-reason");
  });

  it("decision fields are compared exactly", () => {
    const s = { ...settings, decisionFields: [{ id: "refund_status", label: "status" }] };
    const d = decideOnSend({
      ...base,
      settings: s,
      draft,
      draftFields: { status: "pending" },
      reasonCode: "wrong_answer",
      send: { text: draftText, type: "reply", fields: { status: "issued" } },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.changedFields).toEqual(["status"]);
    expect(d.body.sent.fields).toEqual({ status: "issued" });
  });

  it("records seconds to send and the recorded run", () => {
    const d = decideOnSend({
      ...base,
      draft: { ...draft, at: 10_000, runId: "0199a0d0-0000-7000-8000-000000000000", model: "gpt-4.1-mini" },
      now: 14_250,
      send: { text: draftText, type: "reply", fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.secondsToSend).toBe(4.3);
    expect(d.body.draftRunId).toBe("0199a0d0-0000-7000-8000-000000000000");
  });
});

describe("statusLine", () => {
  it("shows Draft inserted · N words", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine({ text: "<p>one two three</p>", origin: "ai", at: 1 }, null)).toBe(
      "Draft inserted · 3 words",
    );
    expect(statusLine(null, { changed: false, dedup: false })).toBe("Sent as drafted · approved");
  });
});
