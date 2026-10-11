import { redirect } from "next/navigation";
import { getSessionTenantId } from "@/lib/auth";
import { computeKcalGoal, getActiveAssumptions, getLinkedPhone, getProfile } from "@/lib/redis";
import { decideAssumption, unlinkMyPhone } from "./actions";

export const dynamic = "force-dynamic";

const BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || "Sezo_AI_bot";

const ACTIVITY: Record<string, string> = {
  sedentary: "mostly sitting",
  light: "lightly active",
  moderate: "moderately active",
  active: "active",
  very_active: "very active",
};

export default async function You() {
  const tenantId = await getSessionTenantId();
  if (!tenantId) redirect("/");
  const [profile, assumptions, phone] = await Promise.all([
    getProfile(tenantId),
    getActiveAssumptions(tenantId, 50),
    getLinkedPhone(tenantId),
  ]);
  const goal = computeKcalGoal(profile);
  const onIMessage = tenantId.startsWith("im:");

  const facts: [string, string | undefined][] = [
    ["Name", profile.name],
    ["Age", profile.age ? String(profile.age) : undefined],
    ["Height", profile.height_cm ? `${profile.height_cm} cm` : undefined],
    ["Weight", profile.weight_kg ? `${profile.weight_kg} kg` : undefined],
    ["Activity", profile.activity_level ? ACTIVITY[profile.activity_level] : undefined],
    ["Daily goal", goal ? `${goal} kcal` : undefined],
    ["Allergies", profile.allergies?.join(", ")],
    ["Eats", profile.dietary_preferences?.join(", ")],
    ["Likes", profile.likes?.join(", ")],
    ["Dislikes", profile.dislikes?.join(", ")],
  ];
  const known = facts.filter(([, v]) => v);

  return (
    <div className="narrow">
      <h1 className="page-title">You</h1>

      <section className="you">
        <h2 className="you-h">Profile</h2>
        {known.length ? (
          <dl className="facts">
            {known.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="page-meta">Nothing yet. Health details stay optional until a question needs them.</p>
        )}
        <p className="page-meta">To change any of this, just tell Sezar.</p>
      </section>

      <section className="you">
        <h2 className="you-h">What Sezar has learned</h2>
        {assumptions.length ? (
          <ul className="learned">
            {assumptions.map((a) => (
              <li key={a.id}>
                <span className="learned-text">
                  {a.text}
                  <span className="learned-meta">
                    {a.status === "confirmed" ? "confirmed by you" : `${a.confidence} confidence`}
                  </span>
                </span>
                {a.status === "confirmed" ? null : (
                  <form action={decideAssumption} className="learned-actions">
                    <input type="hidden" name="id" value={a.id} />
                    <button type="submit" name="status" value="confirmed" className="chip-btn">
                      Right
                    </button>
                    <button type="submit" name="status" value="rejected" className="chip-btn chip-quiet">
                      Not true
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="page-meta">Nothing yet — Sezar notes patterns as you chat, and you can confirm or correct them here.</p>
        )}
      </section>

      <section className="you">
        <h2 className="you-h">Linked chats</h2>
        <ul className="links">
          <li>
            <span>{onIMessage ? "iMessage" : "Telegram"}</span>
            <span className="page-meta-inline">this account</span>
          </li>
          {onIMessage ? null : phone ? (
            <li>
              <span>iMessage · {phone}</span>
              <form action={unlinkMyPhone}>
                <button type="submit" className="chip-btn chip-quiet">
                  Unlink
                </button>
              </form>
            </li>
          ) : (
            <li>
              <span>iMessage</span>
              <span className="page-meta-inline">not linked — send /link to Sezar in Telegram</span>
            </li>
          )}
        </ul>
      </section>

      <section className="you">
        <h2 className="you-h">Your data</h2>
        <p className="page-meta">
          Download everything Sezar stores about you — meals, profile, places, what it learned, published links and
          your conversation — as one file.
        </p>
        <a className="chip-btn" href="/api/export" download>
          Download my data
        </a>
        <p className="page-meta you-danger">
          To delete everything, send <code>/deletemydata</code> to Sezar, then reply <code>DELETE</code>. It removes
          your data and takes your pages and maps offline; it can&apos;t be undone.
          {onIMessage ? null : (
            <>
              {" "}
              <a href={`https://t.me/${BOT}`} target="_blank" rel="noreferrer">
                Open Telegram ↗
              </a>
            </>
          )}
        </p>
      </section>
    </div>
  );
}
