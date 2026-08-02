# Privacy Policy — Autovox

Autovox is a browser extension that digests the current web page into a spoken news report. There is **no Autovox backend**. Processing happens in your browser and via the AI provider you connect.

## What Autovox reads

When you start a brief, Autovox extracts the main article text from the active tab (via Mozilla Readability) so it can rewrite and narrate that page.

## What is sent to third parties

Depending on how you authenticate in Options:

- **OpenRouter (preferred):** article text and narration requests are sent to [OpenRouter](https://openrouter.ai/) (and onward to the models you use there).
- **OpenAI API key (fallback):** the same requests are sent directly to [OpenAI](https://openai.com/).

Those providers process content under their own terms and privacy policies. Autovox does not operate a server that receives your page content or keys.

## What is stored locally

Settings (OpenRouter connection, optional OpenAI API key, voice, report length) are stored in `chrome.storage.local` on your browser profile. Brief/script state may be kept in session storage while the extension is active. Nothing is synced to Autovox servers — there are none.

## Permissions

- **activeTab / scripting:** temporary access to the tab you invoke Autovox on (toolbar click) so Autovox can inject the overlay and extract article text. Autovox does not request persistent access to all websites.
- **storage:** save your settings on this profile.
- **identity:** OpenRouter OAuth connect flow.
- **Host access to `openrouter.ai` and `api.openai.com`:** call those APIs from the extension.

## Contact

For privacy questions about this open-source project, open an issue at the GitHub repository.
