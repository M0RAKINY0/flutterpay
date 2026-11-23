import { useEffect, useState } from "react";
import { Sidebar, type Route } from "./components/Sidebar";
import { KeysPage } from "./pages/KeysPage";
import { OverviewPage } from "./pages/OverviewPage";
import { TransactionsPage } from "./pages/TransactionsPage";
import { WebhooksPage } from "./pages/WebhooksPage";

interface Location {
  route: Route;
  params: URLSearchParams;
}

// Hash routing keeps the app a static bundle with no server rewrites.
function readLocation(): Location {
  const hash = window.location.hash.replace(/^#/, "") || "/";
  const [path = "/", query = ""] = hash.split("?");
  const routes: Record<string, Route> = {
    "/": "overview",
    "/transactions": "transactions",
    "/webhooks": "webhooks",
    "/keys": "keys",
  };
  return { route: routes[path] ?? "overview", params: new URLSearchParams(query) };
}

const TITLES: Record<Route, string> = {
  overview: "Overview",
  transactions: "Transactions",
  webhooks: "Webhooks",
  keys: "API keys",
};

export function App() {
  const [location, setLocation] = useState(readLocation);

  useEffect(() => {
    const onChange = () => {
      setLocation(readLocation());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  useEffect(() => {
    document.title = `${TITLES[location.route]} · FlutterPay Dashboard`;
  }, [location.route]);

  return (
    <div className="shell">
      <Sidebar current={location.route} />
      <main className="content">
        {location.route === "overview" && <OverviewPage />}
        {location.route === "transactions" && <TransactionsPage />}
        {location.route === "webhooks" && (
          <WebhooksPage key={location.params.get("tx") ?? ""} transactionId={location.params.get("tx")} />
        )}
        {location.route === "keys" && <KeysPage />}
      </main>
    </div>
  );
}
