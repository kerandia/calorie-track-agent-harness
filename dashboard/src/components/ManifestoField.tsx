"use client";

import { useEffect, useRef } from "react";

// Physics-driven manifesto field (nell.ai spirit, real dynamics):
// every word is a rigid body with
//   1. a Hooke spring to its home slot in the typographic grid,
//   2. drag toward a superposed-wave wind field (this makes words approach),
//   3. Hertzian soft-contact repulsion between word boxes (F ∝ δ^1.5) —
//      the "magnetic field": they squeeze close but can never touch,
//   4. damping, semi-implicit Euler, spatial-hash neighbor search (O(n·k)).
// The pointer and the CTA buttons are Gaussian repulsors the text parts
// around. Canvas-rendered: 2-5k bodies at 60fps is not a DOM job.

const SENTENCES = [
  "You already know how to do this. You text.",
  "Telegram is the interface. This site is the record.",
  "No new app. No account form. Open the chat you already have.",
  "Two eggs and toast. That is a log entry.",
  "A photo of your plate is a log entry.",
  "A trip plan is a page, not a wall of chat.",
  "Say it like you'd say it to a friend.",
  "Sezar reads the plate, estimates the calories, writes it down.",
  "Wrong guess? Say so. It's a lentil waffle, not a rice cake.",
  "That was yesterday, not today. Moved. Both days corrected.",
  "A health profile is optional until a health question needs it.",
  "A weekend plan does not wait for your weight.",
  "Pages share one look. The model writes the content, not the design.",
  "A link is unlisted. Anyone holding it can open it.",
  "Nothing goes live until you approve it.",
  "Your month becomes a calendar. Green under goal, red over.",
  "The dashboard does not replace the conversation.",
  "Send /login in Telegram. The link comes back to you.",
  "It lives in the Telegram you already have open.",
  "Breakfast, ara ogun, dinner — logged in the time it takes to type it.",
  "Ask what you ate on Tuesday. It knows. You don't have to.",
  "Your data is yours, keyed to your Telegram identity, nobody else's feed.",
  "Email and other channels can come later. They are not the door today.",
  "One message. That's how it starts.",
  "Send a photo when words are lazy. Words when photos are.",
  "The best record is the one you never had to open an app to keep.",
];

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

// ── tuning ────────────────────────────────────────────────────────────────
const FONT =
  '11.5px ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';
const LINE_H = 21;
const COL_GAP = 28;
const PAD = 20;
const HY = 7; // half height of a word box
const MIN_GAP = 5; // px of clearance every pair must keep
const K_SPRING = 3.2; // home spring stiffness (s^-2)
const DAMP = 2.1; // velocity damping (s^-1)
const GAMMA = 1.5; // drag toward the wind field
const K_REP = 260; // Hertzian contact stiffness
const REP_CAP = 1200; // max contact acceleration (px/s^2)
const MOUSE_A = 1600; // pointer repulsor peak accel
const MOUSE_SIG = 85; // pointer repulsor falloff (px)
const MAX_V = 180;
const MAX_DISP = 120; // hard clamp on wander from home
const MAX_WORDS = 5200;
const CELL = 96; // spatial hash cell (≥ widest pair reach)

const BASE_COLOR = "#184f3d";
const HI_COLOR = "#4fae83";
const BG = "#03130e";

type Body = {
  word: string;
  hi: boolean;
  hx: number; // half width
  homeX: number;
  homeY: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
};

// wind: superposed transverse waves, three octaves (px/s)
function windX(x: number, y: number, t: number): number {
  return (
    11 * Math.sin(y * 0.0055 + t * 0.3) * Math.sin(x * 0.003 - t * 0.16) +
    6.5 * Math.sin(y * 0.015 - t * 0.44 + 1.2) +
    3.5 * Math.sin((x + y) * 0.010 + t * 0.62)
  );
}
function windY(x: number, y: number, t: number): number {
  return (
    9 * Math.cos(x * 0.005 - t * 0.26) * Math.sin(y * 0.0042 + t * 0.2 + 0.5) +
    5 * Math.sin(x * 0.013 + t * 0.5 + 2.0) +
    3 * Math.cos((x - y) * 0.011 - t * 0.42)
  );
}

