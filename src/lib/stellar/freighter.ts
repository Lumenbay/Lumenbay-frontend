import {
  getAddress,
  getNetworkDetails,
  isConnected,
  requestAccess,
  signTransaction,
} from "@stellar/freighter-api";
import { STELLAR } from "./config";

declare global {
  interface Window {
    freighter?: boolean;
  }
}

export class WalletError extends Error {}

/** Checks whether the Freighter browser extension injected itself into the window. */
function hasFreighterExtension(): boolean {
  return typeof window !== "undefined" && Boolean(window.freighter);
}

/** True when the Freighter extension is installed in this browser. */
export async function isFreighterInstalled(): Promise<boolean> {
  if (!hasFreighterExtension()) return false;
  try {
    const res = await isConnected();
    return Boolean(res.isConnected);
  } catch {
    return false;
  }
}

/** Address of an account this site already has permission for, without prompting. */
export async function getConnectedAddress(): Promise<string | null> {
  if (!hasFreighterExtension()) return null;
  try {
    const res = await getAddress();
    return res.error || !res.address ? null : res.address;
  } catch {
    return null;
  }
}

/** Opens Freighter's permission prompt and returns the approved address. */
export async function connectFreighter(): Promise<string> {
  if (!(await isFreighterInstalled())) {
    throw new WalletError("Freighter isn't installed. Add it from freighter.app, then try again.");
  }
  const res = await requestAccess();
  if (res.error || !res.address) {
    throw new WalletError(res.error?.message ?? "Freighter didn't share an address.");
  }
  return res.address;
}

/** Whether Freighter is pointed at the network this app uses. */
export async function isOnExpectedNetwork(): Promise<boolean> {
  if (!hasFreighterExtension()) return false;
  try {
    const res = await getNetworkDetails();
    return !res.error && res.networkPassphrase === STELLAR.networkPassphrase;
  } catch {
    return false;
  }
}

/** Signs a transaction XDR with Freighter, in the shape the Stellar SDK expects. */
export async function signWithFreighter(
  xdr: string,
  opts?: { networkPassphrase?: string; address?: string },
) {
  const res = await signTransaction(xdr, {
    networkPassphrase: opts?.networkPassphrase ?? STELLAR.networkPassphrase,
    address: opts?.address,
  });
  if (res.error) {
    throw new WalletError(
      /reject|declin|denied/i.test(res.error.message ?? "")
        ? "You declined the request in Freighter."
        : res.error.message ?? "Freighter couldn't sign the transaction.",
    );
  }
  return { signedTxXdr: res.signedTxXdr, signerAddress: res.signerAddress };
}
