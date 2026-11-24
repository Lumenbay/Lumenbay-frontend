import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient as createSessionClient } from "@/lib/supabase/server";
import { isConfirmedTx, readClaimableAt, readEscrow, readRefundRequests, type OnChainEscrow } from "@/lib/stellar/chain";
import { noteFingerprint } from "@/lib/admin/disputes";
import { STELLAR } from "@/lib/stellar/config";
import { parseOrderTag } from "@/lib/orderTag";
import { decimalXlmToStroops, orderStatusFor, stepsToMatchChain, type DbEscrowState } from "./escrowState";

/**
 * Server side of the order lifecycle. Every write here is preceded by a read
 * of the escrow from the contract: the chain holds the money, so the
 * database only ever records what the chain already shows.
 */

export class OrderApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type Admin = SupabaseClient;

export interface EscrowRow {
  id: string;
  order_id: string;
  buyer_id: string;
  seller_id: string;
  asset_name: string;
  price_xlm: string;
  current_state: DbEscrowState;
  chain_escrow_id: number;
}

const ESCROW_COLUMNS = "id, order_id, buyer_id, seller_id, asset_name, price_xlm, current_state, chain_escrow_id";

export async function requireUserId(): Promise<string> {
  const supabase = await createSessionClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new OrderApiError(401, "Sign in again to continue.");
  return data.user.id;
}

export function parseChainId(value: unknown): bigint {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^\d{1,18}$/.test(text)) {
    throw new OrderApiError(400, "That isn't a valid escrow number.");
  }
  return BigInt(text);
}

export async function readChain(id: bigint): Promise<OnChainEscrow> {
  let escrow: OnChainEscrow | null;
  try {
    escrow = await readEscrow(id);
  } catch (e) {
    console.error("[lumenbay:orders] chain read failed", { id: id.toString(), error: String(e) });
    throw new OrderApiError(502, "Couldn't reach the Stellar network. Try again in a moment.");
  }
  if (!escrow) throw new OrderApiError(404, `Escrow #${id} doesn't exist on ${STELLAR.network}.`);
  return escrow;
}

export async function findEscrowRow(admin: Admin, id: bigint): Promise<EscrowRow | null> {
  const { data, error } = await admin
    .from("escrows")
    .select(ESCROW_COLUMNS)
    .eq("contract_id", STELLAR.escrowContractId)
    .eq("chain_escrow_id", id.toString())
    .maybeSingle();
  if (error) throw dbError("find escrow", error);
  return data as EscrowRow | null;
}

export function dbError(what: string, error: { message: string; code?: string }) {
  console.error(`[lumenbay:orders] ${what} failed`, error);
  return new OrderApiError(500, "Couldn't save to the database. Your money is safe on-chain; try again.");
}

export async function notify(admin: Admin, userId: string, item: { type: "order" | "payment"; severity: "success" | "info" | "warning"; title: string; description: string; href: string }) {
  const { error } = await admin.from("activity_items").insert({ user_id: userId, ...item });
  if (error) console.error("[lumenbay:orders] notification failed", error); // never block the order on this
}

export function stroopsToXlmString(stroops: bigint): string {
  const whole = stroops / BigInt(10_000_000);
  const fraction = (stroops % BigInt(10_000_000)).toString().padStart(7, "0");
  return `${whole}.${fraction}`;
}

// ---------------------------------------------------------------------------
// Record: turn a funded on-chain escrow into an order both parties can see
// ---------------------------------------------------------------------------

