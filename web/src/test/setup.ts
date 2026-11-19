import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no ResizeObserver, which the charts use to follow the size of their box.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// The dashboard with its sidebar takes longer to appear on a busy PC than the default 1 s.
configure({ asyncUtilTimeout: 3000 });

afterEach(() => {
  cleanup();
  localStorage.clear();
});
