import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { router } from "./router";
import "./app/app.css";

const el = document.getElementById("root")!;
const app = <RouterProvider router={router} />;

// Keep the root across hot reloads so the page doesn't remount.
if (import.meta.hot) {
  (import.meta.hot.data.root ??= createRoot(el)).render(app);
} else {
  createRoot(el).render(app);
}
