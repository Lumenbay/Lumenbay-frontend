"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Gavel,
  Loader2,
  Lock,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  Store,
  Truck,
  Wallet,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useWallet } from "@/context/WalletContext";
import { parseOrderTag } from "@/lib/orderTag";
import { fetchEscrowPaymentEvents, markOrderShipped, recordOrder, syncOrder } from "@/lib/orders/client";
import { getOrderByChainId, type OrderSummary } from "@/lib/orders/queries";
import { createClient } from "@/lib/supabase/client";
import { STELLAR, explorerAccount, explorerContract, explorerTx } from "@/lib/stellar/config";
import { recordPayout } from "@/lib/admin/client";
import { countdownLabel, payoutState } from "@/lib/admin/disputes";
import { readClaimableAt, readLatestLedger } from "@/lib/stellar/chain";
import {
  EscrowError,
  claimDisputedFunds,
  fundEscrow,
  getEscrow,
  openDispute,
  releaseEscrow,
  stroopsToXlm,
  type OnChainEscrow,
  type RefundReason,
} from "@/lib/stellar/escrow";
import { eventsForEscrow, mergePaymentEvents, recordPaymentEvent, type PaymentEvent } from "@/lib/stellar/paymentJournal";
import { formatAddress } from "@/lib/utils";

const TRACK = ["Created", "Funds locked", "Shipped", "Released"] as const;

const STATUS_COPY: Record<string, { label: string; body: string; tone: string }> = {
  Pending: { label: "Awaiting payment", body: "The escrow exists but no funds are locked yet.", tone: "text-warn" },
  Funded: { label: "Funds locked", body: "The payment is held by the contract. Confirm delivery once the item arrives.", tone: "text-accent" },
  Released: { label: "Completed", body: "Delivery was confirmed and the seller has been paid.", tone: "text-ok" },
  Disputed: { label: "In dispute", body: "Funds stay locked while the dispute is reviewed. The outcome is either a refund or a release.", tone: "text-bad" },
  Refunded: { label: "Refunded", body: "The dispute was resolved in the buyer's favour.", tone: "text-ok" },
  Cancelled: { label: "Cancelled", body: "This escrow was cancelled before it was funded.", tone: "text-ink-muted" },
};

const RULED_COPY: Record<"refund" | "release", { label: string; body: string; tone: string }> = {
  refund: { label: "Refunded after review", body: "Lumenbay reviewed the dispute and refunded the buyer in full.", tone: "text-ok" },
  release: { label: "Released after review", body: "Lumenbay reviewed the dispute and released the payment to the seller.", tone: "text-ok" },
};

const REASONS: { value: RefundReason; label: string }[] = [
  { value: "ProductNotReceived", label: "Item never arrived" },
  { value: "ProductDefective", label: "Item is damaged or defective" },
  { value: "WrongProduct", label: "Wrong item received" },
  { value: "Other", label: "Something else" },
];

