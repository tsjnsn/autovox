# Development

Requires [pnpm](https://pnpm.io/) 11 (`packageManager` in `package.json`; enable via Corepack: `corepack enable`). Project settings live in [`pnpm-workspace.yaml`](../pnpm-workspace.yaml).

```bash
pnpm install
pnpm dev
```

1. Open `chrome://extensions`
2. Enable Developer mode
3. Load unpacked → `.output/chrome-mv3-dev`
4. Open **Options** → Connect with OpenRouter (or paste an OpenAI API key)
5. Open an article → click the extension icon → press **play**, or right-click the page → **Vox this page**
6. In **Options**, set voice, output language, and report length as needed

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Dev build + reload |
| `pnpm build` | Production build |
| `pnpm compile` | Typecheck |
| `pnpm zip` | Chrome Web Store zip |
| `pnpm submit:chrome` | Submit zip via `wxt submit` (needs `.env.submit` or env vars) |
| `pnpm release <version>` | Bump version, tag, and push (triggers Release workflow) — see [publishing](publishing.md) |

Firefox variants: `pnpm dev:firefox`, `pnpm build:firefox`, `pnpm zip:firefox`.

## Stack

- [WXT](https://wxt.dev/) + React + TypeScript
- Mozilla Readability for article extraction
- OpenAI `gpt-5.6-luna` (understanding) + `gpt-audio-mini` (voice), via OpenRouter or direct OpenAI

Visual language: **Wire Meter** — see [DESIGN.md](../DESIGN.md).

## Auth for local testing

Use **Connect with OpenRouter** in Options, or paste an OpenAI API key as fallback. Keys stay in `chrome.storage.local` on your profile.