export async function recordOrder(userId: string, id: bigint, hashes: { createTxHash?: string; fundTxHash?: string }) {
  const admin = createAdminClient();

  const existing = await findEscrowRow(admin, id);
  if (existing) {
    if (existing.buyer_id !== userId && existing.seller_id !== userId) throw new OrderApiError(403, "This order belongs to someone else.");
    return syncOrder(userId, id, {}); // a retry: already recorded, just make sure it's current
  }

  const chain = await readChain(id);

  const tag = parseOrderTag(chain.metadata);
  if (!tag) throw new OrderApiError(422, "This escrow wasn't created by Lumenbay checkout, so it can't be recorded as an order.");
  if (tag.buyerUserId !== userId) throw new OrderApiError(403, "This escrow was paid from a different Lumenbay account.");
  if (chain.status === "Pending") throw new OrderApiError(409, "The payment isn't locked yet. Finish payment first.");
  if (chain.status === "Cancelled") throw new OrderApiError(409, "This escrow was cancelled before it was paid.");
  if (chain.token !== STELLAR.xlmTokenId) throw new OrderApiError(422, "This escrow isn't paid in XLM.");

  const { data: product, error: productError } = await admin
    .from("products")
    .select("id, name, seller_id, usd_price, xlm_price, status")
    .eq("id", tag.productId)
    .maybeSingle();
  if (productError) throw dbError("load product", productError);
  if (!product) throw new OrderApiError(404, "The listing for this escrow no longer exists.");
  if (product.seller_id === userId) throw new OrderApiError(422, "You can't buy your own listing.");

  const { data: seller, error: sellerError } = await admin
    .from("profiles")
    .select("stellar_address")
    .eq("id", product.seller_id)
    .maybeSingle();
  if (sellerError) throw dbError("load seller", sellerError);
  if (!seller?.stellar_address || seller.stellar_address !== chain.seller) {
    throw new OrderApiError(422, "This escrow pays a wallet that isn't the seller's payout wallet.");
  }

  const price = decimalXlmToStroops(product.xlm_price);
  if (chain.amount < price) throw new OrderApiError(422, "The amount locked is less than the listing price.");

  const [createOk, fundOk] = await Promise.all([
    isConfirmedTx(hashes.createTxHash, chain.buyer),
    isConfirmedTx(hashes.fundTxHash, chain.buyer),
  ]);

  const lockedXlm = stroopsToXlmString(chain.amount);
  const idempotencyKey = `${STELLAR.escrowContractId}:${id}`;

  // Order first, then the escrow row that settles it.
  let orderId: string;
  let createdOrder = false;
  const { data: order, error: orderError } = await admin
    .from("orders")
    .insert({
      buyer_id: userId,
      seller_id: product.seller_id,
      product_id: product.id,
      quantity: 1,
      unit_usd_price: product.usd_price,
      unit_xlm_price: product.xlm_price,
      total_xlm_price: lockedXlm,
      status: "paid",
      idempotency_key: idempotencyKey,
    })
    .select("id")
    .single();
  if (order) {
    orderId = order.id;
    createdOrder = true;
  } else if (orderError?.code === "23505") {
    // A concurrent retry got there first.
    const { data: again, error } = await admin.from("orders").select("id").eq("buyer_id", userId).eq("idempotency_key", idempotencyKey).single();
    if (error || !again) throw dbError("reload order", error ?? { message: "missing" });
    orderId = again.id;
  } else {
    throw dbError("insert order", orderError ?? { message: "no row" });
  }

  const { data: escrowRow, error: escrowError } = await admin
    .from("escrows")
    .insert({
      order_id: orderId,
      asset_name: product.name,
      asset_category: "Physical",
      price_xlm: lockedXlm,
      buyer_id: userId,
      seller_id: product.seller_id,
      buyer_address: chain.buyer,
      seller_address: chain.seller,
      current_state: "funded",
      network: STELLAR.network,
      contract_id: STELLAR.escrowContractId,
      chain_escrow_id: id.toString(),
      amount_stroops: chain.amount.toString(),
      create_tx_hash: createOk ? hashes.createTxHash : null,
      fund_tx_hash: fundOk ? hashes.fundTxHash : null,
      chain_synced_at: new Date().toISOString(),
    })
    .select(ESCROW_COLUMNS)
    .single();

  if (!escrowRow) {
    if (escrowError?.code === "23505") return syncOrder(userId, id, {});
    // Don't leave an order with nothing settling it; the client will retry.
    if (createdOrder) await admin.from("orders").delete().eq("id", orderId);
    throw dbError("insert escrow", escrowError ?? { message: "no row" });
  }

  await admin.from("escrow_events").insert({
    escrow_id: escrowRow.id,
    state: "funded",
    label: "Payment locked",
    actor: "buyer",
    description: `${lockedXlm} XLM locked in escrow #${id} on ${STELLAR.network}.`,
  });

  // One of a kind: take it off the shelf so nobody else pays for it.
  await admin.from("products").update({ status: "sold" }).eq("id", product.id).eq("status", "active");

  await Promise.all([
    notify(admin, product.seller_id, {
      type: "order",
      severity: "success",
      title: `New order: ${product.name}`,
      description: `${Number(lockedXlm).toLocaleString()} XLM is locked in escrow. Ship it, and you're paid when the buyer confirms delivery.`,
      href: `/dashboard/escrow/${id}`,
    }),
    notify(admin, userId, {
      type: "payment",
      severity: "success",
      title: `Payment locked: ${product.name}`,
      description: "Your XLM is held by the escrow contract until you confirm delivery.",
      href: `/dashboard/escrow/${id}`,
    }),
  ]);

  console.info("[lumenbay:orders] recorded", { escrow: id.toString(), orderId, buyer: userId, seller: product.seller_id });

  // The chain may already be past Funded (e.g. recorded late, after a release).
  if (chain.status !== "Funded") return syncOrder(userId, id, {});
  return { orderId, state: "funded" as DbEscrowState };
}

