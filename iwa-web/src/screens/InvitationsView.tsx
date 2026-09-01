// Invitations this wallet accepted.
//
// The link is single use and easy to lose, so it must not be the only way back
// to a place someone already took. Accepting records the wallet against the
// place, and this is what that record is for: reconnect, and the invitation is
// here whether or not the circle has been created yet.

import { CircleListView } from "./CircleListView.tsx";
import type { Route } from "../lib/router.ts";

export function InvitationsView({ navigate }: { navigate: (to: string | Route) => void }) {
  return (
    <CircleListView
      navigate={navigate}
      source="invitations"
      title="Invitations"
      lede="Places you have accepted. Once the organizer creates the circle, you can join it here."
      empty={{
        text: "You have not accepted an invitation yet. An organizer sends you a link with a place reserved for you.",
        action: "Browse circles",
        route: { name: "explore" },
      }}
      connectReason="Your invitations are tied to your wallet, so it needs to be connected before they can be shown."
    />
  );
}
