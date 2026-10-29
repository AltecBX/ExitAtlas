// Multicolor weather symbols for the weather pill and sheet, drawn on a 32 by 32 grid with flat fills (no
// gradient ids, so any number can sit on one page). The iOS app uses SF Symbols in multicolor for the same kinds.

const SUN = '#FFC83D', RAYS = '#FFB000', MOON = '#F3DE8A', MOON_EDGE = '#D9BC52';
const CLOUD = '#FFFFFF', CLOUD_SHADE = '#B9C4D3', GREY = '#A9B5C6', GREY_SHADE = '#7C899C';
const DARK = '#7D879A', DARK_SHADE = '#596377', DROP = '#3B9CFF', FLAKE = '#7CC4FF', BOLT = '#FFC400';

const CLOUD_PATH = 'M10.5 24.5h13a5 5 0 0 0 .6-9.96 7 7 0 0 0-13.3 1.9A4.3 4.3 0 0 0 10.5 24.5z';

function sun(cx, cy, r) {
  let rays = '';
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4, c = Math.cos(a), s = Math.sin(a);
    rays += `M${(cx + c * (r + 2.2)).toFixed(2)} ${(cy + s * (r + 2.2)).toFixed(2)}L${(cx + c * (r + 4.6)).toFixed(2)} ${(cy + s * (r + 4.6)).toFixed(2)}`;
  }
  return `<path d="${rays}" stroke="${RAYS}" stroke-width="2" stroke-linecap="round"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="${SUN}"/>`;
}

/// A crescent opening to the upper right.
function moon(cx, cy, r) {
  const ax = cx + r * 0.5, ay = cy - r * 0.866, bx = cx + r * 0.866, by = cy + r * 0.5;
  return `<path d="M${ax.toFixed(2)} ${ay.toFixed(2)}A${r} ${r} 0 1 0 ${bx.toFixed(2)} ${by.toFixed(2)}A${(r * 0.78).toFixed(2)} ${(r * 0.78).toFixed(2)} 0 0 1 ${ax.toFixed(2)} ${ay.toFixed(2)}z" fill="${MOON}" stroke="${MOON_EDGE}" stroke-width="1" stroke-linejoin="round"/>`;
}

function cloud(x, y, s, fill = CLOUD, shade = CLOUD_SHADE) {
  return `<g transform="translate(${x} ${y}) scale(${s})"><path d="${CLOUD_PATH}" fill="${shade}" transform="translate(0 1.3)"/><path d="${CLOUD_PATH}" fill="${fill}"/></g>`;
}

const sky = (isDay, cx, cy, r) => (isDay === false ? moon(cx, cy, r) : sun(cx, cy, r));
const drops = (xs, y0 = 22.5) => xs.map((x) => `<path d="M${x} ${y0}l-1.4 4" stroke="${DROP}" stroke-width="2.2" stroke-linecap="round"/>`).join('');
const flakes = (pts) => pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.6" fill="${FLAKE}"/>`).join('');
const lines = (color, ys, x0 = 6, x1 = 26) => ys.map((y, i) => `<path d="M${x0 + (i % 2) * 3} ${y}H${x1 - ((i + 1) % 2) * 3}" stroke="${color}" stroke-width="2.2" stroke-linecap="round"/>`).join('');
const waves = (color) => [12, 17, 22].map((y) => `<path d="M5 ${y}c3-2.5 5-2.5 8 0s5 2.5 8 0 4-2 6-1" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round"/>`).join('');

function thermometer(color) {
  return `<path d="M13 7a3 3 0 0 1 6 0v11.2a5.5 5.5 0 1 1-6 0z" fill="#fff" stroke="#8E99AB" stroke-width="1.4"/>`
    + `<path d="M16 12v8" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/><circle cx="16" cy="22.6" r="3.4" fill="${color}"/>`;
}

