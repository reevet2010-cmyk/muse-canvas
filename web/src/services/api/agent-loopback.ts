export const LOOPBACK_IMAGE_CHANNEL_ID = "browser-loopback-image";
export type AgentLoopbackSettings = { baseUrl: string; apiKey: string; model: string; protocol: "responses" | "chat"; imageModel?: string; useImageByDefault?: boolean };

export function normalizeAgentLoopbackUrl(value: string) {
    const url = URL.parse(value.trim());
    if (!url || !["http:", "https:"].includes(url.protocol) ||
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash ||
        !["", "/", "/v1", "/v1/"].includes(url.pathname)) {
        throw new Error("请输入本机 API 地址，例如 http://localhost:8000/v1");
    }
    return url.origin + "/v1";
}

export async function fetchAgentLoopback(baseUrl: string, apiKey: string, path: "/models" | "/responses" | "/chat/completions" | "/images/generations" | "/images/edits", body?: object, signal?: AbortSignal) {
    if (!window.isSecureContext) throw new Error("请从 HTTPS 画布打开本机 API 设置");
    const url = normalizeAgentLoopbackUrl(baseUrl) + path;
    const multipart = body instanceof FormData;
    try {
        return await fetch(url, {
            method: body ? "POST" : "GET",
            headers: { Authorization: "Bearer " + apiKey, ...(body && !multipart ? { "Content-Type": "application/json" } : {}) },
            body: multipart ? body : body && JSON.stringify(body), signal, redirect: "error", credentials: "omit", cache: "no-store",
        });
    } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error("连不上本机 API。请确认服务已启动，并在浏览器提示时允许画布访问本地网络。");
    }
}

export async function listAgentLoopbackModels(baseUrl: string, apiKey: string) {
    const response = await fetchAgentLoopback(baseUrl, apiKey, "/models", undefined, AbortSignal.timeout(10_000));
    if (response.status === 401 || response.status === 403) throw new Error("本机服务已响应，请检查 API Key");
    if (!response.ok) throw new Error(`本机服务无法列出模型（HTTP ${response.status}），可手动填写模型 ID`);
    const data: { data?: { id?: unknown }[] } = await response.json();
    return Array.from(new Set(Array.isArray(data.data) ? data.data.map(item => item?.id).filter(id => typeof id === "string" && id.length > 0) as string[] : []));
}
