import { statusLabel, statusTone } from "../lib/format";

export function StatusBadge({ status, dot = false }: { status: string; dot?: boolean }) {
  return (
    <span className={`badge badge-${statusTone(status)}`}>
      {dot && <span className="dot" aria-hidden="true" />}
      {statusLabel(status)}
    </span>
  );
}
