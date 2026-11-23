import { STELLAR } from "@/lib/stellar/config";
import type { OrderSummary } from "@/lib/orders/queries";

export const afterFee = (xlmAmount: number) =>
  xlmAmount * (1 - STELLAR.feeBps / 10_000);

export interface WeekEarning {
  /** 0 is 11 weeks ago, 11 is the current week */
  weekIndex: number;
  label: string;
  start: Date;
  end: Date;
  earnings: number;
  orderCount: number;
}

export interface WeeklyEarningsSummary {
  weeks: WeekEarning[];
  totalEarnings: number;
  averageWeeklyEarnings: number;
  maxWeeklyEarnings: number;
  totalOrders: number;
}

/**
 * Groups released orders into the last 12 weeks (7-day intervals).
 * Calculates net earnings after deducting the platform escrow fee (1%).
 */
export function getWeeklyEarnings(
  orders: OrderSummary[],
  referenceDate: Date = new Date(),
): WeeklyEarningsSummary {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const ONE_WEEK_MS = 7 * ONE_DAY_MS;

  const endOfCurrentPeriod = new Date(
    referenceDate.getFullYear(),
    referenceDate.getMonth(),
    referenceDate.getDate(),
    23,
    59,
    59,
    999,
  );

  const weeks: WeekEarning[] = [];

  for (let i = 11; i >= 0; i--) {
    const end = new Date(endOfCurrentPeriod.getTime() - i * ONE_WEEK_MS);
    const start = new Date(end.getTime() - ONE_WEEK_MS + 1);
    const month = start.toLocaleDateString("en-US", { month: "short" });
    const day = start.getDate();
    const label = `${month} ${day}`;

    weeks.push({
      weekIndex: 11 - i,
      label,
      start,
      end,
      earnings: 0,
      orderCount: 0,
    });
  }

  const released = orders.filter((o) => o.state === "released");

  for (const order of released) {
    const dateStr = order.paidOutAt || order.resolvedAt || order.createdAt;
    const orderTime = new Date(dateStr).getTime();

    for (const week of weeks) {
      if (orderTime >= week.start.getTime() && orderTime <= week.end.getTime()) {
        week.earnings += afterFee(order.totalXlm);
        week.orderCount += 1;
        break;
      }
    }
  }

  const totalEarnings = weeks.reduce((sum, w) => sum + w.earnings, 0);
  const totalOrders = weeks.reduce((sum, w) => sum + w.orderCount, 0);
  const maxWeeklyEarnings = Math.max(0, ...weeks.map((w) => w.earnings));
  const averageWeeklyEarnings = totalEarnings / 12;

  return {
    weeks,
    totalEarnings,
    averageWeeklyEarnings,
    maxWeeklyEarnings,
    totalOrders,
  };
}
