// Links to official consumer pages where a driver can see a station's posted price themselves (docs/17):
// ExitAtlas opens them and never reads or copies prices from them. Same links in the iOS app
// (App/ExitAtlas/Views/Exits/PriceViews.swift PriceCheckLinks).
//   Google Maps: the documented Maps URLs search (https://developers.google.com/maps/documentation/urls),
//     the brand near the station's coordinates; the nearest one is listed first.
//   GasBuddy: its public city price page (https://www.gasbuddy.com/gasprices/<state>/<city>), else the state
//     page. GasBuddy offers no API or license for its data; a plain link is all ExitAtlas uses.

export const US_STATES = Object.freeze({
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
});

/// "New York" -> "new-york", "St. Mary's" -> "st-marys".
export function slug(text) {
  return String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/// The brand (or name) near the station on Google Maps.
export function googleMapsLink({ name, brand, coordinate }) {
  const what = (brand || name || 'gas station').trim();
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${what} ${coordinate.lat.toFixed(5)},${coordinate.lon.toFixed(5)}`)}`;
}

/// GasBuddy's price page for the station's city, else its state; null when the state is not known.
/// place: {city, state} where state is a two letter code or a full name.
export function gasBuddyLink(place) {
  const state = US_STATES[String(place?.state ?? '').toUpperCase()] ?? place?.state;
  if (!state || !Object.values(US_STATES).includes(state)) return null;
  const city = slug(place.city);
  return `https://www.gasbuddy.com/gasprices/${slug(state)}${city ? `/${city}` : ''}`;
}
