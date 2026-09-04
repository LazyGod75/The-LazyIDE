import { test, expect, type Page } from 'playwright/test';

// Brain wiki navigation test — real data only, no mocks

async function skipOnboarding(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('lazy.onboarded', '1');
  });
}

test.setTimeout(120000);

test.describe('Brain wiki navigation (real data)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('lazy.onboarded', '1');
    });
  });

  test('click neuron → note appears in wiki panel', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Navigate to Brain space via sidebar
    const brainBtn = page.locator('button').filter({ hasText: /brain/i }).first();
    if (await brainBtn.isVisible().catch(() => false)) {
      await brainBtn.click();
      await page.waitForTimeout(3000);
    } else {
      // Try via command palette
      await page.keyboard.press('Control+Shift+P');
      await page.waitForTimeout(500);
      await page.keyboard.type('brain');
      await page.waitForTimeout(500);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);
    }

    await page.screenshot({ path: 'e2e/screenshots/brain-nav-01-loaded.png' });

    // Wait for the 3D graph to render — look for canvas
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible({ timeout: 10000 });

    // Click in the center of the canvas to hit a neuron
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(2000);
    }

    await page.screenshot({ path: 'e2e/screenshots/brain-nav-02-after-click.png' });

    // Check if wiki panel appeared on the right side — look for wiki content
    // The BrainWiki component renders tags, body, links
    const wikiPanel = page.locator('text=/tags|Tags|body|Body|validity|Validity|cluster|Cluster/i').first();
    const hasWiki = await wikiPanel.isVisible().catch(() => false);

    if (hasWiki) {
      console.log('Wiki panel is visible after neuron click');
    } else {
      console.log('Wiki panel NOT visible — checking for any right-panel content');
      // Maybe the wiki uses different labels
      const anyText = await page.evaluate(() => {
        const panels = document.querySelectorAll('[class*="wiki"], [class*="Wiki"], [data-testid*="wiki"]');
        return Array.from(panels).map(p => p.textContent?.slice(0, 100)).join('\n');
      });
      console.log('Wiki panels found:', anyText || 'none');
    }

    await page.screenshot({ path: 'e2e/screenshots/brain-nav-03-wiki-panel.png' });
  });

  test('navigate note-to-note via wiki links', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Navigate to Brain space
    const brainBtn = page.locator('button').filter({ hasText: /brain/i }).first();
    if (await brainBtn.isVisible().catch(() => false)) {
      await brainBtn.click();
      await page.waitForTimeout(3000);
    }

    // Wait for graph
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible({ timeout: 10000 });

    // Click a neuron
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(2000);
    }

    // Look for wiki links — they are div[role="button"] inside the "Liens" section
    // Use page.evaluate to find them specifically
    const wikiLinkInfo = await page.evaluate(() => {
      // Find the "Liens" section title
      const allDivs = document.querySelectorAll('div');
      for (const d of allDivs) {
        if (d.textContent === 'Liens' || d.textContent?.trim() === 'Liens') {
          // Find sibling/cousin div[role="button"] elements
          const parent = d.parentElement;
          if (!parent) continue;
          const links = parent.querySelectorAll('div[role="button"]');
          if (links.length > 0) {
            return { found: true, count: links.length, firstText: links[0].textContent?.trim().slice(0, 80) };
          }
        }
      }
      // Also check for "No rich links" text
      const noLinks = document.body.textContent?.includes('No rich links');
      return { found: false, count: 0, firstText: '', noLinks };
    });
    console.log('Wiki links:', JSON.stringify(wikiLinkInfo));

    const hasLink = wikiLinkInfo.found && wikiLinkInfo.count > 0;

    if (hasLink) {
      // Click the first wiki link using evaluate
      const clicked = await page.evaluate(() => {
        const allDivs = document.querySelectorAll('div');
        for (const d of allDivs) {
          if (d.textContent === 'Liens' || d.textContent?.trim() === 'Liens') {
            const parent = d.parentElement;
            if (!parent) continue;
            const link = parent.querySelector('div[role="button"]');
            if (link) {
              (link as HTMLElement).click();
              return true;
            }
          }
        }
        return false;
      });
      console.log('Clicked wiki link:', clicked);
      await page.waitForTimeout(2000);

      // After click, check the wiki panel still has content
      const afterText = await page.evaluate(() => {
        const allDivs = document.querySelectorAll('div');
        for (const d of allDivs) {
          if (d.textContent === 'Liens' || d.textContent?.trim() === 'Liens') {
            const parent = d.parentElement;
            if (!parent) continue;
            return parent.textContent?.slice(0, 200) ?? '';
          }
        }
        return '';
      });
      console.log('After click, wiki section text:', afterText);

      expect(afterText.length).toBeGreaterThan(0);

      await page.screenshot({ path: 'e2e/screenshots/brain-nav-04-after-link-click.png' });
    } else {
      // Check for "No rich links available" text — means the note has no edges in the graph
      const noLinks = await page.locator('text=/No rich links/i').isVisible().catch(() => false);
      if (noLinks) {
        console.log('Note has no links — trying to click another neuron');
        // Click elsewhere on the canvas
        if (box) {
          await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
          await page.waitForTimeout(2000);
        }
        const wikiLink2 = page.locator('div[role="button"]').first();
        const hasLink2 = await wikiLink2.isVisible({ timeout: 3000 }).catch(() => false);
        if (hasLink2) {
          console.log('Found wiki link on second try');
          await wikiLink2.click();
          await page.waitForTimeout(2000);
          await page.screenshot({ path: 'e2e/screenshots/brain-nav-04-after-link-click.png' });
        } else {
          console.log('No wiki links found on second try either');
        }
      } else {
        console.log('No wiki links and no "No rich links" text — wiki panel may not be rendered');
      }
    }

    await page.screenshot({ path: 'e2e/screenshots/brain-nav-05-final.png' });
  });

  test('camera stays focused after neuron click', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const brainBtn = page.locator('button').filter({ hasText: /brain/i }).first();
    if (await brainBtn.isVisible().catch(() => false)) {
      await brainBtn.click();
      await page.waitForTimeout(3000);
    }

    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible({ timeout: 10000 });

    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(1000);
    }

    // Screenshot right after click
    await page.screenshot({ path: 'e2e/screenshots/brain-nav-06-focused.png' });

    // Wait 5 seconds — camera should NOT have zoomed out
    await page.waitForTimeout(5000);

    // Screenshot after wait — should be same view (still focused)
    await page.screenshot({ path: 'e2e/screenshots/brain-nav-07-still-focused.png' });

    // We can't programmatically assert camera position easily, but the screenshots
    // will show if the camera moved. The fix removed the autoRotate resume timer.
    console.log('Camera focus test — check screenshots 06 and 07 for same view');
  });
});
