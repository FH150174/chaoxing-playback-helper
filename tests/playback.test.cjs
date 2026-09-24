const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const script = fs.readFileSync(path.join(__dirname, '..', 'chaoxing-playback.user.js'), 'utf8');
const courseUrl = 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=100&courseId=200&clazzid=300&mooc2=1';

function fixture(jobMarkup, secondCount = '1') {
  return `<!doctype html><html><body>
    <div class="posCatalog_select posCatalog_active" id="cur100"><span class="posCatalog_name">第一章</span><input class="jobUnfinishCount" value="1"></div>
    <div class="posCatalog_select" id="cur101"><span class="posCatalog_name">第二章</span>${secondCount === null ? '' : `<input class="jobUnfinishCount" value="${secondCount}">`}</div>
    <ul class="prev_ul"><li class="active">视频</li></ul>
    ${jobMarkup}
  </body></html>`;
}

async function setup(html, beforeScript) {
  const dom = new JSDOM(html, { url: courseUrl, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  let now = 1000;
  let interval;
  let plays = 0;
  let paused = true;
  win.Date.now = () => now;
  win.setInterval = (fn) => { interval = fn; return 1; };
  win.console.info = () => {};
  const gmValues = new Map();
  win.GM_getValue = (key, fallback) => gmValues.has(key) ? gmValues.get(key) : fallback;
  win.GM_setValue = (key, value) => gmValues.set(key, value);
  win.GM_deleteValue = (key) => gmValues.delete(key);
  win.__setPaused = (value) => { paused = value; };
  const video = win.document.querySelector('video');
  if (video) {
    Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
    video.play = async () => { plays += 1; paused = false; };
  }
  if (beforeScript) beforeScript(win);
  win.eval(script);
  win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  await Promise.resolve();
  const button = win.document.getElementById('cxpb-toggle');
  assert.ok(button, 'the control panel should be present');
  async function step(milliseconds = 2000) {
    await new Promise((resolve) => setImmediate(resolve));
    now += milliseconds;
    interval();
    await new Promise((resolve) => setImmediate(resolve));
  }
  function close() { dom.window.close(); }
  return { dom, win, video, button, step, close, plays: () => plays };
}

test('plays a pending video at 2x, waits for the finished marker, then opens the next unfinished chapter', async () => {
  const page = await setup(fixture('<div class="ans-attach-ct"><video></video></div>'));
  try {
    let opened = 0;
    page.win.document.querySelector('#cur101 .posCatalog_name').addEventListener('click', () => { opened += 1; });
    page.button.click();
    await page.step();
    assert.equal(page.plays(), 1);
    assert.equal(page.video.playbackRate, 2);
    assert.equal(page.video.muted, true);
    assert.equal(opened, 0, 'video start alone must not advance');
    Object.defineProperty(page.video, 'ended', { configurable: true, get: () => true });
    await page.step();
    assert.equal(opened, 0, 'ended alone must not advance before the platform finishes the task');
    page.win.document.querySelector('.ans-attach-ct').classList.add('ans-job-finished');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(opened, 1, 'the completion marker should wake playback without waiting for a background timer');
    await page.step();
    assert.equal(opened, 1, 'chapter navigation must not be clicked twice');
  } finally { page.close(); }
});

test('stops at an unfinished non-video task and does not leave the chapter', async () => {
  const page = await setup(fixture('<div class="ans-attach-ct"><p>无法识别的互动任务</p></div>'));
  try {
    let opened = 0;
    page.win.document.querySelector('#cur101 .posCatalog_name').addEventListener('click', () => { opened += 1; });
    page.button.click();
    await page.step();
    assert.match(page.win.document.getElementById('cxpb-status').textContent, /非视频\/PPT任务点/);
    assert.equal(page.button.textContent, '开始连播');
    assert.equal(opened, 0);
  } finally { page.close(); }
});

test('does not treat an unknown chapter count as completed or skip to it', async () => {
  const page = await setup(fixture('<div class="ans-attach-ct ans-job-finished"><video></video></div>', null));
  try {
    let opened = 0;
    page.win.document.querySelector('#cur101 .posCatalog_name').addEventListener('click', () => { opened += 1; });
    page.button.click();
    await page.step();
    assert.equal(opened, 0);
    assert.match(page.win.document.getElementById('cxpb-status').textContent, /没有找到可识别/);
  } finally { page.close(); }
});

test('background compatibility follows the toggle and returns native visibility after stopping', async () => {
  const page = await setup(fixture('<div class="ans-attach-ct"><video></video></div>'));
  try {
    const nativeHidden = page.win.document.hidden;
    page.button.click();
    assert.equal(page.win.document.hidden, false);
    assert.equal(page.win.document.visibilityState, 'visible');
    page.button.click();
    assert.equal(page.win.document.hidden, nativeHidden);
  } finally { page.close(); }
});
test('finds media inside the visible chapter iframe', async () => {
  let frameVideo;
  let plays = 0;
  const page = await setup(fixture('<iframe id="iframe"></iframe>'), (win) => {
    const iframeDoc = win.document.getElementById('iframe').contentDocument;
    iframeDoc.body.innerHTML = '<div class="ans-attach-ct"><video id="video_html5_api"></video></div>';
    frameVideo = iframeDoc.getElementById('video_html5_api');
    Object.defineProperty(frameVideo, 'paused', { configurable: true, get: () => true });
    frameVideo.play = async () => { plays += 1; };
  });
  try {
    page.button.click();
    await page.step();
    assert.equal(plays, 1);
    assert.equal(frameVideo.playbackRate, 2);
  } finally { page.close(); }
});
test('skips a completed chapter even when it contains no playable task card', async () => {
  const page = await setup(fixture(''));
  try {
    page.win.document.querySelector('#cur100 input').value = '0';
    let opened = 0;
    page.win.document.querySelector('#cur101 .posCatalog_name').addEventListener('click', () => { opened += 1; });
    page.button.click();
    await page.step();
    assert.equal(opened, 1);
  } finally { page.close(); }
});

test('starts its scan from the first task tab when the user opened a later tab', async () => {
  const html = fixture('<div class="ans-attach-ct"><video></video></div>')
    .replace('<li class="active">视频</li>', '<li>视频一</li><li class="active">视频二</li>');
  const page = await setup(html);
  try {
    const first = page.win.document.querySelector('.prev_ul li');
    let clicks = 0;
    first.addEventListener('click', () => { clicks += 1; });
    page.button.click();
    await page.step();
    assert.equal(clicks, 1);
    assert.equal(page.plays(), 0);
  } finally { page.close(); }
});
async function setupPptPage(options = {}) {
  const frameAttributes = options.classMarker
    ? 'class="ans-attach-online insertdoc-online-ppt"'
    : 'data="{&quot;module&quot;:&quot;insertdoc&quot;}"';
  const html = fixture('<div class="ans-attach-ct"><iframe id="ppt-frame" ' + frameAttributes + '></iframe></div>');
  let position = 0;
  let height = 700;
  let viewer;
  const page = await setup(html, (win) => {
    let doc = win.document.getElementById('ppt-frame').contentDocument;
    if (options.nested) {
      doc.body.innerHTML = '<iframe id="ppt-inner"></iframe>';
      doc = doc.getElementById('ppt-inner').contentDocument;
    }
    doc.body.innerHTML = '<div id="viewerContainer" style="height:200px;overflow-y:auto"></div>';
    viewer = doc.getElementById('viewerContainer');
    Object.defineProperty(viewer, 'clientHeight', { get: () => 200 });
    Object.defineProperty(viewer, 'scrollHeight', { get: () => height });
    Object.defineProperty(viewer, 'scrollTop', {
      get: () => position,
      set: (value) => { position = Math.max(0, Math.min(height - 200, value)); }
    });
  });
  return { page, viewer, getPosition: () => position, grow: (value) => { height = value; } };
}

test('scrolls a PPT viewer in steps and waits for the real finished marker before advancing', async () => {
  const ppt = await setupPptPage();
  const { page } = ppt;
  try {
    let opened = 0;
    page.win.document.querySelector('#cur101 .posCatalog_name').addEventListener('click', () => { opened += 1; });
    page.button.click();
    await page.step();
    assert.equal(ppt.getPosition(), 160);
    assert.equal(opened, 0);
    await page.step();
    assert.equal(ppt.getPosition(), 320);
    await page.step();
    await page.step();
    assert.equal(ppt.getPosition(), 500);
    await page.step();
    assert.equal(opened, 0, 'reaching the bottom must not be treated as platform completion');
    page.win.document.querySelector('.ans-attach-ct').classList.add('ans-job-finished');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(opened, 1);
  } finally { page.close(); }
});

test('continues scrolling when a PPT viewer lazy-loads more pages at the bottom', async () => {
  const ppt = await setupPptPage();
  const { page } = ppt;
  try {
    page.button.click();
    await page.step();
    await page.step();
    await page.step();
    await page.step();
    assert.equal(ppt.getPosition(), 500);
    ppt.grow(1000);
    await page.step();
    assert.ok(ppt.getPosition() > 500);
    assert.equal(page.button.textContent, '停止连播');
  } finally { page.close(); }
});

test('stops when a PPT task has no accessible scroll area', async () => {
  const html = fixture('<div class="ans-attach-ct"><iframe data="{&quot;module&quot;:&quot;insertdoc&quot;}"></iframe></div>');
  const page = await setup(html);
  try {
    page.button.click();
    await page.step();
    await page.step(21000);
    assert.match(page.win.document.getElementById('cxpb-status').textContent, /未找到可访问的 PPT 滚动区域/);
    assert.equal(page.button.textContent, '开始连播');
  } finally { page.close(); }
});
test('scrolls a PPT rendered directly on the course page', async () => {
  const html = fixture('<div class="ans-attach-ct"><div class="ans-insertdoc">课件</div></div>');
  const page = await setup(html, (win) => {
    const root = win.document.documentElement;
    Object.defineProperty(root, 'clientHeight', { get: () => 200 });
    Object.defineProperty(root, 'scrollHeight', { get: () => 600 });
  });
  try {
    page.button.click();
    await page.step();
    assert.equal(page.win.document.documentElement.scrollTop, 160);
  } finally { page.close(); }
});
test('recognizes the insertdoc-online PPT marker and scrolls through a second iframe', async () => {
  const ppt = await setupPptPage({ classMarker: true, nested: true });
  try {
    ppt.page.button.click();
    await ppt.page.step();
    assert.equal(ppt.getPosition(), 160);
  } finally { ppt.page.close(); }
});
test('falls back to 1x when the course resets the requested rate and pauses', async () => {
  let denied = 0;
  const page = await setup(fixture('<div class="ans-attach-ct"><video></video></div>'), (win) => {
    const video = win.document.querySelector('video');
    video.pause = () => {
      win.__setPaused(true);
      video.dispatchEvent(new win.Event('pause'));
    };
    video.addEventListener('ratechange', () => {
      if (video.playbackRate > 1) {
        denied += 1;
        video.playbackRate = 1;
        video.pause();
      }
    });
  });
  try {
    page.button.click();
    await page.step();
    page.video.dispatchEvent(new page.win.Event('ratechange'));
    await page.step();
    assert.equal(page.video.playbackRate, 1);
    assert.equal(page.video.paused, false, 'the video should resume at normal speed');
    assert.match(page.win.document.getElementById('cxpb-status').textContent, /1×.*课程限制/);
    const deniedBefore = denied;
    await page.step();
    assert.equal(denied, deniedBefore, 'the helper must not retry 2x on this video');
  } finally { page.close(); }
});

test('falls back to 1x when the course pauses without resetting the rate', async () => {
  let pauses = 0;
  const page = await setup(fixture('<div class="ans-attach-ct"><video></video></div>'), (win) => {
    const video = win.document.querySelector('video');
    video.pause = () => {
      pauses += 1;
      win.__setPaused(true);
      video.dispatchEvent(new win.Event('pause'));
    };
    video.addEventListener('ratechange', () => {
      if (video.playbackRate > 1) video.pause();
    });
  });
  try {
    page.button.click();
    await page.step();
    page.video.dispatchEvent(new page.win.Event('ratechange'));
    await page.step();
    assert.equal(page.video.playbackRate, 1);
    assert.equal(page.video.paused, false);
    assert.ok(pauses >= 1);
    const pausesBefore = pauses;
    await page.step();
    assert.equal(pauses, pausesBefore, 'the helper must not retrigger a speed-related pause');
  } finally { page.close(); }
});

test('uses the selected fast rate again on the next unrestricted video', async () => {
  let first;
  let second;
  const page = await setup(fixture('<div class="ans-attach-ct" id="first"><video></video></div><div class="ans-attach-ct" id="second"><video></video></div>'), (win) => {
    first = win.document.querySelector('#first video');
    second = win.document.querySelector('#second video');
    Object.defineProperty(second, 'paused', { get: () => false });
    first.addEventListener('ratechange', () => {
      if (first.playbackRate > 1) first.playbackRate = 1;
    });
  });
  try {
    page.button.click();
    await page.step();
    first.dispatchEvent(new page.win.Event('ratechange'));
    await page.step();
    assert.equal(first.playbackRate, 1);
    page.win.document.getElementById('first').classList.add('ans-job-finished');
    await new Promise((resolve) => setImmediate(resolve));
    await page.step();
    assert.equal(second.playbackRate, 2);
  } finally { page.close(); }
});

test('falls back to 1x for restricted media inside a chapter iframe', async () => {
  let frameVideo;
  let resets = 0;
  const page = await setup(fixture('<iframe id="video-frame"></iframe>'), (win) => {
    const frameDoc = win.document.getElementById('video-frame').contentDocument;
    frameDoc.body.innerHTML = '<div class="ans-attach-ct"><video></video></div>';
    frameVideo = frameDoc.querySelector('video');
    Object.defineProperty(frameVideo, 'paused', { get: () => false });
    frameVideo.addEventListener('ratechange', () => {
      if (frameVideo.playbackRate > 1) {
        resets += 1;
        frameVideo.playbackRate = 1;
      }
    });
  });
  try {
    page.button.click();
    await page.step();
    frameVideo.dispatchEvent(new frameVideo.ownerDocument.defaultView.Event('ratechange'));
    await page.step();
    assert.equal(frameVideo.playbackRate, 1);
    const resetCount = resets;
    await page.step();
    assert.equal(resets, resetCount);
  } finally { page.close(); }
});
test('starts a task at 1x when its page explicitly forbids faster playback', async () => {
  const page = await setup(fixture('<div class="ans-attach-ct"><p>未完成任务点前，当前视频不可倍速</p><video></video></div>'));
  try {
    page.button.click();
    await page.step();
    assert.equal(page.video.playbackRate, 1);
    assert.equal(page.plays(), 1);
    assert.match(page.win.document.getElementById('cxpb-status').textContent, /1×.*课程限制/);
  } finally { page.close(); }
});
test('retries at 1x when the player rejects play at a faster rate', async () => {
  let attempts = 0;
  const page = await setup(fixture('<div class="ans-attach-ct"><video></video></div>'), (win) => {
    const video = win.document.querySelector('video');
    video.play = async () => {
      attempts += 1;
      if (video.playbackRate > 1) throw new Error('speed is disabled');
      win.__setPaused(false);
    };
  });
  try {
    page.button.click();
    await page.step();
    assert.equal(page.video.playbackRate, 1);
    assert.equal(page.video.paused, false);
    assert.equal(attempts, 2);
  } finally { page.close(); }
});

async function runQuizFrame(questions, answerForRequest, hasKey = true) {
  const dom = new JSDOM('<!doctype html><html><body><iframe src="/mooc-ans/work/doHomeWorkNew"></iframe></body></html>', {
    url: courseUrl, runScripts: 'outside-only', pretendToBeVisual: true
  });
  const top = dom.window;
  const frame = top.document.querySelector('iframe').contentWindow;
  frame.document.open();
  frame.document.write('<!doctype html><html><body>' + questions + '<button id="quiz-submit">提交</button><button id="popok">确定</button></body></html>');
  frame.document.close();
  let requests = 0;
  let submits = 0;
  let confirms = 0;
  frame.document.querySelector('#quiz-submit').addEventListener('click', () => { submits += 1; });
  frame.document.querySelector('#popok').addEventListener('click', () => { confirms += 1; });
  for (const question of frame.document.querySelectorAll('.singleQuesId')) {
    for (const option of question.querySelectorAll('.quiz-option')) {
      option.addEventListener('click', () => {
        const selected = option.querySelector('.num_option');
        if (/多选/.test(question.querySelector('.newZy_TItle')?.textContent || '')) {
          selected.classList.toggle('check_answer');
        } else {
          for (const other of question.querySelectorAll('.num_option')) {
            other.classList.remove('check_answer');
          }
          selected.classList.add('check_answer');
        }
      });
    }
  }
  frame.setTimeout = (callback) => { queueMicrotask(callback); return 1; };
  frame.GM_getValue = (key, fallback) => {
    if (key === 'cxpb-deepseek-api-key' && hasKey) return 'test-api-key';
    if (key === 'cxpb-quiz-session:200:300') return { token: 'test-token', createdAt: Date.now() };
    return fallback;
  };
  frame.GM_xmlhttpRequest = (details) => {
    requests += 1;
    assert.equal(details.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(details.headers.Authorization, 'Bearer test-api-key');
    const question = JSON.parse(JSON.parse(details.data).messages[1].content);
    const answer = answerForRequest(question, requests, frame, top);
    details.onload({
      status: 200,
      responseText: JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }]
      })
    });
  };
  frame.eval(script);
  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('quiz frame did not finish')), 1500);
    top.addEventListener('message', (event) => {
      if (event.data?.channel !== 'cxpb-quiz-v1' ||
          !['submitted', 'error'].includes(event.data.kind)) return;
      clearTimeout(timeout);
      resolve(event.data);
    });
  });
  frame.dispatchEvent(new frame.MessageEvent('message', {
    origin: 'https://mooc1.chaoxing.com',
    source: top,
    data: { channel: 'cxpb-quiz-v1', action: 'solve', token: 'test-token', sessionKey: 'cxpb-quiz-session:200:300' }
  }));
  try {
    return { result: await result, requests, submits, confirms };
  } finally {
    dom.window.close();
  }
}

