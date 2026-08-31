import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export type SheetSnap = "peek" | "half" | "full";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /**
   * Peek height (px). When set, the lowest snap stage is peek (the canvas stays
   * visible/interactive above it).
   */
  peekHeight?: number;
  /**
   * Middle-stage height (px). When set, there are three stages: peek ↔ half ↔ full.
   * The actual height is capped at 62% of the viewport.
   */
  halfHeight?: number;
  /** Snap stage on open (default: peek if provided, otherwise full) */
  initialSnap?: SheetSnap;
  /**
   * When set, ignore `initialSnap` and open at the smallest stage that shows the
   * ENTIRE content (measured natural height), so the last component — e.g. the
   * Buy button — is visible without the user dragging the sheet up.
   */
  fitContent?: boolean;
  /** Fires when the snap stage changes (including after a drag) */
  onSnapChange?: (snap: SheetSnap) => void;
  /** Accessibility label */
  label?: string;
  /** When set, a title row is shown under the handle (the close button sits inline here) */
  title?: string;
}

const TOP_VH = 0.07; // gap from the top when the sheet is fully open
// The half stage can fill up to this much of the viewport. Raisable: the pixel sheet
// uses a "half taller than the usual half" stage so an owned pixel's content (~510px)
// shows fully without opening fullscreen. Kept below (1 - TOP_VH) so "full" stays
// visually distinct (a bit more headroom at the top).
const HALF_MAX_VH = 0.85;
const CLOSE_VELOCITY = 0.45; // px/ms — a fast downward flick = step down one stage / close

/**
 * Mobile bottom-sheet. Draggable handle with springy snap stages (peek/half/full).
 * NO backdrop — in peek mode the canvas interaction stays open (the game flow is
 * never interrupted).
 */
