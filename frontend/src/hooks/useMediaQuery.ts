import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener("change", onChange);
    onChange();
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Mobile-layout breakpoint — must match the breakpoint in index.css. */
export function useIsMobile(): boolean {
  // Below 1150px the desktop layout (side panels) cramps the board, so the
  // mobile layout (FAB + bottom-sheet) is used.
  return useMediaQuery("(max-width: 1150px)");
}
