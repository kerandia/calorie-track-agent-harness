"use client";

import { useEffect, useRef } from "react";

// nell.ai-style text field: the wave doesn't move elements — it travels
// THROUGH the text, locally stretching words by duplicating letters
// (AAAANNNDD, TTTEEERRS) as the front passes, then healing them.
// Content generation is seeded/deterministic so SSR and hydration agree.

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

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

type WordTok = { v: string; hi: boolean };
const COLUMNS = 12;
const WORDS_PER_COLUMN = 215;

function buildColumns(): WordTok[][] {
  const rand = lcg(20260728);
  const cols: WordTok[][] = [];
  for (let c = 0; c < COLUMNS; c++) {
    const col: WordTok[] = [];
    while (col.length < WORDS_PER_COLUMN) {
      const s = SENTENCES[Math.floor(rand() * SENTENCES.length)]!;
      for (const w of s.split(" ")) col.push({ v: w, hi: rand() < 0.045 });
    }
    cols.push(col);
  }
  return cols;
}

const COLS = buildColumns();

/** Stretch a word the way a wave crest would: duplicate letters, more at the
 *  crest center. Deterministic per (word, tick) so it shimmers, not flickers. */
function stretch(word: string, intensity: number, salt: number): string {
  let out = "";
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]!;
    // pseudo-random but stable within a tick
    const h = (i * 2654435761 + salt * 40503) >>> 0;
    const r = (h % 1000) / 1000;
    const reps = r < intensity ? (r < intensity * 0.4 ? 3 : 2) : 1;
    out += ch.repeat(reps);
  }
  return out;
}

type Props = {
  tgUrl: string;
};

export default function ManifestoWall({ tgUrl }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = rootRef.current;
    if (!root) return;

    const spans = Array.from(
      root.querySelectorAll<HTMLSpanElement>("span[data-w]"),
    );
    const N = spans.length;
    const words = spans.map((el) => el.dataset.w!);
    const warped = new Set<number>();

    let tick = 0;
    const id = setInterval(() => {
      tick++;
      const t = tick * 0.045;
      // Two wave fronts traveling through 1D index space at different speeds
      // and wavelengths — their sum makes the crests meander instead of
      // marching in a straight line.
      for (let i = 0; i < N; i++) {
        const p = i / N;
        const w1 = Math.sin(2 * Math.PI * (p * 3.0 - t));
        const w2 = Math.sin(2 * Math.PI * (p * 7.0 + t * 0.6) + 1.7);
        const v = (w1 + w2) / 2; // -1..1
        if (v > 0.62) {
          const intensity = Math.min(1, (v - 0.62) / 0.3) * 0.7;
          spans[i]!.textContent = stretch(words[i]!, intensity, tick + i) + " ";
          warped.add(i);
        } else if (warped.has(i)) {
          spans[i]!.textContent = words[i]! + " ";
          warped.delete(i);
        }
      }
    }, 110);

    return () => clearInterval(id);
  }, []);

  return (
    <div className="m-wall" ref={rootRef}>
      {COLS.map((col, ci) => (
        <div key={ci} className={`m-col m-col-${ci % 6}`}>
          {col.map((tok, i) => {
            const el = (
              <span
                key={i}
                data-w={tok.v}
                className={tok.hi ? "m-hi" : undefined}
              >
                {tok.v}{" "}
              </span>
            );
            // CTAs embedded mid-column in columns 3 and 7
            if (ci === 3 && i === Math.floor(col.length * 0.45)) {
              return (
                <span key={`c${i}`}>
                  <a
                    className="m-cta m-cta-primary"
                    href={tgUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    START ON TELEGRAM →
                  </a>{" "}
                  {el}
                </span>
              );
            }
            if (ci === 7 && i === Math.floor(col.length * 0.55)) {
              return (
                <span key={`c${i}`}>
                  <a className="m-cta" href="/login">
                    LOGIN TO DASHBOARD →
                  </a>{" "}
                  {el}
                </span>
              );
            }
            return el;
          })}
        </div>
      ))}
    </div>
  );
}
