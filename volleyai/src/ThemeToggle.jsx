import { useTheme } from "./ThemeContext.jsx";
import "./ThemeToggle.css";

export default function ThemeToggle() {
    const { theme, toggleTheme } = useTheme();
    return (
        <button
            className="theme-toggle-btn"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label="Toggle dark/light mode"
        >
            {theme === "dark" ? "☀️" : "🌙"}
        </button>
    );
}
