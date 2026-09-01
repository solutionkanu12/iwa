// app/AppShell.tsx — the frame every application screen sits in.
//
// It owns navigation and the wallet control, and nothing else. What a circle
// contains, what standing says, how a draft is built: all of that stays with
// the screens that already do it. The shell renders whatever the route asks
// for and gets out of the way.
//
// It never requires a wallet to render. A visitor can arrive, look around and
// open a circle without connecting; connection is asked for by the action that
// genuinely needs it, or offered here when the visitor wants it.

import { useEffect, useRef, useState, type ReactNode } from "react";

import styles from "./AppShell.module.css";
import { useWallet } from "./WalletProvider";
import { hrefFor, type Route } from "../lib/router";
import {
  ACCOUNT_NAV,
  ACTION_NAV,
  MOBILE_NAV,
  PRIMARY_NAV,
  isActive,
  labelFor,
  type NavEntry,
} from "./navigation";

/** The cowrie mark, the same lavender glyph the rest of Iwa uses. */
function CowrieGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size * 1.09} viewBox="0 0 60 70" aria-hidden="true">
      <ellipse cx="30" cy="36" rx="20" ry="26" fill="#B6A6F2" />
      <ellipse cx="25" cy="29" rx="11" ry="15" fill="#CECBF6" opacity=".8" />
      <path d="M30 12C34 30 34 42 30 60C26 42 26 30 30 12Z" fill="#F6F4FC" />
    </svg>
  );
}

function short(address: string): string {
  return `${address.slice(0, 5)}…${address.slice(-4)}`;
}


export interface AppShellProps {
  route: Route;
  navigate: (to: string | Route) => void;
  children: ReactNode;
}

export function AppShell({ route, navigate, children }: AppShellProps) {
  const wallet = useWallet();
  // The phone's account menu. Closed by default, and closed again by anything
  // that happens outside it.
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!accountOpen) return;
    const onDown = (e: MouseEvent) => {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) {
        setAccountOpen(false);
      }
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAccountOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [accountOpen]);

  const link = (
    entry: NavEntry,
    className: string,
    activeClassName: string,
    dot: string,
    compact = false,
  ) => {
    const active = isActive(entry, route);
    return (
      <a
        key={entry.label}
        href={hrefFor(entry.route)}
        className={`${className} ${active ? activeClassName : ""}`}
        aria-current={active ? "page" : undefined}
        onClick={(e) => {
          // Left click navigates in place; modified clicks stay real links, so
          // "open in new tab" keeps working.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          navigate(entry.route);
        }}
      >
        <span className={dot} aria-hidden="true" />
        {labelFor(entry, compact)}
      </a>
    );
  };

  const walletControl = (
    <>
      {wallet.address === null ? (
        <button
          type="button"
          className={styles.connectBtn}
          onClick={() => void wallet.connect()}
          disabled={wallet.connecting}
        >
          {wallet.connecting ? "Connecting…" : "Connect wallet"}
        </button>
      ) : (
        <>
          <div className={styles.accountRow}>
            <span className={styles.walletDot} aria-hidden="true" />
            <span className={styles.walletAddr}>{short(wallet.address)}</span>
          </div>
          <button
            type="button"
            className={styles.accountAction}
            onClick={() => void wallet.disconnect()}
          >
            Disconnect
          </button>
        </>
      )}
      {wallet.error !== null && <p className={styles.walletError}>{wallet.error}</p>}
    </>
  );

  return (
    <div className={styles.shell}>
      <span className={`${styles.blob} ${styles.blob1}`} aria-hidden="true" />
      <span className={`${styles.blob} ${styles.blob2}`} aria-hidden="true" />

      <aside className={styles.sidebar}>
        <div className={styles.sidebarInner}>
          <a className={styles.brand} href="/">
            <CowrieGlyph />
            <span className={styles.brandName}>iwa</span>
          </a>

          <nav className={styles.nav} aria-label="Application">
            <div className={styles.navGroup}>
              {PRIMARY_NAV.map((e) => link(e, styles.navItem, styles.navItemActive, styles.navDot))}
            </div>
            <div className={styles.navGroup}>
              <span className={styles.navLabel}>Organize</span>
              {ACTION_NAV.map((e) => link(e, styles.navItem, styles.navItemActive, styles.navDot))}
            </div>
            <div className={styles.navGroup}>
              <span className={styles.navLabel}>About</span>
              <a className={styles.navItem} href="/litepaper.html">
                <span className={styles.navDot} aria-hidden="true" />
                How Iwa works
              </a>
            </div>
          </nav>

          <div className={styles.spacer} />
          <div className={styles.account}>{walletControl}</div>
        </div>
      </aside>

      <div className={styles.main}>
        <div className={styles.content}>
          <header className={styles.mobileBar}>
            <a className={styles.mobileBrand} href="/">
              <CowrieGlyph size={20} />
              <span className={styles.brandName}>iwa</span>
            </a>
            {wallet.address === null ? (
              <button
                type="button"
                className={styles.mobileConnect}
                onClick={() => void wallet.connect()}
                disabled={wallet.connecting}
              >
                {wallet.connecting ? "Connecting…" : "Connect"}
              </button>
            ) : (
              <div className={styles.accountMenu} ref={accountRef}>
                <button
                  type="button"
                  className={styles.mobileAddr}
                  onClick={() => setAccountOpen((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={accountOpen}
                  aria-label={`Account, connected as ${short(wallet.address)}`}
                >
                  <span className={styles.walletDot} aria-hidden="true" />
                  {short(wallet.address)}
                </button>
                {accountOpen ? (
                  <div className={styles.dropdown} role="menu">
                    {ACCOUNT_NAV.map((entry) => (
                      <a
                        key={entry.label}
                        role="menuitem"
                        className={styles.dropdownItem}
                        href={hrefFor(entry.route)}
                        aria-current={isActive(entry, route) ? "page" : undefined}
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
                            return;
                          }
                          e.preventDefault();
                          setAccountOpen(false);
                          navigate(entry.route);
                        }}
                      >
                        {entry.label}
                      </a>
                    ))}
                    <button
                      type="button"
                      role="menuitem"
                      className={styles.dropdownItem}
                      onClick={() => {
                        setAccountOpen(false);
                        void wallet.disconnect();
                      }}
                    >
                      Disconnect
                    </button>
                  </div>
                ) : null}
              </div>
            )}
          </header>

          {children}
        </div>
      </div>

      <nav className={styles.bottomNav} aria-label="Application">
        {MOBILE_NAV.map((e) =>
          link(e, styles.bottomTab, styles.bottomTabActive, styles.bottomDot, true),
        )}
      </nav>
    </div>
  );
}

/** A path the application does not have. Says so, and offers the way back. */
export function NotFoundView({ navigate }: { navigate: (to: string | Route) => void }) {
  return (
    <section className={styles.missing}>
      <h1 className={styles.missingTitle}>That page could not be found</h1>
      <p className={styles.missingText}>
        The link may be mistyped, or the circle may not exist.
      </p>
      <button
        type="button"
        className={styles.connectBtn}
        onClick={() => navigate({ name: "explore" })}
      >
        Browse circles
      </button>
    </section>
  );
}
