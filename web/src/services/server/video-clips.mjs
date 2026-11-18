import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { StudioError } from "./muse-studio.mjs";

const exec = promisify(execFile);
export const CLIP_SECONDS = 10;
export const MAX_VIDEO_UPLOAD = 80 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_DURATION = 300;
const FORMATS = "mov,matroska,webm,avi,mpeg,mpegts";
let splitting = false;

// 放在固定间隔的关键帧上重新编码，切点不会漂到源文件的下一个关键帧。
export async function splitVideo(input, signal) {
    if (splitting) throw new StudioError("已有视频正在拆分，请稍后重试", 429);
    splitting = true;
    let directory;
    try {
        directory = await mkdtemp(join(tmpdir(), "canvas-clips-"));
        const source = join(directory, "input");
        let uploaded = 0;
        const limit = new Transform({
            transform(chunk, _encoding, callback) {
                uploaded += chunk.length;
                if (uploaded > MAX_VIDEO_UPLOAD) callback(new StudioError("视频不能超过 80 MB", 413));
                else callback(null, chunk);
            },
        });
        await pipeline(Readable.fromWeb(input), limit, createWriteStream(source), { signal });
        const inputArgs = ["-protocol_whitelist", "file", "-format_whitelist", FORMATS];
        const { stdout } = await exec(process.env.FFPROBE_BIN || "ffprobe", [
            "-v", "error", ...inputArgs, "-show_entries", "format=duration:stream=codec_type", "-of", "json", source,
        ], { timeout: 15_000, signal, windowsHide: true });
        const probe = JSON.parse(stdout);
        const duration = Number(probe.format?.duration);
        if (!probe.streams?.some((stream) => stream.codec_type === "video") || !Number.isFinite(duration) || duration <= 0) {
            throw new StudioError("无法读取视频时长");
        }
        if (duration > MAX_DURATION) throw new StudioError("单次最多拆分 5 分钟的视频");
        await exec(process.env.FFMPEG_BIN || "ffmpeg", [
            "-hide_banner", "-nostdin", "-v", "error", "-filter_threads", "1",
            ...inputArgs, "-i", source, "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", "scale=w='min(iw,1280)':h='min(ih,1280)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "21", "-threads", "2", "-bf", "0",
            "-maxrate", "4M", "-bufsize", "4M", "-force_key_frames", `expr:gte(t,n_forced*${CLIP_SECONDS})`, "-c:a", "aac",
            "-f", "segment", "-segment_time", String(CLIP_SECONDS), "-segment_time_delta", "0.016667",
            "-reset_timestamps", "1", "-segment_format_options", "movflags=+faststart", join(directory, "clip-%03d.mp4"),
        ], { timeout: 240_000, signal, windowsHide: true });
        const names = (await readdir(directory)).filter((name) => /^clip-\d{3}\.mp4$/.test(name)).sort();
        if (!names.length) throw new StudioError("没有拆出可用的视频片段", 422);
        /** @type {Record<string, Uint8Array>} */
        const clips = {};
        let bytes = 0;
        for (const name of names) {
            const path = join(directory, name);
            bytes += (await stat(path)).size;
            if (bytes > MAX_OUTPUT_BYTES) throw new StudioError("拆分后的文件超过 128 MB，请缩短原视频", 413);
            clips[name] = await readFile(path);
        }
        return clips;
    } catch (error) {
        if (error instanceof StudioError) throw error;
        if (error.code === "ENOENT") throw new StudioError("服务器未安装 FFmpeg 或 FFprobe", 503);
        throw new StudioError("拆分失败，请检查视频格式或换一段较短的视频", 422);
    } finally {
        splitting = false;
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
}
