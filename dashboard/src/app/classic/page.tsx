import { redirect } from "next/navigation";
import { Instrument_Serif } from "next/font/google";
import { getSessionTenantId } from "@/lib/auth";

const serif = Instrument_Serif({ weight: "400", subsets: ["latin"] });

const BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || "Sezo_AI_bot";
const TG_URL = `https://t.me/${BOT}`;

const TEASER_WEEKS: number[][] = [
  [0, 2, 3, 2, 1, 0, 3],
  [2, 3, 2, 4, 2, 1, 3],
  [3, 2, 4, 3, 2, 3, 2],
  [1, 3, 2, 4, 3, 2, 0],
  [2, 4, 3, 2, 3, 1, 2],
];

export default async function ClassicLanding() {
  const tenantId = await getSessionTenantId();
  if (tenantId) redirect("/dashboard");

  return (
    <div className="landing">
      <nav className="l-nav" aria-label="Primary navigation">
        <a className="l-logo" href="/" aria-label="Sezo home">
          <span className="l-logo-mark" aria-hidden="true">S</span>
          <span>sezo</span>
        </a>
        <div className="l-nav-links">
          <a href="#inside">What you get</a>
          <a href="#how">How it works</a>
          <a href="/login">Log in</a>
          <a className="l-nav-cta" href={TG_URL} target="_blank" rel="noreferrer">
            Try Sezo <span aria-hidden="true">↗</span>
          </a>
        </div>
      </nav>

      <main>
        <header className="l-hero">
          <div className="l-hero-copy">
            <p className="l-eyebrow"><span aria-hidden="true" /> Nutrition tracking, minus the admin</p>
            <h1 className={`${serif.className} l-h1`}>
              Less tracking.<br />
              <em>More knowing.</em>
            </h1>
            <p className="l-sub l-hero-sub">
              Tell Sezo what you ate—in a text, photo, or voice note. It keeps
              the numbers, remembers the context, and shows you the pattern
              without turning lunch into paperwork.
            </p>
            <div className="l-cta-row">
              <a className="l-btn l-btn-primary" href={TG_URL} target="_blank" rel="noreferrer">
                Start in Telegram <span aria-hidden="true">↗</span>
              </a>
              <a className="l-btn l-btn-ghost" href="/login">
                Open dashboard <span aria-hidden="true">→</span>
              </a>
            </div>
            <div className="l-hero-note">
              <span className="l-avatar-stack" aria-hidden="true">
                <i>🍳</i><i>🥗</i><i>🍝</i>
              </span>
              <span>No new app to learn. Just the Telegram you already use.</span>
            </div>
          </div>

          <div className="l-demo" aria-label="Example conversation with Sezo">
            <div className="l-demo-glow" aria-hidden="true" />
            <div className="l-phone">
              <div className="l-phone-top">
                <span className="l-phone-back" aria-hidden="true">‹</span>
                <span className="l-phone-avatar" aria-hidden="true">S</span>
                <div>
                  <div className="l-phone-name">Sezo</div>
                  <div className="l-phone-status"><span /> online</div>
                </div>
                <span className="l-phone-menu" aria-hidden="true">•••</span>
              </div>
              <div className="l-chat">
                <span className="l-chat-date">TODAY</span>
                <div className="l-msg l-me">
                  <span className="l-food-shot" aria-hidden="true">🥙</span>
                  chicken bowl for lunch
                  <small>12:42</small>
                </div>
                <div className="l-msg l-bot">
                  got it—chicken grain bowl, about <strong>620 kcal</strong> and
                  42g protein. you&apos;re at 1,180 today.
                  <small>12:42</small>
                </div>
                <div className="l-msg l-me">
                  actually half the rice
                  <small>12:43</small>
                </div>
                <div className="l-msg l-bot">
                  fixed. <strong>510 kcal</strong> now. no paperwork harmed.
                  <small>12:43</small>
                </div>
              </div>
              <div className="l-composer" aria-hidden="true">
                <span>Message Sezo…</span><i>↑</i>
              </div>
            </div>
          </div>
        </header>

        <section className="l-proofbar" aria-label="Ways to use Sezo">
          <div><span>01</span><strong>Text, photo, or voice</strong><small>Log however feels fastest.</small></div>
          <div><span>02</span><strong>Correct it naturally</strong><small>“Half the rice” is enough.</small></div>
          <div><span>03</span><strong>See the whole month</strong><small>Patterns, not scattered entries.</small></div>
        </section>

        <section className="l-intro" id="inside">
          <p className="l-section-label">Built for real life</p>
          <div className="l-intro-grid">
            <h2 className={`${serif.className} l-h2`}>
              Tracking usually fails at the tracking part.
            </h2>
            <p>
              Sezo removes the taps, searches, forms, and tiny decisions between
              eating something and remembering it. Speak normally. The log
              stays structured anyway.
            </p>
          </div>
        </section>

        <section className="l-bento" aria-label="Product features">
          <article className="l-bento-card l-calendar-card">
            <div className="l-card-head">
              <div>
                <p className="l-card-kicker">Your month, at a glance</p>
                <h3>Progress you can actually read.</h3>
              </div>
              <span className="l-card-chip">SEPTEMBER</span>
            </div>
            <div className="l-calendar-demo">
              <div className="l-ring" aria-label="1,840 of 2,100 calories">
                <div><strong>1,840</strong><span>of 2,100 kcal</span></div>
              </div>
              <div className="l-heatmap" aria-hidden="true">
                {TEASER_WEEKS.flat().map((value, index) => (
                  <span key={index} className={`l-heat-${value}`} />
                ))}
              </div>
            </div>
            <div className="l-calendar-legend">
              <span><i className="l-legend-under" /> under goal</span>
              <span><i className="l-legend-over" /> over goal</span>
            </div>
          </article>

          <article className="l-bento-card l-memory-card">
            <span className="l-feature-icon" aria-hidden="true">◎</span>
            <div>
              <p className="l-card-kicker">Memory, not just storage</p>
              <h3>It learns your context.</h3>
              <p>Your goals, allergies, preferences, and the meals that make you feel good stay part of the conversation.</p>
            </div>
            <div className="l-memory-tags" aria-hidden="true">
              <span>vegetarian</span><span>high protein</span><span>2,100 kcal</span>
            </div>
          </article>

          <article className="l-bento-card l-correction-card">
            <p className="l-card-kicker">Edits without menus</p>
            <h3>Say what changed. Done.</h3>
            <div className="l-correction-demo" aria-hidden="true">
              <div><span>PASTA</span><strong>today</strong><del>740 kcal</del></div>
              <i>→</i>
              <div className="is-fixed"><span>PASTA</span><strong>yesterday</strong><b>610 kcal</b></div>
            </div>
          </article>

          <article className="l-bento-card l-voice-card">
            <div className="l-wave" aria-hidden="true">
              {[10, 18, 26, 14, 34, 22, 38, 16, 30, 20, 12].map((height, index) => (
                <i key={index} style={{ height }} />
              ))}
            </div>
            <div>
              <p className="l-card-kicker">Hands full?</p>
              <h3>Just say it.</h3>
              <p>Voice notes go through the same memory and meal log. Sezo can answer back in voice, too.</p>
            </div>
          </article>
        </section>

        <section className="l-how" id="how">
          <div className="l-how-heading">
            <p className="l-section-label">Three small steps</p>
            <h2 className={`${serif.className} l-h2`}>From lunch to useful data.</h2>
          </div>
          <ol className="l-steps">
            <li><span>01</span><h3>Say what you ate</h3><p>A rough sentence is enough. Add a photo or voice note whenever that&apos;s easier.</p></li>
            <li><span>02</span><h3>Let Sezo do the admin</h3><p>Calories and macros are estimated, logged, and corrected in the same conversation.</p></li>
            <li><span>03</span><h3>Notice the pattern</h3><p>Open your private dashboard to see daily totals, meal history, and the month taking shape.</p></li>
          </ol>
        </section>

        <section className="l-final">
          <div className="l-final-orbit" aria-hidden="true"><span /><span /><span /></div>
          <p className="l-section-label">Start with the next thing you eat</p>
          <h2 className={`${serif.className} l-h2`}>One message. That&apos;s the whole workflow.</h2>
          <p>Open Sezo in Telegram and log your next meal before you forget it.</p>
          <a className="l-btn l-btn-light" href={TG_URL} target="_blank" rel="noreferrer">
            Meet Sezo in Telegram <span aria-hidden="true">↗</span>
          </a>
        </section>
      </main>

      <footer className="l-footer">
        <a className="l-logo" href="/" aria-label="Sezo home">
          <span className="l-logo-mark" aria-hidden="true">S</span><span>sezo</span>
        </a>
        <p>A quieter way to understand what you eat.</p>
        <div><a href={TG_URL} target="_blank" rel="noreferrer">Telegram</a><a href="/login">Dashboard</a><a href="/">Manifesto</a></div>
      </footer>
    </div>
  );
}
