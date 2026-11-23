import { merchant } from "../data/mock";
import { Icon } from "./Icon";

export type Route = "overview" | "transactions" | "webhooks" | "keys";

const LINKS: { route: Route; href: string; label: string; icon: Parameters<typeof Icon>[0]["name"] }[] = [
  { route: "overview", href: "#/", label: "Overview", icon: "grid" },
  { route: "transactions", href: "#/transactions", label: "Transactions", icon: "swap" },
  { route: "webhooks", href: "#/webhooks", label: "Webhooks", icon: "pulse" },
  { route: "keys", href: "#/keys", label: "API keys", icon: "key" },
];

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map(part => part.charAt(0).toUpperCase())
    .join("");
}

export function Sidebar({ current }: { current: Route }) {
  return (
    <aside className="sidebar">
      <a className="brand" href="#/">
        <span className="brand-mark">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0F1B15" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 19V5h11M5 12h8" />
          </svg>
        </span>
        <span className="brand-name">
          Flutter<span>Pay</span>
        </span>
      </a>

      <nav className="nav" aria-label="Dashboard">
        {LINKS.map(link => (
          <a key={link.route} href={link.href} aria-current={current === link.route ? "page" : undefined}>
            <Icon name={link.icon} />
            {link.label}
          </a>
        ))}
      </nav>

      <div className="account">
        <span className="mode-pill">Test mode</span>
        <div className="account-row">
          <span className="avatar" aria-hidden="true">
            {initials(merchant.business_name)}
          </span>
          <div>
            <div className="account-name">{merchant.business_name}</div>
            <div className="account-email">{merchant.email}</div>
          </div>
        </div>
        <button type="button" className="btn-ghost-dark">
          Log out
        </button>
      </div>
    </aside>
  );
}
