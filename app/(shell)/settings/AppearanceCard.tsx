"use client";

import { useEffect, useState } from "react";
import { SectionHeader, Segmented } from "@/components/ui";
import { Card } from "@/components/ui/legacy";
import { getThemePref, getDensityPref, setThemePref, setDensityPref, THEME_EVENT, type ThemePref, type DensityPref } from "@/lib/client/theme";

export function AppearanceCard() {
  const [theme, setTheme] = useState<ThemePref>("system");
  const [density, setDensity] = useState<DensityPref>("auto");
  useEffect(() => {
    const sync = () => {
      setTheme(getThemePref());
      setDensity(getDensityPref());
    };
    sync();
    window.addEventListener(THEME_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(THEME_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return (
    <Card>
      <section aria-labelledby="appearance-h" className="min-w-0 space-y-3" id="appearance">
        <SectionHeader id="appearance-h" label="Appearance" />
        <p className="text-sm text-muted">Applies immediately on this device. System and Auto follow your device.</p>
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold">Theme</p>
          <Segmented<ThemePref>
            label="Theme"
            value={theme}
            onChange={setThemePref}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </div>
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold">Density</p>
          <div className="max-w-full [&>.k-seg]:max-w-full [&>.k-seg]:flex-wrap [&_.k-seg-i]:whitespace-nowrap">
            <Segmented<DensityPref>
              label="Density"
              value={density}
              onChange={setDensityPref}
              options={[
                { value: "auto", label: "Auto" },
                { value: "touch", label: "Touch" },
                { value: "comfortable", label: "Comfortable" },
                { value: "compact", label: "Compact" },
              ]}
            />
          </div>
        </div>
      </section>
    </Card>
  );
}
