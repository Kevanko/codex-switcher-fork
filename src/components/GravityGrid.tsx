import { useEffect, useRef } from "react";

// Warping grid background. Grid vertices are pulled toward the cursor (gravity
// well); the pull eases in/out smoothly with `intensity` (no abrupt snap when the
// pointer enters/leaves), the centre gently wobbles so the grid never freezes
// while idle, and edges twinkle + brighten toward the accent near the cursor.

const CELL = 28; // grid cell size (px)
const SIGMA = 240; // soft falloff width (px) — no hard edge
const FALLOFF = 2.0; // >1 keeps the centre punchy and the outer grid gentle
const STRENGTH = 0.92; // max fraction a vertex collapses toward the cursor
const SWIRL = 0.85; // vortex twist (radians-ish), peaks mid-field
const EASE = 0.16; // per-vertex smoothing (gooey)
const INTENSITY_EASE = 0.05; // smooth fade of the whole effect in / out
const WOBBLE = 4; // idle wobble radius (px) so it never sits perfectly still
const WOBBLE_SPEED = 0.0006; // idle wobble speed
const TRAIL_DECAY = 0.965; // per-frame brightness decay once cursor moves on (~1.3s afterglow)
const EDGE = 3; // treat the cursor as "leaving" within this many px of any edge
const MARGIN = CELL * 4; // overscan so warped edges never reveal a boundary

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  return m
    ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
    : [59, 130, 246];
}

