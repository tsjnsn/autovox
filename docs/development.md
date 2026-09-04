# Development

Requires [pnpm](https://pnpm.io/) 11 (`packageManager` in `package.json`; enable via Corepack: `corepack enable`). Project settings live in [`pnpm-workspace.yaml`](../pnpm-workspace.yaml).

```bash
pnpm install
pnpm convex:dev
pnpm dev
```

1. Open `chrome://extensions`
2. Enable Developer mode
3. Load unpacked → `.output/chrome-mv3-dev`
4. Open **Options** → use managed trial credits when configured, connect OpenRouter, or paste an OpenAI key
5. Open an article → click the extension icon → press **play**, or right-click the page → **Vox this page**
6. In **Options**, set voice, output language, and report length as needed

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Dev build + reload |
| `pnpm build` | Production build |
| `pnpm compile` | Typecheck |
| `pnpm lint` | ESLint, including Convex validators/index/await rules |
| `pnpm test` | Money and deterministic-operator invariants |
| `pnpm check` | Lint + typecheck + tests + production build |
| `pnpm convex:dev` | Isolated Convex development backend (agent mode) |
| `pnpm convex:check` | Generate/validate Convex functions once |
| `pnpm zip` | Chrome Web Store zip |
| `pnpm submit:chrome` | Submit zip via `wxt submit` (needs `.env.submit` or env vars) |
| `pnpm release <version>` | Bump version, tag, and push (triggers Release workflow) — see [publishing](publishing.md) |
| `pnpm pulse` | Snapshot public Chrome Web Store users / rating / reviews into `store/pulse.*` (acquisition only) |
| `pnpm money-pulse` | Company spend snapshot from OpenRouter analytics when `OPENROUTER_MANAGEMENT_KEY` is set — see [flywheel](flywheel.md) |
| `pnpm economics-pulse` | Fetch aggregate revenue/COGS/outcomes and emit the bounded operator decision |

Firefox variants: `pnpm dev:firefox`, `pnpm build:firefox`, `pnpm zip:firefox`.

## Stack

- [WXT](https://wxt.dev/) + React + TypeScript
- Mozilla Readability for article extraction
- OpenAI `gpt-5.6-luna` (understanding) + `gpt-audio-mini` (voice), via OpenRouter or direct OpenAI
- Convex control plane + Clerk authentication + Stripe-hosted credit checkout (managed builds only)

Visual language: **Wire Meter** — see [DESIGN.md](../DESIGN.md).

## Auth for local testing

BYOK testing: use **Connect with OpenRouter** in Options, or paste an OpenAI API key. Keys stay in `chrome.storage.local`.

Managed testing: follow [managed-listening.md](managed-listening.md). The public WXT variables enable the UI; server secrets belong only in Convex.
