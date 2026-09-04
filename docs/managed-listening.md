# Managed listening — one-time launch setup

Managed listening is build-gated and off by default. BYOK builds keep the current backend-free behavior and permissions.

This setup requires the legal owner once. After the accounts, disclosures, secrets, and fixed capital limits are approved, the recurring measurement and decision loop runs without product steering.

## 1. Capital and product

Initial product:

- 3 managed trial credits
- 100-credit one-time pack
- short / standard brief: 1 credit
- deep brief: 2 credits

Initial hard limits:

- short session key: $0.03
- standard session key: $0.06
- deep session key: $0.10
- global production provider budget: $20/day
- one active funded session per account

Create a $9 USD one-time Stripe price for the 100-credit pack. The amount is configured server-side; the extension never submits a price or credit quantity.

## 2. Convex control plane

Use the owner-linked development deployment locally:

```bash
pnpm convex:dev
```

Cloud agents must use an isolated deployment:

```bash
CONVEX_AGENT_MODE=anonymous pnpm convex:dev
```

Set server values with `pnpm exec convex env set NAME value`. Never put these in a public WXT variable:

```text
CLERK_JWT_ISSUER_DOMAIN
OPENROUTER_MANAGEMENT_KEY
OPENROUTER_WORKSPACE_ID
AUTOVOX_DAILY_BUDGET_MICRO_USD=20000000
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_CREDIT_PACK_100
CHECKOUT_SUCCESS_URL=https://<deployment>.convex.site/checkout/complete
CHECKOUT_CANCEL_URL=https://<deployment>.convex.site/checkout/complete
AUTOVOX_OPERATOR_SECRET
```

Use `pnpm exec convex deploy` only for the production launch after the development deployment, tests, and disclosures are approved.

## 3. Clerk

1. Create an Autovox Clerk application.
2. Enable Clerk Native API support for the Chrome extension.
3. Enable email OTP or password/passkey sign-in. Popup OAuth and email links are not supported.
4. Disable Clerk bot protection for the extension environment.
5. Configure the Convex JWT integration/template named `convex`.
6. Add `chrome-extension://aodlbiejdiibbpemagfngbdhaappejda` as an allowed origin.
7. Set the Clerk issuer URL as `CLERK_JWT_ISSUER_DOMAIN` in Convex.

Development unpacked builds can have a different extension ID. Add that origin to the development Clerk instance; do not broaden the production origin.

## 4. OpenRouter

1. Fund a dedicated Autovox workspace.
2. Create a management key. Management keys cannot run inference.
3. Put the management key only in Convex.
4. Configure workspace guardrails:
   - allow only `openai/gpt-5.6-luna` and `openai/gpt-audio-mini`
   - require zero data retention
   - deny provider data collection
   - disable prompt/completion logging and training
5. Do not enable unlimited auto-top-up.

Convex creates one inference key per session. The key is returned once, stored only in browser session storage, dollar-capped, disabled at terminal state, reconciled, and deleted. If reconciliation fails three times, funded listening freezes.

## 5. Stripe

1. Complete merchant identity, bank, tax, refund, and seller-information setup.
2. Create the fixed one-time $9 / 100-credit price.
3. Add a webhook endpoint:

```text
https://<deployment>.convex.site/stripe/webhook
```

Subscribe to the component events listed in `@convex-dev/stripe`, plus:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `refund.created`
- `refund.updated`

Credit is granted only from a signature-verified, settled checkout webhook. The success page never grants entitlement.

## 6. Extension build

Copy `.env.example` to a local ignored env file and set:

```text
WXT_PUBLIC_MANAGED_ENABLED=true
WXT_PUBLIC_CONVEX_URL=https://<deployment>.convex.cloud
WXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
WXT_PUBLIC_CLERK_FRONTEND_API_URL=https://<your-clerk-frontend-api>
```

These values are public build configuration. Enabling managed mode adds narrowly scoped Clerk and Convex host access. It never adds persistent access to page origins.

Validate both product variants:

```bash
pnpm check
WXT_PUBLIC_MANAGED_ENABLED=true \
WXT_PUBLIC_CONVEX_URL=https://<deployment>.convex.cloud \
WXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<publishable-key> \
pnpm build
```

## 7. Operator

Set repository secrets:

```text
AUTOVOX_CONTROL_PLANE_SITE_URL
AUTOVOX_OPERATOR_SECRET
```

The daily **Economics operator** workflow fetches aggregates only, writes `store/economics.json` and `store/decision.md`, and maintains one bounded `operator` issue when evidence changes.

Create one Cursor Automation triggered by that issue. Its instructions are in [flywheel.md](flywheel.md). It may implement the signed decision packet; it may not increase budgets, add data, add permissions, change processors, change prices, or publish a policy-changing release.

## 8. Store disclosure before enablement

Before setting `WXT_PUBLIC_MANAGED_ENABLED=true` in a production build:

1. Publish the revised [privacy policy](../PRIVACY.md).
2. Update the Chrome Web Store data-use disclosure for authentication, payment state, coarse configuration, lifecycle outcome, and economic records.
3. State clearly that managed listening is paid after the trial.
4. Publish seller identity, terms of sale, refund terms, and support contact.
5. Submit the added Clerk/Convex hosts for review.

Do not market or enable the paid mode before these owner attestations are accurate.
