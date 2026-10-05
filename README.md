# AI对话导出增强版（ai-chat-exporter-plus）

多平台 AI 对话导出油猴脚本：把豆包 / DeepSeek / Kimi / 通义千问 / 讯飞星火 / 腾讯元宝 / 纳米 AI 的对话导出为 Markdown，图片下载本地化、正确链接到正文。

## 支持平台

| 平台 | 匹配域名 |
|---|---|
| 豆包 | `*.doubao.com` |
| DeepSeek | `chat.deepseek.com` |
| Kimi | `*.kimi.com` |
| 通义千问 | `*.tongyi.com` |
| 讯飞星火 | `*.xfyun.cn` |
| 腾讯元宝 | `yuanbao.tencent.com` |
| 纳米 AI | `bot.n.cn` |

## 来源链（MIT）

- **上游原版**：`AI对话导出 word/json/md` — 作者 **春秋_CQ**（GreasyFork 542188，v2025.9.25-1，2025-07-10 创建）
- **改良版**：作者 **soloman1986**（ScriptCat 7403，v2025.9.25-2.scrollmerge——自动滚动加载、分页合并、用户消息；与 B 站「大魔型阿白」BV1uSuo6BEXb 同源）
- **本增强版**：在改良版基础上由 GD 改造（图片位置修复、URL 本地化、杂图过滤、AI 生成图导出、全量拉取等）

## 相比上游的增强

- **图片链接本地化**：MD 内所有图片 URL 替换为 `images/` 相对路径，zip 内含对应图片文件
- **图片位置修复（豆包）**：用户上传图回到对应用户消息正文，不再堆在文末
- **图片统一命名**：`image_001`、`image_002`… 顺序命名，按响应 Content-Type 修正扩展名
- **杂图过滤**：只收「聊天容器内 + 消息项内」的图片（头像 / 图标 / 页面 UI 资源被硬排除，URL 含 `/obj/`、`logo`、`icon`、`avatar` 一律跳过）
- **图片归一化去重**：豆包同一张图的多个签名 URL（缩略图 / 预览 / 原图，`tos-` 对象路径相同）收敛为一张；同键下会话 JSON 的原图 URL 覆盖 DOM 渲染 URL（反向不降级）
- **AI 生成图 / 搜索卡片图导出**：这类图只在页面渲染结果里、会话 JSON 拿不到——通过「常驻 DOM 采集（MutationObserver + 定时 + 滚动累积）」+「导出前全量渲染整段对话」抓到，并按消息文本指纹 / 序号归位
- **非图片附件导出**：PDF / Word / Excel 等附件打包进 zip 的 `files/` 目录（`file_00N_原名`），不再只计数
- **全量拉取并导出（一键到底）**：加载历史 → 全量渲染 → 收图 / 附件 → 自动导出 `zip{ 对话.md + 对话.json + images/ + files/ }`，文件名带 `_全量`
- **图片取证（默认关闭）**：排查缺图时把脚本内 `ENABLE_DIAGNOSTICS` 改回 `true` 再导出，zip 内附 `_diagnostics.json`（页面全部 `<img>` / `<canvas>`、图库现状、每条消息的块类型与提取结果）
- **失败不静默**：下载失败的图在 MD 末尾「⚠️ 未下载成功的图片」区列出原始 URL；完成提示含成功 / 失败张数、体积、DOM 通道张数、下载与打包耗时
- **移除 JSZip 外部依赖**：内置纯 JS ZIP 写入（jsdelivr 国内常被墙，且 generateAsync 在油猴沙箱易挂起）；零 CDN 零 `@require` / `@connect` / `@resource` / `GM_xmlhttpRequest`
- **纯本地处理**：只与当前平台同源接口通信 + 本地 Blob 落盘，无任何数据外传，不导出 Word（原版 Word 导出已移除）

## 安装

1. 安装 Tampermonkey（油猴）
2. 新建脚本，粘贴 `ai-chat-exporter-plus.user.js` 全部内容并保存（或直接导入文件）
3. 打开对应平台对话页，刷新后点击页面上的导出按钮

## 入口

| 按钮 | 行为 | 滚动页面 |
|---|---|---|
| ⬆️ 回到顶部·加载历史 | 只加载历史分页，不导出 | ✅ |
| ⬇️ **全量拉取并导出**（主） | 加载历史 → 全量渲染 → 收图 / 附件 → 导出 zip（`_全量` 后缀） | ✅（30 分钟内已拉取过则跳过） |
| 📄 仅 MD | 只出 Markdown 文本 | ❌ |
| 🗂️ 仅 JSON | 只出原始 JSON | ❌ |
| 🧪 批量导出（≤3） | 弹面板勾选最多 3 个会话，逐个全量拉取并导出 zip | ✅ |

## 已知限制 / 待办

- 豆包 **文字 + 图片的同一用户消息可能被拆成两条消息**（图片块与文本块未合并）
- **canvas 渲染图不采集**：聊天区 ≥100px 的 `<canvas>` 无直链，当前只报告不取（读像素受污染限制，脆弱）
- **DOM 图与消息的精确对应**：不依赖 React Fiber 读 messageId（脆弱），当前宁可不标也不标错
- **视频 / 媒体资源只保留「标题 + 链接」**：不下载封面、不校验链接有效性。豆包历史回包里 AI 视频**无 mp4 直链**（搜索结果视频卡片只有封面 + 外站链接）；视频分享页接口（`get_video_share_info` 的 `play_info.main`）虽是成品直链，但历史回包字段名无公开佐证，待实机样本
- **音频 / TTS 平台不提供持久直链**（走 WebSocket 流式，如 `openspeech.bytedance.com/api/v3/tts`），无可下载物 → 属「平台不提供」而非「未覆盖」
- **分享页图片**：现代 `data-fn-args` / 旧版 `content_v2`（JSON 字符串）→ `creation_block.creations[].image_ori_raw`（限图片）；`rich_media_layout_block` 键名本地/全网均 0 命中，待实测
- 豆包非图片附件的字段名**未取证**（现有样本里附件只有图片）；DeepSeek 侧用 `signed_path` 拼 URL

## License

MIT（保留上游作者版权声明：春秋_CQ、soloman1986）
