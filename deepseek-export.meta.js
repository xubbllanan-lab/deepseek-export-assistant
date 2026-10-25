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
