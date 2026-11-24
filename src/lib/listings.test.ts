import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatPriceSetDetails, hasActiveOrders, refreshListingXlmPrice } from "./listings";
import { XLM_PER_USD, usdToXlm } from "./money";

describe("formatPriceSetDetails", () => {
  it("formats date and calculates rate based on USD and XLM prices", () => {
    const listing = {
      xlmPrice: 48.5,
      usdPrice: 10,
      createdAt: "2026-03-15T12:00:00Z",
      updatedAt: null,
    };

    const details = formatPriceSetDetails(listing);
    expect(details.rateText).toBe("4.85 XLM/USD");
    expect(details.dateText).toBe("Mar 15, 2026");
    expect(details.displayText).toBe("XLM price set on Mar 15, 2026 at 4.85 XLM/USD");
  });

  it("prefers updatedAt over createdAt for date formatting", () => {
    const listing = {
      xlmPrice: 50,
      usdPrice: 10,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-06-20T10:00:00Z",
    };

    const details = formatPriceSetDetails(listing);
    expect(details.rateText).toBe("5.00 XLM/USD");
    expect(details.dateText).toBe("Jun 20, 2026");
  });

  it("handles zero USD price gracefully without dividing by zero", () => {
    const listing = {
      xlmPrice: 0,
      usdPrice: 0,
      createdAt: "2026-01-01T00:00:00Z",
    };

    const details = formatPriceSetDetails(listing);
    expect(details.rateText).toBe(`${XLM_PER_USD.toFixed(2)} XLM/USD`);
  });
});

describe("hasActiveOrders", () => {
  it("returns true when orders with status pending or paid exist", async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({
              data: [{ id: "order-1", status: "pending" }],
              error: null,
            }),
          }),
        }),
      }),
    };

    const active = await hasActiveOrders(mockSupabase as unknown as SupabaseClient, "prod-1");
    expect(active).toBe(true);
  });

  it("returns false when no orders in pending or paid status exist", async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({
              data: [],
              error: null,
            }),
          }),
        }),
      }),
    };

    const active = await hasActiveOrders(mockSupabase as unknown as SupabaseClient, "prod-1");
    expect(active).toBe(false);
  });
});

describe("refreshListingXlmPrice", () => {
  it("throws an error when listing has an active order in progress", async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "orders") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({
                  data: [{ id: "order-1", status: "paid" }],
                  error: null,
                }),
              }),
            }),
          };
        }
        return {};
      }),
    };

    await expect(
      refreshListingXlmPrice(mockSupabase as unknown as SupabaseClient, "prod-1"),
    ).rejects.toThrow("Cannot refresh XLM price while an order is in progress.");
  });

  it("recalculates and updates xlm_price when no active orders exist", async () => {
    const updateSpy = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });

    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "orders") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({
                  data: [],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "products") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { usd_price: 20, xlm_price: 80 },
                  error: null,
                }),
              }),
            }),
            update: updateSpy,
          };
        }
        return {};
      }),
    };

    const result = await refreshListingXlmPrice(
      mockSupabase as unknown as SupabaseClient,
      "prod-1",
    );
    expect(result.oldXlmPrice).toBe(80);
    expect(result.newXlmPrice).toBe(usdToXlm(20));
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        xlm_price: usdToXlm(20),
        updated_at: expect.any(String),
      }),
    );
  });
});
