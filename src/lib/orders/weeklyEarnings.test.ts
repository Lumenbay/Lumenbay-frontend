import { describe, expect, it } from "vitest";
import type { OrderSummary } from "./queries";
import { getWeeklyEarnings, afterFee } from "./weeklyEarnings";

const makeOrder = (overrides: Partial<OrderSummary> = {}): OrderSummary => ({
  orderId: "order-1",
  createdAt: "2026-11-20T12:00:00Z",
  status: "fulfilled",
  totalXlm: 100,
  role: "seller",
  productId: "prod-1",
  productName: "Vintage Watch",
  image: null,
  counterparty: "Alice",
  chainEscrowId: "escrow-1",
  state: "released",
  shippedAt: null,
  shippingNote: null,
  fundTxHash: null,
  releaseTxHash: null,
  resolution: null,
  resolvedAt: null,
  resolveTxHash: null,
  disputeReason: null,
  paidOutAt: "2026-11-20T12:00:00Z",
  payoutTxHash: null,
  ...overrides,
});

describe("weeklyEarnings", () => {
  const refDate = new Date("2026-11-24T12:00:00Z");

  it("calculates earnings after 1% fee correctly", () => {
    expect(afterFee(100)).toBeCloseTo(99);
    expect(afterFee(250)).toBeCloseTo(247.5);
  });

  it("creates exactly 12 weekly intervals ending at reference date", () => {
    const summary = getWeeklyEarnings([], refDate);
    expect(summary.weeks).toHaveLength(12);
    expect(summary.totalEarnings).toBe(0);
    expect(summary.totalOrders).toBe(0);
    expect(summary.maxWeeklyEarnings).toBe(0);
    expect(summary.averageWeeklyEarnings).toBe(0);
    expect(summary.weeks[11].weekIndex).toBe(11);
    expect(summary.weeks[0].weekIndex).toBe(0);
  });

  it("groups released orders into the correct weekly buckets with 1% fee deducted", () => {
    // Current week (e.g. Nov 20, 2026)
    const o1 = makeOrder({ orderId: "o1", totalXlm: 100, paidOutAt: "2026-11-20T12:00:00Z" });
    // 2 weeks ago (e.g. Nov 06, 2026)
    const o2 = makeOrder({ orderId: "o2", totalXlm: 200, paidOutAt: "2026-11-06T12:00:00Z" });

    const summary = getWeeklyEarnings([o1, o2], refDate);
    expect(summary.totalOrders).toBe(2);
    // 100 * 0.99 = 99; 200 * 0.99 = 198 => total = 297
    expect(summary.totalEarnings).toBeCloseTo(297);
    expect(summary.maxWeeklyEarnings).toBeCloseTo(198);
    expect(summary.averageWeeklyEarnings).toBeCloseTo(297 / 12);

    // Week 11 (most recent week containing Nov 20)
    const currentWeek = summary.weeks[11];
    expect(currentWeek.earnings).toBeCloseTo(99);
    expect(currentWeek.orderCount).toBe(1);
  });

  it("ignores non-released orders", () => {
    const releasedOrder = makeOrder({ orderId: "o1", totalXlm: 100, state: "released" });
    const fundedOrder = makeOrder({ orderId: "o2", totalXlm: 500, state: "funded" });
    const inTransitOrder = makeOrder({ orderId: "o3", totalXlm: 300, state: "in_transit" });
    const disputedOrder = makeOrder({ orderId: "o4", totalXlm: 400, state: "disputed" });

    const summary = getWeeklyEarnings([releasedOrder, fundedOrder, inTransitOrder, disputedOrder], refDate);
    expect(summary.totalOrders).toBe(1);
    expect(summary.totalEarnings).toBeCloseTo(99);
  });

  it("ignores orders older than 12 weeks", () => {
    // 15 weeks ago
    const oldOrder = makeOrder({ orderId: "old", totalXlm: 500, paidOutAt: "2026-06-01T12:00:00Z" });
    const summary = getWeeklyEarnings([oldOrder], refDate);

    expect(summary.totalOrders).toBe(0);
    expect(summary.totalEarnings).toBe(0);
  });

  it("aggregates multiple released orders within the same week", () => {
    const o1 = makeOrder({ orderId: "o1", totalXlm: 100, paidOutAt: "2026-11-20T10:00:00Z" });
    const o2 = makeOrder({ orderId: "o2", totalXlm: 150, paidOutAt: "2026-11-21T15:00:00Z" });

    const summary = getWeeklyEarnings([o1, o2], refDate);
    const week11 = summary.weeks[11];
    expect(week11.orderCount).toBe(2);
    // (100 + 150) * 0.99 = 247.5
    expect(week11.earnings).toBeCloseTo(247.5);
  });
});
