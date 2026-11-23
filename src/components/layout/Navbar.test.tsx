import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import Navbar from "./Navbar";

let mockUser: { email: string; displayName?: string } | null = {
  email: "seller@example.com",
  displayName: "Seller User",
};
let mockUnreadCount = 0;

vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({
    user: mockUser,
    signOut: vi.fn(),
  }),
}));

vi.mock("@/context/ActivityFeedContext", () => ({
  useActivityFeed: () => ({
    unreadCount: mockUnreadCount,
    markAllAsRead: vi.fn(),
    refreshActivities: vi.fn(),
  }),
}));

vi.mock("@/lib/admin/useIsAdmin", () => ({
  useIsAdmin: () => false,
}));

vi.mock("./ThemeToggle", () => ({
  default: () => <div data-testid="theme-toggle" />,
}));

vi.mock("./ModeSwitch", () => ({
  default: () => <div data-testid="mode-switch" />,
}));

vi.mock("@/components/wallet/NavWalletButton", () => ({
  default: () => <div data-testid="nav-wallet-button" />,
}));

describe("Navbar unread notification badge (#135)", () => {
  it("shows the unread notification badge when signed in and unreadCount > 0", () => {
    mockUser = { email: "seller@example.com", displayName: "Seller" };
    mockUnreadCount = 3;

    render(<Navbar />);

    const accountButton = screen.getByRole("button", {
      name: /Account menu, 3 unread notifications/i,
    });
    expect(accountButton).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("does not show the badge when unreadCount is 0", () => {
    mockUser = { email: "seller@example.com", displayName: "Seller" };
    mockUnreadCount = 0;

    render(<Navbar />);

    const accountButton = screen.getByRole("button", { name: "Account menu" });
    expect(accountButton).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("never shows the badge for signed-out users", () => {
    mockUser = null;
    mockUnreadCount = 5;

    render(<Navbar />);

    expect(screen.queryByRole("button", { name: /Account menu/i })).not.toBeInTheDocument();
    expect(screen.queryByText("5")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
  });
});
