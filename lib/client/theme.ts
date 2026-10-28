export type ThemePref = "system" | "dark" | "light";
export type DensityPref = "auto" | "touch" | "comfortable" | "compact";

export const THEME_KEY = "jarvis.theme";
export const DENSITY_KEY = "jarvis.density";
export const THEME_EVENT = "jarvis:appearance";

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function getThemePref(): ThemePref {
  return read<ThemePref>(THEME_KEY, ["system", "dark", "light"], "system");
}

export function getDensityPref(): DensityPref {
  return read<DensityPref>(DENSITY_KEY, ["auto", "touch", "comfortable", "compact"], "auto");
}

/** Mirrors the stored preferences onto <html data-theme / data-density>. "system"/"auto" remove the attribute. */
export function applyAppearance(root: HTMLElement = document.documentElement) {
  const theme = getThemePref();
  const density = getDensityPref();
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  if (density === "auto") root.removeAttribute("data-density");
  else root.setAttribute("data-density", density);
}

export function setThemePref(theme: ThemePref) {
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage blocked: still apply for this page */
  }
  applyAppearance();
  window.dispatchEvent(new Event(THEME_EVENT));
}

export function setDensityPref(density: DensityPref) {
  try {
    if (density === "auto") localStorage.removeItem(DENSITY_KEY);
    else localStorage.setItem(DENSITY_KEY, density);
  } catch {
    /* storage blocked */
  }
  applyAppearance();
  window.dispatchEvent(new Event(THEME_EVENT));
}
