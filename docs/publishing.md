# Publishing to the Chrome Web Store

Live listing: https://chromewebstore.google.com/detail/autovox/aodlbiejdiibbpemagfngbdhaappejda

Listing assets and copy live in [`store/`](../store/) (vendored from the published item). Package uploads go through the **Release** workflow on version tags; promo images and listing text are still edited in the [Developer Dashboard](https://chrome.google.com/webstore/developer/dashboard).

## GitHub Actions secrets

Publishing authenticates with a **Google Cloud service account**, not the older OAuth refresh-token flow. Service account tokens don't expire, so there's nothing to re-mint between releases.

Add these repository secrets (one-time):

- `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL` — `client_email` from the exported JSON key
- `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY` — `private_key` from the same key, full PEM including the `-----BEGIN/END PRIVATE KEY-----` lines
- `CHROME_PUBLISHER_ID` — from the Developer Dashboard URL (`.../developer/dashboard/<publisherId>`); required because the service-account path uses the v2 API, whose resource name is `publishers/{publisherId}/items/{extensionId}`

```bash
jq -r .client_email key.json | gh secret set CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL
jq -r .private_key  key.json | gh secret set CHROME_SERVICE_ACCOUNT_PRIVATE_KEY
gh secret set CHROME_PUBLISHER_ID
```

The extension ID is public and hardcoded in the release workflows as `aodlbiejdiibbpemagfngbdhaappejda`.

### One-time setup

1. Create a service account in Google Cloud and export a JSON key.
2. Enable the **Chrome Web Store API** in that same Cloud project.
3. Link the service account under Developer Dashboard → Settings → Service account.

For local submits, put the same three variables in `.env.submit`. Never commit it.

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

Run **Release Chrome (dry-run)** (`workflow_dispatch`) to validate the store service-account secrets without uploading or creating a GitHub Release.

## Local submit

```bash
pnpm zip
pnpm submit:chrome
```

CI (compile + build) runs on every push and PR to `main`. It does not publish.
