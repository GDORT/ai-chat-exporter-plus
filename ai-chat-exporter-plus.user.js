// ==UserScript==
// @name         AI对话导出增强版 - 多平台（豆包/DeepSeek/Kimi/通义/讯飞/元宝/纳米）
// @namespace    http://tampermonkey.net/
// @version      2026.10.05-plus
// @description  多平台 AI 对话导出增强：图片本地化链接（images/ 相对路径）、豆包用户图位置修复、AI 生成图/搜索卡片图导出、图片归一化去重、非图片附件导出、全量拉取一键导出（zip 含 md+json+images+files+取证）、批量导出；纯本地处理无数据外传。已知限制：豆包文字+图片消息可能拆分、canvas 渲染图只报告
// @author       soloman1986（原作者）+ GD 改进
// @source       https://scriptcat.org/zh-CN/script-show-page/7403   （上游：AI对话导出word/json/md，作者 soloman1986，v2025.9.25-2.scrollmerge，MIT）
// @homepageURL  https://scriptcat.org/zh-CN/script-show-page/7403
// @match        *://chat.deepseek.com/*
// @match        *://bot.n.cn/*
// @match        *://yuanbao.tencent.com/*
// @match        *://*.kimi.com/*
// @match        *://*.tongyi.com/*
// @match        *://*.xfyun.cn/*
// @match        *://*.doubao.com/*
// 注：已移除 JSZip @require（jsdelivr 国内常被墙/超时，且 generateAsync 在油猴沙箱下易挂起导致“卡死在打包”）；打包改用内置纯 JS ZIP 写入（utils.makeStoreZip，零依赖）
// @grant        GM_addStyle
// @grant        unsafeWindow
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';
    console.log('🚀 脚本开始加载', new Date().toISOString());

    // 配置常量
    const CONFIG = {
        DEFAULT_TITLE: '未命名对话',
        BUTTON_OPACITY: 0.3,
        BUTTON_HOVER_OPACITY: 1,
        SPINNER_ANIMATION_DURATION: '1s',
        REL_AND_KNOWLEDGE: false // 默认值为false，表示默认不导出参考链接和知识库
    };

    // 平台URL模式
    const PLATFORM_PATTERNS = {
        deepseek: /chat_session_id=/,
        ncn: /conversation\/info\?conversation_id=/,
        yuanbao: /\/api\/user\/agent\/conversation\/v1\/detail/,
        kimi:  /(\/apiv2\/kimi\.chat\.v1\.ChatService\/ListMessages|\/api\/chat\/[^\/]+\/messages|\/api\/chat|chat_session_id)/,///\/apiv2\/kimi\.chat\.v1\.ChatService\/ListMessages/
        kimi_title: /\/apiv2\/kimi\.chat\.v1\.ChatService\/GetChat/,//kimi标题信息API
        tongyi: /\/dialog\/chat\/list/,
        iflytek: /\/iflygpt\/u\/chat_history\/all\//,
        doubao:/\/im\/chain\/single/, //过期alice\/message\/list/
        doubao_title:/\/im\/conversation\/info/ // 豆包标题会话信息API
    };

    // 状态管理
    const state = {
        targetResponse: null,
        lastUpdateTime: null,
        convertedMd: null,
        platformType: null,
        messageStats: {
            totalTokens: 0,
            totalChars: 0,
            fileCount: 0,
            questions: 0,
            convTurns: 0
        },
        currentTitle: CONFIG.DEFAULT_TITLE,
        kimiSessionId: null,
        kimiTitleCache: null,
        authToken: null,
        // 分页历史记录累积池：key为会话标识，map以消息ID去重存储所有已拦截的消息
        mergeStore: {
            key: null,
            map: new Map(),
            title: null
        },
        // 图片收集器：按会话收集所有图片 URL，用于打包下载
        imageStore: {
            key: null,
            // Map<url, { url, description, platform, filename }>
            map: new Map()
        },
        // 会话列表接口的累计缓存（批量枚举用；只存 id/标题/URL，不参与对话解析）
        recentConvCells: new Map(),
        // DeepSeek 网络取证：记录会话相关的 XHR/fetch URL（去重、上限 60），写进 _diagnostics.json。
        // 目的：若列表接口不是预期的 chat_session，可凭这份记录直接定位真实端点，不再靠猜。
        netLog: [],
        // 非图片附件收集器（PDF/Word/Excel 等）：打包进 zip 的 files/
        fileStore: {
            key: null,
            // Map<key, { url, name, filename, platform }>
            map: new Map()
        }
    };

    // 日志工具
    const logger = {
        info: (msg, data) => console.log(`[AI对话导出] INFO: ${msg}`, data || ''),
        warn: (msg, data) => console.warn(`[AI对话导出] WARN: ${msg}`, data || ''),
        error: (msg, error) => console.error(`[AI对话导出] ERROR: ${msg}`, error || '')
    };

    // 工具函数
    const utils = {
        formatTimestamp: (timestamp) => {
            if (!timestamp) return 'N/A';
            let dt;
            try {
                // 1. 检查是否是数字（Unix 时间戳） const ts = typeof timestamp === 'string' ? parseInt(timestamp) : timestamp;
                if (typeof timestamp === 'number') {
                    // 判断是秒级还是毫秒级（通常毫秒级时间戳 >= 1e12）
                    dt = new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
                }
                // 2. 检查是否是字符串（ISO 8601 或类似格式）
                else if (typeof timestamp === 'string') {
                    //dt = new Date(timestamp);
                    dt = new Date(parseInt(timestamp) < 1e12 ? parseInt(timestamp) * 1000 : parseInt(timestamp));
                }
                // 3. 其他情况（如已经是 Date 对象）
                else {
                    dt = new Date(timestamp);
                }

                // 检查日期是否有效
                if (isNaN(dt.getTime())) {
                    return 'Invalid Date';
                }

                // 使用瑞典格式 (YYYY-MM-DD HH:MM:SS) 并替换特殊字符
                return dt.toLocaleString('sv').replace(/[T \/]/g, '_');
            } catch (e) {
                logger.error('时间戳格式化错误', e);
                return 'Invalid Date';
            }
        },

        adjustHeaderLevels: (text, increaseBy = 1) => {
            if (!text) return '';
            return text.replace(/^(#+)(\s*)(.*?)\s*$/gm, (match, hashes, space, content) => {
                return '#'.repeat(hashes.length + increaseBy) + ' ' + content.trim();
            });
        },

        getLocalTimestamp: () => {
            const d = new Date();
            const offset = d.getTimezoneOffset() * 60 * 1000;
            return new Date(d.getTime() - offset).toISOString()
                .slice(0, 19)
                .replace(/T/g, '_')
                .replace(/:/g, '-');
        },

        // 下载文件名清洗（复用同一套安全规则，避免两套清洗逻辑不一致）
        sanitizeFilename: (name) => utils.safeAssetName(name, 'export'),

        // 平台标识（文件名后缀用，2026-10-11 用户反馈）：与 getExportFilename 的 platformPrefix 同一套映射
        platformTag: () => {
            switch (state.platformType) {
                case 'deepseek': return 'DeepSeek';
                case 'ncn': return 'AI-N';
                case 'yuanbao': return 'Yuanbao';
                case 'kimi': return 'Kimi';
                case 'tongyi': return 'Tongyi';
                case 'iflytek': return 'Iflytek';
                case 'doubao': case 'doubao_title': return 'Doubao';
                default: return 'AI';
            }
        },

        // 给文件名挂平台后缀（插在扩展名前）：_批量导出授权探测_1.txt → _批量导出授权探测_1_DeepSeek.txt；无扩展名则直接追加。
        // 场景：批量导出前的「允许多文件下载」授权探测文件（primeDownloads），多平台各导一次会各留两个同名探测文件互相冲突。
        nameWithPlatform: (name, tag) => {
            if (!name || !tag) return name || '';
            return String(name).replace(/(\.[A-Za-z0-9]{1,8})?$/, (m) => `_${tag}${m || ''}`);
        },

        createBlobDownload: (content, type, filename) => {
            try {
                const blob = new Blob([content], { type });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                }, 100);
                return true;
            } catch (e) {
                logger.error('创建Blob下载失败', e);
                return false;
            }
        },

        // 从 URL 推断扩展名
        getExtFromUrl: (url) => {
            try {
                const u = new URL(url);
                const pathname = u.pathname;
                const match = pathname.match(/\.(png|jpe?g|gif|webp|bmp|svg|webp)(\?|$)/i);
                if (match) return match[1].toLowerCase();
                // 从 query 里的 ty 参数或文件名猜
                const ty = u.searchParams.get('ty');
                if (ty && /^(png|jpe?g|gif|webp|bmp|svg)$/i.test(ty)) return ty.toLowerCase();
                return 'png'; // 默认 png
            } catch(e) {
                return 'png';
            }
        },

        // 图片归一化去重键：豆包同一张图会给出多个签名 URL（缩略图 / 预览 / 原图），
        // 域名（p3 / p11 / p26-flow-imagex-sign.byteimg.com）与 query 都不同，
        // 但 tos- 对象路径相同 —— 用 tos- 路径作键，才能把「同一张图的多个变体」收敛成一张，
        // 避免同一张图被下载好几遍（用户实机反馈"下载变慢"）。
        // 注意：只归一化含 tos- 的图床 URL；其他平台（如 DeepSeek）走下面的 file_id 归一路径。
        imageKeyOf: (url) => {
            if (!url || typeof url !== 'string') return '';
            const noQuery = url.split('?')[0].split('#')[0];
            const i = noQuery.indexOf('tos-');
            if (i >= 0) return noQuery.slice(i).split('~')[0];
            // DeepSeek 同一文件在会话 JSON（chat.deepseek.com/api/file?signed_path 里的 state）与
            // DOM（files.deepseeksvc.com/api/file）下域名、state 都不同，但 file_id 相同 ——
            // 用 file_id 归一键，否则同一张图会被当成两张（重复下载 + 编号错位）。
            if (/deepseek/i.test(url)) {
                try {
                    const fid = new URL(url, location.href).searchParams.get('file_id');
                    if (fid) return 'file_id:' + fid;
                } catch (e) {}
            }
            return url;
        },

        // ===== 非图片附件（PDF/Word/Excel 等）=====
        // 文件名清洗（zip 内不能出现路径分隔符与非法字符）
        sanitizeFileName: (name, fallback) => utils.safeAssetName(name, fallback),

        // 取/登记一个文件条目（按 URL 归一化键去重）。返回 { url, name, filename }
        getFileEntry: (platform, convKey, url, name) => {
            if (!url) return null;
            if (state.fileStore.key !== convKey) {
                state.fileStore.key = convKey;
                state.fileStore.map = new Map();
            }
            const key = utils.imageKeyOf(url);
            if (!key) return null;
            const existing = state.fileStore.map.get(key);
            if (existing) {
                if (!existing.name && name) existing.name = name;
                return existing;
            }
            if (state.fileStore.map.size >= 100) return null; // 安全上限
            const count = state.fileStore.map.size + 1;
            const base = utils.sanitizeFileName(name, `file_${String(count).padStart(3, '0')}`);
            const entry = {
                key,
                url,
                name: name || base,
                filename: `file_${String(count).padStart(3, '0')}_${base}`,
                platform
            };
            state.fileStore.map.set(key, entry);
            return entry;
        },

        // 豆包附件块里的"文件"元信息。注意：非图片附件的字段名**未取证**（样本里只有图片），
        // 因此这里放宽尝试多种字段名；取不到 URL 时至少保留文件名，不让信息静默消失。
        doubaoFileMeta: (att) => {
            if (!att || typeof att !== 'object') return null;
            const cand = att.file || att.file_info || att.attachment || att;
            const url = cand.url || cand.file_url || cand.download_url || cand.download_uri || cand.path ||
                        (cand.file && cand.file.url) || '';
            const name = cand.file_name || cand.name || cand.filename ||
                         (cand.file && cand.file.name) || '';
            const u = (typeof url === 'string') ? url : '';
            if (!u && !name) return null;
            return { url: u, name: utils.mdLabel(name || '') };
        },

        // ===== 历史完整性检查（"仅 MD / 仅 JSON"能不能单独完成任务）=====
        // 平台分页返回里带 `has_more`（还有更早的页）和每条消息的 `index_in_conv`（在会话中的序号）。
        // 只有「没有更早的页」且「已经拿到第 1 条」才算完整 —— 否则导出的只是当前已加载的一部分。
        historyCompleteness: () => {
            try {
                if (state.platformType !== 'doubao') return { complete: true, unknown: true, hasMore: false, minIdx: null };
                const body = state.lastJsonData?.downlink_body?.pull_singe_chain_downlink_body;
                const list = body?.messages || [];
                const idx = list.map(m => parseInt(m.index_in_conv, 10)).filter(n => !isNaN(n));
                const minIdx = idx.length ? Math.min(...idx) : null;
                const hasMore = !!body?.has_more;
                return { complete: !hasMore && minIdx !== null && minIdx <= 1, hasMore, minIdx };
            } catch (e) {
                return { complete: true, unknown: true, hasMore: false, minIdx: null };
            }
        },
        // ===== 统计口径（悬浮提示与导出完成提示必须一致，2026-10-05）=====
        statsSnapshot: () => {
            let domImgs = 0;
            try { domImgs = [...state.imageStore.map.values()].filter(i => i.source === 'dom').length; } catch (e) {}
            return {
                imgs: state.imageStore.map.size,
                domImgs,
                files: state.fileStore.map.size,
                msgs: state.mergeStore.map.size
            };
        },
        // 唯一口径：图片 X 张（DOM 通道 Y 张）｜附件 Z 个｜消息 W 条
        statsLine: (extra) => {
            const s = utils.statsSnapshot();
            return `图片 ${s.imgs} 张（DOM 通道 ${s.domImgs} 张）｜附件 ${s.files} 个｜消息 ${s.msgs} 条` + (extra || '');
        },

        // ===== 非阻塞通知（替代下载流程里的 alert）=====
        // 背景：导出完成/降级时用 alert 提示，而 alert 是「模态阻塞」——弹窗没关闭前 JS 线程被占住，
        // 悬浮按钮的文字会一直卡在「下载图片 x/y」「打包 ZIP…」不动（用户实机反馈）。
        // 这里改成页面顶部浮层通知：不阻塞、可点击关闭、到点自动消失，按钮能立刻恢复常态。
        notify: (message, opts) => {
            opts = opts || {};
            const dismissNoop = () => {};
            // 无文案调用 = 清空当前所有提示（供批量流程在换页/收尾时清掉上一页残留）
            if (message == null || message === '') {
                const h = document.getElementById('ai-chat-exporter-toast-host');
                if (h) { try { h.remove(); } catch (e) {} }
                return dismissNoop;
            }
            try {
                const hostId = 'ai-chat-exporter-toast-host';
                let host = document.getElementById(hostId);
                if (!host) {
                    host = document.createElement('div');
                    host.id = hostId;
                    host.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);'
                        // 层级低于脚本自身的多选面板(2147483600)，避免提示盖住面板；仍高于页面常规 UI
                        + 'z-index:2147483000;display:flex;flex-direction:column;gap:8px;align-items:center;'
                        + 'max-width:min(560px,92vw);pointer-events:none;';
                    (document.body || document.documentElement).appendChild(host);
                }
                const tone = opts.type === 'error' ? '#c0392b' : (opts.type === 'warn' ? '#a9741a' : '#2d7d46');
                const item = document.createElement('div');
                item.style.cssText = `pointer-events:auto;background:${tone};color:#fff;padding:10px 14px;`
                    + 'border-radius:8px;font-size:13px;line-height:1.5;white-space:pre-wrap;'
                    + 'box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer;max-height:50vh;overflow:auto;';
                item.title = '点击关闭';
                item.textContent = String(message == null ? '' : message);
                const dismiss = () => {
                    try {
                        item.remove();
                        if (host && !host.childElementCount) host.remove();
                    } catch (e) {}
                };
                item.addEventListener('click', dismiss);
                host.appendChild(item);
                const ms = opts.duration != null ? opts.duration : (opts.type === 'error' ? 12000 : 8000);
                if (ms > 0) setTimeout(dismiss, ms);
                return dismiss;
            } catch (e) {
                // 极端情况下退化为控制台输出，绝不再退回 alert 阻塞页面
                try { logger.info(message); } catch (e2) {}
                return dismissNoop;
            }
        },

        // 安全文件名（zip 内用）：剥掉路径分隔符/非法字符，防目录穿越
        safeAssetName: (name, fallback) => {
            let n = String(name || '')
                .replace(/[\\/]/g, '_')
                .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
                .replace(/^\.+/, '')
                .trim();
            if (!n) n = fallback || 'asset';
            if (n.length > 80) {
                const dot = n.lastIndexOf('.');
                n = (dot > 0 && n.length - dot <= 10) ? n.slice(0, 76) + n.slice(dot) : n.slice(0, 80);
            }
            return n;
        },

        // Markdown 里的说明文字：方括号会破坏 ![]() / []()  语法，统一替换掉
        mdLabel: (s) => String(s || '').replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim(),


        // ===== 让"仅存在于 DOM 的图"归位到对应消息（思路①文本指纹 + 思路②序号交叉校验）=====
        // 背景：AI 的搜索卡片图只存在于渲染结果里，会话 JSON 没有它们，因此没有消息身份。
        // 思路①：采集时记下所属消息项的文字指纹；导出时拿指纹去 MD 里找唯一匹配的消息块，插到那块末尾。
        // 思路②：若指纹匹配不到，而"渲染出的消息项数 == MD 消息数"（说明序号可比），才退而用序号。
        // 两者都不成立 → 退回文末「图片附件」区（与旧行为一致，绝不硬插）。
        normMsgText: (s) => String(s || '').replace(/[\s*_#>`\[\]()~!|]/g, ''),

        // 从 DOM 消息项取若干滑窗指纹（避开开头的时间戳/角色名等噪声）
        fingerprintsOf: (item) => {
            try {
                const raw = utils.normMsgText(item.innerText || item.textContent || '');
                const fps = [];
                for (let i = 0; i < 4; i++) {
                    const w = raw.slice(i * 20, i * 20 + 40);
                    // 最短 8 字：再短容易在多条消息里重复命中，但重复命中会被"唯一匹配"规则挡掉，所以不设更高门槛
                    if (w.length >= 8 && fps.indexOf(w) === -1) fps.push(w);
                }
                return fps;
            } catch (e) {
                return [];
            }
        },

        // 取「图片前紧邻的一段可见文字」作为行级锚点（归一化后存，供导出时定位到具体一行）。
        // 实现要点：用 Range 取 root→el 之前的文本，再走与 MD 侧完全相同的归一化。
        //   - 不用 innerText（会强制重排/回流）；Range.toString() 只读文本，代价与消息长度同阶。
        //   - 取末尾 60 字：太短会在同一条消息里重复命中，太长则可能跨越 MD 与 DOM 的排版差异。
        anchorBefore: (el, root, maxLen) => {
            try {
                if (!el || !root) return '';
                const r = document.createRange();
                r.setStart(root, 0);
                r.setEndBefore(el);
                const raw = r.toString().replace(/\s+/g, ' ').trim();
                return utils.normMsgText(raw).slice(-(maxLen || 60));
            } catch (e) {
                return '';
            }
        },

        // 在「已唯一命中的消息块」内，用行级锚点定位到具体行，返回行号（调用方插到该行之后）。
        // 依据：normMsgText 是逐字符删除空白/标记，所以 block.norm == 各行 norm 的顺序拼接，
        //       累计各行 norm 长度即可把 block.norm 里的偏移量精确映射回行号。
        // 不满足条件一律返回 -1（调用方回落到「块末尾」，即旧行为），保证不会插错位置：
        //   - 锚点为空或过短（<16 字）：太短容易在块内多处命中
        //   - 锚点在块内出现多次：无法确定是哪一处
        _anchorLine: (lines, block, anchorNorm) => {
            if (!anchorNorm || anchorNorm.length < 16) return -1;
            const pos = block.norm.indexOf(anchorNorm);
            if (pos === -1 || pos !== block.norm.lastIndexOf(anchorNorm)) return -1;
            const endPos = pos + anchorNorm.length;
            let acc = 0;
            for (let i = block.from; i < block.to; i++) {
                acc += utils.normMsgText(lines[i]).length;
                if (acc >= endPos) return i;
            }
            return -1;
        },

        // 消息标题（角色行）匹配：各平台品牌名 + 旧的统一名，均兼容
        ROLE_HEADING_RE: /^##\s+(?:用户|豆包|豆包AI|DS|纳米AI|Kimi|通义千问|讯飞星火|腾讯元宝|助手|AI助手|DeepSeek|我)\s*\(/,

        // 正文内的 Markdown 标题整体降一级（仅 2 级及更深，1 级不动）：
        // 消息标题固定为 `## 角色 (时间)`，正文若也用 ## 会被下游解析器误判为消息边界。
        // 只降不升、封顶 6 级；角色标题与文末「图片附件/未下载」区保持原级。
        demoteBodyHeadings: (md) => {
            if (!md) return md;
            const appendixRe = /^##\s+(?:图片附件|.*未下载成功的图片)\s*$/;
            return md.split('\n').map(line => {
                const m = line.match(/^(#{2,6})(\s+)(.*)$/);
                if (!m) return line;
                if (utils.ROLE_HEADING_RE.test(line) || appendixRe.test(line)) return line;
                return '#'.repeat(Math.min(6, m[1].length + 1)) + ' ' + m[3];
            }).join('\n');
        },

        // 把 MD 按消息标题切块并归一化（带缓存，避免每张图重算一遍）
        _msgBlockCache: { len: -1, head: '', tail: '', blocks: null },
        messageBlocksOf: (md) => {
            const c = utils._msgBlockCache;
            // 用「长度 + 头部片段 + 尾部片段」做键：只比长度（或只看头部）时，
            // 等长且头尾相同的两份 md 会命中过期缓存，故头尾各取 64 字
            if (c.len === md.length && c.head === md.slice(0, 64) && c.tail === md.slice(-64) && c.blocks) return c.blocks;
            const headingRe = utils.ROLE_HEADING_RE;
            const lines = md.split('\n');
            const starts = [];
            lines.forEach((ln, i) => { if (headingRe.test(ln)) starts.push(i); });
            const blocks = starts.map((from, k) => ({
                from,
                to: (k + 1 < starts.length) ? starts[k + 1] : lines.length
            }));
            // 每块一行文本 + 归一化，供指纹查找
            blocks.forEach(b => {
                b.text = lines.slice(b.from, b.to).join('\n');
                b.norm = utils.normMsgText(b.text);
            });
            c.len = md.length; c.head = md.slice(0, 64); c.tail = md.slice(-64); c.blocks = blocks;
            return blocks;
        },

        // 返回 { at, how } —— at 为插入行号（在 md.split('\n') 的坐标系里）
        // how：'anchor'（前文锚点，行级，最准）| 'text'（文本指纹，只到消息级）| 'order'（渲染序号）
        locateMessageForImage: (md, fingerprints, domMessageIndex, domItemCount, anchorNorm) => {
            const lines = md.split('\n');
            const blocks = utils.messageBlocksOf(md);
            if (!blocks.length) return null;

            // 思路①：指纹唯一命中（先定到"哪条消息"）
            let matched = -1;
            if (fingerprints && fingerprints.length) {
                const hit = new Set();
                for (const fp of fingerprints) {
                    blocks.forEach((b, k) => { if (b.norm.indexOf(fp) !== -1) hit.add(k); });
                }
                if (hit.size === 1) matched = [...hit][0];
            }
            if (matched >= 0) {
                const block = blocks[matched];
                // 思路③（新增）：消息已唯一确定，再用"图片前文锚点"精确到行；命中就插到锚点行之后
                const li = utils._anchorLine(lines, block, anchorNorm);
                if (li >= 0) return { at: li + 1, how: 'anchor' };
                // 锚点缺失/命中不到 → 退回旧行为：插到该消息块末尾
                return { at: utils._insertPos(lines, block), how: 'text' };
            }

            // 思路②：序号可比才用（渲染出的消息项数 == MD 消息数）
            if (domMessageIndex !== null && domMessageIndex !== undefined &&
                domItemCount && blocks.length === domItemCount) {
                const k = Math.min(domMessageIndex, blocks.length - 1);
                return { at: utils._insertPos(lines, blocks[k]), how: 'order' };
            }
            return null;
        },

        // 插到某块末尾（跨过末尾的空行与分隔线）
        _insertPos: (lines, block) => {
            let at = block.to;
            for (let i = block.to - 1; i >= block.from; i--) {
                const t = lines[i].trim();
                if (t === '' || t === '---') at = i; else break;
            }
            return at;
        },

        // 收集图片到 state.imageStore（按会话隔离，去重）
        // img.source：'json'（会话 JSON 提取，可拿到原图字段）| 'dom'（页面渲染扫描，多为缩略/预览图）
        collectImages: (platform, convKey, images) => {
            if (state.imageStore.key !== convKey) {
                state.imageStore.key = convKey;
                state.imageStore.map = new Map();
                // 换会话：400 张上限的告警标志重置，否则整段脚本生命周期只提示一次
                utils._capWarned = false;
            }
            images.forEach((img) => {
                if (!img || !img.url) return;
                const key = utils.imageKeyOf(img.url);
                if (!key) return;
                const existing = state.imageStore.map.get(key);
                if (existing) {
                    // 已收集过同一张图：若旧记录来自 DOM（渲染用的缩略/预览 URL），
                    // 而这次是会话 JSON 给的原图，则替换 URL —— 文件名不变，正文引用不受影响。
                    if (existing.source === 'dom' && img.source && img.source !== 'dom') {
                        existing.url = img.url;
                        existing.source = img.source;
                    }
                    // 归位信息补全：DOM 图首次采集时消息可能还在流式渲染（锚点/指纹取不到），
                    // 若旧记录为空而本次拿到了，补上——避免锚点被永久"冻结"在空值上。
                    if (!existing.anchorNorm && img.anchorNorm) existing.anchorNorm = img.anchorNorm;
                    if ((!existing.msgFingerprints || !existing.msgFingerprints.length)
                        && img.msgFingerprints && img.msgFingerprints.length) {
                        existing.msgFingerprints = img.msgFingerprints;
                    }
                    if ((existing.domMessageIndex === null || existing.domMessageIndex === undefined)
                        && img.domMessageIndex !== null && img.domMessageIndex !== undefined) {
                        existing.domMessageIndex = img.domMessageIndex;
                    }
                    if (!existing.domItemCount && img.domItemCount) existing.domItemCount = img.domItemCount;
                    return;
                }
                // 安全上限：常驻 DOM 累积 + 长会话可能收到极多图，避免把导出拖死
                if (state.imageStore.map.size >= 400) {
                    if (!utils._capWarned) { utils._capWarned = true; logger.warn('图片已达 400 张上限，后续图片不再收集'); }
                    return;
                }
                const ext = utils.getExtFromUrl(img.url);
                const count = state.imageStore.map.size + 1;
                const filename = `image_${String(count).padStart(3, '0')}.${ext}`; // 统一顺序编号，不用img自带的name
                state.imageStore.map.set(key, {
                    key,
                    url: img.url,
                    description: utils.mdLabel(img.description || ''),
                    filename,
                    platform,
                    source: img.source || 'json',
                    // DOM 通道抓到的图带归属信息（供未被正文引用时归位）
                    domMessageIndex: (img.domMessageIndex === undefined ? null : img.domMessageIndex),
                    domItemCount: img.domItemCount || 0,
                    msgFingerprints: img.msgFingerprints || [],
                    // 行级锚点：图片前紧邻文字的归一化片段（仅 DOM 通道图有）
                    anchorNorm: img.anchorNorm || ''
                });
            });
        },

        // 获取图片的最终文件名（统一命名）。已收集则直接返回，未收集则加入并分配编号。
        // 返回：{ filename, description }
        // source 缺省视为 'json'（调用方是消息转换阶段，URL 来自会话 JSON）
        getImageFileName: (platform, convKey, url, description, source) => {
            if (!url) return null;
            // 确保会话正确
            if (state.imageStore.key !== convKey) {
                state.imageStore.key = convKey;
                state.imageStore.map = new Map();
            }
            const key = utils.imageKeyOf(url);
            const existing = state.imageStore.map.get(key);
            if (existing) {
                // 会话 JSON 的原图 URL 优于先前 DOM 抓到的渲染 URL：替换之
                if (existing.source === 'dom' && source && source !== 'dom' && existing.url !== url) {
                    existing.url = url;
                    existing.source = source;
                }
                return { filename: existing.filename, description: existing.description || description || '' };
            }
            // 新图片，分配编号
            const ext = utils.getExtFromUrl(url);
            const count = state.imageStore.map.size + 1;
            const filename = `image_${String(count).padStart(3, '0')}.${ext}`;
            state.imageStore.map.set(key, {
                key,
                url,
                description: utils.mdLabel(description || ''),
                filename,
                platform,
                source: source || 'json'
            });
            return { filename, description: description || '' };
        },

        // 根据响应 Content-Type 推断扩展名（比单纯从 URL 路径猜更准）
        extFromContentType: (ct) => {
            if (!ct) return '';
            const map = {
                'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
                'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
                'image/x-icon': 'ico', 'image/avif': 'avif'
            };
            const key = String(ct).split(';')[0].trim().toLowerCase();
            return map[key] || '';
        },

        // 判断下载结果是否真的是图片。防止服务端返回 HTML/错误页却带 200 被当成图片落盘
        // （DeepSeek 旧的同源 /api/file 端点就返回 SPA HTML，静默存成了 .png）。
        // 依据常见图片格式魔数；SVG 等文本型由 Content-Type 放行，不在此判定。
        isImageBytes: (b) => {
            try {
                if (!b || b.length < 4) return false;
                if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return true; // PNG
                if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return true;                   // JPEG
                if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true;                   // GIF
                if (b[0] === 0x42 && b[1] === 0x4D) return true;                                    // BMP
                if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
                    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return true; // WEBP
                if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return true; // AVIF/HEIF
                return false;
            } catch (e) {
                return false;
            }
        },

        // 取出某张图所属的「消息项」DOM 元素。
        // 目的有两个：① 给 DOM 通道抓到的图标位置；② **判断这张图是不是消息内容**——
        // 豆包的 UI 资源（logo 遮罩、功能图标、多彩头像）也在 byteimg 上、也 ≥50px，
        // 只有"挂在消息项里"这一条能把它们排除掉（实机曾因此多收 18 张无关图）。
        // 判定：从图片往上爬，class 命中 message/chat-item/msg-item/answer/question/bubble 的最外层祖先；
        // 若只碰到容器的直接子元素，则认它为消息项（虚拟列表通常一条消息一个顶层项）。都不满足就返回 null。
        getMessageItemOf: (el, root) => {
            try {
                let node = el;
                let guard = 0;
                let outerMatch = null;
                while (node && node !== root && node.parentElement && guard++ < 40) {
                    const cls = (typeof node.className === 'string') ? node.className : '';
                    if (/message|chat-item|msg-item|chat-bubble|chat-message|bubble|markdown|answer|question/i.test(cls)) {
                        outerMatch = node; // 越往上越外层，最终保留最外层命中者
                    }
                    if (node.parentElement === root && !outerMatch) outerMatch = node;
                    node = node.parentElement;
                }
                return outerMatch;
            } catch (e) {
                return null;
            }
        },

        // 找对话消息容器（结果带缓存）
        // 性能要点：旧实现每次扫描都对一批候选元素读 scrollHeight（强制重排），
        // 而常驻 watcher 会周期性调用 —— 那会让整个页面发卡、导出显得"变慢"。
        // 这里改为：只挑「内部真的含目标图片」的候选，按含图数量选最大者，零布局读取；结果缓存 20s。
        _chatContainerCache: { el: null, exp: 0, host: '' },
        getChatContainer: (hostKeyword) => {
            const c = utils._chatContainerCache;
            const now = Date.now();
            if (c.el && c.host === hostKeyword && c.exp > now && c.el.isConnected) return c.el;
            const containerSelectors = [
                '[class*="v_list_scroller"]', '[class*="v_list"]',   // 豆包/字节系虚拟列表（外部实现即用 v_list_scroller-*）
                '[class*="chat-list"]', '[class*="ChatList"]',
                '[class*="message-list"]', '[class*="MessageList"]',
                '[class*="conversation-list"]', '[class*="ConversationList"]',
                '[class*="messages"]', '[class*="Messages"]',
                '[class*="message-container"]', '[class*="MessageContainer"]',
                '[class*="chat-content"]', '[class*="ChatContent"]',
                '[class*="message-wrapper"]', '[class*="scroller"]', '[data-role]'
            ];
            let best = null;
            let bestCount = 0;
            const countSelector = String(hostKeyword || '').split(',').map(s => s.trim()).filter(Boolean)
                                    .map(p => `img[src*="${p}"]`).join(', ');
            if (!countSelector) return null;
            for (const sel of containerSelectors) {
                let els;
                try { els = document.querySelectorAll(sel); } catch (e) { continue; }
                for (const el of els) {
                    let n = 0;
                    try { n = el.querySelectorAll(countSelector).length; } catch (e) { n = 0; }
                    if (n > bestCount) { bestCount = n; best = el; }
                }
            }
            c.el = best; c.host = hostKeyword; c.exp = now + 20000;
            return best;
        },

        // 从当前页面 DOM 扫描图片 URL。
        // 用途：① JSON 收集可能漏掉虚拟滚动未渲染的图片；② DeepSeek 的签名 state 只在渲染后的 <img src> 里
        // 硬约束（实机教训：曾一次多收 18 张豆包 UI 图标/头像）：
        //   ① hostKeyword 支持逗号分隔的多模式（豆包＝byteimg.com,tos-cn-：内容桶标记）；
        //   ② **找不到聊天容器就不扫**（绝不退回全页面扫描）；
        //   ③ **必须能定位到消息项**才收（图标/头像/工具栏不在消息里）；
        //   ④ URL 里带 /obj/、logo、icon、avatar 的一律跳过（前端资源目录）。
        collectDomImages: (platform, convKey, hostKeyword) => {
            const found = [];
            try {
                const patterns = String(hostKeyword || '').split(',').map(s => s.trim()).filter(Boolean);
                if (!patterns.length) return 0;

                // 1. 先找对话消息列表容器（只在这个容器里找图）
                const chatContainer = utils.getChatContainer(hostKeyword);
                if (!chatContainer) {
                    if (!utils._noContainerWarned) {
                        utils._noContainerWarned = true;
                        logger.warn('未找到聊天消息容器，DOM 通道本次跳过（避免把页面 UI 图标当成对话图片收进来）');
                    }
                    return 0;
                }

                // 2. 在容器内找图
                const root = chatContainer;
                const selector = patterns.map(p => `img[src*="${p}"]`).join(', ');
                const imgs = root.querySelectorAll(selector);
                const items = [];
                const containers = [];
                let skippedUi = 0;
                let skippedNoItem = 0;
                imgs.forEach((el) => {
                    const src = el.getAttribute('src') || el.src;
                    if (!src) return;
                    // src 必须命中任一模式（多模式 selector 的并集校验）
                    if (!patterns.some(p => src.indexOf(p) !== -1)) return;

                    // ④ 前端资源目录/命名：一律跳过（豆包 UI 图标、logo、头像都在这里）
                    if (/\/obj\/|logo|icon|avatar/i.test(src)) { skippedUi++; return; }
                    // ④b alt 明确是头像/角色名的也跳过（少数头像会渲染在消息项内部）
                    const altText = el.getAttribute('alt') || '';
                    if (/头像|avatar|doubao|豆包|用户|assistant/i.test(altText) && (el.naturalWidth || 0) <= 512) { skippedUi++; return; }

                    // 额外过滤：排除头像、图标类小图
                    const w = el.naturalWidth || el.width || 0;
                    const h = el.naturalHeight || el.height || 0;
                    if (w > 0 && w < 50 && h > 0 && h < 50) { skippedUi++; return; } // 小于 50x50 的大概率是图标/头像

                    // 排除在头像容器里的图
                    let parent = el.parentElement;
                    let isAvatar = false;
                    for (let d = 0; d < 5 && parent; d++) {
                        const cls = parent.className || '';
                        if (typeof cls === 'string' && /avatar|Avatar|头像|head|Head|icon|Icon/.test(cls)) {
                            isAvatar = true;
                            break;
                        }
                        parent = parent.parentElement;
                    }
                    if (isAvatar) { skippedUi++; return; }

                    // ③ 必须挂在消息项里才算"对话里的图"
                    const item = utils.getMessageItemOf(el, root);
                    if (!item) { skippedNoItem++; return; }

                    if (containers.indexOf(item) === -1) containers.push(item);
                    items.push({ el, src, item });
                });
                if (skippedUi || skippedNoItem) {
                    logger.info(`DOM 通道过滤：UI 资源 ${skippedUi} 张、不在消息项内 ${skippedNoItem} 张`);
                }

                // 消息项按文档顺序排序 → 得到「第几条消息」的归属序号
                try {
                    containers.sort((a, b) => (a.compareDocumentPosition(b) & 4) ? -1 : 1);
                } catch (e) {}

                items.forEach(({ el, src, item }) => {
                    // 性能：本扫描会被 MutationObserver/定时/滚动反复触发。指纹(innerText，强制重排)与锚点
                    // 只在"该图归位信息还不完整"时才需要重算 —— 已入库且锚点/指纹齐全的图直接跳过，
                    // 避免对同一张图每轮重算；但若旧记录缺锚点/指纹（首次采集时消息尚未渲染完），
                    // 这里会补算并由 collectImages 回填，不会永久停留在空值上。
                    const existing = (state.imageStore.key === convKey)
                        ? state.imageStore.map.get(utils.imageKeyOf(src)) : null;
                    const needEnrich = !existing
                        || !existing.anchorNorm
                        || !(existing.msgFingerprints && existing.msgFingerprints.length);
                    const ext = utils.getExtFromUrl(src);
                    const filename = (el.alt && el.alt.trim())
                        ? el.alt.trim()
                        : `${platform}_image_${found.length + 1}.${ext}`;
                    found.push({
                        url: src,
                        description: utils.mdLabel(el.alt || ''),
                        filename,
                        source: 'dom',
                        // 思路①：把所属消息项的文字指纹一起记下来（导出时用它把图插回对应消息）
                        msgFingerprints: (needEnrich && item) ? utils.fingerprintsOf(item) : [],
                        // 思路②：只有存在 ≥2 个不同消息项时序号才有区分意义，否则不标
                        domMessageIndex: (item && containers.length >= 2) ? containers.indexOf(item) : null,
                        // 思路②的交叉校验：本次渲染出的消息项数量（与 MD 消息数一致时才敢用序号）
                        domItemCount: containers.length,
                        // 思路③：图片前紧邻文字的归一化锚点 —— 用于把图还原到消息内的具体一行
                        anchorNorm: (needEnrich && item) ? utils.anchorBefore(el, item) : ''
                    });
                });
            } catch (e) {
                logger.warn(`扫描 ${platform} DOM 图片失败`, e);
            }
            if (found.length) utils.collectImages(platform, convKey, found);
            return found.length;
        },

        // ===== 常驻 DOM 图片累积（修「AI 回复里的图不全」）=====
        // 背景：搜索结果卡片图、AI 生成图等大量图片只存在于页面渲染结果里（会话 JSON 拿不到），
        // 而消息列表是虚拟滚动的 —— 只在"点导出"那一刻扫一次 DOM，只能拿到当前渲染出来的极少数图
        //（实机：AI 回复里明明有多张卡片图，只导出到 1 张）。
        // 因此改为：浏览 / 自动滚动 / 列表变动的过程中反复扫描并累积进 imageStore（按归一化键去重）。
        // 配合脚本自带的「加载全部」按钮滚一遍，所有消息都渲染过 → 图片才收得全。
        domWatcher: { observer: null, timer: null, onScroll: null, pending: null, platform: '', convKey: '', started: false },

        startDomImageWatcher: (platform, convKey, hostKeyword) => {
            const w = utils.domWatcher;
            if (w.started && w.convKey === convKey && w.platform === platform) return;
            utils.stopDomImageWatcher();
            w.started = true;
            w.platform = platform;
            w.convKey = convKey;

            const scan = () => {
                // 会话已切换则不再往旧会话里塞图
                if (state.imageStore.key && state.imageStore.key !== convKey) return;
                try { utils.collectDomImages(platform, convKey, hostKeyword); } catch (e) {}
            };
            const schedule = (delay) => {
                if (w.pending) return;
                w.pending = setTimeout(() => { w.pending = null; scan(); }, delay);
            };

            try {
                w.observer = new MutationObserver(() => schedule(1200));
                w.observer.observe(document.body, { childList: true, subtree: true });
            } catch (e) { w.observer = null; }

            // 懒加载 <img> 完成、canvas→img 替换等不一定触发 childList，用定时兜底（低频，避免拖慢页面）
            w.timer = setInterval(scan, 5000);

            w.onScroll = () => schedule(500);
            window.addEventListener('scroll', w.onScroll, true);

            scan();
        },

        stopDomImageWatcher: () => {
            const w = utils.domWatcher;
            if (w.observer) { try { w.observer.disconnect(); } catch (e) {} w.observer = null; }
            if (w.timer) { clearInterval(w.timer); w.timer = null; }
            if (w.pending) { clearTimeout(w.pending); w.pending = null; }
            if (w.onScroll) { window.removeEventListener('scroll', w.onScroll, true); w.onScroll = null; }
            w.started = false;
            w.convKey = '';
        },

        // DeepSeek 文件/图片的真实下载地址。
        // 会话 JSON 只给「signed_path=/file?file_id=..&state=..」，需要补齐两处才可用：
        //   ① 域名必须是文件服务 files.deepseeksvc.com（拼成同源 chat.deepseek.com/api/file 会命中
        //      SPA 兜底/风控，实测返回 429 + text/html，被当图片存成 .png 就是这个原因）；
        //   ② 必填查询参数 ty（实测缺省报 "missing field `ty`"，取值 p=大图 / t=缩略 / r=原始）。
        // 该服务对 chat.deepseek.com 回 access-control-allow-origin，跨域 fetch 可用。
        DEEPSEEK_FILE_HOST: 'https://files.deepseeksvc.com/api',
        deepseekFileUrl: (signedPath, kind) => {
            if (!signedPath) return '';
            const p = String(signedPath);
            const ty = kind || 'p';
            if (/[?&]ty=/.test(p)) return utils.DEEPSEEK_FILE_HOST + p;
            return utils.DEEPSEEK_FILE_HOST + p + (p.indexOf('?') === -1 ? '?' : '&') + 'ty=' + ty;
        },

        // 从 DeepSeek 会话 JSON 抽取图片（FILE 片段含 signed_path，直取文件服务，无跨域 CORS 问题）
        collectDeepseekImagesFromJson: (convKey, jsonData) => {
            if (!jsonData) return 0;
            const bizData = jsonData?.data?.biz_data || {};
            const chatMessages = bizData.chat_messages || [];
            const found = [];
            chatMessages.forEach(msg => {
                const fragments = msg.fragments || [];
                const desc = (fragments.find(f => f.type === 'REQUEST')?.content || msg.content || '')
                    .toString().slice(0, 40).trim();
                fragments.forEach(fr => {
                    if (fr.type !== 'FILE' || !Array.isArray(fr.files)) return;
                    fr.files.forEach(file => {
                        if (!file.is_image || !file.signed_path) return;
                        const url = utils.deepseekFileUrl(file.signed_path, 'p');
                        found.push({
                            url,
                            description: file.file_name || desc || 'deepseek_image',
                            filename: file.file_name || `${file.id || 'img'}.webp`
                        });
                    });
                });
            });
            if (found.length) utils.collectImages('deepseek', convKey, found);
            return found.length;
        },

        // 纯 JS 生成 ZIP（STORE 不压缩，零依赖 —— 规避 jsdelivr/JSZip 在油猴沙箱下 generateAsync 挂起导致“卡死在打包”）
        // files: [{ name: string, data: Uint8Array, isDir?: boolean }]
        makeStoreZip: (files) => {
            const crcTable = (() => {
                const t = new Uint32Array(256);
                for (let n = 0; n < 256; n++) {
                    let c = n;
                    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                    t[n] = c >>> 0;
                }
                return t;
            })();
            const crc32 = (b) => {
                let crc = 0xFFFFFFFF;
                for (let i = 0; i < b.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ b[i]) & 0xFF];
                return (crc ^ 0xFFFFFFFF) >>> 0;
            };
            const enc = new TextEncoder();
            const UTF8_FLAG = 0x0800;
            const locals = [];
            const centrals = [];
            let offset = 0;
            for (const f of files) {
                const nameBytes = enc.encode(f.name);
                const data = f.data || new Uint8Array(0);
                const crc = crc32(data);
                const lh = new DataView(new ArrayBuffer(30));
                lh.setUint32(0, 0x04034b50, true);
                lh.setUint16(4, 20, true);
                lh.setUint16(6, UTF8_FLAG, true);
                lh.setUint16(8, 0, true);
                lh.setUint16(10, 0, true);
                lh.setUint16(12, 0, true);
                lh.setUint32(14, crc, true);
                lh.setUint32(18, data.length, true);
                lh.setUint32(22, data.length, true);
                lh.setUint16(26, nameBytes.length, true);
                lh.setUint16(28, 0, true);
                locals.push(new Uint8Array(lh.buffer), nameBytes, data);
                const cd = new DataView(new ArrayBuffer(46));
                cd.setUint32(0, 0x02014b50, true);
                cd.setUint16(4, 20, true);
                cd.setUint16(6, 20, true);
                cd.setUint16(8, UTF8_FLAG, true);
                cd.setUint16(10, 0, true);
                cd.setUint16(12, 0, true);
                cd.setUint16(14, 0, true);
                cd.setUint32(16, crc, true);
                cd.setUint32(20, data.length, true);
                cd.setUint32(24, data.length, true);
                cd.setUint16(28, nameBytes.length, true);
                cd.setUint16(30, 0, true);
                cd.setUint16(32, 0, true);
                cd.setUint16(34, 0, true);
                cd.setUint16(36, 0, true);
                cd.setUint32(38, f.isDir ? 0x10 : 0, true);
                cd.setUint32(42, offset, true);
                centrals.push(new Uint8Array(cd.buffer), nameBytes);
                offset += 30 + nameBytes.length + data.length;
            }
            let cdSize = 0;
            for (const c of centrals) cdSize += c.length;
            const eocd = new DataView(new ArrayBuffer(22));
            eocd.setUint32(0, 0x06054b50, true);
            eocd.setUint16(4, 0, true);
            eocd.setUint16(6, 0, true);
            eocd.setUint16(8, files.length, true);
            eocd.setUint16(10, files.length, true);
            eocd.setUint32(12, cdSize, true);
            eocd.setUint32(16, offset, true);
            eocd.setUint16(20, 0, true);
            return new Blob([...locals, ...centrals, new Uint8Array(eocd.buffer)], { type: 'application/zip' });
        },

        // ===== 导出前全量渲染 =====
        // 为什么需要：会话是虚拟列表，**只挂载视口附近的消息**。实机取证（_diagnostics.json）：
        // 整段对话在页面 DOM 里只剩 1 张内容图，其余 34 张全是页面级 UI 资源——
        // 所以"直接扫 DOM"永远只能拿到当前屏幕上那几张。
        // 做法：从列表顶部到底部分步滚动一遍，让每条消息至少渲染一次；
        // 常驻 watcher 会顺手把这些图累积进图库（不依赖最后一次扫描）。
        // 代价：与对话长度成正比（每步 250ms，最多 60 步 ≈ 15s，实测短对话约 2–4s）。
        renderAllMessages: async (onProgress) => {
            try {
                let scroller = autoScroller.findScrollContainer();
                if (!scroller) return false;
                const view = scroller.clientHeight || 600;
                const step = Math.max(240, Math.floor(view * 0.8));
                const MAX_STEPS = 60;

                // 1) 先回顶：既渲染最早的消息，也触发平台去加载更早的历史页
                scroller.scrollTop = 0;
                await autoScroller.sleep(500);

                // 2) 自上而下分步走
                let i = 0;
                for (; i < MAX_STEPS; i++) {
                    if (!scroller.isConnected) {
                        scroller = autoScroller.findScrollContainer();
                        if (!scroller) break;
                    }
                    const maxTop = Math.max(0, scroller.scrollHeight - view);
                    const top = Math.min(maxTop, i * step);
                    scroller.scrollTop = top;
                    if (onProgress) onProgress(top, maxTop);
                    if (top >= maxTop) break;
                    await autoScroller.sleep(250);
                }

                // 3) 收尾：滚到底并等最后一屏渲染，再补扫一次
                scroller.scrollTop = scroller.scrollHeight;
                await autoScroller.sleep(400);
                return true;
            } catch (e) {
                logger.warn('全量渲染过程出错（不阻断导出）', e);
                return false;
            }
        },

        // ===== 图片取证（诊断用，不影响正常导出）=====
        // 用途：把"页面上到底有哪些图、各自在什么容器里、我们各通道收到了什么"一次性 dump 成 JSON。
        // 动机：实机连续两轮卡在"缺图但看不到缺口"——与其继续猜，不如让证据说话。
        // 现状：**本函数只被定义，默认不再调用**——调用点（mdWithImages 内）已由
        //       ENABLE_DIAGNOSTICS 开关关闭，故 zip 里不再生成 _diagnostics.json。
        //       需要排查缺图时，把那个开关改回 true 即可恢复。
        buildImageDiagnostics: () => {
            const pw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            const out = {
                ts: new Date().toISOString(),
                href: location.href,
                platform: state.platformType,
                store: {
                    images: [...state.imageStore.map.values()].map(i => ({
                        url: String(i.url).slice(0, 300), filename: i.filename, source: i.source,
                        domMessageIndex: i.domMessageIndex, description: i.description,
                        anchorNorm: i.anchorNorm || ''
                    })),
                    files: [...state.fileStore.map.values()].map(f => ({
                        url: String(f.url).slice(0, 300), filename: f.filename, name: f.name
                    }))
                },
                dom: { imgs: [], canvases: [] },
                extractor: [],
                routerData: { creationUrls: [], note: '' },
                // DeepSeek 会话相关请求 URL（批量列表定位用；其他平台为空）
                netLog: state.netLog.slice()
            };
            try {
                const patterns = state.platformType === 'doubao' ? ['byteimg.com', 'tos-cn-']
                               : (state.platformType === 'deepseek' ? ['files.deepseeksvc.com'] : []);
                const container = patterns.length ? utils.getChatContainer(patterns.join(',')) : null;
                const root = container || document;
                out.dom.containerFound = !!container;
                [...document.querySelectorAll('img')].slice(0, 300).forEach(el => {
                    const src = el.getAttribute('src') || el.src || '';
                    let host = '';
                    try { host = new URL(src, location.href).host; } catch (e) {}
                    out.dom.imgs.push({
                        src: src.slice(0, 300),
                        alt: String(el.alt || '').slice(0, 60),
                        w: el.naturalWidth || el.width || 0,
                        h: el.naturalHeight || el.height || 0,
                        inContainer: !!(container && container.contains(el)),
                        inMessageItem: !!utils.getMessageItemOf(el, root),
                        matchesPattern: patterns.some(p => src.indexOf(p) !== -1),
                        host
                    });
                });
                [...document.querySelectorAll('canvas')].forEach(c => {
                    out.dom.canvases.push({
                        w: c.width || 0, h: c.height || 0,
                        inContainer: !!(container && container.contains(c)),
                        inMessageItem: !!utils.getMessageItemOf(c, root)
                    });
                });
                const msgs = state.lastJsonData?.downlink_body?.pull_singe_chain_downlink_body?.messages || [];
                msgs.forEach((m, i) => {
                    let imgs = [];
                    try { imgs = platformConverters._extractDoubaoImages(m).map(r => String(r.url).slice(0, 300)); } catch (e) {}
                    out.extractor.push({
                        i,
                        role: m.user_type === 1 ? 'user' : 'ai',
                        blocks: (m.content_block || []).map(b => b.block_type),
                        hasExt: !!m.ext,
                        contentIsJsonString: typeof m.content === 'string' && /^[\[{]/.test(m.content.trim()),
                        images: imgs
                    });
                });
                try {
                    const rd = pw && pw._ROUTER_DATA;
                    if (rd) {
                        out.routerData.creationUrls = platformConverters._extractDoubaoImages(rd).map(r => String(r.url).slice(0, 300)).slice(0, 100);
                        out.routerData.note = '来自页面 _ROUTER_DATA（需 unsafeWindow 授权）';
                    } else {
                        out.routerData.note = '_ROUTER_DATA 不存在（该页无 SSR 数据）';
                    }
                } catch (e) {
                    out.routerData.note = '读取失败: ' + ((e && e.message) || e);
                }
            } catch (e) {
                out.error = String((e && e.message) || e);
            }
            // 摘要：写进导出完成提示，不开文件也能看到关键数字
            try {
                const inItem = out.dom.imgs.filter(i => i.inMessageItem).length;
                const matched = out.dom.imgs.filter(i => i.matchesPattern).length;
                // 口径统一：直接数图库里来源为 JSON 的图，各平台通用。
                // 旧实现只统计豆包 extractor（读 downlink_body.pull_singe_chain_...messages），
                // DeepSeek 等平台恒为 0 —— 图库明明有 JSON 图，摘要却写「会话 JSON 提取 0 张」。
                const jsonImgs = out.store.images.filter(i => i.source === 'json').length;
                const bigCanvas = out.dom.canvases.filter(c => c.w >= 100 && c.h >= 100).length;
                out.summary = `页面 <img> ${out.dom.imgs.length} 张（命中匹配模式(入口) ${matched}、在消息项内 ${inItem}）`
                            + `｜canvas ${out.dom.canvases.length} 个（≥100px ${bigCanvas}）`
                            + `｜会话 JSON 提取(入口) ${jsonImgs} 张｜图库(落盘) ${out.store.images.length} 张`
                            + (out.store.images.length === 0 ? '｜本会话无图' : '');
            } catch (e) {
                out.summary = '';
            }
            return out;
        },

        // 下载所有图片/附件并打包成 zip（内含 md 文件 + images/ 与 files/ 目录）
        exportMdWithImages: async (mdContent, baseName, extraFiles, diagSummary, withJson, pulledRecently) => {
            // 正文内的 #/##… 标题统一降一级：避免与消息标题（## 角色 (时间)）同级，被下游解析器误判为消息边界
            mdContent = utils.demoteBodyHeadings(mdContent);
            const images = [...state.imageStore.map.values()];
            const attachs = [...state.fileStore.map.values()];
            if (images.length === 0 && attachs.length === 0 && !(extraFiles && extraFiles.length)) {
                // 既没有图片也没有附件，直接导出 md
                return utils.createBlobDownload(mdContent, 'text/markdown', `${baseName}.md`);
            }

            // 更新按钮显示进度
            const updateBtn = (text) => {
                const btn = document.getElementById('downloadMdImagesButton');
                if (btn) btn.innerHTML = text;
            };

            try {
                let newMd = mdContent;
                const notReferenced = [];
                const failed = [];
                let successCount = 0;
                let failCount = 0;
                const total = images.length;
                const domCount = images.filter(it => it.source === 'dom').length;
                const t0 = Date.now();
                let bytesTotal = 0;
                logger.info(`待下载图片 ${total} 张（会话 JSON ${total - domCount} 张 / DOM 渲染 ${domCount} 张）、附件 ${attachs.length} 个`);

                // ===== 阶段一：并发下载（最多 3 张并行）=====
                // 之前是纯串行：N 张图 = N 次往返，几十张时明显慢（用户实机反馈"下载变慢"）。
                // 这里只把「网络等待」并行化；MD 改写仍按原顺序在阶段二串行做，既有语义不变。
                const CONCURRENCY = 3;
                let cursor = 0;
                let done = 0;
                const fetchOne = async (img, idx) => {
                    // 关键修复①：不携带 credentials —— 跨域图床（如 byteimg）返回 Access-Control-Allow-Origin:*，
                    // 一旦带 credentials 浏览器会因「通配符+凭据」组合直接拒绝响应；同源（DeepSeek /api）不受影响。
                    // 关键修复②：AbortController 超时，防止图床不响应导致永久挂起（表现为“卡死在打包”）。
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), 20000);
                    let resp;
                    try {
                        resp = await fetch(img.url, { mode: 'cors', signal: controller.signal });
                    } finally {
                        clearTimeout(timer);
                    }
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    const blob = await resp.blob();
                    img._blob = blob; // 备用：ZIP 失败降级逐文件下载
                    img._bytes = new Uint8Array(await blob.arrayBuffer()); // 供纯 JS ZIP 打包
                    // 用响应 Content-Type 修正扩展名（比 URL 路径推断更准）
                    const ctExt = utils.extFromContentType(resp.headers.get('content-type'));
                    // 响应不是图片（如服务的 SPA HTML/错误页却带 200）→ 判失败。
                    // 否则会把 HTML 当 .png 落盘、并在正文里留下"看起来正常"的死链（DeepSeek 旧端点即如此）。
                    if (!ctExt && !utils.isImageBytes(img._bytes)) {
                        throw new Error('响应不是图片（Content-Type=' + (resp.headers.get('content-type') || '未知') + '）');
                    }
                    let finalName = img.filename || `image_${String(idx + 1).padStart(3, '0')}.png`;
                    if (ctExt) finalName = finalName.replace(/\.[^.]+$/, '.' + ctExt);
                    img._ext = ctExt || 'png';
                    img._finalName = finalName;
                };
                const downloadWorker = async () => {
                    while (cursor < total) {
                        const idx = cursor++;
                        const img = images[idx];
                        try {
                            await fetchOne(img, idx);
                            img._ok = true;
                        } catch (e) {
                            img._ok = false;
                            img._err = (e && e.message) ? e.message : String(e);
                            img._errObj = e;
                        }
                        done++;
                        updateBtn(`🖼️ 下载图片 ${done}/${total}`);
                    }
                };
                await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, () => downloadWorker()));

                // ===== 阶段一补：失败图同轮重试（最多 2 轮）=====
                // 用同一轮的「新鲜签名 URL」直接重试；跨轮的旧 URL 多已过期（403），故不做跨会话补下。
                for (let attempt = 1; attempt <= 2; attempt++) {
                    const retryList = images.filter(im => im._ok === false);
                    if (!retryList.length) break;
                    logger.info(`图片下载失败重试（第 ${attempt} 轮）：${retryList.length} 张`);
                    const rc = { v: 0 };
                    const retryWorker = async () => {
                        while (rc.v < retryList.length) {
                            const img = retryList[rc.v++];
                            try {
                                await fetchOne(img, images.indexOf(img));
                                img._ok = true;
                                logger.info(`重试成功: ${img.filename}`);
                            } catch (e) {
                                img._ok = false;
                                img._err = (e && e.message) ? e.message : String(e);
                                img._errObj = e;
                            }
                        }
                    };
                    await Promise.all(Array.from({ length: Math.min(2, retryList.length) }, () => retryWorker()));
                }

                // ===== 阶段二：串行整理 MD（顺序敏感，保持原逻辑）=====
                // DOM 图归位改为「先定位、后批量插入」：本循环内只做 URL/文件名替换（不改变行数），
                // 所有 DOM 图都基于同一份未插入的 MD 定位；最后按行号统一 splice。
                // 好处：① 行号不会随逐张插入而漂移；② 同一锚点下的多张图按原始顺序排开，不会逆序。
                const pendingInserts = [];
                for (let i = 0; i < total; i++) {
                    const img = images[i];
                    if (!img._ok) {
                        logger.warn(`图片下载失败: ${img.filename}`, img._errObj);
                        failCount++;
                        failed.push({ url: img.url, filename: img.filename, error: img._err || '未知错误' });
                        // 失败不能静默消失：文件不进 zip，正文里的相对路径就成了死链 ——
                        // 把相对路径换回原始 URL（签名可能仍有效），并在文末列失败清单方便补取。
                        if (img.filename) {
                            const escapedFailName = img.filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            newMd = newMd.replace(new RegExp(`images/${escapedFailName}`, 'g'), img.url);
                        }
                        continue;
                    }
                    bytesTotal += img._bytes ? img._bytes.length : 0;
                    const finalName = img._finalName;
                    // 全平台通用：将 MD 中的原始 URL 替换为相对路径
                    const escapedUrl = img.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    if (newMd.includes(img.url)) {
                        newMd = newMd.replace(new RegExp(escapedUrl, 'g'), `images/${finalName}`);
                    } else if (img.filename && newMd.includes(`images/${img.filename}`)) {
                        // 已在消息转换阶段内联插入（如豆包用户图/AI图），此时只更新文件名到 Content-Type 修正后的最终名
                        const escapedOldName = img.filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        newMd = newMd.replace(new RegExp(`images/${escapedOldName}`, 'g'), `images/${finalName}`);
                    } else {
                        // 仅存在于 DOM 的图（AI 卡片图等）：先记录定位结果，循环结束后统一插入；定位失败才进附件区
                        let placed = false;
                        try {
                            const loc = utils.locateMessageForImage(newMd, img.msgFingerprints, img.domMessageIndex, img.domItemCount, img.anchorNorm);
                            if (loc) {
                                pendingInserts.push({ at: loc.at, how: loc.how, seq: i, name: finalName, desc: img.description });
                                placed = true;
                            }
                        } catch (e) { /* 归位失败不算导出失败 */ }
                        if (!placed) {
                            notReferenced.push({ finalName, description: img.description, domMessageIndex: img.domMessageIndex });
                        }
                    }
                    successCount++;
                }

                // 统一插入 DOM 图：按目标行升序（同一行的按处理顺序），累计偏移 = 已插入张数 × 3 行。
                // 同一锚点下的多张图因此会依次排开在锚点之后，保持与网页一致的先后顺序。
                if (pendingInserts.length) {
                    pendingInserts.sort((a, b) => (a.at - b.at) || (a.seq - b.seq));
                    const mdLines = newMd.split('\n');
                    let shift = 0;
                    for (const p of pendingInserts) {
                        mdLines.splice(p.at + shift, 0, '', `![${p.desc || p.name}](images/${p.name})`, '');
                        shift += 3;
                        const howText = p.how === 'anchor' ? '前文锚点(行级)'
                            : (p.how === 'text' ? '文本指纹(消息级)' : '渲染序号');
                        logger.info(`DOM 图 ${p.name} 已按${howText}归位到对应消息`);
                    }
                    newMd = mdLines.join('\n');
                    // 插入了内容 → 让消息块缓存失效
                    utils._msgBlockCache.len = -1;
                }
                const downloadMs = Date.now() - t0;

                // ===== 附件（非图片）下载：串行 + 单项 60s 超时，打包进 zip 的 files/ =====
                let fileOk = 0;
                const totalAttach = attachs.length;
                for (let i = 0; i < totalAttach; i++) {
                    const fe = attachs[i];
                    updateBtn(`📎 下载附件 ${i + 1}/${totalAttach}`);
                    try {
                        const controller = new AbortController();
                        const timer = setTimeout(() => controller.abort(), 60000);
                        let resp;
                        try {
                            resp = await fetch(fe.url, { mode: 'cors', signal: controller.signal });
                        } finally {
                            clearTimeout(timer);
                        }
                        if (!resp.ok) throw new Error('HTTP ' + resp.status);
                        const blob = await resp.blob();
                        fe._bytes = new Uint8Array(await blob.arrayBuffer());
                        fe._blob = blob;
                        bytesTotal += fe._bytes.length;
                        fileOk++;
                    } catch (e) {
                        logger.warn(`附件下载失败: ${fe.filename}`, e);
                        failed.push({ url: fe.url, filename: fe.filename, error: (e && e.message) ? e.message : String(e) });
                        // 失败不静默：MD 里把相对路径换回原始 URL
                        const escapedFe = fe.filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        newMd = newMd.replace(new RegExp(`files/${escapedFe}`, 'g'), fe.url);
                    }
                }

                // 未被 MD 内联引用的图片（如从 DOM 收集或其他原因未匹配到），统一追加到末尾“图片附件”区作为兜底
                if (notReferenced.length) {
                    let appendix = '\n\n---\n\n## 图片附件\n\n';
                    appendix += '> 以下图片在正文里找不到对应引用（多见于虚拟滚动/仅 DOM 渲染的图）。\n';
                    appendix += '> 带「第 N 条消息」标记的，是按页面渲染顺序推断的归属，供人工回填位置。\n\n';
                    notReferenced.forEach(it => {
                        const where = (it.domMessageIndex === null || it.domMessageIndex === undefined)
                            ? '' : `（第 ${it.domMessageIndex + 1} 条消息）`;
                        appendix += `![${(it.description || it.finalName) + where}](images/${it.finalName})\n\n`;
                    });
                    newMd += appendix;
                }

                if (failed.length) {
                    newMd += '\n\n---\n\n## ⚠️ 未下载成功的图片\n\n';
                    newMd += '> 这些图片导出时拉取失败，文件不在 zip 内；下面保留原始 URL 以便补取（直链有签名时效，尽快处理）。\n\n';
                    failed.forEach(f => {
                        newMd += `- \`${f.filename || '(无名文件)'}\` — ${f.error || '未知错误'}\n  ${f.url}\n`;
                    });
                }

                // 统计信息行补上"实际导出"的数字（与悬浮提示同一口径）
                const statsSuffix = `｜图片 ${successCount} 张（DOM 通道(落盘) ${domCount} 张）｜附件 ${fileOk} 个｜未下载 ${failed.length} 张`;
                if (/^> 统计信息：.*$/m.test(newMd)) {
                    // 顺带把原来的 ` | ` 统一成 `｜`，整行分隔符一致
                    newMd = newMd.replace(/^> 统计信息：(.*)$/m, (m0, p1) => `> 统计信息：${p1.replace(/ \| /g, '｜')}${statsSuffix}`);
                } else {
                    newMd = `> 统计信息：${statsSuffix.replace(/^｜/, '')}\n\n${newMd}`;
                }

                updateBtn('📦 打包 ZIP...');
                let zipBlob;
                try {
                    const files = [{ name: 'images/', data: new Uint8Array(0), isDir: true }];
                    for (const img of images) {
                        if (img._bytes) files.push({ name: `images/${img._finalName}`, data: img._bytes });
                    }
                    if (attachs.some(f => f._bytes)) files.push({ name: 'files/', data: new Uint8Array(0), isDir: true });
                    for (const fe of attachs) {
                        if (fe._bytes) files.push({ name: `files/${fe.filename}`, data: fe._bytes });
                    }
                    files.push({ name: `${baseName}.md`, data: new TextEncoder().encode(newMd) });
                    // 原始 JSON 一并放进 zip（保真归档源：含思考/引用/工具数据；与 MD 同一份内容、同一范围）
                    if (withJson) {
                        let jsonText = state.targetResponse;
                        if (!jsonText && state.lastJsonData) {
                            try { jsonText = JSON.stringify(state.lastJsonData); } catch (e) { jsonText = ''; }
                        }
                        if (jsonText) files.push({ name: `${baseName}.json`, data: new TextEncoder().encode(jsonText) });
                    }
                    (extraFiles || []).forEach(ef => { if (ef && ef.name && ef.data) files.push(ef); }); // 取证 JSON 等附加文件
                    zipBlob = utils.makeStoreZip(files);
                } catch (ze) {
                    logger.warn('ZIP 生成失败，降级为逐文件下载', ze);
                    let k = 0;
                    for (const img of images) {
                        if (img._blob) {
                            utils.createBlobDownload(img._blob, 'image/' + (img._ext || 'png'), img._finalName || `image_${k + 1}.${img._ext || 'png'}`);
                            await new Promise(r => setTimeout(r, 200));
                            k++;
                        }
                    }
                    for (const fe of attachs) {
                        if (fe._blob) {
                            utils.createBlobDownload(fe._blob, 'application/octet-stream', fe.filename);
                            await new Promise(r => setTimeout(r, 200));
                            k++;
                        }
                    }
                    utils.createBlobDownload(newMd, 'text/markdown', `${baseName}.md`);
                    if (withJson && state.targetResponse) {
                        try { utils.createBlobDownload(state.targetResponse, 'application/json', `${baseName}.json`); } catch (e) {}
                    }
                    for (const ef of (extraFiles || [])) {
                        try { utils.createBlobDownload(new Blob([ef.data], { type: 'application/json' }), 'application/json', ef.name); } catch (e) {}
                    }
                    updateBtn('📄 MD+图片(降级)');
                    utils.notify(`ZIP 打包失败，已降级为逐文件下载：md + ${k} 张图（请在下载目录手动归拢）。`, { type: 'warn' });
                    return true;
                }
                const zipName = `${baseName}.zip`;
                utils.createBlobDownload(zipBlob, 'application/zip', zipName);

                // 导出成功后释放内存里的图片/附件字节（16MB+ 的图不再常驻；重新导出会重新拉取）
                try {
                    images.forEach(it => { it._bytes = null; it._blob = null; });
                    attachs.forEach(it => { it._bytes = null; it._blob = null; });
                } catch (e) {}

                const totalMs = Date.now() - t0;
                const attachInfo = totalAttach ? `，附件 ${fileOk}/${totalAttach} 个` : '';
                const timing = `下载 ${(downloadMs / 1000).toFixed(1)}s（${successCount} 张成功 / ${failCount} 张失败，${(bytesTotal / 1048576).toFixed(1)}MB，其中 DOM 通道 ${domCount} 张${attachInfo}）`
                             + `｜打包 ${((totalMs - downloadMs) / 1000).toFixed(1)}s｜合计 ${(totalMs / 1000).toFixed(1)}s`;
                logger.info(`图片下载完成: 成功 ${successCount} 张，失败 ${failCount} 张，共 ${total} 张；附件成功 ${fileOk}/${totalAttach}`);
                logger.info(`导出耗时: ${timing}`);
                updateBtn('📄 MD+图片(ZIP)');
                const diagLine = diagSummary ? `\n\n图片取证：${diagSummary}\n（zip 内 _diagnostics.json 是完整取证数据，排查缺图用）` : '';
                const pullHint = pulledRecently ? '' : '\n\n⚠️ 本次为「仅导出」路径，未做全量拉取：只导出了已累积的内容，仅存在于未渲染消息里的图可能缺失。';
                let historyHint = '';
                try {
                    const hc = utils.historyCompleteness();
                    if (!hc.complete) {
                        historyHint = `\n\n⚠️ 历史可能不完整：平台仍有更早的消息未加载（has_more=${hc.hasMore}，最早消息序号=${hc.minIdx}）——建议先点「⬆️ 回到顶部·加载历史」。`;
                    }
                } catch (e) {}
                // 与悬浮提示保持一致的统计口径
                const statsLineForAlert = `图片 ${successCount} 张（DOM 通道 ${domCount} 张）｜附件 ${fileOk} 个｜消息 ${state.mergeStore.map.size} 条`
                                        + (failCount ? `｜未下载 ${failCount} 张` : '');
                const msg = failCount > 0
                    ? `下载完成：成功 ${successCount} 张、失败 ${failCount} 张图片，已打包为 ${zipName}。\n失败的图片已在 md 末尾「⚠️ 未下载成功的图片」区列出原始 URL，可稍后补取。\n\n统计：${statsLineForAlert}\n耗时：${timing}${diagLine}${pullHint}${historyHint}`
                    : `下载完成：共 ${successCount} 张图片${totalAttach ? `、${fileOk} 个附件` : ''} + 1 个 Markdown 文件，已打包为 ${zipName}（内含 images/${totalAttach ? ' 与 files/' : ''} 文件夹）。\n\n统计：${statsLineForAlert}\n耗时：${timing}${diagLine}${pullHint}${historyHint}`;
                utils.notify(msg);
                return true;
            } catch (e) {
                logger.error('下载图片失败', e);
                updateBtn('📄 MD+图片');
                utils.notify(`下载失败: ${e.message}`, { type: 'error' });
                return false;
            }
        }
    };

    // ============ 分页历史记录合并（解决滚动加载的旧轮次丢失问题） ============
    // 各平台历史API是分页返回的：页面打开只拿到最近几轮，向上滚动才会请求更早的轮次。
    // 这里把每次拦截到的“一页”数据按消息ID去重合并到累积池，导出时使用完整数据。
    const MERGE_CONFIG = {
        deepseek: {
            getList: d => d?.data?.biz_data?.chat_messages,
            setList: (d, list) => { d.data.biz_data.chat_messages = list; },
            getId: m => m.message_id ?? m.id ?? m.inserted_at,
            // 按 message_id 排序：DeepSeek 助手消息的 inserted_at 会比它前一条用户消息更小
            // （实测 …295.7259 < …295.7289），用 inserted_at 会把 AI 回复排到提问前面 —— 顺序错乱的根因。
            sortKey: m => {
                const id = Number(m && m.message_id);
                if (Number.isFinite(id)) return id;
                return (m && m.inserted_at != null) ? m.inserted_at : 0;
            },
            getTitle: d => d?.data?.biz_data?.chat_session?.title,
            setTitle: (d, t) => { if (d?.data?.biz_data) { d.data.biz_data.chat_session = d.data.biz_data.chat_session || {}; d.data.biz_data.chat_session.title = t; } }
        },
        ncn: {
            getList: d => d?.data?.messages,
            setList: (d, list) => { d.data.messages = list; },
            getId: m => m.id ?? m.msg_id ?? m.qid ?? m.create_time ?? m.prompt,
            sortKey: m => m.create_time ?? m.id ?? 0,
            getTitle: d => d?.data?.title,
            setTitle: (d, t) => { if (d?.data) d.data.title = t; }
        },
        yuanbao: {
            getList: d => d?.convs,
            setList: (d, list) => { d.convs = list; },
            getId: m => m.id ?? `${m.index}|${m.speaker}`,
            sortKey: m => m.index ?? 0,
            getTitle: d => d?.sessionTitle || d?.title,
            setTitle: (d, t) => { d.sessionTitle = t; }
        },
        kimi: {
            getList: d => d?.messages,
            setList: (d, list) => { d.messages = list; },
            getId: m => m.id ?? m.messageId ?? m.createTime,
            sortKey: m => m.createTime ?? 0
        },
        tongyi: {
            getList: d => d?.data,
            setList: (d, list) => { d.data = list; },
            getId: m => m.msgId ?? m.id ?? m.createTime,
            sortKey: m => m.createTime ?? 0
        },
        iflytek: {
            getList: d => d?.data?.[0]?.historyList,
            setList: (d, list) => { if (d?.data?.[0]) d.data[0].historyList = list; },
            getId: m => m.id ?? m.sid ?? m.createTime,
            sortKey: m => m.createTime ?? m.id ?? 0
        },
        doubao: {
            getList: d => d?.downlink_body?.pull_singe_chain_downlink_body?.messages,
            setList: (d, list) => { d.downlink_body.pull_singe_chain_downlink_body.messages = list; },
            getId: m => m.message_id ?? m.server_message_id ?? m.local_message_id ?? `${m.create_time}|${m.user_type}`,
            sortKey: m => m.create_time ?? 0
        }
    };

    // 比较排序键：数字直接比，字符串尝试按日期比，否则按字典序
    function compareSortKeys(a, b) {
        if (a == null || b == null) return 0;
        if (typeof a === 'number' && typeof b === 'number') return a - b;
        const da = Date.parse(a), db = Date.parse(b);
        if (!isNaN(da) && !isNaN(db)) return da - db;
        return String(a).localeCompare(String(b));
    }

    // 会话标识：切换到别的对话时清空累积池，避免混入上一个对话的内容
    function getConversationKey(platform, url) {
        const s = String(url || '');
        const m = s.match(/(?:chat_session_id|conversation_id|sessionId|chat_id)=([^&]+)/);
        if (m) return `${platform}|${m[1]}`;
        // DeepSeek 页面 URL 形如 /a/chat/s/<uuid>，不带 chat_session_id= 查询参数 —— 统一取出 uuid，
        // 让「页面 href」与「消息接口 URL」算出同一个会话键。
        const d = s.match(/\/a\/chat\/s\/([A-Za-z0-9_-]{6,})/);
        if (d) return `${platform}|${d[1]}`;
        return `${platform}|${location.pathname}${location.search}`;
    }

    function mergeHistoryData(platform, jsonData, url) {
        const cfg = MERGE_CONFIG[platform];
        if (!cfg) return jsonData;
        const newList = cfg.getList(jsonData);
        if (!Array.isArray(newList)) return jsonData;

        const convKey = getConversationKey(platform, url);
        if (state.mergeStore.key !== convKey) {
            state.mergeStore.key = convKey;
            state.mergeStore.map = new Map();
            state.mergeStore.title = null;
            logger.info(`检测到新会话，重置历史消息累积池: ${convKey}`);
        }

        newList.forEach(msg => {
            const id = cfg.getId(msg);
            if (id !== undefined && id !== null) {
                state.mergeStore.map.set(String(id), msg);
            }
        });

        const merged = [...state.mergeStore.map.values()]
            .sort((a, b) => compareSortKeys(cfg.sortKey(a), cfg.sortKey(b)));
        cfg.setList(jsonData, merged);

        // 分页响应里可能没有标题，沿用之前拿到的标题
        if (cfg.getTitle) {
            const t = cfg.getTitle(jsonData);
            if (t) {
                state.mergeStore.title = t;
            } else if (state.mergeStore.title && cfg.setTitle) {
                cfg.setTitle(jsonData, state.mergeStore.title);
            }
        }

        logger.info(`历史消息合并: 本次响应 ${newList.length} 条，累积共 ${merged.length} 条`);
        return jsonData;
    }
    // ============ 分页合并模块结束 ============

    // 平台特定的转换器
    const platformConverters = {
        deepseek: (data) => {
            let mdContent = [];
            // 1. 安全的数据访问
            const bizData = data?.data?.biz_data || {};
            const chatSession = bizData.chat_session || {};
            const chatMessages = bizData.chat_messages || [];

            const title = chatSession.title || CONFIG.DEFAULT_TITLE;
            const totalTokens = chatMessages.reduce((acc, msg) =>
                                                    acc + (msg.accumulated_token_usage || 0), 0);

            // 2. 标题和统计信息
            mdContent.push(`# DeepSeek对话 - ${title}`);
            mdContent.push(`\n> 统计信息：累计Token用量 ${totalTokens}`);
            mdContent.push(`> 生成时间：${new Date().toLocaleString()}\n`);

            // 3. 处理消息（用户提问和AI回答都导出）
            chatMessages.forEach((msg,index) => {
                // 标题格式与豆包统一为 `## 角色 (时间)`：旧的 🤖 Assistant / 👤 用户 前缀
                // 既不被 import_ai_chat.py 的消息模式识别（算不出指纹），也不被 messageBlocksOf 的
                // headingRe 命中（DOM 图片无法归位）。
                const role = msg.role === 'ASSISTANT' ? 'DS' : '用户';
                const timestamp = utils.formatTimestamp(msg.inserted_at);

                mdContent.push(`## ${role} (${timestamp})`);

                // 4. 处理文件信息
                if (msg.files?.length > 0) {
                    mdContent.push('### 文件信息');
                    msg.files.forEach(file => {
                        mdContent.push(`- 名称: ${file.file_name}`);
                        mdContent.push(`- 大小: ${(file.file_size / 1024).toFixed(1)}KB`);
                        mdContent.push(`- Token用量: ${file.token_usage}`);
                    });
                    mdContent.push('');
                }

                // 5. 处理消息片段（思考过程和回复内容）
                let content = '';
                let thinkingContent = '';

                if (msg.fragments?.length > 0) {
                    const citations = {};
                    msg.fragments.forEach(fragment => {
                        if (fragment.cite_index !== null) {
                            citations[fragment.cite_index] = fragment.url;
                        }

                        switch (fragment.type) {
                            case 'THINK':
                                thinkingContent += fragment.content + '\n';
                                break;
                            case 'RESPONSE':
                                content += fragment.content + '\n';
                                break;
                            case 'TIP':
                                content += `\n> 💡 ${fragment.content}\n`;
                                break;
                            case 'REQUEST':
                                content += fragment.content + '\n';
                                break;
                            case 'FILE':
                                if (Array.isArray(fragment.files)) {
                                    fragment.files.forEach(file => {
                                        const fsafe = utils.mdLabel(file.file_name || '');
                                        if (file.is_image && file.signed_path) {
                                            // 必须用与 collectDeepseekImagesFromJson 完全一致的 URL，
                                            // 否则下载阶段无法用「正文 URL → 相对路径」替换，图会落不进正文
                                            const url = utils.deepseekFileUrl(file.signed_path, 'p');
                                            content += `\n![${fsafe || 'image'}](${url})\n`;
                                        } else if (file.signed_path) {
                                            // 非图片文件（PDF/Word/…）：ty=r 取原始文件（p/t 是图片预览变体）
                                            const fileUrl = utils.deepseekFileUrl(file.signed_path, 'r');
                                            let linked = false;
                                            try {
                                                const fe = utils.getFileEntry('deepseek', getConversationKey('deepseek', location.href), fileUrl, fsafe);
                                                if (fe) {
                                                    content += `\n> 📎 [${fsafe || fe.filename}](files/${fe.filename})\n`;
                                                    linked = true;
                                                }
                                            } catch (e) {}
                                            if (!linked) content += `\n> 📎 [${fsafe || '文件'}](${fileUrl})\n`;
                                        } else if (fsafe) {
                                            content += `\n> 📎 文件: ${fsafe}\n`;
                                        }
                                    });
                                }
                                break;
                        }
                    });
                    content = content.replace(/\[citation:(\d+)\]/g, (match, p1) => {
                        const url = citations[parseInt(p1)];
                        return url ? ` [${p1}](${url})` : match;
                    });
                    // 重要的空格处理（避免公式中的空格问题）
                    content = content.replace(/\s+,/g, ',').replace(/\s+\./g, '.');
                }

                // 5.5 用户提问通常没有fragments，正文直接在content字段里
                if (!content.trim() && typeof msg.content === 'string' && msg.content.trim()) {
                    content = msg.content;
                }

                // 6. 添加思考过程（如果存在）
                if (thinkingContent.trim()) {
                    const thinkFragment = msg.fragments.find(f => f.type === 'THINK');
                    const thinkTime = thinkFragment?.elapsed_secs ? `(${thinkFragment.elapsed_secs.toFixed(1)}s)` : '';
                    content += `\n**思考过程 ${thinkTime}:**\n${thinkingContent.trim()}\n`;
                }

                // 7. 数学公式格式化 - 智能处理
                content = content.replace(/(\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$\$.*?\$\$)/g, (match) => {
                    // 提取公式内容（移除各种边界符号）
                    let formula = match.replace(/^\\\(|\\\)$|^\\\[|\\\]$|\$\$/g, '');

                    // 转换为单行
                    formula = formula.replace(/\s+/g, ' ').trim();

                    // 返回统一的 $...$ 格式
                    return `$${formula}$`;
                });

                mdContent.push(content.trim() + '\n');
                mdContent.push('---\n');
            });
            return mdContent.join('\n');
        },

        ncn: (data) => {
            let mdContent = [];
            const meta = data.data || {};
            mdContent.push(`# 纳米AI对话记录 - ${meta.title || CONFIG.DEFAULT_TITLE}`);
            mdContent.push(`**生成时间**: ${utils.formatTimestamp(data.timestamp) || '未知'}`);


            const totalChars = meta.messages?.reduce((acc, msg) =>
                acc + (msg.result?.length || 0), 0) || 0;
            const questions = meta.messages?.reduce((acc, msg) =>
                acc + (msg.ask_further?.length || 0), 0) || 0;

            mdContent.push(`\n> 统计信息：总字数 ${totalChars} | 后续问题 ${questions} 个`);

            meta.messages?.forEach(msg => {
                if (msg.file?.length) {
                    mdContent.push('### 附件信息');
                    msg.file.forEach(file => {
                        mdContent.push(`- ${file.title} (${(file.size / 1024).toFixed(1)}KB)`);
                    });
                }

                // 用户提问和AI回复（标题统一为 `## 角色 (时间)`，与入库脚本/图片归位一致）
                const msgTime = utils.formatTimestamp(msg.create_time || data.timestamp);
                mdContent.push(`\n## 用户 (${msgTime})\n${msg.prompt || '无内容'}`);
                // 处理AI回复内容，移除引用标记
                let cleanResult = msg.result || '无内容';
                // 移除类似[[3]()][[7]()]的引用标记
                cleanResult = cleanResult.replace(/\[\[\d+\]\(\)\]/g, '');
                // 移除多余的换行和空格
                cleanResult = cleanResult.replace(/\n{3,}/g, '\n').trim();
                mdContent.push(`\n## 纳米AI (${msgTime})\n${cleanResult}`);
                //mdContent.push(`## AI回复\n${msg.result || '无内容'}`);

                // 推荐追问
                if (msg.ask_further?.length) {
                    mdContent.push('### 推荐追问');
                    msg.ask_further.forEach(q => {
                        mdContent.push(`- ${q.content}`);
                    });
                }

                //是否需要导出，通过全局配置进行选择
                if(CONFIG.REL_AND_KNOWLEDGE){
                    // 参考链接
                    if (msg.refer_search?.length) {
                        mdContent.push('\n### 参考来源');
                        msg.refer_search.forEach(ref => {
                            mdContent.push(`- [${ref.title || '无标题'}](${ref.url}) - ${ref.summary || '无摘要'}`);
                            if (ref.date) mdContent.push(`  - 发布日期: ${ref.date}`);
                            if (ref.site) mdContent.push(`  - 来源网站: ${ref.site}`);
                        });
                    }

                    // 用户知识库引用
                    if (msg.user_knowledge?.length) {
                        mdContent.push('\n### 知识库引用');
                        const uniqueFiles = new Map();
                        msg.user_knowledge.forEach(knowledge => {
                            if (knowledge.file_name && !uniqueFiles.has(knowledge.file_id)) {
                                uniqueFiles.set(knowledge.file_id, knowledge);
                                mdContent.push(`- ${knowledge.file_name} (来自文件夹: ${knowledge.folder_id || '未知'})`);
                            }
                        });
                    }
                }

                mdContent.push('\n---\n');
            });
            return mdContent.join('\n');
        },

        yuanbao: (data) => {
            if (!data?.convs || !Array.isArray(data.convs)) {
                logger.error('无效的元宝数据', data);
                return '# 错误：无效的JSON数据\n\n无法解析对话内容。';
            }

            let markdownContent = [];
            const title = data.sessionTitle || data.title || '元宝对话记录';
            markdownContent.push(`# ${title}\n`);

            if (data.multiMediaInfo?.length > 0) {
                markdownContent.push('**包含的多媒体文件:**\n');
                data.multiMediaInfo.forEach(media => {
                    markdownContent.push(`* [${media.fileName || '未知文件'}](${media.url || '#'}) (${media.type || '未知类型'})\n`);
                });
                markdownContent.push('---\n');
            }

            const sortedConvs = [...data.convs].sort((a, b) => (a.index || 0) - (b.index || 0));

            sortedConvs.forEach(turn => {
                const timestamp = utils.formatTimestamp(turn.createTime);
                const index = turn.index !== undefined ? turn.index : 'N/A';

                // 用户提问轮次
                if (turn.speaker === 'human') {
                    markdownContent.push(`\n## 用户 (${timestamp})\n`);
                    markdownContent.push(`*时间: ${timestamp}*\n`);

                    let userText = '';
                    const collectBlocks = (blocks) => {
                        blocks?.forEach(block => {
                            if (block.type === 'text' && block.msg) {
                                userText += block.msg + '\n\n';
                            } else if (['image', 'code', 'pdf', 'file'].includes(block.type)) {
                                userText += `*附件:* [${block.fileName || '未知文件'}](${block.url || '#'}) (类型: ${block.type})\n\n`;
                            }
                        });
                    };

                    // 用户内容可能在 turn.content 数组里，也可能在 speechesV2 里
                    if (Array.isArray(turn.content)) {
                        collectBlocks(turn.content);
                    }
                    if (!userText.trim()) {
                        turn.speechesV2?.forEach(speech => collectBlocks(speech.content));
                    }
                    if (!userText.trim() && typeof turn.content === 'string') {
                        userText = turn.content;
                    }
                    if (!userText.trim() && typeof turn.displayPrompt === 'string') {
                        userText = turn.displayPrompt;
                    }

                    markdownContent.push((userText.trim() || '（无内容）') + '\n');
                    markdownContent.push('\n---\n');
                    return;
                }

                if (turn.speaker === 'ai') {
                    markdownContent.push(`\n## 腾讯元宝 (${timestamp})\n`);

                    let modelDisplay = '未知模型';
                    let primaryPluginId = '无插件';

                    if (turn.speechesV2?.length > 0) {
                        const firstSpeech = turn.speechesV2[0];
                        const modelIdRaw = firstSpeech.chatModelId;
                        primaryPluginId = firstSpeech.pluginId || primaryPluginId;

                        if (modelIdRaw && String(modelIdRaw).trim() !== '') {
                            modelDisplay = `\`${modelIdRaw}\``;
                        }
                    }

                    markdownContent.push(`*时间: ${timestamp} | 模型: ${modelDisplay} | 插件: \`${primaryPluginId}\`*\n\n`);

                    turn.speechesV2?.forEach(speech => {
                        speech.content?.forEach(block => {
                            switch (block.type) {
                                case 'text':
                                    markdownContent.push(`${utils.adjustHeaderLevels(block.msg || '', 1)}\n\n`);
                                    break;
                                case 'think':
                                    markdownContent.push(`> **[思考过程]** ${block.title || ''}\n>\n`);
                                    (block.content || '无思考内容').split('\n').forEach(line => {
                                        markdownContent.push(`> ${line}\n`);
                                    });
                                    markdownContent.push('\n');
                                    break;
                                case 'searchGuid':
                                    markdownContent.push(`**${block.title || '搜索结果'}** (查询: \`${block.botPrompt || 'N/A'}\` | 主题: ${block.topic || 'N/A'})\n`);
                                    block.docs?.forEach((doc, docIndex) => {
                                        markdownContent.push(`* [${docIndex + 1}] [${doc.title || '无标题'}](${doc.url || '#'}) (${doc.sourceName || '未知来源'})\n    * > ${doc.quote || '无引用'}\n`);
                                    });
                                    markdownContent.push('\n');
                                    break;
                                case 'image':
                                case 'code':
                                case 'pdf':
                                    markdownContent.push(`*文件:* [${block.fileName || '未知文件'}](${block.url || '#'}) (类型: ${block.type})\n\n`);
                                    break;
                            }
                        });
                    });
                }
                markdownContent.push('\n---\n');
            });

            return markdownContent.join('\n').replace(/\n---\n$/, '').trim();
        },

        kimi: async (data) => {
            let mdContent = [];
            const title = await fetchKimiChatTitle() || 'Kimi对话记录';
            //const title = state.currentTitle || 'Kimi对话记录';
            mdContent.push(`# ${title}\n`);

            // 处理消息数组
            data.messages?.forEach((message, index) => {
                const role = message.role === 'user' ? '用户' : 'Kimi';
                const timestamp = utils.formatTimestamp(message.createTime);

                mdContent.push(`## ${role} (${timestamp})\n`);

                // 处理blocks中的内容
                message.blocks?.forEach(block => {
                    if (block.text?.content) {
                        // 文本内容
                        mdContent.push(block.text.content + '\n');
                    } else if (block.artifact) {
                        // 特殊内容（如PPT、文件等）
                        if (block.artifact.type === 'ARTIFACT_TYPE_SLIDES_JSON') {
                            mdContent.push('### 📊 生成的PPT内容\n');
                            try {
                                const slidesData = JSON.parse(block.artifact.content);
                                mdContent.push(`**标题:** ${slidesData.outline?.pptTitle || '无标题'}\n`);
                                mdContent.push(`**页数:** ${slidesData.outline?.slidesCount || 0}\n`);
                                // 可以进一步解析PPT内容
                            } catch (e) {
                                mdContent.push('*[PPT内容解析失败]*\n');
                            }
                        }
                    } else if (block.slidesView) {
                        // 幻灯片视图信息
                        mdContent.push(`### 🎨 幻灯片视图\n`);
                        mdContent.push(`- 名称: ${block.slidesView.name}\n`);
                        mdContent.push(`- 状态: ${block.slidesView.status}\n`);
                        if (block.slidesView.coverUrl) {
                            mdContent.push(`- 封面: ![封面](${block.slidesView.coverUrl})\n`);
                        }
                    }
                });

                mdContent.push('\n---\n');
            });

            return mdContent.join('\n');
        },

        tongyi: (data) => {
            let mdContent = [];
            mdContent.push(`# 通义千问对话记录`);

            const convTurns = data.data?.length || 0;
            const totalChars = data.data?.reduce((acc, msg) => {
                return acc + (msg.contents?.reduce((sum, content) => {
                    if (content.contentType === 'text' && content.content) {
                        return sum + content.content.length;
                    } else if (content.contentType === 'plugin' && content.content) {
                        // 计算插件内容中的文本长度
                        try {
                            const pluginData = JSON.parse(content.content);
                            if (pluginData.pluginCall) {
                                const callData = JSON.parse(pluginData.pluginCall);
                                return sum + (callData.prompt?.length || 0);
                            }
                        } catch (e) {
                            return sum;
                        }
                    }
                    return sum;
                }, 0) || 0);
            }, 0) || 0;

            mdContent.push(`\n> 统计信息：对话轮次 ${convTurns} | 总字数 ${totalChars}`);

            if (data.data?.length) {
                const sortedMessages = [...data.data].sort((a, b) => a.createTime - b.createTime);

                sortedMessages.forEach(msg => {
                    const time = utils.formatTimestamp ? utils.formatTimestamp(msg.createTime) :
                new Date(msg.createTime).toLocaleString();
            const role = msg.senderType === 'USER' ? '用户' : '通义千问';
            mdContent.push(`## ${role} (${time})\n`);

            msg.contents?.forEach(content => {
                if (content.content) {
                    if (content.contentType === 'text') {
                        // 处理普通文本
                        let text = content.content.replace(/\n/g, '\n\n');
                        text = text.replace(/```([\s\S]*?)```/g, '\n```$1```\n');
                        mdContent.push(text);
                    } else if (content.contentType === 'plugin') {
                        // 处理插件内容（文生图等）
                        try {
                            const pluginData = JSON.parse(content.content);
                            mdContent.push('### 插件调用信息');

                            if (pluginData.pluginCall) {
                                const callData = JSON.parse(pluginData.pluginCall);
                                mdContent.push(`**功能：** ${callData.toolName || '未知'}`);
                                mdContent.push(`**提示词：** ${callData.prompt || '无'}`);
                                mdContent.push(`**尺寸：** ${callData.size || '未指定'}`);
                            }

                            if (pluginData.pluginResult?.taskResult?.wanx_text_to_image?.imageList) {
                                const images = pluginData.pluginResult.taskResult.wanx_text_to_image.imageList;
                                mdContent.push('### 生成的图片');
                                images.forEach((img, index) => {
                                    mdContent.push(`**图片 ${index + 1}：**`);
                                    mdContent.push(`- 分辨率：${img.resolution}`);
                                    mdContent.push(`- 状态：${img.isSecurity ? '安全' : '待审核'}`);
                                    mdContent.push(`- 预览：![](${img.resizeUrl})`);
                                    mdContent.push(`- 原图：[点击下载](${img.url})`);
                                });
                            }

                            if (pluginData.pluginResult?.status) {
                                mdContent.push(`**任务状态：** ${pluginData.pluginResult.status}`);
                            }
                        } catch (e) {
                            mdContent.push('`[插件内容解析错误]`');
                        }
                    }
                }
            });
            mdContent.push('\n---\n');
        });
    } else {
        mdContent.push('\n暂无对话内容');
    }
            return mdContent.join('\n');
        },

        iflytek: (data) => {
            let mdContent = [];
            mdContent.push(`# 讯飞星火对话记录`);

            const convTurns = data.data?.[0]?.historyList?.length || 0;
            const totalChars = data.data?.[0]?.historyList?.reduce((acc, msg) => {
                return acc + (msg.message?.length || 0) + (msg.answer?.length || 0);
            }, 0) || 0;

            mdContent.push(`\n> 统计信息：对话轮次 ${convTurns} | 总字数 ${totalChars}`);

            data.data?.[0]?.historyList?.forEach(msg => {
                if (msg.type === 0) {
                    const time = utils.formatTimestamp(msg.createTime);
                    mdContent.push(`## 用户 (${time})\n\n${msg.message}\n`);
                } else if (msg.message) {
                    const time = utils.formatTimestamp(msg.createTime);
                    let sourceInfo = '';

                    if (msg.traceSource) {
                        try {
                            const sources = JSON.parse(msg.traceSource);
                            if (Array.isArray(sources)) {
                                sources.forEach(source => {
                                    if (source.type === 'searchSource' && source.data) {
                                        sourceInfo += '\n\n**参考来源**:\n';
                                        source.data.forEach(item => {
                                            sourceInfo += `- [${item.docid}](${item.source})\n`;
                                        });
                                    }
                                });
                            }
                        } catch (e) {
                            logger.error('解析来源信息失败', e);
                        }
                    }

                    mdContent.push(`## 讯飞星火 (${time})\n\n${msg.message}${sourceInfo}\n`);
                }
                mdContent.push('---\n');
            });

            return mdContent.join('\n');
        },
        // 豆包消息转换
        doubao: (data) => {
            let mdContent = [];
            //const title = data.downlink_body?.get_conv_info_downlink_body?.conversation_info?.name||'豆包对话记录';
            const title = state.currentTitle || '豆包对话记录';

            // 获取正确的消息数组
            const messages = data.downlink_body?.pull_singe_chain_downlink_body?.messages || [];

            mdContent.push(`# ${title}\n`);

            // 统计信息（消息数待下方合并后按 mergedMessages 统计，口径与正文/入库脚本一致）
            let totalMessages = 0;
            let totalChars = 0;

            // 处理消息内容 - 按时间正序排列
            const sortedMessages = [...messages].sort((a, b) => a.create_time - b.create_time);

            // 豆包把「一次发送的文本 + 图片/附件」拆成两条 chain 记录：user_type、create_time 都相同，
            // 一条是纯文本块(10000)、一条是纯附件块(10052)。前端 UI 合成一个气泡，但按记录逐条渲染会变成
            // 两条 `## 用户`（同时间戳）。渲染前把这种「同角色 + 同时间 + 纯文本↔纯附件」的相邻配对合并成一条。
            const mergedMessages = [];
            for (const m of sortedMessages) {
                const prev = mergedMessages[mergedMessages.length - 1];
                const blockTypesOf = (x) => (x && x.content_block ? x.content_block.map(b => b.block_type) : []);
                const isPureText = (x) => { const t = blockTypesOf(x); return t.length > 0 && t.every(b => b === 10000); };
                const isPureAttach = (x) => { const t = blockTypesOf(x); return t.length > 0 && t.every(b => b === 10052); };
                if (prev && prev.user_type === m.user_type && prev.create_time === m.create_time
                    && ((isPureText(prev) && isPureAttach(m)) || (isPureAttach(prev) && isPureText(m)))) {
                    prev.content_block = [...(prev.content_block || []), ...(m.content_block || [])];
                    continue;
                }
                mergedMessages.push(Object.assign({}, m));
            }
            totalMessages = mergedMessages.length;

            // 每条消息的图片提取结果缓存：转换阶段算一次，后面「全局收集」直接复用，
            // 避免对同一条消息重复深度遍历（长会话会明显拖慢导出）
            const imagesByMsg = new Map();

            mergedMessages.forEach(msg => {
                const time = utils.formatTimestamp(msg.create_time);
                const role = msg.user_type === 1 ? '用户' : '豆包';

                mdContent.push(`## ${role} (${time})`);

                // 处理消息内容
                let content = '';
                let messageChars = 0;
                // 本条消息已内联进正文的图片 URL，供「消息级补充通道」去重（避免同一张图出现两次）
                const inlinedUrls = new Set();

                try {
                    // 豆包消息的 content_type 都是 9999（用户和AI都是）
                    // 按 user_type 区分角色：1=用户, 2=AI
                    // 消息内容在 content_block 数组里，按 block_type 区分块类型
                    // block_type: 10000=文本, 10052=附件(图片/文件), 2074=AI生成图, 10025=搜索结果

                    if (msg.content_block?.length) {
                        let blockContent = '';
                        let blockChars = 0;

                        msg.content_block.forEach(block => {
                            const bt = block.block_type;

                            // ===== 文本块 (10000) =====
                            if (bt === 10000) {
                                let text = '';
                                // 优先 content_v2
                                if (block.content_v2) {
                                    try {
                                        const v2 = typeof block.content_v2 === 'string'
                                            ? JSON.parse(block.content_v2)
                                            : block.content_v2;
                                        text = v2.text_block?.text || v2.text || '';
                                    } catch(e) {}
                                }
                                // 回退 content.text_block.text
                                if (!text && block.content?.text_block?.text) {
                                    text = block.content.text_block.text;
                                }
                                // 再回退 content 字符串
                                if (!text && typeof block.content === 'string' && block.content.trim()) {
                                    text = block.content;
                                }
                                if (text) {
                                    blockContent += text + '\n\n';
                                    blockChars += text.length;
                                }
                            }

                            // ===== 附件块 (10052) — 用户上传的图片/文件 =====
                            else if (bt === 10052) {
                                const attachments = block.content?.attachment_block?.attachments;
                                if (Array.isArray(attachments)) {
                                    attachments.forEach(att => {
                                        // type 1 是图片
                                        if (att.type === 1 && att.image) {
                                            const img = att.image;
                                            // 与 AI 生成图共用同一套取 URL 规则，确保「内联」与「收集」拿到同一 URL
                                            // （否则同一张图会因两处 URL 不一致而被当成两张，出现重复/落附件区）
                                            const imgUrl = platformConverters._doubaoImageUrl(img);
                                            if (imgUrl) {
                                                const imgName = img.name || img.uri?.split('/').pop() || '用户上传图片';
                                                try {
                                                    const convKey = getConversationKey('doubao', location.href);
                                                    const info = utils.getImageFileName('doubao', convKey, imgUrl, imgName);
                                                    if (info) {
                                                        inlinedUrls.add(imgUrl);
                                                        blockContent += `![${info.description || '图片'}](images/${info.filename})\n\n`;
                                                    }
                                                } catch(e) {
                                                    // 降级：用原始URL
                                                    blockContent += `![${imgName}](${imgUrl})\n\n`;
                                                }
                                            }
                                            return;
                                        }
                                        // 非图片附件（PDF/Word/Excel 等）：以前只计数、连文件名都没写 —— 现在一并落盘
                                        const meta = utils.doubaoFileMeta(att);
                                        if (!meta) return;
                                        if (meta.url) {
                                            try {
                                                const fKey = getConversationKey('doubao', location.href);
                                                const fe = utils.getFileEntry('doubao', fKey, meta.url, meta.name);
                                                if (fe) blockContent += `📎 [${meta.name || fe.filename}](files/${fe.filename})\n\n`;
                                                else blockContent += `📎 [${meta.name || '文件'}](${meta.url})\n\n`;
                                            } catch (e) {
                                                blockContent += `📎 [${meta.name || '文件'}](${meta.url})\n\n`;
                                            }
                                        } else {
                                            blockContent += `📎 文件: ${meta.name}（该附件未提供下载链接）\n\n`;
                                        }
                                    });
                                }
                            }

                            // ===== AI生成图片块 (2074) =====
                            else if (bt === 2074) {
                                const mediaContent = platformConverters.processDoubaoMediaContent(block);
                                if (mediaContent) {
                                    let mediaText = mediaContent;
                                    // 将图片URL替换为统一命名的相对路径
                                    try {
                                        const convKey = getConversationKey('doubao', location.href);
                                        // 提取所有 ![描述](url) 中的 url
                                        const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
                                        let match;
                                        const replacements = [];
                                        while ((match = imgRegex.exec(mediaText)) !== null) {
                                            const desc = match[1];
                                            const url = match[2];
                                            inlinedUrls.add(url);
                                            const info = utils.getImageFileName('doubao', convKey, url, desc);
                                            if (info) {
                                                replacements.push({ from: match[0], to: `![${info.description || '图片'}](images/${info.filename})` });
                                            }
                                        }
                                        replacements.forEach(r => {
                                            mediaText = mediaText.replace(r.from, r.to);
                                        });
                                    } catch(e) {}
                                    blockContent += mediaText + '\n\n';
                                }
                            }

                            // ===== 搜索结果块 (10025) — 摘要 + 卡片配图 =====
                            // 卡片配图也是"AI 发出来的图"（用户口径：只要是 AI 发的图都要拉），
                            // 且它天然带位置（就在这条回复里），所以在这里按位置内联，不丢给文末附件区。
                            else if (bt === 10025) {
                                const searchBlock = block.content?.search_query_result_block;
                                if (searchBlock) {
                                    blockContent += `> 🔍 ${searchBlock.summary || '搜索结果'}\n\n`;
                                    try {
                                        const convKey = getConversationKey('doubao', location.href);
                                        const results = Array.isArray(searchBlock.results) ? searchBlock.results : [];
                                        results.forEach(r => {
                                            // 视频卡片：只记「标题 + 链接」，不下载封面、不校验链接
                                            //（口径：视频/媒体资源只保留标题与链接；视频本体无直链，链接即外站地址）
                                            const vc = r && r.video_card;
                                            if (vc) {
                                                const vtitle = vc.video_captions || vc.title || '视频';
                                                const vlink = vc.main_site_url || vc.web_play_url || '';
                                                blockContent += `> 🎬 ${vtitle}${vlink ? '：' + vlink : ''}\n\n`;
                                                return;
                                            }
                                            const tc = (r && r.text_card) ? r.text_card : (r || {});
                                            const cardUrl = tc.image_url ||
                                                            (tc.image && typeof tc.image.url === 'string' ? tc.image.url : '');
                                            if (!platformConverters.looksLikeImageUrl(cardUrl)) return;
                                            if (inlinedUrls.has(cardUrl)) return;
                                            const label = utils.mdLabel(tc.title || tc.sitename || '搜索卡片图');
                                            const info = utils.getImageFileName('doubao', convKey, cardUrl, label);
                                            if (!info) return;
                                            inlinedUrls.add(cardUrl);
                                            blockContent += `![${info.description || label}](images/${info.filename})\n\n`;
                                        });
                                    } catch (e) {}
                                }
                            }
                        });

                        content = blockContent.trim();
                        messageChars = blockChars;
                    }

                    // 回退：content 字段直接是文本字符串（旧格式兼容）
                    // 注意：豆包部分消息的 content 本身是 JSON 字符串（含 text / image_list / data），
                    // 不能整段当正文 —— 要解析后分别取文本与图片
                    if (!content.trim() && typeof msg.content === 'string' && msg.content.trim()) {
                        const rawContent = msg.content.trim();
                        if (rawContent.charAt(0) === '{' || rawContent.charAt(0) === '[') {
                            let parsed = null;
                            try { parsed = JSON.parse(rawContent); } catch (e) {}
                            if (parsed) {
                                const text = (typeof parsed.text === 'string' && parsed.text) ||
                                             (typeof parsed.content === 'string' && parsed.content) || '';
                                if (text) {
                                    content = text;
                                    messageChars = text.length;
                                }
                            } else {
                                content = rawContent;
                                messageChars = rawContent.length;
                            }
                        } else {
                            content = rawContent;
                            messageChars = rawContent.length;
                        }
                    }

                    // 消息级补充通道：AI 生成图在历史接口里未必落在 content_block，
                    // 可能只在 msg.ext.creation_full_content（JSON 字符串）或 msg.content 的
                    // image_list / data 里 —— 这里补扫一遍，把图挂到本条消息末尾
                    //（仍然带位置：属于这条消息，而不是被丢到文末「图片附件」区）
                    try {
                        const extraKey = getConversationKey('doubao', location.href);
                        const extraImgs = platformConverters._extractDoubaoImages(msg);
                        imagesByMsg.set(msg, extraImgs);
                        extraImgs.forEach(r => {
                            if (!r.url || inlinedUrls.has(r.url)) return;
                            try {
                                const info = utils.getImageFileName('doubao', extraKey, r.url, r.description);
                                if (!info) return;
                                inlinedUrls.add(r.url);
                                content += `\n\n![${info.description || '图片'}](images/${info.filename})`;
                                if (r.prompt) content += `\n\n**提示词:** ${r.prompt}`;
                            } catch (e) {
                                content += `\n\n![${r.description || '图片'}](${r.url})`;
                            }
                        });
                    } catch (e) {
                        logger.warn('豆包消息级图片补充失败', e);
                    }

                } catch (e) {
                    console.error('[AI对话导出] 解析豆包消息失败', e);
                    content = `解析错误: ${e.message}`;
                }

                totalChars += messageChars;

                // 清理内容格式
                content = content.replace(/```([\s\S]*?)```/g, '\n```$1```\n')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();

                mdContent.push(content || '（无内容）');
                mdContent.push('\n---\n');
            });

            // 插入统计信息与生成时间到标题下方（与 DeepSeek 元信息一致）
            if (mdContent.length > 1) {
                mdContent.splice(1, 0,
                    `> 统计信息：消息数 ${totalMessages} | 总字数 ${totalChars}\n`,
                    `> 生成时间：${new Date().toLocaleString()}\n`);
            }

            // 收集所有图片 URL 到图片收集器（供 MD+图片 打包导出使用）
            try {
                const convKey = getConversationKey('doubao', location.href);
                const allImages = [];
                mergedMessages.forEach(msg => {
                    // AI 消息的图片（从 content_block / content 提取）
                    // 从 content_block 提取图片（用户和AI消息结构一致，content_type 都是 9999）
                    // block_type: 10052=附件图片, 2074=AI生成图
                    if (msg.content_block?.length) {
                        msg.content_block.forEach(block => {
                            const bt = block.block_type;

                            // 附件块 (10052) — 用户上传的图片
                            if (bt === 10052) {
                                const attachments = block.content?.attachment_block?.attachments;
                                if (Array.isArray(attachments)) {
                                    attachments.forEach(att => {
                                        if (att.type === 1 && att.image) {
                                            const img = att.image;
                                            // 与 AI 生成图共用同一套取 URL 规则，确保「内联」与「收集」拿到同一 URL
                                            // （否则同一张图会因两处 URL 不一致而被当成两张，出现重复/落附件区）
                                            const imgUrl = platformConverters._doubaoImageUrl(img);
                                            if (imgUrl) {
                                                const imgName = img.name || img.uri?.split('/').pop() || '用户上传图片';
                                                allImages.push({ url: imgUrl, description: imgName, prompt: '' });
                                            }
                                        }
                                    });
                                }
                            }

                            // AI生成图片块 (2074)
                            if (bt === 2074) {
                                const imgs = platformConverters._extractDoubaoImages(block);
                                allImages.push(...imgs);
                            }
                        });
                    }
                    // 消息级补充：复用转换阶段已算出的结果（避免同一条消息重复深度遍历）
                    const cachedImgs = imagesByMsg.get(msg);
                    if (cachedImgs && cachedImgs.length) allImages.push(...cachedImgs);
                });
                // 去重（按 URL）
                const seen = new Set();
                const uniqueImages = allImages.filter(img => {
                    if (!img.url || seen.has(img.url)) return false;
                    seen.add(img.url);
                    return true;
                });
                utils.collectImages('doubao', convKey, uniqueImages);
            } catch(e) {
                logger.warn('收集豆包图片失败', e);
            }

            return mdContent.join('\n');
        },

        // 处理豆包的媒体内容 - 增强版（支持 content_v2 / content / 直接 creations 等多来源）
        processDoubaoMediaContent: (blockOrMsg) => {
            const results = platformConverters._extractDoubaoImages(blockOrMsg);
            const content = [];
            results.forEach(r => {
                if (r.url) {
                    content.push(`![${r.description || '图片'}](${r.url})`);
                    if (r.prompt) content.push(`**提示词:** ${r.prompt}`);
                }
            });
            return content.join('\n\n');
        },

        // 取豆包图片对象的可用 URL。字段名随版本漂移，按「无水印原图优先」的顺序尝试。
        // 顺序依据外部已验证实现（见 sources/豆包AI生成图解析-外部参考.md §5.1）：
        //   image_thumb_ori > image_ori_raw > image_raw > originalImage > image_ori > image_preview > image_thumb
        // 命中带 watermark 的 URL 时先记为兜底，继续找无水印的；都没有才用兜底。
        // 宽松判断一个字符串是否"看起来就是一张图"（用于 image_url 这类语义模糊的字段）
        looksLikeImageUrl: (url) => {
            if (!url || typeof url !== 'string') return false;
            const u = url.trim();
            if (!/^https?:\/\//i.test(u) && !/^tos-/.test(u)) return false;
            return /(byteimg\.com|tos-cn-|\.(png|jpe?g|webp|gif|bmp|avif|heic)(\?|~|$))/i.test(u);
        },

        _doubaoImageUrl: (obj) => {
            if (!obj) return '';
            if (typeof obj === 'string') return /^(https?:)?\/\//.test(obj.trim()) ? obj.trim() : '';
            if (typeof obj !== 'object') return '';
            const priority = ['image_thumb_ori', 'image_ori_raw', 'image_raw', 'originalImage',
                              'image_ori', 'image_preview', 'image_thumb',
                              'image_url', 'image'];   // 末尾兜底：搜索卡片等只有 image_url 的结构
            let watermarkFallback = '';
            for (const key of priority) {
                const v = obj[key];
                const url = (typeof v === 'string') ? v : (v && typeof v.url === 'string' ? v.url : '');
                if (!url) continue;
                // image_url 语义模糊（也可能是网页链接），必须长得像图才收
                if ((key === 'image_url' || key === 'image') && !platformConverters.looksLikeImageUrl(url)) continue;
                if (url.indexOf('watermark') === -1) return url;
                if (!watermarkFallback) watermarkFallback = url;
            }
            return watermarkFallback;
        },

        // 提取豆包消息中的所有图片 URL（统一入口，供导出时下载图片使用）
        // 返回 [{ url, description, prompt }]
        //
        // 设计：结构特征驱动 + 有界递归，不锚定 block_type=2074 这类魔数
        //（豆包换版会改块号；外部已验证实现同样是按结构找 creation_block.creations）。
        // 覆盖来源（出处见 sources/豆包AI生成图解析-外部参考.md §三）：
        //   ① content_block[].content.creation_block.creations[]      —— AI 生成图主路径
        //   ② ext.creation_full_content（JSON 字符串，内层 BlockInfo.BlockContent.content）
        //   ③ content.image_list[] / data[]（content 为 JSON 字符串时）
        //   ④ 任意对象上的 image / files / file_list 字段
        //   ⑤ rich_media_layout_block.media[].creation —— 未获实机/公开佐证（该键名本地 0 命中、
        //      全网无公开来源），仅靠递归下钻"可能"覆盖，待实测确认
        //   ⑥ image_url / image.url 等语义模糊字段（搜索结果卡片、外部引用图）
        // 注意：不检查 creation.type === 1（真实数据未必给该字段，旧实现在此处会漏图）。
        _extractDoubaoImages: (blockOrMsg) => {
            const images = [];
            const seen = new Set();
            let visited = 0;
            const MAX_NODES = 4000;   // 防止异常深/异常大的对象把导出拖死
            const MAX_DEPTH = 12;

            const addImage = (imgObj, description, prompt) => {
                const url = platformConverters._doubaoImageUrl(imgObj);
                if (!url || seen.has(url)) return false;
                seen.add(url);
                images.push({
                    url,
                    description: utils.mdLabel(description || (imgObj && imgObj.description) || '图片'),
                    prompt: prompt || ''
                });
                return true;
            };

            // 结构探测：当前对象上凡是「像图片容器」的字段都收进来
            const harvest = (node) => {
                if (!node || typeof node !== 'object') return;
                // ① creation_block.creations[] / creations[]
                const creations = (node.creation_block && node.creation_block.creations) || node.creations;
                if (Array.isArray(creations)) {
                    creations.forEach(c => {
                        if (!c) return;
                        if (c.image) addImage(c.image, c.image.description, c.image.gen_params && c.image.gen_params.prompt);
                        else if (c.image_ori || c.image_ori_raw || c.image_thumb_ori || c.image_thumb) addImage(c, '');
                    });
                }
                // ② image_list[]（content 为 JSON 时的 AI 生成图 / 上传图）
                if (Array.isArray(node.image_list)) {
                    node.image_list.forEach(it => addImage(it, (it && it.description) || ''));
                }
                // ③ data[]（SSE event_data 形态的图片项）
                if (Array.isArray(node.data)) {
                    node.data.forEach(it => {
                        if (it && (it.image_ori || it.image_ori_raw || it.image_thumb_ori || it.image_thumb)) addImage(it, '');
                    });
                }
                // ④ 直接 image 对象
                if (node.image && typeof node.image === 'object' &&
                    (node.image.image_ori || node.image.image_ori_raw || node.image.image_thumb_ori || node.image.image_raw)) {
                    addImage(node.image, node.image.description || '');
                }
                // ⑤ file_list / files（非附件块的上传文件兜底）
                const fileList = node.file_list || node.files;
                if (Array.isArray(fileList)) {
                    fileList.forEach(f => {
                        const url = f && (f.file_url || f.url || f.download_url);
                        if (url && typeof url === 'string' && /\.(png|jpe?g|gif|webp|bmp|svg|avif)/i.test(url)) {
                            addImage({ image_ori_raw: url }, (f.file_name || f.name || '图片'));
                        }
                    });
                }
                // ⑥ 语义模糊但常见：image_url / image{url}（搜索结果卡片、外部引用图等）
                // 注：视频封面字段（album_image / video_first_frame_image）不收集——视频/媒体资源
                // 只保留「标题 + 链接」，取证细节见 sources/豆包AI生成图解析-外部参考.md
                const ambiguous = node.image_url ||
                                  (node.image && typeof node.image === 'object' ? node.image.url : '');
                if (platformConverters.looksLikeImageUrl(ambiguous)) {
                    addImage({ image_ori_raw: ambiguous }, node.title || node.sitename || '图片');
                }
            };

            const walk = (node, depth) => {
                if (node === null || node === undefined) return;
                if (visited > MAX_NODES || depth > MAX_DEPTH) return;
                visited++;
                if (typeof node === 'string') {
                    const t = node.trim();
                    // JSON 字符串要二次解析（creation_full_content / content_v2 / content 都是这种形态）
                    if (t.length > 2 && (t.charAt(0) === '{' || t.charAt(0) === '[')) {
                        try { walk(JSON.parse(t), depth + 1); } catch (e) {}
                    }
                    return;
                }
                if (Array.isArray(node)) { node.forEach(v => walk(v, depth + 1)); return; }
                if (typeof node !== 'object') return;

                harvest(node);

                // 继续下钻（已被 harvest 处理的图片容器不再重复递归）
                for (const k in node) {
                    if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
                    if (k === 'image' || k === 'creation_block' || k === 'creations' ||
                        k === 'image_list' || k === 'data') continue;
                    walk(node[k], depth + 1);
                }
            };

            try {
                walk(blockOrMsg, 0);
            } catch (e) {
                console.error('[AI对话导出] 提取豆包图片失败', e);
            }
            return images;
        },

        // 提取用户消息中的图片（多模态数组格式）
        _extractDoubaoUserImages: (contentObj) => {
            const images = [];
            if (!contentObj) return images;
            const arr = Array.isArray(contentObj) ? contentObj : (contentObj.content || []);
            if (!Array.isArray(arr)) return images;

            arr.forEach(item => {
                if (!item || typeof item !== 'object') return;
                // 标准格式: { type: "image_url", image_url: { url: "..." } }
                if (item.type === 'image_url' && item.image_url?.url) {
                    images.push({ url: item.image_url.url, description: '用户上传图片', prompt: '' });
                }
                // 兼容格式: { type: "image", image_url: "..." }
                if (item.type === 'image' && typeof item.image_url === 'string') {
                    images.push({ url: item.image_url, description: '用户上传图片', prompt: '' });
                }
                // 兼容: file 类型
                if (item.type === 'file' && item.file_url?.url) {
                    const url = item.file_url.url;
                    if (/\.(png|jpg|jpeg|gif|webp|bmp|svg)/i.test(url)) {
                        images.push({ url, description: item.file_name || '用户文件', prompt: '' });
                    }
                }
            });
            return images;
        } ,
        // 豆包聊天列表转换器
        doubao_chat: (data) => {
            let mdContent = [];
            mdContent.push(`# 豆包对话列表\n`);

            // 统计信息
            const totalChats = data.data?.length || 0;
            mdContent.push(`> 统计信息：共 ${totalChats} 个对话\n`);

            // 处理对话列表
            data.data?.forEach(chat => {
                const time = utils.formatTimestamp(chat.create_time);
                mdContent.push(`## ${chat.title || '未命名对话'} (${time})`);
                mdContent.push(`- 对话ID: ${chat.conversation_id}`);
                mdContent.push(`- 最后更新时间: ${new Date(chat.update_time * 1000).toLocaleString()}`);
                mdContent.push(`- 消息数: ${chat.message_count || 0}`);
                mdContent.push('\n---\n');
            });

            return mdContent.join('\n');
        }

    };

    // 核心处理函数
    async function processTargetResponse(text, url) {
        try {
            //console.log('=== 开始处理响应 ===');
            //console.log('URL:', url);
            //console.log('响应长度:', text.length);

            let detectedPlatform = null;
            for (const [platform, pattern] of Object.entries(PLATFORM_PATTERNS)) {
                if (pattern.test(url)) {
                    detectedPlatform = platform;
                    break;
                }
            }
            //console.log(detectedPlatform);

            if (!detectedPlatform) {
                console.log('未匹配到任何平台，退出处理');
                return;
            }

/*              if (detectedPlatform==='kimi') {
                text = await fetchkimiMessage();

            } */

            state.platformType = detectedPlatform;
            state.lastUpdateTime = new Date().toLocaleTimeString();

            // 常驻累积页面渲染出来的图片（搜索结果卡片图 / AI 生成图多半只在 DOM 里，
            // 且虚拟滚动导致"导出那一刻"只能扫到很少几张）
            try {
                const watcherKey = getConversationKey(detectedPlatform, location.href);
                // 豆包：byteimg.com（图床）+ tos-cn-（内容桶标记，覆盖换域名的内容图）
                const hostKeyword = detectedPlatform === 'deepseek' ? 'files.deepseeksvc.com'
                                  : (detectedPlatform === 'doubao' ? 'byteimg.com,tos-cn-' : '');
                if (hostKeyword) utils.startDomImageWatcher(detectedPlatform, watcherKey, hostKeyword);
            } catch (e) {}

            // 重置统计信息
            state.messageStats = {
                totalTokens: 0,
                totalChars: 0,
                fileCount: 0,
                questions: 0,
                convTurns: 0
            };

            // 关键改动：不再用本次响应直接覆盖旧数据，
            // 而是把分页返回的消息合并进累积池，得到完整历史后再保存
            const jsonData = mergeHistoryData(detectedPlatform, JSON.parse(text), url);
            state.targetResponse = JSON.stringify(jsonData);
            state.lastJsonData = jsonData; // 供导出时从会话 JSON 抽取 DeepSeek 图片（FILE 片段 signed_path）
            const match = url.match(/(\/apiv2\/kimi\.chat\.v1\.ChatService\/ListMessages|\/api\/chat\/[^\/]+\/messages|\/api\/chat|chat_session_id)/);//Kimi标题

            // 平台特定处理
            switch(detectedPlatform) {
                case 'deepseek':
                    state.convertedMd = platformConverters.deepseek(jsonData);
                    state.messageStats.totalTokens = jsonData.data?.biz_data?.chat_messages?.reduce(
                        (acc, msg) => acc + (msg.accumulated_token_usage || 0), 0) || 0;
                    state.currentTitle = jsonData.data?.biz_data?.chat_session?.title || 'deepseek-Chat';
                    break;

                case 'ncn':
                    state.convertedMd = platformConverters.ncn(jsonData);
                    state.messageStats.totalChars = jsonData.data?.messages?.reduce(
                        (acc, msg) => acc + (msg.result?.length || 0), 0) || 0;
                    state.messageStats.questions = jsonData.data?.messages?.reduce(
                        (acc, msg) => acc + (msg.ask_further?.length || 0), 0) || 0;
                    state.currentTitle = jsonData.data?.title || 'AI-Chat';
                    break;

                case 'yuanbao':
                    state.convertedMd = platformConverters.yuanbao(jsonData);
                    state.messageStats.convTurns = jsonData.convs?.length || 0;
                    state.currentTitle = jsonData.sessionTitle || jsonData.title || 'Yuanbao-Chat';
                    state.messageStats.fileCount = jsonData.multiMediaInfo?.length || 0;
                    break;

                case 'kimi':
                case 'kimi_title':
                    if (match?.[1]) {
                        state.kimiSessionId = match[1];
                        state.currentTitle = await fetchKimiChatTitle();
                        //console.log('测试Kimi_case');
                    }
                     //console.log('测试Kimicase_title');
                    // 如果是标题API，只更新标题不处理内容
                    if (state.platformType === 'kimi_title') {
                        state.currentTitle = jsonData.chat?.name || 'kimi对话';
                        logger.info(`更新kimi标题: ${state.currentTitle}`);
                        return; // 标题API不需要处理消息内容
                    }
                    state.convertedMd = await platformConverters.kimi(jsonData);
                    state.messageStats.totalChars = jsonData.messages?.reduce(
                        (acc, item) => acc + (JSON.stringify(item.contents).length || 0), 0) || 0;
                    break;

                case 'tongyi':
                    state.convertedMd = platformConverters.tongyi(jsonData);
                    state.messageStats.convTurns = jsonData.data?.length || 0;
                    state.messageStats.totalChars = jsonData.data?.reduce((acc, msg) => {
                        return acc + (msg.contents?.reduce(
                            (sum, content) => sum + (content.content?.length || 0), 0) || 0);
                    }, 0) || 0;
                    state.currentTitle = '通义千问对话';
                    break;

                case 'iflytek':
                    state.convertedMd = platformConverters.iflytek(jsonData);
                    state.messageStats.convTurns = jsonData.data?.[0]?.historyList?.length || 0;
                    state.messageStats.totalChars = jsonData.data?.[0]?.historyList?.reduce((acc, msg) => {
                        return acc + (msg.message?.length || 0) + (msg.answer?.length || 0);
                    }, 0) || 0;
                    state.currentTitle = '讯飞星火对话';
                    break;
                case 'doubao':
                case 'doubao_title':
                    // 如果是标题API，只更新标题不处理内容
                    if (state.platformType === 'doubao_title') {
                        state.currentTitle = jsonData.downlink_body?.get_conv_info_downlink_body?.conversation_info?.name || '豆包对话';
                        logger.info(`更新豆包标题: ${state.currentTitle}`);
                        return; // 标题API不需要处理消息内容
                    }

                    // 正常处理对话内容
                    try {
                        state.convertedMd = platformConverters.doubao(jsonData);
                    } catch(e) {
                        logger.error('豆包MD转换失败', e);
                        state.convertedMd = `转换失败: ${e.message}\n\n请将此问题反馈给脚本作者。`;
                    }

                    // 统计信息（基于 content_block 准确计算）
                    const msgs = jsonData.downlink_body?.pull_singe_chain_downlink_body?.messages || [];
                    let statTotalChars = 0;
                    let statFileCount = 0;
                    msgs.forEach(msg => {
                        if (msg.content_block?.length) {
                            msg.content_block.forEach(block => {
                                const bt = block.block_type;
                                if (bt === 10000) {
                                    // 文本块
                                    let text = '';
                                    if (block.content_v2) {
                                        try {
                                            const v2 = typeof block.content_v2 === 'string' ? JSON.parse(block.content_v2) : block.content_v2;
                                            text = v2.text_block?.text || v2.text || '';
                                        } catch(e) {}
                                    }
                                    if (!text && block.content?.text_block?.text) {
                                        text = block.content.text_block.text;
                                    }
                                    if (!text && typeof block.content === 'string') {
                                        text = block.content;
                                    }
                                    statTotalChars += (text || '').length;
                                } else if (bt === 10052) {
                                    // 附件块（图片/文件）
                                    const atts = block.content?.attachment_block?.attachments;
                                    if (Array.isArray(atts)) {
                                        statFileCount += atts.length;
                                    }
                                } else if (bt === 2074) {
                                    // AI生成图也计数
                                    statFileCount += 1;
                                }
                            });
                        }
                    });
                    state.messageStats.totalChars = statTotalChars;
                    state.messageStats.fileCount = statFileCount;
                    state.messageStats.convTurns = msgs.length;

                    // 如果当前标题还是默认值，尝试从对话数据中获取
                    if (state.currentTitle === CONFIG.DEFAULT_TITLE || state.currentTitle === '豆包对话') {
                        state.currentTitle = jsonData.downlink_body?.get_conv_info_downlink_body?.conversation_info?.name || '豆包对话';
                    }
                    break;
            }

            ui.updateButtonStatus();
            logger.info(`成功处理${detectedPlatform.toUpperCase()}响应`);
        } catch (e) {
            logger.error('响应处理错误', e);
        }
    }

    // Kimi相关功能
    // sessionId提取
    function getKimiSessionId() {
        const currentUrl = window.location.href;
        // 匹配多种可能的URL格式
        const match = currentUrl.match(/(?:chat|chat_session)\/([a-zA-Z0-9-]+)(?:\/|$)/);
        return match ? match[1] : null;
    }

    // 拦截XHR请求获取授权令牌
    function setupAuthInterceptor() {
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

        XMLHttpRequest.prototype.open = function(method, url) {
            this._requestURL = url;
            if (url.includes('/api/chat/') && !url.includes('/api/chat/list')) {
                logger.info(`拦截到Kimi API请求: ${method} ${url}`);
                this._isChatAPI = true;
            }
            return originalOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
            if (this._isChatAPI && header.toLowerCase() === 'authorization') {
                state.authToken = value;
                logger.info('获取到Authorization头');
            }
            return originalSetRequestHeader.apply(this, arguments);
        };
    }

    // 获取Kimi对话标题
    async function fetchKimiChatTitle() {
        if (state.kimiTitleCache) return state.kimiTitleCache;
        //console.log('Kimi标题获取测试');

        state.kimiSessionId = getKimiSessionId();
        if (!state.kimiSessionId) {
            logger.warn('无法获取sessionId');
            return "Kimi对话";
        }

        // 等待获取授权令牌
        let retry = 0;
        while (!state.authToken && retry < 5) {
            logger.info('等待获取授权令牌...');
            await new Promise(resolve => setTimeout(resolve, 500));
            retry++;
        }

        if (!state.authToken) {
            logger.warn('未能获取授权令牌');
            return "Kimi对话";
        }

        try {
            const url = `https://www.kimi.com/api/chat/${state.kimiSessionId}`;
            logger.info(`请求标题API: ${url}`);

            const response = await fetch(url, {
                headers: {
                    'Authorization': state.authToken,
                    'Content-Type': 'application/json',
                },
                credentials: 'include'
            });

            if (!response.ok) {
                logger.warn(`API错误: ${response.status}`);
                return "Kimi对话";
            }

            const data = await response.json();
            logger.info('标题_API响应类型:', typeof data);
            logger.info('API响应:', data);

            //const kimidata =await fetchkimiMessage();
            //console.log('标题里面输出对话：',kimidata);

            state.kimiTitleCache = data.name || "Kimi对话";
            return state.kimiTitleCache;
        } catch (error) {
            logger.error('获取标题失败:', error);
            return "Kimi对话";
        }
    }

    // 获取Kimi对话信息
    async function fetchkimiMessage() {
        if (state.kimiTitleCache) return state.kimiTitleCache;

        state.kimiSessionId = getKimiSessionId();
        if (!state.kimiSessionId) {
            logger.warn('无法获取sessionId');
            return "Kimi信息";
        }

        // 等待获取授权令牌
        let retry = 0;
        while (!state.authToken && retry < 5) {
            logger.info('等待获取授权令牌...');
            await new Promise(resolve => setTimeout(resolve, 500));
            retry++;
        }

        if (!state.authToken) {
            logger.warn('未能获取授权令牌');
            return "Kimi信息";
        }

        try {
            const url = `https://www.kimi.com/apiv2/kimi.chat.v1.ChatService/ListMessages`;
            logger.info(`请求信息API: ${url}`);

            // 修正：使用POST方法并添加请求体
            const requestBody = {
                chat_id: state.kimiSessionId, // 需要传递chatId参数
                // 可能还需要其他参数，如：
                // limit: 100,
                // cursor: ""
            };

            const response = await fetch(url, {
                method: 'POST', // 改为POST方法
                headers: {
                    'Authorization': state.authToken,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody), // 添加请求体
                mode: 'cors',
                referrer: window.location.href, // 使用当前页面作为referrer
                credentials: 'include'
            });

            if (!response.ok) {
                logger.warn(`API错误: ${response.status}`);
                return "Kimi信息";
            }

            // 检查Content-Type确认是JSON
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const rawText = await response.text();
                console.warn('响应不是JSON:', rawText.substring(0, 200));
                return null;
            }

            const data = await response.json();
            //const data = JSON.stringify(restext, null, 2)
            logger.info('Kimi_API响应类型:', typeof data);
            logger.info('kimi_API响应:', data);
            //console.log('kimi_API响应:', JSON.stringify(data, null, 2));

            //state.kimiTitleCache = data.name || "Kimi对话";
            return data;

        } catch (error) {
            logger.error('获取kimi信息失败:', error);
            return "Kimi信息";
        }
    }

    // 导出功能
    // 提取获取文件名的公共逻辑
    function getExportFilename(extension = '') {
        const jsonData = JSON.parse(state.targetResponse || '{}');
        let platformPrefix = '';
        let defaultSuffix = 'Chat';

        switch(state.platformType) {
            case 'deepseek':
                platformPrefix = 'DeepSeek';
                defaultSuffix = 'deepseek-Chat';
                break;
            case 'ncn':
                platformPrefix = 'AI-N';
                defaultSuffix = 'AI-Chat';
                break;
            case 'yuanbao':
                platformPrefix = 'Yuanbao';
                defaultSuffix = 'Yuanbao-Chat';
                break;
            case 'kimi':
                platformPrefix = 'Kimi';
                defaultSuffix = 'Kimi-Chat';
                break;
            case 'tongyi':
                platformPrefix = 'Tongyi';
                defaultSuffix = 'Tongyi-Chat';
                break;
            case 'iflytek':
                platformPrefix = 'Iflytek';
                defaultSuffix = 'Iflytek-Chat';
                break;
            case 'doubao':
            case 'doubao_title':
                platformPrefix = 'Doubao';
                defaultSuffix = state.platformType === 'doubao_chat' ? 'ChatList' : 'Chat';
                break;
            default:
                platformPrefix = 'AI';
                defaultSuffix = 'Chat';
        }

        const title = state.currentTitle ||
              jsonData.data?.biz_data?.chat_session?.title ||
              jsonData.data?.title ||
              jsonData.sessionTitle ||jsonData.downlink_body?.get_conv_info_downlink_body?.conversation_info?.name||'豆包对话'||(state.platformType === 'doubao_chat' ? '豆包列表' : '豆包其他')||
              defaultSuffix;

        const sanitizedTitle = utils.sanitizeFilename(`${platformPrefix}_${title}`);
        return `${sanitizedTitle}_${utils.getLocalTimestamp()}${extension ? '.' + extension : ''}`;
    }

    const exportHandlers = {
        // 三个导出入口共用的第一步：**强制**回到顶部加载完整历史。
        // 用户要求：虽然悬浮提示的统计是共享的，但每次下载都要主动来一下，确保数据可信。
        ensureFullHistory: async () => {
            const loadBtn = document.getElementById('loadAllHistoryButton');
            try {
                // 对话不足一屏时没有滚动容器，这里直接跳过（避免 autoScroller 弹"找不到滚动区域"打扰用户）
                const container = autoScroller.findScrollContainer();
                if (!container) {
                    logger.info('页面没有可滚动区域（对话很短），跳过「回到顶部·加载历史」');
                    return;
                }
                // 传一个假按钮对象是允许的：autoScroller 只用 innerText / style
                await autoScroller.start(loadBtn || { innerText: '', style: {} });
            } catch (e) {
                logger.warn('回到顶部·加载历史 失败（继续导出）', e);
            }
        },

        // 「⬇️ 全量拉取并导出」＝主入口（一键到底）：
        //   加载历史（回到顶部触发分页）→ 全量渲染（虚拟列表关键步骤）→ 收集图/附件 → 自动导出
        //   产物 = zip{ 对话.md + 对话.json + images/ + files/ + _diagnostics.json }，文件名带 _全量
        // 智能跳过：30 分钟内已拉取过 → 不再滚动，直接用已收集的内容导出（想强制重拉就等一会儿或再点一次滚动）
        pullAll: async (force) => {
            const mainBtn = document.getElementById('downloadMdImagesButton');
            const pulledRecently = !force && state.fullPullDoneAt && (Date.now() - state.fullPullDoneAt < 30 * 60 * 1000);
            try {
                if (!pulledRecently) {
                    // 1) 先把被隐藏的历史轮次通过分页接口加载出来（复用既有自动滚动，内部已做快速结束）
                    if (mainBtn) mainBtn.innerText = '⏳ 加载历史…';
                    await exportHandlers.ensureFullHistory();
                    // 2) 再从顶到底分步滚一遍，让每条消息至少渲染一次（虚拟列表的关键步骤）
                    const ok = await utils.renderAllMessages((top, maxTop) => {
                        if (mainBtn) mainBtn.innerText = `⬆️ 渲染 ${Math.round((top / Math.max(1, maxTop)) * 100)}%`;
                    });
                    // 3) 收集：会话 JSON（DeepSeek 的 FILE 片段）+ DOM 渲染结果
                    const convKey = getConversationKey(state.platformType, location.href);
                    let domHost = '';
                    if (state.platformType === 'deepseek') {
                        domHost = 'files.deepseeksvc.com';
                        utils.collectDeepseekImagesFromJson(convKey, state.lastJsonData);
                    } else if (state.platformType === 'doubao') {
                        domHost = 'byteimg.com,tos-cn-';
                    }
                    const added = domHost ? utils.collectDomImages(state.platformType, convKey, domHost) : 0;
                    state.fullPullDoneAt = Date.now();
                    logger.info(`拉取完成：消息 ${state.mergeStore.map.size} 条、图库 ${state.imageStore.map.size} 张（本次 DOM 新增 ${added} 张）、附件 ${state.fileStore.map.size} 个；${ok ? '整段对话已渲染一遍' : '未找到滚动容器'}`);
                } else {
                    logger.info('30 分钟内已拉取过，本次跳过滚动渲染，直接用已收集内容导出');
                }
                // 4) 导出（含原始 JSON）
                if (mainBtn) mainBtn.innerText = '📦 自动导出…';
                state._exportNameSuffix = '_全量';
                await exportHandlers.mdWithImages(true);
            } catch (e) {
                logger.error('全量拉取并导出失败', e);
                utils.notify(`全量拉取并导出失败: ${e.message}`, { type: 'error' });
            } finally {
                if (mainBtn) mainBtn.innerText = '⬇️ 全量拉取并导出';
            }
            return true;
        },

        json: async () => {
            if (!state.targetResponse) {
                utils.notify('还没有发现有效的对话记录。\n请等待目标响应或进行一些对话。', { type: 'warn' });
                return false;
            }

            try {
                // 先强制回到顶部加载完整历史（每次导出都主动来一下，确保数据可信）
                await exportHandlers.ensureFullHistory();
                const fileName = getExportFilename('json');
                const c = utils.historyCompleteness();
                if (!c.complete) logger.warn('导出 JSON：加载后仍可能不完整', c);   // 只记录，不打断导出
                return utils.createBlobDownload(
                    state.targetResponse,
                    'application/json',
                    fileName
                );
            } catch (e) {
                logger.error('JSON导出失败', e);
                utils.notify('导出过程中发生错误，请查看控制台了解详情。', { type: 'error' });
                return false;
            }
        },

        markdown: async () => {
            if (!state.convertedMd) {
                utils.notify('还没有发现有效的对话记录。\n请等待目标响应或进行一些对话。', { type: 'warn' });
                return false;
            }

            try {
                // 先强制回到顶部加载完整历史（每次导出都主动来一下，确保数据可信）
                await exportHandlers.ensureFullHistory();
                const fileName = getExportFilename('md');
                const c = utils.historyCompleteness();
                if (!c.complete) logger.warn('导出 MD：加载后仍可能不完整', c);   // 只记录，不打断导出
                return utils.createBlobDownload(
                    state.convertedMd,
                    'text/markdown',
                    fileName
                );
            } catch (e) {
                logger.error('Markdown导出失败', e);
                utils.notify(`导出失败: ${e.message}`, { type: 'error' });
                return false;
            }
        },

        mdWithImages: async (withJson) => {
            if (!state.convertedMd) {
                utils.notify('还没有发现有效的对话记录。\n请等待目标响应或进行一些对话。', { type: 'warn' });
                return false;
            }
            try {
                // 导出文件名：不同入口靠"后缀 + 扩展名"区分
                //   JSON → .json ／ MD → .md ／ MD+图片 → .zip ／ 拉取并导出 → _全量.zip（内容范围不同，故额外标记）
                const nameSuffix = state._exportNameSuffix || '';
                state._exportNameSuffix = '';
                const baseName = getExportFilename().replace(/\.$/, '') + nameSuffix;
                const btn = document.getElementById('downloadMdImagesButton');
                // 兜底：从当前页面 DOM 扫描图片（JSON 收集可能漏掉未渲染/虚拟滚动的部分；
                // DeepSeek 的签名 state 只在渲染后的 <img src> 里，必须从 DOM 取）
                const convKey = getConversationKey(state.platformType, location.href);
                let domHost = '';
                // 注意：这里**不再**自动滚动页面（用户反馈"下载后又自动下拉"很干扰）。
                // 全量渲染改由独立入口「🖼️ 拉取全部」执行；没拉过就只导当前已累积的图，
                // 并在完成提示里明确告知可能缺图（宁可提示，也不偷偷滚动用户页面）。
                const pulledRecently = state.fullPullDoneAt && (Date.now() - state.fullPullDoneAt < 30 * 60 * 1000);
                if (!pulledRecently) {
                    logger.warn('本次未先执行「🖼️ 拉取全部」：只导出已累积的图，仅存在于 DOM 未渲染消息里的图可能缺失');
                }
                if (state.platformType === 'deepseek') {
                    // 优先从会话 JSON 抽取图片（signed_path 同源 /api，无 CORS/跨域问题）；DOM 扫描仅作兜底
                    const n = utils.collectDeepseekImagesFromJson(convKey, state.lastJsonData);
                    domHost = 'files.deepseeksvc.com';
                    utils.collectDomImages('deepseek', convKey, domHost);
                    logger.info(`DeepSeek 从 DOM 收集到 ${n} 张图片`);
                } else if (state.platformType === 'doubao') {
                    domHost = 'byteimg.com,tos-cn-';
                    const n = utils.collectDomImages('doubao', convKey, domHost);
                    logger.info(`豆包从 DOM 补充收集 ${n} 张图片`);
                }
                // ══════════════════════════════════════════════════════════════
                // 【图片取证 / _diagnostics.json】——独立机制，默认关闭
                // ──────────────────────────────────────────────────────────────
                // 作用：导出时额外附一份 _diagnostics.json 进 zip，内容＝页面全部 <img>/<canvas>
                //       的 host、尺寸、是否在聊天容器与消息项内；加上图库现状、每条消息的块类型与
                //       提取结果、_ROUTER_DATA 里的 creation 图。**仅用于「缺图」排查**。
                // 性质：纯只读快照——不参与图片收集/去重/定位，也不写任何 state。
                //       开关只影响两处：① zip 是否多一个 _diagnostics.json；
                //       ② 完成提示是否多一行「图片取证：…」。
                //       正文 / 图片 / 对话.json / files/ / 统计信息 行 一律不受影响。
                // 代价：关闭后 canvas 渲染图将「完全无记录」（它当前唯一的报告出口就是这里）。
                // 启用：把 ENABLE_DIAGNOSTICS 改回 true 即可（buildImageDiagnostics 定义已保留）。
                // ══════════════════════════════════════════════════════════════
                const ENABLE_DIAGNOSTICS = false;
                const extraFiles = [];
                let diagSummary = '';
                if (ENABLE_DIAGNOSTICS) {
                    try {
                        const diag = utils.buildImageDiagnostics();
                        diagSummary = diag.summary || '';
                        extraFiles.push({
                            name: '_diagnostics.json',
                            data: new TextEncoder().encode(JSON.stringify(diag, null, 2))
                        });
                        logger.info(`图片取证：${diagSummary}`);
                    } catch (e) {
                        logger.warn('取证生成失败', e);
                    }
                }
                // 历史不完整时只在提示里说明（不再往导出内容里插提示行 —— 三个入口都会先强制加载历史）
                if (btn) {
                    const origText = btn.innerText;
                    btn.innerHTML = '<span class="gm-spinner"></span>打包中...';
                    btn.disabled = true;
                    try {
                        await utils.exportMdWithImages(state.convertedMd, baseName, extraFiles, diagSummary, !!withJson, pulledRecently);
                    } finally {
                        btn.innerText = origText;
                        btn.disabled = false;
                    }
                } else {
                    await utils.exportMdWithImages(state.convertedMd, baseName, extraFiles, diagSummary, !!withJson, pulledRecently);
                }
                return true;
            } catch (e) {
                logger.error('MD+图片导出失败', e);
                utils.notify(`导出失败: ${e.message}`, { type: 'error' });
                return false;
            }
        }
    };

    // ============ 自动滚动加载全部历史记录 ============
    // 反复把聊天区域滚到顶部，触发平台去请求更早的轮次；
    // 通过“滚动高度”和“累积池消息数”是否还在增长来判断是否已加载完。
    const autoScroller = {
        running: false,
        stopRequested: false,

        sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),

        // 寻找聊天消息所在的滚动容器：可滚动、在视口内、面积够大、可滚动距离最长的元素
        findScrollContainer: () => {
            let best = null;
            let bestScore = 0;
            const elements = document.querySelectorAll('div, main, section, ul, ol');
            for (const el of elements) {
                const scrollable = el.scrollHeight - el.clientHeight;
                if (scrollable < 100) continue;
                const style = getComputedStyle(el);
                if (!/(auto|scroll|overlay)/.test(style.overflowY)) continue;
                const rect = el.getBoundingClientRect();
                if (rect.width < 250 || rect.height < 150) continue;
                if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
                const score = scrollable * Math.sqrt(rect.width * rect.height);
                if (score > bestScore) {
                    bestScore = score;
                    best = el;
                }
            }
            // 有些页面是整个窗口在滚动，作为兜底
            const root = document.scrollingElement;
            if (!best && root && root.scrollHeight - root.clientHeight > 100) {
                best = root;
            }
            return best;
        },

        start: async function(button) {
            // 运行中再点一次 = 请求停止
            if (this.running) {
                this.stopRequested = true;
                button.innerText = '⏹ 正在停止...';
                return;
            }

            let container = this.findScrollContainer();
            if (!container) {
                utils.notify('没有找到可滚动的聊天区域。\n请确认页面里已经打开了一个对话，且对话内容超过一屏。', { type: 'warn' });
                return;
            }

            this.running = true;
            this.stopRequested = false;
            const originalText = (button && button.innerText) ? button.innerText : '⬆️ 回到顶部·加载历史';
            button.style.backgroundColor = '#dc3545';
            logger.info('开始自动滚动加载历史记录...');

            let idleRounds = 0; // 连续无变化的轮数
            let rounds = 0;
            let lastHeight = container.scrollHeight;
            let lastCount = state.mergeStore.map.size;

            // 快速结束：已经到顶又没有新内容时不要空等。
            // 旧阈值 4 轮（4×800ms≈3.2s）会让"明明已经到对话开头"还多等三秒多。
            const IDLE_LIMIT = 2;
            while (!this.stopRequested && idleRounds < IDLE_LIMIT && rounds < 300) {
                // 页面重新渲染可能导致容器失效，重新查找
                if (!container.isConnected) {
                    container = this.findScrollContainer();
                    if (!container) break;
                }

                container.scrollTop = 0;
                // 有些虚拟列表靠wheel事件触发加载，补发一个向上滚动事件
                container.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true, cancelable: true }));

                await this.sleep(800); // 等待平台请求并渲染更早的消息
                rounds++;

                const height = container.scrollHeight;
                const count = state.mergeStore.map.size;
                if (height > lastHeight + 5 || count > lastCount) {
                    idleRounds = 0;
                } else {
                    idleRounds++;
                }
                // 已经在顶部（scrollTop 仍为 0）且这一轮什么都没变 → 不必再等下一轮
                if (idleRounds >= 1 && container.scrollTop === 0 && height <= lastHeight + 5 && count <= lastCount) {
                    idleRounds = IDLE_LIMIT;
                }
                lastHeight = height;
                lastCount = count;

                button.innerText = `⏳ 已捕获 ${count} 条（点击停止）`;
            }

            this.running = false;
            const finalCount = state.mergeStore.map.size;
            logger.info(`自动滚动结束：共捕获 ${finalCount} 条消息，滚动 ${rounds} 轮`);

            button.innerText = this.stopRequested ? `⏹ 已停止，共 ${finalCount} 条` : `✅ 完成，共 ${finalCount} 条`;
            button.style.backgroundColor = '#28a745';
            setTimeout(() => {
                button.innerText = originalText;
                button.style.backgroundColor = '#007bff';
            }, 4000);
        }
    };
    // ============ 自动滚动模块结束 ============

    // UI相关功能
    const ui = {
        updateButtonStatus: () => {
            const jsonButton = document.getElementById('downloadJsonButton');
            const mdButton = document.getElementById('downloadMdButton');
            const mdImagesButton = document.getElementById('downloadMdImagesButton');

            if (!jsonButton || !mdButton || !mdImagesButton) return;

            const hasResponse = state.targetResponse !== null;
            let platformName = 'AI对话';
            let statsText = '';

            try {
                const jsonData = JSON.parse(state.targetResponse || '{}');

                switch(state.platformType) {
                    case 'deepseek':
                        platformName = `DeepSeek_${jsonData.data?.biz_data?.chat_session?.title || 'deepseek-Chat'}`;
                        statsText = `Token用量: ${state.messageStats.totalTokens}`;
                        break;
                    case 'ncn':
                        platformName = `AI-N_${jsonData.data?.title || 'AI-Chat'}`;
                        statsText = `字数: ${state.messageStats.totalChars} | 附件: ${state.messageStats.fileCount}`;
                        break;
                    case 'yuanbao':
                        platformName = `Yuanbao_${jsonData.sessionTitle || jsonData.title || 'Yuanbao-Chat'}`;
                        statsText = `对话轮次: ${state.messageStats.convTurns} | 文件: ${state.messageStats.fileCount}`;
                        break;
                    case 'kimi':
                        platformName = `Kimi_${state.currentTitle}`;
                        statsText = `消息数: ${state.messageStats.convTurns} | 字数: ${state.messageStats.totalChars}`;
                        break;
                    case 'tongyi':
                        platformName = `Tongyi_${state.currentTitle}`;
                        statsText = `对话轮次: ${state.messageStats.convTurns} | 字数: ${state.messageStats.totalChars}`;
                        break;
                    case 'iflytek':
                        platformName = `xinghuo_${state.currentTitle}`;
                        statsText = `对话轮次: ${state.messageStats.convTurns} | 字数: ${state.messageStats.totalChars}`;
                        break;
                    case 'doubao':
                    case 'doubao_title':
                        platformName = state.currentTitle ||jsonData.downlink_body?.get_conv_info_downlink_body?.conversation_info?.name ||'豆包对话';
                        // 从 mergeStore 累积数据计算统计（加载全部后才准确）
                        if (state.mergeStore.map && state.mergeStore.map.size > 0) {
                            let mergeChars = 0;
                            let mergeFiles = 0;
                            state.mergeStore.map.forEach(msg => {
                                if (msg.content_block?.length) {
                                    msg.content_block.forEach(block => {
                                        const bt = block.block_type;
                                        if (bt === 10000) {
                                            let t = '';
                                            if (block.content_v2) {
                                                try {
                                                    const v2 = typeof block.content_v2 === 'string' ? JSON.parse(block.content_v2) : block.content_v2;
                                                    t = v2.text_block?.text || v2.text || '';
                                                } catch(e) {}
                                            }
                                            if (!t && block.content?.text_block?.text) t = block.content.text_block.text;
                                            if (!t && typeof block.content === 'string') t = block.content;
                                            mergeChars += (t || '').length;
                                        } else if (bt === 10052) {
                                            const atts = block.content?.attachment_block?.attachments;
                                            if (Array.isArray(atts)) mergeFiles += atts.length;
                                        } else if (bt === 2074) {
                                            mergeFiles += 1;
                                        }
                                    });
                                }
                            });
                            statsText = `消息数: ${state.mergeStore.map.size} | 字数: ${mergeChars} | 附件: ${mergeFiles}`;
                        } else {
                            statsText = state.platformType === 'doubao_title'
                                ? `对话数: ${state.messageStats.convTurns}`
                                : `消息数: ${state.messageStats.convTurns} | 字数: ${state.messageStats.totalChars} | 附件: ${state.messageStats.fileCount}`;
                        }
                        break;
                }
            } catch (e) {
                logger.error('更新按钮状态时解析JSON失败', e);
            }

            // 统计信息改用"唯一口径"：与导出完成提示里的数字完全一致
            // （用户反馈"悬浮显示"和"下载后顶部提示"要一致；原来悬浮里的「附件」只数对话附件块，与导出结果对不上）
            try {
                if ((state.platformType === 'doubao' || state.platformType === 'deepseek') && state.imageStore) {
                    statsText = utils.statsLine(state.fullPullDoneAt ? '（已拉取）' : '（未拉取⚠️）');
                }
            } catch (e) {}

            // 更新按钮状态和样式
            [jsonButton, mdButton, mdImagesButton].forEach(button => {
                button.style.backgroundColor = hasResponse ? '#28a745' : '#007bff';
                button.dataset.tooltip = `${platformName}数据已就绪\n${statsText}\n最后更新: ${state.lastUpdateTime}`;

                // 悬停效果
                button.onmouseenter = () => {
                    button.style.transform = 'translateY(-2px)';
                    button.style.boxShadow = '0 6px 8px rgba(0,0,0,0.15)';
                };
                button.onmouseleave = () => {
                    button.style.transform = '';
                    button.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)';
                };
            });

            // 特殊处理MD和MD+图片按钮
            mdButton.style.backgroundColor = state.convertedMd ? '#28a745' : '#007bff';
            mdImagesButton.style.backgroundColor = state.convertedMd ? '#28a745' : '#007bff';

            // 禁用状态
            jsonButton.disabled = !hasResponse;
            mdButton.disabled = !state.convertedMd;
            mdImagesButton.disabled = !state.convertedMd;
        },

        createDownloadButtons: () => {
            // 如果按钮已存在，则不再创建
            if (document.getElementById('downloadJsonButton')) return;

            const buttonContainer = document.createElement('div');
            buttonContainer.id = 'exportButtonsContainer';
            const loadAllButton = document.createElement('button');
            const jsonButton = document.createElement('button');
            const mdButton = document.createElement('button');
            const mdImagesButton = document.createElement('button');
            const batchTrialButton = document.createElement('button');

            // 容器样式
            Object.assign(buttonContainer.style, {
                position: 'fixed',
                top: '45%',
                right: '10px',
                zIndex: '9999',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                opacity: CONFIG.BUTTON_OPACITY,
                transition: 'opacity 0.3s ease',
                cursor: 'move'
            });

            // 按钮通用样式
            const buttonStyles = {
                padding: '8px 12px',
                backgroundColor: '#007bff',
                color: '#ffffff',
                border: 'none',
                borderRadius: '5px',
                cursor: 'pointer',
                transition: 'all 0.3s ease',
                fontFamily: 'Arial, sans-serif',
                boxShadow: '0 2px 5px rgba(0,0,0,0.2)',
                whiteSpace: 'nowrap',
                fontSize: '14px'
            };

            // 设置按钮属性和样式
            // ===== 四个入口（按工作流排序；主入口绿色加粗，会滚动页面的入口在 tooltip 里写明）=====
            // ① 回到顶部·加载历史（辅助：只滚页面、不产出文件）
            loadAllButton.id = 'loadAllHistoryButton';
            loadAllButton.innerText = '⬆️ 回到顶部·加载历史';
            loadAllButton.title = '滚到对话开头，让平台把更早的历史分页加载出来（只加载，不导出）。注意：会滚动页面';
            // ② 主入口：全量拉取并导出（沿用原 downloadMdImagesButton 的 id，进度/配色逻辑不变）
            mdImagesButton.id = 'downloadMdImagesButton';
            mdImagesButton.innerText = '⬇️ 全量拉取并导出';
            mdImagesButton.title = '一键到底：回到顶部加载历史 → 全量渲染整段对话 → 收集图片/附件 → 导出 zip（对话.md + 对话.json + images/ + files/）。30 分钟内已拉取过则跳过滚动直接导出。注意：首次会滚动页面';
            // ③④ 仅导出（不滚动页面）
            mdButton.id = 'downloadMdButton';
            mdButton.innerText = '📄 仅 MD';
            mdButton.title = '先自动回到顶部加载完整历史，再只导出 Markdown 文本（不含图片）。注意：会滚动页面';
            jsonButton.id = 'downloadJsonButton';
            jsonButton.innerText = '🗂️ 仅 JSON';
            jsonButton.title = '先自动回到顶部加载完整历史，再只导出会话原始 JSON（不含图片）。注意：会滚动页面';
            // ⑤ 批量导出：弹出多选面板，勾选任意个对话逐个自动导出
            batchTrialButton.id = 'batchTrialButton';
            batchTrialButton.innerText = '🧪 批量导出';
            batchTrialButton.title = '弹面板列出所有对话，勾选任意个，逐个全量拉取并导出 zip。串行处理、每会话约半分钟到 1 分钟。任务进行中再点＝停止。注意：需前台标签页，浏览器会提示"允许下载多个文件"';
            // 添加按钮的 classname
            [loadAllButton, jsonButton, mdButton, mdImagesButton, batchTrialButton].forEach(btn => {
                btn.className = 'export-button';
            });

            Object.assign(loadAllButton.style, buttonStyles);
            Object.assign(jsonButton.style, buttonStyles);
            Object.assign(mdButton.style, buttonStyles);
            Object.assign(mdImagesButton.style, buttonStyles);
            Object.assign(batchTrialButton.style, buttonStyles);
            batchTrialButton.style.opacity = '0.85';   // 实验入口视觉上压低
            // 主入口视觉突出（其余为辅助）
            mdImagesButton.style.fontWeight = 'bold';
            mdImagesButton.style.border = '2px solid #1e7e34';

            // 鼠标悬停效果
            buttonContainer.onmouseenter = () =>{
                buttonContainer.style.opacity = CONFIG.BUTTON_HOVER_OPACITY;
                buttonContainer.style.boxShadow = '0 8px 16px rgba(0,0,0,0.15)';
            };
            buttonContainer.onmouseleave = () =>{
                buttonContainer.style.opacity = CONFIG.BUTTON_OPACITY;
                buttonContainer.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)';
            }


            // 拖动功能
            let isDragging = false;
            let initialX, initialY, xOffset = 0, yOffset = 0;

            buttonContainer.addEventListener('mousedown', (e) => {
                initialX = e.clientX - xOffset;
                initialY = e.clientY - yOffset;
                if (e.target === buttonContainer) {
                    isDragging = true;
                }
            });

            document.addEventListener('mousemove', (e) => {
                if (isDragging) {
                    e.preventDefault();
                    xOffset = e.clientX - initialX;
                    yOffset = e.clientY - initialY;
                    buttonContainer.style.transform = `translate(${xOffset}px, ${yOffset}px)`;
                }
            });

            document.addEventListener('mouseup', () => {
                isDragging = false;
            });

            // 阻止按钮的 mousedown 冒泡影响拖动
            [loadAllButton, jsonButton, mdButton, mdImagesButton, batchTrialButton].forEach(btn => {
                btn.addEventListener('mousedown', (e) => e.stopPropagation());
            });

            // 按钮点击事件
            loadAllButton.onclick = () => autoScroller.start(loadAllButton);
            mdImagesButton.onclick = () => exportHandlers.pullAll(false);   // 主入口：全量拉取并导出
            mdButton.onclick = exportHandlers.markdown;
            jsonButton.onclick = exportHandlers.json;
            batchTrialButton.onclick = () => batchPicker.open();            // 实验：多选后批量导出

            // 组装按钮（顺序 = 工作流顺序：回到顶部 → 全量拉取并导出 → 仅 MD → 仅 JSON → 批量导出）
            buttonContainer.appendChild(loadAllButton);
            buttonContainer.appendChild(mdImagesButton);
            buttonContainer.appendChild(mdButton);
            buttonContainer.appendChild(jsonButton);
            buttonContainer.appendChild(batchTrialButton);
            document.body.appendChild(buttonContainer);

            // 自动折叠/展开功能
            let isCollapsed = false;
            let collapseTimeout;
            const collapseDelay = 2000; // 2秒后自动折叠

            // 自动折叠函数
            const autoCollapse = () => {
                collapseTimeout = setTimeout(() => {
                    // 自动滚动加载进行中时保持展开，方便查看进度
                    if (autoScroller.running) {
                        autoCollapse();
                        return;
                    }
                    buttonContainer.classList.add('collapsed');
                    isCollapsed = true;
                }, collapseDelay);
            };

            // 初始设置自动折叠
            autoCollapse();

            // 鼠标进入展开
            buttonContainer.addEventListener('mouseenter', () => {
                clearTimeout(collapseTimeout);
                if (isCollapsed) {
                    buttonContainer.classList.remove('collapsed');
                    isCollapsed = false;
                }
            });

            // 鼠标离开后延迟折叠
            buttonContainer.addEventListener('mouseleave', () => {
                if (!isCollapsed) {
                    autoCollapse();
                }
            });

            // 点击折叠按钮也可展开
            buttonContainer.addEventListener('click', (e) => {
                if (isCollapsed && e.target === buttonContainer) {
                    buttonContainer.classList.remove('collapsed');
                    isCollapsed = false;
                    clearTimeout(collapseTimeout);
                }
            });

            // 确保拖动时不折叠
            buttonContainer.addEventListener('mousedown', () => {
                clearTimeout(collapseTimeout);
            });

            // 添加加载动画样式
            GM_addStyle(`
               .export-button {
                transition: all 0.2s ease;
                }
                .export-button:hover {
                background-color: #0056b3 !important;
               }
                .export-button:disabled {
                    opacity: 0.6;
                    cursor: not-allowed;
                    background-color: #6c757d !important;
                }
                .gm-spinner {
                    border: 2px solid rgba(255,255,255,0.3);
                    border-radius: 50%;
                    border-top-color: #fff;
                    width: 12px;
                    height: 12px;
                    animation: spin ${CONFIG.SPINNER_ANIMATION_DURATION} linear infinite;
                    display: inline-block;
                    margin-right: 8px;
                    vertical-align: middle;
                }
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                    /* 添加折叠/展开相关样式 */
                #exportButtonsContainer.collapsed {
                    width: 40px;
                    height: 40px;
                    overflow: hidden;
                    padding: 5px;
                }

                #exportButtonsContainer.collapsed .export-button {
                    display: none;
                }

                #exportButtonsContainer.collapsed::before {
                    content: "↓↓↓";
                    position: absolute;
                    width: 30px;
                    height: 30px;
                    background: #007bff;
                    color: white;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 16px;

                    cursor: pointer;
                    box-shadow: 0 2px 5px rgba(0,0,0,0.2);
                }

                #exportButtonsContainer:not(.collapsed)::before {
                    display: none;
                }

                #exportButtonsContainer {
                    transition: all 0.3s ease;
                }
                /* 标题相关样式 */
                [data-tooltip] {
                    position: relative;
                }

                [data-tooltip]:hover::after {
                    content: attr(data-tooltip);
                    position: absolute;
                    right: 100%;
                    top: 50%;
                    transform: translateY(-50%);
                    background:rgba(228,17,136,0.7);
                    color: #fff;
                    padding: 8px 12px;
                    border-radius: 4px;
                    font-size: 16px;
                    font-family: "方正小标宋简体","黑体", Arial, sans-serif;
                    white-space: pre;
                    margin-right: 10px;
                    pointer-events: none;
                    opacity: 0.1;
                    transition: opacity 0.3s;
                }

                [data-tooltip]:hover::after {
                    opacity: 1;
                }
            `);

            ui.updateButtonStatus();
        }
    };

    // 网络拦截
    function setupNetworkInterception() {
        // DeepSeek 会话相关请求的取证记录（去重、上限 60）
        const recordNetUrl = (u) => {
            try {
                if (!u || !/deepseek/.test(location.host)) return;
                const s = String(u);
                if (!/(session|conv|chat)/i.test(s)) return;
                const key = s.slice(0, 200);
                if (state.netLog.indexOf(key) === -1) {
                    state.netLog.push(key);
                    if (state.netLog.length > 60) state.netLog.shift();
                }
            } catch (e) {}
        };
        // 拦截XHR请求
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(...args) {
            // 处理缓存参数
            if (args[1]?.includes('history_messages?chat_session_id')) {
                args[1] = args[1].split('&cache_version=')[0];
            } else if (args[1]?.includes('conversation/info?conversation_id')) {
                args[1] = args[1].split('&cache_version=')[0];
            } else if (args[1]?.includes('/api/user/agent/conversation/v1/detail')) {
                args[1] = args[1].split('&cacheBust=')[0];
            }

            this._requestURL = args[1];
            const url = args[1];
            //console.log('XHR.open被调用:', url);

            this.addEventListener('load', () => {
                if (this.responseURL) {
                    recordNetUrl(this.responseURL);
                    // 会话列表接口：只缓存原始响应（批量枚举用），不进对话解析流程
                    if (/\/im\/chain\/recent_conv/.test(this.responseURL)) { captureConvList(this.responseText); return; }
                    // DeepSeek 会话列表接口：URL 含 chat_session 但不是消息历史（chat_session_id=）
                    if (/deepseek/.test(location.host) && /chat_session/.test(this.responseURL)
                        && !/chat_session_id=/.test(this.responseURL)) {
                        captureConvList(this.responseText, 'deepseek'); return;
                    }
                    //console.log('XHR请求完成:', this.responseURL); // 添加调试
                    for (const [platform, pattern] of Object.entries(PLATFORM_PATTERNS)) {
                        if (pattern.test(this.responseURL)) {
                            processTargetResponse(this.responseText, this.responseURL);
                            break;
                        }
                    }
                }
            });

            originalOpen.apply(this, args);
        };

        // 拦截Fetch请求
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
            const url = args[0] instanceof Request ? args[0].url : args[0];
            let response;
            //console.log('🔍 Fetch请求被调用:', url);
            //console.log('⏰ 时间线调试 - 脚本启动:', performance.now());

            try {
                response = await originalFetch.apply(this, args);

                if (typeof url === 'string') {
                    recordNetUrl(url);
                    // 会话列表接口：只缓存原始响应（批量枚举用）
                    if (/\/im\/chain\/recent_conv/.test(url)) {
                        const ct2 = response.headers.get('content-type');
                        if (ct2 === null || ct2 === void 0 ? void 0 : ct2.includes('application/json')) {
                            response.clone().text().then(t => captureConvList(t)).catch(() => {});
                        }
                        return response;
                    }
                    // DeepSeek 会话列表接口（同上）
                    if (/deepseek/.test(location.host) && /chat_session/.test(url) && !/chat_session_id=/.test(url)) {
                        const ct3 = response.headers.get('content-type');
                        if (ct3 === null || ct3 === void 0 ? void 0 : ct3.includes('application/json')) {
                            response.clone().text().then(t => captureConvList(t, 'deepseek')).catch(() => {});
                        }
                        return response;
                    }
                    for (const [platform, pattern] of Object.entries(PLATFORM_PATTERNS)) {
                        if (pattern.test(url)) {
                            const contentType = response.headers.get('content-type');
                            if (contentType?.includes('application/json')) {
                                const clonedResponse = response.clone();
                                clonedResponse.text().then(text => {
                                    processTargetResponse(text, url);
                                }).catch(e => {
                                    logger.error(`解析fetch响应文本时出错`, { url, error: e });
                                });
                            }
                            break;
                        }
                    }
                }
            } catch (error) {
                logger.error('Fetch请求失败', error);
                throw error;
            }

            return response;
        };
    }

    setupNetworkInterception();
    setupAuthInterceptor(); // Kimi标题授权拦截器

    // ============ 批量导出：自动换对话、逐个拉取并导出 ============
    // 为什么用"整页跳转 + sessionStorage 队列"：换对话最稳的方式就是直接改 location，
    // 但整页刷新会丢内存状态，所以队列（只含会话 ID/标题/进度，不含任何对话内容）存 sessionStorage。
    // 轻量 & 低泄露：全部在本页内完成，只与本平台同源通信；队列随标签页关闭自动消失。
    const BATCH_KEY = 'aiChatExport.batch.v1';
    const batchHelper = {
        load: () => { try { return JSON.parse(sessionStorage.getItem(BATCH_KEY) || 'null'); } catch (e) { return null; } },
        save: (o) => { try { sessionStorage.setItem(BATCH_KEY, JSON.stringify(o)); } catch (e) {} },
        clear: () => { try { sessionStorage.removeItem(BATCH_KEY); } catch (e) {} },

        // 从 URL 取会话 id（豆包：/chat/<id> 或 /chat/bot/chat/<id>；DeepSeek：/a/chat/s/<uuid>）
        convIdFromUrl: (url) => {
            try {
                const s = String(url || location.href);
                let m = s.match(/\/a\/chat\/s\/([A-Za-z0-9_-]{6,})/);        // DeepSeek
                if (m) return m[1];
                m = s.match(/\/chat\/(?:bot\/chat\/)?([A-Za-z0-9_-]{6,})/);  // 豆包
                return m ? m[1] : '';
            } catch (e) { return ''; }
        },

        // 侧栏条目标题：优先 title 属性；否则取叶子文本节点并「去掉相邻重复」。
        // 豆包侧栏会把标题渲染成两份文本节点，直接 a.textContent 会得到 "标题标题"。
        // 按叶子逐个拼接（不加分隔符）＝保留旧 textContent 的拼接语义，只去掉相邻重复副本。
        anchorTitleOf: (a) => {
            const attr = a.getAttribute('title');
            if (attr && attr.trim()) return attr.replace(/\s+/g, ' ').trim();
            const parts = [];
            const visit = (n) => {
                if (n.nodeType === 3) {
                    const t = String(n.nodeValue || '').replace(/\s+/g, ' ').trim();
                    if (t && parts[parts.length - 1] !== t) parts.push(t);
                    return;
                }
                if (n.nodeType !== 1) return;
                for (const ch of n.childNodes) visit(ch);
            };
            try { visit(a); } catch (e) {}
            return parts.join('').trim();
        },

        // 按平台拼会话页 URL（批量跳转用）
        convUrlOf: (id, platform) => {
            const p = platform || state.platformType || '';
            if (p === 'deepseek') return location.origin + '/a/chat/s/' + id;
            return location.origin + '/chat/' + id;
        },

        // 从被拦截的会话列表接口响应里取会话（cells[].conversation）
        fromRecentConv: (raw) => {
            const out = [];
            try {
                const cells = raw?.downlink_body?.pull_recent_conv_chain_downlink_body?.cells || [];
                cells.forEach(c => {
                    const conv = c?.conversation || {};
                    const id = conv.conversation_id || '';
                    if (!id || out.some(x => x.id === id)) return;
                    let title = conv.name || '';
                    if (!title) { // 没标题就用首条用户消息（与平台列表页做法一致）
                        const m = (conv.messages || []).find(x => x.user_type === 1);
                        const blk = (m?.content_block || []).find(b => b.block_type === 10000);
                        title = blk?.content?.text_block?.text || '';
                    }
                    const type = conv.conversation_type;
                    const path = (type === 5) ? `/chat/bot/chat/${id}` : `/chat/${id}`;
                    out.push({ id, title: String(title || id).replace(/\s+/g, ' ').trim().slice(0, 40), url: location.origin + path });
                });
            } catch (e) {}
            return out;
        },

        // 兜底：从侧栏 DOM 取会话链接（严格按侧栏真实顺序）
        fromSidebarDom: () => {
            const out = [];
            try {
                // 只在文档里全局抓 a[href*="/chat/"] 会混进正文里的「相关对话」等链接，
                // 顺序自然和左侧侧栏对不上。这里先锁定「侧栏列表容器」＝这些链接最近的、可滚动的共同祖先。
                const all = [...document.querySelectorAll('a[href*="/chat/"]')];
                let container = null;
                if (all.length) {
                    const counts = new Map();
                    all.forEach(a => {
                        let el = a.parentElement;
                        while (el) {
                            let scrollable = false;
                            try {
                                const cs = getComputedStyle(el);
                                scrollable = /(auto|scroll)/.test(cs.overflowY);
                            } catch (e) {}
                            if (scrollable) { counts.set(el, (counts.get(el) || 0) + 1); break; }
                            el = el.parentElement;
                        }
                    });
                    counts.forEach((n, el) => { if (!container || n > (counts.get(container) || 0)) container = el; });
                }
                const scope = container || document;
                // querySelectorAll 返回文档顺序＝视觉顺序，正是用户看到的排列
                [...scope.querySelectorAll('a[href*="/chat/"]')].forEach(a => {
                    const href = a.getAttribute('href') || a.href || '';
                    const id = batchHelper.convIdFromUrl(href);
                    if (!id || out.some(x => x.id === id)) return;
                    const title = batchHelper.anchorTitleOf(a);
                    out.push({ id, title: (title || id).slice(0, 40), url: a.href || (location.origin + href) });
                });
            } catch (e) {}
            return out;
        },

        // cells → 会话数组（列表接口的单页解析）
        cellsToConvs: (cells) => {
            const out = [];
            try {
                (cells || []).forEach(c => {
                    const conv = c?.conversation || {};
                    const id = conv.conversation_id || '';
                    if (!id || out.some(x => x.id === id)) return;
                    let title = conv.name || '';
                    if (!title) { // 没标题就用首条用户消息（与平台列表页做法一致）
                        const m = (conv.messages || []).find(x => x.user_type === 1);
                        const blk = (m?.content_block || []).find(b => b.block_type === 10000);
                        title = blk?.content?.text_block?.text || '';
                    }
                    const type = conv.conversation_type;
                    const path = (type === 5) ? `/chat/bot/chat/${id}` : `/chat/${id}`;
                    out.push({ id, title: String(title || id).replace(/\s+/g, ' ').trim().slice(0, 40), url: location.origin + path });
                });
            } catch (e) {}
            return out;
        },

        // 通用容错解析：递归遍历任意 JSON，找出形如 { id/session_id/conversation_id, title/name }
        // 的会话对象。DeepSeek 等平台的列表接口 schema 未固定，写死结构极易失效；这里用「UUID 形状的
        // id + 非空 title」两条硬约束来锁定会话，避开消息(message_id)/文件(file_name) 等干扰项。
        fromAnyJson: (raw, platform) => {
            const out = [];
            const seen = new Set();
            const isIdLike = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,}$/.test(v);
            const walk = (node, depth) => {
                if (!node || depth > 6 || out.length >= 300) return;
                if (Array.isArray(node)) { node.forEach(n => walk(n, depth + 1)); return; }
                if (typeof node !== 'object') return;
                const id = node.id ?? node.session_id ?? node.sessionId ?? node.conversation_id ?? node.chat_session_id;
                const title = node.title ?? node.name ?? node.session_title ?? node.conversation_title;
                if (isIdLike(id) && typeof title === 'string' && title.trim()) {
                    const sid = String(id);
                    if (!seen.has(sid)) {
                        seen.add(sid);
                        out.push({
                            id: sid,
                            title: title.replace(/\s+/g, ' ').trim().slice(0, 40) || sid,
                            url: batchHelper.convUrlOf(sid, platform)
                        });
                    }
                }
                for (const k of Object.keys(node)) {
                    const v = node[k];
                    if (v && typeof v === 'object') walk(v, depth + 1);
                }
            };
            try { walk(raw, 0); } catch (e) {}
            return out;
        }
    };

    const batchRunner = {
        // 2026-10-05：放开数量限制（原试跑版上限 3）。串行处理每个会话（整页跳转），
        // 每会话约半分钟到 1 分钟，勾选越多总时长越长，且需保持标签页在前台。

        // 列表来源：以侧栏 DOM 顺序为主（＝用户实际看到的顺序），接口累计数据只补侧栏未渲染的。
        // 旧实现反过来：接口 cells 在前、DOM 兜底追加。接口 recent_conv 的返回顺序与侧栏并不一致
        // （用户反馈"没规律地对不上"），所以把权威顺序交给侧栏 DOM。
        listConversations: () => {
            const out = [];
            const seen = new Set();
            batchHelper.fromSidebarDom().forEach(c => {
                if (c && c.id && !seen.has(c.id)) { seen.add(c.id); out.push(c); }
            });
            try {
                state.recentConvCells.forEach((conv, id) => {
                    if (!id || seen.has(id)) return;
                    seen.add(id);
                    out.push(conv);
                });
            } catch (e) {}
            return out;
        },

        // 用选中的会话启动队列（由多选面板调用）
        startWith: (selected) => {
            const list = (selected || []);
            if (!list.length) { utils.notify('请先勾选要导出的对话。', { type: 'warn' }); return; }
            if (list.length >= 2) {
                // 批量＝整页跳转后「自动」下载，没有用户手势。Chromium 会拦掉第 2 个及以后的下载
                // （用户看到的就是"卡死在浏览器禁止下载"）。这里趁用户刚点按钮、手势还有效时，
                // 主动连发 2 个极小的探测文件，把浏览器的「允许多文件下载」提示逼出来，当场授权。
                utils.notify(`即将串行导出 ${list.length} 个对话（每个约半分钟到 1 分钟，全程请保持页面在前台）。\n`
                    + '会连续下载多个文件，若浏览器弹出「是否允许下载多个文件」，请点击「允许」；\n'
                    + '否则后续下载会被拦截，批量会停在半路。', { duration: 0 });
                batchRunner.primeDownloads();
            }
            batchHelper.save({ queue: list, idx: 0, done: [], failed: [], ts: Date.now() });
            batchRunner.gotoNext();
        },

        // 主动触发浏览器「允许多文件下载」授权：两个极小文件，可随手删除。
        // 站点一旦授权过一次，后续无手势的自动下载就会被放行。
        // 两个文件必须「同一次用户手势内同步连发」：若第二个用 setTimeout 延迟发出，
        // 就脱离了手势窗口，未授权站点（如 DeepSeek）会直接拦掉第二个（只出 _1）。
        primeDownloads: () => {
            // 探测文件名挂平台后缀（2026-10-11 用户反馈）：多平台各批量导出一次，就会各留两个
            // 同名探测文件互相冲突（浏览器只能存成 (1) 副本），挂平台一眼可分。
            const tag = utils.platformTag();
            const mk = (i) => utils.createBlobDownload(
                '批量导出前的一次性授权探测文件，可删除。\n（用于触发浏览器"允许多文件下载"，本批次会连续下载多个 md/zip）\n',
                'text/plain', utils.nameWithPlatform(`_批量导出授权探测_${i}.txt`, tag));
            try { mk(1); } catch (e) {}
            try { mk(2); } catch (e) {}
        },

        gotoNext: () => {
            const b = batchHelper.load();
            if (!b) return;
            if (b.idx >= b.queue.length) { batchRunner.finish(); return; }
            const t = b.queue[b.idx];
            logger.info(`批量：前往第 ${b.idx + 1}/${b.queue.length} 个对话「${t.title}」`);
            location.href = t.url;
        },

        // 页面加载后调用：若当前页正是队列里等待的那个，就跑一次全量拉取并导出
        maybeContinue: async () => {
            const b = batchHelper.load();
            if (!b) return;
            utils.notify();   // 换页后续跑：清掉上一页残留的顶部提示
            const btn = document.getElementById('batchTrialButton');
            if (b.idx >= b.queue.length) { batchRunner.finish(); return; }
            const t = b.queue[b.idx];
            const curId = batchHelper.convIdFromUrl(location.href);
            if (btn) btn.innerText = `🧪 批量 ${b.idx + 1}/${b.queue.length}`;
            // 顶部进度栏（常驻）：页面跳转后由本页重新设置，随会话推进更新；批量结束由 finish 汇总接管
            utils.notify(`⏳ 批量导出 ${b.idx + 1}/${b.queue.length}：「${t.title}」— 拉取并导出中…（全部完成后自动关闭）`, { duration: 0 });
            if (curId !== t.id) {
                logger.info(`批量：当前页(${curId || '未知'}) 不是队列中的「${t.title}」，等待`);
                return;
            }
            logger.info(`批量：处理第 ${b.idx + 1}/${b.queue.length} 个「${t.title}」`);
            const t0 = Date.now();
            while (Date.now() - t0 < 30000) {   // 等页面把会话数据加载出来
                if (state.convertedMd && state.lastJsonData) break;
                await new Promise(r => setTimeout(r, 500));
            }
            try {
                if (!state.convertedMd) throw new Error('页面数据未加载出来（30s 超时）');
                await exportHandlers.pullAll(true);   // 强制全量（不吃"30 分钟内跳过"）
                const b2 = batchHelper.load() || b;
                b2.done.push(t);
                b2.idx++;
                batchHelper.save(b2);
                utils.notify(`✅ 批量导出 ${b2.idx}/${b2.queue.length}：「${t.title}」完成 — 继续下一个…`, { duration: 0 });
            } catch (e) {
                logger.error('批量：该对话处理失败，跳过', e);
                const b3 = batchHelper.load() || b;
                b3.failed.push({ id: t.id, title: t.title, reason: String((e && e.message) || e) });
                b3.idx++;
                batchHelper.save(b3);
                utils.notify(`⚠️ 批量导出：已跳过「${t.title}」（${String((e && e.message) || e)}）— 继续…`, { type: 'warn', duration: 0 });
            }
            await new Promise(r => setTimeout(r, 1500));  // 给浏览器一点时间完成下载
            batchRunner.gotoNext();
        },

        finish: () => {
            const b = batchHelper.load();
            batchHelper.clear();
            utils.notify();   // 清掉上一页残留的提示，避免多页批量时顶部堆叠
            const btn = document.getElementById('batchTrialButton');
            if (btn) btn.innerText = '🧪 批量导出';
            const done = (b && b.done) || [];
            const failed = (b && b.failed) || [];
            utils.notify(`批量导出结束：成功 ${done.length} 个、失败 ${failed.length} 个。\n`
                + (failed.length ? '失败：\n' + failed.map(f => `· ${f.title}（${f.reason}）`).join('\n') : ''),
                { type: failed.length ? 'error' : 'ok' });
            logger.info('批量导出结束', { done, failed });
        }
    };

    // ============ 多选面板：列出所有对话，勾选任意个 ============
    // 为什么不再"自动挑前 3 个"：用户反馈不可控 —— 应该让人自己看清标题再选。
    const batchPicker = {
        el: null,
        selected: [],

        open: () => {
            if (batchHelper.load()) {   // 已有批量任务在跑 → 提供停止
                batchPicker.askStop();
                return;
            }
            const list = batchRunner.listConversations();
            batchPicker.selected = [];
            batchPicker.render(list);
        },

        // 非阻塞确认：已有队列时询问是否停止（替代原生 confirm，避免冻结悬浮按钮文字）
        askStop: () => {
            batchPicker.close();
            const box = document.createElement('div');
            Object.assign(box.style, {
                position: 'fixed', inset: '0', background: 'rgba(0,0,0,.35)',
                zIndex: '2147483600', display: 'flex', alignItems: 'center', justifyContent: 'center'
            });
            const panel = document.createElement('div');
            Object.assign(panel.style, {
                width: '380px', maxWidth: '92vw', background: '#fff', borderRadius: '10px',
                padding: '16px', font: '13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif',
                color: '#222', boxShadow: '0 12px 40px rgba(0,0,0,.28)'
            });
            const p = document.createElement('div');
            p.style.marginBottom = '14px';
            p.innerText = '已有批量任务在队列中。是否停止并清空队列？';
            const btns = document.createElement('div');
            Object.assign(btns.style, { display: 'flex', gap: '10px', justifyContent: 'flex-end' });
            const noBtn = document.createElement('button');
            noBtn.innerText = '继续跑';
            Object.assign(noBtn.style, { padding: '6px 14px', cursor: 'pointer' });
            noBtn.onclick = batchPicker.close;
            const yesBtn = document.createElement('button');
            yesBtn.innerText = '停止并清空';
            Object.assign(yesBtn.style, {
                padding: '6px 14px', cursor: 'pointer', background: '#dc3545', color: '#fff',
                border: '1px solid #b02a37', borderRadius: '4px', fontWeight: 'bold'
            });
            yesBtn.onclick = () => {
                batchHelper.clear();
                batchPicker.close();
                utils.notify();
                utils.notify('已停止批量任务。');
            };
            btns.appendChild(noBtn); btns.appendChild(yesBtn);
            panel.appendChild(p); panel.appendChild(btns);
            box.appendChild(panel);
            box.onclick = (e) => { if (e.target === box) batchPicker.close(); };
            document.body.appendChild(box);
            batchPicker.el = box;
        },

        close: () => { try { batchPicker.el && batchPicker.el.remove(); } catch (e) {} batchPicker.el = null; },

        render: (list) => {
            batchPicker.close();
            const box = document.createElement('div');
            box.id = 'aiExportBatchPicker';
            Object.assign(box.style, {
                position: 'fixed', inset: '0', background: 'rgba(0,0,0,.35)',
                zIndex: '2147483600', display: 'flex', alignItems: 'center', justifyContent: 'center'
            });
            const panel = document.createElement('div');
            Object.assign(panel.style, {
                width: '560px', maxWidth: '92vw', maxHeight: '80vh', background: '#fff',
                borderRadius: '10px', display: 'flex', flexDirection: 'column',
                font: '13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif',
                color: '#222', boxShadow: '0 12px 40px rgba(0,0,0,.28)'
            });
            // 头部
            const head = document.createElement('div');
            Object.assign(head.style, { padding: '12px 16px', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', gap: '8px' });
            head.innerHTML = `<b style="flex:1">批量导出（勾选任意个，逐个串行）</b>`;
            const closeBtn = document.createElement('button');
            closeBtn.innerText = '✕';
            Object.assign(closeBtn.style, { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '15px' });
            closeBtn.onclick = batchPicker.close;
            head.appendChild(closeBtn);
            // 工具条
            const bar = document.createElement('div');
            Object.assign(bar.style, { padding: '8px 16px', borderBottom: '1px solid #f2f2f2', display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px', color: '#666' });
            const countSpan = document.createElement('span');
            countSpan.style.flex = '1';
            const refreshBtn = document.createElement('button');
            refreshBtn.innerText = '重新读取列表';
            Object.assign(refreshBtn.style, { padding: '3px 10px', cursor: 'pointer' });
            refreshBtn.onclick = () => batchPicker.render(batchRunner.listConversations());
            const clearBtn = document.createElement('button');
            clearBtn.innerText = '清空选择';
            Object.assign(clearBtn.style, { padding: '3px 10px', cursor: 'pointer' });
            clearBtn.onclick = () => { batchPicker.selected = []; batchPicker.render(list); };
            // 全选（2026-10-11 用户反馈：逐个勾选太麻烦）。范围与下方列表渲染一致（最多 300 个）。
            const allBtn = document.createElement('button');
            allBtn.innerText = '全选';
            allBtn.title = '选中当前列表全部对话（最多显示 300 个）；再点一次可取消全选';
            Object.assign(allBtn.style, { padding: '3px 10px', cursor: 'pointer' });
            allBtn.onclick = () => {
                const all = list.slice(0, 300);
                const isAll = all.length && all.every(c => batchPicker.selected.some(x => x.id === c.id));
                batchPicker.selected = isAll ? [] : all.slice();
                batchPicker.render(list);
            };
            bar.appendChild(countSpan); bar.appendChild(allBtn); bar.appendChild(refreshBtn); bar.appendChild(clearBtn);
            // 列表
            const listBox = document.createElement('div');
            Object.assign(listBox.style, { overflow: 'auto', flex: '1', padding: '6px 0' });
            const updateCount = () => {
                countSpan.innerText = `已选 ${batchPicker.selected.length}　共 ${list.length} 个对话`;
            };
            if (!list.length) {
                const empty = document.createElement('div');
                empty.style.padding = '18px 16px';
                empty.style.color = '#888';
                empty.innerText = '没读到会话列表。\n请在当前平台的「对话列表」页打开本面板（或先在侧栏滚动几下让列表加载），再点「重新读取列表」。';
                empty.style.whiteSpace = 'pre-line';
                listBox.appendChild(empty);
            }
            list.slice(0, 300).forEach(c => {
                const row = document.createElement('label');
                Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 16px', cursor: 'pointer' });
                row.onmouseenter = () => { row.style.background = '#f7f7f7'; };
                row.onmouseleave = () => { row.style.background = ''; };
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = batchPicker.selected.some(x => x.id === c.id);
                cb.onchange = () => {
                    if (cb.checked) {
                        batchPicker.selected.push(c);
                    } else {
                        batchPicker.selected = batchPicker.selected.filter(x => x.id !== c.id);
                    }
                    updateCount();
                };
                const span = document.createElement('span');
                span.innerText = c.title || c.id;
                span.style.flex = '1';
                span.style.overflow = 'hidden';
                span.style.textOverflow = 'ellipsis';
                span.style.whiteSpace = 'nowrap';
                const idSpan = document.createElement('span');
                idSpan.innerText = c.id.slice(0, 8);
                idSpan.style.color = '#bbb';
                idSpan.style.fontSize = '11px';
                row.appendChild(cb); row.appendChild(span); row.appendChild(idSpan);
                listBox.appendChild(row);
            });
            updateCount();
            // 底部
            const foot = document.createElement('div');
            Object.assign(foot.style, { padding: '10px 16px', borderTop: '1px solid #eee', display: 'flex', gap: '10px', alignItems: 'center' });
            const tip = document.createElement('span');
            tip.style.flex = '1';
            tip.style.fontSize = '12px';
            tip.style.color = '#888';
            tip.innerText = '会逐个打开对话自动导出；每个约 10–60 秒，请保持本标签页在前台，浏览器会提示"允许下载多个文件"。进度会显示在页面顶部，全部完成后自动关闭并给出成功/失败汇总。';
            const cancelBtn = document.createElement('button');
            cancelBtn.innerText = '取消';
            Object.assign(cancelBtn.style, { padding: '6px 14px', cursor: 'pointer' });
            cancelBtn.onclick = batchPicker.close;
            const okBtn = document.createElement('button');
            okBtn.innerText = '开始导出';
            Object.assign(okBtn.style, { padding: '6px 16px', cursor: 'pointer', background: '#28a745', color: '#fff', border: '1px solid #1e7e34', borderRadius: '4px', fontWeight: 'bold' });
            okBtn.onclick = () => {
                if (!batchPicker.selected.length) { utils.notify('请先勾选要导出的对话。', { type: 'warn' }); return; }
                batchPicker.close();
                batchRunner.startWith(batchPicker.selected.slice());
            };
            foot.appendChild(tip); foot.appendChild(cancelBtn); foot.appendChild(okBtn);
            panel.appendChild(head); panel.appendChild(bar); panel.appendChild(listBox); panel.appendChild(foot);
            box.appendChild(panel);
            box.onclick = (e) => { if (e.target === box) batchPicker.close(); };   // 点遮罩关闭
            document.body.appendChild(box);
            batchPicker.el = box;
        }
    };

    // 会话列表接口（批量枚举用；只做累计缓存，不参与对话解析）
    // 豆包＝固定结构（cells[].conversation）；其余平台（DeepSeek 等）schema 未固定，走 fromAnyJson 容错提取。
    function captureConvList(text, platform) {
        try {
            const raw = JSON.parse(text);
            if (!state.recentConvCells) state.recentConvCells = new Map();
            const add = (c) => { if (c && c.id && !state.recentConvCells.has(c.id)) state.recentConvCells.set(c.id, c); };
            const cells = raw?.downlink_body?.pull_recent_conv_chain_downlink_body?.cells || [];
            batchHelper.cellsToConvs(cells).forEach(add);
            // 豆包固定结构的 cells 非空 → 不再跑通用解析，避免误把响应里的其他对象当会话。
            if (!cells.length) {
                const plat = platform || state.platformType || (/deepseek/.test(location.host) ? 'deepseek' : '');
                batchHelper.fromAnyJson(raw, plat).forEach(add);
            }
        } catch (e) {}
    }

    // 初始化
    function initialize() {
       // setupNetworkInterception();
        ui.createDownloadButtons();
        logger.info('增强版导出脚本已启动');

        // 批量任务续跑（若队列里有等待的对话）
        try { setTimeout(() => { batchRunner.maybeContinue(); }, 3000); } catch (e) {}

        // 使用MutationObserver确保按钮存在
        const observer = new MutationObserver((mutations) => {
            if (!document.getElementById('downloadJsonButton') ||
                !document.getElementById('downloadMdButton')) {
                logger.info('检测到按钮丢失，正在重新创建...');
                ui.createDownloadButtons();
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    // 页面加载完成后初始化
    if (document.readyState === 'complete') {
        initialize();
    } else {
        window.addEventListener('load', initialize);
    }
})();