test('sends a start command to a chapter quiz without skipping the task', async () => {
  const page = await setup(fixture('<div class="ans-attach-ct"><iframe src="/mooc-ans/work/doHomeWorkNew"></iframe></div>'));
  try {
    const frame = page.win.document.querySelector('.ans-attach-ct iframe').contentWindow;
    const commands = [];
    frame.addEventListener('message', (event) => commands.push(event.data));
    page.button.click();
    await page.step();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(page.button.textContent, '停止连播');
    assert.equal(commands[0]?.action, 'solve');
    assert.equal(commands[0]?.channel, 'cxpb-quiz-v1');
    page.button.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(commands.at(-1)?.action, 'cancel', 'stopping should cancel the quiz frame');
  } finally { page.close(); }
});

test('answers choice and judgment questions only after two matching model responses', async () => {
  const questions = [
    '<div class="singleQuesId" data="q1">',
    '<div class="newZy_TItle">单选题</div><p>2 + 2 等于几？</p>',
    '<div class="quiz-option"><span class="num_option">A</span>3</div>',
    '<div class="quiz-option"><span class="num_option">B</span>4</div>',
    '</div><div class="singleQuesId" data="q2">',
    '<div class="newZy_TItle">判断题</div><p>太阳从东方升起。</p>',
    '<div class="quiz-option"><span class="num_option">A</span>正确</div>',
    '<div class="quiz-option"><span class="num_option">B</span>错误</div>',
    '</div>'
  ].join('');
  const result = await runQuizFrame(questions, (question) => ({
    answer: [question.question.includes('2 + 2') ? 'B' : 'A'],
    confidence: 'high'
  }));
  assert.equal(result.result.kind, 'submitted');
  assert.equal(result.requests, 4);
  assert.equal(result.submits, 1);
  assert.equal(result.confirms, 1);
});

