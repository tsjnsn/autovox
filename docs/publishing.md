# Publishing to the Chrome Web Store

Live listing: https://chromewebstore.google.com/detail/autovox/aodlbiejdiibbpemagfngbdhaappejda

Listing assets and copy live in [`store/`](../store/) (vendored from the published item). Package uploads go through GitHub Actions; promo images and listing text are still edited in the [Developer Dashboard](https://chrome.google.com/webstore/developer/dashboard).

## GitHub Actions secrets

Add these repository secrets (one-time):

- `CHROME_CLIENT_ID`
- `CHROME_CLIENT_SECRET`
- `CHROME_REFRESH_TOKEN`

The extension ID is public and hardcoded in [`.github/workflows/release-chrome.yml`](../.github/workflows/release-chrome.yml) as `aodlbiejdiibbpemagfngbdhaappejda`.

Generate local credentials with `pnpm wxt submit init`, or `npx chrome-webstore-upload-keys` if the OAuth out-of-band refresh-token flow fails. Never commit `.env.submit`.

## Release Chrome workflow

1. Bump `version` in [`package.json`](../package.json).
2. Run **Release Chrome** (`workflow_dispatch`).
3. Start with `dry_run: true` to validate credentials without uploading.
4. Run again with `dry_run: false` to upload. Set `skip_review: true` to upload a draft without submitting for review.

## Local submit

```bash
pnpm zip
pnpm submit:chrome
```

CI (compile + build) runs on every push and PR to `main`. It does not publish.
