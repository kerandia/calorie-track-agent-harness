import { notFound, redirect } from "next/navigation";
import { getSessionTenantId } from "@/lib/auth";
import {
  isAdmin,
  loadMetrics,
  percentile,
  retention,
  sumMaps,
  turnsOf,
  uniqueActive,
  WATCHED_TOOLS,
} from "@/lib/metrics";

export const dynamic = "force-dynamic";

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const pct = (x: number | null) => (x === null ? "" : `${Math.round(x * 100)}%`);
const secs = (n: number) => `${n < 10 ? n : Math.round(n)}s`;
const top = (m: Record<string, number>, n = 12) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n);

export default async function Admin() {
  const tenantId = await getSessionTenantId();
  if (!tenantId) redirect("/");
  if (!(await isAdmin(tenantId))) notFound();

  const { days, first } = await loadMetrics(91); // newest first
  const last = (n: number) => days.slice(0, n);
  const week = last(7);
  const month = last(30);
  const firstDates = Object.values(first);
  const newIn = (n: number) => {
    const since = last(n).at(-1)!.date;
    return firstDates.filter((d) => d >= since).length;
  };
  const latency = week.flatMap((d) => d.latency);
  const errors7 = sumMaps(week.map((d) => d.errors));
  const errorCount = Object.values(errors7).reduce((a, b) => a + b, 0);
  const tools30 = sumMaps(month.map((d) => d.tools));
  const toolErr30 = sumMaps(month.map((d) => d.toolErrors));
  const shell30 = sumMaps(month.map((d) => d.shell));
  const spend30 = sumMaps(month.map((d) => d.spend));
  const tokens30 = month.reduce((t, d) => ({ in: t.in + d.tokens.in, out: t.out + d.tokens.out, calls: t.calls + d.tokens.calls }), { in: 0, out: 0, calls: 0 });
  const channels30 = { telegram: month.reduce((n, d) => n + (d.turns.telegram ?? 0), 0), imessage: month.reduce((n, d) => n + (d.turns.imessage ?? 0), 0) };
  const series = [...month].reverse();
  const maxDau = Math.max(1, ...series.map((d) => d.active.length));
  const maxTurns = Math.max(1, ...series.map(turnsOf));
  const cohorts = retention(days, first).filter((c) => c.size > 0);
  const unused = WATCHED_TOOLS.filter((t) => !tools30[t]);

  const tiles: [string, string][] = [
    ["users, all-time", String(firstDates.length)],
    ["new, 7 days", String(newIn(7))],
    ["active today", String(days[0]!.active.length)],
    ["active, 7 days", String(uniqueActive(week))],
    ["active, 30 days", String(uniqueActive(month))],
    ["turns, 7 days", String(week.reduce((n, d) => n + turnsOf(d), 0))],
    ["reply p50 / p95", latency.length ? `${secs(percentile(latency, 50)!)} / ${secs(percentile(latency, 95)!)}` : "—"],
    ["errors, 7 days", String(errorCount)],
  ];

  return (
    <div>
      <h1 className="page-title">Admin</h1>
      <p className="page-meta">Pseudonymous product metrics — counts and timings only, no message content.</p>

      <div className="tiles">
        {tiles.map(([label, value]) => (
          <div key={label} className="tile">
            <span className="tile-v">{value}</span>
            <span className="tile-l">{label}</span>
          </div>
        ))}
      </div>

      <section className="admin-sec">
        <h2 className="you-h">Daily active users · 30 days</h2>
        <div className="trend" aria-label="Daily active users">
          {series.map((d) => (
            <span key={d.date} className="trend-bar" title={`${d.date}: ${d.active.length}`}
              style={{ height: `${d.active.length ? Math.max(4, (d.active.length / maxDau) * 100) : 3}%`, background: d.active.length ? "var(--accent)" : "var(--panel-2)" }} />
          ))}
        </div>
        <h2 className="you-h" style={{ marginTop: 18 }}>Turns per day · 30 days</h2>
        <div className="trend" aria-label="Turns per day">
          {series.map((d) => (
            <span key={d.date} className="trend-bar" title={`${d.date}: ${turnsOf(d)}`}
              style={{ height: `${turnsOf(d) ? Math.max(4, (turnsOf(d) / maxTurns) * 100) : 3}%`, background: turnsOf(d) ? "var(--text)" : "var(--panel-2)" }} />
          ))}
        </div>
        <p className="page-meta" style={{ marginTop: 10 }}>
          Last 30 days by channel: Telegram {channels30.telegram}, iMessage {channels30.imessage}.
        </p>
      </section>

      <section className="admin-sec">
        <h2 className="you-h">Retention · weekly cohorts</h2>
        {cohorts.length === 0 ? <p className="page-meta">No new users in the last 8 weeks.</p> : null}
        <div className="table-wrap" hidden={cohorts.length === 0}>
          <table className="ret">
            <thead>
              <tr><th>First week</th><th>Users</th><th>+1 wk</th><th>+2 wk</th><th>+3 wk</th><th>+4 wk</th></tr>
            </thead>
            <tbody>
              {cohorts.map((c) => (
                <tr key={c.week}>
                  <td>{c.week}</td>
                  <td>{c.size}</td>
                  {c.returned.map((r, i) => (
                    <td key={i} style={r !== null && c.size ? { background: `color-mix(in srgb, var(--accent) ${Math.round(r * 60)}%, transparent)` } : undefined}>
                      {c.size ? pct(r) : ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="admin-grid">
        <section className="admin-sec">
          <h2 className="you-h">Tools · 30 days</h2>
          <ul className="kv-list">
            {top(tools30).map(([t, n]) => (
              <li key={t}><span>{t}</span><span>{n}{toolErr30[t] ? ` · ${toolErr30[t]} err` : ""}</span></li>
            ))}
          </ul>
          {unused.length ? <p className="page-meta" style={{ marginTop: 10 }}>Not used in 30 days: {unused.join(", ")}</p> : null}
        </section>

        <section className="admin-sec">
          <h2 className="you-h">Sandbox commands · 30 days</h2>
          {Object.keys(shell30).length ? (
            <ul className="kv-list">{top(shell30).map(([t, n]) => <li key={t}><span>{t}</span><span>{n}</span></li>)}</ul>
          ) : <p className="page-meta">None recorded yet.</p>}
        </section>

        <section className="admin-sec">
          <h2 className="you-h">Model & spend · 30 days</h2>
          <ul className="kv-list">
            <li><span>model calls</span><span>{tokens30.calls}</span></li>
            <li><span>tokens in / out</span><span>{k(tokens30.in)} / {k(tokens30.out)}</span></li>
            {top(spend30).map(([p, usd]) => <li key={p}><span>{p} (metered)</span><span>${usd.toFixed(2)}</span></li>)}
          </ul>
        </section>

        <section className="admin-sec">
          <h2 className="you-h">Errors · 7 days</h2>
          {errorCount ? (
            <ul className="kv-list">{top(errors7).map(([t, n]) => <li key={t}><span>{t}</span><span>{n}</span></li>)}</ul>
          ) : <p className="page-meta">None.</p>}
        </section>
      </div>
    </div>
  );
}
