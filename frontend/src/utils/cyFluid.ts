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
 *   - hideEdgesOnViewport — drop only the (expensive) edges mid-gesture and snap
 *     them back on release; nodes stay live so you always see where you're panning.
 *
 * NOTE: we deliberately do NOT set `textureOnViewport`. It snapshots only the
 * currently-visible region into a bitmap and reuses it for the whole gesture, so
 * any area you pan *toward* falls outside the snapshot and renders blank until you
 * stop moving. `hideEdgesOnViewport` gives the same dense-graph perf win (edges are
 * ~90% of the raster cost) without ever blanking the canvas.
 *
 * Usage:  cytoscape({ container, elements, style, layout, ...FLUID_CY_OPTS })
 */
export const FLUID_CY_OPTS = {
  minZoom: 0.15,
  maxZoom: 5,
  wheelSensitivity: 1.0,
  pixelRatio: 'auto',
  textureOnViewport: false,
  hideEdgesOnViewport: true,
} as const;

/** Hide labels that would render smaller than this on screen (level-of-detail). */
export const MIN_ZOOMED_FONT_SIZE = 9;
