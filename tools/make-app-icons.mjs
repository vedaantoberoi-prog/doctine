import { chromium } from "playwright";
const out = process.argv[2];
const mark = (fg = "#F3F1EB") => `<path d="M11.5 8.5v15h4.2c4.2 0 6.8-3 6.8-7.5s-2.6-7.5-6.8-7.5z" fill="none" stroke="${fg}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="24" cy="7.6" r="2.3" fill="#8DB5AE"/>`;
const files = {
  // Android: full-bleed square (store/legacy), adaptive foreground (mark inside the 66% safe zone) and background
  "icon-only.png": [1024, 1024, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#101C2B"/>${mark()}</svg>`],
  "icon-foreground.png": [1024, 1024, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 48 48">${mark()}</svg>`],
  "icon-background.png": [1024, 1024, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#101C2B"/></svg>`],
  // splash: brand mark centred on the app's ivory background (light) and navy (dark)
  "splash.png": [2732, 2732, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2732 2732"><rect width="2732" height="2732" fill="#F3F1EB"/><g transform="translate(1166 1166) scale(12.5)"><rect width="32" height="32" rx="9" fill="#101C2B"/>${mark()}</g></svg>`],
  "splash-dark.png": [2732, 2732, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2732 2732"><rect width="2732" height="2732" fill="#0C1520"/><g transform="translate(1166 1166) scale(12.5)"><rect width="32" height="32" rx="9" fill="#1B2B40"/>${mark()}</g></svg>`],
  // macOS: Apple's icon grid (824 px rounded square inside 1024, transparent margin)
  "icon-macos.png": [1024, 1024, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1B2D45"/><stop offset="1" stop-color="#0E1928"/></linearGradient></defs><rect x="100" y="100" width="824" height="824" rx="185" fill="url(#g)"/><g transform="translate(160 160) scale(22)">${mark()}</g></svg>`],
};
const b = await chromium.launch();
for (const [name, [w, h, svg]] of Object.entries(files)) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${w}" height="${h}" `)}</body></html>`);
  await p.screenshot({ path: out + "/" + name, omitBackground: true }); await p.close();
}
await b.close(); console.log("ok");
