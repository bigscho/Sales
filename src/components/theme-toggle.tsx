"use client";

import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("grassfed_theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = saved === "dark" || (!saved && prefersDark);
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("grassfed_theme", next ? "dark" : "light");
  };

  return (
    <button
      onClick={toggle}
      className="w-8 h-8 rounded-lg flex items-center justify-center text-sm hover:bg-[var(--muted)] transition-colors"
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {dark ? "☀️" : "🌙"}
    </button>
  );
}
