import { describe, expect, test, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import {
  createAccount,
  createTest,
  expectManagedError,
  fakeOpenRouter,
  getBalance,
  getMetric,
  getSession,
  getWindow,
  openSessionArgs,
  useManagedEnvironment,
} from "./harness";

useManagedEnvironment();

describe("accounts", () => {
  test("ensure and getStatus require sign-in", async () => {
    const t = createTest();
    await expectManagedError(
      t.mutation(api.accounts.ensure, {}),
      "not_authenticated",
    );
    await expectManagedError(
      t.query(api.accounts.getStatus, {}),
      "not_authenticated",
    );
  });

  test("getStatus before ensure is account_not_initialized", async () => {
    const t = createTest();
    await expectManagedError(
      t.withIdentity({ subject: "new" }).query(api.accounts.getStatus, {}),
      "account_not_initialized",
    );
  });

  test("suspended accounts are rejected everywhere", async () => {
    const t = createTest();
    const { user, accountId } = await createAccount(t, "suspended");
    await t.run(async (ctx) => {
      await ctx.db.patch("accounts", accountId, { status: "suspended" });
    });
    await expectManagedError(user.mutation(api.accounts.ensure, {}), "account_suspended");
    await expectManagedError(user.query(api.accounts.getStatus, {}), "account_suspended");
    await expectManagedError(
      user.action(api.openrouter.openSession, openSessionArgs()),
      "account_suspended",
    );
  });
});

describe("openSession", () => {
  test("provisions a capped key for a chalkboard session", async () => {
    const t = createTest();
    const openRouter = fakeOpenRouter();
    const { user } = await createAccount(t, "chalkboard");

    const opened = await user.action(
      api.openrouter.openSession,
      openSessionArgs({ kind: "chalkboard", reportLength: "deep" }),
    );

    expect(opened.apiKey).toMatch(/^sk-or-/);
    expect(opened.reservedCredits).toBe(2);
    expect(await getSession(t, opened.sessionId)).toMatchObject({
      status: "active",
      kind: "chalkboard",
      reservedMicroUsd: 100_000,
    });
    expect(openRouter.calls).toEqual([
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({ limit: 0.1 }),
      }),
    ]);
    expect((await getMetric(t))?.chalkboardStarted).toBe(1);
  });

  test("requires sign-in", async () => {
    const t = createTest();
    await expectManagedError(
      t.action(api.openrouter.openSession, openSessionArgs()),
      "not_authenticated",
    );
  });

  test("missing or invalid server configuration is not_configured without naming secrets", async () => {
    const t = createTest();
    fakeOpenRouter();
    const { user } = await createAccount(t, "config");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    vi.stubEnv("OPENROUTER_MANAGEMENT_KEY", "");
    const missing = await expectManagedError(
      user.action(api.openrouter.openSession, openSessionArgs()),
      "not_configured",
    );
    expect(missing.message).not.toContain("OPENROUTER");

    vi.stubEnv("OPENROUTER_MANAGEMENT_KEY", "test-management-key");
    vi.stubEnv("AUTOVOX_TRIAL_DAILY_BUDGET_MICRO_USD", "lots");
    await expectManagedError(
      user.action(api.openrouter.openSession, openSessionArgs()),
      "not_configured",
    );
  });

  test("asks the client to retry right before the UTC budget rollover", async () => {
    const t = createTest();
    fakeOpenRouter();
    const { user } = await createAccount(t, "midnight");
    vi.setSystemTime(Date.UTC(2026, 9, 2, 23, 59, 0));

    await expectManagedError(
      user.action(api.openrouter.openSession, openSessionArgs()),
      "retry_shortly",
    );
  });

  test("reserve failures reach the client unchanged", async () => {
    const t = createTest();
    fakeOpenRouter();
    await expectManagedError(
      t
        .withIdentity({ subject: "never-ensured" })
        .action(api.openrouter.openSession, openSessionArgs()),
      "account_not_initialized",
    );

    const { user } = await createAccount(t, "busy");
    await user.action(api.openrouter.openSession, openSessionArgs());
    await expectManagedError(
      user.action(api.openrouter.openSession, openSessionArgs()),
      "session_in_progress",
    );
  });

  test("provider failures release the reservation and hide the HTTP status", async () => {
    const t = createTest();
    const openRouter = fakeOpenRouter();
    openRouter.createStatus = 503;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { user, accountId } = await createAccount(t, "outage");

    const error = await expectManagedError(
      user.action(api.openrouter.openSession, openSessionArgs()),
      "provider_unavailable",
    );

    expect(error.message).not.toContain("503");
    expect(errors).toHaveBeenCalledWith(
      "Managed session provisioning failed",
      expect.stringContaining("503"),
    );
    expect((await getBalance(t, accountId)).reservedCredits).toBe(0);
    expect((await getWindow(t, "production"))?.reservedMicroUsd).toBe(0);
    expect((await getWindow(t, "trial"))?.reservedMicroUsd).toBe(0);
    expect((await getMetric(t))?.sessionsFaulted).toBe(1);
  });
});

describe("createCheckout", () => {
  test("validates the caller and product before contacting Stripe", async () => {
    const t = createTest();
    await expectManagedError(
      t.action(api.billing.createCheckout, { productKey: "credit_pack_100" }),
      "not_authenticated",
    );

    const stranger = t.withIdentity({ subject: "stranger" });
    await expectManagedError(
      stranger.action(api.billing.createCheckout, { productKey: "trial" }),
      "product_unavailable",
    );
    await expectManagedError(
      stranger.action(api.billing.createCheckout, {
        productKey: "credit_pack_100",
      }),
      "account_not_initialized",
    );

    const { user, accountId } = await createAccount(t, "buyer");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expectManagedError(
      user.action(api.billing.createCheckout, { productKey: "credit_pack_100" }),
      "not_configured",
    );

    await t.run(async (ctx) => {
      await ctx.db.patch("accounts", accountId, { status: "suspended" });
    });
    await expectManagedError(
      user.action(api.billing.createCheckout, { productKey: "credit_pack_100" }),
      "account_suspended",
    );
  });

  test("Stripe failures surface as provider_unavailable", async () => {
    const t = createTest();
    const { user } = await createAccount(t, "buyer");
    vi.stubEnv("STRIPE_PRICE_CREDIT_PACK_100", "price_test");
    vi.stubEnv("CHECKOUT_SUCCESS_URL", "https://example.com/success");
    vi.stubEnv("CHECKOUT_CANCEL_URL", "https://example.com/cancel");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expectManagedError(
      user.action(api.billing.createCheckout, { productKey: "credit_pack_100" }),
      "provider_unavailable",
    );
    expect(errors).toHaveBeenCalledWith(
      "Stripe checkout creation failed",
      expect.any(String),
    );
  });
});
