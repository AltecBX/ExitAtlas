// Links that hand a destination to another navigation app. Waze: the official deep link
// (https://developers.google.com/waze/deeplinks), which opens the Waze app when it is installed and the
// Waze website otherwise. Same as Sources/ExitAtlasCore/Route/NavigationHandoff.swift.

/// Waze's App Store page, for when the app is not installed.
export const WAZE_APP_STORE = 'https://apps.apple.com/us/app/id323229106';

/// "https://waze.com/ul?ll=40.758895,-73.985131&navigate=yes&utm_source=…": drive to the coordinate.
/// Null for a coordinate that is not on Earth.
export function wazeLink(c, source) {
  if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lon) || Math.abs(c.lat) > 90 || Math.abs(c.lon) > 180) return null;
  return `https://waze.com/ul?ll=${c.lat.toFixed(6)},${c.lon.toFixed(6)}&navigate=yes&utm_source=${encodeURIComponent(source)}`;
}
