"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, PackagePlus, RefreshCw, Store, Wallet } from "lucide-react";
import DashboardSubnav from "@/components/dashboard/DashboardSubnav";
import {
  ActionCard,
  HubHero,
  ListSkeleton,
  OrderRow,
  Panel,
  SectionLabel,
  daysAgo,
  useOrders,
  xlm,
} from "@/components/orders/OrderParts";
import SellerListings from "@/components/selling/SellerListings";
import EarningsChart from "@/components/selling/EarningsChart";
import { useAuth } from "@/context/AuthContext";
import { useWallet } from "@/context/WalletContext";
import { getPayoutAddress } from "@/lib/listings";
import { createClient } from "@/lib/supabase/client";
import { STELLAR } from "@/lib/stellar/config";
import { cn } from "@/lib/utils";

type Filter = "all" | "ship" | "shipped" | "paid";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "ship", label: "To ship" },
  { key: "shipped", label: "Shipped" },
  { key: "paid", label: "Paid out" },
];

const afterFee = (xlmAmount: number) => xlmAmount * (1 - STELLAR.feeBps / 10_000);

export default function SellerHub() {
  const { orders, error, reload, loading } = useOrders("selling");
  const { user } = useAuth();
  const wallet = useWallet();
  const [filter, setFilter] = useState<Filter>("all");
  // Undefined while loading, so the "set a payout wallet" warning doesn't flash.
  const [payout, setPayout] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    getPayoutAddress(createClient(), user.id)
      .then((a) => !cancelled && setPayout(a))
      .catch(() => !cancelled && setPayout(undefined));
    return () => {
      cancelled = true;
    };
  }, [user, wallet.payoutAddress]);

  const list = useMemo(() => orders ?? [], [orders]);
  const toShip = list.filter((o) => o.state === "funded" || o.state === "in_escrow");
  const disputes = list.filter((o) => o.state === "disputed");
  const shipped = list.filter((o) => o.state === "in_transit");
  const paid = list.filter((o) => o.state === "released");
  const earned = paid.reduce((sum, o) => sum + afterFee(o.totalXlm), 0);
  const pending = [...toShip, ...shipped, ...disputes].reduce((sum, o) => sum + afterFee(o.totalXlm), 0);

  const shown = filter === "ship" ? toShip : filter === "shipped" ? shipped : filter === "paid" ? paid : list;
  const needsYou = [...disputes, ...toShip];

  return (
    <div className="min-h-screen bg-bg">
      <div className="pt-14">
        <DashboardSubnav />

        <div className="mx-auto max-w-5xl px-4 py-6 sm:py-8">
          <HubHero
            eyebrow="Selling"
            title="Seller hub"
            figureLabel="Earned on Lumenbay"
            figure={loading ? "…" : xlm(earned)}
            stats={[
              { label: "To ship", value: loading ? "–" : String(toShip.length) },
              { label: "Coming to you", value: loading ? "–" : pending.toLocaleString(undefined, { maximumFractionDigits: 0 }) },
              { label: "Sales", value: loading ? "–" : String(list.length) },
            ]}
          >
            <div className="mt-5 flex flex-wrap gap-2">
              <Link
                href="/dashboard/selling/new"
                className="inline-flex items-center gap-2 rounded-full bg-linear-to-r from-[#E0483B] to-[#FF7A59] px-4 py-2 text-xs font-bold text-white shadow-lg shadow-red-500/30 hover:brightness-110"
              >
                <PackagePlus className="h-4 w-4" aria-hidden /> List an item
              </Link>
              <Link href="#listings" className="inline-flex items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-xs font-bold text-white/90 hover:bg-white/10">
                <Store className="h-4 w-4" aria-hidden /> Your listings
              </Link>
            </div>
          </HubHero>

          {payout === null && (
            <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-warn-line bg-warn-bg p-4 text-sm text-warn sm:flex-row sm:items-center sm:justify-between">
              <p className="flex items-start gap-2">
                <Wallet className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span><strong>Set a payout wallet.</strong> Buyers can&apos;t pay you with escrow until you do.</span>
              </p>
              <Link href="/dashboard/wallet" className="inline-flex shrink-0 items-center gap-1 self-start rounded-full bg-warn px-3 py-1.5 text-xs font-bold text-white">
                Set it up <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </div>
          )}

          {error && (
            <div role="alert" className="mt-6 flex items-center justify-between gap-3 rounded-xl border border-bad-line bg-bad-bg p-3 text-sm text-bad">
              <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {error}</span>
              <button onClick={() => reload()} className="inline-flex items-center gap-1 text-xs font-bold"><RefreshCw className="h-3.5 w-3.5" /> Retry</button>
            </div>
          )}

          <SectionLabel>Earnings</SectionLabel>
          <EarningsChart orders={list} loading={loading} />

          {needsYou.length > 0 && (
            <>
              <SectionLabel>Needs you · {needsYou.length}</SectionLabel>
              <div className="lb-rail lb-fade-x -mx-4 flex gap-3 overflow-x-auto px-4 pb-2">
                {needsYou.map((o) => (
                  <ActionCard
                    key={o.orderId}
                    order={o}
                    cta={o.state === "disputed" ? "Review" : "Ship it"}
                    hint={o.state === "disputed" ? `Buyer: ${o.counterparty}` : `Paid ${daysAgo(o.createdAt)} · ${o.counterparty}`}
                  />
                ))}
              </div>
            </>
          )}

          <SectionLabel>Sales</SectionLabel>
          <Panel
            title="Orders from buyers"
            count={orders ? list.length : undefined}
            action={
              <div className="lb-rail flex gap-1 overflow-x-auto">
                {FILTERS.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setFilter(f.key)}
                    className={cn(
                      "whitespace-nowrap rounded-full px-3 py-1 text-[11px] font-bold transition-colors",
                      filter === f.key ? "bg-ink text-bg" : "text-ink-muted hover:bg-surface-2",
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            }
          >
            {loading ? (
              <ListSkeleton />
            ) : shown.length === 0 ? (
              <p className="px-5 py-12 text-center text-sm text-ink-muted">
                {list.length === 0 ? "No sales yet. When someone buys one of your listings, it lands here." : "Nothing here with this filter."}
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {shown.map((o) => <OrderRow key={o.orderId} order={o} />)}
              </ul>
            )}
          </Panel>

          <div id="listings" className="scroll-mt-20">
            <SectionLabel>Your listings</SectionLabel>
            <SellerListings />
          </div>
        </div>
      </div>
    </div>
  );
}
