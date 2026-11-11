// Renders tools/art/auth-still-life.html to the sign-in panel image (public/img/auth-still-1x.webp, -2x.webp).
//   node tools/art/render-auth-still.mjs      (needs Playwright and Python Pillow; run by hand when the art changes)
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../..", import.meta.url));
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 900, height: 1200 }, deviceScaleFactor: 2 });
await pg.goto("file://" + root + "tools/art/auth-still-life.html"); await pg.evaluate(() => document.fonts.ready); await pg.waitForTimeout(300);
const png = root + "tools/art/.auth-still.png"; await pg.screenshot({ path: png }); await b.close();
execFileSync("python3", ["-c", `
from PIL import Image
im = Image.open(${JSON.stringify(png)}).convert("RGB")
im.resize((1350, 1800), Image.LANCZOS).save(${JSON.stringify(root + "public/img/auth-still-2x.webp")}, "WEBP", quality=70, method=6)
im.resize((675, 900), Image.LANCZOS).save(${JSON.stringify(root + "public/img/auth-still-1x.webp")}, "WEBP", quality=74, method=6)
`]);
console.log("render-auth-still: wrote public/img/auth-still-1x.webp and -2x.webp");
