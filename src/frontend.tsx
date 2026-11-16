import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { router } from "./router";
import "./app/app.css";
import { applySavedTheme } from "./app/pages/ThemeToggle";

// Light or dark as the writer chose it, before the first paint (`ThemeToggle`).
applySavedTheme();

// Tells the server someone has the app open, for as long as this window does (`server/presence.ts`): its terminal
// view shows the full dashboard only then. One per window, kept across hot reloads.
const w = window as typeof window & { __solipPresence?: EventSource };
w.__solipPresence ??= new EventSource("/api/presence");

const el = document.getElementById("root")!;
const app = <RouterProvider router={router} />;

// Keep the root across hot reloads so the page doesn't remount.
if (import.meta.hot) {
  (import.meta.hot.data.root ??= createRoot(el)).render(app);
} else {
  createRoot(el).render(app);
}
