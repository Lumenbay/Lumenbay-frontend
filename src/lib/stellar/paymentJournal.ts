/**
 * Append-only record of every money-moving step the browser attempts.
 *
 * Each entry says what was tried, by which wallet, for how much, and what came
 * back (a transaction hash on success, the raw error and contract code on
 * failure). It is kept locally so a buyer's own history survives reloads, and
 * is the shape the server-side audit table will store.
 */

export type PaymentStep =
  | "checkout_started"
  | "escrow_created"
  | "escrow_funded"
  | "order_shipped"
  | "escrow_released"
  | "dispute_opened"
  | "step_failed";

export interface PaymentEvent {
  id: string;
  at: string;
  step: PaymentStep;
  /** Which action failed, for `step_failed`. */
  failedAction?: "create" | "fund" | "release" | "dispute";
  escrowId?: string;
  productId?: string;
  buyer?: string;
  seller?: string;
  amountXlm?: number;
  txHash?: string;
  errorCode?: number;
  errorMessage?: string;
  network: string;
  contractId: string;
}

const KEY = "lumenbay-payment-journal";
const CHANGE_EVENT = "lumenbay-payment-journal-change";
const MAX_EVENTS = 500;

export function parseJournal(raw: string | null): PaymentEvent[] {
  try {
    return JSON.parse(raw || "[]") as PaymentEvent[];
  } catch {
    return [];
  }
}

function read(): PaymentEvent[] {
  try {
    return parseJournal(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

/** For useSyncExternalStore: the raw journal string, stable until it changes. */
export function journalSnapshot(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

/** Notifies on changes from this tab and from other tabs. */
export function subscribeJournal(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

export function recordPaymentEvent(event: Omit<PaymentEvent, "id" | "at">): PaymentEvent {
  const full: PaymentEvent = { id: crypto.randomUUID(), at: new Date().toISOString(), ...event };
  try {
    const events = read();
    events.push(full);
    localStorage.setItem(KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // Storage can be unavailable (private mode). The console line below still records it.
  }
  const log = event.step === "step_failed" ? console.error : console.info;
  log("[lumenbay:payment]", full);
  void persist(full);
  return full;
}

/**
 * Copies the event to the `payment_events` audit table, so failures are
 * visible to us and not only in this browser. Best effort: a failed write
 * must never break a payment flow.
 */
async function persist(e: PaymentEvent) {
  try {
    const { createClient } = await import("@/lib/supabase/client");
    const { error } = await createClient().from("payment_events").insert({
      step: e.step,
      failed_action: e.failedAction ?? null,
      network: e.network,
      contract_id: e.contractId,
      chain_escrow_id: e.escrowId ?? null,
      product_id: e.productId ?? null,
      buyer_address: e.buyer ?? null,
      seller_address: e.seller ?? null,
      amount_xlm: e.amountXlm ?? null,
      tx_hash: e.txHash ?? null,
      error_code: e.errorCode ?? null,
      error_message: e.errorMessage?.slice(0, 1000) ?? null,
      client_at: e.at,
    });
    if (error) console.warn("[lumenbay:payment] audit write failed", error.message);
  } catch (err) {
    console.warn("[lumenbay:payment] audit write failed", err);
  }
}

/** All recorded events for one escrow, oldest first. */
export function eventsForEscrow(escrowId: string): PaymentEvent[] {
  return read().filter((e) => e.escrowId === escrowId);
}

/** Latest recorded event per escrow involving this wallet, newest first. */
export function escrowsForWallet(address: string, events: PaymentEvent[] = read()): PaymentEvent[] {
  const latest = new Map<string, PaymentEvent>();
  for (const e of events) {
    if (!e.escrowId || (e.buyer !== address && e.seller !== address)) continue;
    latest.set(e.escrowId, e);
  }
  return [...latest.values()].sort((a, b) => b.at.localeCompare(a.at));
}

/** Escrows this browser created but never managed to fund, newest first. */
export function unfundedEscrows(buyer: string, events: PaymentEvent[] = read()): PaymentEvent[] {
  const funded = new Set(events.filter((e) => e.step === "escrow_funded").map((e) => e.escrowId));
  return events
    .filter((e) => e.step === "escrow_created" && e.buyer === buyer && !funded.has(e.escrowId))
    .reverse();
}

/** Maps a row from `payment_events` table into `PaymentEvent`. */
export function mapDbPaymentEvent(row: Record<string, unknown>): PaymentEvent {
  return {
    id: String(row.id || crypto.randomUUID()),
    at: String(row.client_at || row.created_at || new Date().toISOString()),
    step: (row.step as PaymentStep) || "escrow_created",
    failedAction: (row.failed_action as PaymentEvent["failedAction"]) || undefined,
    escrowId: row.chain_escrow_id ? String(row.chain_escrow_id) : undefined,
    productId: row.product_id ? String(row.product_id) : undefined,
    buyer: row.buyer_address ? String(row.buyer_address) : undefined,
    seller: row.seller_address ? String(row.seller_address) : undefined,
    amountXlm: row.amount_xlm != null ? Number(row.amount_xlm) : undefined,
    txHash: row.tx_hash ? String(row.tx_hash) : undefined,
    errorCode: row.error_code != null ? Number(row.error_code) : undefined,
    errorMessage: row.error_message ? String(row.error_message) : undefined,
    network: String(row.network || ""),
    contractId: String(row.contract_id || ""),
  };
}

/**
 * Merges local browser journal with remote database events.
 * Deduplicates by txHash (or id if no txHash), preserving error details and failures,
 * and sorts all events by timestamp ascending (oldest first).
 */
export function mergePaymentEvents(
  localEvents: PaymentEvent[],
  remoteEvents: PaymentEvent[],
): PaymentEvent[] {
  const merged: PaymentEvent[] = [];
  const seenTxHashes = new Set<string>();
  const seenIds = new Set<string>();

  for (const event of remoteEvents) {
    if (event.txHash) {
      seenTxHashes.add(event.txHash);
    }
    seenIds.add(event.id);
    merged.push(event);
  }

  for (const event of localEvents) {
    if (seenIds.has(event.id)) continue;
    if (event.txHash && seenTxHashes.has(event.txHash)) continue;

    if (event.txHash) {
      seenTxHashes.add(event.txHash);
    }
    seenIds.add(event.id);
    merged.push(event);
  }

  return merged.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}
