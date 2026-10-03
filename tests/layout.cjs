const fs=require('fs'), assert=require('assert/strict');
const {chromium}=require('playwright');
(async()=>{
 fs.mkdirSync('test-results',{recursive:true});
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1600,height:1000}});
  let total=44;
  await page.route('https://x.com/**',r=>r.request().url().includes('/graphql/')?r.fulfill({json:{media:Array.from({length:total},(_,i)=>({id_str:String(i+1),type:'photo',media_url_https:`https://pbs.twimg.com/media/${i+1}.jpg`,expanded_url:`https://x.com/artist/status/${i+1000}/photo/1`}))}}):r.fulfill({contentType:'text/html; charset=utf-8',body:'<body style="height:100000px"><p>Mock timeline</p></body>'}));
  await page.route('https://pbs.twimg.com/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="1408" height="640"><defs><linearGradient id="b" x2="0" y2="1"><stop stop-color="#367da8"/><stop offset="1" stop-color="#0b2844"/></linearGradient></defs><rect width="1408" height="640" fill="url(#b)"/><path d="M0 490Q220 370 400 500T850 510T1408 420V640H0Z" fill="#0c253b"/><text x="704" y="300" fill="#d7e9f5" text-anchor="middle" font-family="sans-serif" font-size="32">Landscape test image</text></svg>'}));
  await page.addInitScript(fs.readFileSync('x-reels.user.js','utf8'));
  await page.goto('https://x.com/home');await page.evaluate(()=>fetch('/i/api/graphql/test/HomeTimeline'));
  await page.getByRole('button',{name:'▶ Reels'}).click();
  const slider=page.getByRole('slider',{name:'Jump to loaded media'});
  await slider.waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('div')].some(d=>d.shadowRoot?.querySelector('.loaded-total')?.textContent==='44'));
  assert.equal(await slider.getAttribute('aria-valuemax'),'44');
  const stage=await page.locator('.stage').boundingBox();
  assert(stage.width>1400,'Landscape area must use available screen width');
  assert.equal(stage.height,872);
  assert.equal(await page.locator('.stage img').evaluate(el=>el.style.objectFit),'contain');
  const rect=await slider.boundingBox(),x=rect.x+rect.width/2;
  await page.mouse.click(x,rect.y+rect.height*11/43);
  assert.equal(await slider.getAttribute('aria-valuenow'),'12');
  // Drag from item 12 to bottom, then top, including outside the track bounds.
  await page.mouse.move(x,rect.y+rect.height*11/43);await page.mouse.down();
  await page.mouse.move(x,rect.y+rect.height+20,{steps:8});await page.mouse.up();
  assert.equal(await slider.getAttribute('aria-valuenow'),'44');
  await page.mouse.move(x,rect.y+rect.height);await page.mouse.down();
  await page.mouse.move(x,rect.y-20,{steps:8});await page.mouse.up();
  assert.equal(await slider.getAttribute('aria-valuenow'),'1');
  await slider.focus();await page.keyboard.press('End');assert.equal(await slider.getAttribute('aria-valuenow'),'44');
  await page.keyboard.press('Home');await page.keyboard.press('PageDown');assert.equal(await slider.getAttribute('aria-valuenow'),'11');
  total=60;await page.evaluate(()=>fetch('/i/api/graphql/test/HomeTimeline'));
  await page.waitForFunction(()=>[...document.querySelectorAll('div')].some(d=>d.shadowRoot?.querySelector('.loaded-total')?.textContent==='60'));
  assert.equal(await slider.getAttribute('aria-valuemax'),'60');
  await page.keyboard.press('End');assert.equal(await slider.getAttribute('aria-valuenow'),'60');
  await page.mouse.click(x,rect.y+rect.height*11/59);
  assert.equal(await slider.getAttribute('aria-valuenow'),'12');
  await page.screenshot({path:'test-results/layout.png'});
  await page.setViewportSize({width:390,height:844});
  const mobileStage=await page.locator('.stage').boundingBox(),mobileRail=await slider.boundingBox();
  assert(mobileStage.x+mobileStage.width<mobileRail.x,'Media must not overlap mobile navigation');
  assert(mobileStage.height>600);assert(mobileRail.height>500);
  // Closing during a drag must release capture and cancel pending jumps.
  await page.mouse.move(mobileRail.x+17,mobileRail.y+100);await page.mouse.down();
  await page.keyboard.press('Escape');await page.mouse.up();
  assert.equal(await page.getByRole('button',{name:'▶ Reels'}).isVisible(),true);
  console.log('PASS: full-width default Fit; click/drag jumps and endpoint clamping; keyboard slider controls; live loaded-count updates; mobile layout; close during drag. Offline media fixtures.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
