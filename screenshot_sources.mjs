import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page    = await browser.newPage();
await page.setViewportSize({ width: 1400, height: 900 });

// Start on overview to let app bootstrap
await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });
await page.waitForTimeout(1000);

// Click Sources in the nav
await page.locator("text=Sources").first().click();
await page.waitForTimeout(3000);
await page.screenshot({ path: "/tmp/s1_sources_page.png" });

// Click AI-Enabled tab in the sources page (it has the category dot)
const tabs = await page.locator(".hz-cat-tab").all();
console.log("Tabs found:", tabs.length);
for (const tab of tabs) {
  const txt = await tab.innerText();
  console.log("tab:", txt.trim().slice(0,30));
}

// Click AI-Enabled
for (const tab of tabs) {
  if ((await tab.innerText()).includes("AI-Enabled")) {
    await tab.click(); break;
  }
}
await page.waitForTimeout(2000);
await page.screenshot({ path: "/tmp/s2_ai_enabled_tab.png" });

// Sort by Newest to get the OpenAI reports near the top
const sortBtns = await page.locator(".hz-seg-btn").all();
for (const btn of sortBtns) {
  if ((await btn.innerText()).includes("Newest")) { await btn.click(); break; }
}
await page.waitForTimeout(500);

// Click first row
const rows = await page.locator(".hz-src-row").all();
console.log("Rows found:", rows.length);
if (rows.length > 0) {
  await rows[0].click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "/tmp/s3_expanded.png" });
  
  const ra = page.locator(".hz-report-analysis");
  if (await ra.count()) {
    console.log("✓ Report analysis panel found");
    await ra.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/s4_report_panel.png" });

    // Open first walkthrough
    const wtBtn = page.locator(".hz-wt-header").first();
    if (await wtBtn.count()) {
      await wtBtn.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: "/tmp/s5_walkthrough_open.png" });

      // Click show diagram
      const diagBtn = page.locator(".hz-wt-diagram-toggle").first();
      if (await diagBtn.count()) {
        await diagBtn.scrollIntoViewIfNeeded();
        await diagBtn.click();
        await page.waitForTimeout(5000); // mermaid.ink
        await page.screenshot({ path: "/tmp/s6_diagram.png" });
        console.log("✓ Diagram screenshot taken");
      }
    }
  } else {
    // Try a few more rows
    for (let i = 1; i < Math.min(rows.length, 8); i++) {
      await rows[i].click();
      await page.waitForTimeout(600);
      if (await page.locator(".hz-report-analysis").count()) {
        console.log("✓ Found on row", i);
        await page.locator(".hz-report-analysis").scrollIntoViewIfNeeded();
        await page.screenshot({ path: "/tmp/s4_report_panel.png" });
        break;
      }
      await rows[i].click();
    }
  }
}

await browser.close();
console.log("done");
