import "@testing-library/jest-dom";

// cmdk uses ResizeObserver internally; jsdom doesn't include it
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Radix UI uses pointer-capture APIs not available in jsdom
if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}
if (!HTMLElement.prototype.setPointerCapture) {
  HTMLElement.prototype.setPointerCapture = () => {};
}
if (!HTMLElement.prototype.releasePointerCapture) {
  HTMLElement.prototype.releasePointerCapture = () => {};
}

// Radix UI uses scrollIntoView in jsdom environments
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}
