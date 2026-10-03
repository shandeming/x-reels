const fs = require('fs'), assert = require('assert/strict');
const { chromium } = require('playwright');
(async () => {
 const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 try {
  const page = await browser.newPage({viewport:{width:1280,height:800}});
  const bytes = await page.evaluate(async () => {
   const c=document.createElement('canvas');c.width=c.height=32;
   const stream=c.captureStream(15),ctx=c.getContext('2d'),r=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),chunks=[];
   r.ondataavailable=e=>chunks.push(e.data);const stop=new Promise(resolve=>r.onstop=resolve);
   r.start();let n=0;const timer=setInterval(()=>{ctx.fillStyle=n++%2?'red':'blue';ctx.fillRect(0,0,32,32);},60);
   await new Promise(resolve=>setTimeout(resolve,800));r.stop();await stop;clearInterval(timer);stream.getTracks().forEach(t=>t.stop());
   return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  });
  const photo={id_str:'1',type:'photo',media_url_https:'https://pbs.twimg.com/media/a.jpg',expanded_url:'https://x.com/artist/status/123/photo/1'};
  const video={id_str:'2',type:'video',media_url_https:'https://pbs.twimg.com/media/b.jpg',video_info:{variants:[{content_type:'video/mp4',bitrate:1,url:'https://video.twimg.com/low.mp4'},{content_type:'video/mp4',bitrate:9,url:'https://video.twimg.com/high.mp4'}]}};
  const extra=Array.from({length:38},(_,n)=>({...photo,id_str:String(n+3),media_url_https:`https://pbs.twimg.com/media/${n+3}.jpg`}));
  const response={entries:[{text:'Text only'},{__typename:'Tweet',rest_id:'456',legacy:{full_text:'caption',extended_entities:{media:[photo,photo,video,...extra]}}},{promotedMetadata:{},media:[{...photo,id_str:'advert'}]}]};
  await page.context().route('https://x.com/**',route=>route.request().url().includes('/graphql/')?route.fulfill({json:response}):route.fulfill({contentType:'text/html',body:'<body style="height:10000px"><article>Timeline</article><input aria-label="Post text"></body>'}));
  await page.route('https://pbs.twimg.com/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="teal"/></svg>'}));
  await page.route('https://video.twimg.com/**',route=>route.fulfill({contentType:'video/webm',body:Buffer.from(bytes)}));
  await page.addInitScript(fs.readFileSync('x-reels.user.js','utf8'));
  await page.goto('https://x.com/home');await page.evaluate(()=>fetch('/i/api/graphql/test/HomeTimeline'));
  const waitCount=async count=>{
   try {await page.waitForFunction(count=>[...document.querySelectorAll('div')].some(e=>e.shadowRoot?.querySelector('.count')?.textContent===count),count,{timeout:5000});}
   catch(e){console.log('Expected',count,'actual',await read());throw e;}
  };
  const read=()=>page.evaluate(()=>{
   const r=[...document.querySelectorAll('div')].find(e=>e.shadowRoot)?.shadowRoot,m=r.querySelector('.stage img,.stage video');
   return {count:r.querySelector('.count').textContent,src:m?.src,fit:m?.style.objectFit,href:r.querySelector('.stage a')?.href,muted:m?.muted,autoplay:m?.autoplay};
  });
  await page.getByRole('button',{name:'▶ Reels'}).waitFor();
  await page.keyboard.press('Alt+Shift+r');await waitCount('1 / 40');
  assert.equal((await read()).href,'https://x.com/i/status/123');assert.equal((await read()).fit,'contain');
  await page.mouse.move(640,400);await page.mouse.wheel(0,100);await waitCount('2 / 40');
  const v=await read();assert.equal(v.src,'https://video.twimg.com/high.mp4');assert.equal(v.href,'https://x.com/i/status/456');assert.equal(v.muted,true);assert.equal(v.autoplay,true);
  await page.waitForFunction(()=>[...document.querySelectorAll('div')].some(e=>{const v=e.shadowRoot?.querySelector('video');return v&&!v.paused&&v.currentTime>0;}));
  await page.keyboard.press('p');assert.equal(await page.locator('video').evaluate(v=>v.paused),true);
  await page.getByRole('button',{name:'Pause or play video'}).click();assert.equal(await page.locator('video').evaluate(v=>v.paused),false);
  await page.mouse.wheel(0,600);await waitCount('8 / 40');
  await page.mouse.wheel(0,-600);await waitCount('2 / 40');
  await page.locator('video').evaluate(v=>{const h=v.getRootNode().host;for(let n=0;n<3;n++)h.dispatchEvent(new WheelEvent('wheel',{deltaY:100,bubbles:true,cancelable:true}));});
  await waitCount('5 / 40');
  await page.getByRole('button',{name:'Show entire image or fill frame'}).click();assert.equal((await read()).fit,'cover');
  const popupPromise=page.waitForEvent('popup');await page.getByRole('link',{name:'Open original post'}).click();
  const popup=await popupPromise;await popup.waitForLoadState();assert.equal(popup.url(),'https://x.com/i/status/123');await popup.close();
  await page.getByRole('button',{name:'Set Reels shortcut'}).click();await page.keyboard.press('Alt+q');
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('codex-x-reels-shortcut')).code),'KeyQ');
  await page.keyboard.press('Alt+q');assert.equal(await page.getByRole('button',{name:'▶ Reels'}).isVisible(),true);
  await page.getByRole('textbox',{name:'Post text'}).focus();await page.keyboard.press('Alt+q');assert.equal(await page.getByRole('button',{name:'▶ Reels'}).isVisible(),true);
  await page.getByRole('textbox',{name:'Post text'}).evaluate(el=>el.blur());await page.keyboard.press('Alt+q');await waitCount('5 / 40');
  await page.reload();await page.evaluate(()=>fetch('/i/api/graphql/test/HomeTimeline'));await waitCount('1 / 40');
  await page.keyboard.press('Alt+q');assert.equal(await page.getByRole('button',{name:'▶ Reels'}).isVisible(),true);
  console.log('PASS: fast/burst/reverse scrolling; original-post links; real muted autoplay, pause/resume; saved configurable shortcut and typing exclusion; fit; dedup/ad/text omission; remembered auto-start. Offline X-shaped responses, not live account.');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
