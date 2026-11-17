# Overturn for Intercom

QA for AI-drafted replies, in the Intercom inbox. A Canvas Kit app in the conversation details panel keeps the draft, a one-click reason and an optional note; Intercom's `conversation.admin.replied` webhook brings the reply that actually went out. The diff is posted to `POST /v1/capture` with `source: "intercom"` and `externalId: "ic:<conversation id>"`.

## What the teammate sees

- **Draft inserted · N words** once there is a draft. A drafting agent that recorded its run with the Overturn SDK (`externalId: "ic:<conversation id>"`) is found automatically. Otherwise the teammate pastes the draft and says who wrote it.
- A **reason** picker (`support` pack by default, `claims` with `OVERTURN_REASON_PACK=claims`) and an optional note.
- When the reply goes out: sent as drafted is an approve; changed is an edit. With `require_reason` on (default), a changed reply's capture waits in the panel until a reason is picked.

Intercom's send is never held, and a failed capture only shows a note in the panel.

### Draft origin

Fin drafts and human-written replies must be told apart, and guessing is worse than not knowing:

| How the draft got here | Tag |
| --- | --- |
| A drafting agent recorded the run with the SDK | `draft:ai` |
| Teammate pasted it and picked "Fin / AI assist" | `draft:ai` |
| Teammate picked "I wrote it" | `draft:manual` |
| Teammate picked "Not sure" | no `draft:*` tag (the API reports `unknown`) |

Canvas Kit apps cannot read the composer, so nothing is inferred from the text.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build and deploy: `pnpm --filter @overturn-ai/intercom-app build` → `dist/overturn-intercom-app.zip` (or `dist/app/`). Run it with `node main.js` on any HTTPS host.
3. In the Intercom Developer Hub, create an app:
   - **Canvas Kit → For teammates → Conversation details**: Initialize URL `https://<host>/initialize`, Submit URL `https://<host>/submit`.
   - **Webhooks**: `https://<host>/webhook`, topics `conversation.admin.replied` (and `conversation.admin.noted` with internal notes on).
4. Environment:
   - `OVERTURN_API_KEY` (required, stays on the server)
   - `INTERCOM_CLIENT_SECRET` checks Intercom's `X-Body-Signature` / `X-Hub-Signature`
   - `INTERCOM_ACCESS_TOKEN` (optional) reads the whole thread for context; without it the webhook's parts are used
   - `INTERCOM_WORKSPACE_ID` (optional) adds a link from the run page back to the conversation
   - `OVERTURN_AGENT` (default `support-reply`), `OVERTURN_REASON_PACK`, `OVERTURN_REQUIRE_REASON`, `OVERTURN_CAPTURE_INTERNAL_NOTES`, `OVERTURN_DECISION_FIELDS` (conversation attributes as `attr:label`), `OVERTURN_MIN_DRAFT_CHARS`, `OVERTURN_BASE_URL`, `PORT`

The default store is in memory (one process). For several instances, pass a shared `Store` to `createApp`.

## Development

```bash
pnpm --filter @overturn-ai/intercom-app test
pnpm --filter @overturn-ai/intercom-app build
```

`src/capture.ts` holds the logic (pure, tested). `src/app.ts` handles the Canvas Kit and webhook requests (tested with a mocked Overturn API), and `src/main.ts` is the Node server.
