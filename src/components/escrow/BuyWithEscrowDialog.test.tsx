import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BuyWithEscrowDialog from "./BuyWithEscrowDialog";
import type { Product } from "@/lib/products";

vi.mock("@/context/WalletContext", () => ({
  useWallet: () => ({
    address: "GBUYER1234567890123456789012345678901234567890",
    installed: true,
    networkOk: true,
    balance: 500,
    unfunded: false,
    connecting: false,
    connect: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "buyer-user-id" },
  }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/listings", () => ({
  getSellerProfile: vi.fn().mockResolvedValue({
    stellarAddress: "GSELLER1234567890123456789012345678901234567890",
  }),
}));

const mockProduct: Product = {
  id: "prod-1",
  sellerId: "seller-user-id",
  seller: "Alice Seller",
  name: "Vintage Mechanical Keyboard",
  description: "A wonderful keyboard",
  xlmPrice: 50,
  usdPrice: 10,
  originalUsdPrice: 15,
  discountPercent: 33,
  rating: 5,
  reviewCount: 12,
  category: "electronics",
  images: ["https://example.com/img.jpg"],
};

describe("BuyWithEscrowDialog Accessibility (#136)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders with role=dialog, aria-modal=true, and live region", async () => {
    const onClose = vi.fn();
    render(<BuyWithEscrowDialog product={mockProduct} onClose={onClose} />);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "buy-title");

    // Live region for step announcements
    const liveRegion = dialog.querySelector("[aria-live='polite']");
    expect(liveRegion).toBeInTheDocument();
  });

  it("exposes the step list and accessible step labels", async () => {
    const onClose = vi.fn();
    render(<BuyWithEscrowDialog product={mockProduct} onClose={onClose} />);

    await waitFor(() => {
      const stepList = screen.getByRole("list", { name: "Escrow checkout steps" });
      expect(stepList).toBeInTheDocument();
    });

    expect(screen.getByLabelText(/Step 1: Create the escrow/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Step 2: Lock your payment/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Step 3: Save your order/i)).toBeInTheDocument();
  });

  it("closes on Escape key press", () => {
    const onClose = vi.fn();
    render(<BuyWithEscrowDialog product={mockProduct} onClose={onClose} />);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("focuses the close button or first interactive element on mount", () => {
    const onClose = vi.fn();
    render(<BuyWithEscrowDialog product={mockProduct} onClose={onClose} />);

    const closeButton = screen.getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(closeButton);
  });
});
