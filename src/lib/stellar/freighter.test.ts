import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connectFreighter,
  getConnectedAddress,
  isFreighterInstalled,
  isOnExpectedNetwork,
  WalletError,
} from "./freighter";

describe("Freighter wallet helpers without extension", () => {
  const originalFreighter = window.freighter;

  beforeEach(() => {
    delete window.freighter;
  });

  afterEach(() => {
    if (originalFreighter !== undefined) {
      window.freighter = originalFreighter;
    } else {
      delete window.freighter;
    }
  });

  it("returns false from isFreighterInstalled when window.freighter is not present", async () => {
    const installed = await isFreighterInstalled();
    expect(installed).toBe(false);
  });

  it("returns false from isOnExpectedNetwork without probing extension", async () => {
    const onExpected = await isOnExpectedNetwork();
    expect(onExpected).toBe(false);
  });

  it("returns null from getConnectedAddress without probing extension", async () => {
    const address = await getConnectedAddress();
    expect(address).toBe(null);
  });

  it("throws a clear WalletError when connectFreighter is called without extension", async () => {
    await expect(connectFreighter()).rejects.toThrow(WalletError);
    await expect(connectFreighter()).rejects.toThrow(/Freighter isn't installed/);
  });
});
