# Publishing to the Chrome Web Store

Live listing: https://chromewebstore.google.com/detail/autovox/aodlbiejdiibbpemagfngbdhaappejda

Listing assets and copy live in [`store/`](../store/) (vendored from the published item). Package uploads go through the **Release** workflow on version tags; promo images and listing text are still edited in the [Developer Dashboard](https://chrome.google.com/webstore/developer/dashboard).

## GitHub Actions secrets

Add these repository secrets (one-time):

- `CHROME_CLIENT_ID`
- `CHROME_CLIENT_SECRET`
- `CHROME_REFRESH_TOKEN`

The extension ID is public and hardcoded in the release workflows as `aodlbiejdiibbpemagfngbdhaappejda`.

Generate local credentials with `pnpm wxt submit init`, or `npx chrome-webstore-upload-keys` if the OAuth out-of-band refresh-token flow fails. Never commit `.env.submit`.

## Cut a release

From a clean `main` working tree:

```bash
pnpm release 0.1.1
```

That bumps `version` in [`package.json`](../package.json), commits, tags `v0.1.1`, and pushes. The **Release** workflow then:

1. Typechecks and zips the Chrome extension
2. Asserts `package.json` version matches the tag
3. Creates a GitHub Release with the zip attached
4. Submits the zip to the Chrome Web Store for review

## Credential dry-run

Run **Release Chrome (dry-run)** (`workflow_dispatch`) to validate store OAuth secrets without uploading or creating a GitHub Release.

## Local submit

```bash
pnpm zip
pnpm submit:chrome
```

CI (compile + build) runs on every push and PR to `main`. It does not publish.
