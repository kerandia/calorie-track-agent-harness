import { redirect } from "next/navigation";
import { Instrument_Serif } from "next/font/google";
import { getSessionTenantId } from "@/lib/auth";

const serif = Instrument_Serif({ weight: "400", subsets: ["latin"] });

const BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || "Sezo_AI_bot";
const TG_URL = `https://t.me/${BOT}`;

// Static mini-heatmap for the calendar teaser (deficit=green, surplus=red).
const TEASER_WEEKS: number[][] = [
  [2, 3, 1, 2, 0, 3, 2],
  [3, 2, 2, 4, 2, 1, 3],
  [2, 4, 3, 2, 3, 2, 0],
  [1, 2, 4, 3, 2, 3, 2],
];
const TEASER_COLORS = [
  "var(--l-cell)",
  "rgba(31,122,90,0.25)",
  "rgba(31,122,90,0.45)",
  "rgba(31,122,90,0.7)",
  "rgba(220,83,72,0.55)",
];

export default async function Landing() {
  const tenantId = await getSessionTenantId();
  if (tenantId) redirect("/dashboard");

  return (
    <div className="landing">
      <nav className="l-nav">
        <span className="l-logo">🍎 Sezo</span>
        <a className="l-btn l-btn-ghost" href="/login">
          Dashboard
        </a>
      </nav>

      {/* Hero */}
      <header className="l-hero">
        <div className="l-hero-copy">
          <p className="l-eyebrow">Your health agent on Telegram</p>
          <h1 className={`${serif.className} l-h1`}>
            Track calories by just&nbsp;texting.
          </h1>
          <p className="l-sub">
            Send Sezo a message — or a photo of your plate — and it logs
            calories and macros, remembers what works for you, and turns it all
            into a calendar you&apos;ll actually look at. No forms. No barcode
            scanning. Just a chat.
          </p>
          <div className="l-cta-row">
            <a className="l-btn l-btn-primary" href={TG_URL} target="_blank" rel="noreferrer">
              Start on Telegram →
            </a>
            <a className="l-btn l-btn-ghost" href="/login">
              Open your dashboard
            </a>
          </div>
          <p className="l-fineprint">
            Free to try · works inside the Telegram you already have
          </p>
        </div>

        {/* Chat mockup */}
        <div className="l-phone" aria-hidden="true">
          <div className="l-phone-top">
            <span className="l-phone-avatar">🍎</span>
            <div>
              <div className="l-phone-name">Sezo</div>
              <div className="l-phone-status">bot</div>
            </div>
          </div>
          <div className="l-chat">
            <div className="l-msg l-me">2 eggs and toast for breakfast</div>
            <div className="l-msg l-bot">
              Logged 🍳 <strong>310 kcal</strong> · 18g protein. 1,540 kcal
              left today.
            </div>
            <div className="l-msg l-me">
              <span className="l-photo">📷 photo of a chicken bowl</span>
              lunch
            </div>
            <div className="l-msg l-bot">
              Grilled chicken bowl — <strong>~620 kcal</strong>, 42g protein.
              Logged 🍗
            </div>
            <div className="l-msg l-me">the pasta was yesterday btw</div>
            <div className="l-msg l-bot">
              Moved it to yesterday — both days&apos; totals fixed ✅
            </div>
          </div>
        </div>
      </header>

      {/* Features */}
      <section className="l-section">
        <h2 className={`${serif.className} l-h2`}>
          A coach that pays attention
        </h2>
        <div className="l-grid">
          <div className="l-card">
            <div className="l-card-emoji">📷</div>
            <h3>Snap your plate</h3>
            <p>
              Photos become meals: Sezo identifies the food and estimates
              calories and macros — correct it in plain words if it&apos;s off.
            </p>
          </div>
          <div className="l-card">
            <div className="l-card-emoji">✏️</div>
            <h3>Corrections that work</h3>
            <p>
              &ldquo;That was yesterday.&rdquo; &ldquo;Smaller portion.&rdquo;
              &ldquo;It&apos;s a lentil waffle, not a rice cake.&rdquo; Sezo
              edits the log instead of arguing.
            </p>
          </div>
          <div className="l-card">
            <div className="l-card-emoji">🧠</div>
            <h3>Remembers you</h3>
            <p>
              Your goals, allergies, likes and patterns persist. Sezo even asks
              how a meal made you feel — and learns from the answer.
            </p>
          </div>
          <div className="l-card">
            <div className="l-card-emoji">📅</div>
            <h3>A calendar you&apos;ll check</h3>
            <p>
              Every day colored by deficit or surplus, with daily rings and
              macro bars — your month at a glance.
            </p>
          </div>
        </div>
      </section>

      {/* Calendar teaser */}
      <section className="l-section l-teaser">
        <div className="l-teaser-grid" aria-hidden="true">
          {TEASER_WEEKS.flat().map((v, i) => (
            <span
              key={i}
              className="l-teaser-cell"
              style={{ background: TEASER_COLORS[v] }}
            />
          ))}
        </div>
        <div>
          <h2 className={`${serif.className} l-h2`}>
            Every day, colored by how you did.
          </h2>
          <p className="l-sub" style={{ marginBottom: 18 }}>
            Green for under goal, red for over. Streaks become visible;
            patterns become obvious. Log in with the same Telegram account you
            chat from — Sezo can send you a one-tap login link.
          </p>
          <a className="l-btn l-btn-ghost" href="/login">
            See your calendar →
          </a>
        </div>
      </section>

      {/* How it works */}
      <section className="l-section">
        <h2 className={`${serif.className} l-h2`}>How it works</h2>
        <ol className="l-steps">
          <li>
            <span className="l-step-n">1</span>
            <div>
              <h3>Open Telegram</h3>
              <p>
                Tap the button below — Sezo introduces itself and asks a few
                friendly questions to set your daily target.
              </p>
            </div>
          </li>
          <li>
            <span className="l-step-n">2</span>
            <div>
              <h3>Say what you ate</h3>
              <p>
                Text it, photograph it, describe it roughly — Sezo does the
                counting and keeps a running total.
              </p>
            </div>
          </li>
          <li>
            <span className="l-step-n">3</span>
            <div>
              <h3>Watch the calendar fill</h3>
              <p>
                Type /login any time for your dashboard: daily rings, macros,
                and the month heatmap.
              </p>
            </div>
          </li>
        </ol>
      </section>

      {/* Final CTA */}
      <section className="l-final">
        <h2 className={`${serif.className} l-h2`}>
          Your next meal is worth logging.
        </h2>
        <div className="l-cta-row" style={{ justifyContent: "center" }}>
          <a className="l-btn l-btn-primary" href={TG_URL} target="_blank" rel="noreferrer">
            Start on Telegram →
          </a>
        </div>
      </section>

      <footer className="l-footer">
        <span>🍎 Sezo — your health agent</span>
        <span>
          <a href={TG_URL} target="_blank" rel="noreferrer">
            Telegram
          </a>{" "}
          · <a href="/login">Dashboard</a>
        </span>
      </footer>
    </div>
  );
}
