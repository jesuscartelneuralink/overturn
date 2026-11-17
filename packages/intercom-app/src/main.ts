import { createServer } from "node:http";
import { createApp, type IntercomConversation, memoryStore, type Overturn } from "./app";
import { settingsFrom } from "./capture";

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

const env = process.env;
const settings = settingsFrom({
  overturn_base_url: env.OVERTURN_BASE_URL,
  agent: env.OVERTURN_AGENT,
  reason_pack: env.OVERTURN_REASON_PACK,
  require_reason: env.OVERTURN_REQUIRE_REASON,
  capture_internal_notes: env.OVERTURN_CAPTURE_INTERNAL_NOTES,
  decision_fields: env.OVERTURN_DECISION_FIELDS,
  min_draft_chars: env.OVERTURN_MIN_DRAFT_CHARS,
});
const apiKey = env.OVERTURN_API_KEY;
if (!apiKey) throw new Error("OVERTURN_API_KEY is required");

const call = async <T>(url: string, init: RequestInit, auth: string): Promise<T> => {
  const r = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
  if (!r.ok) throw new HttpError(r.status);
  return (await r.json()) as T;
};
const overturn: Overturn = {
  get: (path) => call(`${settings.baseUrl}${path}`, { method: "GET" }, apiKey),
  post: (path, body) =>
    call(`${settings.baseUrl}${path}`, { method: "POST", body: JSON.stringify(body) }, apiKey),
};
const token = env.INTERCOM_ACCESS_TOKEN;

const app = createApp({
  settings,
  store: memoryStore(),
  overturn,
  clientSecret: env.INTERCOM_CLIENT_SECRET ?? null,
  workspaceId: env.INTERCOM_WORKSPACE_ID ?? null,
  ...(token
    ? {
        fetchConversation: (id: string) =>
          call<IntercomConversation>(
            `https://api.intercom.io/conversations/${encodeURIComponent(id)}?display_as=plaintext`,
            { method: "GET" },
            token,
          ),
      }
    : {}),
  log: (m) => console.warn(`[overturn-intercom] ${m}`),
});

const port = Number(env.PORT ?? 8787);
createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
    void app({
      method: req.method ?? "GET",
      path: (req.url ?? "/").split("?")[0]!,
      headers,
      body: Buffer.concat(chunks).toString("utf8"),
    }).then((r) => {
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
}).listen(port, () => console.log(`overturn-intercom listening on :${port}`));
