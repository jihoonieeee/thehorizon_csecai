import "./style.css";
import { DashboardShell } from "./components/dashboard/DashboardShell.jsx";
import { Analytics } from "@vercel/analytics/react";

export default function App() {
  return (
    <>
      <DashboardShell />
      <Analytics />
    </>
  );
}
