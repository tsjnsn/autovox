# Chrome Web Store listing

Live item: https://chromewebstore.google.com/detail/autovox/aodlbiejdiibbpemagfngbdhaappejda

Extension ID: `aodlbiejdiibbpemagfngbdhaappejda`

Assets in this folder were pulled from the live listing (do not invent replacements here — update the dashboard, then re-vendor).

| File | Role | Size |
| --- | --- | --- |
| `icon.png` | Store / package icon reference | 128×128 |
| `promo-small.png` | Small promotional image | 440×280 |
| `screenshot-1.png` | Screenshot | 640×400 |

## Copy (as published)

**Short description**

> Digest a web page into a spoken news report—with real comprehension, not just a summary or TTS.

**Detailed description**

> Autovox gives you a spoken summary for any web page.

**Developer**

- Name: tsjnsn
- Email: chrome@tylerjohnson.dev

**Privacy**

- Declares no data collection
- Policy: [PRIVACY.md](../PRIVACY.md) on `main`

That declaration is accurate only for the currently published BYOK-only build. Before enabling managed listening, update the dashboard disclosure and detailed description using the checklist in [managed-listening.md](../docs/managed-listening.md). Do not ship a managed build while the listing still says “no data collection.”

## Proposed copy for the Chalkboard release (not yet published)

Paste into the dashboard before submitting the release for review, then move it into "Copy (as published)" above. The release is still BYOK-only, so the privacy disclosure is unchanged.

**Short description**

> Turn any web page into a spoken news report, or a narrated chalkboard lesson you can save as a video.

**Detailed description**

> Autovox turns the page you're reading into something you can listen to.
>
> • Brief: press play and Autovox reads the page, understands it, and narrates a short spoken news report. Real comprehension, not text-to-speech of the article.
> • Chalkboard: for tutorials and explainers, get a narrated lesson while stick-figure chalk scenes are drawn in step with the voice. Scrub, pause, and replay keep the board on the words being spoken.
> • Export video: save a chalkboard lesson and its narration as a video file, made right in your browser.
> • Choose the voice, report length, and output language.
> • Bring your own OpenRouter or OpenAI key and pick the models you want. Autovox suggests good ones and shows a rough cost for each.
>
> The page's text goes only to the AI provider you connect. Your key stays in your browser.

**Screenshot:** the current `screenshot-1.png` predates Chalkboard. A 1280×800 capture of the overlay with a drawn board would show the new feature.

## Metrics

Public listing metrics (users, rating, reviews) are snapshotted by `pnpm pulse` as an **acquisition** signal. The [flywheel](../docs/flywheel.md) is spend per brief, recorded on-device — not store vanity, and not in-extension product analytics.
