const VIDEO_STATUSES = {
    succeeded: "completed", success: "completed", completed: "completed",
    failed: "failed", error: "failed", cancelled: "failed", canceled: "failed",
    queued: "queued", pending: "queued",
};

export class StudioError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

export function createMuseClient(baseUrl, key, fetcher = fetch) {
    if (!baseUrl || !key) throw new StudioError("Muse 渠道还未配置", 503);
    const base = new URL(baseUrl.trim().replace(/\/+$/, "") + "/");
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
        throw new StudioError("Muse 服务地址配置无效", 503);
    }
    const route = (path) => new URL(path.replace(/^\//, ""), base);
    async function send(path, body) {
        const headers = { Authorization: `Bearer ${key}` };
        if (body) headers["Content-Type"] = "application/json";
        const response = await fetcher(route(path), {
            method: body ? "POST" : "GET",
            body: body ? JSON.stringify(body) : undefined,
            headers,
            redirect: "error",
            cache: "no-store",
            signal: AbortSignal.timeout(300_000),
        });
        if (!response.ok) {
            const payload = await response.json().catch(() => null);
            const safeMessage = typeof payload?.error?.message === "string" ? payload.error.message.replaceAll(key, "[密钥]").slice(0, 300) : "";
            throw new StudioError(safeMessage || `Muse 请求失败（${response.status}）`, 502);
        }
        return response;
    }

    function safeMediaPath(value) {
        const path = new URL(value, base).pathname;
        const name = path.match(/\/media\/([a-zA-Z0-9_-]+\.(?:mp4|webm|png|jpeg|jpg|webp))$/)?.[1];
        if (!name) throw new StudioError("Muse 没有返回可下载的媒体文件", 502);
        return "media/" + name;
    }

    function taskId(value) {
        if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new StudioError("视频任务 ID 无效");
        return value;
    }

    async function readVideo(id) {
        return (await send("videos/" + taskId(id))).json();
    }

    return {
        async accounts() {
            const result = await (await send("../admin/accounts")).json();
            if (!Array.isArray(result.accounts)) throw new StudioError("无法读取 Muse 账号列表", 502);
            return result.accounts.map(account => ({
                label: String(account.label || "未命名账号").slice(0, 100),
                enabled: account.enabled !== false,
                complete: account.essential_ok === true,
            }));
        },
        async importAccount(input) {
            const session = typeof input?.session === "string" ? input.session.trim() : "";
            const label = typeof input?.label === "string" ? input.label.trim() : "";
            if (!session || session.length > 32000 || /[\r\n]/.test(session) || !/^[^;=\s]+=[^;]+/.test(session) || label.length > 100) {
                throw new StudioError("请粘贴一个账号的单行 Cookie（名称=值；各项用英文分号分隔）");
            }
            let result;
            try {
                result = await (await send("../admin/accounts", { label, cookie_header: session })).json();
            } catch {
                throw new StudioError("Muse 网关未确认导入，请刷新账号列表后再试", 502);
            }
            if (result.count !== 1) throw new StudioError("未收到账号导入确认，请刷新列表核对", 502);
            return { complete: Array.isArray(result.essential_missing) && !result.essential_missing.length };
        },
        async text(prompt) {
            const data = await (await send("chat/completions", {
                model: "muse-spark", messages: [{ role: "user", content: prompt }], stream: false,
            })).json();
            const text = data.choices?.[0]?.message?.content;
            if (typeof text !== "string" || !text.trim()) throw new StudioError("Muse 没有返回文本", 502);
            return text;
        },
        async image(prompt, size) {
            const data = await (await send("images/generations", {
                model: "muse-image", prompt, size, response_format: "b64_json",
            })).json();
            const image = data.data?.[0];
            if (typeof image?.b64_json === "string") {
                const bytes = Buffer.from(image.b64_json, "base64");
                const isPng = bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
                const isWebp = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
                const isJpeg = bytes.subarray(0, 3).toString("hex") === "ffd8ff";
                if (isPng || isWebp || isJpeg) {
                    const type = isPng ? "image/png" : isWebp ? "image/webp" : "image/jpeg";
                    return new Response(bytes, { headers: { "Content-Type": type } });
                }
            }
            if (typeof image?.url === "string") return send(safeMediaPath(image.url));
            throw new StudioError("Muse 没有返回图片", 502);
        },
        async createVideo({ prompt, size, duration, image, referenceVideo }) {
            const data = await (await send("videos", {
                model: "muse-video", prompt, size, duration,
                ...(image ? { images: [{ url: image }] } : {}),
                ...(referenceVideo ? { videos: [{ url: referenceVideo }] } : {}),
            })).json();
            return taskId(data.id);
        },
        async videoStatus(id) {
            const data = await readVideo(id);
            const upstreamStatus = String(data.status || "").toLowerCase();
            const status = Object.hasOwn(VIDEO_STATUSES, upstreamStatus) ? VIDEO_STATUSES[upstreamStatus] : "processing";
            const progress = typeof data.progress === "number" ? Math.max(0, Math.min(100, data.progress)) : null;
            const rawError = typeof data.error === "string" ? data.error : data.error?.message;
            const error = status === "failed" && typeof rawError === "string" ? rawError.replaceAll(key, "[密钥]").slice(0, 300) : undefined;
            return { status, progress, error };
        },
        async videoContent(id) {
            const data = await readVideo(id);
            if (typeof data.result?.url !== "string") throw new StudioError("视频还没有可下载的结果", 409);
            return send(safeMediaPath(data.result.url));
        },
    };
}
