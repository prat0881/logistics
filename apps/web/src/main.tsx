import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/api";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { App } from "./App";

// Self-hosted fonts (no runtime CDN). See src/styles/tokens.md.
// Body/UI — Inter
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
// Display — Space Grotesk (wordmark, H1s, step numbers only)
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
// Data — IBM Plex Mono (codes, weights, CBM, dims, dates; tabular numerals)
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
