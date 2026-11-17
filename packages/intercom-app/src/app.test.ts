import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createApp,
  type HttpRequest,
  memoryStore,
  type Overturn,
  renderCanvas,
  verifySignature,
} from "./app";
import { DEFAULT_SETTINGS } from "./capture";

const SECRET = "shh";
const draft =
  "Hi Dana, your refund for order #1042 was issued today and should land in 5 business days. Sorry for the wait.";

function signed(path: string, body: unknown, kind: "canvas" | "hook" = "canvas"): HttpRequest {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> =
    kind === "canvas"
      ? { "x-body-signature": createHmac("sha256", SECRET).update(raw).digest("hex") }
      : { "x-hub-signature": `sha1=${createHmac("sha1", SECRET).update(raw).digest("hex")}` };
  return { method: "POST", path, headers, body: raw };
}

function fakeOverturn(runs: Array<{ id: string; output: unknown }> = [], fail = false) {
  const posts: unknown[] = [];
  const api: Overturn = {
    get: async <T>() => ({ items: runs }) as T,
    post: async <T>(_path: string, body: unknown) => {
      if (fail) throw Object.assign(new Error("down"), { status: 503 });
      posts.push(body);
      return { changed: true, deduplicated: false, kind: "edit", case: { title: "x" } } as T;
    },
  };
  return { api, posts };
}

const reply = (text: string) => ({
  topic: "conversation.admin.replied",
  data: {
    item: {
      id: "77",
      title: "Refund",
      source: {
        id: "s",
        body: "<p>Where is my refund?</p>",
        author: { type: "user", email: "dana@example.com" },
      },
      conversation_parts: {
        conversation_parts: [
          {
            id: "p9",
            part_type: "comment",
            body: `<p>${text}</p>`,
            author: { type: "admin", email: "ray@shop.com" },
          },
        ],
      },
    },
  },
});

const components = (r: { body: unknown }) =>
  (r.body as { canvas: { content: { components: Array<{ id?: string; text?: string }> } } }).canvas.content
    .components;

describe("signatures", () => {
  it("accepts Canvas Kit and webhook signatures, rejects others", () => {
    expect(verifySignature(signed("/x", { a: 1 }), SECRET)).toBe(true);
    expect(verifySignature(signed("/x", { a: 1 }, "hook"), SECRET)).toBe(true);
    expect(
      verifySignature(
        { method: "POST", path: "/x", headers: { "x-body-signature": "nope" }, body: "{}" },
        SECRET,
      ),
    ).toBe(false);
    expect(verifySignature({ method: "POST", path: "/x", headers: {}, body: "{}" }, SECRET)).toBe(false);
  });
  it("401s an unsigned request", async () => {
    const app = createApp({
      settings: DEFAULT_SETTINGS,
      store: memoryStore(),
      overturn: fakeOverturn().api,
      clientSecret: SECRET,
    });
    expect((await app({ method: "POST", path: "/initialize", headers: {}, body: "{}" })).status).toBe(401);
  });
});

describe("panel + webhook flow", () => {
  it("a recorded run is the draft (draft:ai); an unchanged reply posts an approve", async () => {
    const ov = fakeOverturn([{ id: "0199a0d0-0000-7000-8000-000000000000", output: draft }]);
    const app = createApp({
      settings: DEFAULT_SETTINGS,
      store: memoryStore(),
      overturn: ov.api,
      clientSecret: SECRET,
      now: () => 1000,
    });
    const init = await app(signed("/initialize", { conversation: { id: "77" } }));
    expect(components(init)[0]?.text).toMatch(/^Draft inserted · \d+ words$/);
    const r = await app(signed("/webhook", reply(draft), "hook"));
    expect(r.body).toEqual({ ok: true, captured: true });
    const body = ov.posts[0] as {
      source: string;
      externalId: string;
      tags: string[];
      draftRunId: string;
      context: unknown[];
    };
    expect(body.source).toBe("intercom");
    expect(body.externalId).toBe("ic:77");
    expect(body.tags).toContain("draft:ai");
    expect(body.draftRunId).toBe("0199a0d0-0000-7000-8000-000000000000");
    expect(body.context).toHaveLength(1);
  });

  it("a pasted draft keeps the origin the teammate gave; a changed reply is held until a reason", async () => {
    const ov = fakeOverturn();
    const app = createApp({
      settings: DEFAULT_SETTINGS,
      store: memoryStore(),
      overturn: ov.api,
      clientSecret: SECRET,
    });
    await app(
      signed("/submit", {
        conversation: { id: "77" },
        component_id: "save_draft",
        input_values: { draft, origin: "manual" },
      }),
    );
    const held = await app(signed("/webhook", reply(draft.replace("5", "10")), "hook"));
    expect(held.body).toEqual({ ok: true, held: true });
    expect(ov.posts).toHaveLength(0);
    const panel = await app(signed("/initialize", { conversation: { id: "77" } }));
    expect(components(panel)[0]?.text).toBe("Pick why you changed the reply");
    await app(
      signed("/submit", {
        conversation: { id: "77" },
        component_id: "save_reason",
        input_values: { reason_code: "wrong_amount_or_date", note: "10 days" },
      }),
    );
    const body = ov.posts[0] as { reasonCode: string; reason: string; tags: string[] };
    expect(body.reasonCode).toBe("wrong_amount_or_date");
    expect(body.reason).toBe("10 days");
    expect(body.tags).toEqual(["draft:manual", "public-reply"]);
  });

  it("a conversation without a draft is never captured", async () => {
    const ov = fakeOverturn();
    const app = createApp({
      settings: DEFAULT_SETTINGS,
      store: memoryStore(),
      overturn: ov.api,
      clientSecret: SECRET,
    });
    expect((await app(signed("/webhook", reply(draft), "hook"))).body).toEqual({
      ok: true,
      skipped: "no-draft",
    });
    expect(ov.posts).toHaveLength(0);
  });

  it("a failed capture is acknowledged and reported in the panel", async () => {
    const ov = fakeOverturn([], true);
    const app = createApp({
      settings: { ...DEFAULT_SETTINGS, requireReason: false },
      store: memoryStore(),
      overturn: ov.api,
      clientSecret: SECRET,
    });
    await app(
      signed("/submit", {
        conversation: { id: "77" },
        component_id: "save_draft",
        input_values: { draft, origin: "ai" },
      }),
    );
    const r = await app(signed("/webhook", reply(draft), "hook"));
    expect(r.status).toBe(200);
    const panel = await app(signed("/initialize", { conversation: { id: "77" } }));
    expect(components(panel).some((c) => c.text?.includes("could not save"))).toBe(true);
  });

  it("the panel offers the support reasons once there is a draft", () => {
    const c = renderCanvas(
      {
        draft: { text: draft, origin: "unknown", at: 1 },
        draftFields: {},
        reasonCode: null,
        reason: "",
        held: null,
        lastResult: null,
        message: "",
      },
      DEFAULT_SETTINGS,
    ).canvas.content.components as Array<{ id?: string; options?: Array<{ id: string }> }>;
    expect(c.find((x) => x.id === "reason_code")?.options?.map((o) => o.id)).toContain("wrong_answer");
  });
});
