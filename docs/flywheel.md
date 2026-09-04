# Autovox flywheel — money is the data

A flywheel needs a dataset that compounds. Store-user counts and star ratings are acquisition vanity. The dataset that can improve Autovox is **economic events**: dollars in, outcome out.

```
user spends $ on a brief
    → Autovox records $ / outcome / model / length / voice  (never page text)
    → product changes what people keep paying for
    → more completed briefs, less wasted $
    → denser money data
```

BYOK remains available, but it cannot make Autovox money. Managed listening adds the company rail: trial credits, Stripe purchases, Autovox-funded OpenRouter sessions, and authoritative provider-cost reconciliation.

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
| **Managed economics (this is the flywheel)** | Settled revenue, provider COGS, completion, fault waste, credits | Autovox control plane; aggregates only reach the operator. |
| **BYOK money ledger** | $ per brief, waste, completed average | The user, on-device only. |
| **Store pulse (acquisition only)** | Public CWS users / rating / reviews | Anyone. `pnpm pulse` → `store/pulse.*` |

Do **not** add GA4, PostHog, or generic in-extension telemetry. Managed mode collects a strict lifecycle state machine and financial records only; its complete data boundary is in [PRIVACY.md](../PRIVACY.md). Do not put spend on the Wire Meter faceplate ([DESIGN.md](../DESIGN.md)).

## Company rail

Managed mode is deliberately bounded:

1. Clerk authenticates a managed account.
2. Convex reserves customer credits and the global provider budget transactionally.
3. Convex creates a short-lived OpenRouter key capped to the session.
4. The extension sends page content directly to OpenRouter with ZDR enforced.
5. Terminal state disables the key; Convex reconciles provider truth and deletes it.
6. Stripe webhooks grant purchased credits and record settled revenue/refunds.

The first offer is 3 trial credits and a one-time 100-credit pack. Subscription is a later decision only after repeat purchases prove recurring demand. See [managed-listening.md](managed-listening.md) for the one-time launch setup.

## Deterministic operator

The daily operator reads only aggregate economics:

```bash
pnpm economics-pulse
```

It writes:

- [`store/economics.json`](../store/economics.json) — aggregate machine input
- [`store/decision.md`](../store/decision.md) — one bounded decision packet

The decision order is code, not an LLM:

1. frozen budget / reconciliation failure → stop
2. no managed trial starts → acquisition
3. 10 trials and no payment → paid conversion
4. completion below 85% → reliability
5. contribution margin below 60% → cost
6. insufficient evidence → hold

An agent may implement the decision. It cannot choose the budget, expand data collection, change processors, add permissions, or invent work when the decision is `hold`.

## Store pulse (acquisition only)

```bash
pnpm pulse
```

Still snapshots the public listing into [`store/pulse.json`](../store/pulse.json). Use it for discovery and listing conversion — not for “what to build next.” What to build next is: lower `$ wasted on faults`, lower `$ per completed brief`, keep configurations people actually pay for.

## Close the loop with a Cursor Automation

Create a scheduled or issue-triggered [Cursor Automation](https://cursor.com/automations) on `tsjnsn/autovox` with a prompt like:

```
You are the bounded Autovox operator. Read docs/flywheel.md, DESIGN.md,
PRIVACY.md, store/economics.json, and store/decision.md. Store pulse is
acquisition context only.

Rules:
- Implement only the objective and allowed paths in store/decision.md.
- If action is hold or stop, do not create a product PR.
- Optimize gross profit from completed listening.
- Do not increase budgets, prices, permissions, processors, or data fields.
- Never collect URL, title, page text, prompts, scripts, audio, or raw errors.
- Prefer borrowed media UX over dashboard chrome (DESIGN.md).
- Spend belongs in Options, never on the overlay faceplate.
- One active experiment and one focused PR at a time.
- Add tests, rollback conditions, evidence denominators, and expected dollars.

Ship only after CI passes. Never bypass a frozen budget.
```

## First-run reality (2026-09)

The listing is live at version 0.2.0 with a handful of public users. The first milestone is **10 settled, unrefunded credit-pack purchases**. At this sample size the operator reports counts, not statistical theater, and runs at most one reversible change at a time.
