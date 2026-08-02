# Contributing to Autovox

Thanks for helping improve Autovox.

## Setup

```bash
pnpm install
pnpm dev
```

Load the unpacked extension from `.output/chrome-mv3-dev` in `chrome://extensions` (Developer mode on).

## Checks before a PR

```bash
pnpm compile
pnpm build
```

CI runs the same compile + build steps on every push and pull request to `main`.

## Guidelines

- Keep the overlay player-first (see [DESIGN.md](./DESIGN.md)). Preferences belong in Options.
- Prefer small, focused PRs.
- **Never paste API keys, OpenRouter tokens, or `.env.submit` contents into issues or PRs.**

## Auth for local testing

Use **Connect with OpenRouter** in Options, or paste an OpenAI API key as fallback. Keys stay in `chrome.storage.local` on your profile.