const SHAPES = {
  clear: (d) => (d === false ? moon(16, 16, 9) : sun(16, 16, 6.5)),
  mostlyClear: (d) => sky(d, 13, 13, d === false ? 7.5 : 5.5) + cloud(10, 10, 0.62),
  partlyCloudy: (d) => sky(d, 12, 11, d === false ? 6.5 : 4.8) + cloud(2, 2, 0.9),
  mostlyCloudy: (d) => sky(d, 10, 9.5, d === false ? 5 : 3.8) + cloud(0.5, 1, 1),
  cloudy: () => cloud(-4.5, -4.5, 0.85, GREY, GREY_SHADE) + cloud(1, 1, 0.95),
  showers: (d) => sky(d, 11, 9, d === false ? 5 : 3.8) + cloud(0.5, -2, 0.95, GREY, GREY_SHADE) + drops([13, 18]),
  rain: () => cloud(0, -3.5, 1, GREY, GREY_SHADE) + drops([11.5, 16.5, 21.5]),
  thunder: () => cloud(0, -4, 1, DARK, DARK_SHADE) + `<path d="M17.5 17.5l-4.2 6.2h3.4l-1.9 5.6 6-7.4h-3.6l2.2-4.4z" fill="${BOLT}" stroke="#F59E0B" stroke-width="0.8" stroke-linejoin="round"/>`,
  sleet: () => cloud(0, -3.5, 1, GREY, GREY_SHADE) + drops([12]) + flakes([[17.5, 25], [22, 23.5]]),
  snow: () => cloud(0, -3.5, 1, GREY, GREY_SHADE) + flakes([[11.5, 24.5], [16.5, 27], [21.5, 24.5]]),
  fog: () => cloud(0, -5.5, 1, GREY, GREY_SHADE) + lines('#9AA6B8', [22.5, 27]),
  haze: (d) => sky(d, 16, 11, d === false ? 6.5 : 4.8) + lines('#C9B27C', [22, 26.5]),
  smoke: () => waves('#8E8E93'),
  dust: () => waves('#C8A06A'),
  wind: () => `<path d="M4 12h15a3.5 3.5 0 1 0-3.5-3.5M4 17h21a3.5 3.5 0 1 1-3.5 3.5M4 22h10" fill="none" stroke="#7FB2E5" stroke-width="2.4" stroke-linecap="round"/>`,
  hot: () => thermometer('#FF5A36'),
  cold: () => thermometer('#4DA3FF'),
  severe: () => `<path d="M16 4.5L29 27H3z" fill="#FF9F0A" stroke="#E08600" stroke-width="1.4" stroke-linejoin="round"/><path d="M16 12v7" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><circle cx="16" cy="23" r="1.6" fill="#fff"/>`,
};

/// The symbol for a weather kind (engine/weather.js WEATHER_KINDS); a plain cloud when the kind is unknown.
export function weatherIcon(kind, isDay, cls = 'wx-icon') {
  const shape = SHAPES[kind] ?? SHAPES.cloudy;
  return `<svg class="${cls}" viewBox="0 0 32 32" aria-hidden="true">${shape(isDay)}</svg>`;
}

/// Sky colors for the weather card: [top, bottom], deep enough for white text.
export function skyColors(kind, isDay) {
  const night = isDay === false;
  switch (kind) {
    case 'clear': case 'mostlyClear': return night ? ['#0B1530', '#26386A'] : ['#1A5FBF', '#3B8BD9'];
    case 'thunder': return ['#2A2340', '#4A4170'];
    case 'severe': return ['#5A1E1E', '#8E3A2A'];
    case 'rain': case 'showers': return night ? ['#121A26', '#2A3749'] : ['#344A61', '#566E88'];
    case 'snow': case 'sleet': case 'cold': return night ? ['#1F2D42', '#42557A'] : ['#45698E', '#6C8BAA'];
    case 'smoke': case 'dust': case 'hot': return night ? ['#2B1F19', '#4A362A'] : ['#6E4630', '#97683F'];
    default: return night ? ['#1A2331', '#364357'] : ['#46607D', '#6C849F'];
  }
}