export default function EscrowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const escrowId = /^\d+$/.test(id) ? BigInt(id) : null;
  const wallet = useWallet();
  const { user } = useAuth();

  const [escrow, setEscrow] = useState<OnChainEscrow | null | undefined>(undefined);
  const [order, setOrder] = useState<OrderSummary | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [journal, setJournal] = useState<PaymentEvent[]>([]);
  const [busy, setBusy] = useState<null | "fund" | "release" | "dispute" | "ship" | "save">(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [reason, setReason] = useState<RefundReason>("ProductNotReceived");
  const [note, setNote] = useState("");
  const [shipNote, setShipNote] = useState("");

  const loadOrder = useCallback(async () => {
    if (escrowId === null || !user) return setOrder(null);
    try {
      setOrder(await getOrderByChainId(createClient(), user.id, escrowId.toString()));
    } catch (e) {
      console.error("[lumenbay:orders] load order failed", e);
      setOrder(null);
    }
  }, [escrowId, user]);

  const load = useCallback(async () => {
    if (escrowId === null) return;
    setLoadError(null);
    try {
      setEscrow(await getEscrow(escrowId));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't read this escrow from the network.");
    }
    const local = eventsForEscrow(escrowId.toString());
    setJournal(local);
    fetchEscrowPaymentEvents(escrowId)
      .then((remote) => {
        setJournal(mergePaymentEvents(local, remote));
      })
      .catch(() => {});
    await loadOrder();
  }, [escrowId, loadOrder]);

  useEffect(() => {
    void load();
  }, [load]);

  // Opening the page is a good moment to catch up with anything that happened on-chain.
  const orderKnown = !!order;
  useEffect(() => {
    if (escrowId === null || !orderKnown) return;
    syncOrder(escrowId)
      .then(() => loadOrder())
      .catch(() => {}); // the chain read above is still shown; sync is a background tidy-up
  }, [escrowId, orderKnown, loadOrder]);

  if (escrowId === null) return <Shell><p className="text-ink-muted">That isn&apos;t a valid escrow number.</p></Shell>;

  // The account decides the role when the order is saved; otherwise fall back to the wallet.
  const isBuyer = order ? order.role === "buyer" : !!escrow && wallet.address === escrow.buyer;
  const isSeller = order ? order.role === "seller" : !!escrow && wallet.address === escrow.seller;
  const walletIsBuyer = !!escrow && wallet.address === escrow.buyer;
  const shipped = order?.state === "in_transit" || !!order?.shippedAt;
  const amountXlm = escrow ? stroopsToXlm(escrow.amount) : 0;
  // A dispute an admin settled: the plain Released/Refunded copy would be wrong.
  const ruled = order?.resolution ?? null;
  const copy = escrow ? (ruled ? RULED_COPY[ruled] : STATUS_COPY[escrow.status] ?? STATUS_COPY.Pending) : null;

  const run = async (action: "fund" | "release" | "dispute") => {
    if (!escrow || !wallet.address) return;
    setBusy(action);
    setActionError(null);
    const base = {
      escrowId: escrow.id.toString(),
      buyer: escrow.buyer,
      seller: escrow.seller,
      amountXlm,
      network: STELLAR.network,
      contractId: STELLAR.escrowContractId,
    };
    try {
      if (action === "fund") {
        const { hash } = await fundEscrow(wallet.address, escrow.id);
        recordPaymentEvent({ ...base, step: "escrow_funded", txHash: hash });
        await recordOrder(escrow.id, { fundTxHash: hash }).catch((e) => setActionError(`Payment locked, but the order isn't saved yet: ${e.message}`));
      } else if (action === "release") {
        const { hash } = await releaseEscrow(wallet.address, escrow.id);
        recordPaymentEvent({ ...base, step: "escrow_released", txHash: hash });
        if (order) await syncOrder(escrow.id, hash).catch(() => {});
      } else {
        const { hash } = await openDispute({ buyer: wallet.address, escrowId: escrow.id, amountStroops: escrow.amount, reason, note });
        recordPaymentEvent({ ...base, step: "dispute_opened", txHash: hash });
        if (order) await syncOrder(escrow.id, undefined, note).catch(() => {});
        setDisputeOpen(false);
      }
      await load();
      void wallet.refresh();
    } catch (e) {
      const err = e instanceof EscrowError ? e : new EscrowError(String(e));
      recordPaymentEvent({ ...base, step: "step_failed", failedAction: action, errorCode: err.code, errorMessage: err.message });
      setActionError(err.message);
      const local = eventsForEscrow(escrow.id.toString());
      fetchEscrowPaymentEvents(escrow.id)
        .then((remote) => setJournal(mergePaymentEvents(local, remote)))
        .catch(() => setJournal(local));
    } finally {
      setBusy(null);
    }
  };

  /** Server-side actions: no wallet signature, the server checks the chain. */
  const serverAction = async (action: "ship" | "save") => {
    if (!escrow) return;
    setBusy(action);
    setActionError(null);
    try {
      if (action === "ship") await markOrderShipped(escrow.id, shipNote);
      else await recordOrder(escrow.id, {});
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const holding = escrow?.status === "Funded";

  return (
    <Shell>
      <div className="flex items-center justify-between">
        <Link href={isSeller ? "/dashboard/selling" : "/dashboard/buying"} className="inline-flex items-center gap-1 text-xs font-semibold text-ink-faint hover:text-accent">
          <ArrowLeft className="h-3.5 w-3.5" /> {isSeller ? "Seller hub" : "My purchases"}
        </Link>
        <button onClick={() => load()} className="inline-flex items-center gap-1 text-xs font-semibold text-ink-faint hover:text-accent">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh from chain
        </button>
      </div>

      <header className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-ink-faint">
            Escrow #{id}
            {order && <> · <Link href={`/product/${order.productId}`} className="normal-case tracking-normal text-ink-muted hover:text-accent">{order.productName}</Link></>}
          </p>
          <h1 className="font-display mt-1 text-3xl font-extrabold tracking-tight text-ink">
            {escrow ? `${amountXlm.toLocaleString()} XLM` : "Loading…"}
          </h1>
        </div>
        {copy && <span className={`rounded-full bg-surface-2 px-3 py-1 text-sm font-bold ${copy.tone}`}>{copy.label}</span>}
      </header>

      {escrow && (
        <RoleBanner
          role={isBuyer ? "buyer" : isSeller ? "seller" : wallet.address ? "outsider" : "unknown"}
          status={ruled ? (ruled === "refund" ? "RuledRefund" : "RuledRelease") : escrow.status === "Funded" && shipped ? "Shipped" : escrow.status}
          counterparty={order?.counterparty}
        />
      )}

      {loadError && <Alert>{loadError}</Alert>}
      {escrow === null && <Alert>No escrow #{id} exists on {STELLAR.network}.</Alert>}

      {escrow && copy && (
        <>
          <Track status={ruled ? "Ruled" : escrow.status} shipped={shipped} />
          <p className="mt-4 text-sm text-ink-muted">{copy.body}</p>

          {order && ruled && (
            <DisputeOutcome
              order={order}
              escrowId={escrow.id}
              amountXlm={amountXlm}
              wallet={wallet.address}
              onPaid={() => load()}
            />
          )}

          {order?.shippedAt && (
            <div className="mt-4 flex items-start gap-3 rounded-2xl border border-line bg-surface p-4">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-accent">
                <Truck className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-bold text-ink">Shipped {new Date(order.shippedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</p>
                {order.shippingNote ? (
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-ink-muted">{order.shippingNote}</p>
                ) : (
                  <p className="mt-0.5 text-xs text-ink-faint">No tracking details were added.</p>
                )}
              </div>
            </div>
          )}

          <dl className="mt-6 grid grid-cols-1 gap-3 rounded-2xl border border-line bg-surface p-5 text-sm sm:grid-cols-2">
            <Field label="Buyer" value={escrow.buyer} href={explorerAccount(escrow.buyer)} you={isBuyer} />
            <Field label="Seller" value={escrow.seller} href={explorerAccount(escrow.seller)} you={isSeller} />
            <Field label="Contract" value={STELLAR.escrowContractId} href={explorerContract(STELLAR.escrowContractId)} />
            <div>
              <dt className="text-xs text-ink-faint">Seller receives on release</dt>
              <dd className="font-semibold text-ink">{(amountXlm * (1 - STELLAR.feeBps / 10_000)).toLocaleString()} XLM</dd>
            </div>
          </dl>

          {/* Actions */}
          <section className="mt-6 flex flex-col gap-3">
            {isSeller && order && holding && !shipped && (
              <div className="flex flex-col gap-3 rounded-2xl border border-accent-line bg-accent-soft p-4">
                <p className="flex items-center gap-2 text-sm font-black text-ink"><Truck className="h-4 w-4 text-accent" /> Ready to ship</p>
                <p className="text-xs text-ink-muted">
                  The buyer&apos;s {amountXlm.toLocaleString()} XLM is locked. Send the item, then mark it shipped so they know it&apos;s coming. No wallet signature needed.
                </p>
                <textarea
                  value={shipNote}
                  onChange={(e) => setShipNote(e.target.value)}
                  maxLength={500}
                  rows={2}
                  placeholder="Optional: courier and tracking number, or how it's being delivered"
                  className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
                />
                <ActionButton onClick={() => serverAction("ship")} busy={busy === "ship"} busyText="Saving…" icon={<Truck className="h-4 w-4" />}>
                  Mark as shipped
                </ActionButton>
              </div>
            )}

            {isSeller && !order && order !== undefined && holding && (
              <p className="rounded-2xl border border-line bg-surface-2 p-4 text-xs text-ink-muted">
                This payment isn&apos;t linked to a Lumenbay order yet, so shipping can&apos;t be tracked here. It still pays out to you when the buyer confirms delivery.
              </p>
            )}

            {walletIsBuyer && user && order === null && escrow.status !== "Pending" && escrow.status !== "Cancelled" &&
              parseOrderTag(escrow.metadata)?.buyerUserId === user.id && (
              <ActionButton onClick={() => serverAction("save")} busy={busy === "save"} busyText="Checking on-chain…" icon={<ShieldCheck className="h-4 w-4" />}>
                Save this order to my account
              </ActionButton>
            )}

            {isBuyer && wallet.address && !walletIsBuyer && (escrow.status === "Pending" || escrow.status === "Funded") && (
              <p className="rounded-2xl border border-warn-line bg-warn-bg p-4 text-xs text-warn">
                You paid for this order from the wallet ending <strong className="font-mono">{escrow.buyer.slice(-6)}</strong>. Switch to that account in your wallet to release payment or open a dispute.
              </p>
            )}

            {!wallet.address && !isSeller && (escrow.status === "Pending" || escrow.status === "Funded") && (
              <button onClick={() => wallet.connect()} className="inline-flex items-center justify-center gap-2 rounded-xl border border-line bg-surface py-3 text-sm font-bold text-ink hover:border-accent">
                <Wallet className="h-4 w-4" /> Connect the buyer&apos;s wallet to take action
              </button>
            )}

            {walletIsBuyer && escrow.status === "Pending" && (
              <ActionButton onClick={() => run("fund")} busy={busy === "fund"} icon={<Lock className="h-4 w-4" />}>
                Finish payment: lock {amountXlm.toLocaleString()} XLM
              </ActionButton>
            )}

            {walletIsBuyer && escrow.status === "Funded" && !disputeOpen && (
              <>
                <ActionButton onClick={() => run("release")} busy={busy === "release"} icon={<PackageCheck className="h-4 w-4" />}>
                  I received it: release payment to seller
                </ActionButton>
                <button onClick={() => setDisputeOpen(true)} disabled={!!busy} className="inline-flex items-center justify-center gap-2 rounded-xl border border-bad-line py-3 text-sm font-bold text-bad hover:bg-bad-bg">
                  <Gavel className="h-4 w-4" /> There&apos;s a problem: open a dispute
                </button>
              </>
            )}

            {walletIsBuyer && escrow.status === "Funded" && disputeOpen && (
              <div className="flex flex-col gap-3 rounded-2xl border border-bad-line bg-bad-bg/40 p-4">
                <p className="text-sm font-bold text-ink">Open a dispute</p>
                <p className="text-xs text-ink-muted">Funds stay locked until it&apos;s resolved. Only a fingerprint of your note is stored on-chain, not the text.</p>
                <select value={reason} onChange={(e) => setReason(e.target.value as RefundReason)} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink">
                  {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="What went wrong?" className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink" />
                <div className="flex gap-2">
                  <ActionButton onClick={() => run("dispute")} busy={busy === "dispute"} disabled={note.trim().length < 5} icon={<Gavel className="h-4 w-4" />} tone="bad">
                    Submit dispute
                  </ActionButton>
                  <button onClick={() => setDisputeOpen(false)} disabled={!!busy} className="rounded-xl px-4 text-sm font-semibold text-ink-muted">Cancel</button>
                </div>
              </div>
            )}


            {actionError && <Alert>{actionError}</Alert>}
          </section>

          <Journal events={journal} />
        </>
      )}

      {escrow === undefined && !loadError && (
        <p className="mt-8 flex items-center gap-2 text-sm text-ink-muted"><Loader2 className="h-4 w-4 animate-spin" /> Reading escrow from the Stellar network…</p>
      )}
    </Shell>
  );
}

const ROLE_COPY: Record<"buyer" | "seller", Record<string, string>> = {
  buyer: {
    Pending: "Your payment isn't locked yet. Finish payment to start the escrow.",
    Funded: "Your money is locked in the contract. Release it once the item arrives, or open a dispute if something is wrong.",
    Shipped: "The seller has shipped your item. Once it arrives, release the payment. If something's wrong, open a dispute instead.",
    Released: "You confirmed delivery and the seller has been paid.",
    Disputed: "You opened a dispute. Your money stays locked until it's resolved.",
    Refunded: "The dispute was resolved and your money was refunded.",
    Cancelled: "This order was cancelled before payment.",
    RuledRefund: "We reviewed your dispute and refunded you in full.",
    RuledRelease: "We reviewed your dispute and released the payment to the seller.",
  },
  seller: {
    Pending: "The buyer hasn't locked their payment yet. Don't ship until it shows as funded.",
    Funded: "The buyer's payment is locked. Ship the item and mark it shipped; you're paid automatically when they confirm delivery.",
    Shipped: "You've marked this shipped. You're paid automatically when the buyer confirms delivery.",
    Released: "The buyer confirmed delivery and you've been paid.",
    Disputed: "The buyer opened a dispute. The payment stays locked until it's resolved.",
    Refunded: "The dispute was resolved in the buyer's favour.",
    Cancelled: "This order was cancelled before payment.",
    RuledRefund: "We reviewed the dispute and refunded the buyer.",
    RuledRelease: "We reviewed the dispute and released the payment to you.",
  },
};

/**
 * What happened after a dispute: who the admin ruled for, and where the money
 * is. The contract holds it through a 24-hour appeal window; after that
 * anyone can trigger the payout, so either party can do it from here.
 */
function DisputeOutcome({ order, escrowId, amountXlm, wallet, onPaid }: { order: OrderSummary; escrowId: bigint; amountXlm: number; wallet: string | null; onPaid: () => void }) {
  const [chain, setChain] = useState<{ claimableAt: number | null; ledger: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([readClaimableAt(escrowId), readLatestLedger()])
      .then(([claimableAt, ledger]) => !cancelled && setChain({ claimableAt, ledger }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [escrowId, order.paidOutAt]);

  const refund = order.resolution === "refund";
  const recipient = refund ? "buyer" : "seller";
  const mine = order.role === recipient;
  const state = chain ? payoutState({ resolved: true, claimableAt: chain.claimableAt, currentLedger: chain.ledger }) : null;

  const payOut = async () => {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    try {
      const { hash } = await claimDisputedFunds(wallet, escrowId);
      await recordPayout(escrowId.toString(), hash).catch(() => {});
      onPaid();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-ok-line bg-ok-bg/40 p-4">
      <p className="flex items-center gap-2 text-sm font-black text-ink">
        <Gavel className="h-4 w-4 text-ok" />
        Dispute resolved: {refund ? `${amountXlm.toLocaleString()} XLM refunded to the buyer` : "payment released to the seller"}
      </p>
      <p className="text-xs text-ink-muted">
        {order.resolvedAt && <>Decided {new Date(order.resolvedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}. </>}
        {mine ? (refund ? "The money comes back to your wallet." : "The money goes to your payout wallet.") : refund ? "The buyer gets their money back." : "The seller receives the payment."}
      </p>
      {order.resolveTxHash && (
        <a href={explorerTx(order.resolveTxHash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 self-start font-mono text-xs text-accent">
          Ruling {order.resolveTxHash.slice(0, 10)}… <ExternalLink className="h-3 w-3" />
        </a>
      )}
      {state?.kind === "paid" || order.paidOutAt ? (
        <p className="flex items-center gap-2 text-xs font-semibold text-ok">
          <CheckCircle2 className="h-3.5 w-3.5" /> Paid out
          {order.payoutTxHash && (
            <a href={explorerTx(order.payoutTxHash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-accent">
              {order.payoutTxHash.slice(0, 10)}… <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </p>
      ) : state?.kind === "waiting" ? (
        <p className="text-xs text-ink-muted">There&apos;s a 24-hour appeal window before the money moves. It can be paid out in {countdownLabel(state.secondsLeft)}.</p>
      ) : state?.kind === "claimable" ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-ink">The appeal window has passed. {mine ? "Collect your XLM now." : "Anyone can trigger the payout now."}</p>
          {wallet ? (
            <button onClick={payOut} disabled={busy} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-on-accent disabled:opacity-60">
              {busy ? "Approve in your wallet…" : mine ? "Collect my XLM" : "Trigger payout"}
            </button>
          ) : (
            <span className="text-xs text-ink-faint">Connect a wallet to send the payout.</span>
          )}
        </div>
      ) : null}
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}

/** Says plainly which side of this escrow the connected wallet is on. */
function RoleBanner({ role, status, counterparty }: { role: "buyer" | "seller" | "outsider" | "unknown"; status: string; counterparty?: string }) {
  if (role === "buyer" || role === "seller") {
    const Icon = role === "buyer" ? ShoppingBag : Store;
    return (
      <div className="mt-5 flex items-start gap-3 rounded-2xl border border-accent-line bg-accent-soft p-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-on-accent">
          <Icon className="h-4 w-4" />
        </span>
        <div>
          <p className="text-sm font-black text-ink">
            You&apos;re the {role} in this order
            {counterparty && <span className="font-semibold text-ink-muted"> · {role === "buyer" ? "sold by" : "bought by"} {counterparty}</span>}
          </p>
          <p className="text-xs text-ink-muted">{ROLE_COPY[role][status] ?? ""}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-5 rounded-2xl border border-line bg-surface-2 p-4 text-xs text-ink-muted">
      {role === "outsider"
        ? "The connected wallet isn't the buyer or the seller in this order, so you can view it but not act on it. Switch wallet accounts if this is your order."
        : "Connect your wallet to see whether you're the buyer or the seller in this order."}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg">
      <main className="mx-auto max-w-2xl px-4 pb-16 pt-24">{children}</main>
    </div>
  );
}

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="mt-4 flex gap-2 rounded-xl border border-bad-line bg-bad-bg p-3 text-sm text-bad">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function Track({ status, shipped }: { status: string; shipped: boolean }) {
  // Disputed / refunded / cancelled sit off the happy path, so nothing lights up.
  const index =
    status === "Pending" ? 0 : status === "Funded" ? (shipped ? 2 : 1) : status === "Released" ? 3 : -1;
  return (
    <ol className="mt-6 grid grid-cols-4 gap-2">
      {TRACK.map((s, i) => {
        const reached = index !== -1 && i <= index;
        return (
          <li key={s} className="flex flex-col gap-2">
            <span className={`h-1.5 rounded-full ${reached ? "bg-accent" : "bg-surface-3"}`} />
            <span className={`text-xs font-semibold ${reached ? "text-ink" : "text-ink-faint"}`}>{s}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Field({ label, value, href, you }: { label: string; value: string; href: string; you?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-ink-faint">{label}{you && <span className="ml-1 rounded bg-accent-soft px-1 text-[10px] font-bold text-accent">you</span>}</dt>
      <dd>
        <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-ink hover:text-accent">
          {formatAddress(value)} <ExternalLink className="h-3 w-3" />
        </a>
      </dd>
    </div>
  );
}

function ActionButton({
  onClick,
  busy,
  disabled,
  icon,
  tone = "accent",
  busyText = "Approve in your wallet…",
  children,
}: {
  onClick: () => void;
  busy: boolean;
  disabled?: boolean;
  icon: React.ReactNode;
  tone?: "accent" | "bad";
  busyText?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      className={`flex flex-1 items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-60 ${
        tone === "bad" ? "bg-bad" : "bg-linear-to-r from-[#E0483B] to-[#FF7A59] shadow-lg shadow-red-500/25"
      }`}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {busy ? busyText : children}
    </button>
  );
}

const STEP_LABEL: Record<PaymentEvent["step"], string> = {
  checkout_started: "Checkout started",
  escrow_created: "Escrow created",
  escrow_funded: "Funds locked",
  order_shipped: "Item shipped",
  escrow_released: "Released to seller",
  dispute_opened: "Dispute opened",
  step_failed: "Step failed",
};

function Journal({ events }: { events: PaymentEvent[] }) {
  return (
    <section className="mt-8">
      <h2 className="flex items-center gap-2 text-sm font-black text-ink">
        <ShieldCheck className="h-4 w-4 text-accent" /> Payment activity
      </h2>
      {events.length === 0 ? (
        <p className="mt-2 text-xs text-ink-faint">No activity recorded in this browser yet. The on-chain status above is always authoritative.</p>
      ) : (
        <ol className="mt-3 flex flex-col gap-2">
          {[...events].reverse().map((e) => (
            <li key={e.id} className="flex items-start gap-3 rounded-xl border border-line bg-surface p-3 text-xs">
              {e.step === "step_failed" ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-bad" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" />}
              <div className="min-w-0 flex-1">
                <p className="font-bold text-ink">
                  {STEP_LABEL[e.step]}
                  {e.failedAction && ` (${e.failedAction})`}
                </p>
                <p className="text-ink-faint">{new Date(e.at).toLocaleString()}</p>
                {e.errorMessage && (
                  <p className="mt-1 text-bad">
                    {e.errorMessage}
                    {e.errorCode !== undefined && ` · contract error #${e.errorCode}`}
                  </p>
                )}
                {e.txHash && (
                  <a href={explorerTx(e.txHash)} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 font-mono text-accent">
                    {e.txHash.slice(0, 12)}…{e.txHash.slice(-6)} <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