// ---------------------------------------------------------------------------
// Sync: bring the database in line with the chain after release / dispute
// ---------------------------------------------------------------------------

export async function syncOrder(userId: string, id: bigint, hashes: { releaseTxHash?: string }, disputeNote?: string) {
  const admin = createAdminClient();
  const row = await findEscrowRow(admin, id);
  if (!row) throw new OrderApiError(404, "This order hasn't been recorded yet.");
  if (row.buyer_id !== userId && row.seller_id !== userId) throw new OrderApiError(403, "This order belongs to someone else.");

  const chain = await readChain(id);
  const state = await applyChainState(admin, row, chain, hashes);

  // The buyer's own words: stored only when they match the fingerprint on-chain.
  if (state === "disputed" && disputeNote && row.buyer_id === userId) {
    await storeDisputeNote(admin, row.id, id, disputeNote);
  }

  return { orderId: row.order_id, state };
}

/**
 * Steps the escrow row to the chain's status, updates the order and tells
 * the right people. Shared by the parties' sync and the admin tools.
 */
export async function applyChainState(admin: Admin, row: EscrowRow, chain: OnChainEscrow, hashes: { releaseTxHash?: string } = {}): Promise<DbEscrowState> {
  const id = chain.id;
  const steps = stepsToMatchChain(row.current_state, chain.status);
  const wasDisputed = row.current_state === "disputed" || steps.includes("disputed");

  let state = row.current_state;
  for (const next of steps) {
    const patch: Record<string, unknown> = { current_state: next };
    if (next === "released" && !wasDisputed && (await isConfirmedTx(hashes.releaseTxHash, chain.buyer))) {
      patch.release_tx_hash = hashes.releaseTxHash;
    }
    if (next === "disputed") {
      patch.disputed_at = new Date().toISOString();
      patch.dispute_reason = await latestDisputeReason(id);
    }
    if ((next === "released" || next === "refunded") && wasDisputed) {
      // An admin ruling. The money moves later, after the appeal window.
      patch.resolution = next === "refunded" ? "refund" : "release";
      patch.resolved_at = new Date().toISOString();
      patch.claimable_at_ledger = await readClaimableAt(id).catch(() => null);
    }
    const { error } = await admin.from("escrows").update(patch).eq("id", row.id).eq("current_state", state);
    if (error) throw dbError(`move escrow ${state} -> ${next}`, error);
    state = next;
  }

  await admin.from("escrows").update({ chain_synced_at: new Date().toISOString() }).eq("id", row.id);

  if (steps.length) {
    const { error } = await admin.from("orders").update({ status: orderStatusFor(state) }).eq("id", row.order_id);
    if (error) throw dbError("update order status", error);

    const href = `/dashboard/escrow/${id}`;
    if (state === "released" && wasDisputed) {
      await Promise.all([
        notify(admin, row.seller_id, { type: "payment", severity: "success", title: `Dispute resolved in your favour: ${row.asset_name}`, description: "The payment is released to you after a 24-hour appeal window.", href }),
        notify(admin, row.buyer_id, { type: "order", severity: "info", title: `Dispute closed: ${row.asset_name}`, description: "The dispute was reviewed and the payment goes to the seller.", href }),
      ]);
    } else if (state === "released") {
      await notify(admin, row.seller_id, { type: "payment", severity: "success", title: `You've been paid: ${row.asset_name}`, description: "The buyer confirmed delivery and the escrow paid out to your wallet.", href });
    } else if (state === "disputed") {
      await notify(admin, row.seller_id, { type: "order", severity: "warning", title: `Dispute opened: ${row.asset_name}`, description: "The buyer reported a problem. The payment stays locked until it's resolved.", href });
    } else if (state === "refunded") {
      await Promise.all([
        notify(admin, row.buyer_id, { type: "payment", severity: "success", title: `Refund approved: ${row.asset_name}`, description: "The dispute was resolved in your favour. Your XLM is returned after a 24-hour appeal window.", href }),
        notify(admin, row.seller_id, { type: "order", severity: "warning", title: `Dispute closed: ${row.asset_name}`, description: "The dispute was reviewed and the buyer is refunded.", href }),
      ]);
    }
    console.info("[lumenbay:orders] synced", { escrow: id.toString(), from: row.current_state, to: state });
  }

  return state;
}