export default function ManifestoField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let bodies: Body[] = [];
    let baseIdx: number[] = [];
    let hiIdx: number[] = [];
    let W = 0;
    let H = 0;
    const pointer = { x: -1e9, y: -1e9 };

    function layout() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas!.width = Math.floor(W * dpr);
      canvas!.height = Math.floor(H * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.font = FONT;
      ctx!.textBaseline = "middle";

      const rand = lcg(20260728);
      const colW = Math.min(300, W - PAD * 2);
      const spaceW = ctx!.measureText(" ").width || 7;
      bodies = [];
      baseIdx = [];
      hiIdx = [];

      let colX = PAD;
      while (colX + 60 < W - PAD && bodies.length < MAX_WORDS) {
        let y = 16;
        let cursor = 0;
        let pool: string[] = [];
        while (y < H - 8 && bodies.length < MAX_WORDS) {
          if (pool.length === 0) {
            pool = SENTENCES[Math.floor(rand() * SENTENCES.length)]!
              .toUpperCase()
              .split(" ");
          }
          const word = pool.shift()!;
          const w = ctx!.measureText(word).width;
          if (cursor > 0 && cursor + w > colW) {
            y += LINE_H;
            cursor = 0;
            if (y >= H - 8) {
              pool.unshift(word);
              break;
            }
          }
          const homeX = colX + cursor + w / 2;
          const homeY = y;
          const hi = rand() < 0.045;
          bodies.push({
            word,
            hi,
            hx: w / 2,
            homeX,
            homeY,
            x: homeX,
            y: homeY,
            vx: 0,
            vy: 0,
          });
          (hi ? hiIdx : baseIdx).push(bodies.length - 1);
          cursor += w + spaceW;
        }
        colX += colW + COL_GAP;
      }
    }

    // spatial hash rebuilt per step
    const grid = new Map<number, number[]>();
    const cellKey = (cx: number, cy: number) => cx * 8192 + cy;

    function step(dt: number, t: number) {
      grid.clear();
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i]!;
        const key = cellKey(Math.floor(b.x / CELL), Math.floor(b.y / CELL));
        const arr = grid.get(key);
        if (arr) arr.push(i);
        else grid.set(key, [i]);
      }

      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i]!;
        // spring home + wind drag
        let ax = -K_SPRING * (b.x - b.homeX) + GAMMA * (windX(b.x, b.y, t) - b.vx);
        let ay = -K_SPRING * (b.y - b.homeY) + GAMMA * (windY(b.x, b.y, t) - b.vy);

        // pointer repulsor (Gaussian falloff)
        {
          const dx = b.x - pointer.x;
          const dy = b.y - pointer.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < MOUSE_SIG * MOUSE_SIG * 16) {
            const d = Math.sqrt(d2) || 1;
            const a = MOUSE_A * Math.exp(-d2 / (2 * MOUSE_SIG * MOUSE_SIG));
            ax += (dx / d) * a;
            ay += (dy / d) * a;
          }
        }

        // pairwise soft-contact repulsion via neighbor cells (j > i)
        const cx = Math.floor(b.x / CELL);
        const cy = Math.floor(b.y / CELL);
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          for (let gy = cy - 1; gy <= cy + 1; gy++) {
            const cell = grid.get(cellKey(gx, gy));
            if (!cell) continue;
            for (const j of cell) {
              if (j <= i) continue;
              const o = bodies[j]!;
              const dx = o.x - b.x;
              const dy = o.y - b.y;
              const gapX = Math.abs(dx) - (b.hx + o.hx);
              const gapY = Math.abs(dy) - 2 * HY;
              const gap = Math.max(gapX, gapY);
              if (gap < MIN_GAP) {
                const pen = MIN_GAP - gap;
                const f = Math.min(K_REP * Math.pow(pen, 1.5), REP_CAP);
                if (gapX > gapY) {
                  const s = dx >= 0 ? 1 : -1;
                  ax -= f * s * 0.5;
                  o.vx += f * s * 0.5 * dt;
                } else {
                  const s = dy >= 0 ? 1 : -1;
                  ay -= f * s * 0.5;
                  o.vy += f * s * 0.5 * dt;
                }
              }
            }
          }
        }

        // integrate (semi-implicit Euler)
        b.vx += ax * dt;
        b.vy += ay * dt;
        const dampF = Math.max(0, 1 - DAMP * dt);
        b.vx *= dampF;
        b.vy *= dampF;
        const sp = Math.hypot(b.vx, b.vy);
        if (sp > MAX_V) {
          b.vx = (b.vx / sp) * MAX_V;
          b.vy = (b.vy / sp) * MAX_V;
        }
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        // safety clamp on wander
        if (b.x - b.homeX > MAX_DISP) b.x = b.homeX + MAX_DISP;
        else if (b.homeX - b.x > MAX_DISP) b.x = b.homeX - MAX_DISP;
        if (b.y - b.homeY > MAX_DISP) b.y = b.homeY + MAX_DISP;
        else if (b.homeY - b.y > MAX_DISP) b.y = b.homeY - MAX_DISP;
      }
    }

    function draw() {
      ctx!.fillStyle = BG;
      ctx!.fillRect(0, 0, W, H);
      ctx!.fillStyle = BASE_COLOR;
      for (const i of baseIdx) {
        const b = bodies[i]!;
        ctx!.fillText(b.word, b.x - b.hx, b.y);
      }
      ctx!.fillStyle = HI_COLOR;
      for (const i of hiIdx) {
        const b = bodies[i]!;
        ctx!.fillText(b.word, b.x - b.hx, b.y);
      }
    }

    layout();
    draw();

    let raf = 0;
    let last = performance.now();
    let t = 0;
    if (!reduced) {
      const loop = (now: number) => {
        const dt = Math.min((now - last) / 1000, 0.033);
        last = now;
        t += dt;
        step(dt, t);
        draw();
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }

    const onPointer = (e: PointerEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
    };
    const onLeave = () => {
      pointer.x = -1e9;
      pointer.y = -1e9;
    };
    let resizeTimer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        layout();
        if (reduced) draw();
      }, 150);
    };
    window.addEventListener("pointermove", onPointer);
    window.addEventListener("pointerdown", onPointer);
    document.addEventListener("pointerleave", onLeave);
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(resizeTimer);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return <canvas ref={canvasRef} className="m-canvas" aria-hidden="true" />;
}
