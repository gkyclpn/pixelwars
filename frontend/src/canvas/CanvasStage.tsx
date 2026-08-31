import { useEffect, useRef } from "react";
import { Application, Color, Container, Graphics, Text, TextStyle } from "pixi.js";
import type { PixelState, BoardState, Kol } from "../types";
import { canvasPalette, getTheme, ownedColor } from "../theme";
import type { PendingIntent } from "../hooks/useBoard";

/**
 * Full-bleed game canvas with pan + pinch/wheel zoom.
 * - The board is drawn in world space with CELL units from the (0,0) corner; the
 *   camera `view` (x/y/scale) is applied to the world container. Zoom/pan needs no
 *   re-draw (transform only).
 * - Tap ≠ drag: separated by an 8px/500ms threshold; only a tap counts as a buy click.
 * - Hover tooltip is mouse-only.
 * - Label tier: emoji/badge drawn per effective cell px (no text when far away → perf).
 * - The "pw:fitview" window event fits the camera to the board (control dock button).
 *
 * Performance: the canvas is built only on mount (effect `[]`). Prop changes are read
 * via ref. Drawing is 3-layered: grid (size/theme), cells+labels (data/tier),
 * overlay (hover/selection/nuke — cheap, 200ms tick).
 */

interface Props {
  board: BoardState;
  cells: PixelState[];
  kols: Record<string, Kol>;
  myOwner?: string | null;
  onHover: (info: { x: number; y: number; screen: { x: number; y: number } } | null) => void;
  onClick: (x: number, y: number) => void;
  highlightNukeDrop?: { x: number; y: number; t: number } | null;
  selected?: { x: number; y: number } | null;
  pendingIntents?: Record<string, PendingIntent>;
}

const CELL = 64; // world unit / cell
// Text texture render resolution — since max zoom is fit*5, 4x is sharp enough
const TEXT_RES = 4;

// FOMO emoji ladder — gets "more fun" as the multiplier climbs. The ladder tops
// out at MULT_CAP(64) — reaching the cap and then being gasped once more turns the
// pixel golden (backend verify.ts: nextRaw > MULT_CAP → becomingGold). An empty
// pixel (mult=1) is always 🪙; decay (falling back to 1) also regresses the emoji to 🪙.
function fomoEmoji(mult: number, isGold: boolean): string {
  if (isGold) return "👑";
  if (mult >= 64) return "💎";
  if (mult >= 32) return "🚀";
  if (mult >= 16) return "🤑";
  if (mult >= 8) return "🔥";
  if (mult >= 2) return "💰";
  return "🪙";
}

