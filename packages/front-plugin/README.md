# Overturn for Front

QA for AI-drafted replies, in the Front sidebar. It watches the composer for an AI draft, diffs it against what the teammate actually sends, asks for a one-line reason, and posts the result to `POST /v1/capture` with `source: "front"` and `externalId: "fr:<conversation id>"`.

## What the teammate sees

- **Draft inserted · N words** once an AI assist, macro or paste lands in the composer. A drafting agent that recorded its run with the Overturn SDK (`externalId: "fr:<conversation id>"`) is found automatically. "Use the current text as the draft" marks it by hand.
- A **reason** picker (`reason_pack`: `support` by default, or `claims`) and an optional note.
- On **send**, sent as drafted is an approve; changed is an edit. With `require_reason` on, a changed reply's capture is held in the panel until a reason chip is picked.

Front's Plugin SDK has no pre-send veto. Native Send is never blocked. A failed capture logs in the panel and gets out of the way.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build: `pnpm --filter @overturn-ai/front-plugin build` → `dist/overturn-front-plugin.zip` (or host `dist/plugin/`).
3. In Front: Settings → Company → Developers → Create app → Features → Sidebar Plugin. Set the Side panel URL to where you host `index.html`.
4. Preferred: configure a Front app server so `relayHttp` attaches the bearer token server-side (no key in the browser). Alternatively append `?overturn_api_key=…` to the plugin URL (less ideal).

Other query params (same names as the Zendesk app): `agent`, `reason_pack`, `require_reason`, `decision_fields`, `scope_tag`, `min_draft_chars`, `overturn_base_url`.

## Development

```bash
pnpm --filter @overturn-ai/front-plugin test
pnpm --filter @overturn-ai/front-plugin build
```

`src/capture.ts` is the logic (pure, tested); `src/main.ts` is the Front Plugin SDK glue; `plugin/` is the hosted shell.
