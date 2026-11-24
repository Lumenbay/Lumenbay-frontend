import { beforeEach, describe, expect, it } from "vitest";
import {
  escrowsForWallet,
  eventsForEscrow,
  mapDbPaymentEvent,
  mergePaymentEvents,
  recordPaymentEvent,
  unfundedEscrows,
  type PaymentEvent,
} from "./paymentJournal";

const base = { network: "testnet", contractId: "CTEST", buyer: "GBUYER", seller: "GSELLER", amountXlm: 10 };

describe("payment journal", () => {
  beforeEach(() => localStorage.clear());

  it("records events with id and timestamp, and lists them per escrow", () => {
    recordPaymentEvent({ ...base, step: "escrow_created", escrowId: "1", txHash: "aaa" });
    recordPaymentEvent({ ...base, step: "escrow_funded", escrowId: "1", txHash: "bbb" });
    recordPaymentEvent({ ...base, step: "escrow_created", escrowId: "2", txHash: "ccc" });

    const events = eventsForEscrow("1");
    expect(events.map((e) => e.step)).toEqual(["escrow_created", "escrow_funded"]);
    expect(events[0].id).toBeTruthy();
    expect(Date.parse(events[0].at)).not.toBeNaN();
  });

  it("flags escrows that were created but never funded", () => {
    recordPaymentEvent({ ...base, step: "escrow_created", escrowId: "1" });
    recordPaymentEvent({ ...base, step: "escrow_funded", escrowId: "1" });
    recordPaymentEvent({ ...base, step: "escrow_created", escrowId: "2" });
    recordPaymentEvent({ ...base, step: "step_failed", failedAction: "fund", escrowId: "2", errorCode: 13 });

    expect(unfundedEscrows("GBUYER").map((e) => e.escrowId)).toEqual(["2"]);
    expect(unfundedEscrows("GSOMEONE_ELSE")).toEqual([]);
  });

  it("returns the latest state of each escrow for a wallet, as buyer or seller", () => {
    recordPaymentEvent({ ...base, step: "escrow_created", escrowId: "1" });
    recordPaymentEvent({ ...base, step: "escrow_released", escrowId: "1" });

    const asBuyer = escrowsForWallet("GBUYER");
    const asSeller = escrowsForWallet("GSELLER");
    expect(asBuyer).toHaveLength(1);
    expect(asBuyer[0].step).toBe("escrow_released");
    expect(asSeller[0].escrowId).toBe("1");
  });

  it("keeps failure details for debugging", () => {
    recordPaymentEvent({ ...base, step: "step_failed", failedAction: "release", escrowId: "5", errorCode: 11, errorMessage: "wrong state" });
    const [failure] = eventsForEscrow("5");
    expect(failure).toMatchObject({ failedAction: "release", errorCode: 11, errorMessage: "wrong state" });
  });

  describe("mapDbPaymentEvent", () => {
    it("maps snake_case database row to PaymentEvent", () => {
      const dbRow = {
        id: "ev-1",
        step: "escrow_funded",
        failed_action: null,
        network: "testnet",
        contract_id: "CTEST",
        chain_escrow_id: "100",
        product_id: "prod-1",
        buyer_address: "GBUYER",
        seller_address: "GSELLER",
        amount_xlm: "25.5",
        tx_hash: "tx-hash-1",
        error_code: null,
        error_message: null,
        client_at: "2026-11-20T10:00:00.000Z",
        created_at: "2026-11-20T10:00:01.000Z",
      };

      const event = mapDbPaymentEvent(dbRow);
      expect(event).toEqual({
        id: "ev-1",
        at: "2026-11-20T10:00:00.000Z",
        step: "escrow_funded",
        failedAction: undefined,
        escrowId: "100",
        productId: "prod-1",
        buyer: "GBUYER",
        seller: "GSELLER",
        amountXlm: 25.5,
        txHash: "tx-hash-1",
        errorCode: undefined,
        errorMessage: undefined,
        network: "testnet",
        contractId: "CTEST",
      });
    });

    it("maps failure rows with error code and action intact", () => {
      const dbRow = {
        id: "ev-fail",
        step: "step_failed",
        failed_action: "fund",
        network: "testnet",
        contract_id: "CTEST",
        chain_escrow_id: "101",
        error_code: 14,
        error_message: "insufficient balance",
        created_at: "2026-11-21T10:00:00.000Z",
      };

      const event = mapDbPaymentEvent(dbRow);
      expect(event.step).toBe("step_failed");
      expect(event.failedAction).toBe("fund");
      expect(event.errorCode).toBe(14);
      expect(event.errorMessage).toBe("insufficient balance");
    });
  });

  describe("mergePaymentEvents", () => {
    it("deduplicates events by txHash and sorts chronologically", () => {
      const local: PaymentEvent[] = [
        {
          id: "local-1",
          at: "2026-11-20T10:00:00.000Z",
          step: "escrow_created",
          txHash: "tx-create",
          network: "testnet",
          contractId: "CTEST",
          escrowId: "1",
        },
        {
          id: "local-2",
          at: "2026-11-20T10:05:00.000Z",
          step: "escrow_funded",
          txHash: "tx-fund",
          network: "testnet",
          contractId: "CTEST",
          escrowId: "1",
        },
      ];

      const remote: PaymentEvent[] = [
        {
          id: "remote-2",
          at: "2026-11-20T10:05:00.000Z",
          step: "escrow_funded",
          txHash: "tx-fund", // same txHash as local-2
          network: "testnet",
          contractId: "CTEST",
          escrowId: "1",
        },
        {
          id: "remote-3",
          at: "2026-11-20T11:00:00.000Z",
          step: "order_shipped",
          network: "testnet",
          contractId: "CTEST",
          escrowId: "1",
        },
        {
          id: "remote-4",
          at: "2026-11-20T12:00:00.000Z",
          step: "escrow_released",
          txHash: "tx-release",
          network: "testnet",
          contractId: "CTEST",
          escrowId: "1",
        },
      ];

      const merged = mergePaymentEvents(local, remote);

      expect(merged).toHaveLength(4);
      expect(merged.map((e) => e.step)).toEqual([
        "escrow_created",
        "escrow_funded",
        "order_shipped",
        "escrow_released",
      ]);
    });

    it("retains failure steps with contract error code", () => {
      const local: PaymentEvent[] = [
        {
          id: "fail-1",
          at: "2026-11-20T10:02:00.000Z",
          step: "step_failed",
          failedAction: "fund",
          errorCode: 12,
          errorMessage: "Authorization expired",
          network: "testnet",
          contractId: "CTEST",
          escrowId: "1",
        },
      ];

      const remote: PaymentEvent[] = [
        {
          id: "remote-1",
          at: "2026-11-20T10:00:00.000Z",
          step: "escrow_created",
          txHash: "tx-created",
          network: "testnet",
          contractId: "CTEST",
          escrowId: "1",
        },
      ];

      const merged = mergePaymentEvents(local, remote);
      expect(merged).toHaveLength(2);
      expect(merged[1].step).toBe("step_failed");
      expect(merged[1].errorCode).toBe(12);
      expect(merged[1].errorMessage).toBe("Authorization expired");
    });

    it("displays full history on a new browser with empty local journal", () => {
      const remote: PaymentEvent[] = [
        {
          id: "remote-1",
          at: "2026-11-20T10:00:00.000Z",
          step: "escrow_created",
          txHash: "tx-created",
          network: "testnet",
          contractId: "CTEST",
          escrowId: "1",
        },
        {
          id: "remote-2",
          at: "2026-11-20T10:05:00.000Z",
          step: "escrow_funded",
          txHash: "tx-fund",
          network: "testnet",
          contractId: "CTEST",
          escrowId: "1",
        },
      ];

      const merged = mergePaymentEvents([], remote);
      expect(merged).toHaveLength(2);
      expect(merged.map((e) => e.step)).toEqual(["escrow_created", "escrow_funded"]);
    });
  });
});
