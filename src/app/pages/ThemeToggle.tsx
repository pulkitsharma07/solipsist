import { useEffect, useState } from "react";

/** The writer's choice, kept in this browser; none means the system's (`prefers-color-scheme`). */
const KEY = "solipsist.theme";
type Theme = "light" | "dark";

export function savedTheme(): Theme | null {
  try { const t = localStorage.getItem(KEY); return t === "light" || t === "dark" ? t : null; } catch { return null; }
}
const systemTheme = (): Theme => (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

/** Puts the saved choice on the page (`data-theme`, read by `tokens.css`) before it draws: called by `frontend.tsx`. */
export function applySavedTheme(): void {
  const t = savedTheme();
  if (t) document.documentElement.dataset.theme = t;
}

/**
 * Light or dark, top right beside the gear: shows a moon on a light page and a sun on a dark one, and switches to the
 * other. The first click turns the system's theme into a choice of the writer's, kept in this browser.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => savedTheme() ?? systemTheme());
  // Follow the system until the writer has chosen.
  useEffect(() => {
    if (savedTheme() || typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const f = () => { if (!savedTheme()) setTheme(mq.matches ? "dark" : "light"); };
    mq.addEventListener?.("change", f);
    return () => mq.removeEventListener?.("change", f);
  }, []);
  const flip = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(KEY, next); } catch { /* not kept */ }
    setTheme(next);
  };
  const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  return (
    <button type="button" className="btn btn-ghost theme-toggle" onClick={flip} aria-label={label} title={label}>
      {theme === "dark" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}
