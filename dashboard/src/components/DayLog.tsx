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
  const diff = goal ? consumed - goal : undefined;

  return (
    <div className="panel">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 12,
        }}
      >
        <strong style={{ fontSize: 16 }}>{date}</strong>
        <span className="muted">
          {totals?.meal_count ?? 0} meals · {consumed} kcal
          {goal ? ` / ${goal}` : ""}
        </span>
      </div>

      {goal ? (
        <div style={{ marginBottom: 14 }}>
          <span
            className="pill"
            style={{
              borderColor:
                diff! <= 0 ? "var(--good-strong)" : "var(--over)",
              color: diff! <= 0 ? "var(--good-strong)" : "var(--over)",
            }}
          >
            {diff! <= 0
              ? `${Math.abs(diff!)} kcal under goal`
              : `${diff} kcal over goal`}
          </span>
        </div>
      ) : null}

      {meals.length === 0 ? (
        <p className="muted">No meals logged this day.</p>
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
                  <span className="muted" style={{ whiteSpace: "nowrap" }}>
                    {m.kcal} kcal
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
