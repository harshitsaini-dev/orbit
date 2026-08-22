import { useSyncExternalStore } from 'react';

/**
 * Whether a media query matches, as state.
 *
 * For the cases where CSS cannot do the job on its own - a control that should
 * be a row of tabs on a desk and a menu on a phone is two different controls,
 * not one control with different padding, and rendering both and hiding one
 * would put two labelled versions of the same thing in the accessibility tree.
 *
 * `useSyncExternalStore` rather than an effect and a state: the value is read
 * during render from the browser rather than written after paint, so nothing
 * flashes the wrong variant on the first frame.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    // Server-rendered HTML has no viewport to measure, so the desktop variant
    // is the safe assumption; Orbit has no SSR today, and this keeps the hook
    // honest if that changes.
    () => false,
  );
}

/** The width below which a phone layout is used. Matches the CSS breakpoints. */
export const PHONE = '(max-width: 40rem)';
