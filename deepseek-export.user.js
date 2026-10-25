// ==UserScript==
// @name         DeepSeek 对话导出助手（单条导出 / 纯文本复制 / 多格式下载）
// @name:en      DeepSeek Chat Export Assistant
// @namespace    https://github.com/xubbllanan-lab/deepseek-export-assistant
// @version      5.7.10
// @description  接口级数据提取（用户提问 100% 准确），整段对话一键复制纯文本 / 下载 TXT·MD·HTML·JSON·Word(docx)·PDF；排版对齐 DeepSeek 原生样式，自动清除全部 Emoji；每条回答旁可单独导出这一轮（含提问），DeepSeek 配色现代界面。
// @description:en  API-level extraction, plain-text copy, multi-format download (true .docx), DeepSeek-native typography, emoji stripped, per-message export.
// @author       xubbllanan-lab
// @license      MIT
// @copyright    2026 xubbllanan-lab
// @homepageURL  https://github.com/xubbllanan-lab/deepseek-export-assistant
// @supportURL   https://github.com/xubbllanan-lab/deepseek-export-assistant/issues
// @contributor  WorkBuddy
// @match        https://chat.deepseek.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=deepseek.com
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        unsafeWindow
// @require      https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js
// @updateURL    https://raw.githubusercontent.com/xubbllanan-lab/deepseek-export-assistant/main/deepseek-export.meta.js
// @downloadURL  https://raw.githubusercontent.com/xubbllanan-lab/deepseek-export-assistant/main/deepseek-export.user.js
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_VERSION = '5.7.10';

  /* ============================================================
   * 0. 选择器
   * ============================================================ */
  const S = {
    aiMessage: '.ds-message',
    markdown: '.ds-markdown',
    thinkContent: '.ds-think-content',
    convItem: 'a[href*="/a/chat/s/"]',
    convTitle: '.c08e6e93',
  };

  /* ============================================================
   * 1. 工具
   * ============================================================ */
  function q(sel, root) { return (root || document).querySelector(sel); }
  function qa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function safeName(s) {
    return (s || 'DeepSeek对话').replace(/[\\/:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'DeepSeek对话';
  }

  function nowStamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function currentConvId() {
    const m = location.href.match(/\/a\/chat\/s\/([^/?]+)/);
    return m ? m[1] : null;
  }

  /* ============================================================
   * 2. 接口拦截（从 DeepSeek 历史接口拿原始消息，用户提问 100% 准确）
   * ============================================================ */
  const apiStore = { byConv: {}, latest: null };

  function ingestApi(url, data) {
    try {
      const found = [];
      findMessageArrays(data, found);
      found.forEach(arr => {
        const msgs = normalizeMessages(arr);
        if (msgs.length >= 1) {
          const cid = convIdFromUrl(String(url)) || currentConvId() || 'latest';
          const prev = apiStore.byConv[cid];
          if (!prev || msgs.length >= prev.length) apiStore.byConv[cid] = msgs;
          if (!apiStore.latest || msgs.length >= apiStore.latest.length) apiStore.latest = msgs;
        }
      });
    } catch (e) { /* 静默 */ }
  }

  function convIdFromUrl(url) {
    let m = url.match(/a\/chat\/s\/([a-zA-Z0-9_-]{8,})/);
    if (m) return m[1];
    m = url.match(/chat\/history\/([a-zA-Z0-9_-]{8,})/);
    if (m) return m[1];
    m = url.match(/conversation[_/]?id=([a-zA-Z0-9_-]{8,})/i);
    if (m) return m[1];
    return null;
  }

  function findMessageArrays(data, out) {
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data)) {
      if (data.length && data.some(x => x && typeof x === 'object' && x.role)) out.push(data);
      else if (data.length) data.forEach(x => findMessageArrays(x, out));
      return;
    }
    for (const k in data) {
      if (Object.prototype.hasOwnProperty.call(data, k)) findMessageArrays(data[k], out);
    }
  }

  function normalizeMessages(arr) {
    const msgs = [];
    arr.forEach(item => {
      if (!item || typeof item !== 'object') return;
      const role = String(item.role || item.role_type || '').toLowerCase();
      const isUser = role.includes('user');
      const isAI = role.includes('assistant') || role === 'ai' || role.includes('bot');
      if (!isUser && !isAI) return;
      let content = item.content;
      if (typeof content !== 'string') content = item.text || item.fragment || '';
      if (typeof content !== 'string' || !content.trim()) return;
      const thinking = typeof item.thinking_content === 'string' ? item.thinking_content
        : (typeof item.thinking === 'string' ? item.thinking : '');
      msgs.push({
        role: isUser ? 'user' : 'assistant',
        content: stripEmoji(content),
        thinking: stripEmoji(thinking),
      });
    });
    return msgs;
  }

  function getApiMessages() {
    const id = currentConvId();
    if (id && apiStore.byConv[id] && apiStore.byConv[id].length) return apiStore.byConv[id];
    if (apiStore.latest && apiStore.latest.length) return apiStore.latest;
    return null;
  }

  function installNetworkHooks() {
    try {
      const uw = unsafeWindow || window;
      const origFetch = uw.fetch;
      if (origFetch) {
        uw.fetch = async function (...args) {
          const res = await origFetch.apply(this, args);
          try {
            const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
            const ct = res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '';
            if (ct.includes('json') && !ct.includes('stream')) {
              res.clone().json().then(data => ingestApi(url, data)).catch(() => { });
            }
          } catch (e) { /* 静默 */ }
          return res;
        };
      }
      const XHR = uw.XMLHttpRequest;
      if (XHR && XHR.prototype) {
        const oOpen = XHR.prototype.open;
        const oSend = XHR.prototype.send;
        XHR.prototype.open = function (method, url) {
          try { this.__dsxUrl = String(url || ''); } catch (e) { /* 静默 */ }
          return oOpen.apply(this, arguments);
        };
        XHR.prototype.send = function () {
          try {
            this.addEventListener('load', () => {
              try {
                const ct = this.getResponseHeader('content-type') || '';
                if (ct.includes('json')) {
                  const data = JSON.parse(this.responseText);
                  ingestApi(this.__dsxUrl || '', data);
                }
              } catch (e) { /* 静默 */ }
            });
          } catch (e) { /* 静默 */ }
          return oSend.apply(this, arguments);
        };
      }
    } catch (e) { /* 静默 */ }
  }

  function apiToBlocks(apiMsgs) {
    return apiMsgs.map(m => m.role === 'user'
      ? { role: 'user', content: m.content, contentMd: m.content, fromApi: true }
      : {
        role: 'assistant',
        thinking: m.thinking || '',
        answer: m.content,
        thinkingMd: m.thinking || '',
        answerMd: m.content,
        block: null,
        fromApi: true,
      });
  }

  /* ============================================================
   * 3. 复制 / 下载
   * ============================================================ */
  function copyText(text) {
    return new Promise((resolve, reject) => {
      try {
        if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, 'text'); resolve(); return; }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(resolve, () => fallbackCopy(text, resolve, reject));
          return;
        }
        fallbackCopy(text, resolve, reject);
      } catch (e) { fallbackCopy(text, resolve, reject); }
    });
  }
  function fallbackCopy(text, resolve, reject) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      ok ? resolve() : reject(new Error('copy failed'));
    } catch (e) { reject(e); }
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: (mime || 'text/plain') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  /* ============================================================
   * 4. 消息提取（API 优先，DOM 兜底）
   * ============================================================ */
  const NOISE_RE = [
    /^$/, /^深度思考$/, /^已深度思考$/, /^思考中$/,
    /^(已深度思考|思考用时).*/, /^(共搜索|联网搜索|已搜索).*/,
    /^\d+ 个(网页|来源|结果).*$/, /^本回答由 ?AI 生成.*$/, /^内容由 ?AI 生成.*$/,
    /^(复制|重新生成|点赞|点踩|分享|语音|朗读|导出|编辑|收藏|重试)$/,
    /^\d+\/\d+$/,
  ];

  function cleanText(el) {
    const clone = el.cloneNode(true);
    qa('button, svg, textarea, input, img, style, script', clone).forEach(e => e.remove());
    const blocks = qa('p, div, h1, h2, h3, h4, h5, h6, li, tr, blockquote, pre', clone);
    blocks.forEach(b => {
      try {
        if (!b.parentNode) return;
        b.parentNode.insertBefore(document.createTextNode('\n'), b);
        b.parentNode.insertBefore(document.createTextNode('\n'), b.nextSibling);
      } catch (e) { /* ignore */ }
    });
    qa('br', clone).forEach(br => {
      try { br.parentNode.insertBefore(document.createTextNode('\n'), br); } catch (e) { /* ignore */ }
    });
    let t = (clone.textContent || '');
    t = t.split('\n').map(s => s.trim()).filter(s => !NOISE_RE.some(re => re.test(s))).join('\n');
    return t.replace(/\n{3,}/g, '\n\n').trim();
  }

  function findStreamContainer() {
    const ais = qa(S.aiMessage);
    if (!ais.length) return null;
    let p = ais[0].parentElement;
    while (p && p !== document.body) {
      const direct = Array.from(p.children).filter(c => c.querySelector(S.aiMessage));
      if (direct.length >= 2) return p;
      p = p.parentElement;
    }
    return null;
  }

  function extractItemMessages(el) {
    const out = [];
    // el 自身就可能是 AI 消息块（父容器直接是 .ds-message 时只查后代会漏掉）
    const selfIsAI = !!(el.matches && el.matches(S.aiMessage));
    const aiBlocks = selfIsAI ? [el] : qa(S.aiMessage, el);
    if (!aiBlocks.length) {
      const t = stripEmoji(cleanText(el));
      if (t) out.push({ role: 'user', content: t, contentMd: t });
      return out;
    }
    // 自身就是 AI 块时没有「提问」可言，不能把整条回答当成用户消息
    let userText = '';
    if (!selfIsAI) {
      const clone = el.cloneNode(true);
      qa(S.aiMessage + ', ' + S.thinkContent, clone).forEach(e => e.remove());
      userText = stripEmoji(cleanText(clone));
    }
    if (userText) out.push({ role: 'user', content: userText, contentMd: userText });
    aiBlocks.forEach(block => {
      const m = extractOneAssistant(block);
      if (m) out.push(m);
    });
    return out;
  }

  function extractOneAssistant(block) {
    const thinkEl = q(S.thinkContent, block);
    const thinking = thinkEl ? (thinkEl.innerText || '').trim() : '';
    const mds = qa(S.markdown, block).filter(el => !el.closest(S.thinkContent));
    const answer = stripCitations(stripEmoji(mds.map(e => (e.innerText || '').trim()).filter(Boolean).join('\n\n')));
    if (!thinking && !answer) return null;
    const thinkingMd = stripCitations(stripEmoji(thinkEl ? domToMarkdown(thinkEl) : ''));
    const answerMd = stripCitations(stripEmoji(mds.map(e => domToMarkdown(e)).filter(Boolean).join('\n\n')));
    return { role: 'assistant', thinking: stripEmoji(thinking), answer, thinkingMd, answerMd, block };
  }

  function getBlocksFromDom() {
    const stream = findStreamContainer();
    if (stream) {
      const msgs = [];
      Array.from(stream.children).forEach(child => {
        try { extractItemMessages(child).forEach(m => msgs.push(m)); }
        catch (err) { console.warn('[DeepSeek导出助手] 单条消息提取失败，已跳过：', err); }
      });
      if (msgs.some(m => m.role === 'assistant')) return msgs;
    }
    const ais = qa(S.aiMessage);
    if (!ais.length) return [];
    let common = ais[0].parentElement;
    for (const ai of ais) {
      while (common && !common.contains(ai)) common = common.parentElement;
    }
    const msgs = [];
    if (common) {
      Array.from(common.children).forEach(child => {
        try { extractItemMessages(child).forEach(m => msgs.push(m)); }
        catch (err) { console.warn('[DeepSeek导出助手] 单条消息提取失败，已跳过：', err); }
      });
    }
    return msgs;
  }

  function getBlocks() {
    const api = getApiMessages();
    if (api && api.length) {
      const blocks = apiToBlocks(api);
      if (blocks.some(m => m.role === 'user')) return blocks;
    }
    return getBlocksFromDom();
  }

  function getCurrentTitle() {
    const t = stripEmoji((document.title || '').replace(/\s*[-|–—·]\s*(DeepSeek|深度求索).*$/i, '').trim());
    if (t) return t;
    const active = q(S.convItem + '[class*="active"], ' + S.convItem + '[aria-current="page"]');
    if (active) {
      const te = q(S.convTitle, active);
      if (te && te.textContent.trim()) return stripEmoji(te.textContent.trim());
    }
    return 'DeepSeek对话';
  }

  /* ============================================================
   * 5. DOM → Markdown
   * ============================================================ */
  function latexOf(katexEl) {
    const ann = katexEl.querySelector('annotation[encoding="application/x-tex"]');
    return ann ? ann.textContent : (katexEl.textContent || '');
  }

  function inlineText(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const s = node.textContent;
      // 纯空白节点：含换行的保留为换行（Markdown 软换行，DeepSeek 里是另起一行）
      // 纯缩进空格保留一个空格，避免单词粘连
      if (!s.trim()) return s.includes('\n') ? '\n' : ' ';
      return s;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName;
    if (node.classList) {
      if (node.classList.contains('katex-display')) return `\n$$${latexOf(node)}$$\n`;
      if (node.classList.contains('katex')) return `$${latexOf(node)}$`;
    }
    if (tag === 'BR') return '\n';
    if (tag === 'STRONG' || tag === 'B') return '**' + innerInline(node) + '**';
    if (tag === 'EM' || tag === 'I') return '*' + innerInline(node) + '*';
    if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return '~~' + innerInline(node) + '~~';
    if (tag === 'CODE') return '`' + node.textContent + '`';
    if (tag === 'A') {
      const href = node.getAttribute('href') || '';
      const txt = innerInline(node);
      return (href && href !== txt) ? `[${txt}](${href})` : txt;
    }
    if (tag === 'IMG') return `![${node.getAttribute('alt') || ''}](${node.getAttribute('src') || ''})`;
    return innerInline(node);
  }
  // 块级标签：在行内提取流程中遇到时必须交给块级转换器，
  // 否则 <div> 包裹的列表/段落会被拼接成一整行（深度思考内容粘连的根因）
  const BLOCK_TAG_RE = /^(P|DIV|UL|OL|LI|TABLE|PRE|BLOCKQUOTE|H[1-6]|HR)$/;
  function innerInline(node) {
    let out = '';
    const kids = node.childNodes;
    const isBlockEl = n => n && n.nodeType === Node.ELEMENT_NODE && BLOCK_TAG_RE.test(n.tagName);
    kids.forEach((c, idx) => {
      // 空白文本节点：紧邻块级元素 → 标签间缩进，丢弃；
      // 夹在行内内容之间 → 段内软换行（DeepSeek 里的另起一行），保留
      if (c.nodeType === Node.TEXT_NODE && !c.textContent.trim() && c.textContent.includes('\n')) {
        if (isBlockEl(kids[idx - 1]) || isBlockEl(kids[idx + 1])) return;
        out += '\n';
        return;
      }
      if (c.nodeType === Node.ELEMENT_NODE && BLOCK_TAG_RE.test(c.tagName)) {
        const block = domToMarkdown(c);
        if (block) out += '\n\n' + block + '\n\n';
      } else {
        out += inlineText(c);
      }
    });
    return out;
  }

  function detectCodeLang(codeEl) {
    const cls = String((codeEl && codeEl.className) || '');
    const m = cls.match(/language-([\w+#.-]+)/) || cls.match(/lang-([\w+#.-]+)/);
    return m ? m[1] : '';
  }

  function domToMarkdown(root) {
    let out = '';
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { if (node.textContent.trim()) out += node.textContent; return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName;
      const cls = node.classList || { contains: () => false };
      if (cls.contains('katex-display')) { out += `\n$$\n${latexOf(node)}\n$$\n\n`; return; }
      if (cls.contains('katex')) { out += `$${latexOf(node)}$`; return; }
      switch (tag) {
        case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
          out += '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + innerInline(node) + '\n\n'; return;
        case 'P': case 'DIV': out += '\n\n' + innerInline(node) + '\n\n'; return;
        case 'UL': case 'OL': {
          // 只取直接子项：querySelectorAll('li') 会把嵌套子项也拿出来，
          // 导致子项重复输出（父项里已经递归过一次）
          const items = Array.from(node.children).filter(el => el.tagName === 'LI');
          out += '\n';
          items.forEach((li, i) => {
            out += (tag === 'OL' ? `${i + 1}. ` : '- ') + liToMd(li, 1) + '\n';
          });
          out += '\n'; return;
        }
        case 'BLOCKQUOTE':
          out += '\n\n' + innerInline(node).split('\n').map(l => '> ' + l).join('\n') + '\n\n'; return;
        case 'PRE': {
          const codeEl = node.querySelector('code');
          const lang = detectCodeLang(codeEl);
          const code = codeEl ? codeEl.innerText : node.innerText;
          out += `\n\n\`\`\`${lang}\n${code.replace(/\n$/, '')}\n\`\`\`\n\n`; return;
        }
        case 'HR': out += '\n\n---\n\n'; return;
        case 'TABLE': out += '\n\n' + tableToMd(node) + '\n\n'; return;
        case 'BR': out += '\n'; return;
        case 'STRONG': case 'B': out += '**' + innerInline(node) + '**'; return;
        case 'EM': case 'I': out += '*' + innerInline(node) + '*'; return;
        case 'DEL': case 'S': out += '~~' + innerInline(node) + '~~'; return;
        case 'CODE': out += '`' + node.textContent + '`'; return;
        case 'A': {
          const href = node.getAttribute('href') || '';
          const txt = innerInline(node).trim();
          // 引用角标（[1] / [-27] 指向外链）直接丢弃，否则文档里会出现一串神秘字符
          if (/^-?\d+$/.test(txt)) return;
          out += (href && href !== txt) ? `[${txt}](${href})` : txt; return;
        }
        case 'IMG': out += `![${node.getAttribute('alt') || ''}](${node.getAttribute('src') || ''})`; return;
        default: node.childNodes.forEach(walk);
      }
    };
    walk(root);
    // 过滤没有文字的纯空白行，再把 3 个以上连续换行收敛为 1 个空行
    return stripCitations(out).replace(/^[ \t\u00A0]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  // 单个列表项 → Markdown：正文收起为一行，子列表保留换行并按「每层 4 空格」缩进
  // （有序列表的嵌套必须 ≥3 空格，否则解析器会当成同级、编号被拉平）
  function liToMd(li, depth) {
    let head = '';
    let nested = '';
    const pad = '    '.repeat(Math.max(1, depth || 1));
    Array.from(li.childNodes).forEach(c => {
      if (c.nodeType === Node.ELEMENT_NODE && (c.tagName === 'UL' || c.tagName === 'OL')) {
        const sub = domToMarkdown(c);
        if (sub) nested += '\n' + sub.split('\n').map(l => (l ? pad + l : l)).join('\n');
      } else if (c.nodeType === Node.ELEMENT_NODE && /^(P|DIV)$/.test(c.tagName)) {
        head += innerInline(c);
      } else {
        head += inlineText(c);
      }
    });
    head = head.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
    return head + nested;
  }

  function tableToMd(table) {
    const rows = [];
    qa('tr', table).forEach(tr => {
      rows.push(qa('th,td', tr).map(c => innerInline(c).replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ').trim()));
    });
    if (!rows.length) return '';
    const colCount = Math.max(...rows.map(r => r.length));
    const norm = rows.map(r => { while (r.length < colCount) r.push(''); return r; });
    let md = '| ' + norm[0].join(' | ') + ' |\n| ' + norm[0].map(() => '---').join(' | ') + ' |\n';
    norm.slice(1).forEach(r => { md += '| ' + r.join(' | ') + ' |\n'; });
    return md;
  }

  /* ============================================================
   * 6. 序列化器
   * ============================================================ */
  // 去除所有 Emoji / 符号表情
  function stripEmoji(s) {
    return String(s || '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '');
  }

  // 标题是否已自带序号（中文 一、/（一）/ 西文 1. 都算）
  function hasOwnNumber(s) {
    const t = String(s || '').trim();
    return /^[（(]?[一二三四五六七八九十百千]+[）)、.．]/.test(t)
      || /^[（(]?\d+(?:[.．]\d+)*[）)、.．]/.test(t)
      || /^[①②③④⑤⑥⑦⑧⑨⑩]/.test(t);
  }

  // 去掉 DeepSeek 自带的西文编号前缀（"1."、"1.1 "、"（2）" 等），
  // 避免与我们的 1 / 1.1 / 1.1.1 叠加成 "1　1. 标题"
  function cleanHeadNum(s) {
    let r = String(s || '');
    // （1）/（2.1）这类括号编号
    r = r.replace(/^\s*[（(]\s*\d+(?:[.．]\d+)*\s*[）)]\s*/, '');
    // 1. / 1.1 / 2、 这类西文编号（要求带分隔符或多级点号，避免误伤 "30 分钟" 这类正文）
    r = r.replace(/^\s*\d+(?:(?:[.．]\d+)+[.、．]?|[.、．])\s*/, '');
    return r;
  }

  // Markdown → 纯文本：彻底清掉 # * ` > --- 等标记，代码块只留内容
  function mdToPlain(md) {
    let t = String(md || '');
    t = t.replace(/\$\$([\s\S]*?)\$\$/g, (m, f) => '\n' + f.trim() + '\n');
    t = t.replace(/\$([^$\n]+)\$/g, '$1');
    t = t.replace(/```[\w+#.-]*[ \t]*\n?([\s\S]*?)```/g, (m, code) => code);
    t = t.replace(/`([^`]+)`/g, '$1');
    t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
    t = t.replace(/^[ \t]{0,3}>[ \t]?/gm, '');
    t = t.replace(/^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '');
    t = t.replace(/^[ \t]{0,3}[-*+][ \t]*$/gm, '');
  t = t.replace(/^[ \t]{0,3}[-*+][ \t]+/gm, '');
    t = t.replace(/^[ \t]{0,3}\d+[.)][ \t]+/gm, '');
    t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
    t = t.replace(/__([^_]+)__/g, '$1');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2');
    t = t.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, '$1$2');
    t = t.replace(/~~([^~]+)~~/g, '$1');
    t = t.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (m, row) => row.split('|').map(c => c.trim()).filter(Boolean).join('　'));
    t = t.replace(/^[ \t]*\|?[\s:|-]+\|?[ \t]*$/gm, '');
    t = stripEmoji(t);
    t = t.replace(/[ \t]+$/gm, '');
    return t.replace(/\n{3,}/g, '\n\n').trim();
  }

  // 纯文本：角色独占一行，正文另起一行，轮次之间空两行
  function buildPlainText(messages) {
    const blocks = [];
    messages.forEach(m => {
      if (m.role === 'user') {
        blocks.push('【我】\n' + mdToPlain(m.contentMd || m.content));
      } else {
        let s = '【DeepSeek】\n';
        const think = mdToPlain(m.thinkingMd || m.thinking || '');
        if (think) s += '〔深度思考〕\n' + think + '\n\n';
        s += mdToPlain(m.answerMd || m.answer);
        blocks.push(s);
      }
    });
    return blocks.join('\n\n\n');
  }

  // toMarkdown：严格遵循 Markdown 规范（给 Obsidian / Notion 用）
  // · 对话分隔用 *** （不用 --- ，--- 易被识别为 Setext 前置标题语法）
  // · 角色标记用加粗独占一行： **【我】** / **【DeepSeek】**
  // · 思考过程用 <details><summary>深度思考过程</summary> 折叠包装
  function buildMarkdown(messages, title) {
    const lines = ['# ' + stripEmoji(String(title || 'DeepSeek 对话')), '', '> 导出时间：' + nowStamp(), ''];
    messages.forEach((m, i) => {
      if (m.role === 'user') {
        lines.push('**【我】**', '', stripEmoji(m.contentMd || m.content || ''), '');
      } else {
        const tk = stripEmoji(m.thinkingMd || m.thinking || '');
        if (tk.trim()) {
          lines.push('<details>', '<summary>深度思考过程</summary>', '', tk, '', '</details>', '');
        }
        lines.push('**【DeepSeek】**', '', stripEmoji(m.answerMd || m.answer || ''), '');
      }
      if (i < messages.length - 1) lines.push('***', '');
    });
    return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
  }

  function buildJson(messages, title) {
    return JSON.stringify({
      title, exportedAt: new Date().toISOString(), source: location.href,
      messages: messages.map(m => m.role === 'user'
        ? { role: 'user', content: m.content }
        : { role: 'assistant', thinking: m.thinking || null, content: m.answer }),
    }, null, 2);
  }

  function mdToHtml(md) {
    let html = escHtml(stripEmoji(String(md || '')));
    html = html.replace(/```([\w+#.-]*)\n([\s\S]*?)```/g, (m, lang, code) => `<pre><code>${code}</code></pre>`);
    html = html.replace(/^###### (.*)$/gm, '<h6>$1</h6>');
    html = html.replace(/^##### (.*)$/gm, '<h5>$1</h5>');
    html = html.replace(/^#### (.*)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.*)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.*)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.*)$/gm, '<h1>$1</h1>');
    html = html.replace(/^\s*(---|\*\*\*)\s*$/gm, '<hr>');
    html = html.replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>');
    // 列表：按缩进识别层级（marked 未加载时的兜底路径，不能把嵌套子项挤成一行）
    const liIndent = (ind) => Math.min(3, Math.floor(String(ind || '').replace(/\t/g, '  ').length / 2));
    html = html.replace(/^([ \t]*)[-*] (.*)$/gm, (m, ind, txt) => {
      const lv = liIndent(ind);
      return `<li${lv ? ` style="margin-left:${lv * 20}px"` : ''}>${txt}</li>`;
    });
    html = html.replace(/^([ \t]*)\d+\. (.*)$/gm, (m, ind, txt) => {
      const lv = liIndent(ind);
      return `<li${lv ? ` style="margin-left:${lv * 20}px"` : ''}>${txt}</li>`;
    });
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
    html = html.split(/\n{2,}/).map(block => {
      const t = block.trim();
      if (!t) return '';
      if (/^<(h\d|hr|pre|blockquote|ul|ol|li|table)/.test(t)) {
        if (/^<li>/.test(t)) return '<ul>' + t + '</ul>';
        return t;
      }
      return '<p>' + t.replace(/\n/g, '<br>') + '</p>';
    }).join('\n');
    return html;
  }

  // Markdown → HTML：优先用 marked.parse，异常时降级到内置转换
  function mdToHtmlMarked(md) {
    // 三级标题已取消：##/###… 统一压成一级；编号规则与 docx 一致（单级递增、自带序号不叠加）
    let src = stripCitations(stripEmoji(String(md || ''))).replace(/^#{2,6}\s+/gm, '# ');
    let n = 0;
    src = src.replace(/^#\s+(.+?)\s*$/gm, (m, t) => {
      const tt = cleanHeadNum(t);
      if (hasOwnNumber(tt)) return '# ' + tt;
      n += 1;
      return '# ' + n + '. ' + tt;
    });
    try {
      if (typeof marked !== 'undefined' && typeof marked.parse === 'function') {
        return marked.parse(src, { gfm: true, breaks: true });
      }
    } catch (e) { /* 降级 */ }
    return mdToHtml(src);
  }

  // 富文本 / .html 导出：每轮一个容器，对话边界清晰，深度思考独立区块
  function buildHtmlMarked(messages, title) {
    const rounds = [];
    messages.forEach(m => {
      if (m.role === 'user') {
        rounds.push({ user: m.contentMd || m.content, ai: [] });
      } else {
        if (!rounds.length) rounds.push({ user: '', ai: [] });
        rounds[rounds.length - 1].ai.push(m);
      }
    });

    const body = rounds.map(r => {
      let inner = '';
      if (r.user) {
        inner += `<div style="font-weight:700;font-size:14px;color:#1b2559;margin-bottom:8px;">【我】</div>
<div style="margin:0;color:#2a3247;">${mdToHtmlMarked(r.user)}</div>`;
      }
      r.ai.forEach(a => {
        let think = '';
        const tk = a.thinkingMd || a.thinking || '';
        if (tk.trim()) {
          think = `<div style="margin:0;padding:6px 12px;background:#f6f7fb;border-left:3px solid #b9caff;border-radius:8px;line-height:1.3;">
<div style="font-weight:700;font-size:12.5px;color:#6b7280;margin-bottom:6px;">深度思考</div>
<div style="color:#5b6472;font-size:13.5px;">${mdToHtmlMarked(tk)}</div>
</div>`;
        }
        inner += `<div style="font-weight:700;font-size:14px;color:#1b2559;margin-bottom:8px;">【DeepSeek】</div>
${think}<div style="color:#2a3247;">${mdToHtmlMarked(a.answerMd || a.answer)}</div>`;
      });
      return `<div style="margin:0;padding:0 0 6px;border-bottom:1px solid #eee;">${inner}</div>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escHtml(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"
  onload="try{renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}],throwOnError:false})}catch(e){}"></script>
<style>
body{margin:0;background:#f5f6fa}
.md-wrap{max-width:900px;margin:0 auto;background:#fff;font-family:SimSun,Times New Roman,serif;font-size:10.5pt}
.md-wrap p,.md-wrap li,.md-wrap td{font-size:10.5pt;font-family:SimSun,Times New Roman,serif}
.md-wrap h1,.md-wrap h2,.md-wrap h3,.md-wrap h4{color:#1b2559;margin:0.5em 0;line-height:1.3}
.md-wrap h1,.md-wrap h2,.md-wrap h3,.md-wrap h4{font-size:20px}
.md-wrap p{margin:5.25pt 0;line-height:1.43}
.md-wrap ul,.md-wrap ol{margin:0;padding-left:26px;line-height:1.43}
.md-wrap li{margin:0;line-height:1.43}
.md-wrap pre{background:#f6f8fb;border:1px solid #e6ebf4;border-radius:10px;padding:8px 12px;overflow:auto;margin:0;line-height:1.3}
.md-wrap pre code{font-family:Consolas,monospace;font-size:13px;line-height:1.65;background:none;padding:0;white-space:pre}
.md-wrap code{font-family:Consolas,monospace;font-size:13px;background:#eef2fb;padding:2px 5px;border-radius:4px}
.md-wrap blockquote{margin:0;padding:0 12px;line-height:1.3;border-left:3px solid #c9d6ff;background:#f8f9fd;color:#5b6472;line-height:1.3}
.md-wrap table{border-collapse:collapse;width:100%;margin:0;line-height:1.43}
.md-wrap th,.md-wrap td{border:1px solid #e2e8f2;padding:4px 8px;text-align:left;line-height:1.3}
.md-wrap th{background:#f4f6fb}
.md-wrap img{max-width:100%}
.md-wrap hr{border:none;border-top:1px solid #eef1f7;margin:18px 0}
</style></head>
<body><div class="md-wrap" style="font-family:${(ACTIVE.fontEast || 'SimSun')},${(ACTIVE.bodyLatin || 'Times New Roman')},serif;font-size:${((ACTIVE.sz && ACTIVE.sz.BodyText) ? ACTIVE.sz.BodyText / 2 : 10.5)}pt;line-height:${ACTIVE.line ? (ACTIVE.line / 240 * 1.15).toFixed(2) : '1.43'};padding:20px;">
${body}
</div></body></html>`;
  }

  // 三个核心转换函数统一命名（与转换规范一致）：
  //   toPlainText —— 纯文本，彻底去掉 Markdown 符号与 Emoji
  //   toHTML      —— 真实排版 marked.parse()，可直接粘进 Word 或浏览器打开
  //   toMarkdown  —— 规范 Markdown，给 Obsidian / Notion
  const toPlainText = buildPlainText;
  const toHTML = buildHtmlMarked;
  const toMarkdown = buildMarkdown;

  // 复制富文本：同时写入 text/html 与 text/plain，粘到 Word 保留排版
  async function copyRich(messages, title) {
    const html = toHTML(messages, title);
    const plain = toPlainText(messages);
    try {
      if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        })]);
        toast('已复制富文本，可直接粘贴到 Word', 'success');
        return;
      }
      throw new Error('no ClipboardItem');
    } catch (e) {
      await copyText(plain);
      toast('浏览器不支持富文本复制，已改复制纯文本', 'error');
    }
  }

  /* ---- 论文排版参数（北京师范大学本科生毕业论文写作规范）
   * 页面 A4 · 上下 2.54cm / 左右 3.17cm
   * 正文 小四宋体 12pt · 行距 20pt · 首行缩进 2 字符
   * 标题 黑体，按 1 / 1.1 / 1.1.1 多级编号；「我 / DeepSeek」只作为角色标记，不占标题层级
   * 全文无任何表情符号
   */
  const PAPER_CSS = `
@page{size:A4;margin:2.54cm 3.17cm}
html,body{margin:0;padding:0;background:#fff;color:#000}
body{font-family:SimSun,Times New Roman,serif;font-size:10.5pt;line-height:1.43}
/* 仅屏幕预览时补内边距，模拟 A4 页边距（打印与 Word 走 @page） */
@media screen{body{padding:26px 28px;max-width:860px;margin:0 auto}}
p,div,pre,table,tr,td,th,li{mso-line-height-rule:auto}
p{margin:0}
table{border-collapse:collapse}
strong{font-weight:700}
`;

  const WORD_PAGE_CSS = `
@page WordSection1{size:21.0cm 29.7cm;margin:2.54cm 3.17cm 2.54cm 3.17cm}
div.WordSection1{page:WordSection1}
`;

  // 行内 markdown → HTML（论文风格：链接直接展开为「文字（URL）」）
  function inlineMd(s) {
    let h = escHtml(stripCitations(stripEmoji(String(s || ''))));
    h = h.replace(/`([^`]+)`/g, '<span style="font-family:Consolas,monospace;font-size:10.5pt;background:#f2f2f2">$1</span>');
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    h = h.replace(/~~([^~]+)~~/g, '<s>$1</s>');
    h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1（$2）');
    return h;
  }

  // 内联样式表：Word / WPS 对 CSS 类选择器支持不稳定，所有样式写进 style 属性
  // 注意：style 属性内不能出现双引号，字体名一律用不带空格的写法（SimHei / SimSun / Consolas）
  let PS = {
    // ---- 文档头 ----
    docTitle: 'font-family:SimHei,sans-serif;font-size:22pt;font-weight:bold;color:#1F2328;line-height:1.3;text-indent:0;margin:0.5em 0',
    docMeta: 'font-family:SimSun,serif;font-size:9pt;color:#8B95AB;line-height:1.3;text-indent:0;margin:0',
    docMetaLine: 'font-family:SimSun,serif;font-size:9pt;color:#8B95AB;line-height:1.3;text-indent:0;margin:0;padding-bottom:6pt;border-bottom:0.75pt solid #DFE5F0',
    // ---- 角色标记：不用色块，靠字间距、颜色与分隔线 ----
    roleUser: 'font-family:SimHei,sans-serif;font-size:9pt;font-weight:bold;color:#7C8798;letter-spacing:3pt;text-indent:0;line-height:1.3;margin:0.5em 0;border-top:1pt solid #DFE5F0;padding-top:6pt;page-break-after:avoid',
    roleUserFirst: 'font-family:SimHei,sans-serif;font-size:9pt;font-weight:bold;color:#7C8798;letter-spacing:3pt;text-indent:0;line-height:1.3;margin:0.5em 0;page-break-after:avoid',
    roleAI: 'font-family:SimHei,sans-serif;font-size:9pt;font-weight:bold;color:#4D6BFE;letter-spacing:3pt;text-indent:0;line-height:1.3;margin:0.5em 0;page-break-after:avoid',
    // ---- 深度思考：缩进 + 灰字旁注，不用任何竖条 ----
    thinkLabel: 'font-family:SimHei,sans-serif;font-size:8.5pt;font-weight:bold;color:#98A2B8;letter-spacing:1.2pt;margin:7pt 0 3pt 0;text-indent:0',
    thinkBody: 'font-family:SimSun,Times New Roman,serif;font-size:10pt;line-height:1.5;color:#6B7688;text-indent:20pt;text-align:justify;margin:5.25pt 0',
    // ---- 回答内标题（编号带品牌色）----
    h1: 'font-family:SimHei,sans-serif;font-size:15pt;font-weight:bold;color:#1F2328;line-height:1.3;margin:0.5em 0;text-indent:0;page-break-after:avoid',
    h2: 'font-family:SimHei,sans-serif;font-size:13.5pt;font-weight:bold;color:#1F2937;line-height:1.3;margin:0.5em 0;text-indent:0;page-break-after:avoid',
    h3: 'font-family:SimHei,sans-serif;font-size:12pt;font-weight:bold;color:#2C3A5B;line-height:1.3;margin:0.5em 0;text-indent:0;page-break-after:avoid',
    // ---- 正文 / 列表 / 引用 / 代码 / 表格（对齐 DeepSeek 原生：无首行缩进、靠段间距）----
    body: 'font-family:SimSun,Times New Roman,serif;font-size:10.5pt;line-height:1.43;color:#1F2937;text-indent:0;text-align:justify;margin:5.25pt 0',
    math: 'font-family:Cambria Math,Times New Roman,serif;font-size:11pt;line-height:1.43;color:#1F2937;text-align:center;text-indent:0;margin:5.25pt 0',
    list: 'font-family:SimSun,Times New Roman,serif;font-size:10.5pt;line-height:1.43;color:#1F2937;margin:0;text-indent:0;padding-left:24pt',
    quote: 'font-family:SimSun,Times New Roman,serif;font-size:10.5pt;line-height:1.43;color:#5B6472;margin:5.25pt 0;padding:0 0 0 13pt;border-left:2.5pt solid #DDE3EE;text-indent:0',
    code: 'font-family:Consolas,monospace;font-size:10pt;line-height:1.3;color:#374151;background:#F7F8FB;border:0.5pt solid #E8ECF3;padding:6pt 10pt;margin:0;white-space:pre-wrap;word-break:break-all;text-indent:0',
    // 三线表：无底色、无竖线，最干净
    table: 'border-collapse:collapse;width:100%;margin:0',
    th: 'border:none;border-top:1pt solid #AEB8CA;border-bottom:0.75pt solid #AEB8CA;padding:4pt 8pt;text-align:left;font-family:SimHei,sans-serif;font-size:9.5pt;line-height:1.3;color:#2C3A5B;text-indent:0',
    td: 'border:none;border-bottom:0.5pt solid #E3E9F4;padding:4pt 8pt;text-align:left;font-family:SimSun,Times New Roman,serif;font-size:10pt;line-height:1.3;color:#1F2937;text-indent:0',
    hr: 'border:none;border-top:0.5pt solid #E4E7F0;margin:0.5em 0',
    roundSep: 'border:none;border-top:1.25pt solid #9AA6BC;margin:24pt 0',
    num: '',
  };
  const PS_BASE = Object.assign({}, PS);
  // 把当前预设的字体/字号/行距覆盖到 HTML 内联样式上，保证同一次导出里三通道一致
  function applyPresetToPS(p) {
    PS = Object.assign({}, PS_BASE);
    if (!p || p.id === 'modern') return;
    const fam = (p.fontEast || '宋体') + ',' + (p.bodyLatin || 'Times New Roman') + ',serif';
    const sz = ((p.sz && p.sz.BodyText ? p.sz.BodyText : 21) / 2) + 'pt';
    const lh = p.line ? (p.line / 240 * 1.15).toFixed(2) : '1.43';
    ['body', 'list', 'quote'].forEach(function (k) {
      if (!PS[k]) return;
      PS[k] = PS[k]
        .replace(/font-family:[^;]+/, 'font-family:' + fam)
        .replace(/font-size:[^;]+/, 'font-size:' + sz)
        .replace(/line-height:[^;]+/, 'line-height:' + lh);
    });
    // 首行缩进 2 字符（em = 字号，随预设字号自动换算）
    if (p.textIndent) {
      ['body', 'thinkBody'].forEach(function (k) {
        if (PS[k]) PS[k] = PS[k].replace(/text-indent:[^;]+/, 'text-indent:' + p.textIndent);
      });
    }
  }

  // 正文 → 段落（逐行成段）；withHeadings=true 时 ##/###/#### → 彩色编号 1 / 1.1 / 1.1.1
  function renderPaperBody(md, withHeadings, cnt, bodyStyle) {
    // 先把多行 $$ 公式块折成单行，便于识别为居中公式段
    const src = String(md || '').replace(/\$\$([\s\S]*?)\$\$/g, (m, f) => '\n$$' + f.replace(/\s*\n\s*/g, ' ').trim() + '$$\n');
    const lines = src.split('\n');
    const B = bodyStyle || PS.body;
    const ordMap2 = ordNumbers(lines);
    let li2 = 0;
    let out = '';
    let inCode = false;
    let codeBuf = [];
    let tableBuf = [];
    const c = cnt || { n: 0 };

    const flushCode = () => {
      if (codeBuf.length) {
        // Word 不认 <pre> 里的 \n，必须显式转成 <br>，否则多行代码会挤成一行
        const code = escHtml(codeBuf.join('\n')).replace(/\n/g, '<br>');
        out += `<pre style="${PS.code}">${code}</pre>`;
      }
      codeBuf = [];
      inCode = false;
    };
    const flushTable = () => {
      if (!tableBuf.length) return;
      const rows = tableBuf.map(r => r.replace(/^[ \t]*\|/, '').replace(/\|[ \t]*$/, '').split('|').map(x => x.trim()));
      const data = rows.filter(r => !r.every(x => /^:?-{2,}:?$/.test(x) || x === ''));
      tableBuf = [];
      if (!data.length) return;
      const head = data[0];
      let tb = `<table style="${PS.table}"><tr>${head.map(h => `<th style="${PS.th}">${inlineMd(h)}</th>`).join('')}</tr>`;
      data.slice(1).forEach(r => {
        tb += `<tr>${r.map(cell => `<td style="${PS.td}">${inlineMd(cell)}</td>`).join('')}</tr>`;
      });
      out += tb + '</table>';
    };

    for (li2 = 0; li2 < lines.length; li2++) {
      const raw = lines[li2];
      const t = raw.trim();
      if (/^```/.test(t)) {
        flushTable();
        if (!inCode) { inCode = true; codeBuf = []; }
        else flushCode();
        continue;
      }
      if (inCode) { codeBuf.push(raw.replace(/\t/g, '    ')); continue; }
      if (!t) { flushTable(); continue; }

      // 表格行
      if (/^[ \t]*\|.*\|[ \t]*$/.test(raw)) { tableBuf.push(t); continue; }
      flushTable();

      const m = t.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        const ht = cleanHeadNum(m[2]);
        if (!withHeadings) {
          out += `<p style="${B}"><strong>${inlineMd(ht)}</strong></p>`;
        } else {
          // 单级编号 1. 2. 3.；标题自带「一、」等序号时不叠加
          const tag = 'h3';
          const sty = PS.h1;
          if (hasOwnNumber(ht)) {
            out += `<${tag} style="${sty}">${inlineMd(ht)}</${tag}>`;
          } else {
            c.n = (c.n || 0) + 1;
            out += `<${tag} style="${sty}"><span style="${PS.num}">${c.n}.</span> ${inlineMd(ht)}</${tag}>`;
          }
        }
        continue;
      }
      if (/^(---+|\*\*\*+)$/.test(t)) { out += `<hr style="${PS.hr}">`; continue; }
      if (/^\$\$(.+)\$\$$/.test(t)) { out += `<p style="${PS.math}">${inlineMd(t.slice(2, -2).trim())}</p>`; continue; }
      if (/^>\s?/.test(t)) { out += `<p style="${PS.quote}">${inlineMd(t.replace(/^>\s?/, ''))}</p>`; continue; }
      // 列表按「每层 4 空格」缩进换算层级，嵌套子项不再与父项平齐
      const listLv = Math.min(3, Math.round((raw.match(/^ */)[0].length || 0) / 4));
      const listStyle = `${PS.list};padding-left:${24 + listLv * 18}pt`;
      if (/^[-*+]\s*$/.test(t)) { continue; }                   // 孤立的项目符号：空列表项，直接丢弃
      const lb = t.match(/^[-*+]\s+(.*)$/);
      if (lb) { out += `<p style="${listStyle}">• ${inlineMd(lb[1])}</p>`; continue; }
      const om2 = t.match(ORD_RE);
      if (om2) {
        const shown2 = (ordMap2 && ordMap2[li2] != null) ? ordMap2[li2] : om2[1];
        const body2 = om2[2] || '';
        const inner2 = hasOwnNumber(body2) ? inlineMd(body2)
          : inlineMd(body2).replace(/^/, '<span style="' + PS.num + '">' + shown2 + '. </span>');
        out += `<p style="${listStyle}">${inner2}</p>`; continue;
      }
      out += `<p style="${B}">${inlineMd(t)}</p>`;
    }
    flushTable();
    flushCode();
    return out;
  }

  // 对话 → 文档头（无竖条，仅用横线分隔）+ 每轮段落式排版
  function buildPaperBody(messages, title) {
    applyPresetToPS(ACTIVE);
    let out = '';

    // 文档头：标题 + 元信息，元信息段落底部一条细横线作为分隔（Word 渲染稳定）
    out += `<div style="margin:0 0 20pt 0;text-indent:0">
<div style="${PS.docTitle}">${escHtml(title || 'DeepSeek 对话记录')}</div>
<p style="${PS.docMetaLine}">导出时间：${escHtml(nowStamp())}　·　共 ${messages.length} 条消息</p>
</div>`;

    // 按轮分组
    const rounds = [];
    messages.forEach(m => {
      if (m.role === 'user') rounds.push({ user: m, ai: [] });
      else {
        if (!rounds.length) rounds.push({ user: null, ai: [] });
        rounds[rounds.length - 1].ai.push(m);
      }
    });

    // 每一轮对话独立一套编号计数器：轮内标题从 1 重新计数，轮次之间互不影响
    rounds.forEach((r, ri) => {
      // 不同对话之间：空几行 + 一条横线（相当于 Markdown 的 ---）
      if (ri > 0) out += `<hr style="${PS.roundSep}">`;
      if (r.user) {
        out += `<div style="${ri === 0 ? PS.roleUserFirst : PS.roleUser}">我</div>`;
        out += renderPaperBody(r.user.contentMd || r.user.content, false, { n: 0 });
      }

      if (r.ai.length) {
        out += `<div style="${PS.roleAI}">DEEPSEEK</div>`;
        r.ai.forEach(m => {
          // 每条回答独立一套编号：从 1 起计，绝不多条回答串成 1.1…1.32
          const cnt = { n: 0 };
          const tk = m.thinkingMd || m.thinking || '';
          if (tk.trim()) {
            out += `<div style="${PS.thinkBox}">`;
            out += `<div style="${PS.thinkLabel}">深度思考</div>`;
            out += renderPaperBody(tk, false, cnt, PS.thinkBody);
            out += `</div>`;
          }
          const ans = m.answerMd || m.answer;
          if (ans) out += renderPaperBody(ans, true, cnt);
        });
      }
    });

    return out;
  }

  // HTML 下载 + PDF 打印共用（含 KaTeX 公式渲染，离线时自动降级为源码）
  function buildHtml(messages, title) {
    applyPresetToPS(ACTIVE);
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${escHtml(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"
  onload="try{renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}],throwOnError:false})}catch(e){}"></script>
<style>${PAPER_CSS}</style></head>
<body>${buildPaperBody(messages, title)}</body></html>`;
  }

  // Word（.doc，Word/WPS 识别的 HTML 版式）
  function buildDocHtml(messages, title) {
    return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${escHtml(title)}</title>
<style>${PAPER_CSS}${WORD_PAGE_CSS}</style></head>
<body><div class="WordSection1">${buildPaperBody(messages, title)}</div></body></html>`;
  }

  /* ============================================================
   * 6b. 真正的 .docx 导出（OOXML）
   *     打开即 Word/WPS 页面视图，不会被当成网页渲染
   * ============================================================ */
  function xmlEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  /* ------------------------------------------------------------
   * 导出样式预设
   * 依据：pandoc reference.docx 机制（样式即契约）、Quarto Word 模板、
   *       GB/T 9704-2012 公文版式、常见技术文档排版惯例
   * 每套预设只改「字体 / 字号 / 行距 / 段间距 / 首行缩进 / 页边距」六组参数，
   * 段落结构、编号规则、列表符号保持一致 —— 换风格不换结构。
   * ------------------------------------------------------------ */
  const PRESETS = [
    /* 日常问答 / 聊天记录归档：紧凑、无缩进、边距适中 */
    { id: 'modern', name: '现代简洁', tag: '日常通用', desc: '黑体标题 · 宋体五号 · 1.25 倍行距 · 无首行缩进',
      line: 300, spacing: null, sz: null, page: { t: 1440, b: 1440, l: 1797, r: 1797 } },

    /* 职场汇报：标题用无衬线并带下划线，正文略大、行距更松 */
    /* 学位论文：宋体小四、1.5 倍行距、首行缩进 2 字符、装订边 */
    { id: 'thesis', name: '学位论文', tag: '课程论文', desc: '黑体标题 · 宋体小四 · 1.5 倍行距 · 首行缩进 2 字符',
      fontEast: '宋体', headEast: '黑体', headLatin: 'Times New Roman',
      sz: { DocTitle: 44, H1: 32, BodyText: 24, ThinkBody: 21, ListItem: 24, Quote: 24, TableCell: 21, TableHead: 21 },
      line: 360,
      spacing: { BodyText: 'w:before="0" w:after="0"', ThinkBody: 'w:before="0" w:after="0"',
                 ListItem: 'w:before="0" w:after="0"', Quote: 'w:before="0" w:after="0"',
                 MathPara: 'w:before="60" w:after="60"' },
      ind: { BodyText: '<w:ind w:firstLineChars="200" w:firstLine="480"/>' },
      jc: { DocTitle: 'center' },
      textIndent: '2em',
      page: { t: 1701, b: 1418, l: 1701, r: 1418 } },

    /* 党政机关公文：仿宋三号、1.75 倍行距、标题小标宋居中、国标页边距 */
    { id: 'official', name: '公文格式', tag: 'GB/T 9704', desc: '方正小标宋标题 · 仿宋三号 · 1.75 倍行距 · 国标页边距',
      fontEast: '仿宋_GB2312', headEast: '方正小标宋简体', headLatin: 'Times New Roman', codeFont: '仿宋_GB2312',
      sz: { DocTitle: 44, H1: 32, BodyText: 32, ThinkBody: 28, ListItem: 32, Quote: 32, TableCell: 28, TableHead: 28, RoleUser: 24, RoleAI: 24 },
      line: 420,
      spacing: { BodyText: 'w:before="0" w:after="0"', ThinkBody: 'w:before="0" w:after="0"',
                 ListItem: 'w:before="0" w:after="0"', Quote: 'w:before="0" w:after="0"',
                 MathPara: 'w:before="0" w:after="0"' },
      ind: { BodyText: '<w:ind w:firstLineChars="200" w:firstLine="640"/>' },
      jc: { DocTitle: 'center' },
      textIndent: '2em',
      page: { t: 2098, b: 1984, l: 1588, r: 1474 } },

    /* 开发文档：全无衬线、字号小、行距紧、边距窄 */
    { id: 'tech', name: '技术文档', tag: '开发者', desc: '微软雅黑 · 10pt · 1.15 倍行距 · 窄边距 · 代码优先',
      fontEast: '微软雅黑', headEast: '微软雅黑', headLatin: 'Segoe UI', bodyLatin: 'Segoe UI',
      sz: { DocTitle: 36, H1: 28, BodyText: 20, ThinkBody: 18, ListItem: 20, Quote: 20, TableCell: 18, TableHead: 18 },
      line: 276,
      spacing: { BodyText: 'w:before="40" w:after="40"', ThinkBody: 'w:before="0" w:after="40"',
                 ListItem: 'w:before="0" w:after="0"', Quote: 'w:before="40" w:after="40"' },
      page: { t: 1134, b: 1134, l: 1276, r: 1276 } },
  ];
  let ACTIVE = PRESETS[0];
  function presetById(id) { return PRESETS.filter(p => p.id === id)[0] || PRESETS[0]; }
  // 本地存储：优先 localStorage（不依赖 @grant，任何脚本管理器都可用），GM_* 仅作兜底
  const FMT_KEY = 'dsx_export_fmt_v1';
  function storeGet(key, dft) {
    try {
      if (typeof localStorage !== 'undefined') {
        const v = localStorage.getItem(key);
        if (v !== null && v !== '') return v;
      }
    } catch (e) { /* 隐私模式等 */ }
    try { if (typeof GM_getValue === 'function') return GM_getValue(key, dft); } catch (e) { /* 无授权 */ }
    return dft;
  }
  function storeSet(key, val) {
    let ok = false;
    try { if (typeof localStorage !== 'undefined') { localStorage.setItem(key, val); ok = true; } } catch (e) { /* 忽略 */ }
    try { if (typeof GM_setValue === 'function') { GM_setValue(key, val); ok = true; } } catch (e) { /* 无授权 */ }
    return ok;
  }
  function currentFmt() {
    const id = storeGet(FMT_KEY, 'modern');
    return PRESETS.some(p => p.id === id) ? id : 'modern';
  }
  function setFmt(id) {
    if (!PRESETS.some(p => p.id === id)) return;
    const ok = storeSet(FMT_KEY, id);
    syncFmtChips();
    toast(ok ? ('导出格式：' + presetById(id).name + '（已记住）') : '当前浏览器无法保存格式选择，本次导出仍按所选格式生成', ok ? 'success' : 'error');
  }
  function syncFmtChips() {
    const cur = currentFmt();
    const p = presetById(cur);
    Array.prototype.forEach.call(document.querySelectorAll('.dsx-chip'), el => {
      el.classList.toggle('dsx-chip-on', el.getAttribute('data-fmt') === cur);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-fmt-hint]'), el => {
      el.textContent = '当前生效：' + p.name + ' · ' + p.desc + '（Word / HTML / PDF 同步）';
    });
  }
  function fmtChips(cls) {
    const cur = currentFmt();
    return PRESETS.map(p =>
      `<button type="button" class="${cls}${p.id === cur ? ' dsx-chip-on' : ''}" data-fmt="${p.id}" title="${p.desc}">${p.name}</button>`
    ).join('');
  }

  // 按预设改写样式表：只换字体、字号、首行缩进，段落结构不动
  function patchStyleXml(xml, id, sz, ind, line, jc, bdr) {
    const a = xml.indexOf('w:styleId="' + id + '"');
    if (a < 0) return xml;
    const b = xml.indexOf('</w:style>', a);
    let seg = xml.slice(a, b);
    if (sz) seg = seg.replace(/<w:sz w:val="\d+"\/>/, '<w:sz w:val="' + sz + '"/>')
                     .replace(/<w:szCs w:val="\d+"\/>/, '<w:szCs w:val="' + sz + '"/>');
    if (ind) {
      if (/<w:ind[^/]*\/>/.test(seg)) seg = seg.replace(/<w:ind[^/]*\/>/, ind);
      else seg = seg.replace('</w:pPr>', ind + '</w:pPr>');
    }
    if (line) seg = seg.replace(/w:line="\d+" w:lineRule="auto"/, 'w:line="' + line + '" w:lineRule="auto"');
    // 标题居中
    if (jc) {
      if (/<w:jc[^/]*\/>/.test(seg)) seg = seg.replace(/<w:jc[^/]*\/>/, '<w:jc w:val="' + jc + '"/>');
      else seg = seg.replace('</w:pPr>', '<w:jc w:val="' + jc + '"/></w:pPr>');
    }
    // 标题下细线（商务报告用）
    if (bdr && !/<w:pBdr>/.test(seg)) {
      seg = seg.replace('</w:pPr>', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="C9D4EC"/></w:pBdr></w:pPr>');
    }
    return xml.slice(0, a) + seg + xml.slice(b);
  }

  // 只改样式里的段前/段后，保留该样式自己的行距
  function patchStyleSpacing(xml, id, before, after) {
    const a = xml.indexOf('w:styleId="' + id + '"');
    if (a < 0) return xml;
    const b = xml.indexOf('</w:style>', a);
    let seg = xml.slice(a, b);
    seg = seg.replace(/<w:spacing([^/]*)\/>/, (m, attrs) => {
      let at = attrs.replace(/\s*w:before="[^"]*"/, '').replace(/\s*w:after="[^"]*"/, '');
      return '<w:spacing' + at + ' w:before="' + before + '" w:after="' + after + '"/>';
    });
    return xml.slice(0, a) + seg + xml.slice(b);
  }

  function stylesFor(p) {
    let xml = DOCX_STYLES;
    if (p.fontEast) xml = xml.split('w:eastAsia="宋体"').join('w:eastAsia="' + p.fontEast + '"');
    if (p.headEast) xml = xml.split('w:eastAsia="黑体"').join('w:eastAsia="' + p.headEast + '"');
    if (p.headLatin) xml = xml.split('w:ascii="Arial"').join('w:ascii="' + p.headLatin + '"').split('w:hAnsi="Arial"').join('w:hAnsi="' + p.headLatin + '"');
    if (p.bodyLatin) xml = xml.split('w:ascii="Times New Roman"').join('w:ascii="' + p.bodyLatin + '"').split('w:hAnsi="Times New Roman"').join('w:hAnsi="' + p.bodyLatin + '"');
    if (p.codeFont) xml = xml.split('w:ascii="Consolas"').join('w:ascii="' + p.codeFont + '"').split('w:eastAsia="Consolas"').join('w:eastAsia="' + p.codeFont + '"').split('w:hAnsi="Consolas"').join('w:hAnsi="' + p.codeFont + '"');
    if (p.sz) Object.keys(p.sz).forEach(function (id) {
      xml = patchStyleXml(xml, id, p.sz[id], p.ind && p.ind[id], null, p.jc && p.jc[id], p.hBdr && p.hBdr[id]);
    });
    // 段前/段后：样式表与段落直接格式保持一致
    if (p.spacing) Object.keys(p.spacing).forEach(function (id) {
      const mb = p.spacing[id].match(/w:before="(\d+)"/);
      const ma = p.spacing[id].match(/w:after="(\d+)"/);
      if (mb && ma) xml = patchStyleSpacing(xml, id, mb[1], ma[1]);
    });
    if (p.jc) Object.keys(p.jc).forEach(function (id) {
      if (!(p.sz && p.sz[id])) xml = patchStyleXml(xml, id, null, null, null, p.jc[id], null);
    });
    if (p.hBdr) Object.keys(p.hBdr).forEach(function (id) {
      if (!(p.sz && p.sz[id])) xml = patchStyleXml(xml, id, null, null, null, null, p.hBdr[id]);
    });
    // 正文类行距按预设改写（标题/代码/表格固定单倍）
    if (p.line) {
      ['BodyText', 'ThinkBody', 'ListItem', 'Quote', 'MathPara'].forEach(function (id) {
        xml = patchStyleXml(xml, id, null, null, p.line);
      });
    }
    return xml;
  }

  const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>
<w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/>
</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>
<w:pPr><w:ind w:firstLine="0"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="DocTitle"><w:name w:val="Doc Title"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:spacing w:before="140" w:after="140" w:line="240" w:lineRule="auto"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="黑体" w:hAnsi="Arial"/><w:b/><w:sz w:val="44"/><w:color w:val="1F2328"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="DocMeta"><w:name w:val="Doc Meta"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="8" w:color="DFE5F0"/></w:pBdr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>
<w:rPr><w:sz w:val="18"/><w:color w:val="8B95AB"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="RoundSep"><w:name w:val="Round Sep"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:spacing w:before="560" w:after="560" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>
<w:rPr><w:sz w:val="21"/><w:color w:val="6B7688"/><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="RoleUser"><w:name w:val="Role User"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:spacing w:before="140" w:after="140" w:line="240" w:lineRule="auto"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="黑体" w:hAnsi="Arial"/><w:b/><w:sz w:val="18"/><w:spacing w:val="60"/><w:color w:val="7C8798"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="RoleUserFirst"><w:name w:val="Role User First"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:spacing w:before="140" w:after="140" w:line="240" w:lineRule="auto"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="黑体" w:hAnsi="Arial"/><w:b/><w:sz w:val="18"/><w:spacing w:val="60"/><w:color w:val="7C8798"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="RoleAI"><w:name w:val="Role AI"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:spacing w:before="140" w:after="140" w:line="240" w:lineRule="auto"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="黑体" w:hAnsi="Arial"/><w:b/><w:sz w:val="18"/><w:spacing w:val="60"/><w:color w:val="4D6BFE"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ThinkLabel"><w:name w:val="Think Label"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:ind w:left="280"/><w:spacing w:before="140" w:after="70" w:line="240" w:lineRule="auto"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="黑体" w:hAnsi="Arial"/><w:b/><w:sz w:val="17"/><w:spacing w:val="24"/><w:color w:val="98A2B8"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ThinkBody"><w:name w:val="Think Body"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:ind w:left="280" w:firstLine="200"/><w:spacing w:before="105" w:after="105" w:line="300" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="20"/><w:color w:val="6B7688"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="H1"><w:name w:val="Heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="BodyText"/><w:qFormat/>
<w:pPr><w:keepNext/><w:spacing w:before="140" w:after="140" w:line="240" w:lineRule="auto"/><w:outlineLvl w:val="0"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="黑体" w:hAnsi="Arial"/><w:b/><w:sz w:val="30"/><w:color w:val="1F2328"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:ind w:firstLine="0"/><w:spacing w:before="105" w:after="105" w:line="300" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="21"/><w:color w:val="1F2937"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="MathPara"><w:name w:val="Math Para"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:spacing w:before="105" w:after="105" w:line="300" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Cambria Math" w:eastAsia="Cambria Math" w:hAnsi="Cambria Math"/><w:sz w:val="22"/><w:color w:val="1F2937"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListItem"><w:name w:val="List Item"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:ind w:left="520" w:hanging="260"/><w:spacing w:before="0" w:after="0" w:line="300" w:lineRule="auto"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="21"/><w:color w:val="1F2937"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:pBdr><w:left w:val="single" w:sz="12" w:space="10" w:color="DDE3EE"/></w:pBdr><w:ind w:left="200"/><w:spacing w:before="105" w:after="105" w:line="300" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="21"/><w:color w:val="5B6472"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F6F8FB"/><w:ind w:left="240"/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Consolas" w:eastAsia="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/><w:color w:val="374151"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CodeFirst"><w:name w:val="Code First"/><w:basedOn w:val="CodeBlock"/>
<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F6F8FB"/><w:ind w:left="240"/><w:spacing w:before="140" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="CodeLast"><w:name w:val="Code Last"/><w:basedOn w:val="CodeBlock"/>
<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F6F8FB"/><w:ind w:left="240"/><w:spacing w:before="0" w:after="140" w:line="240" w:lineRule="auto"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="TableHead"><w:name w:val="Table Head"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:spacing w:before="140" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="黑体" w:hAnsi="Arial"/><w:b/><w:sz w:val="19"/><w:color w:val="2C3A5B"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TableCell"><w:name w:val="Table Cell"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="20"/><w:color w:val="1F2937"/></w:rPr></w:style>
</w:styles>`;

  // 段落间距同时写成「直接格式」：WPS 对自定义样式里的 spacing 继承不可靠，
  // 直接格式一定会生效（pandoc 也是这么做的）。数值单位 twips，1 行≈273。
  const DOCX_SPACING = {
    DocTitle: 'w:before="140" w:after="140"',
    DocMeta: 'w:before="0" w:after="0"',
    RoleUser: 'w:before="140" w:after="140"',
    RoleUserFirst: 'w:before="140" w:after="140"',
    RoleAI: 'w:before="140" w:after="140"',
    RoundSep: 'w:before="560" w:after="560"',
    H1: 'w:before="140" w:after="140"',
    BodyText: 'w:before="105" w:after="105"',
    ThinkLabel: 'w:before="140" w:after="70"',
    ThinkBody: 'w:before="105" w:after="105"',
    ListItem: 'w:before="0" w:after="0"',
    Quote: 'w:before="105" w:after="105"',
    MathPara: 'w:before="105" w:after="105"',
    CodeFirst: 'w:before="140" w:after="0"',
    CodeBlock: 'w:before="0" w:after="0"',
    CodeLast: 'w:before="0" w:after="140"',
    TableHead: 'w:before="140" w:after="0"',
    TableCell: 'w:before="0" w:after="0"',
  };
  // 正文类走 1.25 倍行距（300 twips），标题/代码/表格保持单倍
  const LINE_125 = { BodyText: 1, ThinkBody: 1, ListItem: 1, Quote: 1, MathPara: 1 };
  function spacingXml(styleId) {
    const sp = (ACTIVE.spacing && ACTIVE.spacing[styleId]) || DOCX_SPACING[styleId];
    if (!sp) return '';
    const bodyLine = String(ACTIVE.line || 300);
    const line = LINE_125[styleId] ? bodyLine : '240';
    return `<w:spacing ${sp} w:line="${line}" w:lineRule="auto"/>`;
  }

  function docxPara(styleId, text, runProps) {
    const rp = runProps || '';
    const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
    return `<w:p><w:pPr><w:pStyle w:val="${styleId}"/>${spacingXml(styleId)}</w:pPr><w:r>${rp ? `<w:rPr>${rp}</w:rPr>` : ''}<w:t${preserve}>${xmlEsc(text)}</w:t></w:r></w:p>`;
  }

  function docxRichPara(styleId, segments) {
    const runs = segments.map(s => {
      const rp = [];
      if (s.color) rp.push(`<w:color w:val="${s.color}"/>`);
      if (s.bold) rp.push('<w:b/>');
      if (s.italic) rp.push('<w:i/>');
      if (s.italic) rp.push('<w:i/>');
      if (s.mono) rp.push('<w:rFonts w:ascii="Consolas" w:eastAsia="Consolas" w:hAnsi="Consolas"/>');
      const rps = rp.length ? `<w:rPr>${rp.join('')}</w:rPr>` : '';
      const preserve = /^\s|\s$/.test(s.text) ? ' xml:space="preserve"' : '';
      return `<w:r>${rps}<w:t${preserve}>${xmlEsc(s.text)}</w:t></w:r>`;
    }).join('');
    return `<w:p><w:pPr><w:pStyle w:val="${styleId}"/>${spacingXml(styleId)}</w:pPr>${runs}</w:p>`;
  }

  // 行内 markdown → 若干 run（加粗 / 行内代码）
  // 清掉 DeepSeek 的引用角标残留：[-1](url) / [[1]](url) / [1]
  // 这些是网页上的引文标记，进文档只会变成一串神秘字符
  function stripCitations(t) {
    return String(t || '')
      .replace(/\[\[?-?\d+\]?\]\([^()\s]*\)/g, '')
      .replace(/\[\^?\d{1,3}\]/g, '')
      .replace(/[ \t]{2,}/g, ' ');
  }

  function inlineSegs(text, baseColor) {
    const segs = [];
    const src = stripCitations(stripEmoji(String(text || '')));
    const re = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g;
    let last = 0, m;
    while ((m = re.exec(src)) !== null) {
      if (m.index > last) segs.push({ text: src.slice(last, m.index), color: baseColor });
      const tok = m[0];
      if (tok.startsWith('**')) segs.push({ text: tok.slice(2, -2), bold: true, color: baseColor });
      else if (tok.charAt(0) === '*') segs.push({ text: tok.slice(1, -1), italic: true, color: baseColor });
      else segs.push({ text: tok.slice(1, -1), mono: true, color: '243044' });
      last = m.index + tok.length;
    }
    if (last < src.length) segs.push({ text: src.slice(last), color: baseColor });
    if (!segs.length) segs.push({ text: '', color: baseColor });
    return segs;
  }

  // 列表段落：编号是正文文字（非 Word 自动编号），用悬挂缩进对齐
  function literalListPara(ilvl, segments) {
    const runs = segments.map(s => {
      const rp = [];
      if (s.color) rp.push(`<w:color w:val="${s.color}"/>`);
      if (s.bold) rp.push('<w:b/>');
      if (s.italic) rp.push('<w:i/>');
      if (s.italic) rp.push('<w:i/>');
      if (s.mono) rp.push('<w:rFonts w:ascii="Consolas" w:eastAsia="Consolas" w:hAnsi="Consolas"/>');
      const rps = rp.length ? `<w:rPr>${rp.join('')}</w:rPr>` : '';
      const preserve = /^\s|\s$/.test(s.text) ? ' xml:space="preserve"' : '';
      return `<w:r>${rps}<w:t${preserve}>${xmlEsc(s.text)}</w:t></w:r>`;
    }).join('');
    const ind = `<w:ind w:left="${520 + ilvl * 360}" w:hanging="260"/>`;
    return `<w:p><w:pPr><w:pStyle w:val="ListItem"/>${spacingXml('ListItem')}${ind}</w:pPr>${runs}</w:p>`;
  }

  // 有序列表块重编号：模型常写成 1. 1. 1.，块内编号不连续时按顺序重排；
  // 原编号本来就连续（1,2,3 或 25,26）时保留原样，避免破坏语义编号
  function ordNumbers(lines) {
    const map = {};
    let i = 0;
    while (i < lines.length) {
      if (!ORD_RE.test(lines[i].trim())) { i++; continue; }
      let j = i;
      const indent = (lines[i].match(/^ */) || [''])[0].length;
      const nums = [];
      while (j < lines.length) {
        const raw = lines[j];
        const t = raw.trim();
        // 空行与孤立的项目符号不打断列表（模型常写成「1. … / - / 1. …」）
        if (!t || /^[-*+]\s*$/.test(t)) { j++; continue; }
        const mm = t.match(ORD_RE);
        const ind = (raw.match(/^ */) || [''])[0].length;
        if (!mm || ind !== indent) break;
        nums.push({ line: j, n: parseInt(mm[1], 10) });
        j++;
      }
      const seq = nums.every((x, k) => k === 0 || x.n === nums[k - 1].n + 1);
      nums.forEach((x, k) => { map[x.line] = seq ? x.n : k + 1; });
      i = j;
    }
    return map;
  }

  // 有序列表行：1. / 1) / 1、（顿号后可不带空格）
  const ORD_RE = /^(\d{1,3})(?:[.)]\s+|、\s*)(.*)$/;

  // 轮次分隔线：段落下边框 + 零宽空格
  // 踩过的两个坑：① 空段落的下边框 WPS 不绘制；② VML <v:rect> 的 width:0 在 WPS 不展开、缩成一个点
  function docxHr() {
    return '<w:p><w:pPr><w:pStyle w:val="RoundSep"/>'
      + '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="9AA6BC"/></w:pBdr>'
      + '<w:spacing w:before="480" w:after="480" w:line="240" w:lineRule="auto"/></w:pPr>'
      + '<w:r><w:t xml:space="preserve">\u200B</w:t></w:r></w:p>';
  }

  // markdown → docx 段落
  function renderDocxBody(md, withHeadings, cnt, mode) {
    // 先把多行 $$ 公式块折成单行，便于识别为居中公式段
    const src = String(md || '').replace(/\$\$([\s\S]*?)\$\$/g, (m, f) => '\n$$' + f.replace(/\s*\n\s*/g, ' ').trim() + '$$\n');
    const lines = src.split('\n');

    const c = cnt || { n: 0 };
    const ordMap = ordNumbers(lines);
    const bodyStyle = mode === 'think' ? 'ThinkBody' : 'BodyText';
    const baseColor = mode === 'think' ? '6B7688' : '1F2937';
    let out = '';
    let inCode = false;
    let codeBuf = [];
    let tableBuf = [];

    const flushCode = () => {
      if (!codeBuf.length) { inCode = false; return; }
      codeBuf.forEach((ln, i) => {
        const st = codeBuf.length === 1 ? 'CodeFirst' : (i === 0 ? 'CodeFirst' : (i === codeBuf.length - 1 ? 'CodeLast' : 'CodeBlock'));
        out += docxPara(st, ln || ' ');
      });
      codeBuf = [];
      inCode = false;
    };
    const flushTable = () => {
      if (!tableBuf.length) return;
      const rows = tableBuf.map(r => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(x => x.trim()));
      const data = rows.filter(r => !r.every(x => /^:?-{2,}:?$/.test(x) || x === ''));
      tableBuf = [];
      if (!data.length) return;
      const cellW = Math.floor(9000 / data[0].length);
      let tbl = `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>
<w:top w:val="single" w:sz="8" w:space="0" w:color="AEB8CA"/>
<w:left w:val="none" w:sz="0" w:space="0" w:color="auto"/>
<w:bottom w:val="single" w:sz="8" w:space="0" w:color="AEB8CA"/>
<w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/>
<w:insideH w:val="single" w:sz="4" w:space="0" w:color="E3E9F4"/>
<w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/>
</w:tblBorders><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:left w:w="140" w:type="dxa"/><w:right w:w="140" w:type="dxa"/></w:tblCellMar></w:tblPr>`;
      data.forEach((row, ri) => {
        tbl += '<w:tr>';
        row.forEach(cell => {
          tbl += `<w:tc><w:tcPr><w:tcW w:w="${cellW}" w:type="dxa"/>${ri === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="F4F6FB"/>' : ''}</w:tcPr>`;
          // 单元格也要解析 **加粗** / `代码`，否则星号会原样出现在表格里
          const cellColor = ri === 0 ? '2C3A5B' : '1F2937';
          let csegs = inlineSegs(cell, cellColor);
          if (ri === 0) csegs = csegs.map(x => Object.assign({}, x, { bold: true }));
          tbl += docxRichPara(ri === 0 ? 'TableHead' : 'TableCell', csegs);
          tbl += '</w:tc>';
        });
        tbl += '</w:tr>';
      });
      out += tbl + '</w:tbl>' + docxPara('BodyText', '');
    };

    for (let li = 0; li < lines.length; li++) {
      const raw = lines[li];
      const t = raw.trim();
      if (/^```/.test(t)) {
        flushTable();
        if (!inCode) { inCode = true; codeBuf = []; } else flushCode();
        continue;
      }
      if (inCode) { codeBuf.push(raw.replace(/\t/g, '    ')); continue; }
      if (!t) { flushTable(); continue; }

      if (/^\s*\|.*\|\s*$/.test(raw)) { tableBuf.push(t); continue; }
      flushTable();

      const m = t.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        const title = cleanHeadNum(m[2]);
        if (!withHeadings || mode === 'think') {
          out += docxRichPara(bodyStyle, inlineSegs(title, baseColor).map(s => ({ ...s, bold: true })));
        } else {
          // 三级标题已取消：无论 # ## ### 一律按同一级标题排版；编号单级递增 1. 2. 3.
          const st = 'H1';
          const tc = '1B2559';
          const segs = inlineSegs(title, tc);
          if (hasOwnNumber(title)) {
            out += docxRichPara(st, segs);
          } else {
            c.n = (c.n || 0) + 1;
            out += docxRichPara(st, [{ text: c.n + '. ', color: tc }].concat(segs));
          }
        }
        continue;
      }
      if (/^(---+|\*\*\*+)$/.test(t)) { out += docxPara('BodyText', ''); continue; }
      if (/^\$\$(.+)\$\$$/.test(t)) { out += docxPara('MathPara', t.slice(2, -2).trim()); continue; }
      if (/^>\s?/.test(t)) {
        out += docxRichPara('Quote', inlineSegs(t.replace(/^>\s?/, ''), '6B7688'));
        continue;
      }
      // 列表：编号直接写成文字（不依赖 Word 自动编号，绝不跨会话串号）
      if (/^[-*+]\s*$/.test(t)) { flushTable(); continue; }   // 孤立的项目符号：空列表项，直接丢弃
      const bm = t.match(/^[-*+]\s+(.*)$/);
      const tcList = baseColor === '6B7688' ? '6B7688' : '1F2937';
      if (bm) {
        const lv = Math.min(2, Math.round((raw.match(/^ */)[0].length || 0) / 4));
        const cc = baseColor === '6B7688' ? '6B7688' : '1F2937';
        out += literalListPara(lv, [{ text: '• ', color: tcList }].concat(inlineSegs(bm[1], cc)));
        continue;
      }
      const om = t.match(ORD_RE);
      if (om) {
        const lv = Math.min(2, Math.round((raw.match(/^ */)[0].length || 0) / 4));
        const shown = (ordMap && ordMap[li] != null) ? ordMap[li] : om[1];
        // 内容自带中文序号（如「一、」）时不再叠加阿拉伯数字，避免「1. 一、…」
        const segs = hasOwnNumber(om[2])
          ? inlineSegs(om[2], '1F2937')
          : [{ text: shown + '. ', color: tcList }].concat(inlineSegs(om[2], '1F2937'));
        out += literalListPara(lv, segs);
        continue;
      }
      out += docxRichPara(bodyStyle, inlineSegs(t, baseColor));
    }
    flushTable();
    flushCode();
    return out;
  }

  function buildDocxDocumentXml(messages, title) {
    let body = '';
    body += docxPara('DocTitle', title || 'DeepSeek 对话记录');
    body += docxPara('DocMeta', `导出时间：${nowStamp()}　·　共 ${messages.length} 条消息`);

    const rounds = [];
    messages.forEach(m => {
      if (m.role === 'user') rounds.push({ user: m, ai: [] });
      else {
        if (!rounds.length) rounds.push({ user: null, ai: [] });
        rounds[rounds.length - 1].ai.push(m);
      }
    });

    // 每一轮对话独立一套编号计数器：轮内标题从 1 重新计数，轮次之间互不影响
    rounds.forEach((r, ri) => {
      // 不同对话之间：空几行 + 一条横线（相当于 Markdown 的 ---）
      if (ri > 0) body += docxHr();
      if (r.user) {
        body += docxPara(ri === 0 ? 'RoleUserFirst' : 'RoleUser', '我');
        body += renderDocxBody(r.user.contentMd || r.user.content, false, { n: 0 }, 'body');
      }
      if (r.ai.length) {
        body += docxPara('RoleAI', 'DEEPSEEK');
        r.ai.forEach(m => {
          // 每条回答独立一套编号：从 1 起计，绝不多条回答串成 1.1…1.32
          const cnt = { n: 0 };
          const tk = m.thinkingMd || m.thinking || '';
          if (tk.trim()) {
            body += docxPara('ThinkLabel', '深度思考');
            body += renderDocxBody(tk, false, cnt, 'think');
          }
          const ans = m.answerMd || m.answer;
          if (ans) body += renderDocxBody(ans, true, cnt, 'body');
        });
      }
    });

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><w:body>
${body}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="${(ACTIVE.page||{}).t||1440}" w:right="${(ACTIVE.page||{}).r||1797}" w:bottom="${(ACTIVE.page||{}).b||1440}" w:left="${(ACTIVE.page||{}).l||1797}" w:header="851" w:footer="992" w:gutter="0"/><w:cols w:space="425"/></w:sectPr>
</w:body></w:document>`;
  }

  /* ---- 内嵌 ZIP 打包器（STORE 存储，docx 无需压缩，不依赖任何外部库） ---- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zipStore(files) {
    const enc = new TextEncoder();
    const u16 = v => new Uint8Array([v & 255, (v >>> 8) & 255]);
    const u32 = v => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
    const now = new Date();
    const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | ((now.getSeconds() >> 1) & 31);
    const dosDate = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const nameB = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameB.length);
      local.set(u32(0x04034b50), 0);   // 本地文件头签名
      local.set(u16(20), 4);           // 解压所需版本
      local.set(u16(0x0800), 6);       // 标志：UTF-8 文件名
      local.set(u16(0), 8);            // 压缩方式：STORE
      local.set(u16(dosTime), 10);
      local.set(u16(dosDate), 12);
      local.set(u32(crc), 14);
      local.set(u32(data.length), 18);
      local.set(u32(data.length), 22);
      local.set(u16(nameB.length), 26);
      local.set(u16(0), 28);
      local.set(nameB, 30);
      chunks.push(local, data);
      central.push({ nameB, crc, size: data.length, offset });
      offset += local.length + data.length;
    }
    const centralStart = offset;
    let centralSize = 0;
    for (const c of central) {
      const rec = new Uint8Array(46 + c.nameB.length);
      rec.set(u32(0x02014b50), 0);     // 中央目录签名
      rec.set(u16(20), 4);
      rec.set(u16(20), 6);
      rec.set(u16(0x0800), 8);
      rec.set(u16(0), 10);
      rec.set(u16(dosTime), 12);
      rec.set(u16(dosDate), 14);
      rec.set(u32(c.crc), 16);
      rec.set(u32(c.size), 20);
      rec.set(u32(c.size), 24);
      rec.set(u16(c.nameB.length), 28);
      rec.set(u32(c.offset), 42);
      rec.set(c.nameB, 46);
      chunks.push(rec);
      centralSize += rec.length;
    }
    const eocd = new Uint8Array(22);
    eocd.set(u32(0x06054b50), 0);      // 结束记录签名
    eocd.set(u16(central.length), 8);
    eocd.set(u16(central.length), 10);
    eocd.set(u32(centralSize), 12);
    eocd.set(u32(centralStart), 16);
    chunks.push(eocd);
    return new Blob(chunks, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }

  async function buildDocxBlob(messages, title, preset) {
    if (preset) ACTIVE = preset;
    const enc = new TextEncoder();
    const files = [
      { name: '[Content_Types].xml', data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`) },
      { name: '_rels/.rels', data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`) },
      { name: 'word/_rels/document.xml.rels', data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`) },
      { name: 'word/styles.xml', data: enc.encode(stylesFor(ACTIVE)) },
      { name: 'word/document.xml', data: enc.encode(buildDocxDocumentXml(messages, title)) },
      { name: 'docProps/core.xml', data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xmlEsc(title)}</dc:title><dc:creator>DeepSeek 导出助手</dc:creator>
</cp:coreProperties>`) },
    ];
    return zipStore(files);
  }

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  /* ============================================================
   * 7. 导出执行
   * ============================================================ */
  function serialize(messages, format, title) {
    const base = safeName(title);
    switch (format) {
      case 'txt': return { name: base + '.txt', mime: 'text/plain', data: toPlainText(messages) };
      case 'md': return { name: base + '.md', mime: 'text/markdown', data: toMarkdown(messages, title) };
      case 'json': return { name: base + '.json', mime: 'application/json', data: buildJson(messages, title) };
      case 'html': return { name: base + '.html', mime: 'text/html', data: toHTML(messages, title) };
      case 'doc': return { name: base + '.doc', mime: 'application/msword', data: buildDocHtml(messages, title) };
      case 'docx': return null; // .docx 走异步 OOXML 生成
    }
    return null;
  }

  function doExport(messages, format, title) {
    ACTIVE = presetById(currentFmt());   // HTML/PDF 与 docx 用同一套预设
    if (!messages.length) { toast('没有可导出的内容', 'error'); return; }
    if (format === 'pdf') {
      printToPdf(buildHtml(messages, title));
      toast('打印窗口里选「另存为 PDF」，边距保持「默认」', 'success');
      return;
    }
    if (format === 'docx') {
      buildDocxBlob(messages, title, presetById(currentFmt())).then(blob => {
        downloadBlob(safeName(title) + '.docx', blob);
        toast('已导出 Word（' + presetById(currentFmt()).name + '）', 'success');
      }).catch(err => {
        console.error(err);
        toast('导出 .docx 失败：' + err.message, 'error');
      });
      return;
    }
    const r = serialize(messages, format, title);
    if (r) { download(r.name, r.data, r.mime); toast('已导出 ' + r.name, 'success'); }
  }

  function printToPdf(html) {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    setTimeout(() => {
      try { iframe.contentWindow.focus(); iframe.contentWindow.print(); }
      catch (e) { toast('打印失败，请改用 HTML 下载后转 PDF', 'error'); }
      setTimeout(() => iframe.remove(), 60000);
    }, 500);
  }

  /* ============================================================
   * 8. 单条回答按钮 + 弹出菜单
   * ============================================================ */
  const btnMap = new WeakMap();

  // 向上逐层试探，找到「这一轮」的容器：容器内既能提取到用户提问、又能提取到 AI 回答。
  // 只依赖 DOM 结构，不做消息数组的下标对齐 —— 重新生成产生多个回答时也不会错位。
  function findRoundContainer(block) {
    let node = block;
    while (node && node !== document.body && node !== document.documentElement) {
      try {
        const items = extractItemMessages(node);
        const user = items.find(m => m.role === 'user' && String(m.contentMd || m.content || '').trim().length > 1);
        const hasAI = items.some(m => m.role === 'assistant');
        if (user && hasAI) return { node, items, user };
      } catch (e) { /* 结构不认识就继续向上找 */ }
      node = node.parentElement;
    }
    return null;
  }

  function capturePerMessage(block) {
    // 主路径：该轮容器内同时取 用户提问 + 被点击的这条回答
    if (block) {
      const found = findRoundContainer(block);
      if (found) {
        let ai = found.items.find(m => m.role === 'assistant' && m.block === block);
        if (!ai) { try { ai = extractOneAssistant(block); } catch (e) { /* 静默 */ } }
        if (!ai) ai = found.items.find(m => m.role === 'assistant');
        const round = [found.user, ai].filter(Boolean);
        if (round.length === 2) return { title: getCurrentTitle(), round };
      }
    }
    // 兜底：接口数据里最后一条 assistant + 它前面最近的 user（不猜下标，只回溯相邻提问）
    const msgs = getBlocks();
    if (!msgs.length) return null;
    let aiIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') { aiIdx = i; break; }
    }
    if (aiIdx < 0) return null;
    const round = [];
    for (let i = aiIdx - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') { round.push(msgs[i]); break; }
    }
    round.push(msgs[aiIdx]);
    return { title: getCurrentTitle(), round };
  }

  function elDepth(el) {
    let d = 0, p = el.parentElement;
    while (p) { d++; p = p.parentElement; }
    return d;
  }

  function findActionBar(block) {
    const iconSel = 'button, [role="button"], .ds-icon-button';
    const cands = qa('div', block).filter(d =>
      d.querySelectorAll(iconSel).length >= 3 &&
      !d.querySelector(S.markdown) &&
      d.clientHeight > 0 && d.clientHeight < 90
    );
    if (cands.length) {
      cands.sort((a, b) => elDepth(b) - elDepth(a));
      return cands[0];
    }
    let sib = block.nextElementSibling;
    for (let i = 0; i < 3 && sib; i++) {
      const btns = sib.querySelectorAll(iconSel);
      if (btns.length >= 3) return sib;
      const inner = qa('div', sib).filter(d => d.querySelectorAll(iconSel).length >= 3 && !d.querySelector(S.markdown));
      if (inner.length) { inner.sort((a, b) => elDepth(b) - elDepth(a)); return inner[0]; }
      sib = sib.nextElementSibling;
    }
    return null;
  }

  function createMiniBtn(block) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dsx-mini';
    btn.title = '导出本轮对话';
    btn._dsxBlock = block;
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
    // 点击动作由 window 捕获层统一分发（installActionDispatcher 的 .dsx-mini 分支）
    return btn;
  }

  function injectPerMessageButtons() {
    qa(S.aiMessage).forEach(block => {
      if (!q(S.markdown, block)) return;
      let btn = btnMap.get(block);
      if (!btn) { btn = createMiniBtn(block); btnMap.set(block, btn); }
      btn._dsxBlock = block;
      const bar = findActionBar(block);
      if (bar) {
        if (btn.parentElement !== bar) bar.appendChild(btn);
      } else if (!btn.parentElement || !block.contains(btn)) {
        const row = document.createElement('div');
        row.className = 'dsx-mini-row';
        row.appendChild(btn);
        block.appendChild(row);
      }
    });
  }

  let menuEl = null;
  let menuTarget = null;

  function ensureMenu() {
    if (menuEl) return;
    menuEl = document.createElement('div');
    menuEl.id = 'dsx-menu';
    menuEl.className = 'dsx-hidden';
    menuEl.innerHTML = `
      <div class="dsx-menu-head">
        <span class="dsx-menu-title">导出本轮</span>
        <span class="dsx-menu-sub">含你的提问与回答</span>
      </div>
      <div class="dsx-menu-body">
        <div class="dsx-menu-label">Word 导出格式</div>
        <div class="dsx-menu-row dsx-fmt-row">${fmtChips('dsx-chip dsx-chip-sm')}</div>
        <div class="dsx-fmt-hint" data-fmt-hint></div>
        <div class="dsx-menu-row dsx-row3">
          <button data-act="copy-plain">纯文本</button>
          <button data-act="copy-md">Markdown</button>
          <button data-act="copy-rich">富文本</button>
        </div>
        <div class="dsx-menu-label">下载为文件</div>
        <div class="dsx-menu-row dsx-row3">
          <button data-act="dl-txt">TXT</button>
          <button data-act="dl-md">MD</button>
          <button data-act="dl-html">HTML</button>
        </div>
        <div class="dsx-menu-row dsx-row3">
          <button data-act="dl-json">JSON</button>
          <button data-act="dl-docx">Word</button>
          <button data-act="dl-pdf">PDF</button>
        </div>
      </div>`;
    document.body.appendChild(menuEl);

    // 按钮动作统一由 window 捕获层分发（installActionDispatcher），这里只保留点击空白处关闭
    document.addEventListener('click', (e) => {
      if (menuEl && !menuEl.classList.contains('dsx-hidden') && !menuEl.contains(e.target) && !e.target.closest('.dsx-mini')) {
        hideMenu();
      }
    }, true);
  }

  function openPerMsgMenu(btn) {
    ensureMenu();
    const block = btn._dsxBlock || btn.closest(S.aiMessage);
    const snap = capturePerMessage(block);
    if (!snap) { toast('未能定位本条回答，请刷新页面后重试', 'error'); return; }
    menuTarget = { block, snapshot: snap };
    const rect = btn.getBoundingClientRect();
    menuEl.classList.remove('dsx-hidden');
    const mw = 344, mh = 280;
    let left = Math.min(Math.max(8, rect.right - mw), window.innerWidth - mw - 8);
    let top = rect.bottom + 10;
    if (top + mh > window.innerHeight - 8) top = rect.top - mh - 10;
    if (top < 8) top = 8;
    menuEl.style.left = left + 'px';
    menuEl.style.top = top + 'px';
  }

  function hideMenu() {
    if (menuEl) menuEl.classList.add('dsx-hidden');
  }

  /* ============================================================
   * 9. UI 样式 v2.4 —— 全新视觉
   *    · FAB 改为带文字的胶囊按钮
   *    · 头部：浅蓝渐变 + 顶部品牌色高光条
   *    · 功能按钮改为「图标 + 主标题 + 副说明」信息卡片
   * ============================================================ */
  // 内嵌吉祥物（透明 PNG，主界面站姿大图 / 小界面趴姿图，均为 data URI，离线可用）
  const MASCOT_MAIN = 'data:image/png;base64,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';
  const MASCOT_MINI = 'data:image/png;base64,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';

  const CSS = `
#dsx-root, #dsx-root *{box-sizing:border-box}
#dsx-root button{font-family:inherit}
#dsx-root{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  color:#232c3d;
}

/* ============ 悬浮胶囊按钮 ============ */
#dsx-fab{
  position:fixed;right:34px;bottom:34px;height:52px;padding:0 22px 0 18px;border-radius:999px;
  display:flex;align-items:center;gap:9px;border:none;cursor:pointer;
  background:#3f5df2;color:#fff;font-family:inherit;font-size:14.5px;font-weight:600;letter-spacing:.3px;
  box-shadow:0 6px 22px rgba(77,107,254,.38),0 1px 2px rgba(29,41,87,.12);
  transition:transform .2s cubic-bezier(.22,1,.36,1),box-shadow .2s,background .2s;
  z-index:2147483646;
}
#dsx-fab:hover{transform:translateY(-2px);background:#3350e0;box-shadow:0 12px 30px rgba(77,107,254,.5)}
#dsx-fab:active{transform:translateY(0) scale(.985)}
#dsx-fab svg{width:19px;height:19px;flex:none}

/* ============ 面板 ============ */
#dsx-panel{
  position:fixed;right:36px;bottom:108px;width:min(560px,calc(100vw - 88px));max-height:88vh;
  background:rgba(255,255,255,.90);
  -webkit-backdrop-filter:blur(20px) saturate(1.3);
  backdrop-filter:blur(20px) saturate(1.3);
  border-radius:20px;overflow:hidden;display:block;
  border:1px solid #E3E9F4;
  box-shadow:0 30px 80px -14px rgba(29,41,87,.22),0 10px 28px -10px rgba(29,41,87,.12);
  z-index:2147483646;
  animation:dsx-in .28s cubic-bezier(.22,1,.36,1);
}
@keyframes dsx-in{from{opacity:0;transform:translateY(20px) scale(.965)}to{opacity:1;transform:none}}
#dsx-panel.dsx-hidden{display:none}
/* 吉祥物水印：铺在面板背景上，不占任何布局高度 */
#dsx-panel::after{
  content:"";position:absolute;left:50%;top:50%;
  width:250px;height:250px;                     /* 比面板本身小一截 */
  transform:translate(-50%,-50%);               /* 居中 */
  background:url("${MASCOT_MAIN}") center/contain no-repeat;
  opacity:1;                                    /* 实心：完全不透明 */
  filter:none;                                   /* 不加投影，避免糊出"背景" */
  pointer-events:none;z-index:0;
}
.dsx-head,.dsx-body{position:relative;z-index:1}
/* 内容浮在实心角色上时，用白色柔光保证可读 */
.dsx-btn .txt b,.dsx-btn .txt em,.dsx-fmt-hint,.dsx-chip,.dsx-menu-row button,.dsx-menu-title,.dsx-menu-sub,.dsx-section span,.dsx-tip{
  text-shadow:0 1px 3px rgba(255,255,255,.95),0 0 7px rgba(255,255,255,.85);
}
#dsx-panel::before{
  content:"";position:absolute;top:0;left:0;right:0;height:3px;z-index:2;
  background:linear-gradient(90deg,rgba(255,255,255,.38) 0%,rgba(255,255,255,.10) 100%);
}

/* ============ 顶部吉祥物横幅 ============ */
/* ============ 头部 ============ */
.dsx-head{
  position:relative;z-index:2;display:flex;align-items:center;gap:16px;
  padding:28px 28px 24px;
  background:linear-gradient(135deg,#4a67f5 0%,#2f4bd8 100%);
  border-bottom:1px solid rgba(255,255,255,.18);
}
.dsx-head .logo{
  width:52px;height:52px;border-radius:16px;flex:none;
  background:rgba(12,22,64,.30);
  border:1px solid rgba(255,255,255,.22);
  display:flex;align-items:center;justify-content:center;color:#fff;
  box-shadow:none;
}
.dsx-head .logo svg{width:25px;height:25px}
.dsx-head h2{font-size:19.5px;font-weight:700;color:#fff;letter-spacing:-.2px;line-height:1.2;margin:0}
.dsx-head .dsx-ver{font-size:11px;font-weight:600;color:#fff;background:rgba(12,22,64,.32);border:1px solid rgba(255,255,255,.28);border-radius:20px;padding:2px 8px;margin-left:6px;vertical-align:2px;letter-spacing:0}
.dsx-head p{font-size:12.5px;color:#fff;margin:6px 0 0;letter-spacing:.2px}
.dsx-close{
  position:absolute;top:22px;right:22px;width:32px;height:32px;border-radius:50%;
  border:none;background:transparent;color:#fff;cursor:pointer;
  font-size:14px;line-height:1;display:flex;align-items:center;justify-content:center;
  transition:all .16s;
}
.dsx-close:hover{background:rgba(255,255,255,.22);color:#fff;transform:rotate(90deg)}

/* ============ 主体 ============ */
.dsx-body{display:block;width:auto;max-height:calc(88vh - 120px);overflow-y:auto;overflow-x:hidden;padding:28px 28px 34px;box-sizing:border-box}
.dsx-body::-webkit-scrollbar{width:8px}
.dsx-body::-webkit-scrollbar-thumb{background:#dde3ee;border-radius:99px;border:2px solid #f7f8fa}
.dsx-body::-webkit-scrollbar-thumb:hover{background:#c6cfdf}

.dsx-section{display:flex;align-items:center;gap:10px;margin:30px 0 16px;min-width:0;overflow:hidden}
.dsx-section:first-child{margin-top:0}
.dsx-section i{width:6px;height:6px;border-radius:50%;background:#4d6bfe;flex:none;box-shadow:0 0 0 3px #eef2ff}
.dsx-section span{font-size:11.5px;font-weight:700;color:#6b7688;letter-spacing:1.2px;white-space:nowrap}
.dsx-section::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,#eef1f7,transparent)}

/* ============ 功能卡片 ============ */
.dsx-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;width:100%;box-sizing:border-box}
.dsx-btn{
  position:relative;display:flex;align-items:center;gap:13px;min-width:0;width:100%;box-sizing:border-box;overflow:hidden;
  padding:16px 18px;border-radius:14px;border:1px solid #E3E9F4;background:rgba(255,255,255,.90);
  box-shadow:0 1px 2px rgba(29,41,87,.035);
  cursor:pointer;text-align:left;font-family:inherit;transition:all .18s cubic-bezier(.22,1,.36,1);
}
.dsx-btn:hover{
  border-color:#c3d0ff;background:rgba(255,255,255,.97);
  transform:translateY(-2px);
  box-shadow:0 12px 26px -8px rgba(77,107,254,.24);
}
.dsx-btn:active{transform:translateY(0) scale(.988)}
.dsx-btn .ico{
  width:42px;height:42px;border-radius:13px;flex:none;color:#3d55a8;
  display:flex;align-items:center;justify-content:center;font-size:19px;
  background:#eef3fd;transition:all .18s;
}
.dsx-btn .ico.icotxt{font-family:Consolas,monospace;font-size:9.5px;font-weight:700;letter-spacing:0}
.dsx-btn .ico svg{display:block}
.dsx-btn:hover .ico{background:#eaf0ff;transform:scale(1.04)}
.dsx-btn .txt{display:flex;flex-direction:column;gap:3px;min-width:0;overflow:hidden}
.dsx-btn .txt b{font-size:14px;font-weight:650;color:#1f2733;line-height:1.25;letter-spacing:-.1px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsx-btn .txt em{font-style:normal;font-size:11.5px;color:#5a6478;line-height:1.3;font-weight:400;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsx-btn:hover .txt b{color:#2a4bd0}

/* 强调按钮（细蓝描边 + 蓝字，与品牌色一致） */
.dsx-btn.dsx-accent{
  border-color:#b9caff;
  background:#ffffff;
}
.dsx-btn.dsx-accent .ico{background:#eef2ff}
.dsx-btn.dsx-accent .txt b{color:#4d6bfe}
.dsx-btn.dsx-block{grid-column:1/-1}

/* 主按钮 */
.dsx-btn.dsx-primary{
  grid-column:1/-1;justify-content:center;padding:17px 20px;border:none;
  background:#4d6bfe;
  box-shadow:0 8px 22px -6px rgba(77,107,254,.5);
}
.dsx-btn.dsx-primary:hover{box-shadow:0 14px 32px -8px rgba(77,107,254,.62);transform:translateY(-2px)}
.dsx-btn.dsx-primary .ico{background:rgba(255,255,255,.16);width:38px;height:38px;font-size:18px}
.dsx-btn.dsx-primary:hover .ico{background:rgba(255,255,255,.24)}
.dsx-btn.dsx-primary .txt{align-items:flex-start}
.dsx-btn.dsx-primary .txt b{color:#fff;font-size:14.5px}
.dsx-btn.dsx-primary .txt em{color:rgba(255,255,255,.72)}

/* 底部说明 */
.dsx-tip{
  margin:30px 0 4px;padding:20px 22px;border-radius:16px;word-break:break-word;overflow:hidden;
  background:rgba(255,255,255,.90);border:1px solid #eceff5;
  font-size:13px;color:#5a6478;line-height:2.1;
}
.dsx-tip b{color:#333d4f;font-weight:650}
.dsx-tip .k{
  display:inline-flex;align-items:center;justify-content:center;
  min-width:20px;height:20px;padding:0 5px;margin:0 2px;border-radius:6px;
  background:#fff;border:1px solid #e4e9f3;color:#4d6bfe;font-size:11px;font-weight:700;
  vertical-align:-4px;
}

/* ============ 格式选择芯片 ============ */
.dsx-fmt-wrap{margin:0 0 14px;padding:12px 14px;border:1px solid #E3E9F4;border-radius:14px;background:rgba(255,255,255,.90)}
.dsx-fmt-title{font-size:11.5px;font-weight:700;color:#616c7e;letter-spacing:.6px;margin-bottom:9px}
.dsx-fmt-row{display:flex;flex-wrap:wrap;gap:8px}
.dsx-chip{
  appearance:none;border:1px solid #D9E1EF;background:rgba(255,255,255,.90);color:#414a5e;cursor:pointer;
  font-size:12.5px;line-height:1;padding:8px 13px;border-radius:999px;transition:all .16s;font-family:inherit;
}
.dsx-chip:hover{border-color:#4d6bfe;color:#4d6bfe;background:#fff}
.dsx-chip.dsx-chip-on{background:#3f5df2;border-color:#3f5df2;color:#fff;box-shadow:0 4px 12px -4px rgba(63,93,242,.55)}
.dsx-chip-sm{padding:6px 10px;font-size:11.5px}
.dsx-fmt-hint{margin-top:9px;font-size:11.5px;color:#5a6478;line-height:1.5}

/* ============ 单条按钮 ============ */
.dsx-mini{
  display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;
  background:transparent;border:none;color:#6f7b8e;cursor:pointer;transition:all .15s;flex:none;
}
.dsx-mini:hover{background:#eef2ff;color:#4d6bfe;transform:translateY(-1px)}
.dsx-mini-row{display:flex;justify-content:flex-end;padding:6px 4px 2px}

/* ============ 弹出菜单（与面板同一套设计令牌） ============ */
#dsx-menu{
  position:fixed;z-index:2147483647;width:340px;background:rgba(255,255,255,.90);
  border-radius:18px;overflow:hidden;
  border:1px solid #E3E9F4;
  box-shadow:0 22px 56px -12px rgba(29,41,87,.22),0 6px 16px -8px rgba(29,41,87,.1);
  animation:dsx-in .2s cubic-bezier(.22,1,.36,1);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
}
#dsx-menu.dsx-hidden{display:none}
/* 吉祥物水印：铺在菜单背景上，不占布局 */
#dsx-menu::after{
  content:"";position:absolute;left:50%;top:50%;
  width:120px;height:96px;                      /* 比菜单本身小一截 */
  transform:translate(-50%,-50%);               /* 居中 */
  background:url("${MASCOT_MINI}") center/contain no-repeat;
  opacity:1;                                    /* 实心：完全不透明 */
  filter:none;                                   /* 不加投影，避免糊出"背景" */
  pointer-events:none;z-index:0;
}
.dsx-menu-head,.dsx-menu-body{position:relative;z-index:1}
.dsx-menu-head{
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:16px 18px;
  background:linear-gradient(135deg,#4a67f5 0%,#2f4bd8 100%);
  border-bottom:1px solid rgba(255,255,255,.18);
}
.dsx-menu-title{font-size:14px;font-weight:700;color:#fff}
.dsx-menu-sub{font-size:11px;color:#fff;margin-left:auto;text-align:right}
.dsx-menu-body{padding:14px 18px 16px}
.dsx-menu-row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.dsx-menu-row.dsx-row3{grid-template-columns:1fr 1fr 1fr}
.dsx-menu-row button{
  display:flex;align-items:center;justify-content:center;
  padding:10px 8px;border-radius:10px;border:1px solid #E3E9F4;background:rgba(255,255,255,.90);
  font-size:12.5px;font-weight:600;color:#333d4f;cursor:pointer;transition:all .16s;font-family:inherit;
}
.dsx-menu-row button:hover{border-color:#C3D0FF;background:rgba(255,255,255,.97);color:#2a4bd0}
.dsx-menu-label{
  display:flex;align-items:center;gap:8px;
  font-size:10.5px;font-weight:700;color:#6b7688;letter-spacing:.8px;margin:11px 0 8px;
}
.dsx-menu-label::after{content:"";flex:1;height:1px;background:#E6EAF3}

/* ============ Toast（提示框已改为全内联样式，不再依赖这里的规则） ============ */
`;

  /* ============================================================
   * 10. UI 构建
   * ============================================================ */
  function toast(msg, type) {
    let t = document.getElementById('dsx-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'dsx-toast';
      // 全部用内联样式：即使页面 CSS 冲突 / 样式注入失败，提示也一定可见
      t.style.cssText = 'position:fixed;top:auto;bottom:36px;left:50%;height:auto;min-height:0;'
        + 'transform:translateX(-50%) translateY(20px);'
        + 'z-index:2147483647;background:rgba(27,37,89,.96);color:#fff;padding:11px 18px;border-radius:10px;'
        + 'font-size:13.5px;line-height:1.5;box-shadow:0 8px 24px rgba(0,0,0,.28);opacity:0;'
        + 'transition:opacity .22s,transform .22s;pointer-events:none;max-width:min(520px,80vw);white-space:pre-wrap';
      (document.body || document.documentElement).appendChild(t);
    }
    t.textContent = msg;
    t.style.background = type === 'error' ? 'rgba(220,38,38,.96)' : 'rgba(27,37,89,.96)';
    t.style.opacity = '1';
    t.style.transform = 'translateX(-50%) translateY(0) scale(1)';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => {
      t.style.opacity = '0';
      t.style.transform = 'translateX(-50%) translateY(20px) scale(.96)';
    }, 3500);
  }

  const SVG_COPY = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
  const SVG_DOC = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';

  function btnHtml(act, icon, label, desc, accent, block) {
    const isSvg = icon.charAt(0) === '<';
    return `<button class="dsx-btn${accent ? ' dsx-accent' : ''}${block ? ' dsx-block' : ''}" data-act="${act}">
      <span class="ico${isSvg ? '' : ' icotxt'}">${icon}</span>
      <span class="txt"><b>${label}</b><em>${desc}</em></span>
    </button>`;
  }

  function buildUI() {
    // 多版本共存防护：页面上若已有其他版本脚本创建的根节点，
    // 只有当本版本更新时才替换（旧版本没有 dataset.ver，视为 0）
    const existing = document.getElementById('dsx-root');
    if (existing) {
      const oldVer = String(existing.dataset.ver || '0');
      const newer = (() => {
        const a = SCRIPT_VERSION.split('.').map(Number);
        const b = oldVer.split('.').map(Number);
        for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); }
        return false;
      })();
      if (!newer) return;
      existing.remove();
    }
    GM_addStyle(CSS);

    const root = document.createElement('div');
    root.id = 'dsx-root';
    root.dataset.ver = SCRIPT_VERSION;

    const fab = document.createElement('button');
    fab.id = 'dsx-fab';
    fab.title = 'DeepSeek 对话导出助手';
    fab.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>导出</span>`;

    const panel = document.createElement('div');
    panel.id = 'dsx-panel';
    panel.className = 'dsx-hidden';
    panel.innerHTML = `
      <div class="dsx-head">
        <button class="dsx-close" title="关闭">×</button>
        <div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></div>
        <div>
          <h2>DeepSeek 导出助手 <span class="dsx-ver">v${SCRIPT_VERSION}</span></h2>
          <p>纯文本复制 · 多格式下载 · 单条导出</p>
        </div>
      </div>
      <div class="dsx-body">
        <div class="dsx-section"><i></i><span>复制</span></div>
        <div class="dsx-grid">
          ${btnHtml('copy-plain', SVG_COPY, '复制纯文本', '无 Markdown 符号', true)}
          ${btnHtml('copy-md', SVG_DOC, '复制 Markdown', '保留排版格式')}
        </div>
        <div class="dsx-grid" style="margin-top:16px">
          ${btnHtml('copy-rich', SVG_DOC, '复制富文本', '带标题与段落格式，可直接粘贴进 Word', false, true)}
        </div>
        <div class="dsx-section"><i></i><span>下载为文件</span></div>
        <div class="dsx-fmt-wrap">
          <div class="dsx-fmt-title">Word 导出格式</div>
          <div class="dsx-fmt-row">${fmtChips('dsx-chip')}</div>
          <div class="dsx-fmt-hint" data-fmt-hint></div>
        </div>
        <div class="dsx-grid">
          ${btnHtml('dl-docx', 'DOCX', 'Word 文档', '.docx · WPS 直接打开', true)}
          ${btnHtml('dl-pdf', 'PDF', 'PDF', '打印为 PDF · 另存即可')}
          ${btnHtml('dl-txt', 'TXT', '纯文本 TXT', '.txt · 无符号，最通用')}
          ${btnHtml('dl-md', 'MD', 'Markdown', '.md · 需用编辑器打开')}
          ${btnHtml('dl-html', 'HTML', '网页 HTML', '.html · 带排版，可打印')}
          ${btnHtml('dl-json', 'JSON', '数据 JSON', '.json · 结构化')}
        </div>
        <div class="dsx-tip">
          <b>单轮导出</b>：每条回答底部操作栏里有一个下载按钮，点开可复制或下载这一轮对话（含你的提问）。<br>
          <b>PDF</b> 会打开打印窗口，选择「另存为 PDF」即可；<b>Word</b> 为真正的 .docx 文档，WPS / Office 都能直接打开。
        </div>
      </div>
    `;

    root.appendChild(fab);
    root.appendChild(panel);
    document.body.appendChild(root);

    fab.addEventListener('click', () => panel.classList.toggle('dsx-hidden'));
    panel.querySelector('.dsx-close').addEventListener('click', () => panel.classList.add('dsx-hidden'));
  }

  // 统一动作分发：绑定在 window 捕获阶段——这是浏览器事件流的第一站，
  // 页面或其他脚本在 document/冒泡阶段拦截点击也拦不住它
  function installActionDispatcher() {
    window.addEventListener('click', (e) => {
      let btn = null;
      try {
        const t = e.target;
        if (!t || typeof t.closest !== 'function') return;
        // 单条回答旁的迷你按钮
        const mini = t.closest('.dsx-mini');
        if (mini) {
          e.preventDefault();
          if (e.stopImmediatePropagation) e.stopImmediatePropagation();
          else e.stopPropagation();
          console.log('[DeepSeek导出助手] 收到点击：单轮导出按钮');
          openPerMsgMenu(mini);
          return;
        }
        const chip = t.closest('[data-fmt]');
        if (chip) {
          e.preventDefault();
          if (e.stopImmediatePropagation) e.stopImmediatePropagation();
          else e.stopPropagation();
          setFmt(chip.getAttribute('data-fmt'));
          return;
        }
        btn = t.closest('#dsx-panel [data-act], #dsx-menu [data-act]');
        if (!btn) return;
        // 命中我们自己的按钮：就地截停，防止后续阶段被页面脚本干扰或重复执行
        e.preventDefault();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        else e.stopPropagation();
        const scope = t.closest('#dsx-menu') ? 'menu' : 'panel';
        console.log('[DeepSeek导出助手] 收到点击：' + btn.dataset.act + (scope === 'menu' ? '（单轮菜单）' : '（主面板）'));
        if (scope === 'menu') runMenuAction(btn);
        else runPanelAction(btn.dataset.act);
      } catch (err) {
        console.error('[DeepSeek导出助手] 按钮处理异常：', err);
        try { toast('导出出错：' + (err && err.message ? err.message : err), 'error'); } catch (e2) { /* 静默 */ }
      }
    }, true);
  }

  // 主面板动作
  function runPanelAction(act) {
    const title = getCurrentTitle();
    const messages = getBlocks();
    if (!messages.length) { toast('未捕获到对话内容，请先进入某个对话', 'error'); return; }
    const userCount = messages.filter(m => m.role === 'user').length;
    if (act === 'copy-plain') copyText(toPlainText(messages)).then(() => toast(`已复制纯文本（含你的提问 ${userCount} 条）`, 'success')).catch(() => toast('复制失败', 'error'));
    else if (act === 'copy-md') copyText(toMarkdown(messages, title)).then(() => toast('已复制 Markdown', 'success')).catch(() => toast('复制失败', 'error'));
    else if (act === 'copy-rich') copyRich(messages, title);
    else if (act.startsWith('dl-')) doExport(messages, act.slice(3), title);
  }

  // 单轮菜单动作
  function runMenuAction(btn) {
    if (!menuTarget) return;
    const act = btn.dataset.act;
    const snap = menuTarget.snapshot;
    const messages = snap.round;
    const title = snap.title + '_本轮对话';
    if (act === 'copy-plain') copyText(toPlainText(messages)).then(() => toast('已复制本轮对话纯文本', 'success')).catch(() => toast('复制失败', 'error'));
    else if (act === 'copy-md') copyText(toMarkdown(messages, snap.title)).then(() => toast('已复制本轮对话 Markdown', 'success')).catch(() => toast('复制失败', 'error'));
    else if (act === 'copy-rich') copyRich(messages, snap.title);
    else if (act.startsWith('dl-')) doExport(messages, act.slice(3), title);
    hideMenu();
  }

  /* ============================================================
   * 11. 初始化
   * ============================================================ */
  let observer = null;

  function init() {
    buildUI();
    installActionDispatcher();
    try { syncFmtChips(); } catch (e) { /* 忽略 */ }
    try { injectPerMessageButtons(); }
    catch (err) { console.warn('[DeepSeek导出助手] 单条按钮注入失败：', err); }
    if (observer) observer.disconnect();
    const scheduleInject = () => {
      clearTimeout(scheduleInject._t);
      scheduleInject._t = setTimeout(() => {
        try { injectPerMessageButtons(); }
        catch (err) { console.warn('[DeepSeek导出助手] 单条按钮注入失败：', err); }
      }, 300);
    };
    observer = new MutationObserver(scheduleInject);
    observer.observe(document.body, { childList: true, subtree: true });
    console.log('[DeepSeek导出助手] v' + SCRIPT_VERSION + ' 已加载。如果按钮点了没反应，请按 F12 把红色报错截图发给开发者。');
  }

  installNetworkHooks();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 300));
  } else {
    setTimeout(init, 300);
  }
})();
