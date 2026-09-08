import { redirect } from "next/navigation";
import { getSessionTenantId } from "@/lib/auth";
import ManifestoField from "@/components/ManifestoField";

// Full-viewport typographic manifesto landing (nell.ai spirit) driven by a
// real particle system: each word is a body with a home spring, wind drag,
// and soft-contact repulsion — words flow toward each other but can never
// touch (see ManifestoField). Previous conventional landing: /classic.

const BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || "Sezo_AI_bot";
const TG_URL = `https://t.me/${BOT}`;

export default async function Landing() {
  const tenantId = await getSessionTenantId();
  if (tenantId) redirect("/dashboard");

  return (
    <div className="mani">
      <nav className="m-nav" aria-label="Primary navigation">
        <a className="m-logo" href="/" aria-label="Sezo home">
          <span className="m-logo-mark" aria-hidden="true">S</span>
          <span>sezo</span>
        </a>
        <div className="m-nav-links">
          <a href="/classic">the calm version</a>
          <a className="m-nav-login" href="/login">dashboard</a>
        </div>
      </nav>

      <main className="m-viewport">
        <ManifestoField />
        <div className="m-wind m-wind-1" aria-hidden="true" />
        <div className="m-wind m-wind-2" aria-hidden="true" />

        <section className="m-hero" aria-labelledby="manifesto-title">
          <p className="m-kicker"><span aria-hidden="true" /> a food log that listens</p>
          <h1 id="manifesto-title">
            You eat.<br />
            You text.<br />
            <em>Sezo remembers.</em>
          </h1>
          <p className="m-deck">
            Send a sentence, a photo, or a voice note. Sezo counts the meal,
            fixes mistakes when you correct it, and quietly turns your days
            into a health record worth keeping.
          </p>
          <div className="m-actions">
            <a className="m-action m-action-primary" href={TG_URL} target="_blank" rel="noreferrer">
              Open Sezo in Telegram <span aria-hidden="true">↗</span>
            </a>
            <a className="m-action m-action-secondary" href="/login">
              View your dashboard <span aria-hidden="true">→</span>
            </a>
          </div>
          <ul className="m-proof" aria-label="Product highlights">
            <li>No forms</li>
            <li>Natural corrections</li>
            <li>Your history, remembered</li>
          </ul>
        </section>

        <div className="m-footnote" aria-hidden="true">
          <span>Move your cursor. The field moves with you.</span>
          <span>Telegram-first nutrition companion</span>
        </div>
      </main>
    </div>
  );
}
