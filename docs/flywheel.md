# Autovox flywheel — money is the data

A flywheel needs a dataset that compounds. Store-user counts and star ratings are acquisition vanity. The dataset that can improve Autovox is **economic events**: dollars in, outcome out.

```
user spends $ on a brief
    → Autovox records $ / outcome / model / length / voice  (never page text)
    → product changes what people keep paying for
    → more completed briefs, less wasted $
    → denser money data
```

Today each brief is paid by the user (BYOK: OpenRouter or a pasted OpenAI key). The ledger still lives **on this browser profile**. Autovox has no backend and does not ingest spend. The schema is the flywheel; sitting on the payment rail is how the company later sees the same events.

## What is recorded

Each brief (and each TTS remount that actually hits the API) writes a money event to `chrome.storage.local` (`autovoxMoneyLedger`):

| Field | Why it is money-data |
| --- | --- |
| `costUsd` + line items (`understand`, `tts`) | What the brief cost |
| `outcome` (`completed` / `fault` / `aborted`) | Whether the dollars produced a listen |
| `faultStage` (`extract` / `understand` / `tts`) | Where money was wasted |
| `reportLength`, `voice`, `outputLanguage`, `authMode` | What configuration people pay for |

**Never stored:** URL, title, article text, keys.

OpenRouter responses include `usage.cost`. If a stream omits it, Autovox asks `GET /api/v1/generation?id=`. A pasted OpenAI key usually has tokens but no USD — those events stay `costKnown: false`.

The readout is **Options → Spend**, not the overlay. Cache replay inside an already-open player does not double-count. Closing the overlay and hearing the script again *does* spend TTS again; that is a new event.

## Two layers

| Layer | Dataset | Who can see it |
| --- | --- | --- |
| **Money ledger (this is the flywheel)** | $ per brief, waste, completed average | The user, on-device. Company: only after Autovox pays. |
| **Store pulse (acquisition only)** | Public CWS users / rating / reviews | Anyone. `pnpm pulse` → `store/pulse.*` |

Do **not** complete the flywheel with GA4, PostHog, or any in-extension product telemetry. That would break [PRIVACY.md](../PRIVACY.md) and the CWS “no data collection” declaration. Do not put spend on the Wire Meter faceplate ([DESIGN.md](../DESIGN.md)).

## Company pulse (Autovox on the rail)

BYOK means the dollars and the learning go to OpenRouter. Company-level compounding needs Autovox **on the payment rail**:

1. Autovox-owned OpenRouter keys (users no longer paste their own inference key)
2. An OpenRouter **management key** (inference keys get 403 on analytics)
3. Optional later: Autovox billing so margin is first-party

When `OPENROUTER_MANAGEMENT_KEY` is set:

```bash
pnpm money-pulse
```

queries `POST /api/v1/analytics/query` and writes `store/money-pulse.json`. Without that key the script exits cleanly and records that the company rail is not live. Never commit the management key.

## Store pulse (keep, but do not steer product by it)

```bash
pnpm pulse
```

Still snapshots the public listing into [`store/pulse.json`](../store/pulse.json). Use it for discovery and listing conversion — not for “what to build next.” What to build next is: lower `$ wasted on faults`, lower `$ per completed brief`, keep configurations people actually pay for.

## Close the loop with a Cursor Automation

Create a scheduled or issue-triggered [Cursor Automation](https://cursor.com/automations) on `tsjnsn/autovox` with a prompt like:

```
You are closing Autovox's money flywheel. Read docs/flywheel.md, DESIGN.md,
PRIVACY.md, and store/money-pulse.json if it exists. Store pulse
(store/pulse.*) is acquisition only.

Rules:
- Money is the data. Optimize wasted $ on faults and $ per completed brief.
- Do not add in-extension analytics, new host permissions, or a backend
  unless the change is Autovox sitting on the OpenRouter payment rail.
- Prefer borrowed media UX over dashboard chrome (DESIGN.md).
- Spend belongs in Options, never on the overlay faceplate.
- If users are low and reviews are empty, listing conversion is an
  acquisition task — do not confuse it with the money flywheel.
- Keep page text off every spend record.

Ship a small PR. Say what dollar outcome you expect.
```

## First-run reality (2026-09)

The listing is live at version 0.2.0 with a handful of public users. Until Autovox owns spend, the flywheel’s job is to **record every dollar this profile already pays** so the next product change has a cost function. Store counts will not tell you if a model, voice, or length change was worth it.
