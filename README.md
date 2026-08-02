# Autovox

Chrome extension that digests the current web page into a spoken **news report**.

It sits between a summary and raw text-to-speech: an LLM **comprehension** pass rewrites the article into broadcast-style prose, then `gpt-audio-mini` streams PCM narration so playback can start before the full report is synthesized.

Visual language: **Wire Meter** — see [DESIGN.md](./DESIGN.md).

## Features

- On-page overlay player (toolbar icon toggles it)
- **Play starts the brief** when idle — one transport control
- Progressive scrubber (buffered + played), seek within downloaded audio
- In-memory PCM cache for replay without re-calling TTS
- OpenRouter OAuth (preferred) or OpenAI API key fallback
- Voice and report length in Options only

## Stack

- [WXT](https://wxt.dev/) + React + TypeScript
- Mozilla Readability for article extraction
- OpenAI `gpt-5.6-luna` (understanding) + `gpt-audio-mini` (voice), via OpenRouter or direct OpenAI

## Develop

```bash
pnpm install
pnpm dev
```

1. Open `chrome://extensions`
2. Enable Developer mode
3. Load unpacked → `.output/chrome-mv3-dev`
4. Open **Options** → Connect with OpenRouter (or paste an OpenAI API key)
5. Open an article → click the extension icon → press **play**

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Dev build + reload |
| `pnpm build` | Production build |
| `pnpm compile` | Typecheck |
| `pnpm zip` | Chrome Web Store zip |
| `pnpm submit:chrome` | Submit zip via `wxt submit` (needs `.env.submit` or env vars) |

## Privacy & permissions

See [PRIVACY.md](./PRIVACY.md).

API keys and OpenRouter credentials stay in `chrome.storage.local` on your profile. Page text is sent only to the AI provider you configure. Autovox has no backend.

Page access uses `activeTab` + `scripting` when you click the toolbar icon — not a persistent `<all_urls>` host permission. Declared hosts are only OpenRouter and OpenAI.

## Publishing (Chrome Web Store)

First listing must be created manually in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/developer/dashboard):

1. Create the Autovox item (description, screenshots, privacy policy URL pointing at this repo’s [PRIVACY.md](./PRIVACY.md) on `main`).
2. Upload the first package: `pnpm zip` → `.output/*-chrome.zip`.
3. Locally run `pnpm wxt submit init` to produce `.env.submit` (gitignored).
4. Add these **GitHub Actions secrets** to the repo:

   - `CHROME_EXTENSION_ID`
   - `CHROME_CLIENT_ID`
   - `CHROME_CLIENT_SECRET`
   - `CHROME_REFRESH_TOKEN`

5. Bump `version` in `package.json`, then run **Release Chrome** (`workflow_dispatch`). Start with `dry_run: true` to verify secrets, then `false` to upload. Set `skip_review: true` to upload a draft without submitting for review.

CI (compile + build) runs on every push and PR to `main`.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © tsjnsn
