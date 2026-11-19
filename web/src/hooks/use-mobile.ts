import { useEffect, useState } from 'react';

const MOBILE_BREAKPOINT = 768;

/** True below the `md` breakpoint, where the sidebar becomes a panel that slides in. */
export function useIsMobile(): boolean {
  const query = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;
  const [mobile, setMobile] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = () => setMobile(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return mobile;
}
