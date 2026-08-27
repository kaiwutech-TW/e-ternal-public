import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyLocale } from "./i18n.ts";
import "./styles.css";

applyLocale();

createRoot(document.getElementById("root")!).render(<App />);
