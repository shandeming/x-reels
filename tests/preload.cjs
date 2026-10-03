const fs = require('fs'), assert = require('assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  try {
    const page = await browser.newPage(), requested = new Set();
    let releaseSlow;
    const slowImage = new Promise(resolve => { releaseSlow = resolve; });
    let total = 12;
    const photo = n => ({ id_str: `p${n}`, type: 'photo', media_url_https: `https://pbs.twimg.com/media/p${n}.jpg` });
    const video = { id_str: 'v1', type: 'video', media_url_https: 'https://pbs.twimg.com/media/poster.jpg', video_info: { variants: [{ content_type: 'video/mp4', url: 'https://video.twimg.com/v1.mp4' }] } };
    await page.route('https://x.com/**', r => r.request().url().includes('/graphql/') ? r.fulfill({ json: { media: [photo(0), video, ...Array.from({ length: total - 1 }, (_, i) => photo(i + 1))] } }) : r.fulfill({ contentType: 'text/html', body: '<body style="height:10000px">Timeline</body>' }));
    await page.route('https://pbs.twimg.com/**', async r => {
      requested.add(r.request().url());
      if (r.request().url().endsWith('/p5.jpg')) await slowImage;
      if (r.request().url().endsWith('/p6.jpg')) return r.abort('failed');
      return r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/>' });
    });
    await page.route('https://video.twimg.com/**', r => { throw new Error('A video was prefetched: ' + r.request().url()); });
    // Record retained preload elements separately from the displayed image.
    await page.addInitScript(() => {
      const NativeImage = window.Image;
      window.preloadElements = [];
      window.Image = function (...args) { const image = new NativeImage(...args); window.preloadElements.push(image); return image; };
    });
    await page.addInitScript(fs.readFileSync('x-reels.user.js', 'utf8'));
    await page.goto('https://x.com/home');
    const ingest = () => page.evaluate(() => fetch('/i/api/graphql/test/HomeTimeline'));
    await ingest();
    assert.equal(requested.size, 0, 'Do not preload while Reels is closed');
    await page.getByRole('button', { name: '▶ Reels' }).click();
    const retained = () => page.evaluate(() => window.preloadElements.filter(i => i.hasAttribute('src')).map(i => i.src));
    assert.deepEqual(await retained(), Array.from({ length: 10 }, (_, i) => `https://pbs.twimg.com/media/p${i + 1}.jpg`));
    const states = () => page.locator('.media-marker').evaluateAll(nodes => nodes.map(n => ({ state: n.dataset.state, type: n.dataset.type, title: n.title })));
    assert.equal((await states())[0].state, 'current');
    assert.equal((await states())[1].type, 'video');
    assert.equal((await states())[1].state, 'idle');
    assert.equal((await states())[6].state, 'loading', 'Pending image stays amber');
    releaseSlow();
    await page.waitForFunction(() => window.preloadElements.filter(i => i.hasAttribute('src')).every(i => i.complete));
    await page.waitForFunction(() => [...document.querySelectorAll('div')].some(e => e.shadowRoot?.querySelector('.preload-summary')?.textContent === '9/10 ready'));
    assert.equal((await states()).filter(n => n.state === 'ready').length, 9);
    assert.equal((await states())[6].state, 'ready', 'Loaded image turns green');
    assert.equal((await states())[7].state, 'error', 'Failed image stays gray');
    assert.match((await states())[7].title, /failed/);
    assert(!requested.has('https://pbs.twimg.com/media/poster.jpg'), 'Skip video posters too');
    // Skip over the video: entering it normally would play it as designed.
    const slider = page.getByRole('slider', { name: 'Jump to loaded media' });
    const rect = await slider.boundingBox();
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height * 2 / 12);
    assert.deepEqual(await retained(), Array.from({ length: 10 }, (_, i) => `https://pbs.twimg.com/media/p${i + 2}.jpg`));
    assert.equal(await page.evaluate(() => window.preloadElements.length), 11, 'Reuse the overlapping nine images');
    assert.equal((await states())[2].state, 'current', 'Blue follows the slider');
    await page.keyboard.press('End');
    assert.equal((await retained()).length, 0, 'No future images remain');
    assert.equal((await states()).filter(n => n.state === 'ready' || n.state === 'loading').length, 0, 'Old buffer markers reset');
    total = 22; await ingest();
    assert.deepEqual(await retained(), Array.from({ length: 10 }, (_, i) => `https://pbs.twimg.com/media/p${i + 12}.jpg`), 'Replenish when timeline data arrives');
    await page.keyboard.press('Escape');
    assert.equal((await retained()).length, 0, 'Release the preload buffer on exit');
    total = 30; await ingest();
    assert.equal((await retained()).length, 0);
    console.log('PASS: next ten images; videos/posters skipped; buffer reuse/refill/exit; amber pending, green ready, gray failures/videos, blue current and accurate ready count.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
