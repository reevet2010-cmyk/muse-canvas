# Muse 创作

基于 tigerowo/infinite-canvas v0.8.4。打开画布编辑器，登录管理员账号，从底部工具栏打开「Muse 创作」。

从画布首页顶部点击「导入 Muse 账号」。登录后会自动回到导入表单，粘贴自己 Muse 账号已导出的单行 Cookie，点「导入账号」。管理员也可查看账号摘要。要授权一个普通用户导入，在画布服务设置 `MUSE_ACCOUNT_IMPORTER_ID` 为该用户的画布 ID，该授权仅允许导入。

- 「写脚本」生成文本节点。「生成分镜」生成图片节点。选中图片后用「生成视频」，会把图片作为首帧参考。
- 选中已有视频，用「尾帧续接」，输入接下来的画面并设置段数（1–12）。每一段请求 10 秒，上一段成片的尾帧用作下一段的首帧。片段按顺序加入画布并连线。
- 选中样片，用「拆段复刻」。系统按约 10 秒一段重编码并保留末段，然后逐段把参考视频发送给 Muse。可补充复刻要求。每段生成的成片单独加入画布。
- 每段生成会分别消耗 Muse 额度。实际成片时长、动作衔接和还原程度以 Muse 返回为准。批量任务运行期间保持画布打开。当前弹窗内可重试失败段，画布中已添加的结果会保留。

拆段接受最大 80 MB、最长 5 分钟的视频。需安装 FFmpeg / FFprobe，联合镜像已包含。任务中间不做成片拼接，每个视频节点都可单独预览和下载。

### 镜头时间线

按住 Shift 依次点选 2–24 个有素材的视频节点，打开底部「镜头时间线」。拖动镜头或用上下箭头调整顺序，点名称和播放键可从该镜头开始连播。选择竖屏或横屏后，管理员可点「导出 MP4」下载成片。此操作由 FFmpeg 执行，无需 Muse 额度。导出支持合计 80 MB、总长 5 分钟，输出 720×1280 或 1280×720、30 fps，保留原声，比例不同时补黑边。关闭时间线会结束本次排序。

## 部署

### Agent 的两种用法

画布 Agent 的「配置 API」打开渠道与模型配置。使用自己的 OpenAI 或兼容服务时填写 Base URL、API Key 和可用文本模型，在 Agent 设置中选择 Chat Completions 或 Responses。

要从本机 Codex 操作画布，在本地克隆本项目，进入 `canvas-agent` 后用 Node.js 22 或更高版本运行 `npm install`。使用实际的 HTTPS 站点源（包括端口）及本地绝对路径注册：

```sh
codex mcp add infinite-canvas --env CANVAS_AGENT_SITE=https://canvas.example.com -- node /absolute/path/to/canvas-agent/index.mjs mcp
```

在 HTTPS 画布的 Agent 面板点「用本机 Codex」，复制画布指令给新的 Codex 对话。首次调用 `open_canvas` 会按需启动本机桥接服务并在浏览器打开目标项目。若浏览器询问，仅为自己的画布站点允许访问本地网络。保持该标签页打开。地址栏中的连接片段会自动清除。API 模式和本机 Codex 分别使用各自配置的凭据。

### Docker Compose

在支持 Docker Compose 的主机上将 `ADMIN_PASSWORD`、`JWT_SECRET`、`MUSE2API_KEY` 写入部署环境（或未入库的 `.env`），使用独立强随机值。然后执行：

```sh
docker compose -f compose.muse.yml up -d --build
```

画布在本机 `3210`，生产环境通过 HTTPS 反代，同时禁止在公网 HTTP 上提交 `/api/muse-studio/accounts`。账号通过画布导入，原生 Muse 管理页在本机 `18610/admin`。网关密钥由画布后端持有。生产反代需支持至少 80 MB 上传及 360 秒请求超时。

已有独立的画布安装可配置 `MUSE2API_BASE_URL`（带 `/v1`）及 `MUSE2API_KEY` 接入内网网关。可选设置 `FFMPEG_BIN`、`FFPROBE_BIN`。
