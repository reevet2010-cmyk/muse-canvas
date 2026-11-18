import { zipSync } from "fflate";
import { createMuseClient, StudioError } from "@/services/server/muse-studio.mjs";
import { MAX_VIDEO_UPLOAD, splitVideo } from "@/services/server/video-clips.mjs";
import { composeTimeline } from "@/services/server/video-timeline.mjs";

export const runtime = "nodejs";
export const maxDuration = 360;
type Context = { params: Promise<{ action: string }> };
const NO_STORE = { "Cache-Control": "no-store" };
const CONTENT_PREFIX = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const VIDEO_PREFIX = /^data:video\/mp4;base64,[A-Za-z0-9+/]+=*$/;
const VIDEO_DURATIONS = new Set([5, 6, 8, 10]);

async function authorize(request: Request) {
    const token = request.headers.get("authorization");
    if (!token?.startsWith("Bearer ")) throw new StudioError("请先登录画布管理员账号", 401);
    const base = (process.env.API_BASE_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
    const response = await fetch(`${base}/api/auth/me`, {
        headers: { Authorization: token },
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
        cache: "no-store",
    });
    const session = await response.json().catch(() => null);
    if (!response.ok || session?.code !== 0 || session?.data?.role !== "admin") {
        throw new StudioError("当前账号没有 Muse 创作权限", 403);
    }
}

function actionError(error: unknown) {
    const status = error instanceof StudioError ? error.status : 502;
    const message = error instanceof StudioError ? error.message : "服务请求失败，请稍后重试";
    return Response.json({ message }, { status, headers: NO_STORE });
}

function mediaResponse(upstream: Response, allowed: string) {
    const type = upstream.headers.get("Content-Type");
    if (!upstream.body || !type?.startsWith(allowed)) throw new StudioError("Muse 返回的媒体格式无效", 502);
    return new Response(upstream.body, { headers: { ...NO_STORE, "Content-Type": type, "X-Content-Type-Options": "nosniff" } });
}

export async function POST(request: Request, { params }: Context) {
    try {
        await authorize(request);
        const { action } = await params;
        if (action === "compose") {
            const movie = await composeTimeline(request);
            return new Response(new Uint8Array(movie), { headers: { ...NO_STORE, "Content-Type": "video/mp4", "Content-Disposition": 'attachment; filename="timeline.mp4"' } });
        }
        if (action === "split") {
            if (!request.body) throw new StudioError("请上传视频");
            if (Number(request.headers.get("content-length")) > MAX_VIDEO_UPLOAD) throw new StudioError("视频不能超过 80 MB", 413);
            const clips = await splitVideo(request.body, request.signal);
            return new Response(zipSync(clips, { level: 0 }), {
                headers: { ...NO_STORE, "Content-Type": "application/zip" },
            });
        }
        if (!["text", "image", "video"].includes(action)) throw new StudioError("未知操作", 404);
        const client = createMuseClient(process.env.MUSE2API_BASE_URL, process.env.MUSE2API_KEY);
        if (Number(request.headers.get("content-length")) > 12 * 1024 * 1024) throw new StudioError("生成请求过大", 413);
        const data = await request.json().catch(() => null);
        const prompt = typeof data?.prompt === "string" ? data.prompt.trim() : "";
        if (!prompt || prompt.length > 12_000) throw new StudioError("请输入不超过 12000 字的提示词");
        if (action === "text") return Response.json({ text: await client.text(prompt) }, { headers: NO_STORE });
        const size = ["9:16", "16:9", "1:1"].includes(data.size) ? data.size : "9:16";
        if (action === "image") return mediaResponse(await client.image(prompt, size), "image/");
        const duration = data.duration ?? 10;
        if (!VIDEO_DURATIONS.has(duration)) throw new StudioError("不支持该视频时长");
        const image = data.image;
        const referenceVideo = data.referenceVideo;
        if (image !== undefined && (typeof image !== "string" || image.length > 11_000_000 || !CONTENT_PREFIX.test(image))) {
            throw new StudioError("参考图需要是 8 MB 以内的 PNG、JPEG 或 WebP 图片");
        }
        if (referenceVideo !== undefined && (image || typeof referenceVideo !== "string" || referenceVideo.length > 11_000_000 || !VIDEO_PREFIX.test(referenceVideo))) {
            throw new StudioError("参考视频需要是 8 MB 以内的 MP4 片段");
        }
        const id = await client.createVideo({ prompt, size, duration, image, referenceVideo });
        return Response.json({ id }, { status: 202, headers: NO_STORE });
    } catch (error) {
        return actionError(error);
    }
}

export async function GET(request: Request, { params }: Context) {
    try {
        await authorize(request);
        const { action } = await params;
        const id = new URL(request.url).searchParams.get("id");
        const client = createMuseClient(process.env.MUSE2API_BASE_URL, process.env.MUSE2API_KEY);
        if (action === "video") return Response.json(await client.videoStatus(id), { headers: NO_STORE });
        if (action === "media") return mediaResponse(await client.videoContent(id), "video/");
        throw new StudioError("未知操作", 404);
    } catch (error) {
        return actionError(error);
    }
}
