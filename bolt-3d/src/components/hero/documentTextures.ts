import * as THREE from 'three';

export type DocumentKind = 'report' | 'prescription' | 'schedule' | 'profile' | 'dates';

const WIDTH = 512;
const HEIGHT = 724;
const PAPER = '#F3F1EB';
const INK = '#123B78';
const SAGE = '#527D76';
const GOLD = '#C89A57';
const SILVER = '#D8DEE6';

function seededRandom(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;
}

function rule(ctx: CanvasRenderingContext2D, y: number) {
  bar(ctx, 56, y, WIDTH - 112, 2, SILVER);
}

function drawReport(ctx: CanvasRenderingContext2D, rand: () => number) {
  bar(ctx, 0, 0, WIDTH, 120, INK);
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(WIDTH - 90, 60, 26, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 11; i++) {
    const y = 190 + i * 36;
    bar(ctx, 56, y, 140, 12, SILVER);
    bar(ctx, 230, y, 90 + rand() * 170, 12, INK, 0.45);
    rule(ctx, y + 24);
  }
  ctx.strokeStyle = SAGE;
  ctx.lineWidth = 5;
  ctx.beginPath();
  for (let i = 0; i <= 12; i++) {
    const x = 56 + (i * (WIDTH - 112)) / 12;
    const y = 640 - rand() * 90;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawPrescription(ctx: CanvasRenderingContext2D, rand: () => number) {
  bar(ctx, 0, 0, 28, HEIGHT, SAGE);
  bar(ctx, 80, 70, 220, 18, INK);
  bar(ctx, 80, 104, 150, 12, SILVER);
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(400, 110, 58, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 7; i++) {
    const y = 230 + i * 58;
    bar(ctx, 80, y, 40 + rand() * 60, 14, INK, 0.6);
    bar(ctx, 150, y + 30, 260 + rand() * 60, 8, SILVER);
  }
  rule(ctx, 640);
  bar(ctx, 80, 660, 180, 4, INK);
}

function drawSchedule(ctx: CanvasRenderingContext2D, rand: () => number) {
  bar(ctx, 0, 0, WIDTH, 96, SAGE);
  const cell = 58;
  const gap = 14;
  const originX = 56;
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 7; col++) {
      const x = originX + col * (cell + gap);
      const y = 150 + row * (cell + gap);
      bar(ctx, x, y, cell, cell, SILVER, 0.55);
      if (rand() > 0.45) {
        ctx.fillStyle = rand() > 0.5 ? GOLD : SAGE;
        ctx.beginPath();
        ctx.arc(x + cell / 2, y + cell / 2, 12, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function drawProfile(ctx: CanvasRenderingContext2D, rand: () => number) {
  bar(ctx, 0, 0, WIDTH, 16, INK);
  ctx.fillStyle = SILVER;
  ctx.beginPath();
  ctx.arc(WIDTH / 2, 220, 110, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = SAGE;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.ellipse(WIDTH / 2, 480, 180, 120, 0, Math.PI, 0);
  ctx.fill();
  ctx.globalAlpha = 1;
  for (let i = 0; i < 6; i++) {
    const y = 560 + i * 24;
    bar(ctx, 56, y, 120 + rand() * 200, 10, INK, 0.4);
  }
}

function drawDates(ctx: CanvasRenderingContext2D, rand: () => number) {
  bar(ctx, 118, 80, 4, 560, SILVER);
  for (let i = 0; i < 9; i++) {
    const y = 96 + i * 66;
    ctx.fillStyle = i % 3 === 0 ? GOLD : INK;
    ctx.beginPath();
    ctx.arc(120, y, 12, 0, Math.PI * 2);
    ctx.fill();
    bar(ctx, 170, y - 8, 120 + rand() * 200, 16, SILVER);
  }
}

const DRAWERS: Record<DocumentKind, (ctx: CanvasRenderingContext2D, rand: () => number) => void> = {
  report: drawReport,
  prescription: drawPrescription,
  schedule: drawSchedule,
  profile: drawProfile,
  dates: drawDates,
};

export function createDocumentTexture(kind: DocumentKind): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    bar(ctx, 0, 0, WIDTH, HEIGHT, PAPER);
    DRAWERS[kind](ctx, seededRandom(kind.length * 9973 + kind.charCodeAt(0)));
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
