// ==UserScript==
// @name         学习通视频与 PPT 连播助手
// @namespace    local.chaoxing.playback
// @version      0.3.1
// @description  顺序处理视频、PPT 与章节习题任务，等待平台完成标记后切换。
// @homepageURL  https://github.com/FH150174/chaoxing-playback-helper
// @supportURL   https://github.com/FH150174/chaoxing-playback-helper/issues
// @updateURL    https://raw.githubusercontent.com/FH150174/chaoxing-playback-helper/main/chaoxing-playback.user.js
// @downloadURL  https://raw.githubusercontent.com/FH150174/chaoxing-playback-helper/main/chaoxing-playback.user.js
// @license      MIT
// @match        https://*.chaoxing.com/*
// @run-at       document-start
// @sandbox     raw
// @connect     api.deepseek.com
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_deleteValue
// @grant       GM_xmlhttpRequest
// ==/UserScript==

(() => {
  'use strict';

  const ROOT_PATH = /\/mycourse\/studentstudy\/?$/;
  const QUIZ_PATH = /\/(?:mooc-ans\/work\/(?:doHomeWorkNew|selectWorkQuestion)|mooc2\/work\/task|ananas\/modules\/work\/)/i;
  const QUIZ_CHANNEL = 'cxpb-quiz-v1';
  const API_KEY_NAME = 'cxpb-deepseek-api-key';
  const MODEL_NAME = 'cxpb-deepseek-model';
  if (window !== window.top && QUIZ_PATH.test(window.location.pathname)) {
    initQuizFrame();
    return;
  }
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
  const quizSessionKey = 'cxpb-quiz-session:' + courseId + ':' + clazzId;
  const defaults = { enabled: false, speed: 2, background: true, muted: true };
  const isRoot = window === root;
  const askApiKey = window.prompt.bind(window);
  let panelStatus = null;
  let lastLocation = root.location.href;
  let lastNavigation = Date.now();
  let pendingChapterId = null;
  let pendingTabIndex = null;
  let scanFromBeginning = true;
  let waitingForMedia = 0;
  let endedAt = 0;
  let documentScroll = null;
  let quizState = null;
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

  function cancelQuizTask() {
    if (quizState?.frame) {
      quizState.frame.postMessage({
        channel: QUIZ_CHANNEL,
        action: 'cancel',
        token: quizState.token
      }, '*');
    }
    GM_deleteValue(quizSessionKey);
    quizState = null;
  }

  function stop(message) {
    saveSettings({ enabled: false });
    cancelQuizTask();
    syncPanel();
    setStatus(message);
  }

  window.addEventListener('message', (event) => {
    if (!quizState || !/^https:\/\/(?:[^.]+\.)*chaoxing\.com$/.test(event.origin)) return;
    const data = event.data;
    if (event.source !== quizState.frame || data?.channel !== QUIZ_CHANNEL ||
        data.token !== quizState.token) return;
    quizState.messageAt = Date.now();
    if (data.kind === 'error') {
      stop('习题处理停止：' + String(data.message || '未知错误').slice(0, 120));
    } else if (data.kind === 'submitted') {
      quizState.submitted = true;
      quizState.submittedAt = Date.now();
      setStatus('习题已提交，等待平台显示任务完成…');
    } else if (data.kind === 'progress') {
      setStatus(String(data.message || '正在处理习题…').slice(0, 120));
    }
  });

  function syncPanel() {
    const settings = readSettings();
    const button = document.getElementById('cxpb-toggle');
    const speed = document.getElementById('cxpb-speed');
    const background = document.getElementById('cxpb-background');
    const muted = document.getElementById('cxpb-muted');
    const model = document.getElementById('cxpb-model');
    const keyButton = document.getElementById('cxpb-key');
    if (model && typeof GM_getValue === 'function') {
      model.value = GM_getValue(MODEL_NAME, 'deepseek-v4-pro');
    }
    if (keyButton && typeof GM_getValue === 'function') {
      keyButton.textContent = GM_getValue(API_KEY_NAME, '') ? '更换 DeepSeek Key' : '设置 DeepSeek Key';
    }
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
        cancelQuizTask();
        endedAt = 0;
        stallAt = Date.now();
        lastTime = -1;
        setStatus('正在查找未完成的视频、PPT 或习题任务点…');
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
    const modelLabel = document.createElement('label');
    modelLabel.style.cssText = 'display:block;margin-top:8px';
    modelLabel.textContent = '习题模型 ';
    const model = document.createElement('select');
    model.id = 'cxpb-model';
    for (const [value, label] of [['deepseek-v4-pro', 'DeepSeek V4 Pro'], ['deepseek-flash', 'DeepSeek Flash']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      model.append(option);
    }
    model.addEventListener('change', () => GM_setValue(MODEL_NAME, model.value));
    modelLabel.append(model);
    box.append(modelLabel);
    const keyButton = document.createElement('button');
    keyButton.id = 'cxpb-key';
    keyButton.type = 'button';
    keyButton.style.cssText = 'display:block;margin-top:6px;cursor:pointer';
    keyButton.addEventListener('click', () => {
      const value = askApiKey('输入 DeepSeek API Key；留空并确定可清除本地密钥。密钥只保存在篡改猴脚本存储中。');
      if (value === null) return;
      if (value.trim()) GM_setValue(API_KEY_NAME, value.trim());
      else GM_deleteValue(API_KEY_NAME);
      syncPanel();
      setStatus(value.trim() ? 'DeepSeek API Key 已保存到篡改猴本地存储。' : '已清除 DeepSeek API Key。');
    });
    box.append(keyButton);
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
        const quizFrame = findQuizFrame(element) || element.querySelector('iframe[data*="insertwork"],.ans-insertwork');
        const quizText = /章节测验|课后习题/.test(element.textContent || '');
        const type = documentFrame ? 'document' : media || mediaFrame ? 'media' :
          quizFrame || quizText ? 'quiz' : 'other';
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
      cancelQuizTask();
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
    cancelQuizTask();
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
      cancelQuizTask();
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
    if (quizState && !quizState.element.isConnected) cancelQuizTask();
    if (quizState && quizState.element.isConnected) {
      if (quizState.submitted) {
        if (quizState.element.classList.contains('ans-job-finished')) cancelQuizTask();
        else {
          if (Date.now() - quizState.submittedAt > 90000) {
            stop('习题已提交，但平台仍未显示任务完成。请手动检查结果。');
          } else setStatus('习题已提交，等待平台显示任务完成…');
          return;
        }
      } else {
        processQuizTask({ element: quizState.element });
        return;
      }
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
    if (pending.type === 'quiz') {
      processQuizTask(pending);
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

  function findQuizFrame(host) {
    for (const frame of host.querySelectorAll('iframe')) {
      try {
        const url = new URL(frame.src, frame.ownerDocument.baseURI);
        if (/^(?:[^.]+\.)*chaoxing\.com$/i.test(url.hostname) &&
            QUIZ_PATH.test(url.pathname) && frame.contentWindow) return frame;
      } catch { /* 非法或尚未加载的框架地址。 */ }
      try {
        if (frame.contentDocument) {
          const nested = findQuizFrame(frame.contentDocument);
          if (nested) return nested;
        }
      } catch { /* 跨域中间框架不可访问。 */ }
    }
    return null;
  }

  function processQuizTask(job) {
    const now = Date.now();
    if (!quizState || quizState.element !== job.element) {
      quizState = {
        element: job.element,
        token: String(now) + '-' + Math.random().toString(36).slice(2),
        startedAt: now,
        messageAt: now,
        submitted: false,
        frame: null
      };
      GM_setValue(quizSessionKey, { token: quizState.token, createdAt: now });
    }
    const frame = findQuizFrame(job.element);
    if (!frame) {
      if (now - quizState.startedAt > 25000) {
        stop('未找到可访问的章节习题框架，请检查题目是否加载。');
      } else setStatus('正在等待章节习题页面加载…');
      return;
    }
    quizState.frame = frame.contentWindow;
    if (now - quizState.startedAt > 60 * 60 * 1000) {
      stop('章节习题处理超过一小时，请手动检查。');
      return;
    }
    frame.contentWindow.postMessage({
      channel: QUIZ_CHANNEL,
      action: 'solve',
      token: quizState.token,
      sessionKey: quizSessionKey
    }, '*');
    if (now - quizState.messageAt > 10000) {
      setStatus('正在等待章节习题页面响应…');
    }
  }

  function quizText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function parseQuizQuestions(doc) {
    const roots = Array.from(doc.querySelectorAll('div.singleQuesId, .questionLi, div[id^="question"]'))
      .filter((node) => visible(node) &&
        (!node.matches('.questionLi') || !node.closest('.singleQuesId')) &&
        (node.matches('.singleQuesId, .questionLi') ||
          (!node.closest('.singleQuesId') &&
            !node.querySelector('div.singleQuesId, .questionLi, div[id^="question"]'))));
    return roots.map((node, index) => {
      if (node.querySelector('.font-cxsecret')) {
        throw new Error('第 ' + (index + 1) + ' 题使用加密字体，无法可靠读取题干。');
      }
      if (node.querySelector('img')) {
        throw new Error('第 ' + (index + 1) + ' 题含图片，当前版本无法可靠作答。');
      }
      const typeText = quizText(node.querySelector('.newZy_TItle, .colorShallow')?.textContent ||
        node.getAttribute('typename') || '');
      let type = /多选/.test(typeText) ? 'multi' :
        /单选|判断/.test(typeText) ? 'single' : null;
      const spans = Array.from(node.querySelectorAll('span.num_option'));
      const inputs = spans.length ? [] : Array.from(node.querySelectorAll('input[type="radio"],input[type="checkbox"]'));
      if (!type && inputs.length) type = inputs[0].type === 'checkbox' ? 'multi' : 'single';
      if (!type) {
        throw new Error('第 ' + (index + 1) + ' 题题型尚不支持：' + (typeText || '未知题型'));
      }
      const controls = spans.length ? spans : inputs;
      const options = controls.map((control, optionIndex) => {
        const parent = control.closest('label') || control.parentElement;
        const displayed = quizText(control.textContent).match(/^[A-Z]/i)?.[0]?.toUpperCase();
        const letter = displayed || String.fromCharCode(65 + optionIndex);
        const text = quizText(parent?.textContent).replace(/^[A-Z][.、．\s]*/i, '');
        return { control, target: spans.length ? parent : control, letter, text };
      });
      if (options.length < 2 || options.some((option) => !option.text) ||
          new Set(options.map((option) => option.letter)).size !== options.length) {
        throw new Error('第 ' + (index + 1) + ' 题选项无法可靠读取。');
      }
      const clone = node.cloneNode(true);
      for (const control of clone.querySelectorAll('span.num_option')) {
        (control.closest('label') || control.parentElement)?.remove();
      }
      for (const control of clone.querySelectorAll('input[type="radio"],input[type="checkbox"]')) {
        (control.closest('label') || control.parentElement)?.remove();
      }
      for (const element of clone.querySelectorAll('script,style,button,textarea,input')) element.remove();
      const stem = quizText(clone.textContent);
      if (stem.length < 4) throw new Error('第 ' + (index + 1) + ' 题题干无法可靠读取。');
      return { node, index, type, stem, options };
    });
  }

  function selectedQuizOption(option) {
    return option.control.classList.contains('check_answer') ||
      option.target.classList.contains('check_answer') ||
      option.target.classList.contains('selected') ||
      option.control.checked === true;
  }

  function requestDeepSeek(key, model, question, pass) {
    const instruction = pass === 1 ?
      '独立解答课程选择题。仔细推理后仅输出 JSON：{"answer":["A"],"confidence":"high"}。多选可返回多个字母；判断题也按选项字母回答。不确定或题目信息不足时返回空数组和 low。' :
      '重新独立核对这道题，不要猜。仅输出 JSON：{"answer":["A"],"confidence":"high"}。多选须列出全部正确选项；不确定返回空数组和 low。';
    const payload = {
      model,
      messages: [
        { role: 'system', content: instruction },
        { role: 'user', content: JSON.stringify({
          type: question.type,
          question: question.stem,
          options: question.options.map(({ letter, text }) => ({ letter, text }))
        }) }
      ],
      response_format: { type: 'json_object' },
      thinking: { type: 'enabled' },
      max_tokens: 8192,
      stream: false
    };
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('篡改猴跨域请求接口不可用。'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.deepseek.com/chat/completions',
        redirect: 'error',
        headers: {
          Authorization: 'Bearer ' + key,
          'Content-Type': 'application/json'
        },
        data: JSON.stringify(payload),
        timeout: 180000,
        onload(response) {
          if (response.status !== 200) {
            reject(new Error('DeepSeek API 返回 HTTP ' + response.status + '。'));
            return;
          }
          try {
            const body = JSON.parse(response.responseText);
            const choice = body.choices?.[0];
            if (choice?.finish_reason !== 'stop' || !choice.message?.content) {
              throw new Error('DeepSeek 没有返回完整答案。');
            }
            resolve(JSON.parse(choice.message.content));
          } catch {
            reject(new Error('DeepSeek 返回的答案格式不完整。'));
          }
        },
        onerror() { reject(new Error('DeepSeek 请求失败，请检查网络。')); },
        ontimeout() { reject(new Error('DeepSeek 请求超时。')); }
      });
    });
  }

  function normalizeQuizAnswer(result, question) {
    if (!result || !['high', 'medium'].includes(result.confidence)) return null;
    const raw = Array.isArray(result.answer) ? result.answer : [result.answer];
    const letters = raw.map((item) => quizText(item).toUpperCase());
    const allowed = new Set(question.options.map((option) => option.letter));
    if (!letters.length || letters.some((letter) => !allowed.has(letter)) ||
        (question.type === 'single' && letters.length !== 1)) return null;
    return Array.from(new Set(letters)).sort();
  }

  function sleepQuiz(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  async function applyQuizAnswer(question, letters, isCancelled) {
    if (isCancelled()) throw new Error('习题处理已停止。');
    if (!question.node.isConnected) throw new Error('习题页面已变化，停止提交。');
    const wanted = new Set(letters);
    const clicks = question.type === 'multi' ?
      question.options.filter((option) => selectedQuizOption(option) !== wanted.has(option.letter)) :
      question.options.filter((option) => wanted.has(option.letter) && !selectedQuizOption(option));
    for (const option of clicks) {
      if (isCancelled()) throw new Error('习题处理已停止。');
      option.target.click();
      await sleepQuiz(1600);
    }
    if (isCancelled()) throw new Error('习题处理已停止。');
    const actual = question.options.filter(selectedQuizOption).map((option) => option.letter).sort();
    if (actual.join(',') !== letters.join(',')) {
      throw new Error('第 ' + (question.index + 1) + ' 题未能确认选项已保存，停止提交。');
    }
  }

  async function submitQuiz(doc, isCancelled) {
    if (isCancelled()) throw new Error('习题处理已停止。');
    const controls = Array.from(doc.querySelectorAll('button,a,input[type="button"],input[type="submit"]'));
    const submit = controls.find((control) =>
      /提交|交卷/.test(quizText(control.value || control.textContent)) &&
      !/重做|重新/.test(quizText(control.value || control.textContent))) ||
      doc.querySelector('[onclick*="btnBlueSubmit"]');
    if (!submit) throw new Error('找不到习题提交按钮；答案已填写，未自动提交。');
    submit.click();
    await sleepQuiz(700);
    if (isCancelled()) throw new Error('习题处理已停止。');
    const confirm = doc.querySelector('#popok');
    if (confirm && confirm.isConnected) {
      confirm.click();
      await sleepQuiz(700);
    }
  }

  function initQuizFrame() {
    let running = false;
    let submitted = false;
    let activeToken = null;
    let cancelled = false;
    function report(token, kind, message) {
      window.top.postMessage({ channel: QUIZ_CHANNEL, token, kind, message }, '*');
    }
    window.addEventListener('message', (event) => {
      if (event.source !== window.top ||
          !/^https:\/\/(?:[^.]+\.)*chaoxing\.com$/.test(event.origin)) return;
      const data = event.data;
      if (data?.channel !== QUIZ_CHANNEL || !data.token) return;
      if (data.action === 'cancel' && data.token === activeToken) {
        cancelled = true;
        return;
      }
      if (data.action !== 'solve' || running || submitted ||
          !String(data.sessionKey || '').startsWith('cxpb-quiz-session:')) return;
      const session = GM_getValue(data.sessionKey, null);
      if (session?.token !== data.token ||
          !Number.isFinite(session.createdAt) || session.createdAt > Date.now() ||
          Date.now() - session.createdAt > 60 * 60 * 1000) return;
      activeToken = data.token;
      cancelled = false;
      running = true;
      (async () => {
        const key = typeof GM_getValue === 'function' ? quizText(GM_getValue(API_KEY_NAME, '')) : '';
        if (!key) throw new Error('请先在主页面设置 DeepSeek API Key。');
        const configured = GM_getValue(MODEL_NAME, 'deepseek-v4-pro');
        const model = ['deepseek-v4-pro', 'deepseek-flash'].includes(configured) ?
          configured : 'deepseek-v4-pro';
        let questions = [];
        let parseError = null;
        let firstReadyAt = 0;
        for (let attempt = 0; attempt < 25; attempt++) {
          if (cancelled) throw new Error('习题处理已停止。');
          try {
            questions = parseQuizQuestions(document);
            if (questions.length) {
              if (!firstReadyAt) firstReadyAt = Date.now();
              if (document.readyState === 'complete' && Date.now() - firstReadyAt >= 3000) break;
            }
          } catch (error) {
            parseError = error;
          }
          await sleepQuiz(1000);
        }
        if (!questions.length) {
          throw parseError || new Error('没有识别到选择题或判断题。');
        }
        if (questions.length > 50) throw new Error('题目超过 50 道，暂停以避免意外的 API 费用。');
        const isCancelled = () => cancelled ||
          GM_getValue(data.sessionKey, null)?.token !== data.token;
        for (const question of questions) {
          if (isCancelled()) throw new Error('习题处理已停止。');
          report(data.token, 'progress', '正在解答第 ' + (question.index + 1) + '/' + questions.length + ' 题…');
          const first = normalizeQuizAnswer(await requestDeepSeek(key, model, question, 1), question);
          if (isCancelled()) throw new Error('习题处理已停止。');
          const second = normalizeQuizAnswer(await requestDeepSeek(key, model, question, 2), question);
          if (!first || !second || first.join(',') !== second.join(',')) {
            throw new Error('第 ' + (question.index + 1) + ' 题两次判断不一致或信心不足，未提交。');
          }
          await applyQuizAnswer(question, first, isCancelled);
        }
        if (isCancelled()) throw new Error('习题处理已停止。');
        report(data.token, 'progress', '全部题目已填写，正在提交…');
        await submitQuiz(document, isCancelled);
        submitted = true;
        report(data.token, 'submitted', '习题已提交。');
      })().catch((error) => {
        report(data.token, 'error', error.message || '习题处理失败。');
      }).finally(() => { running = false; });
    });
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