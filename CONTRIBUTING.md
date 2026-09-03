# Contributing to Autovox

Thanks for helping improve Autovox.

## Setup

See [docs/development.md](docs/development.md).

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

## Publishing

Chrome Web Store releases are documented in [docs/publishing.md](docs/publishing.md). Listing assets live under [`store/`](store/).

The [flywheel](docs/flywheel.md) is **money** (local spend ledger; later Autovox-owned OpenRouter spend). Store-listing pulse (`pnpm pulse`) is acquisition only. Do not add in-extension product analytics.
