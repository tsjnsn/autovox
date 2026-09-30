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
   - For a tutorial, click **Chalkboard** in the overlay (or right-click → **Chalkboard this page**) to get a narrated chalkboard lesson
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
| `pnpm eval:chalk` | Compare writing and drawing models on one page, judged blind by Claude Opus — see [Chalkboard model eval](#chalkboard-model-eval) |

Firefox variants: `pnpm dev:firefox`, `pnpm build:firefox`, `pnpm zip:firefox`.

## Stack

- [WXT](https://wxt.dev/) + React + TypeScript
- Mozilla Readability for article extraction
- OpenAI `gpt-6-luna` (understanding) + `gpt-6-sol` (chalkboard drawing) + `gpt-audio-mini` (voice) by default, via OpenRouter or direct OpenAI; BYOK users can pick other models from the live list in Options. Managed credits draw with `gpt-6-luna`.
- [mediabunny](https://mediabunny.dev/) (MPL-2.0) + WebCodecs for chalkboard video export, entirely in the browser
- Convex control plane + Clerk authentication + Stripe-hosted credit checkout (managed builds only)

Visual language: **Wire Meter** — see [DESIGN.md](../DESIGN.md).

## Auth for local testing

BYOK testing: use **Connect with OpenRouter** in Options, or paste an OpenAI API key. Keys stay in `chrome.storage.local`.

Managed testing: follow [managed-listening.md](managed-listening.md). The public WXT variables enable the UI; server secrets belong only in Convex.

## Chalkboard model eval

`pnpm eval:chalk` writes a lesson plan with each writing model, draws one lesson's boards with each drawing model, and has Claude Opus judge the results blind (shuffled, from rendered board images). It spends real money on your key: put `OPENROUTER_API_KEY` in `.env`. The last run (10 writers, 10 drawers, one judge pass) cost about $1.20 at list prices. Needs Chrome installed for the board images.

The page is a saved article, not a URL: a JSON file in the shape the extension extracts (`ExtractedArticle` in `utils/types.ts`: `title`, `url`, `textContent`, …). The default, `.eval/pages/econ-augment.json`, is local only (`.eval/` is gitignored), so pass `--page` on a fresh clone.

```bash
pnpm eval:chalk --page .eval/pages/my-tutorial.json --drawers openai/gpt-6-sol,google/gemini-3.8-flash
pnpm eval:chalk --extend .eval/chalk/<run> --drawers anthropic/claude-sonnet-5.5   # add a model to an earlier run and re-judge together
pnpm eval:chalk --judge-only .eval/chalk/<run> --judge-passes 2
```

Results land in `.eval/chalk/<timestamp>/`, including `index.html`, a blind side-by-side viewer with a reveal button. Other flags: `--writers` (comma-separated model IDs), `--skip-writing` with `--plan-file <results.json>` or `--plan-from <writer>` to choose which lesson gets drawn, `--reps`, `--length`, `--judge <model|none>`, and `--render-only <run>` to rebuild the viewer. Each board streams with live token counts, an idle timeout, and a runaway-reasoning guard, so a stalled host fails fast instead of hanging.

`pnpm exec tsx scripts/chalk-eval/ping.ts [model,model,…]` sends each model one tiny request with the extension's routing preferences and prints the host, latency, tokens, and cost — a quick check before a full run.

The picks, quality bars, and notes in the Options model picker (`MODEL_PICKS` in `utils/models.ts`) follow the latest eval.
