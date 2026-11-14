import { createBrowserRouter, isRouteErrorResponse, Link, useRouteError } from "react-router";
import { Pages, pagesLoader } from "./app/pages/Pages";
import { Sheet, sheetLoader } from "./app/pages/Sheet";

function Oops() {
  const e = useRouteError();
  const missing = isRouteErrorResponse(e) && (e.status === 404 || e.status === 400);
  return (
    <main className="home">
      <h1>{missing ? "No such page" : "Something went wrong"}</h1>
      {missing && <p className="muted"><code>{decodeURI(location.pathname.replace(/^\/d\//, ""))}</code> isn't one of your pages. Add files from the list.</p>}
      <p><Link to="/">All pages</Link></p>
    </main>
  );
}

export const router = createBrowserRouter([
  { path: "/", element: <Pages />, loader: pagesLoader, errorElement: <Oops /> },
  // The loader runs once per visit; the session then keeps the page current over the event stream.
  { path: "/d/*", element: <Sheet />, loader: sheetLoader, errorElement: <Oops />, shouldRevalidate: ({ currentParams, nextParams }) => currentParams["*"] !== nextParams["*"] },
]);
