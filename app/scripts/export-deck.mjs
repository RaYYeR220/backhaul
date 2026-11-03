#!/usr/bin/env node
// Prints the pitch deck (/deck) to public/backhaul-deck.pdf, one 16:9 page per slide.
//
//   npm run export:deck                  refresh facts from ../results and ../deployments, build,
//                                        start the app, print, stop it
//   npm run export:deck -- --no-build    print the last build
//   npm run export:deck -- --url URL     print a server that is already running
//
// Before printing it checks that every slide is exactly 1280 × 720 and that nothing on a slide
// runs past its edges or out of its content box; after, that the PDF has one page per slide.
// Needs Chromium for Playwright: `npx playwright install chromium` once.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { APP, writeFacts } from "./deck-facts.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const OUT = resolve(APP, opt("out") ?? "public/backhaul-deck.pdf");
const NEXT = resolve(APP, "node_modules/next/dist/bin/next");

function freePort() {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
    });
  });
}

async function waitFor(url, ms = 90_000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    if (Date.now() > until) throw new Error(`no answer from ${url}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** Runs in the page: everything that would show as a broken slide. */
export function layoutProblems() {
  const out = [];
  const slides = [...document.querySelectorAll("[data-slide]")];
  const say = (i, el, what) => {
    const text = (el.textContent || el.className || el.tagName).trim().replace(/\s+/g, " ").slice(0, 60);
    out.push(`slide ${i + 1}: ${what} · "${text}"`);
  };
  slides.forEach((slide, i) => {
    const r = slide.getBoundingClientRect();
    if (Math.abs(r.width - 1280) > 0.5 || Math.abs(r.height - 720) > 0.5) say(i, slide, `is ${r.width} × ${r.height}`);
    for (const box of slide.querySelectorAll("[data-fit]")) {
      if (box.scrollHeight > box.clientHeight + 1) say(i, box, `content is ${box.scrollHeight - box.clientHeight}px taller than its box`);
    }
    const walk = (el) => {
      for (const c of el.children) {
        const cs = getComputedStyle(c);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const cr = c.getBoundingClientRect();
        const outside = cr.width > 0 && cr.height > 0 && (cr.left < r.left - 0.5 || cr.right > r.right + 0.5 || cr.top < r.top - 0.5 || cr.bottom > r.bottom + 0.5);
        if (outside) say(i, c, "runs past the slide edge");
        if (/(hidden|clip)/.test(cs.overflowX + cs.overflowY) && !c.hasAttribute("data-fit") && (c.scrollWidth > c.clientWidth + 1 || c.scrollHeight > c.clientHeight + 1) && cs.textOverflow !== "ellipsis") {
          if (!c.closest("[data-clip-ok]")) say(i, c, "clips its own content");
        }
        if (!c.hasAttribute("data-clip-ok")) walk(c);
      }
    };
    walk(slide);
  });
  return { slides: slides.length, problems: out };
}

async function main() {
  writeFacts();

  let url = opt("url")?.replace(/\/+$/, "");
  let server = null;
  if (!url) {
    if (!flag("no-build")) {
      const b = spawnSync(process.execPath, [NEXT, "build"], { cwd: APP, stdio: "inherit" });
      if (b.status !== 0) throw new Error("next build failed");
    }
    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [NEXT, "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: APP, stdio: ["ignore", "ignore", "inherit"] });
    await waitFor(`${url}/deck`);
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.emulateMedia({ media: "print" });
    await page.goto(`${url}/deck?print`, { waitUntil: "load" });
    await page.waitForSelector("html[data-deck-ready]", { timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);

    const { slides, problems } = await page.evaluate(layoutProblems);
    if (!slides) throw new Error("no slides on /deck");
    if (problems.length && !flag("allow-overflow")) {
      console.error(problems.join("\n"));
      throw new Error(`${problems.length} layout problem(s); fix them or pass --allow-overflow`);
    }
    problems.forEach((p) => console.warn(`warning: ${p}`));

    await page.pdf({ path: OUT, width: "1280px", height: "720px", printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    const pdf = readFileSync(OUT, "latin1");
    const pages = (pdf.match(/\/Type\s*\/Page(?![a-z])/g) ?? []).length;
    if (pages !== slides) throw new Error(`${OUT} has ${pages} pages for ${slides} slides`);
    console.log(`deck: ${slides} slides → ${OUT} (${pages} pages, ${Math.round(statSync(OUT).size / 1024)} KB)`);
  } finally {
    await browser.close();
    server?.kill();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`export-deck: ${e.message}`);
    process.exit(1);
  });
}