test('does not submit when two model passes disagree', async () => {
  const questions = [
    '<div class="singleQuesId" data="q1">',
    '<div class="newZy_TItle">单选题</div><p>2 + 2 等于几？</p>',
    '<div class="quiz-option"><span class="num_option">A</span>3</div>',
    '<div class="quiz-option"><span class="num_option">B</span>4</div>',
    '</div>'
  ].join('');
  const result = await runQuizFrame(questions, (_question, number) => ({
    answer: [number === 1 ? 'A' : 'B'],
    confidence: 'high'
  }));
  assert.equal(result.result.kind, 'error');
  assert.match(result.result.message, /两次判断不一致/);
  assert.equal(result.submits, 0);
});

test('does not call DeepSeek or submit without a locally configured key', async () => {
  const questions = [
    '<div class="singleQuesId" data="q1">',
    '<div class="newZy_TItle">判断题</div><p>太阳从东方升起。</p>',
    '<div class="quiz-option"><span class="num_option">A</span>正确</div>',
    '<div class="quiz-option"><span class="num_option">B</span>错误</div>',
    '</div>'
  ].join('');
  const result = await runQuizFrame(questions, () => ({ answer: ['A'], confidence: 'high' }), false);
  assert.equal(result.result.kind, 'error');
  assert.match(result.result.message, /API Key/);
  assert.equal(result.requests, 0);
  assert.equal(result.submits, 0);
});