export function Sheet({ open, onClose, children, peekHeight, halfHeight, initialSnap, fitContent, onSnapChange, label, title }: SheetProps) {
  const [mounted, setMounted] = useState(open);
  const [snap, setSnap] = useState<SheetSnap>("peek");
  const [ty, setTy] = useState(0); // px translateY (0 = full)
  const [dragging, setDragging] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; baseTy: number; lastY: number; lastT: number; vy: number } | null>(null);
  const snapCbRef = useRef(onSnapChange);
  snapCbRef.current = onSnapChange;
  // During the 320ms close-out the parent has already cleared its own state (e.g.
  // `selected` → null), so `children` now render an empty placeholder. Freeze the
  // last full content so the slide-down shows the real panel, not a flash of the
  // empty state.
  const [frozen, setFrozen] = useState<ReactNode>(null);
  // Capture a snapshot of the live content ONLY when the sheet transitions to open.
  // It must NOT re-run on every children identity change: parents hand a fresh JSX
  // element on each render (e.g. the pixel panel re-renders while `busy` toggles), so
  // `[open, children]` here would setState with a new reference every render while open
  // → re-render → new children → setState → "Maximum update depth exceeded". Freezing
  // once on open is enough: `frozen` is only ever READ during the close-out slide-down,
  // and `{frozen || children}` shows the live panel while open.
  useEffect(() => {
    if (open) setFrozen(children);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // dvh = dynamic viewport height: the real visible area that shrinks when the
  // mobile browser toolbar is shown — matches the CSS .sheet height: 93dvh.
  // useCallback ([]) so these are stable references — a fresh fn identity every
  // render would re-trigger any effect that closes over it each render.
  const vh = useCallback(() => window.visualViewport?.height ?? window.innerHeight, []);
  const sheetH = useCallback(() => vh() * (1 - TOP_VH), [vh]);
  const closedTy = useCallback(() => vh(), [vh]);

  /** Stage → translateY points (smaller ty = more open) */
  const points = useCallback((): Array<{ snap: SheetSnap; ty: number }> => {
    const pts: Array<{ snap: SheetSnap; ty: number }> = [{ snap: "full", ty: 0 }];
    if (halfHeight) pts.push({ snap: "half", ty: sheetH() - Math.min(halfHeight, vh() * HALF_MAX_VH) });
    if (peekHeight) pts.push({ snap: "peek", ty: sheetH() - peekHeight });
    return pts;
  }, [halfHeight, peekHeight]);

  const tyOf = useCallback((s: SheetSnap) => points().find((p) => p.snap === s)?.ty ?? 0, [points]);

  const startSnap = useCallback((): SheetSnap => {
    if (initialSnap === "half" && halfHeight) return "half";
    if (initialSnap === "full") return "full";
    return peekHeight ? "peek" : "full";
  }, [initialSnap, halfHeight, peekHeight]);

  // Open/close animations
  useEffect(() => {
    if (open) {
      setMounted(true);
      // Stage every target through "full" so the body is measured unconstrained
      // (peek hides .peek-hide, which would shrink the natural height).
      setSnap("full");
      setTy(closedTy());
      const raf = requestAnimationFrame(() => {
        const target = fitContent ? pickSnap(naturalContentHeight()) : startSnap();
        setSnap(target);
        snapCbRef.current?.(target);
        // Move to the target a frame after mount so the CSS transition kicks in
        requestAnimationFrame(() => setTy(tyOf(target)));
      });
      return () => cancelAnimationFrame(raf);
    }
    if (mounted) {
      // Slide down over the 0.32s transition, then unmount. The fitContent
      // ResizeObserver must not fight this: when the body collapses during the
      // close it re-fires and would snap ty back to the half point (the "stuck a
      // beat, then vanishes" hitch) — see the openRef guard in the RO effect.
      requestAnimationFrame(() => setTy(closedTy()));
      const t = setTimeout(() => setMounted(false), 330);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** Smallest stage whose visible height fits the full content — but never fullscreen. */
  const pickSnap = (contentHeight: number): SheetSnap => {
    if (contentHeight <= 0) return halfHeight ? "half" : "full"; // measurement failed
    if (peekHeight && contentHeight <= peekHeight) return "peek";
    // Never escalate to "full" just to fit content — a pixel sheet that overflows the
    // half stage should open a bit taller, not fill the screen. The half stage gets its
    // extra room from the taller halfHeight + a higher HALF_MAX_VH. If content still
    // overflows, the body's maxHeight turns the surplus into a short scroll rather than
    // the sheet jumping to full.
    return halfHeight ? "half" : "full";
  };

  /**
   * Total natural height of the sheet's content. The body is `flex:1` so its
   * offsetHeight is whatever space is available — NOT what the content needs.
   * Measure instead the auto-height chrome (handle / head / close button) plus the
   * body's content (top padding + bottom of the tallest child + bottom padding).
   */
  const naturalContentHeight = (): number => {
    const sheet = sheetRef.current;
    const body = bodyRef.current;
    if (!sheet || !body) return 0;
    let chrome = 0;
    let bodyContent = 0;
    for (const child of Array.from(sheet.children)) {
      if (child === body) {
        const cs = getComputedStyle(body);
        const padTop = parseFloat(cs.paddingTop) || 0;
        const padBottom = parseFloat(cs.paddingBottom) || 0;
        let maxBottom = 0;
        for (const c of Array.from(body.children)) {
          const el = c as HTMLElement;
          maxBottom = Math.max(maxBottom, el.offsetTop + el.offsetHeight);
        }
        bodyContent = padTop + maxBottom + padBottom;
      } else {
        chrome += (child as HTMLElement).offsetHeight;
      }
    }
    return chrome + bodyContent;
  };

  // Refetch the snap points when the viewport resizes
  useEffect(() => {
    if (!mounted) return;
    const onResize = () => setTy(tyOf(snap));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [mounted, snap, tyOf]);

  /**
   * Cap the body's height to the VISIBLE region of the sheet. The .sheet element is a
   * fixed 93vh tall and translateY only slides it — so flex:1 would otherwise leave the
   * body ~full height at every snap, hiding off-screen content with no scrollbar. Instead,
   * size the body to (visible sheet height − unchanging chrome: handle + optional head),
   * which both clips content into the visible area AND lets overflow-y:auto scroll it.
   *
   * Deps are ONLY [mounted, ty]: any extra identity (e.g. a fresh function) would rerun
   * this on every parent render. In a live feed the parent re-renders on each SSE event —
   * an effect+cleanup that resets maxHeight("") then re-applies it thrashes layout and
   * yanks a bottom-scrolled feed back toward the middle. We set the height once per ty and
   * never touch it again until ty actually changes.
   */
  useEffect(() => {
    const body = bodyRef.current;
    const sheet = sheetRef.current;
    if (!body || !sheet || !mounted) return;
    const constrain = () => {
      let c = 0;
      for (const ch of Array.from(sheet.children)) if (ch !== body) c += (ch as HTMLElement).offsetHeight;
      body.style.maxHeight = Math.max(0, sheetH() - ty - c) + "px";
    };
    constrain();
  }, [mounted, ty]);

  // In fitContent mode, content (e.g. async pixel info) may land after the first
  // measurement. Re-fit once the body settles so the last component stays visible.
  const fitRef = useRef(fitContent);
  fitRef.current = fitContent;
  // When `open` flips false the close slide-down collapses the body (maxHeight→0),
  // which fires this ResizeObserver; its re-fit would then re-open the sheet to the
  // half position and freeze the close — the "stuck a beat, then vanishes" hitch.
  // Gate the re-fit off `open` so it never fights the close anim.
  const openRef = useRef(open);
  openRef.current = open;
  // The RO callback closes over mount-time state (snap/ty aren't in its deps), so it
  // must read the LIVE values through refs. Without this, a re-fit decision made from
  // a STALE snap could overwrite a manual drag or an open-anim stage every resize.
  const snapRef = useRef(open ? "full" : "peek");
  snapRef.current = snap;
  const tyRef = useRef(0);
  tyRef.current = ty;
  useEffect(() => {
    if (!mounted || !fitRef.current) return;
    const ro = new ResizeObserver(() => {
      if (!openRef.current) return; // closing — stop re-fitting, let the slide-down run
      // Converge, don't fight: only re-snap when the content genuinely outgrows what
      // the current stage shows. `naturalContentHeight()` is measured from a body whose
      // maxHeight the sibling effect restyles on every `ty` change — unconditionally
      // re-applying setSnap/setTy here re-sizes the body, which re-fires the RO with a
      // shifted measurement, which can ping-pong between two snap points until React
      // throws "Maximum update depth exceeded". Bail when nothing meaningfully changed.
      const target = pickSnap(naturalContentHeight());
      const targetTy = tyOf(target);
      // Converge, don't fight: if the sheet is already AT the fitted stage+position,
      // stay silent — no setState, no layout change, so the RO stops re-firing. The
      // bail must check BOTH snap and ty: applying only one could leave the transform
      // mid-flight and the RO would restart on the next resize.
      if (snapRef.current === target && tyRef.current === targetTy) return;
      setSnap((prev) => {
        if (prev !== target) snapCbRef.current?.(target);
        return target;
      });
      // Clear the drag direction so a re-fit during a drag doesn't fight the pointer.
      drag.current = null;
      setTy(targetTy);
    });
    ro.observe(bodyRef.current as Element);
    return () => ro.disconnect();
  }, [mounted, tyOf]);

  const snapTo = useCallback((target: SheetSnap | "closed") => {
    if (target === "closed") { onClose(); return; }
    setSnap(target);
    setTy(tyOf(target));
    snapCbRef.current?.(target);
  }, [onClose, tyOf]);

  const onPointerDown = (e: React.PointerEvent) => {
    const el = sheetRef.current;
    if (!el) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, baseTy: ty, lastY: e.clientY, lastT: performance.now(), vy: 0 };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const now = performance.now();
    const dt = Math.max(1, now - d.lastT);
    d.vy = (e.clientY - d.lastY) / dt;
    d.lastY = e.clientY;
    d.lastT = now;
    const next = Math.max(-24, Math.min(closedTy(), d.baseTy + (e.clientY - d.startY)));
    setTy(next);
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d) return;
    const order = points().sort((a, b) => a.ty - b.ty); // full → half → peek
    const idx = order.findIndex((p) => p.snap === snap);
    // Fast flick: direction decides — step down / up one stage
    if (d.vy > CLOSE_VELOCITY) {
      const lower = order[idx + 1];
      snapTo(lower ? lower.snap : "closed");
      return;
    }
    if (d.vy < -CLOSE_VELOCITY) {
      const higher = order[idx - 1];
      snapTo(higher ? higher.snap : "full");
      return;
    }
    // Close if dropped clearly below the lowest stage
    const lowest = order[order.length - 1];
    const closeMargin = lowest.snap === "full" ? sheetH() * 0.35 : 90;
    if (ty > lowest.ty + closeMargin) { snapTo("closed"); return; }
    // Otherwise snap to the nearest stage by position
    let best = order[0];
    for (const p of order) if (Math.abs(p.ty - ty) < Math.abs(best.ty - ty)) best = p;
    snapTo(best.snap);
  };

  if (!mounted) return null;

  return (
    <div
      ref={sheetRef}
      className={"sheet" + (dragging ? " dragging" : "")}
      data-snap={snap}
      role="dialog"
      aria-label={label}
      style={{ transform: `translateY(${ty}px)` }}
    >
      <div
        className="sheet-handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span className="sheet-grip" />
      </div>
      {title ? (
        <div className="sheet-head">
          <span className="sheet-title">{title}</span>
          <button className="sheet-close in-head" onClick={onClose} aria-label="Close">✕</button>
        </div>
      ) : (
        <button className="sheet-close" onClick={onClose} aria-label="Close">✕</button>
      )}
      <div className="sheet-body" ref={bodyRef}>{open ? children : (frozen || children)}</div>
    </div>
  );
}
