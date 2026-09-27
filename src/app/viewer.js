import * as Cesium from 'cesium';

/**
 * Cesium requests a 'high-performance' context, which some hybrid-GPU setups
 * (e.g. Chrome on NVIDIA PRIME offload via Vulkan) refuse outright. Probe on a
 * throwaway canvas and fall back to the browser default when it fails.
 */
export function pickPowerPreference(doc = globalThis.document) {
  try {
    const gl = doc
      .createElement('canvas')
      .getContext('webgl2', { powerPreference: 'high-performance' });
    if (!gl) return 'default';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return 'high-performance';
  } catch {
    return 'default';
  }
}

/** Create the standard globe viewer in caller-owned, visible containers. */
export function createApplicationViewer({ container, creditContainer }) {
  if (!container || !creditContainer)
    throw new TypeError('Viewer and credit containers are required');
  const viewer = new Cesium.Viewer(container, {
    timeline: false,
    animation: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    vrButton: false,
    selectionIndicator: false,
    infoBox: false,
    baseLayer: false,
    creditContainer,
    msaaSamples: 4,
    contextOptions: {
      webgl: {
        preserveDrawingBuffer: true,
        powerPreference: pickPowerPreference(),
      },
    },
  });
  try {
    viewer.targetFrameRate = 60;
    viewer.scene.globe.show = false;
    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.skyAtmosphere.atmosphereLightIntensity = 18;
    viewer.scene.skyAtmosphere.saturationShift = -0.12;
    viewer.scene.skyAtmosphere.brightnessShift = -0.08;
    return viewer;
  } catch (error) {
    viewer.destroy();
    throw error;
  }
}
