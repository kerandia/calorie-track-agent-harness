import { redirect } from "next/navigation";
import { getSessionTenantId } from "@/lib/auth";
import {
  computeKcalGoal,
  getActiveAssumptions,
  getDayTotals,
  getMealsInRange,
  getProfile,
} from "@/lib/redis";
import CalorieCalendar from "@/components/CalorieCalendar";
import DayLog from "@/components/DayLog";

export const dynamic = "force-dynamic";

const pad = (n: number) => String(n).padStart(2, "0");

function monthDates(year: number, month: number): string[] {
  const n = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Array.from(
    { length: n },
    (_, i) => `${year}-${pad(month + 1)}-${pad(i + 1)}`,
  );
}

type SearchParams = { [k: string]: string | string[] | undefined };

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const tenantId = await getSessionTenantId();
  if (!tenantId) redirect("/");

  const sp = await searchParams;
  const now = new Date();
  const month = sp.m ? Number(sp.m) : now.getUTCMonth();
  const year = sp.y ? Number(sp.y) : now.getUTCFullYear();
  const selectedDate =
    typeof sp.d === "string"
      ? sp.d
      : `${year}-${pad(month + 1)}-${pad(Math.min(now.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate()))}`;

  const [profile, assumptions] = await Promise.all([
    getProfile(tenantId),
    getActiveAssumptions(tenantId),
  ]);
  const goal = computeKcalGoal(profile);

  const dates = monthDates(year, month);
  const totals = await getDayTotals(tenantId, dates);

  // selected day's meals
  const dayStart = Date.parse(`${selectedDate}T00:00:00.000Z`);
  const dayEnd = Date.parse(`${selectedDate}T23:59:59.999Z`);
  const dayMeals = await getMealsInRange(tenantId, dayStart, dayEnd);

  // month nav
  const prev = month === 0 ? { y: year - 1, m: 11 } : { y: year, m: month - 1 };
  const next = month === 11 ? { y: year + 1, m: 0 } : { y: year, m: month + 1 };

  // month summary
  let daysLogged = 0;
  let daysUnderGoal = 0;
  let kcalSum = 0;
  for (const t of totals.values()) {
    if (t.meal_count > 0) {
      daysLogged++;
      kcalSum += t.kcal;
      if (goal && t.kcal <= goal) daysUnderGoal++;
    }
  }
  const avgKcal = daysLogged ? Math.round(kcalSum / daysLogged) : 0;
  const maxDayKcal = Math.max(
    1,
    ...dates.map((d) => totals.get(d)?.kcal ?? 0),
  );

  return (
    <div className="container">
      <div className="header">
        <h1 className="h1">🍎 Calorie Dashboard</h1>
        <a className="btn" href="/api/logout">
          Log out
        </a>
      </div>

      <div className="panel" style={{ marginBottom: 18 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="row">
            <div className="stat">
              <span className="v">{daysLogged}</span>
              <span className="l">days logged</span>
            </div>
            <div className="stat">
              <span className="v">{avgKcal}</span>
              <span className="l">avg kcal/day</span>
            </div>
            <div className="stat">
              <span className="v">{goal ? daysUnderGoal : "—"}</span>
              <span className="l">days at/under goal</span>
            </div>
          </div>
          <div className="row" style={{ alignItems: "center" }}>
            <a className="btn" href={`/dashboard?y=${prev.y}&m=${prev.m}`}>
              ← Prev
            </a>
            <a className="btn" href={`/dashboard?y=${next.y}&m=${next.m}`}>
              Next →
            </a>
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 18 }}>
        <CalorieCalendar
          year={year}
          month={month}
          totals={totals}
          goal={goal}
          selectedDate={selectedDate}
        />
        <div className="section-title">Daily trend</div>
        <div className="trend">
          {dates.map((d) => {
            const t = totals.get(d);
            const kcal = t?.kcal ?? 0;
            const h = kcal ? Math.max(3, (kcal / maxDayKcal) * 100) : 3;
            const color = !kcal
              ? "var(--panel-2)"
              : goal && kcal <= goal
                ? "var(--good)"
                : goal
                  ? "var(--over)"
                  : "var(--accent)";
            return (
              <a
                key={d}
                href={`/dashboard?y=${year}&m=${month}&d=${d}`}
                className="trend-bar"
                style={{ height: `${h}%`, background: color }}
                title={`${d}: ${kcal} kcal`}
              />
            );
          })}
        </div>
      </div>

      <DayLog
        date={selectedDate}
        meals={dayMeals}
        totals={totals.get(selectedDate)}
        goal={goal}
      />

      <div className="panel" style={{ marginTop: 18 }}>
        <div className="section-title" style={{ marginTop: 0 }}>
          Profile
        </div>
        {profile.onboarded_at ? (
          <p style={{ margin: "4px 0" }}>
            {[
              profile.name,
              profile.age ? `${profile.age}yo` : null,
              profile.sex,
              profile.weight_kg ? `${profile.weight_kg}kg` : null,
              goal ? `goal ${goal} kcal` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : (
          <p className="muted">
            Profile not complete — finish onboarding in the Telegram chat.
          </p>
        )}
        {profile.allergies?.length ? (
          <p className="muted" style={{ margin: "4px 0" }}>
            Allergies: {profile.allergies.join(", ")}
          </p>
        ) : null}

        {assumptions.length ? (
          <>
            <div className="section-title">What the agent thinks it knows</div>
            <div className="grid-meals">
              {assumptions.map((a) => (
                <div key={a.id} className="meal-row">
                  <span>
                    {a.text}
                    {a.status === "confirmed" ? " ✅" : ""}
                  </span>
                  <span className="pill" style={{ fontSize: 11 }}>
                    {a.confidence}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