export function CanvasStage({ board, cells, kols, myOwner, onHover, onClick, highlightNukeDrop, selected, pendingIntents }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const dataRef = useRef({ board, cells, kols, myOwner, highlightNukeDrop, selected, pendingIntents });
  dataRef.current = { board, cells, kols, myOwner, highlightNukeDrop, selected, pendingIntents };
  // Keep the latest callbacks in a ref — effect is mount-only, always use the current version.
  const propsRef = useRef({ onHover, onClick });
  propsRef.current = { onHover, onClick };
  // Points at the internal requestDraw (set during mount). Lets the effect below force
  // an immediate redraw on data change — background tabs throttle the 200ms poll, so we
  // can't wait for it. The pixi canvas redraws here, not the throttled timer.
  const redrawRef = useRef<null | (() => void)>(null);

  useEffect(() => {
    if (!redrawRef.current) return; // mount not ready yet
    redrawRef.current();
  }, [cells, board, kols]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const app = new Application();
    let disposed = false;
    let ro: ResizeObserver | null = null;

    (async () => {
      await app.init({
        resizeTo: host,
        backgroundColor: canvasPalette().bg,
        antialias: true,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
      });
      if (disposed) { app.destroy(); return; }
      host.appendChild(app.canvas);
      appRef.current = app;

      const world = new Container();
      app.stage.addChild(world);
      const gridG = new Graphics();
      world.addChild(gridG);
      const cellsG = new Graphics();
      world.addChild(cellsG);
      // Pulsing multiplier badges — separate layer: animates only the badge colors
      // without re-drawing the static cells every frame.
      const badgeG = new Graphics();
      world.addChild(badgeG);
      const labelsCont = new Container();
      world.addChild(labelsCont);
      const hoverG = new Graphics();
      world.addChild(hoverG);

      const canvas = app.canvas;
      canvas.style.touchAction = "none";
      canvas.style.display = "block";
      canvas.style.cursor = "crosshair";

      // ---- Kamera ----
      const view = { x: 0, y: 0, scale: 1, userZoomed: false };
      const boardPx = () => CELL * dataRef.current.board.size;

      // ---- Input state (must be defined BEFORE the first draw — drawOverlay reads hoverCell) ----
      let hoverCell: { x: number; y: number } | null = null;
      const pointers = new Map<number, { x: number; y: number }>();
      let dragging = false;
      let downPos: { x: number; y: number } | null = null;
      let downTime = 0;
      let pinchDist = 0;

      const applyView = () => {
        world.position.set(view.x, view.y);
        world.scale.set(view.scale);
      };

      // On desktop only the left column (leaderboard + live feed) counts in the fit
      // calculation. The pixel card (desktop) and sheet (mobile) open OVER the board
      // (overlay) — the board isn't shrunk or moved; it carries on unchanged when closed.
      const fitInsets = () => {
        const rect = canvas.getBoundingClientRect();
        const wide = rect.width > 1150;
        return {
          left: wide ? 326 : 0,
          right: wide ? 12 : 0,
          top: wide ? 56 : 46,
          bottom: wide ? 12 : 64,
        };
      };

      const fitScale = () => {
        const rect = canvas.getBoundingClientRect();
        const bp = boardPx();
        if (!bp) return 1;
        const ins = fitInsets();
        const availW = Math.max(120, rect.width - ins.left - ins.right);
        const availH = Math.max(120, rect.height - ins.top - ins.bottom);
        return (Math.min(availW, availH) * 0.94) / bp;
      };

      const fitView = () => {
        const rect = canvas.getBoundingClientRect();
        const bp = boardPx();
        if (!bp) return;
        const wide = rect.width > 1150;
        const ins = fitInsets();
        const availW = Math.max(120, rect.width - ins.left - ins.right);
        const availH = Math.max(120, rect.height - ins.top - ins.bottom);
        const s = (Math.min(availW, availH) * 0.94) / bp;
        view.scale = s;
        // Align the board horizontally to the exact center of the stage (same axis as
        // the board chip); if it's too narrow to clear the side panels, clip to the usable area.
        const bw = bp * s;
        const idealX = (rect.width - bw) / 2;
        const minX = ins.left;
        const maxX = rect.width - ins.right - bw;
        view.x = maxX < minX ? ins.left + (availW - bw) / 2 : Math.max(minX, Math.min(idealX, maxX));
        // On mobile the board sits at the top with breathing room below the chip; on desktop it's vertically centered.
        view.y = wide ? ins.top + (availH - bp * s) / 2 : ins.top + 16;
        view.userZoomed = false;
        applyView();
      };

      // Pan limit: at least 20% of the board always stays visible —
      // it's impossible to drag it off-screen.
      const clampView = () => {
        const rect = canvas.getBoundingClientRect();
        const bp = boardPx() * view.scale;
        view.x = Math.min(rect.width * 0.8, Math.max(rect.width * 0.2 - bp, view.x));
        view.y = Math.min(rect.height * 0.8, Math.max(rect.height * 0.2 - bp, view.y));
      };

      const zoomAt = (clientX: number, clientY: number, factor: number) => {
        const rect = canvas.getBoundingClientRect();
        const bp = boardPx();
        if (!bp) return;
        const px = clientX - rect.left;
        const py = clientY - rect.top;
        // Zoom limits: between 0.55x and 5x of fit (the board neither disappears nor grows too large)
        const fit = fitScale();
        const ns = Math.min(fit * 5, Math.max(fit * 0.55, view.scale * factor));
        if (ns === view.scale) return;
        const wx = (px - view.x) / view.scale;
        const wy = (py - view.y) / view.scale;
        view.scale = ns;
        view.x = px - wx * ns;
        view.y = py - wy * ns;
        view.userZoomed = true;
        clampView();
        applyView();
      };

      const onFitEvent = () => fitView();
      window.addEventListener("pw:fitview", onFitEvent);

      // ---- Drawing ----
      const labelTier = () => {
        const eff = CELL * view.scale;
        return eff >= 30 ? 2 : eff >= 20 ? 1 : 0;
      };

      const drawGrid = () => {
        const pal = canvasPalette();
        const bp = boardPx();
        const size = dataRef.current.board.size;
        gridG.clear();
        // Outer frame — rounded, thin neon-edged backdrop
        gridG.roundRect(-6, -6, bp + 12, bp + 12, 14)
          .fill(pal.frame)
          .stroke({ width: 2.5, color: pal.frameBorder, alpha: 0.55 });
        gridG.setStrokeStyle({ width: 1, color: pal.gridLine, alpha: 0.55 });
        for (let i = 1; i < size; i++) {
          gridG.moveTo(i * CELL, 0).lineTo(i * CELL, bp);
          gridG.moveTo(0, i * CELL).lineTo(bp, i * CELL);
        }
        gridG.stroke();
        // "Available" dot at empty cell centers — only on small boards
        // (1M circles on a big board would choke the GPU; also invisible when zoomed in).
        if (size <= 64) {
          const occupied = new Set(dataRef.current.cells.map((c) => c.x + "," + c.y));
          gridG.setFillStyle({ color: pal.emptyDot, alpha: 0.8 });
          for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
              if (occupied.has(x + "," + y)) continue;
              gridG.circle(x * CELL + CELL / 2, y * CELL + CELL / 2, CELL * 0.07);
            }
          }
          gridG.fill();
        }
      };

      // Emoji ink-center measuring: font line-box metrics shift per platform, so anchor
      // 0.5 alone can't center the glyph. The texture is actually rendered and the
      // bounding box of its alpha pixels is measured; the gap between the texture center
      // and the ink center is returned as a correction in world units.
      // Computed once per emoji (cached).
      const emojiOffsetCache = new Map<string, { dx: number; dy: number }>();
      const emojiOffset = (emoji: string, size: number): { dx: number; dy: number } => {
        const key = emoji + "@" + size;
        const hit = emojiOffsetCache.get(key);
        if (hit) return hit;
        let off = { dx: 0, dy: 0 };
        const probe = new Text({
          text: emoji,
          style: new TextStyle({ fontSize: size, lineHeight: size, fill: 0xffffff }),
          resolution: TEXT_RES,
        });
        try {
          const cv = app.renderer.extract.canvas(probe) as HTMLCanvasElement;
          const ctx = cv.getContext("2d");
          if (ctx && cv.width > 0 && cv.height > 0) {
            const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
            let minX = cv.width, minY = cv.height, maxX = -1, maxY = -1;
            for (let y = 0; y < cv.height; y++) {
              for (let x = 0; x < cv.width; x++) {
                if (img[(y * cv.width + x) * 4 + 3] > 8) {
                  if (x < minX) minX = x;
                  if (x > maxX) maxX = x;
                  if (y < minY) minY = y;
                  if (y > maxY) maxY = y;
                }
              }
            }
            if (maxX >= 0) {
              off = {
                dx: (0.5 - (minX + maxX) / 2 / cv.width) * probe.width,
                dy: (0.5 - (minY + maxY) / 2 / cv.height) * probe.height,
              };
            }
          }
        } catch { /* if measuring fails, continue without a correction */ }
        probe.destroy();
        emojiOffsetCache.set(key, off);
        return off;
      };

      // ---- Text pooling ------
      // Creating `new Text()` uploads a GPU texture per label (emoji / multiplier
      // badge / KOL avatar). drawCells re-runs on every dataKey change (the 200ms poll
      // + decay tick + scroll), so recreating those textures each time is constant GPU
      // churn — the cold-start snap at refresh and part of the scroll cost. Instead we
      // reuse Pixi Text instances per cell: mutating .text/.style in place re-textures
      // only when the string actually changes (and Pixi's texture cache reuses identical
      // strings). A cell with an unchanged emoji therefore costs ~zero on redraw.
      const textPool = new Map<string, { e: Text; m: Text | null; k: Text | null }>();
      const poolStyle = { resolution: TEXT_RES };

      const drawCells = () => {
        const pal = canvasPalette();
        const size = dataRef.current.board.size;
        const tier = labelTier();
        cellsG.clear();
        labelsCont.removeChildren();
        const cells = dataRef.current.cells;
        const kols = dataRef.current.kols;
        const my = dataRef.current.myOwner;
        const radius = CELL * 0.16;
        const seen = new Set<string>();

        for (const c of cells) {
          if (c.x >= size || c.y >= size) continue;
          const key = `${c.x},${c.y}`;
          seen.add(key);
          const px = c.x * CELL;
          const py = c.y * CELL;
          const col = ownedColor(c.mult, c.is_gold);
          // Soft glow behind high-multiplier / golden cells
          if (c.is_gold || c.mult >= 32) {
            cellsG.roundRect(px - 3, py - 3, CELL + 6, CELL + 6, radius + 4)
              .fill({ color: c.is_gold ? pal.goldGlow : col, alpha: 0.22 });
          }
          cellsG.roundRect(px + 3, py + 3, CELL - 6, CELL - 6, radius).fill({ color: col, alpha: 0.92 });
          if (c.is_gold) {
            cellsG.roundRect(px + 3, py + 3, CELL - 6, CELL - 6, radius).stroke({ width: 3, color: pal.gold });
          }
          // The user's own pixel — green border highlight
          if (my && c.owner === my) {
            cellsG.roundRect(px + 1.5, py + 1.5, CELL - 3, CELL - 3, radius + 1).stroke({ width: 3, color: pal.mine });
          }
          if (tier === 0) continue;
          // FOMO emoji: ink center aligned exactly to the cell center
          // (overlapping its badge is fine — user approval).
          const emojiSize = Math.floor(CELL * 0.42);
          const emoji = fomoEmoji(c.mult, c.is_gold);
          const slot = textPool.get(key) ?? { e: new Text({ text: "", ...poolStyle }), m: null, k: null };
          const e = slot.e;
          if (e.parent !== labelsCont) labelsCont.addChild(e);
          if (e.text !== emoji) {
            e.text = emoji;
            e.style = new TextStyle({ fontSize: emojiSize, lineHeight: emojiSize, fill: 0xffffff });
          }
          e.anchor.set(0.5);
          const eo = emojiOffset(emoji, emojiSize);
          e.x = px + CELL / 2 + eo.dx;
          e.y = py + CELL / 2 + eo.dy;
          if (tier < 2) continue;
          // Top right — multiplier badge (except golden pixels). The backdrop is drawn
          // animated in the badgeG layer; here only the readable text is produced.
          if (c.mult >= 2 && !c.is_gold) {
            const badgeR = CELL * 0.18;
            const bStr = `${c.mult}x`;
            const bt = slot.m ?? (slot.m = new Text({ text: "", ...poolStyle }));
            if (bt.parent !== labelsCont) labelsCont.addChild(bt);
            if (bt.text !== bStr) {
              bt.text = bStr;
              bt.style = new TextStyle({
                fontSize: Math.floor(badgeR * 1.05),
                fontWeight: "800",
                fill: 0xffffff,
                stroke: { color: 0x14082e, width: 2.5 },
              });
            }
            const bb = bt.getLocalBounds();
            bt.x = px + CELL - badgeR - 3 - (bb.x + bb.width / 2);
            bt.y = py + badgeR + 3 - (bb.y + bb.height / 2);
          } else if (slot.m) {
            slot.m.parent?.removeChild(slot.m);
          }
          // Top left — KOL avatar
          if (c.is_kol && c.owner && kols[c.owner]) {
            const k = kols[c.owner];
            const badgeR = CELL * 0.16;
            cellsG.circle(px + badgeR + 3, py + badgeR + 3, badgeR).fill(pal.kol);
            const label = (k.name || "?").slice(0, 1).toUpperCase();
            const kt = slot.k ?? (slot.k = new Text({ text: "", ...poolStyle }));
            if (kt.parent !== labelsCont) labelsCont.addChild(kt);
            if (kt.text !== label) {
              kt.text = label;
              kt.style = new TextStyle({ fontSize: Math.floor(badgeR * 1.05), fontWeight: "800", fill: 0xffffff });
            }
            const kb = kt.getLocalBounds();
            kt.x = px + badgeR + 3 - (kb.x + kb.width / 2);
            kt.y = py + badgeR + 3 - (kb.y + kb.height / 2);
          } else if (slot.k) {
            slot.k.parent?.removeChild(slot.k);
          }
          textPool.set(key, slot);
        }

        // Prune pooled Text objects for cells that no longer exist / fell out of size.
        for (const [key, slot] of textPool) {
          if (seen.has(key)) continue;
          for (const t of [slot.e, slot.m, slot.k]) t?.parent?.removeChild(t);
          textPool.delete(key);
        }
      };

      // ---- Pulsing multiplier badges in red tones (FOMO) ----
      // Theme-independent: the hue oscillates in the red band (±9°), brightness
      // pulses up and down — dark maroon ↔ warm red. Each badge has its own phase,
      // so they ripple rather than flashing all at once. Same colors in both themes.
      let badgePhase = 0;
      const hslNum = (h: number, s: number, l: number) =>
        new Color({ h: (h + 360) % 360, s, l }).toNumber();
      const drawBadges = () => {
        badgeG.clear();
        if (labelTier() < 2) return;
        const size = dataRef.current.board.size;
        const badgeR = CELL * 0.18;
        for (const c of dataRef.current.cells) {
          if (c.mult < 2 || c.is_gold || c.x >= size || c.y >= size) continue;
          const cx = c.x * CELL + CELL - badgeR - 3;
          const cy = c.y * CELL + badgeR + 3;
          const wave = Math.sin(badgePhase + (c.x * 7 + c.y * 13) * 0.55);
          const h = wave * 9; // red band: -9° (maroon) ↔ +9° (warm red)
          const l = 50 + wave * 11; // brightness pulse: 39–61%
          badgeG.circle(cx, cy, badgeR).fill(hslNum(h, 96, l));
          badgeG.circle(cx, cy, badgeR).stroke({ width: 1.5, color: hslNum(h + 5, 100, Math.min(l + 16, 70)), alpha: 0.95 });
        }
      };
      // 30fps is enough — advance the phase every other frame
      let badgeFrame = 0;
      app.ticker.add(() => {
        if (badgeFrame++ % 2) return;
        badgePhase = (badgePhase + 0.08) % (Math.PI * 2);
        drawBadges();
      });

      // Hover + selection + nuke flash overlay — cheap, produces no Text; can be drawn any time.
      const drawOverlay = () => {
        const pal = canvasPalette();
        const size = dataRef.current.board.size;
        hoverG.clear();
        const radius = CELL * 0.16;
        const now = Date.now();
        const hl = dataRef.current.highlightNukeDrop;
        if (hl && hl.x < size && hl.y < size && now - hl.t < 2000) {
          hoverG.roundRect(hl.x * CELL, hl.y * CELL, CELL, CELL, radius + 2)
            .stroke({ width: 4, color: pal.gold, alpha: 0.95 });
        }
        // Selected pixel — persistent frame while the panel/sheet is open.
        const sel = dataRef.current.selected;
        if (sel && sel.x < size && sel.y < size) {
          hoverG.roundRect(sel.x * CELL, sel.y * CELL, CELL, CELL, radius + 2)
            .stroke({ width: 3.5, color: pal.select, alpha: 1 });
        }
        if (hoverCell && hoverCell.x < size && hoverCell.y < size) {
          hoverG.roundRect(hoverCell.x * CELL, hoverCell.y * CELL, CELL, CELL, radius + 2)
            .stroke({ width: 2, color: pal.hover, alpha: 0.9 });
        }
        // Pixels locked by someone's in-flight purchase (intent locked → confirm/expiry).
        // Full-bleed tint + a pulsing stroke so every user sees it as "being bought".
        const pending = dataRef.current.pendingIntents;
        if (pending) {
          const pulse = 0.6 + 0.4 * Math.sin(now / 250);
          for (const key of Object.keys(pending)) {
            const px = pending[key];
            if (px.x < size && px.y < size) {
              hoverG.roundRect(px.x * CELL, px.y * CELL, CELL, CELL, radius)
                .fill({ color: pal.pending, alpha: 0.28 })
                .stroke({ width: 2.5, color: pal.pending, alpha: pulse });
            }
          }
        }
      };

      // Smooth 60fps overlay animation. The 200ms tick below is too slow for the pending
      // pulse / nuke flash (5fps → visibly jerky), so we also draw the overlay on the Pixi
      // ticker. It's nearly free when idle: when there's no live animation we skip the draw
      // and let the 200ms tick own static hover/selection redraws.
      const overlayFrame = () => {
        const now = Date.now();
        const hl = dataRef.current.highlightNukeDrop;
        const pending = dataRef.current.pendingIntents;
        const hasAnim = (pending && Object.keys(pending).length > 0) || (hl && now - hl.t < 2000);
        if (hasAnim) drawOverlay();
      };
      app.ticker.add(overlayFrame);

      // Lightweight key comparison to catch data changes.
      // Theme + label tier are also in the key — re-drawn on toggle/zoom threshold.
      // Was a whole-array `.map().join()` (a fresh giant string on every 200ms poll;
      // cold-start churn + the trigger that re-ran drawCells needlessly). Now a
      // single-pass FNV-1a hash: one number, no string allocation, catches the same
      // change set (owner affects the my-pixel border, so it's folded in too).
      const hashJoin = (...vals: (string | number)[]) => {
        let h = 0x811c9dc5;
        for (const v of vals) {
          const s = String(v);
          for (let i = 0; i < s.length; i++) h = (h ^ s.charCodeAt(i)) * 0x01000193;
        }
        return h >>> 0;
      };
      // Rolling hash over cells — order/position-sensitive, so a swap of two cells'
      // mults (same sum, different visuals) still changes the key. A commutative
      // addition would let such a swap slip through and skip a needed redraw.
      const dataKey = () => {
        const b = dataRef.current.board;
        const cs = dataRef.current.cells;
        let kn = 0;
        for (const k in dataRef.current.kols) kn = (kn + hashJoin(k)) >>> 0;
        const my = dataRef.current.myOwner ?? "";
        let ch = 0x811c9dc5;
        for (const c of cs) {
          const cell = hashJoin(c.x, c.y, c.mult, c.is_gold ? 1 : 0, c.is_kol ? 1 : 0, c.owner === my ? 1 : 0);
          ch = (ch * 0x01000193 + cell) >>> 0;
        }
        return `${getTheme()}|${labelTier()}|${b.size}|${b.level}|${kn}|${hashJoin(my)}|${ch}`;
      };

      // Initial: fit the camera + first draw
      fitView();
      let lastKey = dataKey();
      let lastSize = dataRef.current.board.size;
      drawGrid();
      drawCells();
      drawOverlay();

      // Re-draw the static layers when data/theme/tier changed.
      const requestDraw = () => {
        const sizeNow = dataRef.current.board.size;
        if (sizeNow !== lastSize) {
          lastSize = sizeNow;
          fitView(); // expansion → re-fit to the new board
        }
        const k = dataKey();
        if (k !== lastKey) {
          lastKey = k;
          app.renderer.background.color = canvasPalette().bg;
          drawGrid();
          drawCells();
        }
        drawOverlay();
      };

      // Expose so the component can force an immediate redraw on data change (see below).
      (app as any)._requestDraw = requestDraw;
      redrawRef.current = requestDraw;

      // The poll catches zoom/theme/tier changes. IMPORTANT: browsers throttle
      // setInterval hard in BACKGROUND tabs (down to 1/min), so a frozen canvas can't
      // rely on this timer to pick up new pixels — the component effect below drives
      // the immediate redraw for data changes instead. This poll is just the net for
      // non-data changes (theme toggle, zoom-tier label switch).
      const tickInterval = setInterval(requestDraw, 200);

      // ---- Input: tap/drag/pinch/wheel ----
      const toCell = (clientX: number, clientY: number) => {
        const rect = canvas.getBoundingClientRect();
        const size = dataRef.current.board.size;
        const wx = (clientX - rect.left - view.x) / view.scale;
        const wy = (clientY - rect.top - view.y) / view.scale;
        const cx = Math.floor(wx / CELL);
        const cy = Math.floor(wy / CELL);
        if (cx < 0 || cx >= size || cy < 0 || cy >= size) return null;
        return { x: cx, y: cy };
      };

      const clearHover = () => {
        if (hoverCell) {
          hoverCell = null;
          propsRef.current.onHover(null);
          drawOverlay();
        }
      };

      canvas.addEventListener("pointerdown", (ev) => {
        canvas.setPointerCapture(ev.pointerId);
        pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (pointers.size === 1) {
          downPos = { x: ev.clientX, y: ev.clientY };
          downTime = Date.now();
          dragging = false;
        } else if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
          dragging = true; // pinch cancels the tap
          clearHover();
        }
      });

      canvas.addEventListener("pointermove", (ev) => {
        // If not dragging: mouse hover only
        if (!pointers.has(ev.pointerId)) {
          if (ev.pointerType !== "mouse") return;
          const c = toCell(ev.clientX, ev.clientY);
          canvas.style.cursor = c ? "pointer" : "crosshair";
          const changed = c?.x !== hoverCell?.x || c?.y !== hoverCell?.y;
          hoverCell = c;
          if (changed) {
            propsRef.current.onHover(c ? { x: c.x, y: c.y, screen: { x: ev.clientX, y: ev.clientY } } : null);
            drawOverlay();
          } else if (c) {
            // Mouse moving within the same cell — keep the tooltip position updated
            propsRef.current.onHover({ x: c.x, y: c.y, screen: { x: ev.clientX, y: ev.clientY } });
          }
          return;
        }
        const prev = pointers.get(ev.pointerId)!;
        pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (pointers.size === 1 && downPos) {
          const dx = ev.clientX - downPos.x;
          const dy = ev.clientY - downPos.y;
          if (!dragging && Math.hypot(dx, dy) > 8) {
            dragging = true;
            canvas.style.cursor = "grabbing";
            clearHover();
          }
          if (dragging) {
            view.x += ev.clientX - prev.x;
            view.y += ev.clientY - prev.y;
            view.userZoomed = true;
            clampView();
            applyView();
          }
        } else if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (pinchDist > 0 && d > 0) {
            zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchDist);
          }
          pinchDist = d;
        }
      });

      const endPointer = (ev: PointerEvent) => {
        const wasTap =
          pointers.size === 1 && !dragging && downPos != null &&
          Date.now() - downTime < 500 &&
          Math.hypot(ev.clientX - downPos.x, ev.clientY - downPos.y) <= 8;
        pointers.delete(ev.pointerId);
        if (pointers.size < 2) pinchDist = 0;
        if (pointers.size === 0) {
          dragging = false;
          downPos = null;
          if (ev.pointerType === "mouse") {
            canvas.style.cursor = toCell(ev.clientX, ev.clientY) ? "pointer" : "crosshair";
          }
          if (wasTap) {
            const c = toCell(ev.clientX, ev.clientY);
            if (c) propsRef.current.onClick(c.x, c.y);
          }
        }
      };
      canvas.addEventListener("pointerup", endPointer);
      canvas.addEventListener("pointercancel", endPointer);
      canvas.addEventListener("pointerleave", () => {
        hoverCell = null;
        canvas.style.cursor = "crosshair";
        propsRef.current.onHover(null);
        drawOverlay();
      });

      canvas.addEventListener("wheel", (ev) => {
        ev.preventDefault();
        zoomAt(ev.clientX, ev.clientY, Math.pow(1.0016, -ev.deltaY));
      }, { passive: false });

      ro = new ResizeObserver(() => {
        if (!view.userZoomed) fitView();
      });
      ro.observe(host);

      (app as any)._cleanup = () => {
        clearInterval(tickInterval);
        app.ticker.remove(overlayFrame);
        window.removeEventListener("pw:fitview", onFitEvent);
        redrawRef.current = null;
      };
    })();

    return () => {
      disposed = true;
      ro?.disconnect();
      (appRef.current as any)?._cleanup?.();
      if (appRef.current) {
        appRef.current.destroy(true, { children: true });
        appRef.current = null;
      }
    };
  }, []);

  return <div className="stage" ref={hostRef} />;
}
