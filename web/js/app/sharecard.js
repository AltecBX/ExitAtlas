// Share cards: a trip summary drawn on a canvas as a PNG, shared with the system
// share sheet when the browser can share files, otherwise downloaded.
import { METERS_PER_MILE as MILE } from '../engine/geo.js';

const W = 1080, H = 1350;
const GREEN = '#00673D', BLUE = '#0B4DA2', INK = '#0E1116', MUTED = '#525C69', BG = '#F2F3F5';

function font(weight, size) {
  return `${weight} ${size}px Overpass, -apple-system, "Segoe UI", Roboto, sans-serif`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

function frame(ctx, eyebrow, title) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = GREEN;
  roundRect(ctx, 60, 60, W - 120, 250, 28);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 6;
  roundRect(ctx, 72, 72, W - 144, 226, 20);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = font(700, 34);
  ctx.fillText(eyebrow.toUpperCase(), 110, 140);
  ctx.font = font(800, 64);
  ctx.fillText(fitText(ctx, title, W - 220), 110, 230);
}

function footer(ctx, note) {
  ctx.fillStyle = MUTED;
  ctx.font = font(600, 28);
  ctx.fillText(note, 60, H - 70);
  ctx.textAlign = 'right';
  ctx.fillStyle = GREEN;
  ctx.font = font(800, 32);
  ctx.fillText('ExitAtlas', W - 60, H - 70);
  ctx.textAlign = 'left';
}

/// Trip card: miles driven and the miles in each state, from the trip ledger (real GPS miles).
/// states: [{code, name, meters}] in driving order.
export function drawTripCard(canvas, { title, date, totalMeters, states, simulated = false }) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  frame(ctx, simulated ? 'Simulated drive' : 'Road trip', title);
  ctx.fillStyle = INK;
  ctx.font = font(800, 150);
  const miles = Math.round(totalMeters / MILE).toLocaleString('en-US');
  ctx.fillText(miles, 60, 500);
  const mw = ctx.measureText(miles).width;
  ctx.font = font(700, 48);
  ctx.fillStyle = MUTED;
  ctx.fillText(miles === '1' ? 'mile' : 'miles', 80 + mw, 500);
  const named = states.filter((s) => s.code && s.meters > 0);
  ctx.fillText(`${named.length} ${named.length === 1 ? 'state' : 'states'}`, 60, 570);
  const max = Math.max(...named.map((s) => s.meters), 1);
  let y = 650;
  for (const s of named.slice(0, 9)) {
    ctx.fillStyle = BLUE;
    roundRect(ctx, 60, y - 44, 92, 60, 12);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = font(800, 34);
    ctx.textAlign = 'center';
    ctx.fillText(s.code, 106, y);
    ctx.textAlign = 'left';
    const barW = Math.max(12, (W - 420) * (s.meters / max));
    ctx.fillStyle = GREEN;
    roundRect(ctx, 176, y - 36, barW, 44, 10);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.font = font(700, 34);
    ctx.fillText(`${Math.round(s.meters / MILE).toLocaleString('en-US')} mi`, 196 + barW, y - 2);
    y += 74;
  }
  if (named.length > 9) {
    ctx.fillStyle = MUTED;
    ctx.font = font(600, 30);
    ctx.fillText(`and ${named.length - 9} more`, 60, y);
  }
  footer(ctx, simulated ? `${date} · simulated GPS, not a real drive` : `${date} · miles measured by GPS`);
}

/// Shares a canvas as a PNG, or downloads it. Returns 'shared', 'downloaded' or 'cancelled'.
export async function shareCanvas(canvas, filename, text) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not draw the card');
  const file = new File([blob], filename, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return 'downloaded';
}
