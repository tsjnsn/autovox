# Autovox flywheel — extension analytics → self-improve

Autovox has **no backend** and declares **no product telemetry** ([PRIVACY.md](../PRIVACY.md)). The improvement loop therefore uses **extrinsic extension analytics**: public Chrome Web Store listing signals, public reviews, and (optionally) the store-listing metrics Google already shows in the Developer Dashboard.

```
ship Autovox
    → people find / install / review it on the Chrome Web Store
    → pnpm pulse snapshots those signals into store/pulse.*
    → a GitHub issue (label flywheel) plus this file tell an agent what changed
    → the agent files issues / opens PRs / you ship
    → the next pulse measures whether it worked
```

That is the whole flywheel. Do **not** complete it by piping page text or API keys to a third-party analytics SDK — that would break the privacy contract and the CWS data-use declarations.

## What to connect (and what not to)

| Source | What it measures | How Autovox uses it |
| --- | --- | --- |
| Public listing (`store/pulse.json`) | Approximate users, rating, review count, listed version, public review text | Automated daily snapshot. Safe: already public. |
| [Developer Dashboard metrics](https://developer.chrome.com/docs/webstore/metrics) | Installs, uninstalls, impressions, weekly users, enabled vs disabled | Human / agent reads the dashboard (or exported CSV). No public API. |
| CWS-managed listing GA | Store **page** views and listing conversion — not in-extension events | Opt in under **Store listing → Additional metrics**. The public listing blob may expose a `G-` measurement id; treat it as store-page analytics only. |
| In-extension GA4 / PostHog / Umami | Brief starts, faults, voice picks | **Out of scope.** Would need a host permission, a privacy-policy rewrite, and a CWS data-collection disclosure. |

Official CWS publish credentials (`CHROME_SERVICE_ACCOUNT_*`) upload zips. They do **not** return analytics. Connecting “extension analytics” here means the pulse + dashboard, not `wxt submit`.

## Daily pulse

```bash
pnpm pulse
```

Fetches the live listing and reviews pages, writes:

- [`store/pulse.json`](../store/pulse.json) — machine-readable snapshot + deltas vs the last run
- [`store/pulse.md`](../store/pulse.md) — the same digest used as the GitHub issue body

The **Store pulse** workflow runs this on a schedule and on `workflow_dispatch`. When the snapshot changes it commits the files on `main` and upserts a GitHub issue labeled `flywheel`.

## Close the loop with a Cursor Automation

Create a scheduled or issue-triggered [Cursor Automation](https://cursor.com/automations) on `tsjnsn/autovox` with a prompt like:

```
You are closing Autovox's flywheel. Read docs/flywheel.md, DESIGN.md, PRIVACY.md,
and the latest store/pulse.json + store/pulse.md (or the open GitHub issue labeled
flywheel).

Rules:
- Do not add in-extension analytics, new host permissions, or a backend.
- Prefer borrowed media UX over dashboard chrome (DESIGN.md).
- If users are low and reviews are empty, improve listing conversion
  (store/listing.md copy, screenshots) — not new overlay controls.
- If there are new ≤3★ reviews, file one GitHub issue per distinct product
  problem, then implement the highest-leverage fix as a PR.
- If user count or rating dropped, investigate uninstall / fault paths
  (extract → understand → TTS) before adding features.
- Keep the overlay player-first. Preferences stay in Options.

Ship a small PR. Update suggestedActions commentary in the flywheel issue.
```

Point the automation at this repo, the `flywheel` label, and (optionally) a weekly cron. The pulse issue is the inbox; the agent is the actuator.

## Manual dashboard checks (richer than the public count)

Once a week, or before a release:

1. [Developer Dashboard](https://chrome.google.com/webstore/developer/dashboard) → Autovox → **Analytics**
2. Note installs, uninstalls, impressions, and weekly users by country / version
3. If you opted into listing GA, open that GA4 property for store-page conversion
4. Paste any insight that is not already in `store/pulse.md` as a comment on the flywheel issue

Public `userCount` is a coarse bucket. Dashboard weekly users and uninstalls are the numbers that decide whether a release helped.

## First-run reality (2026-09)

The listing is live at version 0.2.0 with a handful of public users and **no ratings**. Until reviews exist, the flywheel’s job is discovery and listing conversion — not a product-analytics warehouse.
