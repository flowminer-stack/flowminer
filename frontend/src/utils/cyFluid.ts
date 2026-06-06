/**
 * Shared Cytoscape options for fluid zoom/pan across every graph view.
 *
 * These are the settings that fixed the "stiff, zooms out, slow to zoom in"
 * complaint on the main process map; every graph in the app should spread
 * them into its `cytoscape({...})` call so the feel is consistent:
 *
 *   - wheelSensitivity 1.0  — cytoscape's calibrated default (0.3 was ~3x slower)
 *   - minZoom 0.15 / maxZoom 5 — room to zoom out on dense graphs and in to read
 *   - pixelRatio 'auto' — crisp text on HiDPI displays
 *
 * NOTE: we deliberately set BOTH `textureOnViewport` and `hideEdgesOnViewport`
 * to false. `textureOnViewport` snapshots only the visible region and blanks
 * anything you pan toward. `hideEdgesOnViewport` hides edges during viewport
 * gestures — but Cytoscape also treats a NODE DRAG as a viewport gesture, so it
 * made every edge vanish while you reposition a node. Keeping edges live during
 * drag matters more than the marginal raster saving (the smooth zoom feel comes
 * from wheelSensitivity / min-max zoom, not from edge hiding).
 *
 * Usage:  cytoscape({ container, elements, style, layout, ...FLUID_CY_OPTS })
 */
export const FLUID_CY_OPTS = {
  minZoom: 0.15,
  maxZoom: 5,
  wheelSensitivity: 1.0,
  pixelRatio: 'auto',
  textureOnViewport: false,
  hideEdgesOnViewport: false,
} as const;

/** Hide labels that would render smaller than this on screen (level-of-detail). */
export const MIN_ZOOMED_FONT_SIZE = 9;
