import { Instrument_Serif } from "next/font/google";
import { redirect } from "next/navigation";
import { getSessionTenantId } from "@/lib/auth";

// One calm page: what Sezar is, the way in, and what it does. Same palette
// and type as the pages Sezar publishes. Earlier landings (the particle
// manifesto and /classic) live in git history.

const serif = Instrument_Serif({ weight: "400", style: ["normal", "italic"], subsets: ["latin"] });

const BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || "Sezo_AI_bot";
const TG_URL = `https://t.me/${BOT}`;

const DOES = [
  ["Meals", "Text it, snap it or say it. Calories and macros, logged — and corrected when you push back."],
  ["Places", "Share a Google Maps list. Sezar keeps your notes and learns what you like."],
  ["Plans", "Live places, real walking times and the hourly forecast, checked before it suggests."],
  ["Pages", "Trip plans and lists on a link you can reopen. Nothing goes public until you approve it."],
] as const;

export default async function Landing() {
  const tenantId = await getSessionTenantId();
  if (tenantId) redirect("/dashboard");

  return (
    <div className="lp">
      <nav className="lp-nav" aria-label="Primary navigation">
        <a className="lp-logo" href="/" aria-label="Sezar home">
          <span className="lp-logo-mark" aria-hidden="true">S</span>
          sezar
        </a>
        <a className="lp-nav-link" href="/login">Dashboard</a>
      </nav>

      <main className="lp-main">
        <p className="lp-eyebrow">A personal agent in your chat</p>
        <h1 className={serif.className}>
          You text.
          <br />
          Sezar <em>handles it.</em>
        </h1>
        <p className="lp-deck">
          Log a meal from a photo. Plan a weekend around places you&apos;ve saved. Check the rain
          before booking the terrace. No new app — it lives in the chat you already use.
        </p>
        <div className="lp-actions">
          <a className="lp-btn" href={TG_URL} target="_blank" rel="noreferrer">
            Open in Telegram <span aria-hidden="true">↗</span>
          </a>
          <span className="lp-soon">
            <b>iMessage</b> · invite only for now
          </span>
        </div>

        <ul className="lp-list" aria-label="What Sezar does">
          {DOES.map(([label, text]) => (
            <li key={label}>
              <span>{label}</span>
              <p>{text}</p>
            </li>
          ))}
        </ul>
      </main>

      <footer className="lp-foot">
        <span>Health details stay optional until a question needs them.</span>
        <a href="/login">Your dashboard →</a>
      </footer>
    </div>
  );
}
