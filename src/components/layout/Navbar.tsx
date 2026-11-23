"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowRight,
  Bell,
  Gavel,
  Heart,
  LayoutList,
  LogOut,
  Package,
  Plus,
  Search,
  Store,
  User,
  UserRound,
  Wallet,
} from "lucide-react";
import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useActivityFeed } from "@/context/ActivityFeedContext";
import ThemeToggle from "./ThemeToggle";
import NavWalletButton from "@/components/wallet/NavWalletButton";
import ModeSwitch from "./ModeSwitch";
import { isStandalonePage } from "@/lib/standalonePages";
import { useIsAdmin } from "@/lib/admin/useIsAdmin";

const ACCOUNT_LINKS = [
  { href: "/dashboard/activity", label: "Activity Feed", icon: Bell },
  { href: "/dashboard/buying", label: "My Purchases", icon: Package },
  { href: "/dashboard/selling", label: "Seller Hub", icon: LayoutList },
  { href: "/dashboard/selling/new", label: "List an Item", icon: Plus },
  { href: "/dashboard/wallet", label: "Wallet", icon: Wallet },
  { href: "/profile", label: "Profile", icon: UserRound },
];

/** Shown only to admins. The admin pages check the role again on the server. */
const ADMIN_LINK = { href: "/dashboard/admin/disputes", label: "Admin · Disputes", icon: Gavel };

