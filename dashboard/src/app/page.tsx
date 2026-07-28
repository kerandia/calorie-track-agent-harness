import { redirect } from "next/navigation";
import { getSessionTenantId } from "@/lib/auth";

// Full-viewport typographic manifesto landing (nell.ai-style): a wall of
// low-contrast text fills the screen; the CTAs are bright highlights embedded
// IN the text mass. The previous conventional landing is kept at /classic.

const BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || "Sezo_AI_bot";
const TG_URL = `https://t.me/${BOT}`;

const SENTENCES = [
  "You already know how to do this. You text.",
  "Two eggs and toast. That is a log entry.",
  "A photo of your plate is a log entry.",
  "No forms. No barcode scanning. No database of 4,000 yogurts.",
  "Say it like you'd say it to a friend, and it's counted.",
  "Sezo reads the plate, estimates the calories, writes it down.",
  "Wrong guess? Say so. It's a lentil waffle, not a rice cake.",
  "That was yesterday, not today. Moved. Both days corrected.",
  "Smaller portion. Fixed. You missed the rice. Added.",
  "The log should argue less than you do.",
  "It remembers your goal, your allergies, what feels good after.",
  "It asks how the meal felt, and it learns from your answer.",
  "Your month becomes a calendar. Green under goal, red over.",
  "Streaks become visible. Patterns become obvious.",
  "Every day gets a color. Every meal gets remembered.",
  "Tracking fails when it feels like accounting.",
  "So we made it feel like texting, because it is texting.",
  "The best food log is the one you actually keep.",
  "It lives in the Telegram you already have open.",
  "Breakfast, ara ogun, dinner — logged in the time it takes to type it.",
  "Protein, carbs, fat. Counted while you eat.",
  "Ask what you ate on Tuesday. It knows. You don't have to.",
  "A coach that pays attention beats an app that waits for input.",
  "Your data is yours, keyed to your Telegram identity, nobody else's feed.",
  "This starts with calories. It doesn't end there.",
  "Biological age, sleep, movement — the same conversation, later.",
  "Your next meal is worth logging.",
  "One message a meal. That's the whole workflow.",
  "Send a photo when words are lazy. Words when photos are.",
  "The dashboard is one /login away, sent to you as a link.",
];

// Deterministic PRNG so server output is stable.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

type Token =
  | { t: "w"; v: string; hi: boolean }
  | { t: "cta"; v: string; href: string; primary: boolean; external: boolean };

function buildWall(): Token[] {
  const rand = lcg(20260728);
  const tokens: Token[] = [];
  const target = 2400; // words — enough to overfill a large viewport
  let words = 0;
  while (words < target) {
    const s = SENTENCES[Math.floor(rand() * SENTENCES.length)]!;
    for (const w of s.split(" ")) {
      tokens.push({ t: "w", v: w, hi: rand() < 0.045 });
      words++;
    }
  }
  // Embed the CTAs inside the text mass.
  tokens.splice(Math.floor(tokens.length * 0.38), 0, {
    t: "cta",
    v: "START ON TELEGRAM →",
    href: TG_URL,
    primary: true,
    external: true,
  });
  tokens.splice(Math.floor(tokens.length * 0.62), 0, {
    t: "cta",
    v: "LOGIN TO DASHBOARD →",
    href: "/login",
    primary: false,
    external: false,
  });
  return tokens;
}

export default async function Landing() {
  const tenantId = await getSessionTenantId();
  if (tenantId) redirect("/dashboard");

  const wall = buildWall();

  return (
    <div className="mani">
      <a className="m-logo" href="/classic" title="Sezo">
        <span className="m-logo-mark">🍎</span> sezo
      </a>
      <a className="m-top-btn" href="/login" title="Login to dashboard">
        →
      </a>

      <main className="m-viewport">
        <div className="m-wall">
          {wall.map((tok, i) =>
            tok.t === "cta" ? (
              <a
                key={i}
                className={tok.primary ? "m-cta m-cta-primary" : "m-cta"}
                href={tok.href}
                {...(tok.external
                  ? { target: "_blank", rel: "noreferrer" }
                  : {})}
              >
                {tok.v}
              </a>
            ) : (
              <span key={i} className={tok.hi ? "m-hi" : undefined}>
                {tok.v}{" "}
              </span>
            ),
          )}
        </div>
      </main>
    </div>
  );
}
