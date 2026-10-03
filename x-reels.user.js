// ==UserScript==
// @name         X Reels — media viewer
// @namespace    local.codex.x-reels
// @version      1.4.0
// @description  One photo or video per screen. Wheel, swipe or arrow keys to browse your current X feed.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// ==/UserScript==

(() => {
  'use strict';
  if (!/^https:\/\/(?:x|twitter)\.com\//.test(location.href)) return;
  const pendingActions = new Set();
  function findPostArticle(postId) {
    return [...document.querySelectorAll('article[data-testid="tweet"]')].find(article =>
      [...article.querySelectorAll('a[href*="/status/"]')].filter(link =>
        link.querySelector('time') && link.closest('article') === article &&
        link.getAttribute('href').match(/\/status\/(\d+)/)
      )[0]?.getAttribute('href').match(/\/status\/(\d+)/)?.[1] === postId
    );
  }
  function actionButton(postId, action, done = false) {
    const article = findPostArticle(postId);
    const testId = action === 'like' ? (done ? 'unlike' : 'like') : (done ? 'removeBookmark' : 'bookmark');
    return article?.querySelector(`[data-testid="${testId}"]`);
  }
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function addToPost(postId, action, waitForPost = false) {
    const deadline = Date.now() + (waitForPost ? 20000 : 1000);
    while (!actionButton(postId, action) && !actionButton(postId, action, true) && Date.now() < deadline) {
      await delay(150);
    }
    if (actionButton(postId, action, true)) return { ok: true, already: true };
    const button = actionButton(postId, action);
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') {
      return { ok: false, error: 'The post action is unavailable. Check that you are signed in.' };
    }
    button.click();
    const verifyDeadline = Date.now() + 10000;
    while (Date.now() < verifyDeadline) {
      if (actionButton(postId, action, true)) {
        // Wait for the initial optimistic UI update to settle before reporting success.
        await delay(1000);
        if (actionButton(postId, action, true)) return { ok: true, already: false };
        return { ok: false, error: 'X did not keep the change. Check the original post.' };
      }
      await delay(150);
    }
    return { ok: false, error: 'X did not confirm the action. Check the original post.' };
  }
  const KEY = 'codex-x-reels-enabled';
  const SHORTCUT_KEY = 'codex-x-reels-shortcut';
  let shortcut = { code: 'KeyR', alt: true, ctrl: false, shift: true, meta: false };
  try {
    const saved = JSON.parse(localStorage.getItem(SHORTCUT_KEY));
    if (saved && typeof saved.code === 'string') shortcut = saved;
  } catch {}
  let recordingShortcut = false, wheelPixels = 0, wheelDirection = 0, wheelTime = 0, wheelFrame = 0;
  let pendingSteps = 0, manuallyPaused = false;
  const items = [], seen = new Map();
  let host, root, stage, status, launcher, index = 0;
  let enabled = false, muted = true, contain = true;
  let dragPointer = null, dragFrame = 0, dragFraction = 0;
  let loader = null, misses = 0, lastSize = 0, lastPump = 0;
  let originalScroll = 0;
  const isFeed = () => !/\/(status|messages|compose|settings|i\/chat)(\/|$)/.test(location.pathname);
  const mediaURL = value => {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && /(^|\.)(twimg\.com)$/.test(u.hostname) ? u.href : null;
    } catch { return null; }
  };

  // Read media URLs from timeline responses X already requested.
  function ingest(data) {
    const stack = [{ value: data, postId: null }];
    while (stack.length) {
      const entry = stack.pop();
      const o = entry.value;
      if (!o || typeof o !== 'object') continue;
      if (o.promotedMetadata || o.promoted_metadata) continue;
      const postId = (o.__typename === 'Tweet' && o.rest_id) ||
        (o.id_str && (o.full_text !== undefined || o.extended_entities || o.entities) && o.id_str) || entry.postId;
      if (['photo', 'video', 'animated_gif'].includes(o.type) && o.media_url_https) {
        const poster = mediaURL(o.media_url_https);
        const variants = (o.video_info?.variants || []).filter(v =>
          v.content_type === 'video/mp4' && mediaURL(v.url)
        ).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        const src = o.type === 'photo' ? poster : mediaURL(variants[0]?.url);
        if (src && poster) {
          const key = String(o.id_str || o.id || poster);
          const expanded = String(o.expanded_url || '').match(/^https:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/);
          const ownerId = expanded?.[1] || o.source_status_id_str || postId;
          const postURL = /^\d+$/.test(String(ownerId)) ? `https://x.com/i/status/${ownerId}` : null;
          const item = { key, type: o.type === 'photo' ? 'image' : 'video', src, poster, postURL };
          if (!seen.has(key)) {
            seen.set(key, items.length);
            items.push(item);
          } else if (item.type === 'video') {
            const previous = items[seen.get(key)];
            items[seen.get(key)] = { ...item, postURL: item.postURL || previous.postURL };
          } else if (postURL && !items[seen.get(key)].postURL) {
            items[seen.get(key)].postURL = postURL;
          }
        }
      }
      const values = Object.values(o);
      for (let n = values.length - 1; n >= 0; n--) {
        const v = values[n];
        if (v && typeof v === 'object') stack.push({ value: v, postId });
      }
    }
    if (enabled && items.length) {
      if (pendingSteps && index + 1 < items.length) {
        const advance = Math.min(pendingSteps, items.length - 1 - index);
        index += advance; pendingSteps -= advance; render();
      }
      else if (!stage.firstElementChild) render();
      updateStatus();
    }
  }
  const timeline = url => /\/graphql\/.*\/(HomeTimeline|HomeLatestTimeline|SearchTimeline|UserTweets|UserMedia|UserTweetsAndReplies|ListLatestTweets)(\?|$)/.test(String(url));
  const nativeFetch = window.fetch;
  // Session headers stay in this page's memory. They are never saved, logged,
  // exported, or sent anywhere except the same-origin X API.
  const sessionHeaders = new Headers();
  const actionQueryIds = {
    FavoriteTweet: 'lI07N6Otwv1PhnEgXILM7A',
    CreateBookmark: 'aoDbu3RHznuiSkQ9aNM67Q'
  };
  const completedActions = new Set();
  const apiURL = value => {
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin && url.pathname.startsWith('/i/api/') ? url : null;
    } catch { return null; }
  };
  function captureHeaders(value, headers) {
    const url = apiURL(value); if (!url) return;
    const source = new Headers(headers);
    for (const name of ['authorization', 'x-csrf-token', 'x-twitter-auth-type', 'x-twitter-active-user', 'x-twitter-client-language']) {
      if (source.has(name)) sessionHeaders.set(name, source.get(name));
    }
    // Prefer the current IDs used by X over the bundled fallback IDs.
    const op = url.pathname.match(/\/graphql\/([A-Za-z0-9_-]+)\/(FavoriteTweet|CreateBookmark)$/);
    if (op) actionQueryIds[op[2]] = op[1];
  }
  window.fetch = async function(...args) {
    try {
      const headers = new Headers(args[0] instanceof Request ? args[0].headers : undefined);
      new Headers(args[1]?.headers).forEach((value, name) => headers.set(name, value));
      captureHeaders(args[0]?.url || args[0], headers);
    } catch {}
    const response = await nativeFetch.apply(this, args);
    if (timeline(args[0]?.url || args[0])) response.clone().json().then(ingest).catch(() => {});
    return response;
  };
  const xhrInfo = new WeakMap();
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    xhrInfo.set(this, { url, headers: new Headers() });
    if (timeline(url)) this.addEventListener('load', () => {
      try { ingest(this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); } catch {}
    }, { once: true });
    return nativeOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    const result = nativeSetHeader.call(this, name, value);
    try { xhrInfo.get(this)?.headers.set(name, value); } catch {}
    return result;
  };
  XMLHttpRequest.prototype.send = function(...args) {
    const info = xhrInfo.get(this);
    if (info) captureHeaders(info.url, info.headers);
    return nativeSend.apply(this, args);
  };
  async function backgroundAction(postId, action) {
    if (!/^\d+$/.test(postId) || !['like', 'bookmark'].includes(action)) {
      return { ok: false, error: 'No valid original post is available.' };
    }
    const headers = new Headers(sessionHeaders);
    const csrfCookie = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('ct0='));
    if (csrfCookie) {
      try { headers.set('x-csrf-token', decodeURIComponent(csrfCookie.slice(4))); } catch {}
    }
    if (!headers.has('authorization') || !headers.has('x-csrf-token')) {
      return { ok: false, error: 'Session not ready. Refresh X while signed in, then try again.' };
    }
    headers.set('content-type', 'application/json');
    headers.set('x-twitter-active-user', 'yes');
    headers.set('x-twitter-auth-type', 'OAuth2Session');
    const operation = action === 'like' ? 'FavoriteTweet' : 'CreateBookmark';
    const queryId = actionQueryIds[operation];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await nativeFetch.call(window, `${location.origin}/i/api/graphql/${queryId}/${operation}`, {
        method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify({ variables: { tweet_id: postId }, queryId }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.errors?.length) {
        if (action === 'like' && data?.errors?.length === 1 && data.errors[0].code === 139) return { ok: true, already: true };
        const reason = response.status === 429 ? 'X rate limit reached. Try later.' :
          [401, 403].includes(response.status) ? 'X rejected the background action. Refresh your session or use the original post.' :
          'X did not accept the background action. Open the original post to check.';
        return { ok: false, error: reason };
      }
      const value = data?.data?.[action === 'like' ? 'favorite_tweet' : 'tweet_bookmark_put'];
      return value === 'Done' || value === true ? { ok: true, already: false } :
        { ok: false, error: 'X did not confirm the action. Open the original post to check.' };
    } catch {
      // A timeout may still have reached X. Never replay a write automatically.
      return { ok: false, error: 'The action could not be confirmed. Check the original post before retrying.' };
    } finally { clearTimeout(timer); }
  }

  function updateStatus() {
    if (!status) return;
    status.textContent = items.length ? `${index + 1} / ${items.length}` : 'Loading media…';
    root.querySelector('.loaded-total').textContent = items.length;
    root.querySelector('.last-item').textContent = items.length || '—';
    const track = root.querySelector('.track');
    const fraction = items.length > 1 ? index / (items.length - 1) : 0;
    track.style.setProperty('--position', `${fraction * 100}%`);
    track.setAttribute('aria-valuemax', String(Math.max(1, items.length)));
    track.setAttribute('aria-valuenow', String(items.length ? index + 1 : 1));
    track.setAttribute('aria-valuetext', items.length ? `Item ${index + 1} of ${items.length} loaded` : 'No media loaded yet');
    track.setAttribute('aria-disabled', String(!items.length));
    track.tabIndex = items.length ? 0 : -1;
  }
  function jumpTo(next) {
    if (!items.length) return;
    pendingSteps = 0; wheelPixels = 0;
    next = Math.max(0, Math.min(items.length - 1, Math.round(next)));
    if (next !== index) { index = next; render(); }
    pump();
  }
  function dragTo(clientY, immediate = false) {
    const rect = root.querySelector('.track').getBoundingClientRect();
    dragFraction = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    if (immediate) jumpTo(dragFraction * (items.length - 1));
    else if (!dragFrame) dragFrame = requestAnimationFrame(() => {
      dragFrame = 0;
      if (enabled && dragPointer !== null) jumpTo(dragFraction * (items.length - 1));
    });
  }
  function render() {
    if (!enabled || !items[index]) return;
    const old = stage.querySelector('video');
    if (old) { old.pause(); old.removeAttribute('src'); old.load(); }
    stage.replaceChildren();
    root.querySelector('.notice')?.remove();
    const item = items[index];
    const el = document.createElement(item.type === 'video' ? 'video' : 'img');
    el.style.objectFit = contain ? 'contain' : 'cover';
    manuallyPaused = false;
    if (item.type === 'video') {
      el.poster = item.poster; el.muted = muted; el.loop = true;
      el.defaultMuted = muted; el.autoplay = true; el.preload = 'auto';
      el.playsInline = true; el.controls = false;
      const play = () => {
        if (el.isConnected && enabled && !manuallyPaused) el.play().catch(() => {
          if (el.isConnected && enabled) message('Autoplay was blocked. Press P or the Play button.');
        });
      };
      el.addEventListener('loadeddata', play);
      el.addEventListener('error', () => { if (el.isConnected) message('This video could not play. Scroll to skip it.'); });
    } else {
      el.alt = 'Photo from your X feed';
      el.addEventListener('error', () => message('This image could not load. Scroll to skip it.'));
    }
    el.src = item.src;
    if (item.postURL) {
      const link = document.createElement('a');
      link.href = item.postURL; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.title = 'Open original post'; link.setAttribute('aria-label', 'Open original post');
      link.append(el); stage.append(link);
    } else {
      el.onclick = () => message('X did not include a post link for this item.');
      stage.append(el);
    }
    root.querySelector('.play').hidden = item.type !== 'video';
    root.querySelector('.play').textContent = 'Pause';
    updateActionButtons();
    if (item.type === 'video') el.play().catch(() => {
      if (el.isConnected && enabled) {
        root.querySelector('.play').textContent = 'Play';
        message('Autoplay was blocked. Press P or the Play button.');
      }
    });
    updateStatus(); misses = 0;
  }
  function message(text) {
    let note = root.querySelector('.notice');
    if (!note) { note = document.createElement('div'); note.className = 'notice'; root.append(note); }
    note.textContent = text;
    clearTimeout(message.timer);
    message.timer = setTimeout(() => note.remove(), 4500);
  }
  function step(distance) {
    if (distance < 0) pendingSteps = 0;
    const target = index + distance;
    const next = Math.max(0, Math.min(items.length - 1, target));
    if (next !== index && items.length) { index = next; render(); }
    if (distance > 0 && target >= items.length) {
      // Keep the requested distance while more media loads, without an unbounded queue.
      pendingSteps = Math.min(30, pendingSteps + target - Math.max(0, items.length - 1));
      misses = 0; message('Loading more media…');
    }
    pump();
  }
  function gesture(direction) {
    step(direction);
  }
  function pump() {
    const now = performance.now();
    if (!enabled || !isFeed() || items.length - index > 30 || misses >= 20 || now - lastPump < 700) return;
    lastPump = now;
    if (items.length === lastSize) misses++; else misses = 0;
    lastSize = items.length;
    window.scrollBy({ top: Math.max(650, innerHeight * .85), behavior: 'instant' });
    if (misses === 20) message('X has not loaded more media. Close Reels, check the feed, then reopen.');
  }
  function toggle(value) {
    if (enabled === value) return;
    enabled = value;
    wheelPixels = 0; wheelDirection = 0;
    cancelAnimationFrame(wheelFrame); wheelFrame = 0;
    cancelAnimationFrame(dragFrame); dragFrame = 0;
    if (dragPointer !== null) {
      const track = root.querySelector('.track');
      try { track.releasePointerCapture(dragPointer); } catch {}
      dragPointer = null;
    }
    try { localStorage.setItem(KEY, value ? '1' : '0'); } catch {}
    host.style.display = value ? 'block' : 'none';
    launcher.hidden = value;
    if (value) {
      originalScroll = window.scrollY;
      render(); updateStatus();
      if (!items.length) message('Waiting for X media. If this stays empty, refresh X once.');
      misses = 0; lastPump = -Infinity; pump(); loader = setInterval(pump, 800);
    } else {
      clearInterval(loader); loader = null; pendingSteps = 0;
      const video = stage.querySelector('video');
      if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
      stage.replaceChildren();
      window.scrollTo({ top: originalScroll, behavior: 'instant' });
    }
  }
  function shortcutLabel() {
    return [shortcut.ctrl && 'Ctrl', shortcut.alt && 'Alt', shortcut.shift && 'Shift', shortcut.meta && 'Meta', shortcut.code.replace(/^(Key|Digit)/, '')].filter(Boolean).join('+');
  }
  function updateShortcutUI() {
    launcher.title = `Toggle Reels: ${shortcutLabel()}. Right-click to change shortcut.`;
    root.querySelector('.keys').title = `Change shortcut (currently ${shortcutLabel()})`;
  }
  function recordShortcut() {
    recordingShortcut = true;
    const help = document.createElement('div'); help.className = 'shortcut-help';
    help.textContent = 'Press your new shortcut (include Ctrl or Alt). Esc cancels.';
    help.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#222;color:#fff;padding:16px 24px;border-radius:16px;font:14px system-ui';
    document.querySelector('#x-reels-shortcut-help')?.remove();
    help.id = 'x-reels-shortcut-help'; document.body.append(help);
  }
  function togglePlayback() {
    const v = stage.querySelector('video'); if (!v) return;
    manuallyPaused = !v.paused;
    if (manuallyPaused) v.pause(); else v.play().catch(() => message('Video could not start.'));
    root.querySelector('.play').textContent = manuallyPaused ? 'Play' : 'Pause';
  }
  function updateActionButtons() {
    const postId = items[index]?.postURL?.match(/\/status\/(\d+)/)?.[1];
    for (const action of ['like', 'bookmark']) {
      const button = root.querySelector(`.${action}`);
      button.disabled = !postId || pendingActions.has(`${postId}:${action}`);
    }
  }
  async function actOnCurrentPost(action) {
    const postId = items[index]?.postURL?.match(/\/status\/(\d+)/)?.[1];
    if (!postId) { message('No original post link is available for this item.'); return; }
    const key = `${postId}:${action}`;
    if (pendingActions.has(key)) return;
    pendingActions.add(key); updateActionButtons();
    message(`${action === 'like' ? 'Liking' : 'Bookmarking'} post ${postId}…`);
    try {
      let result;
      if (actionButton(postId, action) || actionButton(postId, action, true)) {
        result = await addToPost(postId, action);
      } else {
        result = completedActions.has(key) ? { ok: true, already: true } : await backgroundAction(postId, action);
      }
      if (result.ok) completedActions.add(key);
      const label = action === 'like' ? 'Liked' : 'Bookmarked';
      message(result.ok ? `${result.already ? 'Already ' + label.toLowerCase() : label} post ${postId}.` : result.error);
    } catch {
      message('Could not complete the action. Open the original post to check.');
    } finally {
      pendingActions.delete(key); updateActionButtons();
    }
  }
  function mount() {
    if (!document.body) { setTimeout(mount, 30); return; }
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:none;background:#000';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      *{box-sizing:border-box} :host{color:#fff;font-family:system-ui,sans-serif}
      .viewer{position:absolute;inset:0;background:#000;touch-action:none;--rail-width:88px}
      .stage{position:absolute;left:20px;right:calc(var(--rail-width) + 20px);top:64px;bottom:64px;background:#000;overflow:hidden}
      img,video,.stage>a{width:100%;height:100%;display:block}
      .stage>a{cursor:pointer} [hidden]{display:none!important}
      .bar{position:absolute;top:12px;right:calc(var(--rail-width) + 16px);left:16px;display:flex;gap:8px;justify-content:flex-end;align-items:center;flex-wrap:wrap}
      button,.count{color:white;background:#242424c9;border:1px solid #ffffff35;border-radius:24px;padding:9px 13px;font:13px system-ui;cursor:pointer}
      button:hover{background:#444}button:disabled{opacity:.5;cursor:default}.notice{position:absolute;bottom:50px;left:50%;transform:translateX(-50%);max-width:85vw;background:#242424dd;padding:12px 18px;border-radius:16px;font-size:14px;text-align:center}
      .actions{position:absolute;left:12px;bottom:20px;display:flex;gap:8px}
      .rail{position:absolute;right:0;top:0;bottom:0;width:var(--rail-width);background:#0d1117;border-left:1px solid #303946;display:flex;align-items:center;flex-direction:column;user-select:none}
      .loaded{padding-top:17px;text-align:center;font-size:11px;color:#9aa6b8;line-height:1.5}
      .loaded-total{display:block;font-size:22px;line-height:1.2;color:#fff;font-weight:650}
      .count{font-size:12px;padding:5px 8px;margin-top:7px;cursor:default;white-space:nowrap}
      .track{position:absolute;top:135px;bottom:110px;width:34px;cursor:pointer;touch-action:none;--position:0%}
      .track:before{content:'';position:absolute;top:0;bottom:0;left:11px;width:12px;border:1px solid #394555;background:#252d39;border-radius:12px}
      .track:focus-visible{outline:2px solid #8bdcff;outline-offset:6px;border-radius:10px}
      .thumb{position:absolute;top:var(--position);left:50%;transform:translate(-50%,-50%);width:24px;height:30px;border-radius:8px;background:#7dd5ff;box-shadow:0 0 0 4px #162936;cursor:grab}
      .track:active .thumb{cursor:grabbing}
      .track[aria-disabled=true]{opacity:.4;cursor:default}
      .first-item,.last-item{position:absolute;font-size:12px;color:#8592a5}.first-item{top:110px}.last-item{bottom:76px}
      .arrows{position:absolute;bottom:18px;display:flex;gap:5px}.arrows button{padding:7px 10px}
      @media(max-width:600px){.viewer{--rail-width:64px}.stage{left:4px;right:68px;top:106px;bottom:64px}.bar{top:8px;left:4px;right:72px;gap:4px}.bar button{padding:7px 9px}.count{font-size:10px;padding:4px}.loaded-total{font-size:19px}.actions{left:4px;bottom:14px;gap:4px}.actions button{padding:8px;font-size:11px}.arrows button{padding:6px 8px}}
      @media(max-height:420px){.track{top:112px;bottom:80px}.first-item{top:90px}.last-item{bottom:52px}.arrows{bottom:10px}.loaded{padding-top:10px}.stage{top:56px;bottom:56px}}
    </style><div class="viewer"><div class="stage"></div>
      <div class="bar"><button class="play" hidden aria-label="Pause or play video">Pause</button><button class="sound" aria-label="Toggle video sound">Muted</button><button class="fit" aria-label="Show entire image or fill frame">Fill</button><button class="keys" aria-label="Set Reels shortcut">Keys</button><button class="close" aria-label="Close Reels">✕</button></div>
      <div class="rail"><div class="loaded"><strong class="loaded-total">0</strong>loaded items</div><span class="count"></span><span class="first-item">1</span>
        <div class="track" role="slider" aria-label="Jump to loaded media" aria-orientation="vertical" aria-valuemin="1" aria-valuemax="1" aria-valuenow="1" aria-disabled="true" tabindex="-1"><span class="thumb"></span></div>
        <span class="last-item">—</span><div class="arrows"><button class="prev" aria-label="Previous media">↑</button><button class="next" aria-label="Next media">↓</button></div></div>
      <div class="actions"><button class="like" aria-label="Like current post" title="L: like (does not unlike)">♡ Like · L</button><button class="bookmark" aria-label="Bookmark current post" title="B: bookmark (does not remove)">Bookmark · B</button></div>
    </div>`;
    stage = root.querySelector('.stage'); status = root.querySelector('.count');
    const track = root.querySelector('.track');
    track.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !items.length) return;
      e.preventDefault(); e.stopPropagation();
      dragPointer = e.pointerId; track.setPointerCapture(e.pointerId); track.focus();
      dragTo(e.clientY, true);
    });
    track.addEventListener('pointermove', e => {
      if (e.pointerId === dragPointer) { e.preventDefault(); e.stopPropagation(); dragTo(e.clientY); }
    });
    const finishDrag = e => {
      if (e.pointerId !== dragPointer) return;
      if (e.type === 'pointerup') dragTo(e.clientY, true);
      cancelAnimationFrame(dragFrame); dragFrame = 0;
      dragPointer = null;
      if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
    };
    track.addEventListener('pointerup', finishDrag);
    track.addEventListener('pointercancel', finishDrag);
    track.addEventListener('lostpointercapture', () => { dragPointer = null; cancelAnimationFrame(dragFrame); dragFrame = 0; });
    updateStatus();
    root.querySelector('.close').onclick = () => toggle(false);
    root.querySelector('.prev').onclick = () => step(-1);
    root.querySelector('.next').onclick = () => step(1);
    root.querySelector('.keys').onclick = recordShortcut;
    root.querySelector('.play').onclick = togglePlayback;
    root.querySelector('.like').onclick = () => actOnCurrentPost('like');
    root.querySelector('.bookmark').onclick = () => actOnCurrentPost('bookmark');
    updateActionButtons();
    root.querySelector('.sound').onclick = e => {
      muted = !muted; e.target.textContent = muted ? 'Muted' : 'Sound';
      const v = stage.querySelector('video'); if (v) v.muted = muted;
    };
    root.querySelector('.fit').onclick = e => {
      contain = !contain; e.target.textContent = contain ? 'Fill' : 'Fit';
      const media = stage.querySelector('img,video');
      if (media) media.style.objectFit = contain ? 'contain' : 'cover';
    };
    host.addEventListener('wheel', e => {
      e.preventDefault(); e.stopPropagation();
      if (!e.deltaY) return;
      const now = performance.now(), direction = Math.sign(e.deltaY);
      if (now - wheelTime > 220 || direction !== wheelDirection) wheelPixels = 0;
      const newGesture = now - wheelTime > 220 || direction !== wheelDirection;
      wheelTime = now; wheelDirection = direction;
      const delta = e.deltaY * (e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? innerHeight : 1);
      // A normal mouse notch advances one item. Faster/larger input advances more;
      // trackpad pixel deltas accumulate, and rendering is coalesced per frame.
      wheelPixels += delta;
      if (newGesture && Math.abs(delta) >= 4 && Math.abs(wheelPixels) < 100) wheelPixels = direction * 100;
      if (!wheelFrame) wheelFrame = requestAnimationFrame(() => {
        wheelFrame = 0;
        if (!enabled) return;
        const count = Math.trunc(wheelPixels / 100);
        if (count) { wheelPixels -= count * 100; step(count); }
      });
    }, { passive: false });
    let startY = null;
    host.addEventListener('touchstart', e => { startY = e.composedPath().includes(track) ? null : e.touches[0].clientY; }, { passive: true });
    host.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
    host.addEventListener('touchend', e => {
      if (startY !== null) {
        const delta = startY - e.changedTouches[0].clientY;
        if (Math.abs(delta) > 45) gesture(Math.sign(delta));
        startY = null;
      }
    });
    window.addEventListener('keydown', e => {
      if (recordingShortcut) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.key === 'Escape') {
          recordingShortcut = false; document.querySelector('#x-reels-shortcut-help')?.remove();
        } else if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key) && (e.ctrlKey || e.altKey)) {
          shortcut = { code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
          try { localStorage.setItem(SHORTCUT_KEY, JSON.stringify(shortcut)); } catch {}
          recordingShortcut = false; document.querySelector('#x-reels-shortcut-help')?.remove();
          updateShortcutUI();
          if (enabled) message(`Reels shortcut: ${shortcutLabel()}`);
        }
        return;
      }
      const editing = e.composedPath().some(n => n instanceof Element &&
        (n.matches('input,textarea,select') || n.isContentEditable));
      if (editing) return;
      if (e.code === shortcut.code && e.ctrlKey === !!shortcut.ctrl && e.altKey === !!shortcut.alt &&
          e.shiftKey === !!shortcut.shift && e.metaKey === !!shortcut.meta && isFeed()) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (!e.repeat) toggle(!enabled);
        return;
      }
      if (!enabled) return;
      if (e.composedPath()[0] === track && ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.key === 'Home') jumpTo(0);
        else if (e.key === 'End') jumpTo(items.length - 1);
        else jumpTo(index + (['ArrowUp', 'ArrowLeft', 'PageUp'].includes(e.key) ? -1 : 1) * (e.key.startsWith('Page') ? 10 : 1));
        return;
      }
      if (['KeyL', 'KeyB'].includes(e.code) && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (!e.repeat) actOnCurrentPost(e.code === 'KeyL' ? 'like' : 'bookmark');
      } else if (e.code === 'KeyP' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault(); e.stopImmediatePropagation(); togglePlayback();
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation(); toggle(false);
      }
      else if (['ArrowDown', 'PageDown', ' ', 'ArrowUp', 'PageUp'].includes(e.key)) {
        e.preventDefault(); e.stopImmediatePropagation();
        gesture(['ArrowUp', 'PageUp'].includes(e.key) ? -1 : 1);
      }
    }, true);
    launcher = document.createElement('button'); launcher.textContent = '▶ Reels';
    launcher.style.cssText = 'position:fixed;right:24px;bottom:90px;z-index:2147483646;background:#111;color:#fff;border:1px solid #888;border-radius:28px;padding:14px 22px;font:bold 15px system-ui;cursor:pointer';
    launcher.onclick = () => toggle(true);
    launcher.oncontextmenu = e => { e.preventDefault(); recordShortcut(); };
    updateShortcutUI();
    document.body.append(host, launcher);
    try { if (localStorage.getItem(KEY) === '1' && isFeed()) toggle(true); } catch {}
    setInterval(() => {
      if (!isFeed()) { if (enabled) toggle(false); launcher.hidden = true; }
      else launcher.hidden = enabled;
    }, 1000);
  }
  mount();
})();
