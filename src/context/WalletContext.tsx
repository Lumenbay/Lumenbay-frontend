"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "@/context/AuthContext";
import { createClient } from "@/lib/supabase/client";
import { getPayoutAddress, setPayoutAddress } from "@/lib/listings";
import { STELLAR, isTestnet } from "@/lib/stellar/config";
import {
  connectFreighter,
  getConnectedAddress,
  isFreighterInstalled,
  isOnExpectedNetwork,
} from "@/lib/stellar/freighter";

/**
 * Wallet state for the signed-in Lumenbay user.
 *
 * Freighter's permission is per browser, not per Lumenbay account, so the
 * connection is scoped to the user here: it resets whenever the user changes,
 * reconnects silently only when Freighter is on that user's saved payout
 * wallet, and never changes the payout wallet without an explicit call to
 * `savePayoutAddress`.
 */
interface WalletState {
  address: string | null;
  /** The user's saved payout wallet (profiles.stellar_address), or null if none. */
  payoutAddress: string | null;
  /** Connected wallet differs from the saved payout wallet. */
  payoutMismatch: boolean;
  installed: boolean;
  networkOk: boolean;
  /** XLM balance, or null while unknown. 0 with `unfunded` for brand-new accounts. */
  balance: number | null;
  unfunded: boolean;
  connecting: boolean;
  savingPayout: boolean;
  error: string | null;
  connect: () => Promise<string | null>;
  disconnect: () => void;
  refresh: () => Promise<void>;
  fundWithFriendbot: () => Promise<void>;
  /** Makes the connected wallet this user's payout wallet. */
  savePayoutAddress: () => Promise<boolean>;
}

const WalletContext = createContext<WalletState | undefined>(undefined);

/** Last wallet each Lumenbay user connected, so a reload reconnects only their own wallet. */
const rememberedKey = (userId: string) => `lumenbay-wallet:${userId}`;

function remembered(userId: string): string | null {
  try {
    return localStorage.getItem(rememberedKey(userId));
  } catch {
    return null;
  }
}

function remember(userId: string, address: string | null) {
  try {
    if (address) localStorage.setItem(rememberedKey(userId), address);
    else localStorage.removeItem(rememberedKey(userId));
  } catch {}
}

async function fetchXlmBalance(address: string): Promise<{ balance: number; unfunded: boolean }> {
  const res = await fetch(`${STELLAR.horizonUrl}/accounts/${address}`);
  if (res.status === 404) return { balance: 0, unfunded: true };
  if (!res.ok) throw new Error("Couldn't load your balance.");
  const data = (await res.json()) as { balances: { asset_type: string; balance: string }[] };
  const native = data.balances.find((b) => b.asset_type === "native");
  return { balance: native ? Number(native.balance) : 0, unfunded: false };
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [address, setAddress] = useState<string | null>(null);
  const [payoutAddress, setPayoutAddressState] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);
  const [networkOk, setNetworkOk] = useState(true);
  const [balance, setBalance] = useState<number | null>(null);
  const [unfunded, setUnfunded] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [savingPayout, setSavingPayout] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each Lumenbay user starts from a clean slate; reconnect only to their own saved wallet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const isInstalled = await isFreighterInstalled();
      const onNetwork = isInstalled ? await isOnExpectedNetwork() : true;
      const saved = userId ? await getPayoutAddress(createClient(), userId).catch(() => null) : null;
      const known = userId ? [saved, remembered(userId)].filter((a): a is string => !!a) : [];
      const freighterAddress = isInstalled && known.length ? await getConnectedAddress() : null;
      if (cancelled) return;
      setInstalled(isInstalled);
      setNetworkOk(onNetwork);
      setPayoutAddressState(saved);
      setAddress(freighterAddress && known.includes(freighterAddress) ? freighterAddress : null);
      setBalance(null);
      setUnfunded(false);
      setError(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const refresh = useCallback(async () => {
    const isInstalled = await isFreighterInstalled();
    const onNetwork = isInstalled ? await isOnExpectedNetwork() : true;
    setInstalled(isInstalled);
    setNetworkOk(onNetwork);
    if (!address) return;
    try {
      const result = await fetchXlmBalance(address);
      setBalance(result.balance);
      setUnfunded(result.unfunded);
    } catch {
      setBalance(null);
    }
  }, [address]);

  useEffect(() => {
    if (address) void refresh();
  }, [address, refresh]);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const approved = await connectFreighter();
      if (userId) remember(userId, approved);
      setAddress(approved);
      setNetworkOk(await isOnExpectedNetwork());
      return approved;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't connect to Freighter.");
      return null;
    } finally {
      setConnecting(false);
    }
  }, [userId]);

  const disconnect = useCallback(() => {
    if (userId) remember(userId, null);
    setAddress(null);
    setBalance(null);
    setUnfunded(false);
    setError(null);
  }, [userId]);

  const savePayoutAddress = useCallback(async () => {
    if (!userId || !address) return false;
    setSavingPayout(true);
    setError(null);
    try {
      await setPayoutAddress(createClient(), userId, address);
      setPayoutAddressState(address);
      return true;
    } catch (e) {
      const duplicate = /duplicate|unique/i.test(e instanceof Error ? e.message : String(e));
      setError(
        duplicate
          ? "This wallet is already the payout wallet of another Lumenbay account. Use a different wallet account for each Lumenbay login."
          : "Couldn't save your payout wallet. Please try again.",
      );
      return false;
    } finally {
      setSavingPayout(false);
    }
  }, [userId, address]);

  const fundWithFriendbot = useCallback(async () => {
    if (!address || !isTestnet) return;
    setError(null);
    const res = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(address)}`);
    if (!res.ok && res.status !== 400) {
      setError("Friendbot couldn't fund this account. Try again in a minute.");
    }
    await refresh();
  }, [address, refresh]);

  const payoutMismatch = !!address && !!payoutAddress && address !== payoutAddress;

  const value = useMemo<WalletState>(
    () => ({
      address,
      payoutAddress,
      payoutMismatch,
      installed,
      networkOk,
      balance,
      unfunded,
      connecting,
      savingPayout,
      error,
      connect,
      disconnect,
      refresh,
      fundWithFriendbot,
      savePayoutAddress,
    }),
    [address, payoutAddress, payoutMismatch, installed, networkOk, balance, unfunded, connecting, savingPayout, error, connect, disconnect, refresh, fundWithFriendbot, savePayoutAddress],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside WalletProvider");
  return ctx;
}