test('answers all required options in a multiple-choice question', async () => {
  const questions = [
    '<div class="singleQuesId" data="q1">',
    '<div class="newZy_TItle">多选题</div><p>哪些是偶数？</p>',
    '<div class="quiz-option"><span class="num_option">A</span>2</div>',
    '<div class="quiz-option"><span class="num_option">B</span>3</div>',
    '<div class="quiz-option"><span class="num_option">C</span>4</div>',
    '</div>'
  ].join('');
  const result = await runQuizFrame(questions, () => ({
    answer: ['A', 'C'],
    confidence: 'high'
  }));
  assert.equal(result.result.kind, 'submitted');
  assert.equal(result.requests, 2);
  assert.equal(result.submits, 1);
});

test('cancels before selecting or submitting after the user stops', async () => {
  const questions = [
    '<div class="singleQuesId" data="q1">',
    '<div class="newZy_TItle">单选题</div><p>2 + 2 等于几？</p>',
    '<div class="quiz-option"><span class="num_option">A</span>3</div>',
    '<div class="quiz-option"><span class="num_option">B</span>4</div>',
    '</div>'
  ].join('');
  const result = await runQuizFrame(questions, (_question, number, frame, top) => {
    if (number === 1) {
      frame.dispatchEvent(new frame.MessageEvent('message', {
        origin: 'https://mooc1.chaoxing.com',
        source: top,
        data: { channel: 'cxpb-quiz-v1', action: 'cancel', token: 'test-token' }
      }));
    }
    return { answer: ['B'], confidence: 'high' };
  });
  assert.equal(result.result.kind, 'error');
  assert.match(result.result.message, /已停止/);
  assert.equal(result.requests, 1);
  assert.equal(result.submits, 0);
});

