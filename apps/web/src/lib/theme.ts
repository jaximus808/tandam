import { useEffect, useState } from "react";

// The user's theme preference. "system" follows the OS (prefers-color-scheme);
// "light"/"dark" force a mode and persist across reloads. The boot script in
// index.html applies the initial `.dark` class before first paint using the
// same localStorage key, so this hook only has to keep it in sync afterward.
export type ThemePref = "light" | "dark" | "system";

const STORAGE_KEY = "tandem.theme";
// Fired whenever the preference changes so every mounted toggle (e.g. the header
// account menu AND the settings page, both visible on /me) stays in agreement —
// same-tab, so we can't rely on the `storage` event, which only fires cross-tab.
const THEME_EVENT = "tandem:themechange";

function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "system";
}

// Whether a given preference resolves to dark right now (system → OS).
export function isDark(pref: ThemePref): boolean {
  return pref === "dark" || (pref === "system" && prefersDark());
}

// Apply the preference to the document (<html class="dark">) and persist it.
export function applyThemePref(pref: ThemePref) {
  document.documentElement.classList.toggle("dark", isDark(pref));
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent<ThemePref>(THEME_EVENT, { detail: pref }));
  } catch {
    /* ignore */
  }
}

// useTheme exposes the current preference and a setter. It also re-applies when
// the OS theme changes while the preference is "system", so a canvas left open
// follows the user's day/night switch without a reload.
export function useTheme(): { pref: ThemePref; setPref: (p: ThemePref) => void } {
  const [pref, setPrefState] = useState<ThemePref>(readThemePref);

  function setPref(p: ThemePref) {
    setPrefState(p);
    applyThemePref(p);
  }

  // Sync this instance when the preference is changed by any other toggle.
  useEffect(() => {
    const onChange = (e: Event) => {
      const p = (e as CustomEvent<ThemePref>).detail;
      if (p === "light" || p === "dark" || p === "system") setPrefState(p);
    };
    window.addEventListener(THEME_EVENT, onChange);
    return () => window.removeEventListener(THEME_EVENT, onChange);
  }, []);

  useEffect(() => {
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyThemePref("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  return { pref, setPref };
}
