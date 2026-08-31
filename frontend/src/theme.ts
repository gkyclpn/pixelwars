import { useCallback, useState } from "react";

export type Theme = "dark" | "light";

const KEY = "pw_theme";

/** The bootstrap script in index.html sets data-theme before painting; we read it here. */
export function getTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode — silently skip */
  }
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => getTheme());
  const toggle = useCallback(() => {
    setTheme((cur) => {
      const next = cur === "dark" ? "light" : "dark";
      applyTheme(next);
      return next;
    });
  }, []);
  return [theme, toggle];
}

/**
 * Pixi canvas can't read CSS variables — it needs a theme-based JS palette.
 * The theme is added to CanvasStage's dataKey so toggling causes a redraw within the 200ms tick.
 */
export function canvasPalette() {
  const light = getTheme() === "light";
  return {
    bg: light ? 0xe9ebf4 : 0x080a11,
    frame: light ? 0xfbfcff : 0x0e1119,
    frameBorder: light ? 0x6a3df0 : 0x7c5cff,
    gridLine: light ? 0xd9deed : 0x1f2432,
    emptyDot: light ? 0xc6cddf : 0x2a3042,
    hover: light ? 0x6a3df0 : 0x8b6cff,
    select: light ? 0x6a3df0 : 0x9d7bff,
    mine: light ? 0x16a34a : 0x4ade80,
    gold: 0xffd166,
    goldGlow: 0xffb930,
    kol: 0xb45cff,
    pending: 0x22d3ee,
  };
}

/** Owned-cell colors — a saturated palette that stays readable in both themes. */
export function ownedColor(mult: number, isGold: boolean): number {
  if (isGold) return 0xffc93c;
  if (mult >= 512) return 0xff2d95;
  if (mult >= 128) return 0xff5470;
  if (mult >= 32) return 0xff8c42;
  if (mult >= 8) return 0xffa94d;
  if (mult >= 2) return 0x8b5cf6;
  return 0x6a7cff;
}
