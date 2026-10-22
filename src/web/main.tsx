import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { match, useLocation } from "./router";
import { Spinner, Toasts } from "./ui";

const Home = lazy(() => import("./pages/Home"));
const Login = lazy(() => import("./pages/Auth").then(m => ({ default: m.Login })));
const Signup = lazy(() => import("./pages/Auth").then(m => ({ default: m.Signup })));
const Forgot = lazy(() => import("./pages/Auth").then(m => ({ default: m.Forgot })));
const Reset = lazy(() => import("./pages/Auth").then(m => ({ default: m.Reset })));
const Verify = lazy(() => import("./pages/Auth").then(m => ({ default: m.Verify })));
const Invite = lazy(() => import("./pages/Auth").then(m => ({ default: m.Invite })));
const Settings = lazy(() => import("./pages/Settings"));
const PublicForm = lazy(() => import("./pages/PublicForm"));
const BasePage = lazy(() => import("./base/BasePage"));

function App() {
  const path = useLocation().split("?")[0];
  let page: React.ReactNode;
  let m: Record<string, string> | null;
  if ((m = match("/base/:baseId/dash/:dashId", path))) page = <BasePage key={m.baseId} baseId={m.baseId} dashboardId={m.dashId} />;
  else if ((m = match("/base/:baseId/automations/:autoId?", path))) page = <BasePage key={m.baseId} baseId={m.baseId} automations automationId={m.autoId} />;
  else if ((m = match("/base/:baseId/:tableId?/:viewId?", path))) page = <BasePage key={m.baseId} baseId={m.baseId} tableId={m.tableId} viewId={m.viewId} />;
  else if ((m = match("/form/:shareId", path))) page = <PublicForm shareId={m.shareId} />;
  else if ((m = match("/invite/:inviteId", path))) page = <Invite inviteId={m.inviteId} />;
  else if (match("/login", path)) page = <Login />;
  else if (match("/signup", path)) page = <Signup />;
  else if (match("/forgot", path)) page = <Forgot />;
  else if (match("/reset", path)) page = <Reset />;
  else if (match("/verify", path)) page = <Verify />;
  else if ((m = match("/settings/:tab?", path))) page = <Settings tab={m.tab ?? "account"} />;
  else page = <Home />;
  return (
    <>
      <Suspense fallback={<div className="center-page"><Spinner size={24} /></div>}>{page}</Suspense>
      <Toasts />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
