# Privacy Policy — Autovox

Autovox is a browser extension that digests the current web page into a spoken news report. Page processing happens in your browser and at the AI provider.

Autovox offers two modes:

- **Bring your own key (BYOK):** no Autovox backend is involved.
- **Managed listening:** an optional Autovox control plane handles sign-in, credits, payments, strict provider budgets, and coarse listening outcomes. Page content still goes directly from the extension to OpenRouter and never through the Autovox control plane.

## What Autovox reads

When you start a brief, Autovox extracts the main article text from the active tab (via Mozilla Readability) so it can rewrite and narrate that page.

## What is sent to third parties

Depending on the mode selected in Options:

- **Managed listening:** article text and narration requests are sent directly to [OpenRouter](https://openrouter.ai/) using a short-lived, dollar-capped key funded by Autovox. Requests require zero-data-retention routing and deny provider data collection.
- **OpenRouter BYOK:** article text and narration requests are sent to OpenRouter (and onward to the models you use there).
- **OpenAI API key (fallback):** the same requests are sent directly to [OpenAI](https://openai.com/).

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

Settings (OpenRouter connection, optional OpenAI API key, voice, output language, report length) are stored in `chrome.storage.local` on your browser profile. Brief/script state may be kept in session storage while the extension is active.

Autovox also keeps a **local spend ledger** on this profile: cost, model, outcome (completed / fault / aborted), report length, voice, and output language. That record does **not** include the page URL, title, or article text. BYOK ledger records are not sent to Autovox.

Short-lived managed provider keys are held in `chrome.storage.session`, not local or sync storage, and are disabled after the session or automatically expire.

## Permissions

- **activeTab / scripting:** temporary access to the tab you invoke Autovox on (toolbar icon or “Vox this page” context menu) so Autovox can inject the overlay and extract article text. Autovox does not request persistent access to all websites.
- **contextMenus:** adds a “Vox this page” item to the page right-click menu that opens Autovox and starts the spoken brief.
- **storage:** save settings, the BYOK spend ledger, and short-lived managed session state on this profile.
- **identity:** OpenRouter OAuth connect flow.
- **Host access to `openrouter.ai` and `api.openai.com`:** call those APIs from the extension.
- **Managed builds only — host access to `*.convex.cloud` and `*.clerk.accounts.dev`:** authenticate, reserve credits, open checkout, receive a capped provider key, and report coarse lifecycle outcomes. These hosts are omitted from BYOK-only builds.

## Contact

For privacy questions about this open-source project, open an issue at the GitHub repository.
