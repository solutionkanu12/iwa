// Circles this wallet is part of, organized or joined.
//
// The list a person comes back to. Its whole job is that closing the browser
// costs nothing: connect the same wallet and your circles are here, with no
// invitation link and nothing kept on the device.

import { CircleListView } from "./CircleListView.tsx";
import type { Route } from "../lib/router.ts";

export function MyCirclesView({ navigate }: { navigate: (to: string | Route) => void }) {
  return (
    <CircleListView
      navigate={navigate}
      source="circles"
      title="My circles"
      lede="Circles you organize, and circles you hold a place in."
      empty={{
        text: "You are not part of a circle yet. You can look at the ones that exist, or start your own.",
        action: "Browse circles",
        route: { name: "explore" },
      }}
      connectReason="Which circles are yours is private to your wallet, so it needs to be connected before this can be shown."
    />
  );
}
