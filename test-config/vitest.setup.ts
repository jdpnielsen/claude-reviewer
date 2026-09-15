import '@testing-library/jest-dom/vitest';

// jsdom doesn't implement ResizeObserver, and it does no layout, so there are
// no resizes to report anyway. Components that observe an element (e.g.
// CollapsibleDescription re-measuring its clamp) would otherwise throw on
// mount. Tests that need a specific size drive it by stubbing the element's
// scrollHeight/clientHeight directly.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
