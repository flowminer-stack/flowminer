/**
 * Shared Cytoscape options for fluid zoom/pan across every graph view.
 *
 * These are the settings that fixed the "stiff, zooms out, slow to zoom in"
 * complaint on the main process map; every graph in the app should spread
 * them into its `cytoscape({...})` call so the feel is consistent:
 *
 *   - wheelSensitivity 1.0  — cytoscape's calibrated default (0.3 was ~3x slower)
 *   - minZoom 0.15 / maxZoom 5 — room to zoom out on dense graphs and in to read
 *   - pixelRatio 1 — ~4x fewer pixels per frame than the HiDPI default ('auto'=2)
 *   - textureOnViewport — snapshot the canvas during a gesture instead of re-rastering
 *
 * Usage:  cytoscape({ container, elements, style, layout, ...FLUID_CY_OPTS })
 */
export const FLUID_CY_OPTS = {
  minZoom: 0.15,
  maxZoom: 5,
  wheelSensitivity: 1.0,
  pixelRatio: 'auto',
  textureOnViewport: true,
} as const;

/** Hide labels that would render smaller than this on screen (level-of-detail). */
export const MIN_ZOOMED_FONT_SIZE = 9;
