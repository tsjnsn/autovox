# Privacy Policy — Autovox

Autovox is a browser extension that digests the current web page into a spoken news report. Page processing happens in your browser and at the AI provider.

Autovox offers two modes:

- **Bring your own key (BYOK):** no Autovox backend is involved.
- **Managed listening:** an optional Autovox control plane handles sign-in, credits, payments, strict provider budgets, and coarse listening outcomes. Page content still goes directly from the extension to OpenRouter and never through the Autovox control plane.

## What Autovox reads

When you start a brief or a chalkboard lesson, Autovox extracts the main article text from the active tab (via Mozilla Readability) so it can rewrite and narrate that page.

## What is sent to third parties

Depending on the mode selected in Options:

A chalkboard lesson additionally sends the generated lesson script (not the article text) back to the same provider, once per board, to draw its scenes. Exporting a chalkboard as a video happens entirely in your browser: the file is encoded locally from the board and narration already on the page and saved through your browser's download, with nothing sent anywhere.

- **Managed listening:** article text and narration requests are sent directly to [OpenRouter](https://openrouter.ai/) using a short-lived, dollar-capped key funded by Autovox. Requests require zero-data-retention routing and deny provider data collection. Bring-your-own-key OpenRouter requests deny provider data collection but otherwise follow your own OpenRouter privacy settings.
- **OpenRouter BYOK:** article text and narration requests are sent to OpenRouter (and onward to the models you use there).
- **OpenAI API key (fallback):** the same requests are sent directly to [OpenAI](https://openai.com/).
- **Ask in ChatGPT or Claude (optional):** if you choose it after a brief, Autovox copies the spoken brief and your question to the clipboard and opens a new [ChatGPT](https://chatgpt.com/) or [Claude](https://claude.ai/) chat. The link contains no brief and no question. Those sites receive the brief only if you paste it. That conversation uses your ChatGPT or Claude account.

Those providers process content under their own terms and privacy policies. The Autovox control plane never receives the page URL, title, article text, generated script, or audio.

Managed listening additionally uses:

- [Clerk](https://clerk.com/) for account authentication. Autovox stores Clerk's opaque identity, not a copied profile.
- [Stripe](https://stripe.com/) for hosted checkout and payment records. Card details never enter the extension or Autovox control plane.
- [Convex](https://convex.dev/) for credits, budget reservations, aggregate economics, and lifecycle outcomes.

## What managed listening sends to Autovox

Managed mode sends only the information needed to fulfill and improve a paid brief:

- opaque account and session identifiers
- extension and policy version
- report length, voice, and output language
- lifecycle outcome (completed, fault, aborted, or expired), coarse fault stage, and playback duration
- credit reservations, settled payments, refunds, and provider cost

It does **not** send browsing history, URL, hostname, page title, article text, prompts, script, audio, or raw provider error text.

Reconciled per-session product records are deleted after 90 days. Aggregate daily economics and payment/credit records are retained longer for operating and accounting purposes. OpenRouter session keys are deleted immediately after successful reconciliation.

## What is stored locally

Settings (OpenRouter connection, optional OpenAI API key, voice, output language, report length) are stored in `chrome.storage.local` on your browser profile. Brief/script state for the tab you are on may be kept in session storage while the extension is active.

**Saved briefs.** When a brief or chalkboard finishes, Autovox keeps a copy in this browser's IndexedDB so the player can show it again: the spoken script, chalkboard art, the page address, the page title, and the site name. The newest 40 are kept. **Remove** on an older brief deletes that copy. This copy never leaves your browser and is not sent to Autovox.

Autovox also keeps a **local spend ledger** on this profile: cost, model, stage (understand, narrate, or chalkboard drawing), outcome (completed / fault / aborted), report length, voice, output language, and the article type the brief was written as (and whether you picked it or Autovox inferred it). That record does **not** include the page URL, title, or article text. BYOK ledger records are not sent to Autovox.

Short-lived managed provider keys are held in `chrome.storage.session`, not local or sync storage, and are disabled after the session or automatically expire.

Provider keys and managed session keys are used only by the extension's background service worker, which also makes every provider request. The overlay Autovox shows on a page never receives a key, and where the browser supports it Autovox restricts its local storage to extension pages so the page's process can't read it.

**Saved narration.** Once a narration has downloaded in full, its audio is saved in the extension's own IndexedDB on this profile, so playing the same brief again (reopening the overlay on that page, or switching back to the same voice) doesn't request it from the provider again; in managed mode, replaying saved audio uses no credit. Each saved narration is the audio plus a one-way hash of the script, voice, narration model, narrator instructions, language, and provider mode. The audio is the spoken script, so it reflects the article; no URL or title is stored with it. Saved narration is deleted when the browser restarts, 7 days after it was saved, or sooner, least recently played first, once it passes 128 MB (about 45 minutes of audio). **Clear saved narration** in Options deletes all of it. It never leaves your browser.

## Permissions

- **activeTab / scripting:** temporary access to the tab you invoke Autovox on (toolbar icon or “Vox this page” context menu) so Autovox can inject the overlay and extract article text. Autovox does not request persistent access to all websites.
- **contextMenus:** adds “Vox this page” and “Chalkboard this page” items to the page right-click menu that open Autovox and start the spoken brief or chalkboard lesson.
- **storage:** save settings, the BYOK spend ledger, the on-device library of briefs you generated, and short-lived managed session state on this profile.
- **identity:** OpenRouter OAuth connect flow.
- **Host access to `openrouter.ai` and `api.openai.com`:** call those APIs from the extension.
- **Managed builds only — host access to `*.convex.cloud` and `*.clerk.accounts.dev`:** authenticate, reserve credits, open checkout, receive a capped provider key, and report coarse lifecycle outcomes. These hosts are omitted from BYOK-only builds.

## Contact

For privacy questions about this open-source project, open an issue at the GitHub repository.
