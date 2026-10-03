const fs=require('fs'),assert=require('assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 try {
  const context=await browser.newContext(),page=await context.newPage(),writes=[];
  await context.addCookies([{name:'ct0',value:'test-fresh-csrf',url:'https://x.com'}]);
  await context.route('https://x.com/**',r=>{
   const req=r.request(),url=req.url();
   if(req.method()==='POST'&&/\/(FavoriteTweet|CreateBookmark)$/.test(url)){
    const body=req.postDataJSON(),id=body.variables.tweet_id;
    writes.push({url,id,headers:req.headers(),body});
    if(id==='789')return r.fulfill({status:429,json:{errors:[{code:88}]}});
    if(id==='790')return r.fulfill({json:{errors:[{code:999,message:'rejected'}]}});
    if(id==='791')return r.fulfill({json:{data:{}}});
    if(id==='792')return r.abort('failed');
    const data=url.endsWith('FavoriteTweet')?{favorite_tweet:'Done'}:{tweet_bookmark_put:'Done'};
    return r.fulfill({json:{data}});
   }
   if(url.includes('HomeTimeline'))return r.fulfill({json:{media:['123','456','789','790','791','792'].map((id,i)=>({id_str:String(i+1),type:'photo',media_url_https:`https://pbs.twimg.com/media/${i+1}.jpg`,expanded_url:`https://x.com/artist/status/${id}/photo/1`}))}});
   if(url.includes('/i/api/'))return r.fulfill({json:{data:{}}});
   return r.fulfill({contentType:'text/html; charset=utf-8',body:'<body style="height:10000px"><article data-testid="tweet"><a href="/artist/status/123"><time>Now</time></a><button data-testid="like">Like</button><button data-testid="bookmark">Bookmark</button></article><input aria-label="Post text"><script>window.nativeClicks=0;document.querySelectorAll("article button").forEach(b=>b.onclick=()=>{window.nativeClicks++;b.dataset.testid=b.dataset.testid==="like"?"unlike":"removeBookmark";});</script></body>'});
  });
  await context.route('https://pbs.twimg.com/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>'}));
  await context.addInitScript(fs.readFileSync('x-reels.user.js','utf8'));
  await page.goto('https://x.com/home');await page.evaluate(()=>fetch('/i/api/graphql/test/HomeTimeline'));
  await page.getByRole('button',{name:'▶ Reels'}).click();
  const note=page.locator('.notice');
  await page.keyboard.press('l');await note.filter({hasText:'Liked post 123.'}).waitFor();
  assert.equal(await page.evaluate(()=>window.nativeClicks),1);
  await page.getByRole('button',{name:'Next media'}).click();
  await page.keyboard.press('l');await note.filter({hasText:'Session not ready.'}).waitFor();assert.equal(writes.length,0);
  // Capture headers from Request + init overrides, without exposing any actual credentials.
  await page.evaluate(()=>fetch(new Request(location.origin+'/i/api/graphql/test/HomeTimeline',{headers:{authorization:'Bearer test-session'}}),{headers:{'x-csrf-token':'test-old-csrf'}}));
  await page.keyboard.down('l');await page.keyboard.down('l');await page.keyboard.up('l');
  await note.filter({hasText:'Liked post 456.'}).waitFor();
  assert.equal(writes.length,1);assert.equal(writes[0].id,'456');assert.equal(writes[0].headers['x-csrf-token'],'test-fresh-csrf');assert.equal(writes[0].headers.authorization,'Bearer test-session');
  assert.equal(writes[0].body.queryId,'lI07N6Otwv1PhnEgXILM7A');
  await page.keyboard.press('l');await note.filter({hasText:'Already liked post 456.'}).waitFor();assert.equal(writes.length,1);
  // Observe X's newer query ID and headers over XHR; later background requests should use them.
  await page.evaluate(()=>new Promise(resolve=>{const xhr=new XMLHttpRequest();xhr.open('GET','/i/api/graphql/newBookmarkQuery/CreateBookmark');xhr.setRequestHeader('authorization','Bearer test-xhr-session');xhr.onload=resolve;xhr.send();}));
  await page.keyboard.press('b');await note.filter({hasText:'Bookmarked post 456.'}).waitFor();
  assert(writes[1].url.includes('/newBookmarkQuery/CreateBookmark'));assert.equal(writes[1].headers.authorization,'Bearer test-xhr-session');
  await page.keyboard.press('b');await note.filter({hasText:'Already bookmarked post 456.'}).waitFor();assert.equal(writes.length,2);
  await page.getByRole('button',{name:'Next media'}).click();await page.keyboard.press('l');await note.filter({hasText:'X rate limit reached.'}).waitFor();
  await page.getByRole('button',{name:'Next media'}).click();await page.keyboard.press('b');await note.filter({hasText:'X did not accept'}).waitFor();
  await page.getByRole('button',{name:'Next media'}).click();await page.keyboard.press('l');await note.filter({hasText:'X did not confirm'}).waitFor();
  await page.getByRole('button',{name:'Next media'}).click();await page.keyboard.press('l');await note.filter({hasText:'could not be confirmed'}).waitFor();
  assert.equal(writes.length,6);assert.equal(context.pages().length,1,'Like/bookmark must never open a tab');
  const stored=await page.evaluate(()=>JSON.stringify({...localStorage}));
  assert(!stored.includes('test-session')&&!stored.includes('test-xhr-session')&&!stored.includes('test-fresh-csrf'),'Session headers must never persist');
  assert(!fs.readFileSync('x-reels.user.js','utf8').includes('window.open('),'No tab-opening fallback remains');
  console.log('PASS: native loaded-post action; no-tab background like/bookmark; session readiness; fetch/XHR header capture; current CSRF; observed query IDs; duplicate protection; explicit API success; rate-limit, GraphQL, malformed-response and network failures; no automatic retries or credential persistence. Mock X API only.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
