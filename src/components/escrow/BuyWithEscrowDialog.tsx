"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, Lock, ShieldCheck, Wallet, X } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useWallet } from "@/context/WalletContext";
import { createClient } from "@/lib/supabase/client";
import { getSellerProfile } from "@/lib/listings";
import { buildOrderTag } from "@/lib/orderTag";
import { recordOrder } from "@/lib/orders/client";
import type { Product } from "@/lib/products";
import { STELLAR, explorerTx, isTestnet } from "@/lib/stellar/config";
import { EscrowError, createEscrow, fundEscrow } from "@/lib/stellar/escrow";
import { recordPaymentEvent } from "@/lib/stellar/paymentJournal";
import { formatAddress } from "@/lib/utils";

/** Stellar accounts must keep a small reserve; leave headroom for it and fees. */
const RESERVE_HEADROOM_XLM = 2;

type StepState = "idle" | "signing" | "done" | "error";

export default function BuyWithEscrowDialog({ product, onClose }: { product: Product; onClose: () => void }) {
  const wallet = useWallet();
  const { user } = useAuth();
  const [sellerAddress, setSellerAddress] = useState<string | null | undefined>(undefined);
  const [createState, setCreateState] = useState<StepState>("idle");
  const [fundState, setFundState] = useState<StepState>("idle");
  const [saveState, setSaveState] = useState<StepState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [escrowId, setEscrowId] = useState<bigint | null>(null);
  const [hashes, setHashes] = useState<{ create?: string; fund?: string }>({});
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const price = product.xlmPrice;
  const fee = (price * STELLAR.feeBps) / 10_000;
  const busy = createState === "signing" || fundState === "signing";
  const done = fundState === "done";

  // Remember the trigger element that opened the dialog and restore focus on close.
  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    return () => {
      previouslyFocusedRef.current?.focus();
    };
  }, []);

  // Trap keyboard focus within the dialog while it is open.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;

    const getFocusables = () =>
      Array.from(
        el.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );

    const initial = getFocusables();
    if (initial.length > 0) {
      initial[0].focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusables = getFocusables();
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first || !el.contains(document.activeElement)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last || !el.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    getSellerProfile(createClient(), product.sellerId)
      .then((p) => setSellerAddress(p?.stellarAddress ?? null))
      .catch(() => setSellerAddress(null));
  }, [product.sellerId]);

  // Escape closes, except while Freighter is mid-signature.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const blocker = (() => {
    if (!user) return "signed-out";
    if (!wallet.installed) return "install";
    if (!wallet.address) return "connect";
    if (!wallet.networkOk) return "network";
    if (sellerAddress === undefined) return "loading";
    if (!sellerAddress) return "no-seller-wallet";
    if (sellerAddress === wallet.address) return "own-listing";
    if (wallet.unfunded || (wallet.balance !== null && wallet.balance < price + RESERVE_HEADROOM_XLM)) return "balance";
    return null;
  })();

  const journalBase = () => ({
    productId: product.id,
    buyer: wallet.address ?? undefined,
    seller: sellerAddress ?? undefined,
    amountXlm: price,
    network: STELLAR.network,
    contractId: STELLAR.escrowContractId,
  });

  const fail = (action: "create" | "fund", e: unknown, id?: bigint) => {
    const err = e instanceof EscrowError ? e : new EscrowError(String(e));
    recordPaymentEvent({ ...journalBase(), step: "step_failed", failedAction: action, escrowId: id?.toString(), errorCode: err.code, errorMessage: err.message });
    setError(err.message);
  };

  /** Tells the server, which checks the chain and saves the order for buyer and seller. */
  const saveOrder = async (id: bigint, createTxHash?: string, fundTxHash?: string) => {
    setSaveState("signing");
    setSaveError(null);
    try {
      await recordOrder(id, { createTxHash, fundTxHash });
      setSaveState("done");
    } catch (e) {
      setSaveState("error");
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  const lockFunds = async (id: bigint, createTxHash?: string) => {
    setFundState("signing");
    try {
      const { hash } = await fundEscrow(wallet.address!, id);
      setHashes((h) => ({ ...h, fund: hash }));
      recordPaymentEvent({ ...journalBase(), step: "escrow_funded", escrowId: id.toString(), txHash: hash });
      setFundState("done");
      void wallet.refresh();
      await saveOrder(id, createTxHash ?? hashes.create, hash);
    } catch (e) {
      setFundState("error");
      fail("fund", e, id);
    }
  };

  const pay = async () => {
    setError(null);
    if (escrowId !== null) return lockFunds(escrowId); // create already succeeded; only retry funding
    recordPaymentEvent({ ...journalBase(), step: "checkout_started" });
    setCreateState("signing");
    try {
      const { escrowId: id, hash } = await createEscrow({
        buyer: wallet.address!,
        seller: sellerAddress!,
        amountXlm: price,
        tag: buildOrderTag(product.id, user!.id),
      });
      setEscrowId(id);
      setHashes({ create: hash });
      recordPaymentEvent({ ...journalBase(), step: "escrow_created", escrowId: id.toString(), txHash: hash });
      setCreateState("done");
      await lockFunds(id, hash);
    } catch (e) {
      setCreateState("error");
      fail("create", e);
    }
  };

  const liveAnnouncement = (() => {
    if (error) return `Error: ${error}`;
    if (saveState === "error" && saveError) return `Order save error: ${saveError}`;
    if (saveState === "signing") return "Checking payment on-chain and saving order…";
    if (saveState === "done") return "Order placed successfully. View order.";
    if (fundState === "signing") return "Locking payment into escrow… approve in your wallet.";
    if (fundState === "done") return "Payment locked into escrow.";
    if (createState === "signing") return "Creating escrow on-chain… approve in your wallet.";
    if (createState === "done") return "Escrow created.";
    return "";
  })();

  return (
    <div ref={dialogRef} className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="buy-title">
      <div className="w-full max-w-md overflow-hidden rounded-t-3xl border border-line bg-surface shadow-2xl sm:rounded-3xl">
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {liveAnnouncement}
        </div>
        <div className="relative overflow-hidden bg-[linear-gradient(135deg,#1A0907_0%,#8C2A20_55%,#FF7A59_100%)] px-6 pb-5 pt-6 text-white">
          <button onClick={onClose} disabled={busy} className="absolute right-4 top-4 rounded-full p-1.5 text-white/80 hover:bg-white/10 disabled:opacity-40" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
          <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-orange-100/80">
            <ShieldCheck className="h-3.5 w-3.5" /> Escrow checkout {isTestnet && "· Testnet"}
          </p>
          <h2 id="buy-title" className="font-display mt-2 text-xl font-extrabold leading-tight">{product.name}</h2>
          <p className="mt-3 text-3xl font-black tabular-nums">{price.toLocaleString()} XLM</p>
          <p className="text-xs text-orange-100/75">≈ ${product.usdPrice.toLocaleString()} · You pay exactly this amount</p>
        </div>

        <div className="flex flex-col gap-4 p-6">
          {!done && blocker && blocker !== "loading" && <Blocker kind={blocker} />}
          {blocker === "loading" && (
            <p className="flex items-center gap-2 text-sm text-ink-muted"><Loader2 className="h-4 w-4 animate-spin" /> Checking the seller&apos;s payout wallet…</p>
          )}

          {!blocker && (
            <>
              <dl className="grid grid-cols-2 gap-y-1.5 rounded-2xl bg-surface-2 p-4 text-xs">
                <dt className="text-ink-faint">From your wallet</dt>
                <dd className="text-right font-mono text-ink">{formatAddress(wallet.address!)}</dd>
                <dt className="text-ink-faint">Seller receives</dt>
                <dd className="text-right font-semibold text-ink">{(price - fee).toLocaleString()} XLM</dd>
                <dt className="text-ink-faint">Platform fee ({STELLAR.feeBps / 100}%)</dt>
                <dd className="text-right text-ink-muted">{fee.toLocaleString()} XLM, paid by seller</dd>
                <dt className="text-ink-faint">Network fees</dt>
                <dd className="text-right text-ink-muted">Under 0.01 XLM</dd>
              </dl>

              <ol className="flex flex-col gap-2" aria-label="Escrow checkout steps">
                <Step n={1} title="Create the escrow" body="Records the deal on-chain. No money moves yet." state={createState} hash={hashes.create} />
                <Step n={2} title="Lock your payment" body="Moves the XLM into the contract until you confirm delivery." state={fundState} hash={hashes.fund} />
                <Step
                  n={3}
                  title="Save your order"
                  body="Lumenbay checks the payment on-chain and tells the seller. No signature needed."
                  busyText="Checking the payment on-chain…"
                  state={saveState}
                />
              </ol>

              {saveState === "error" && escrowId !== null && (
                <div role="alert" className="flex flex-col gap-2 rounded-xl border border-warn-line bg-warn-bg p-3 text-xs text-warn">
                  <p className="flex gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>Your payment is locked and safe, but we couldn&apos;t save the order yet: {saveError}</span>
                  </p>
                  <button onClick={() => saveOrder(escrowId, hashes.create, hashes.fund)} className="self-start rounded-lg bg-warn px-3 py-1.5 font-bold text-white">
                    Try saving again
                  </button>
                </div>
              )}
            </>
          )}

          {error && (
            <div role="alert" className="flex gap-2 rounded-xl border border-bad-line bg-bad-bg p-3 text-xs text-bad">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {done ? (
            <Link
              href={`/dashboard/escrow/${escrowId}`}
              className="flex items-center justify-center gap-2 rounded-xl bg-accent py-3.5 text-sm font-bold text-on-accent hover:bg-accent-hover"
            >
              {saveState === "signing" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {saveState === "done" ? "Order placed · View order" : "Payment locked · View order"}
            </Link>
          ) : (
            !blocker && (
              <button
                onClick={pay}
                disabled={busy}
                className="flex items-center justify-center gap-2 rounded-xl bg-linear-to-r from-[#E0483B] to-[#FF7A59] py-3.5 text-sm font-bold text-white shadow-lg shadow-red-500/25 transition hover:brightness-110 disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
                {busy ? "Approve in your wallet…" : escrowId !== null ? "Retry locking payment" : `Pay ${price.toLocaleString()} XLM into escrow`}
              </button>
            )
          )}

          <p className="text-center text-[11px] leading-relaxed text-ink-faint">
            Your wallet asks you to approve each step. Lumenbay never holds your funds or your keys.
          </p>
        </div>
      </div>
    </div>
  );

  function Blocker({ kind }: { kind: Exclude<typeof blocker, null> }) {
    const box = "flex flex-col gap-3 rounded-2xl border border-line bg-surface-2 p-4 text-sm text-ink-muted";
    const btn = "inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-bold text-on-accent hover:bg-accent-hover disabled:opacity-60";
    switch (kind) {
      case "signed-out":
        return (
          <div className={box}>
            <p>Sign in to buy, so the order is saved to your account and the seller can see it.</p>
            <Link href="/auth/login" className={btn}>Sign in</Link>
          </div>
        );
      case "install":
        return (
          <div className={box}>
            <p>You need the <strong className="text-ink">Freighter</strong> wallet extension to pay with escrow.</p>
            <a href="https://www.freighter.app/" target="_blank" rel="noreferrer" className={btn}>Get Freighter <ExternalLink className="h-3.5 w-3.5" /></a>
            <button onClick={() => wallet.refresh()} className="text-xs font-semibold text-accent">I&apos;ve installed it</button>
            <GuideLink anchor="install-freighter">New to Freighter? Follow the setup guide</GuideLink>
          </div>
        );
      case "connect":
        return (
          <div className={box}>
            <p>Connect your Stellar wallet to continue.</p>
            <button onClick={() => wallet.connect()} disabled={wallet.connecting} className={btn}>
              {wallet.connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />} Connect wallet
            </button>
            {wallet.error && <p className="text-xs text-bad">{wallet.error}</p>}
          </div>
        );
      case "network":
        return (
          <div className={box}>
            <p>Your wallet is on the wrong network. Open it and switch the network to <strong className="text-ink">{isTestnet ? "Testnet" : "Mainnet"}</strong>, then check again.</p>
            <button onClick={() => wallet.refresh()} className={btn}>I&apos;ve switched</button>
            <GuideLink anchor="switch-testnet">How to switch networks</GuideLink>
          </div>
        );
      case "no-seller-wallet":
        return <div className={box}>This seller hasn&apos;t connected a payout wallet yet, so escrow payments can&apos;t be sent to them. Check back soon.</div>;
      case "own-listing":
        return <div className={box}>This is your own listing. Switch to a different wallet account to test buying it.</div>;
      case "balance":
        return (
          <div className={box}>
            <p>
              You need about <strong className="text-ink">{(price + RESERVE_HEADROOM_XLM).toLocaleString()} XLM</strong> (the price plus Stellar&apos;s account reserve). Your balance:{" "}
              <strong className="text-ink">{(wallet.balance ?? 0).toLocaleString()} XLM</strong>.
            </p>
            {isTestnet && (
              <button onClick={() => wallet.fundWithFriendbot()} className={btn}>Get 10,000 free test XLM</button>
            )}
            <GuideLink anchor="fees">Why you need a little extra</GuideLink>
          </div>
        );
      default:
        return null;
    }
  }
}

function Step({ n, title, body, state, hash, busyText = "Approve in your wallet…" }: { n: number; title: string; body: string; state: StepState; hash?: string; busyText?: string }) {
  const statusLabel =
    state === "done" ? "completed" : state === "signing" ? "in progress" : state === "error" ? "failed" : "pending";

  return (
    <li
      aria-current={state === "signing" ? "step" : undefined}
      aria-label={`Step ${n}: ${title} (${statusLabel})`}
      className={`flex items-start gap-3 rounded-xl border p-3 ${state === "done" ? "border-ok-line bg-ok-bg" : state === "error" ? "border-bad-line" : "border-line"}`}
    >
      <span aria-hidden="true" className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-black text-ink">
        {state === "signing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : state === "done" ? <CheckCircle2 className="h-4 w-4 text-ok" /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-ink">{title}</p>
        <p className="text-xs text-ink-muted">{state === "signing" ? busyText : body}</p>
        {hash && (
          <a
            href={explorerTx(hash)}
            target="_blank"
            rel="noreferrer"
            aria-label={`View transaction ${hash.slice(0, 10)} on explorer`}
            className="mt-1 inline-flex items-center gap-1 font-mono text-[11px] text-accent"
          >
            {hash.slice(0, 10)}…{hash.slice(-6)} <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        )}
      </div>
    </li>
  );
}

/** Opens the testnet guide in a new tab, so the checkout stays where it is. */
function GuideLink({ anchor, children }: { anchor: string; children: React.ReactNode }) {
  return (
    <Link
      href={`/help/testnet#${anchor}`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center justify-center gap-1 text-xs font-semibold text-ink-muted underline decoration-line-strong underline-offset-2 hover:text-accent"
    >
      {children} <ExternalLink className="h-3 w-3" aria-hidden />
    </Link>
  );
}
