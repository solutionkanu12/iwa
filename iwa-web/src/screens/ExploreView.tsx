// The public directory of circles.
//
// Read-only, and honestly so. Iwa's circles are invite gated in the contract:
// join_circle derives the member reference from an invite secret and requires
// it to already sit in the payout order, so a stranger cannot join whatever the
// interface offers them. Showing a Join button here would produce nothing but a
// reverted transaction, so the directory says what is actually true: you need a
// place reserved for you, and the organizer is the one who reserves it.
//
// Everything shown comes from public chain state and needs no wallet.

import { BrowseCirclesView } from "./BrowseCirclesView.tsx";
import { Island } from "../components/Island.tsx";
import { circlePath, type Route } from "../lib/router.ts";
import styles from "./CircleView.module.css";

export function ExploreView({ navigate }: { navigate: (to: string | Route) => void }) {
  return (
    <>
      <BrowseCirclesView onView={(id) => navigate(circlePath(id))} />

      <Island className={styles.card}>
        <h2 className={styles.h2}>Circles are invite only</h2>
        <p className={styles.meta}>
          You can read any circle here: its amount, its cadence, how many places it has and
          how far along it is. Taking a place is different. Each place is reserved for one
          person when the circle is created, so you join with an invitation from the
          organizer rather than by asking a circle to let you in.
        </p>
        <p className={styles.meta}>
          Nothing about who paid, or how much anyone holds, is visible here or anywhere else.
        </p>
      </Island>
    </>
  );
}
