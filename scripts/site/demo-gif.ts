// Records the landing page's demo (the window and its three steps, site/src/landing.html) as the README's looping
// GIF, site/public/demo.gif: one whole loop, sped up to about 15 s. Run `bun run site` first if the landing page is
// stale, then `bun run site:demo`, and commit the GIF. Real Chrome via Playwright, on a fake clock, so every frame is
// exactly 1/FPS of the demo's time apart however slow the screenshots are. Needs ffmpeg.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = join(import.meta.dir, "../..");
const LANDING = pathToFileURL(join(root, "site/src/landing.html")).href;
const OUT = join(root, "site/public/demo.gif");
const FPS = 15; // of the demo's own time; the GIF plays them faster
const SECONDS = 15; // how long one loop of the GIF lasts
const WIDTH = 880; // the GIF's width, in pixels

const dir = mkdtempSync(join(tmpdir(), "solipsist-demo-"));
const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL ?? "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 2, colorScheme: "light" });
  await page.clock.install();
  await page.goto(LANDING);
  await page.evaluate(() => document.fonts.ready);
  await page.locator("#demo").scrollIntoViewIfNeeded();
  // The fake clock still runs on its own until paused; from here only runFor moves it.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1));

  // The window and the steps under it, with a margin.
  const box = await page.evaluate(() => {
    const a = document.getElementById("demo")!.getBoundingClientRect();
    const b = document.getElementById("d-steps")!.getBoundingClientRect();
    const m = 16;
    return { x: Math.min(a.left, b.left) - m, y: a.top - m, width: Math.max(a.right, b.right) - Math.min(a.left, b.left) + 2 * m, height: b.bottom - a.top + 2 * m };
  });

  // The step playing: 0, 1 or 2. One loop ends when step 0 comes round again after step 2.
  const step = () => page.evaluate(() => [...document.querySelectorAll("#d-steps .l-step")].findIndex((s) => s.hasAttribute("aria-current")));
  let frames = 0, seenLast = false;
  for (;;) {
    await page.screenshot({ path: join(dir, `${String(frames).padStart(4, "0")}.png`), clip: box });
    frames++;
    await page.clock.runFor(1000 / FPS);
    const now = await step();
    if (now === 2) seenLast = true;
    if (seenLast && now === 0) break;
    if (frames > FPS * 60) throw new Error("demo-gif: the demo never looped");
  }

  const speed = frames / FPS / SECONDS;
  const filter = `setpts=PTS/${speed},fps=${FPS},scale=${WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  const ff = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(dir, "%04d.png"), "-vf", filter, "-loop", "0", OUT]);
  if (ff.exitCode !== 0) throw new Error(`demo-gif: ffmpeg failed\n${ff.stderr}`);
  console.log(`demo-gif: ${frames} frames (${(frames / FPS).toFixed(1)} s of demo) → ${OUT}, ${SECONDS} s, ${(Bun.file(OUT).size / 1e6).toFixed(1)} MB`);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
