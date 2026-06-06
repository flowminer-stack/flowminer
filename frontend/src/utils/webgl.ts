/**
 * Cheap, cached WebGL availability probe.
 *
 * Process City renders with three.js/WebGL. On machines without a usable GPU
 * context (some remote desktops, locked-down VMs, headless browsers) creating
 * a WebGL context fails and three.js throws — leaving a black panel. Callers
 * use this to fall back to the 2D flow map instead.
 */
let cached: boolean | null = null;

export function isWebGLAvailable(): boolean {
  if (cached !== null) return cached;
  try {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl');
    cached = !!gl;
  } catch {
    cached = false;
  }
  return cached;
}
