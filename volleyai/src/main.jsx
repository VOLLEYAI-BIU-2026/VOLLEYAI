import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { GoogleOAuthProvider } from "@react-oauth/google";
import App from "./App.jsx";
import "./index.css";
import { ThemeProvider } from "./ThemeContext.jsx";
import ThemeToggle from "./ThemeToggle.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID}>
    <ThemeProvider>
      <BrowserRouter>
        <App />
        <ThemeToggle />
      </BrowserRouter>
    </ThemeProvider>
  </GoogleOAuthProvider>
);