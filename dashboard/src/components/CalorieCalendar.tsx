import type { DayTotals } from "@/lib/types";

type Props = {
  year: number;
  month: number; // 0-11
  totals: Map<string, DayTotals>;
  goal: number | undefined;
  selectedDate: string;
};

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

/**
 * Apple-Watch-style calorie calendar. Each day is colored by how the day's
 * intake compares to the goal: under goal (deficit) → green; over → red;
 * no data → neutral. Cells are clickable to select that day.
 */
function cellStyle(
  total: DayTotals | undefined,
  goal: number | undefined,
): React.CSSProperties {
  if (!total || total.meal_count === 0) {
    return { background: "var(--panel-2)", color: "var(--muted)" };
  }
  if (!goal) {
    return { background: "#1f6feb33", color: "var(--text)" };
  }
  const diff = total.kcal - goal; // negative = deficit (good)
  const ratio = Math.max(-1, Math.min(1, diff / goal));
  if (ratio <= 0) {
    const alpha = 0.28 + Math.min(0.62, Math.abs(ratio) * 1.2);
    return { background: `rgba(52,211,153,${alpha})`, color: "#06231a" };
  }
  const alpha = 0.28 + Math.min(0.62, ratio * 1.2);
  return { background: `rgba(248,81,73,${alpha})`, color: "#2a0b0a" };
}

export default function CalorieCalendar({
  year,
  month,
  totals,
  goal,
  selectedDate,
}: Props) {
  const first = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const startOffset = (first.getUTCDay() + 6) % 7; // Mon-first

  const cells: (number | null)[] = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const monthName = new Date(Date.UTC(year, month, 1)).toLocaleString("en", {
    month: "long",
    timeZone: "UTC",
  });

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 12,
        }}
      >
        <strong style={{ fontSize: 16 }}>
          {monthName} {year}
        </strong>
        <span className="muted" style={{ fontSize: 12 }}>
          {goal ? `goal ${goal} kcal/day` : "set a goal for deficit coloring"}
        </span>
      </div>
      <div className="cal-grid" style={{ marginBottom: 7 }}>
        {DOW.map((d) => (
          <div key={d} className="cal-dow">
            {d}
          </div>
        ))}
      </div>
      <div className="cal-grid">
        {cells.map((d, i) => {
          if (d === null) return <div key={`e${i}`} className="cal-cell is-empty" />;
          const date = ymd(year, month, d);
          const total = totals.get(date);
          const isSelected = date === selectedDate;
          const title = total
            ? `${date}: ${total.kcal} kcal${goal ? ` / ${goal}` : ""} (${total.meal_count} meals)`
            : `${date}: no log`;
          return (
            <a
              key={date}
              href={`/dashboard?y=${year}&m=${month}&d=${date}`}
              className={`cal-cell${isSelected ? " is-selected" : ""}`}
              style={cellStyle(total, goal)}
              title={title}
            >
              <span className="cal-day">{d}</span>
              {total ? <span className="cal-kcal">{total.kcal}</span> : null}
            </a>
          );
        })}
      </div>
    </div>
  );
}
