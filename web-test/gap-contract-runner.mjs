import { chromium } from "playwright";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(process.cwd(), "..");
const host = "127.0.0.1";
const port = 4173;
const baseUrl = `http://${host}:${port}`;

const viewports = Array.from({ length: Math.floor((1800 - 600) / 100) + 1 }, (_, index) => ({
  width: 600 + index * 100,
  height: 900
}));

const fonts = [
  "Digital7Mono"
];

const dualFontModes = [false];
const targetWeightGap = 0.07;
const targetFr = 0.07;
const ratioTolerance = 0.012;

function waitForServer(url, timeoutMs = 10_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(url, res => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Server did not start in ${timeoutMs}ms`));
          return;
        }
        setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

function startServer() {
  const child = spawn("python3", ["-m", "http.server", String(port), "--bind", host], {
    cwd: path.join(repoRoot, "web"),
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});

  return child;
}

async function measureGapContract(page, viewport, fontName, dualFont) {
  await page.setViewportSize(viewport);
  await page.goto(`${baseUrl}/index.html?e2e=1`, { waitUntil: "load" });
  await page.waitForFunction(() => {
    const clock = document.getElementById("clock");
    const dateLine = document.getElementById("dateLine");
    const hour = document.getElementById("hour");
    return Boolean(
      clock &&
      dateLine &&
      hour &&
      getComputedStyle(clock).display !== "none" &&
      typeof window.applyClockTransform === "function" &&
      typeof window.getRenderedTextBounds === "function" &&
      dateLine.children.length > 0
    );
  }, { timeout: 5000 });
  await page.waitForTimeout(80);

  const result = await page.evaluate(({ fontName, dualFont, targetWeightGap, targetFr }) => {
    const ok = (v) => Number.isFinite(v);

    if (typeof setSimulationModeByKey === "function") {
      setSimulationModeByKey("8");
    }

    if (typeof state !== "object") {
      return { error: "Global state is unavailable" };
    }

    state.weightGap = targetWeightGap;
    state.fr = targetFr;
    state.numericFont = fontName;
    state.dualFont = dualFont;
    state.alphaFont = dualFont ? fontName : state.numericFont;

    if (typeof window.applyLoadedStateToUi === "function") {
      window.applyLoadedStateToUi();
    }
    if (typeof window.applyClockTransform === "function") {
      window.applyClockTransform();
    }

    const getRowBounds = (element) => {
      const textBounds = typeof window.getRenderedTextBounds === "function"
        ? window.getRenderedTextBounds(element)
        : null;
      if (textBounds) return textBounds;
      if (typeof window.getChildrenVisualBounds !== "function") return null;
      return window.getChildrenVisualBounds(element);
    };

    const getElementsBounds = (elements) => {
      const textBounds = typeof window.getElementsRenderedTextBounds === "function"
        ? window.getElementsRenderedTextBounds(elements)
        : null;
      if (textBounds) return textBounds;
      if (typeof window.getElementsVisualBounds !== "function") return null;
      return window.getElementsVisualBounds(elements);
    };

    const dateLine = document.getElementById("dateLine");
    const timeLine = document.getElementById("timeLine");

    if (!dateLine || !timeLine) {
      return { error: "Clock elements are missing" };
    }

    const dateBounds = getRowBounds(dateLine);
    const hhmmBounds = getRowBounds(timeLine);

    if (!dateBounds || !hhmmBounds || !ok(hhmmBounds.height)) {
      return { error: "Failed to compute visual bounds" };
    }

    const gapPx = hhmmBounds.top - dateBounds.bottom;
    const hhmmHeightPx = hhmmBounds.height;
    const ratio = hhmmHeightPx > 0 ? gapPx / hhmmHeightPx : NaN;
    const expectedGapPx = targetWeightGap * hhmmHeightPx;
    const gapErrorPx = Number.isFinite(gapPx) && Number.isFinite(expectedGapPx)
      ? gapPx - expectedGapPx
      : NaN;

    return {
      gapPx,
      hhmmHeightPx,
      expectedGapPx,
      gapErrorPx,
      ratio,
      targetWeightGap,
      overlap: gapPx < 0,
      fontName,
      dualFont,
      dateBounds,
      hhmmBounds,
      viewport: { width: window.innerWidth, height: window.innerHeight }
    };
  }, { fontName, dualFont, targetWeightGap, targetFr });

  return result;
}

async function main() {
  const server = startServer();
  let browser;
  const all = [];

  try {
    await waitForServer(baseUrl);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    for (const viewport of viewports) {
      for (const fontName of fonts) {
        for (const dualFont of dualFontModes) {
          const m = await measureGapContract(page, viewport, fontName, dualFont);
          all.push(m);
          const label = `${viewport.width}x${viewport.height} | ${fontName} | dual=${dualFont}`;
          if (m.error) {
            console.log(`ERROR ${label}: ${m.error}`);
          } else {
            console.log(
              `${label} -> gap=${m.gapPx.toFixed(2)} px, expected=${m.expectedGapPx.toFixed(2)} px, error=${m.gapErrorPx.toFixed(2)} px, hhmm=${m.hhmmHeightPx.toFixed(2)} px, ratio=${m.ratio.toFixed(4)}`
            );
          }
        }
      }
    }

    const failures = all.filter(m => {
      if (m.error) return true;
      if (!Number.isFinite(m.ratio)) return true;
      if (m.overlap) return true;
      if (Math.abs(m.ratio - targetWeightGap) > ratioTolerance) return true;
      if (!Number.isFinite(m.gapErrorPx)) return true;
      const expectedGapAbsTolerancePx = Math.max(1, m.hhmmHeightPx * ratioTolerance);
      return Math.abs(m.gapErrorPx) > expectedGapAbsTolerancePx;
    });

    const report = {
      generatedAt: new Date().toISOString(),
      targetWeightGap,
      ratioTolerance,
      viewportStepPx: 100,
      total: all.length,
      failed: failures.length,
      results: all,
      failures
    };

    const reportPath = path.join(repoRoot, "web", "screens", "gap-contract-report.json");
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

    console.log(`\nReport written to ${reportPath}`);
    console.log(`Total cases: ${all.length}, failures: ${failures.length}`);

    if (failures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (browser) {
      await browser.close();
    }
    server.kill("SIGTERM");
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
