// Which screen a route shows.
//
// One switch, in one place. Each screen keeps its own behaviour: the shell
// frames it, this chooses it, and neither knows what a circle contains.

import { AppShell, NotFoundView } from "./app/AppShell.tsx";
import { AdminShell } from "./app/AdminShell.tsx";
import { CircleView } from "./screens/CircleView.tsx";
import { HomeView } from "./screens/HomeView.tsx";
import { ExploreView } from "./screens/ExploreView.tsx";
import { MyCirclesView } from "./screens/MyCirclesView.tsx";
import { InvitationsView } from "./screens/InvitationsView.tsx";
import { StandingView } from "./screens/StandingView.tsx";
import { OrganizerCircleView } from "./screens/OrganizerCircleView.tsx";
import { AdminView } from "./screens/AdminView.tsx";
import { shellFor } from "./app/navigation.ts";
import type { Route } from "./lib/router.ts";

export interface AppProps {
  route: Route;
  navigate: (to: string | Route) => void;
}

export function App({ route, navigate }: AppProps) {
  let screen;
  switch (route.name) {
    case "home":
      screen = <HomeView navigate={navigate} />;
      break;
    case "explore":
      screen = <ExploreView navigate={navigate} />;
      break;
    case "myCircles":
      screen = <MyCirclesView navigate={navigate} />;
      break;
    case "invitations":
      screen = <InvitationsView navigate={navigate} />;
      break;
    case "circle":
      // Keyed by id so moving between circles remounts rather than leaving one
      // circle's state on another circle's screen.
      screen = <CircleView key={route.circleId} circleId={route.circleId} navigate={navigate} />;
      break;
    case "standing":
      screen = <StandingView navigate={navigate} />;
      break;
    case "create":
      screen = <OrganizerCircleView navigate={navigate} />;
      break;
    case "admin":
      screen = <AdminView navigate={navigate} />;
      break;
    default:
      screen = <NotFoundView navigate={navigate} />;
  }

  // Which frame this route belongs in. The operator area has its own, so the
  // saver's navigation never appears beside a page about running the platform.
  // The rule is in app/navigation.ts, where it can be checked directly.
  if (shellFor(route) === "admin") {
    return <AdminShell navigate={navigate}>{screen}</AdminShell>;
  }

  return (
    <AppShell route={route} navigate={navigate}>
      {screen}
    </AppShell>
  );
}
