import { describe, expect, test } from "vitest";
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  createAccount,
  createTest,
  getBalance,
  getMetric,
  NOW,
  purchaseCredits,
  useManagedEnvironment,
  type TestConvex,
} from "./harness";

useManagedEnvironment();

async function getAccount(t: TestConvex, accountId: Id<"accounts">) {
  return await t.run(async (ctx) => await ctx.db.get("accounts", accountId));
}

function refund(t: TestConvex, refundId: string, refundMicroUsd: number) {
  return t.mutation(internal.billingInternal.applyRefund, {
    providerEventId: `refund:${refundId}`,
    stripeObjectId: "pi_1",
    refundMicroUsd,
    currency: "USD",
    now: NOW,
  });
}

describe("applyCheckout", () => {
  test("grants credits once per payment and marks the account as paid", async () => {
    const t = createTest();
    const { accountId } = await createAccount(t, "buyer");
    expect((await getAccount(t, accountId))?.firstPurchaseAt).toBeUndefined();

    expect(await purchaseCredits(t, accountId, "pi_1")).toBe(true);
    expect(await purchaseCredits(t, accountId, "pi_1")).toBe(false);

    expect((await getBalance(t, accountId)).grantedCredits).toBe(103);
    expect((await getAccount(t, accountId))?.firstPurchaseAt).toBe(NOW);
    expect(await getMetric(t)).toMatchObject({
      grossRevenueMicroUsd: 9_000_000,
      confirmedPayments: 1,
    });

    expect(await purchaseCredits(t, accountId, "pi_2", NOW + 60_000)).toBe(true);
    expect((await getBalance(t, accountId)).grantedCredits).toBe(203);
    expect((await getAccount(t, accountId))?.firstPurchaseAt).toBe(NOW);
  });
});

describe("applyRefund", () => {
  test("revokes credits in proportion to the refunded amount, once per event", async () => {
    const t = createTest();
    const { accountId } = await createAccount(t, "refunder");
    await purchaseCredits(t, accountId, "pi_1");

    expect(await refund(t, "re_1", 4_500_000)).toBe(true);
    expect((await getBalance(t, accountId)).grantedCredits).toBe(53);
    expect(await getMetric(t)).toMatchObject({
      grossRevenueMicroUsd: 4_500_000,
      confirmedPayments: 0,
    });

    expect(await refund(t, "re_1", 4_500_000)).toBe(false);
    expect((await getBalance(t, accountId)).grantedCredits).toBe(53);

    expect(await refund(t, "re_2", 3_000_000)).toBe(true);
    expect((await getBalance(t, accountId)).grantedCredits).toBe(20);

    expect(await refund(t, "re_3", 3_000_000)).toBe(true);
    expect((await getBalance(t, accountId)).grantedCredits).toBe(3);
    expect(await getMetric(t)).toMatchObject({
      grossRevenueMicroUsd: 0,
      confirmedPayments: 0,
    });

    expect(await refund(t, "re_4", 1_000_000)).toBe(false);
    expect((await getBalance(t, accountId)).grantedCredits).toBe(3);
    const original = await t.run(
      async (ctx) =>
        await ctx.db
          .query("billingReceipts")
          .withIndex("by_provider_event", (q) =>
            q.eq("providerEventId", "payment:pi_1"),
          )
          .unique(),
    );
    expect(original).toMatchObject({
      refundedMicroUsd: 9_000_000,
      revokedCredits: 100,
    });
  });
});
