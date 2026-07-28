import { redirect } from "next/navigation";
import { getSessionTenantId } from "@/lib/auth";

// Full-viewport typographic manifesto landing (nell.ai-style): a wall of
// low-contrast text fills the screen; the CTAs are bright highlights embedded
// IN the text mass. Motion = wind: columns sway out of phase, bright words
// bob independently, and light bands sweep across the field.
// The previous conventional landing is kept at /classic.

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
  | { t: "w"; v: string; hi: boolean; phase: number }
  | { t: "cta"; v: string; href: string; primary: boolean; external: boolean };

const COLUMNS = 12;
const WORDS_PER_COLUMN = 215;

function buildColumns(): Token[][] {
  const rand = lcg(20260728);
  const cols: Token[][] = [];
  for (let c = 0; c < COLUMNS; c++) {
    const col: Token[] = [];
    let words = 0;
    while (words < WORDS_PER_COLUMN) {
      const s = SENTENCES[Math.floor(rand() * SENTENCES.length)]!;
      for (const w of s.split(" ")) {
        col.push({
          t: "w",
          v: w,
          hi: rand() < 0.045,
          phase: Math.floor(rand() * 6),
        });
        words++;
      }
    }
    cols.push(col);
  }
  // Embed the CTAs inside the text mass (columns 3 and 7, mid-height).
  cols[3]!.splice(Math.floor(cols[3]!.length * 0.45), 0, {
    t: "cta",
    v: "START ON TELEGRAM →",
    href: TG_URL,
    primary: true,
    external: true,
  });
  cols[7]!.splice(Math.floor(cols[7]!.length * 0.55), 0, {
    t: "cta",
    v: "LOGIN TO DASHBOARD →",
    href: "/login",
    primary: false,
    external: false,
  });
  return cols;
}

export default async function Landing() {
  const tenantId = await getSessionTenantId();
  if (tenantId) redirect("/dashboard");

  const columns = buildColumns();

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
          {columns.map((col, ci) => (
            <div key={ci} className={`m-col m-col-${ci % 6}`}>
              {col.map((tok, i) =>
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
                ) : tok.hi ? (
                  <span key={i} className={`m-hi m-f${tok.phase}`}>
                    {tok.v}{" "}
                  </span>
                ) : (
                  <span key={i}>{tok.v} </span>
                ),
              )}
            </div>
          ))}
        </div>
        <div className="m-wind m-wind-1" aria-hidden="true" />
        <div className="m-wind m-wind-2" aria-hidden="true" />
      </main>
    </div>
  );
}
