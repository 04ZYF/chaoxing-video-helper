// ==UserScript==
// @name         学习通视频自动播放助手
// @namespace    cx-video-helper
// @version      1.4.5
// @description  自动播放、静音、倍速保持、关闭挂机弹窗、播完自动下一节（视频+文档任务点）。仅辅助播放/阅读，不代答测验/考试。
// @match        *://*.chaoxing.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ---------- 关键：最早把 document.domain 放宽到 chaoxing.com ----------
     学习通顶层页面会把自己的 document.domain 设成 chaoxing.com，但内嵌的
     cards 内容 iframe 只在其"读到顶层 domain 抛错"时才走 catch 也设成
     chaoxing.com。若顶层放宽太晚（document-end），cards 已按 mooc1.chaoxing.com
     初始化 → 顶层(chaoxing.com)与 cards(mooc1.chaoxing.com) 变成跨域 → 脚本
     读不到视频 → 一会能读一会不能读，反复"刷第一个/第二个视频"。
     所以必须在 document-start 最早把顶层 domain 设成 chaoxing.com，
     让 cards 的 domain.js 走 catch 分支同步放宽，两端对齐同源。
  -------------------------------------------------- */
  try {
    document.domain = location.hostname.split('.').slice(-2).join('.');
  } catch (e) { /* 已设过或不可设则忽略 */ }

  // ================= 配置（可改） =================
  const CFG = {
    mute: true,        // 自动静音
    rate: 1,           // 倍速：1 / 1.25 / 1.5（别贪高，异常倍速会进学习行为记录）
    autoNext: true,    // 播完自动下一节
    closePopup: true,  // 自动关闭“是否还在学习”弹窗
    waitJobs: true,    // 跳下一节前等待所有任务点完成
    finishDocs: true,  // 自动完成文档任务点（PPT/PDF：调 finishJob，实测有效）
    pollMs: 5000,      // 主循环间隔（毫秒）。加大可降低操作频率，减少触发 9010 风控
    noVideoJumpMs: 15000, // 无视频小节跳节前的等待（毫秒）
  };
  // ================================================

  const TAG = '[学习通助手]';
  const isTop = window === window.top;

  /* ---------- 弹窗自动关闭（所有 frame 都执行） ---------- */
  setInterval(() => {
    if (!CFG.closePopup) return;
    try {
      const btn = document.querySelector('.layui-layer-btn0');
      if (btn) { btn.click(); return; }
      const layer = document.querySelector('.layui-layer');
      if (layer) {
        const t = [...layer.querySelectorAll('button, a, span')]
          .find(b => /^(确定|继续观看|继续学习|继续)$/.test((b.textContent || '').trim()));
        if (t) t.click();
      }
    } catch (e) { /* 忽略 */ }
  }, 4000);

  /* ================= 只在顶层 frame 工作 ================= */
  if (!isTop) return;
  if (!/\/mycourse\/(studentstudy|studylearn)/.test(location.pathname)) return;

  /* ---------- 页面结构（CDP 实测 2026-10-19） ----------
     顶层 studentstudy 页：
       DIV#coursetree            目录树
         DIV#<chapterId>.firstLayer          章节头（不可点）
         DIV#cur<knowledgeId>               知识点行
           SPAN.posCatalog_name[onclick*=getTeacherAjax]   ← 点击跳知识点（纯 AJAX，实测有效）
         DIV#cur<id>.posCatalog_active       当前高亮行
       DIV#mainid > IFRAME#iframe       知识卡片（/mooc-ans/knowledge/cards）
         内嵌多个媒体 iframe（同源）：/ananas/modules/video/index.html 等
           video.vjs-tech（videojs 播放器）
       隐藏域 #chapterIdid              当前知识点 id
     所有 iframe 与顶层同源 → 直接 contentDocument 穿透。
     底部“下一节”按钮走 PCount.next，任务点没完成会弹窗拦截 → 不用它。
  -------------------------------------------------- */

  function tryAccess(f) {
    try { const d = f.contentDocument; return d && d.readyState !== 'loading' ? d : null; }
    catch (e) { return null; }
  }

  // 递归收集页面所有 video 元素（顶层 + 同源 iframe）
  function allVideos(rootDoc, acc, depth) {
    acc = acc || [];
    if (depth > 4) return acc;
    for (const v of rootDoc.querySelectorAll('video')) acc.push(v);
    for (const f of rootDoc.querySelectorAll('iframe')) {
      const d = tryAccess(f);
      if (d) allVideos(d, acc, (depth || 0) + 1);
    }
    return acc;
  }
  // 不过滤 readyState：学习通视频 preload，未播过时 readyState=0，
  // 若过滤则永远不会对它调用 play() → 死锁不播放（v1.4.1 的 bug）
  function liveVideos() { return allVideos(document, [], 0); }

  // 任务点统计：.ans-job-icon，父级有 .ans-job-finished 即完成
  function jobStats(doc, acc, depth) {
    acc = acc || { total: 0, finished: 0 };
    if (depth > 4) return acc;
    for (const ic of doc.querySelectorAll('.ans-job-icon')) {
      acc.total++;
      if (ic.parentElement && ic.parentElement.classList.contains('ans-job-finished')) acc.finished++;
    }
    for (const f of doc.querySelectorAll('iframe')) {
      const d = tryAccess(f);
      if (d) jobStats(d, acc, (depth || 0) + 1);
    }
    return acc;
  }

  function quizPresent() {
    const urls = [];
    (function walk(doc, depth) {
      if (depth > 4) return;
      for (const f of doc.querySelectorAll('iframe')) {
        urls.push(f.src || '');
        const d = tryAccess(f);
        if (d) walk(d, depth + 1);
      }
    })(document, 0);
    return urls.some(u => /\/(work|exam)\//i.test(u));
  }

  /* ---------- 文档任务点自动完成（PPT/PDF，CDP 实测 2026-10-20） ----------
     文档(insertdoc)渲染在 /ananas/modules/pdf/index.html 这个 frame 里，
     其 contentWindow 暴露 finishJob()/hasJobToFinish()：
       hasJobToFinish() === true  表示存在未完成文档任务点
       finishJob()                 直接上报完成（实测调用后任务点变绿）
     直接调 finishJob 走的是页面自身标准接口，等价于"阅读到最后一页"。
  -------------------------------------------------- */
  let lastDocFinish = 0;
  function finishDocJobs() {
    if (!CFG.finishDocs) return false;
    if (Date.now() - lastDocFinish < 5000) return false; // 限频
    const targets = [];
    (function walk(doc, depth) {
      if (depth > 4) return;
      for (const f of doc.querySelectorAll('iframe')) {
        if (/\/ananas\/modules\/pdf\/index\.html/i.test(f.src || '')) {
          try {
            const w = f.contentWindow;
            if (w && typeof w.finishJob === 'function' && typeof w.hasJobToFinish === 'function' && w.hasJobToFinish()) {
              targets.push(w);
            }
          } catch (e) { /* 跨域或未加载 */ }
        }
        const d = tryAccess(f);
        if (d) walk(d, depth + 1);
      }
    })(document, 0);
    if (!targets.length) return false;
    for (const w of targets) {
      try { w.finishJob(); console.log(TAG, '已完成文档任务点'); } catch (e) { console.log(TAG, '文档完成失败:', e.message); }
    }
    lastDocFinish = Date.now();
    return true;
  }

  /* ---------- 目录导航（getTeacherAjax，已 CDP 实测跳转成功） ---------- */
  function catalogRows() {
    const rows = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('#coursetree .posCatalog_select')) {
      const id = el.id.replace(/^cur/, '');
      if (seen.has(id)) continue;
      seen.add(id);
      const span = el.querySelector('.posCatalog_name[onclick*="getTeacherAjax"]');
      const nameEl = el.querySelector('.posCatalog_name');
      rows.push({
        id,
        el,
        span,
        name: nameEl ? (nameEl.textContent || '').trim().slice(0, 30) : '',
        isLeaf: !!span,
        finished: !!el.querySelector('.icon_Completed'),
      });
    }
    return rows;
  }

  function currentId() {
    return (document.getElementById('chapterIdid') || {}).value || null;
  }

  /* ---------- 面板 ---------- */
  let statusHoldUntil = 0;
  function setStatus(t, hold) {
    const s = document.getElementById('cxh-status');
    if (s) s.textContent = t;
    if (hold) statusHoldUntil = Date.now() + (typeof hold === 'number' ? hold : 6000);
  }

  function buildPanel() {
    if (document.getElementById('cxh-panel')) return;
    const p = document.createElement('div');
    p.id = 'cxh-panel';
    const jitter = 14 + (Math.random() * 40 | 0);
    p.style.cssText = 'position:fixed;right:14px;bottom:' + jitter + 'px;z-index:2147483647;' +
      'background:rgba(20,20,20,.85);color:#fff;padding:10px 12px;border-radius:10px;' +
      'font:12px/1.8 system-ui,sans-serif;display:flex;flex-direction:column;user-select:none;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.4)';
    p.innerHTML =
      '<b style="font-size:13px">学习通助手 v1.4.5</b>' +
      '<label><input type="checkbox" id="cxh-mute"' + (CFG.mute ? ' checked' : '') + '> 自动静音</label>' +
      '<label>倍速 <select id="cxh-rate" style="color:#000">' +
        [1, 1.25, 1.5].map(r => '<option value="' + r + '"' + (CFG.rate === r ? ' selected' : '') + '>' + r + 'x</option>').join('') +
      '</select></label>' +
      '<label><input type="checkbox" id="cxh-next"' + (CFG.autoNext ? ' checked' : '') + '> 播完自动下一节</label>' +
      '<button id="cxh-gonext" style="margin-top:4px;cursor:pointer;background:#2d7ff9;color:#fff;border:0;border-radius:5px;padding:3px 8px">⏭ 下一节</button>' +
      '<span id="cxh-status" style="opacity:.75"></span>';
    (document.body || document.documentElement).appendChild(p);
    p.querySelector('#cxh-mute').onchange = e => { CFG.mute = e.target.checked; if (CFG.mute) for (const v of liveVideos()) v.muted = true; };
    p.querySelector('#cxh-rate').onchange = e => { CFG.rate = parseFloat(e.target.value); for (const v of liveVideos()) v.playbackRate = CFG.rate; };
    p.querySelector('#cxh-next').onchange = e => { CFG.autoNext = e.target.checked; };
    p.querySelector('#cxh-gonext').onclick = () => gotoNext(true);
  }

  /* ---------- 跳下一节 ---------- */
  let navBusy = false;
  let lastNav = Date.now();

  function gotoNext(manual) {
    if (navBusy) return false;
    const rows = catalogRows();
    const kid = currentId();
    let idx = kid ? rows.findIndex(r => r.id === kid) : -1;
    if (idx < 0) {
      const hl = rows.findIndex(r => r.el.classList.contains('posCatalog_active'));
      if (hl >= 0) idx = hl;
    }
    if (idx < 0) { setStatus('✖ 未找到当前小节（目录缺失？）', true); return false; }
    let next = null;
    for (let i = idx + 1; i < rows.length; i++) {
      if (rows[i].isLeaf) { next = rows[i]; break; }
    }
    if (!next) { setStatus('✖ 已是最后一节', true); return false; }
    navBusy = true;
    setStatus('→ ' + next.name, true);
    try { next.span.scrollIntoView({ block: 'center' }); } catch (e) {}
    setTimeout(() => {
      try { next.span.click(); } catch (e) {}
      setTimeout(() => {
        navBusy = false;
        lastNav = Date.now();
        const newKid = currentId();
        if (newKid === next.id) setStatus('✔ ' + next.name, true);
        else if (manual) setStatus('✖ 点击后未跳转', true);
      }, 3000);
    }, 350);
    return true;
  }

  /* ---------- 主循环（顶层） ---------- */
  const fmt = t => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
  let lastPanelBuild = 0;

  setInterval(() => {
    // 面板可能被 AJAX 换章冲掉，定期补建
    if (Date.now() - lastPanelBuild > 5000) {
      buildPanel();
      lastPanelBuild = Date.now();
    }

    const videos = liveVideos();

    if (!videos.length) {
      // 没有视频的小节：等内容区加载完、确认不含视频模块后，10 秒自动跳
      const cards = document.getElementById('iframe');
      const cd = cards && tryAccess(cards);
      if (!cd || cd.readyState !== 'complete') return; // 内容区还在加载
      // 若有未完成文档任务点（纯 PPT/PDF 小节），先自动完成再跳
      if (finishDocJobs()) { setStatus('完成文档任务点…', true); return; }
      const hasVideoModule = [...cd.querySelectorAll('iframe')].some(f => /\/ananas\/modules\/video\//.test(f.src || ''));
      if (CFG.autoNext && !hasVideoModule && Date.now() - lastNav > CFG.noVideoJumpMs && !navBusy) {
        if (quizPresent()) { setStatus('检测到测验/作业，自动跳过已暂停', true); return; }
        lastNav = Date.now();
        console.log(TAG, '本节无视频，跳下一节');
        gotoNext(false);
      }
      return;
    }

    // 有视频：对每个视频应用静音/倍速（不动播放状态，避免多视频并发互相顶掉）
    for (const v of videos) {
      if (CFG.mute) v.muted = true;
      if (Math.abs(v.playbackRate - CFG.rate) > 0.01) v.playbackRate = CFG.rate;
    }

    // 串行播放：同一时刻只让一个视频播，播完一个再播下一个。
    // 学习通同一卡片里的多个视频是 videojs 堆叠的，同时 play() 会互相顶掉，
    // 造成"一会播第一个一会播第二个"来回切换。所以按顺序播。
    const notEnded = videos.filter(v => !(v.ended && v.duration > 0));
    const anyPlaying = notEnded.some(v => !v.paused);
    if (!anyPlaying && notEnded.length) {
      // 找到第一个还没结束的视频，只播它（其余保持暂停）
      const target = notEnded[0];
      target.play().catch(e => console.log(TAG, 'play() 被拒绝:', e.name, e.message));
    }

    // 所有视频都播完 → 检查任务点 → 跳下一节
    const ended = videos.every(v => v.ended && v.duration > 0);
    if (ended && CFG.autoNext && !navBusy) {
      if (quizPresent()) { setStatus('检测到测验/作业，停在当前小节', true); return; }
      const jobs = jobStats(document, null, 0);
      if (CFG.waitJobs && jobs.total > 0 && jobs.finished < jobs.total) {
        // 还有未完成任务点：先尝试自动完成文档任务点，再继续等待
        finishDocJobs();
        setStatus('任务点完成 ' + jobs.finished + '/' + jobs.total + '，等待中…');
        return;
      }
      lastNav = Date.now();
      console.log(TAG, '本节全部视频播完，跳下一节');
      gotoNext(false);
      return;
    }

    // 常规状态行
    if (Date.now() > statusHoldUntil) {
      const notEnded = videos.filter(v => !(v.ended && v.duration > 0));
      const playing = notEnded.filter(v => !v.paused).length;
      const v0 = notEnded[0] || videos[0];
      setStatus('▶ ' + playing + '/' + videos.length + ' 在播 ' + fmt(v0.currentTime) + '/' + fmt(v0.duration || 0));
    }
  }, CFG.pollMs);
})();
