// app/AdminShell.tsx — the frame the operator area sits in.
//
// Separate from AppShell on purpose. The saver's navigation answers a saver's
// questions: where are my circles, what am I invited to, how is my standing.
// None of those is a question somebody running the platform is asking, and
// offering them on an operations page makes the two feel like one product when
// they are deliberately not.
//
// So this renders no sidebar, no bottom bar, and none of Home, Explore, My
// circles, Invitations, My standing or Start a circle. What it renders is a
// compact header, the section anchors for the one page the operator area has,
// and the account the reader is signed in as.
//
// IT IS NOT A SECURITY BOUNDARY, and nothing here pretends to be one. A shell
// is layout. What an operator may see is decided by the service, against a
// wallet signature and an allowlist, and this file has no part in that: it
// holds no role, reads no allowlist, and gates nothing. Rendering it grants
// exactly nothing, which is why it can be rendered before anybody has proved
// who they are.

import type { ReactNode } from "react";

import styles from "./AdminShell.module.css";
import { useWallet } from "./WalletProvider";
import { ADMIN_NAV } from "./navigation";
import { hrefFor, type Route } from "../lib/router";

/** The cowrie mark, the same lavender glyph the rest of Iwa uses. */
function CowrieGlyph({ size = 20 }: { size?: number }) {
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

export interface AdminShellProps {
  navigate: (to: string | Route) => void;
  children: ReactNode;
}

export function AdminShell({ navigate, children }: AdminShellProps) {
  const { address } = useWallet();

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          {/* The brand leads back to the saver product, which is the only other
              place there is to go from here. */}
          <a
            className={styles.brand}
            href={hrefFor({ name: "home" })}
            onClick={(e) => {
              e.preventDefault();
              navigate({ name: "home" });
            }}
          >
            <CowrieGlyph />
            <span className={styles.brandName}>Iwa</span>
          </a>
          <span className={styles.badge}>Operations</span>

          <nav className={styles.nav} aria-label="Operator sections">
            {ADMIN_NAV.map((entry) => (
              <a key={entry.id} className={styles.navLink} href={`#${entry.id}`}>
                {entry.label}
              </a>
            ))}
          </nav>

          {/* Whose browser this is, and nothing about anybody else. Shown the
              same way the saver shell shows it, because it answers the same
              question: which wallet am I about to be asked to sign with. */}
          <div className={styles.account}>
            <span className={`${styles.dot} ${address === null ? styles.dotOff : ""}`} />
            {address === null ? "Not connected" : short(address)}
          </div>
        </div>
      </header>

      <main className={styles.main}>{children}</main>
    </div>
  );
}