export function GravityGrid({ theme, accent }: { theme: string; accent: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const line = theme === "light" ? [38, 52, 74] : [140, 154, 176];
    const acc = hexToRgb(accent);
    const baseAlpha = theme === "light" ? 0.05 : 0.055;

    let cols = 0, rows = 0, W = 0, H = 0;
    let topH = 56; // bottom of the draggable topbar — a dead zone for the effect
    let ox = new Float32Array(0), oy = new Float32Array(0);
    let cx = new Float32Array(0), cy = new Float32Array(0);
    let ph = new Float32Array(0), br = new Float32Array(0);
    const mouse = { x: W / 2, y: H / 2 };
    let active = false; // pointer present & inside
    let intensity = 0; // eased 0..1
    let raf = 0;
    let running = false; // is the RAF loop currently scheduled?

    const build = () => {
      W = window.innerWidth; H = window.innerHeight;
      topH = Math.round(document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 56);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil((W + 2 * MARGIN) / CELL) + 1;
      rows = Math.ceil((H + 2 * MARGIN) / CELL) + 1;
      const n = cols * rows;
      ox = new Float32Array(n); oy = new Float32Array(n);
      cx = new Float32Array(n); cy = new Float32Array(n);
      ph = new Float32Array(n); br = new Float32Array(n);
      for (let r = 0, i = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++, i++) {
          ox[i] = -MARGIN + c * CELL; oy[i] = -MARGIN + r * CELL;
          cx[i] = ox[i]; cy[i] = oy[i];
          ph[i] = Math.random() * Math.PI * 2;
        }
      }
    };

    // Edges are bucketed by quantized colour + alpha so the whole grid draws in a
    // few dozen stroke() calls instead of one per segment (~7500/frame) — the main
    // cost win while the cursor moves. The quantization is invisible at these low
    // alphas. ponytail: 24×10 buckets is plenty; bump only if banding ever shows.
    const ALPHA_BUCKETS = 24;
    const COLOR_BUCKETS = 10;
    const NUM_BUCKETS = ALPHA_BUCKETS * COLOR_BUCKETS;

    const draw = (t: number) => {
      intensity += ((active ? 1 : 0) - intensity) * INTENSITY_EASE;
      // Idle wobble so the funnel keeps gently moving when the cursor is still.
      const mx = mouse.x + Math.cos(t * WOBBLE_SPEED) * WOBBLE * intensity;
      const my = mouse.y + Math.sin(t * WOBBLE_SPEED) * WOBBLE * intensity;

      ctx.clearRect(0, 0, W, H);
      const s2 = SIGMA * SIGMA;
      let maxBr = 0; // brightest edge this frame — drives idle-sleep detection
      for (let i = 0; i < ox.length; i++) {
        const dx = mx - ox[i], dy = my - oy[i];
        const f = 1 / (1 + (dx * dx + dy * dy) / s2);
        const k = Math.pow(f, FALLOFF) * STRENGTH * intensity; // fades in/out smoothly
        const rx = dx * k, ry = dy * k;
        const ang = f * (1 - f) * SWIRL * intensity;
        const cs = Math.cos(ang), sn = Math.sin(ang);
        const tx = ox[i] + rx * cs - ry * sn;
        const ty = oy[i] + rx * sn + ry * cs;
        cx[i] += (tx - cx[i]) * EASE;
        cy[i] += (ty - cy[i]) * EASE;
        // Afterglow: jump up instantly with the cursor, but only ever decay
        // slowly — leaves a trail of recently-touched edges that fades over time.
        const target = f * intensity;
        br[i] = target > br[i] ? target : br[i] * TRAIL_DECAY;
        if (br[i] > maxBr) maxBr = br[i];
      }
      ctx.lineWidth = 1;
      // Collect every segment into its colour+alpha bucket...
      const buckets: (Path2D | null)[] = new Array(NUM_BUCKETS).fill(null);
      const addSeg = (a: number, b: number) => {
        const prox = (br[a] + br[b]) * 0.5;
        const m = prox * prox; // color mix stays tight around the actual cursor
        const tw = reduce ? 0.5 : 0.5 + 0.5 * Math.sin(t * 0.0011 + ph[a] + ph[b]);
        // Glow uses `prox` linearly (not squared) so the decaying afterglow trail
        // stays visibly brighter for longer instead of vanishing almost instantly.
        const alpha = Math.min(0.6, baseAlpha + tw * 0.05 + prox * 0.55);
        let ai = (alpha / 0.6 * ALPHA_BUCKETS) | 0;
        if (ai >= ALPHA_BUCKETS) ai = ALPHA_BUCKETS - 1;
        let mi = (m * (COLOR_BUCKETS - 1) + 0.5) | 0;
        if (mi >= COLOR_BUCKETS) mi = COLOR_BUCKETS - 1;
        const key = mi * ALPHA_BUCKETS + ai;
        let path = buckets[key];
        if (!path) { path = new Path2D(); buckets[key] = path; }
        path.moveTo(cx[a], cy[a]);
        path.lineTo(cx[b], cy[b]);
      };
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          if (c < cols - 1) addSeg(i, i + 1);
          if (r < rows - 1) addSeg(i, i + cols);
        }
      }
      // ...then stroke each non-empty bucket once with its representative style.
      for (let key = 0; key < NUM_BUCKETS; key++) {
        const path = buckets[key];
        if (!path) continue;
        const mi = (key / ALPHA_BUCKETS) | 0;
        const ai = key % ALPHA_BUCKETS;
        const m = COLOR_BUCKETS > 1 ? mi / (COLOR_BUCKETS - 1) : 0;
        const alpha = (ai + 0.5) / ALPHA_BUCKETS * 0.6;
        const cr = Math.round(line[0] + (acc[0] - line[0]) * m);
        const cg = Math.round(line[1] + (acc[1] - line[1]) * m);
        const cb = Math.round(line[2] + (acc[2] - line[2]) * m);
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},${alpha})`;
        ctx.stroke(path);
      }
      // Stop looping once the scene has fully settled (no cursor, intensity and
      // afterglow both faded to nothing) or the window is hidden — this is what
      // kills the idle/background CPU cost. onMove / visibility wake it back up.
      const settled = !active && intensity < 0.001 && maxBr < 0.001;
      if (reduce || settled || document.hidden) {
        running = false;
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(draw);
    };

    // Wake (or keep) the loop running. No-op if already scheduled or hidden.
    const schedule = () => {
      if (running || reduce || document.hidden) return;
      running = true;
      raf = requestAnimationFrame(draw);
    };
    const stop = () => {
      running = false;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    };

    // Active only while the pointer is well inside the window — moving toward any
    // edge starts the smooth relax even if the leave event is swallowed by the
    // draggable topbar.
    const onMove = (e: MouseEvent) => {
      mouse.x = e.clientX; mouse.y = e.clientY;
      // The draggable topbar is a dead zone: hovering it counts as "cursor gone"
      // (no warp), same as leaving the window. Edges also relax the effect.
      active =
        e.clientX > EDGE && e.clientX < window.innerWidth - EDGE &&
        e.clientY > topH && e.clientY < window.innerHeight - EDGE;
      schedule(); // wake the loop if it had settled to sleep
    };
    const onLeave = () => { active = false; };
    const onOut = (e: MouseEvent) => { if (!e.relatedTarget) active = false; };
    const onResize = () => { build(); if (reduce) draw(0); else schedule(); };
    // Minimised / background / other-tab: pause entirely (the real CPU win).
    const onVisibility = () => { if (document.hidden) stop(); else schedule(); };

    build();
    if (reduce) draw(0); else schedule();
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("mouseout", onOut);
    document.addEventListener("mouseleave", onLeave);
    window.addEventListener("blur", onLeave);
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseout", onOut);
      document.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("blur", onLeave);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [theme, accent]);

  return <canvas ref={ref} className="bg-fx" aria-hidden="true" />;
}
