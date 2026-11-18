import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { StudioError } from "./muse-studio.mjs";
import { MAX_VIDEO_UPLOAD } from "./video-clips.mjs";

const exec = promisify(execFile);
const inputOptions = ["-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,webm,avi,mpeg,mpegts"];
const sizes = new Map([["portrait", [720, 1280]], ["landscape", [1280, 720]]]);
let exporting = false;

export async function composeTimeline(request) {
    if (exporting) throw new StudioError("已有成片正在导出，请稍后重试", 429);
    const maxBody = MAX_VIDEO_UPLOAD + 64 * 1024;
    if (!request.body || !request.headers.get("content-type")?.startsWith("multipart/form-data;")) throw new StudioError("请提交镜头文件");
    if (Number(request.headers.get("content-length")) > maxBody) throw new StudioError("镜头文件合计不能超过 80 MB", 413);
    exporting = true;
    let directory;
    let received = 0;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(330_000)]);
    try {
        const limited = request.body.pipeThrough(new TransformStream({
            transform(chunk, controller) {
                received += chunk.byteLength;
                if (received > maxBody) throw new StudioError("镜头文件合计不能超过 80 MB", 413);
                controller.enqueue(chunk);
            },
        }), { signal });
        const form = await new Response(limited, { headers: { "content-type": request.headers.get("content-type") } }).formData();
        const files = form.getAll("clip");
        const size = sizes.get(form.get("layout"));
        if (!size || files.length < 2 || files.length > 24 || files.some(file => typeof file === "string" || !file.size)) {
            throw new StudioError("请选择 2–24 个有效的视频镜头和成片比例");
        }
        if (files.reduce((sum, file) => sum + file.size, 0) > MAX_VIDEO_UPLOAD) throw new StudioError("镜头文件合计不能超过 80 MB", 413);
        directory = await mkdtemp(join(tmpdir(), "canvas-timeline-"));
        const options = { cwd: directory, signal, windowsHide: true };
        const ffmpeg = args => exec(process.env.FFMPEG_BIN || "ffmpeg", ["-nostdin", "-v", "error", ...args], options);
        const [width, height] = size;
        const ratio = width / height;
        const scale = `scale=w='if(gt(dar,${ratio}),${width},max(2,trunc(${height}*dar/2)*2))':h='if(gt(dar,${ratio}),max(2,trunc(${width}/dar/2)*2),${height})'`;
        const list = [];
        let total = 0;
        for (const [index, file] of files.entries()) {
            const input = "input-" + index;
            const normalized = "shot-" + index + ".mov";
            await writeFile(join(directory, input), file.stream(), { signal });
            const { stdout } = await exec(process.env.FFPROBE_BIN || "ffprobe", [
                "-v", "error", ...inputOptions, "-show_entries", "format=duration:stream=codec_type,duration,width,height:stream_disposition=attached_pic", "-of", "json", input,
            ], options);
            const info = JSON.parse(stdout);
            const video = info.streams.find(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic);
            const seconds = Number(video?.duration) || Number(info.format?.duration);
            if (!video || !Number.isFinite(seconds) || seconds <= 0 || video.width * video.height > 4096 * 2160) throw new StudioError(`第 ${index + 1} 个镜头无法处理，请使用 4K 以内的有效视频`, 422);
            const length = Math.max(1, Math.round(seconds * 30)) / 30;
            total += length;
            if (total > 300.001) throw new StudioError("成片总时长最多 5 分钟");
            const audio = info.streams.some(stream => stream.codec_type === "audio");
            await ffmpeg(["-filter_threads", "1", "-threads", "2", ...inputOptions, "-i", input,
                ...(audio ? [] : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]),
                "-map", "0:V:0", "-map", audio ? "0:a:0" : "1:a:0",
                "-vf", `setpts=PTS-STARTPTS,${scale},setsar=1,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30,tpad=stop_mode=clone:stop_duration=1`,
                "-af", "aresample=48000:async=1:first_pts=0,apad", "-t", String(length), "-ac", "2", "-c:a", "pcm_s16le",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "2", "-preset", "veryfast", "-crf", "22",
                "-maxrate", "2500k", "-bufsize", "5000k", "-map_metadata", "-1", normalized]);
            list.push("file '" + normalized + "'");
        }
        await writeFile(join(directory, "shots.txt"), list.join("\n"));
        await ffmpeg(["-f", "concat", "-safe", "1", "-i", "shots.txt", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "timeline.mp4"]);
        return await readFile(join(directory, "timeline.mp4"));
    } catch (error) {
        if (received > maxBody) throw new StudioError("镜头文件合计不能超过 80 MB", 413);
        if (error instanceof StudioError) throw error;
        if (signal.aborted) throw new StudioError("导出已取消或超时", 408);
        if (error.code === "ENOENT") throw new StudioError("服务器缺少 FFmpeg 或 FFprobe", 503);
        throw new StudioError("镜头读取或合成失败，请检查素材是否可以播放", 422);
    } finally {
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
        exporting = false;
    }
}