test('does not submit questions that require unreadable images', async () => {
  const questions = [
    '<div class="singleQuesId" data="q1">',
    '<div class="newZy_TItle">单选题</div><p>图中的数字是什么？<img src="/private.png"></p>',
    '<div class="quiz-option"><span class="num_option">A</span>3</div>',
    '<div class="quiz-option"><span class="num_option">B</span>4</div>',
    '</div>'
  ].join('');
  const result = await runQuizFrame(questions, () => ({ answer: ['B'], confidence: 'high' }));
  assert.equal(result.result.kind, 'error');
  assert.match(result.result.message, /图片/);
  assert.equal(result.requests, 0);
  assert.equal(result.submits, 0);
});

test('recognizes a quiz iframe nested inside a chapter card', async () => {
  let quizFrame;
  const page = await setup(fixture('<div class="ans-attach-ct"><iframe id="cards" src="/knowledgecards"></iframe></div>'), (win) => {
    const cardDoc = win.document.querySelector('#cards').contentDocument;
    cardDoc.open();
    cardDoc.write('<!doctype html><html><body><iframe src="/mooc-ans/work/doHomeWorkNew"></iframe></body></html>');
    cardDoc.close();
    quizFrame = cardDoc.querySelector('iframe').contentWindow;
  });
  try {
    const commands = [];
    quizFrame.addEventListener('message', (event) => commands.push(event.data));
    page.button.click();
    await page.step();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(commands[0]?.action, 'solve');
    assert.equal(page.button.textContent, '停止连播');
  } finally { page.close(); }
});