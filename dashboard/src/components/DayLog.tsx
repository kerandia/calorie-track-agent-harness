import {
  MEAL_TYPE_LABEL,
  MEAL_TYPE_ORDER,
  type DayTotals,
  type Meal,
  type MealType,
} from "@/lib/types";

type Props = {
  date: string;
  meals: Meal[];
  totals: DayTotals | undefined;
  goal: number | undefined;
};

const sentimentEmoji: Record<string, string> = {
  good: "😊",
  neutral: "😐",
  bad: "🤢",
};

const MACROS: { key: keyof DayTotals; label: string; color: string }[] = [
  { key: "protein_g", label: "Protein", color: "#34d399" },
  { key: "carb_g", label: "Carbs", color: "#e3a008" },
  { key: "fat_g", label: "Fat", color: "#f0883e" },
];

function ProgressRing({
  consumed,
  goal,
}: {
  consumed: number;
  goal: number | undefined;
}) {
  const size = 96;
  const stroke = 10;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const pct = goal ? Math.min(1.3, consumed / goal) : 0;
  const dash = Math.min(1, pct) * circ;
  const over = goal ? consumed - goal : 0;
  const color =
    !goal || pct <= 1
      ? "var(--accent)"
      : pct <= 1.1
        ? "var(--warn)"
        : "var(--over)";

  return (
    <div className="ring-wrap">
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--panel-2)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`}
        />
      </svg>
      <div className="ring-center">
        <div className="big">{consumed}</div>
        <div className="muted" style={{ fontSize: 12 }}>
          {goal ? `/ ${goal} kcal` : "kcal"}
        </div>
        {goal ? (
          <div
            style={{
              fontSize: 12,
              fontWeight: 650,
              marginTop: 4,
              color: over <= 0 ? "var(--good)" : "var(--over)",
            }}
          >
            {over <= 0 ? `${Math.abs(over)} left` : `${over} over`}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function DayLog({ date, meals, totals, goal }: Props) {
  const byType = new Map<MealType | "other", Meal[]>();
  for (const m of meals) {
    const key = (m.meal_type ?? "other") as MealType | "other";
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key)!.push(m);
  }

  const allGroups: (MealType | "other")[] = [...MEAL_TYPE_ORDER, "other"];
  const groups = allGroups.filter((g) => byType.has(g));
  const consumed = totals?.kcal ?? 0;

  const prettyDate = new Date(`${date}T00:00:00Z`).toLocaleDateString("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

  const maxMacro = Math.max(
    1,
    totals?.protein_g ?? 0,
    totals?.carb_g ?? 0,
    totals?.fat_g ?? 0,
  );

  return (
    <div className="panel">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 18,
        }}
      >
        <div>
          <strong style={{ fontSize: 17 }}>{prettyDate}</strong>
          <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
            {totals?.meal_count ?? 0}{" "}
            {(totals?.meal_count ?? 0) === 1 ? "meal" : "meals"} logged
          </div>
        </div>
        <ProgressRing consumed={consumed} goal={goal} />
      </div>

      {totals && totals.meal_count > 0 ? (
        <div style={{ marginBottom: 6 }}>
          {MACROS.map((mac) => {
            const v = (totals[mac.key] as number) ?? 0;
            return (
              <div key={mac.key} className="macro">
                <span className="muted">{mac.label}</span>
                <span className="track">
                  <span
                    className="fill"
                    style={{
                      width: `${(v / maxMacro) * 100}%`,
                      background: mac.color,
                    }}
                  />
                </span>
                <span className="val">{v} g</span>
              </div>
            );
          })}
        </div>
      ) : null}

      {meals.length === 0 ? (
        <p className="muted" style={{ marginTop: 16 }}>
          No meals logged this day.
        </p>
      ) : (
        groups.map((g) => (
          <div key={g}>
            <div className="section-title">
              {g === "other" ? "Other" : MEAL_TYPE_LABEL[g as MealType]}
            </div>
            <div className="grid-meals">
              {byType.get(g)!.map((m) => (
                <div key={m.id} className="meal-row">
                  <span>
                    {m.text}
                    {m.feedback_sentiment ? (
                      <span
                        title={m.feedback_note ?? m.feedback_sentiment}
                        style={{ marginLeft: 6 }}
                      >
                        {sentimentEmoji[m.feedback_sentiment] ?? ""}
                      </span>
                    ) : null}
                  </span>
                  <span className="meal-kcal">{m.kcal} kcal</span>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
