import * as Cesium from 'cesium';

// Attribution and service rights are documented in DATA_SOURCES.md.
export const ESRI_ATTRIBUTION_HTML =
  '<a href="https://www.esri.com" target="_blank" rel="noopener">Powered by Esri</a>';

export function createOsmImagery() {
  return new Cesium.OpenStreetMapImageryProvider({
    url: 'https://tile.openstreetmap.org/',
    credit: '© OpenStreetMap contributors',
  });
}

export function createEsriImagery() {
  return Cesium.ArcGisMapServerImageryProvider.fromUrl(
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
    {
      credit:
        'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      enablePickFeatures: false,
    },
  );
}

/**
 * The Streets map: Esri World Street Map, labelled in English. It replaced
 * the OpenStreetMap standard tiles as the street map, because those print
 * every name in the local script (日本, Москва) and BK wants every label in
 * English (2026-10-08). Retiring December 2029 (DATA_SOURCES.md).
 */
export function createEsriStreetImagery() {
  return Cesium.ArcGisMapServerImageryProvider.fromUrl(
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer',
    {
      credit:
        'Powered by Esri — Sources: Esri, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCan, Esri Japan, METI, Esri China (Hong Kong), Esri Korea, Esri (Thailand), NGCC, © OpenStreetMap contributors, and the GIS User Community',
      enablePickFeatures: false,
    },
  );
}

/**
 * The Streets map, falling back to OpenStreetMap's own tiles only if Esri's
 * service cannot be reached, so an Esri outage still leaves a street map.
 */
export async function createStreetImagery() {
  try {
    return await createEsriStreetImagery();
  } catch (error) {
    console.warn(
      '[Map] Esri street map unavailable; using OpenStreetMap tiles:',
      error?.message || error,
    );
    return createOsmImagery();
  }
}

/**
 * Country and state borders and English place names, transparent, for
 * drawing over satellite imagery (maps/placeLabels.js).
 */
export function createEsriPlaceLabelsImagery() {
  return Cesium.ArcGisMapServerImageryProvider.fromUrl(
    'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer',
    {
      credit:
        'Borders and place names: Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community',
      enablePickFeatures: false,
    },
  );
}

export function createIonImagery(style, accessToken) {
  accessToken = String(accessToken || '').trim();
  if (!accessToken) throw new Error('Ion imagery requires an explicit token');
  return Cesium.IonImageryProvider.fromAssetId(style, { accessToken });
}
