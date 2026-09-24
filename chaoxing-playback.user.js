// ==UserScript==
// @name         学习通视频与 PPT 连播助手
// @namespace    local.chaoxing.playback
// @version      0.2.3
// @description  顺序处理未完成的视频与 PPT 任务，等待平台完成标记后切换。
// @homepageURL  https://github.com/FH150174/chaoxing-playback-helper
// @supportURL   https://github.com/FH150174/chaoxing-playback-helper/issues
// @updateURL    https://raw.githubusercontent.com/FH150174/chaoxing-playback-helper/main/chaoxing-playback.user.js
// @downloadURL  https://raw.githubusercontent.com/FH150174/chaoxing-playback-helper/main/chaoxing-playback.user.js
// @license      MIT
// @match        https://*.chaoxing.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const ROOT_PATH = /\/mycourse\/studentstudy\/?$/;
  let root;
  try {
    root = window.top;
    if (!ROOT_PATH.test(root.location.pathname)) return;
  } catch {
    return; // 无法安全读取课程页的跨域框架，不在未知页面运行。
  }

  const courseUrl = new URL(root.location.href);
  const courseId = courseUrl.searchParams.get('courseId');
  const clazzId = courseUrl.searchParams.get('clazzid');
  if (!courseId || !clazzId) return;
  const storageKey = 'cx-playback:' + courseId + ':' + clazzId;
  const defaults = { enabled: false, speed: 2, background: true, muted: true };
  const isRoot = window === root;
  let panelStatus = null;
  let lastLocation = root.location.href;
  let lastNavigation = Date.now();
  let pendingChapterId = null;
  let pendingTabIndex = null;
  let scanFromBeginning = true;
  let waitingForMedia = 0;
  let endedAt = 0;
  let documentScroll = null;
  let stallAt = 0;
  let lastTime = -1;
  let busy = false;
  let pendingWake = false;
  const observedDocs = new WeakSet();
  const guardedDocs = new WeakSet();
  const watchedMedia = new WeakSet();
  const mediaSpeedStates = new WeakMap();
  let lastStatus = '';

  function readSettings() {
    try {
      const saved = JSON.parse(root.sessionStorage.getItem(storageKey) || '{}');
      return {
        enabled: saved.enabled === true,
        speed: [1, 1.5, 2].includes(saved.speed) ? saved.speed : defaults.speed,
        background: saved.background !== false,
        muted: saved.muted !== false
      };
    } catch {
      return { ...defaults };
    }
  }

  function saveSettings(change) {
    const next = { ...readSettings(), ...change };
    root.sessionStorage.setItem(storageKey, JSON.stringify(next));
    return next;
  }

  // 只在助手运行时让页面的失焦检测看到“可见”。浏览器节流及服务器端规则仍由浏览器/网站决定。
  function installBackgroundCompatibility(doc) {
    if (!doc.defaultView) return;
    const native = {};
    for (const prop of ['hidden', 'visibilityState', 'webkitHidden', 'webkitVisibilityState']) {
      let owner = doc;
      while (owner && !Object.getOwnPropertyDescriptor(owner, prop)) owner = Object.getPrototypeOf(owner);
      const descriptor = owner && Object.getOwnPropertyDescriptor(owner, prop);
      if (!descriptor || typeof descriptor.get !== 'function') continue;
      native[prop] = descriptor.get.bind(doc);
      try {
        Object.defineProperty(doc, prop, {
          configurable: true,
          get() {
            const settings = readSettings();
            if (settings.enabled && settings.background) {
              return prop.toLowerCase().includes('state') ? 'visible' : false;
            }
            return native[prop]();
          }
        });
      } catch { /* 页面实现不允许覆盖时，保留原状。 */ }
    }
    const nativeHasFocus = doc.hasFocus.bind(doc);
    try {
      Object.defineProperty(doc, 'hasFocus', {
        configurable: true,
        value: () => {
          const settings = readSettings();
          return settings.enabled && settings.background ? true : nativeHasFocus();
        }
      });
    } catch { /* 保留原状。 */ }
    doc.addEventListener('visibilitychange', (event) => {
      const settings = readSettings();
      if (settings.enabled && settings.background) event.stopImmediatePropagation();
    }, true);
    doc.defaultView.addEventListener('blur', (event) => {
      const settings = readSettings();
      if (settings.enabled && settings.background) event.stopImmediatePropagation();
    }, true);
  }

  installBackgroundCompatibility(document);
  guardedDocs.add(document);
  if (!isRoot) return;

  function setStatus(message) {
    if (message === lastStatus) return;
    lastStatus = message;
    if (panelStatus) panelStatus.textContent = message;
    console.info('[学习通连播]', message);
  }

  function stop(message) {
    saveSettings({ enabled: false });
    syncPanel();
    setStatus(message);
  }

  function syncPanel() {
    const settings = readSettings();
    const button = document.getElementById('cxpb-toggle');
    const speed = document.getElementById('cxpb-speed');
    const background = document.getElementById('cxpb-background');
    const muted = document.getElementById('cxpb-muted');
    if (button) button.textContent = settings.enabled ? '停止连播' : '开始连播';
    if (speed) speed.value = String(settings.speed);
    if (background) background.checked = settings.background;
    if (muted) muted.checked = settings.muted;
  }

  function createPanel() {
    if (!document.body || document.getElementById('cxpb-panel')) return;
    const box = document.createElement('section');
    box.id = 'cxpb-panel';
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:270px;padding:12px;border-radius:10px;background:#17212e;color:#fff;font:13px/1.5 system-ui,Arial;box-shadow:0 4px 20px #0005';
    const title = document.createElement('strong');
    title.textContent = '学习通视频与 PPT 连播';
    title.style.cssText = 'display:block;margin-bottom:8px;font-size:14px';
    box.append(title);
    const button = document.createElement('button');
    button.id = 'cxpb-toggle';
    button.type = 'button';
    button.style.cssText = 'padding:5px 10px;margin-right:8px;cursor:pointer';
    button.addEventListener('click', () => {
      if (readSettings().enabled) stop('已停止');
      else {
        saveSettings({ enabled: true });
        waitingForMedia = 0;
        scanFromBeginning = true;
        documentScroll = null;
        endedAt = 0;
        stallAt = Date.now();
        lastTime = -1;
        setStatus('正在查找未完成的视频或 PPT 任务点…');
        syncPanel();
        tick();
      }
    });
    box.append(button);
    const speedLabel = document.createElement('label');
    speedLabel.textContent = '倍速 ';
    const speed = document.createElement('select');
    speed.id = 'cxpb-speed';
    for (const value of [1, 1.5, 2]) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = String(value) + '×';
      speed.append(option);
    }
    speed.addEventListener('change', () => saveSettings({ speed: Number(speed.value) }));
    speedLabel.append(speed);
    box.append(speedLabel);
    const backgroundLabel = document.createElement('label');
    backgroundLabel.style.cssText = 'display:block;margin-top:8px';
    const background = document.createElement('input');
    background.id = 'cxpb-background';
    background.type = 'checkbox';
    background.addEventListener('change', () => saveSettings({ background: background.checked }));
    backgroundLabel.append(background, document.createTextNode(' 后台播放兼容'));
    box.append(backgroundLabel);
    const muteLabel = document.createElement('label');
    muteLabel.style.cssText = 'display:block';
    const muted = document.createElement('input');
    muted.id = 'cxpb-muted';
    muted.type = 'checkbox';
    muted.addEventListener('change', () => saveSettings({ muted: muted.checked }));
    muteLabel.append(muted, document.createTextNode(' 静音以便自动播放'));
    box.append(muteLabel);
    panelStatus = document.createElement('div');
    panelStatus.id = 'cxpb-status';
    panelStatus.style.cssText = 'margin-top:8px;color:#d5e6ff;word-break:break-word';
    panelStatus.textContent = lastStatus || '准备就绪；点击“开始连播”。';
    box.append(panelStatus);
    document.body.append(box);
    syncPanel();
  }

  function visible(element) {
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
      const style = node.ownerDocument.defaultView.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }

  function accessibleDocuments(startDoc) {
    const results = [];
    const visited = new Set();
    function visit(doc) {
      if (!doc || visited.has(doc)) return;
      visited.add(doc);
      results.push(doc);
      if (!guardedDocs.has(doc)) {
        guardedDocs.add(doc);
        installBackgroundCompatibility(doc);
      }
      if (!observedDocs.has(doc) && doc.documentElement) {
        observedDocs.add(doc);
        const observer = new doc.defaultView.MutationObserver((records) => {
          const taskChanged = records.some((record) =>
            record.type === 'attributes' && record.target.classList?.contains('ans-attach-ct')
          );
          if (taskChanged) tick();
        });
        observer.observe(doc.documentElement, {
          attributes: true,
          attributeFilter: ['class'],
          subtree: true
        });
      }
      for (const frame of doc.querySelectorAll('iframe')) {
        if (!visible(frame)) continue;
        try { visit(frame.contentDocument); } catch { /* 跨域框架不可访问。 */ }
      }
    }
    visit(startDoc);
    return results;
  }

  function findMedia(host) {
    const direct = host.querySelector('video, audio');
    if (direct) return direct;
    for (const frame of host.querySelectorAll('iframe')) {
      try {
        const child = frame.contentDocument;
        if (child) {
          const nested = findMedia(child);
          if (nested) return nested;
        }
      } catch { /* 跨域播放器交由超时处理。 */ }
    }
    return null;
  }

  function documentScrollTargets(task) {
    const candidates = [];
    const seen = new Set();
    function add(element, depth) {
      if (!element || seen.has(element)) return;
      seen.add(element);
      const distance = element.scrollHeight - element.clientHeight;
      if (distance < 8 || element.clientHeight < 70 || !visible(element)) return;
      const doc = element.ownerDocument;
      const style = doc.defaultView.getComputedStyle(element);
      const nativeScroller = element === doc.scrollingElement ||
        element === doc.documentElement || element === doc.body;
      if (!nativeScroller && !/auto|scroll|overlay/.test(style.overflowY)) return;
      const viewer = /viewer|reader|scroll|content/i.test(element.id + ' ' + element.className);
      candidates.push({ element, score: depth * 100 + (viewer ? 20 : 0) + (nativeScroller ? 0 : 10) });
    }
    function scan(doc, depth) {
      add(doc.scrollingElement, depth);
      add(doc.documentElement, depth);
      add(doc.body, depth);
      const elements = doc.querySelectorAll('*');
      for (const element of elements) {
        if (element.tagName !== 'IFRAME') add(element, depth);
      }
      for (const frame of doc.querySelectorAll('iframe')) {
        if (!visible(frame)) continue;
        try {
          if (frame.contentDocument) scan(frame.contentDocument, depth + 1);
        } catch { /* 跨域 PPT 阅读器不能直接滚动。 */ }
      }
    }
    for (const element of task.querySelectorAll('*')) {
      if (element.tagName !== 'IFRAME') add(element, 0);
    }
    for (const frame of task.querySelectorAll('iframe')) {
      if (!visible(frame)) continue;
      try {
        if (frame.contentDocument) scan(frame.contentDocument, 1);
      } catch { /* 跨域 PPT 阅读器不能直接滚动。 */ }
    }
    if (!task.querySelector('iframe')) {
      const doc = task.ownerDocument;
      add(doc.scrollingElement || doc.documentElement, -1);
    }
    return candidates.sort((a, b) => b.score - a.score).map((candidate) => candidate.element);
  }

  function scrollDocumentTask(job) {
    const now = Date.now();
    if (!documentScroll || documentScroll.job !== job.element) {
      documentScroll = { job: job.element, target: null, discoveryAt: now, lastScanAt: 0, bottomAt: 0, stuckAt: 0 };
    }
    const state = documentScroll;
    const needsScan = !state.target || !state.target.isConnected ||
      state.target.scrollHeight - state.target.clientHeight < 8 || now - state.lastScanAt > 10000;
    if (needsScan) {
      const target = documentScrollTargets(job.element)[0] || null;
      state.lastScanAt = now;
      if (state.target !== target) {
        state.target = target;
        state.bottomAt = 0;
        state.stuckAt = 0;
      }
    }
    if (!state.target) {
      if (now - state.discoveryAt > 20000) stop('未找到可访问的 PPT 滚动区域，请检查课件是否加载。');
      else setStatus('正在等待 PPT 阅读区域加载…');
      return;
    }
    const target = state.target;
    const maximum = target.scrollHeight - target.clientHeight;
    const previous = target.scrollTop;
    if (previous < maximum - 2) {
      const step = Math.max(120, Math.floor(target.clientHeight * 0.8));
      target.scrollTop = Math.min(maximum, previous + step);
      state.bottomAt = 0;
      if (target.scrollTop <= previous + 1) {
        if (!state.stuckAt) state.stuckAt = now;
        if (now - state.stuckAt > 10000) stop('PPT 滚动区域没有移动，请检查播放器。');
        else setStatus('正在等待 PPT 滚动响应…');
      } else {
        state.stuckAt = 0;
        setStatus('正在浏览 PPT：' + Math.round(target.scrollTop / maximum * 100) + '%');
      }
      return;
    }
    if (!state.bottomAt) state.bottomAt = now;
    if (now - state.bottomAt > 60000) stop('PPT 已滚动到底，但平台还没有显示任务完成。');
    else setStatus('PPT 已滚动到底，等待平台更新完成标记…');
  }
  function getJobs(docs) {
    const jobs = [];
    for (const doc of docs) {
      for (const element of doc.querySelectorAll('.ans-attach-ct')) {
        if (!visible(element)) continue;
        const finished = element.classList.contains('ans-job-finished');
        const media = findMedia(element);
        const mediaFrame = element.querySelector('iframe[src*="video"],iframe[src*="audio"],iframe[data*="insertvideo"],iframe[data*="insertaudio"],.ans-insertvideo,.ans-insertaudio');
        const documentFrame = element.querySelector('iframe[src*="/pdf/"],iframe[src*="/ppt/"],iframe[src*="/document/"],iframe[data*="insertdoc"],iframe[data*="insertppt"],iframe[data*="insertpdf"],iframe[class*="insertdoc-online"],.ans-insertdoc,.ans-insertppt,.ans-insertpdf');
        const type = documentFrame ? 'document' : media || mediaFrame ? 'media' : 'other';
        jobs.push({ element, finished, media, type });
      }
    }
    return jobs;
  }

  function activeTabs(docs) {
    for (const doc of docs) {
      const tabs = Array.from(doc.querySelectorAll('.prev_ul > li'));
      if (tabs.length) return tabs;
    }
    return [];
  }

  function readCount(input) {
    if (!input) return null;
    const raw = 'value' in input ? input.value : input.textContent;
    if (!/^\s*\d+\s*$/.test(raw || '')) return null;
    return Number(raw);
  }

  function chapters() {
    const rows = Array.from(document.querySelectorAll('.posCatalog_select[id^="cur"]'));
    return rows.map((row) => {
      const clickable = row.querySelector('.posCatalog_name, [onclick^="getTeacherAjax"]');
      const countInput = row.querySelector('.jobUnfinishCount');
      const remaining = readCount(countInput);
      const completed = !!row.querySelector('.icon_Completed') || remaining === 0;
      const locked = row.classList.contains('lock') || clickable?.getAttribute('aria-disabled') === 'true';
      return { row, clickable, remaining, completed, locked };
    });
  }

  function currentChapterIndex(list) {
    const fromClass = list.findIndex((item) => item.row.classList.contains('posCatalog_active'));
    if (fromClass >= 0) return fromClass;
    const chapterId = new URL(root.location.href).searchParams.get('chapterId');
    return list.findIndex((item) => item.row.id === 'cur' + chapterId);
  }

  function nextChapter() {
    const list = chapters();
    const current = currentChapterIndex(list);
    if (!list.length) {
      stop('未识别章节目录。请确认当前为电脑端课程学习页。');
      return;
    }
    for (let offset = 1; offset < list.length; offset++) {
      const item = list[(current + offset + list.length) % list.length];
      if (item.remaining === null || item.completed || item.locked || !item.clickable) continue;
      pendingChapterId = item.row.id;
      pendingTabIndex = null;
      scanFromBeginning = true;
      item.clickable.click();
      lastNavigation = Date.now();
      waitingForMedia = 0;
      documentScroll = null;
      endedAt = 0;
      stallAt = 0;
      lastTime = -1;
      setStatus('已切换到下一节未完成章节，等待任务加载…');
      return;
    }
    stop('没有找到可识别且未完成的章节；请检查目录中是否有锁定项或其他任务。');
  }

  function nextTab(tabs) {
    const index = tabs.findIndex((tab) => tab.classList.contains('active'));
    if (index < 0 || index + 1 >= tabs.length) return false;
    pendingTabIndex = index + 1;
    tabs[index + 1].click();
    lastNavigation = Date.now();
    waitingForMedia = 0;
    endedAt = 0;
    stallAt = 0;
    lastTime = -1;
    setStatus('已切换到下一任务卡，等待加载…');
    return true;
  }

  async function runStep() {
    if (!readSettings().enabled) return;
    if (root.location.href !== lastLocation) {
      lastLocation = root.location.href;
      lastNavigation = Date.now();
      pendingTabIndex = null;
      scanFromBeginning = true;
      waitingForMedia = 0;
      documentScroll = null;
      endedAt = 0;
      stallAt = 0;
      lastTime = -1;
    }
    if (Date.now() - lastNavigation < 1800) return;
    if (pendingChapterId) {
      const list = chapters();
      const current = list[currentChapterIndex(list)];
      if (current?.row.id === pendingChapterId) {
        pendingChapterId = null;
        lastNavigation = Date.now();
        return;
      }
      else if (Date.now() - lastNavigation > 10000) {
        stop('章节切换未生效，请检查课程目录。');
        return;
      } else {
        setStatus('等待章节切换生效…');
        return;
      }
    }
    const docs = accessibleDocuments(document);
    const jobs = getJobs(docs);
    const tabs = activeTabs(docs);
    if (pendingTabIndex !== null) {
      const currentTab = tabs.findIndex((tab) => tab.classList.contains('active'));
      if (currentTab === pendingTabIndex) {
        pendingTabIndex = null;
        lastNavigation = Date.now();
        return;
      }
      else if (Date.now() - lastNavigation > 10000) {
        stop('任务卡切换未生效，请检查页面。');
        return;
      } else {
        setStatus('等待任务卡切换生效…');
        return;
      }
    }
    if (scanFromBeginning && tabs.length) {
      scanFromBeginning = false;
      const currentTab = tabs.findIndex((tab) => tab.classList.contains('active'));
      if (currentTab > 0) {
        pendingTabIndex = 0;
        tabs[0].click();
        lastNavigation = Date.now();
        setStatus('从第一张任务卡开始检查…');
        return;
      }
    }
    if (!jobs.length) {
      const list = chapters();
      if (list[currentChapterIndex(list)]?.completed) {
        nextChapter();
        return;
      }
      if (Date.now() - lastNavigation < 12000) {
        setStatus('正在等待任务点加载…');
        return;
      }
      if (nextTab(tabs)) return;
      stop('当前任务卡未识别到任务点。请检查页面是否加载完成。');
      return;
    }
    const pending = jobs.find((job) => !job.finished);
    if (!pending) {
      if (nextTab(tabs)) return;
      nextChapter();
      return;
    }
    if (pending.type === 'document') {
      scrollDocumentTask(pending);
      return;
    }
    if (pending.type !== 'media') {
      stop('遇到未完成的非视频/PPT任务点，请先在页面完成该项。');
      return;
    }
    if (!pending.media) {
      if (!waitingForMedia) waitingForMedia = Date.now();
      if (Date.now() - waitingForMedia > 20000) stop('视频框架不可访问或加载失败，无法继续自动播放。');
      else setStatus('正在等待视频播放器加载…');
      return;
    }
    waitingForMedia = 0;
    const media = pending.media;
    if (!watchedMedia.has(media)) {
      watchedMedia.add(media);
      mediaSpeedStates.set(media, {
        configuredSpeed: null,
        requestedFast: false,
        requestedAt: 0,
        limited: false,
        pauseCount: 0,
        lastPauseAt: 0
      });
      media.addEventListener('ended', tick, { once: true });
      media.addEventListener('ratechange', () => {
        const state = mediaSpeedStates.get(media);
        const settings = readSettings();
        if (!settings.enabled || settings.speed <= 1 || !state?.requestedFast || state.limited) return;
        if (media.playbackRate < state.configuredSpeed - 0.01) {
          state.limited = true;
          setStatus('当前视频不允许所选倍速，已改用 1×。');
        }
      });
      media.addEventListener('pause', () => {
        const state = mediaSpeedStates.get(media);
        const settings = readSettings();
        if (!settings.enabled || settings.speed <= 1 || !state?.requestedFast || state.limited || media.ended) return;
        const now = Date.now();
        state.pauseCount = now - state.lastPauseAt <= 10000 ? state.pauseCount + 1 : 1;
        state.lastPauseAt = now;
        if (now - state.requestedAt <= 5000 || state.pauseCount >= 2) {
          state.limited = true;
          setStatus('当前视频在倍速下自动暂停，已改用 1×。');
        }
      });
    }
    const settings = readSettings();
    const speedState = mediaSpeedStates.get(media);
    if (speedState.configuredSpeed !== settings.speed) {
      speedState.configuredSpeed = settings.speed;
      speedState.requestedFast = false;
      speedState.limited = false;
      speedState.pauseCount = 0;
    }
    const speedNotice = (pending.element.textContent || '') +
      (media.closest('.ans-attach-ct')?.textContent || '');
    if (settings.speed > 1 && /(?:不可|不允许|禁止|不能)倍速/.test(speedNotice)) {
      speedState.limited = true;
    }
    if (settings.speed > 1 && speedState.requestedFast &&
        media.playbackRate < settings.speed - 0.01) {
      speedState.limited = true;
    }
    if (media.muted !== settings.muted) media.muted = settings.muted;
    let targetSpeed = speedState.limited ? 1 : settings.speed;
    if (Math.abs(media.playbackRate - targetSpeed) > 0.01) {
      try {
        if (targetSpeed > 1) {
          speedState.requestedFast = true;
          speedState.requestedAt = Date.now();
        }
        media.playbackRate = targetSpeed;
      } catch {
        if (targetSpeed <= 1) {
          stop('播放器拒绝了原速播放，请手动检查。');
          return;
        }
        speedState.limited = true;
        targetSpeed = 1;
      }
    }
    if (speedState.limited && Math.abs(media.playbackRate - 1) > 0.01) {
      try { media.playbackRate = 1; }
      catch {
        stop('播放器拒绝了原速播放，请手动检查。');
        return;
      }
    }
    if (media.ended) {
      if (!endedAt) endedAt = Date.now();
      if (Date.now() - endedAt > 90000) stop('视频已播放完，但平台还没有显示任务完成。');
      else setStatus('视频已播完，等待平台更新完成标记…');
      return;
    }
    endedAt = 0;
    const now = Date.now();
    if (media.currentTime > lastTime + 0.1) {
      lastTime = media.currentTime;
      stallAt = now;
    } else if (stallAt && now - stallAt > 30000) {
      stop('视频进度持续没有变化，请检查测验、验证或网络状态。');
      return;
    }
    if (!stallAt) stallAt = now;
    if (media.paused) {
      try { await media.play(); }
      catch {
        if (settings.speed > 1 && !speedState.limited) {
          speedState.limited = true;
          try {
            media.playbackRate = 1;
            await media.play();
          } catch {
            stop('浏览器或课程阻止了自动播放，请手动播放后重新开始。');
            return;
          }
        } else {
          stop('浏览器或课程阻止了自动播放，请手动播放后重新开始。');
          return;
        }
      }
    }
    const speedLabel = speedState.limited ? '1×（课程限制）' : media.playbackRate + '×';
    setStatus('正在播放当前未完成视频：' + Math.floor(media.currentTime) + ' 秒，' + speedLabel);
  }

  function tick() {
    if (!readSettings().enabled) return;
    if (busy) {
      pendingWake = true;
      return;
    }
    busy = true;
    Promise.resolve(runStep()).catch((error) => {
      console.error('[学习通连播]', error);
      stop('脚本遇到页面结构或播放错误，请查看控制台。');
    }).finally(() => {
      busy = false;
      if (pendingWake) {
        pendingWake = false;
        tick();
      }
    });
  }

  function boot() {
    createPanel();
    if (readSettings().enabled) setStatus('继续上次的连播，等待页面加载…');
    tick();
    window.setInterval(() => {
      createPanel();
      tick();
    }, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();