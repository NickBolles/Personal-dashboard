"use client";

import { useEffect } from "react";

/** Minimum height difference (px) between the layout and the visual viewport that counts as an on-screen keyboard. */
const KEYBOARD_MIN_PX = 120;

/**
 * Keeps two things on <html> in sync with the on-screen keyboard while a page that has a composer is mounted:
 *  - `data-kb="open"` while a text field is focused and the keyboard covers part of the screen
 *    (CSS hides the phone bottom bar + orb and drops its padding then), and
 *  - `--kb-inset`: how much of the layout viewport the keyboard covers. With
 *    `interactive-widget=resizes-content` (Android Chrome) the layout viewport already shrinks and this
 *    stays 0; on browsers that only shrink the visual viewport (iOS Safari) it lifts the sticky composer.
 */
export function useKeyboardInset(onChange?: (open: boolean) => void) {
  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;
    let baseline = window.innerHeight;
    let width = window.innerWidth;
    let last: boolean | undefined;
    const editing = () => {
      const el = document.activeElement as HTMLElement | null;
      return (
        !!el &&
        (el.tagName === "TEXTAREA" ||
          (el.tagName === "INPUT" && !/^(button|checkbox|radio|file|submit|range|color)$/i.test((el as HTMLInputElement).type)) ||
          el.isContentEditable)
      );
    };
    const update = () => {
      if (window.innerWidth !== width) {
        // rotation / fold: reset the "no keyboard" height
        width = window.innerWidth;
        baseline = window.innerHeight;
      }
      if (!editing()) baseline = Math.max(window.innerHeight, vv?.height ?? 0);
      const visible = vv ? vv.height : window.innerHeight;
      // Keyboard = the visible area shrank well below the height we had without a focused field.
      const open = editing() && baseline - visible > KEYBOARD_MIN_PX;
      const inset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
      root.style.setProperty("--kb-inset", `${open ? Math.round(inset) : 0}px`);
      if (open) root.dataset.kb = "open";
      else delete root.dataset.kb;
      if (open !== last) {
        last = open;
        onChange?.(open);
      }
    };
    update();
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    document.addEventListener("focusin", update);
    const onOut = () => setTimeout(update, 50);
    document.addEventListener("focusout", onOut);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", onOut);
      root.style.removeProperty("--kb-inset");
      delete root.dataset.kb;
    };
  }, [onChange]);
}