export default function Navbar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, signOut } = useAuth();
  const { unreadCount } = useActivityFeed();
  const isAdmin = useIsAdmin();
  const accountLinks = isAdmin ? [...ACCOUNT_LINKS, ADMIN_LINK] : ACCOUNT_LINKS;
  const [query, setQuery] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const closeAccountMenu = (restoreFocus = true) => {
    setAccountOpen(false);

    if (restoreFocus) {
      accountButtonRef.current?.focus();
    }
  };

  const getAccountMenuItems = () =>
    Array.from(accountMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  useEffect(() => {
    if (!accountOpen) return;

    getAccountMenuItems()[0]?.focus();
  }, [accountOpen]);

  // Close the account menu on an outside click, as every other menu does.
  useEffect(() => {
    if (!accountOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (accountMenuRef.current?.contains(target) || accountButtonRef.current?.contains(target)) return;
      setAccountOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [accountOpen]);

  // "/" jumps to search from anywhere that is not already a text field.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleAccountButtonKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (["ArrowDown", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      setAccountOpen(true);
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setAccountOpen(true);
      requestAnimationFrame(() => getAccountMenuItems().at(-1)?.focus());
    }
  };

  const handleAccountMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const menuItems = getAccountMenuItems();
    const activeIndex = menuItems.findIndex((item) => item === document.activeElement);

    switch (e.key) {
      case "Escape":
        e.preventDefault();
        closeAccountMenu();
        break;
      case "Tab": {
        e.preventDefault();
        const nextIndex = e.shiftKey
          ? (activeIndex - 1 + menuItems.length) % menuItems.length
          : (activeIndex + 1) % menuItems.length;
        menuItems[nextIndex]?.focus();
        break;
      }
      case "ArrowDown":
        e.preventDefault();
        menuItems[(activeIndex + 1) % menuItems.length]?.focus();
        break;
      case "ArrowUp":
        e.preventDefault();
        menuItems[(activeIndex - 1 + menuItems.length) % menuItems.length]?.focus();
        break;
      case "Home":
        e.preventDefault();
        menuItems[0]?.focus();
        break;
      case "End":
        e.preventDefault();
        menuItems.at(-1)?.focus();
        break;
      default:
        break;
    }
  };

  if (isStandalonePage(pathname)) return null;

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return;

    router.push(`/search?q=${encodeURIComponent(trimmedQuery)}`);
  };

  const displayName = user ? user.displayName || user.email.split("@")[0] : "";

  return (
    <header className="fixed left-0 right-0 top-0 z-50 flex h-14 items-center gap-2 border-b border-line bg-bg/80 px-3 backdrop-blur-xl backdrop-saturate-150 sm:gap-3 sm:px-5">
      {/* Wordmark */}
      <Link href="/home" className="group flex shrink-0 items-center gap-2" aria-label="Lumenbay home">
        <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-white shadow-[0_0_0_1px_var(--line),0_6px_16px_-6px_rgba(224,72,59,0.55)] transition-transform group-hover:-rotate-6">
          <Image src="/logo-icon.png" alt="" width={20} height={20} priority />
        </span>
        <span className="font-display hidden text-[17px] font-extrabold tracking-[-0.02em] text-ink md:inline">
          Lumenbay
        </span>
      </Link>

      {/* Search */}
      <form onSubmit={handleSearch} role="search" className="mx-auto flex h-10 min-w-0 max-w-xl flex-1">
        <div className="group/search relative flex h-full w-full items-center rounded-full border border-line bg-surface-2 pl-3.5 pr-1 transition-colors focus-within:border-accent focus-within:bg-surface focus-within:shadow-[0_0_0_4px_var(--accent-soft)]">
          <Search className="h-4 w-4 shrink-0 text-ink-faint transition-colors group-focus-within/search:text-accent" aria-hidden />
          <label htmlFor="nav-search" className="sr-only">Search Lumenbay</label>
          <input
            id="nav-search"
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the marketplace"
            className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-sm text-ink outline-none placeholder:text-ink-faint [&::-webkit-search-cancel-button]:hidden"
          />
          <kbd className="mr-1.5 hidden rounded-md border border-line-strong px-1.5 py-0.5 font-mono text-[10px] text-ink-faint lg:inline">
            /
          </kbd>
          <button
            type="submit"
            aria-label="Search"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink text-bg transition-colors hover:bg-accent hover:text-on-accent"
          >
            <ArrowRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </form>

      {/* Right cluster */}
      <div className="flex shrink-0 items-center gap-0.5 sm:gap-1.5">
        <Link
          href={user ? "/dashboard/selling/new" : "/auth/register"}
          className="relative hidden items-center gap-1.5 overflow-hidden rounded-full bg-linear-to-r from-[#E0483B] to-[#FF7A59] px-3.5 py-2 text-xs font-bold text-white shadow-[0_8px_20px_-8px_rgba(224,72,59,0.8)] transition hover:brightness-110 sm:flex"
        >
          <Store className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{user ? "Sell an item" : "Sell on Lumenbay"}</span>
        </Link>
        <Link
          href={user ? "/dashboard/selling/new" : "/auth/register"}
          aria-label={user ? "Sell an item" : "Sell on Lumenbay"}
          className="grid h-9 w-9 place-items-center rounded-full bg-linear-to-r from-[#E0483B] to-[#FF7A59] text-white sm:hidden"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </Link>

        {user && <ModeSwitch className="hidden lg:flex" />}
        {user && <NavWalletButton />}

        <ThemeToggle />

        <Link
          href="/dashboard/wishlist"
          aria-label="Saved items"
          title="Saved items"
          className="hidden h-9 w-9 place-items-center rounded-md text-ink-muted transition-colors hover:bg-surface-2 hover:text-accent min-[400px]:grid"
        >
          <Heart className="h-[18px] w-[18px]" aria-hidden="true" />
        </Link>

        {user ? (
          <div className="relative">
            <button
              ref={accountButtonRef}
              aria-expanded={accountOpen}
              aria-haspopup="menu"
              aria-controls="account-menu"
              aria-label={unreadCount > 0 ? `Account menu, ${unreadCount} unread notifications` : "Account menu"}
              onClick={() => setAccountOpen((v) => !v)}
              onKeyDown={handleAccountButtonKeyDown}
              className="relative flex items-center gap-2 rounded-full p-0.5 transition-colors hover:bg-surface-2 lg:pr-3"
            >
              <span className="relative grid h-8 w-8 place-items-center rounded-full bg-linear-to-br from-[#E0483B] to-[#FFB4A2] text-xs font-bold text-white ring-2 ring-bg">
                {(user.displayName || user.email).charAt(0).toUpperCase()}
                {unreadCount > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white ring-2 ring-bg"
                  >
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                )}
              </span>
              <span className="hidden max-w-[9rem] truncate text-xs font-semibold text-ink lg:inline">
                {displayName}
              </span>
            </button>
            {accountOpen && (
              <div
                id="account-menu"
                ref={accountMenuRef}
                role="menu"
                aria-label="Account menu"
                onKeyDown={handleAccountMenuKeyDown}
                className="absolute right-0 top-12 z-50 w-60 overflow-hidden rounded-2xl border border-line bg-surface p-1.5 shadow-modal"
              >
                <div className="mb-1 flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-linear-to-br from-[#E0483B] to-[#FFB4A2] text-sm font-bold text-white">
                    {(user.displayName || user.email).charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-ink-faint">Signed in as</p>
                    {user.displayName && <p className="truncate text-sm font-bold text-ink">{user.displayName}</p>}
                    <p className="truncate text-xs text-ink-muted">{user.email}</p>
                  </div>
                </div>
                {accountLinks.map(({ href, label, icon: Icon }) => (
                  <Link
                    key={href}
                    href={href}
                    role="menuitem"
                    tabIndex={-1}
                    onClick={() => setAccountOpen(false)}
                    className="flex items-center justify-between rounded-lg px-3 py-2 text-sm text-ink-muted hover:bg-surface-2 hover:text-ink focus:bg-surface-2 focus:text-ink focus:outline-none"
                  >
                    <div className="flex items-center gap-2.5">
                      <Icon className="h-4 w-4 text-ink-faint" aria-hidden />
                      {label}
                    </div>
                    {href === "/dashboard/activity" && unreadCount > 0 && (
                      <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-bold text-white">
                        {unreadCount}
                      </span>
                    )}
                  </Link>
                ))}
                <div className="my-1 h-px bg-line" />
                <button
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => {
                    void signOut();
                    setAccountOpen(false);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-bad hover:bg-bad-bg focus:bg-bad-bg focus:outline-none"
                >
                  <LogOut className="h-4 w-4" aria-hidden />
                  Sign Out
                </button>
              </div>
            )}
          </div>
        ) : (
          <Link
            href="/auth/login"
            aria-label="Sign in"
            className="grid h-9 w-9 place-items-center rounded-md text-ink-muted transition-colors hover:bg-surface-2 hover:text-accent"
          >
            <User className="h-[18px] w-[18px]" />
          </Link>
        )}
      </div>
    </header>
  );
}