async function latestDisputeReason(id: bigint): Promise<string | null> {
  try {
    const requests = await readRefundRequests(id);
    return requests.at(-1)?.reason ?? null;
  } catch {
    return null;
  }
}

async function storeDisputeNote(admin: Admin, rowId: string, id: bigint, note: string) {
  const text = note.slice(0, 2000);
  try {
    const latest = (await readRefundRequests(id)).at(-1);
    if (!latest?.evidenceHash || latest.evidenceHash !== (await noteFingerprint(note))) return;
    const { error } = await admin
      .from("escrows")
      .update({ dispute_note: text, dispute_reason: latest.reason })
      .eq("id", rowId);
    if (error) console.error("[lumenbay:orders] store dispute note failed", error);
  } catch (e) {
    console.error("[lumenbay:orders] store dispute note failed", e); // the dispute itself is on-chain already
  }
}

// ---------------------------------------------------------------------------
// Ship: the seller says the item is on its way
// ---------------------------------------------------------------------------

export async function markShipped(userId: string, id: bigint, note: string) {
  const trimmed = note.trim();
  if (trimmed.length > 500) throw new OrderApiError(400, "Keep the shipping note under 500 characters.");

  const admin = createAdminClient();
  const row = await findEscrowRow(admin, id);
  if (!row) throw new OrderApiError(404, "This order hasn't been recorded yet.");
  if (row.seller_id !== userId) throw new OrderApiError(403, "Only the seller can mark this order as shipped.");

  // Catch anything that changed on-chain first, e.g. the buyer already released.
  const { state } = await syncOrder(userId, id, {});
  if (state === "in_transit") return { orderId: row.order_id, state }; // already shipped
  if (state !== "funded" && state !== "in_escrow") {
    throw new OrderApiError(409, "This order can't be shipped any more; check its status.");
  }

  const { error } = await admin
    .from("escrows")
    .update({ current_state: "in_transit", shipped_at: new Date().toISOString(), shipping_note: trimmed || null })
    .eq("id", row.id)
    .eq("current_state", state);
  if (error) throw dbError("mark shipped", error);

  await admin.from("payment_events").insert({
    user_id: userId,
    step: "order_shipped",
    network: STELLAR.network,
    contract_id: STELLAR.escrowContractId,
    chain_escrow_id: id.toString(),
    client_at: new Date().toISOString(),
  });

  await notify(admin, row.buyer_id, {
    type: "order",
    severity: "info",
    title: `Shipped: ${row.asset_name}`,
    description: trimmed ? `The seller says: "${trimmed.slice(0, 160)}"` : "The seller marked your order as shipped. Confirm delivery once it arrives.",
    href: `/dashboard/escrow/${id}`,
  });

  console.info("[lumenbay:orders] shipped", { escrow: id.toString(), seller: userId });
  return { orderId: row.order_id, state: "in_transit" as DbEscrowState };
}

export async function getEscrowPaymentEvents(userId: string, id: bigint) {
  const admin = createAdminClient();
  const row = await findEscrowRow(admin, id);
  if (row && row.buyer_id !== userId && row.seller_id !== userId) {
    throw new OrderApiError(403, "This order belongs to someone else.");
  }

  const { data, error } = await admin
    .from("payment_events")
    .select("id, step, failed_action, network, contract_id, chain_escrow_id, product_id, buyer_address, seller_address, amount_xlm, tx_hash, error_code, error_message, client_at, created_at")
    .eq("contract_id", STELLAR.escrowContractId)
    .eq("chain_escrow_id", id.toString())
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) throw new OrderApiError(500, error.message);
  return { events: data ?? [] };
}
