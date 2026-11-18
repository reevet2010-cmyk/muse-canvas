import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { composeTimeline } from "../src/services/server/video-timeline.mjs";

function request(clips, layout) {
    const form = new FormData();
    form.set("layout", layout);
    for (const clip of clips) form.append("clip", new Blob([clip]), "video.mp4");
    return new Request("http://localhost/api/muse-studio/compose", { method: "POST", body: form });
}

test("timeline rejects a single clip and invalid layouts", async () => {
    await assert.rejects(composeTimeline(request(["a"], "portrait")), /2–24/);
    await assert.rejects(composeTimeline(request(["a", "b"], "square")), /成片比例/);
});

test("exports in selected order, fits the frame and keeps sound and silence across cuts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "timeline-test-"));
    const run = args => execFileSync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", ...args], { cwd: dir, windowsHide: true });
    try {
        run(["-f", "lavfi", "-i", "color=red:s=160x90:r=24", "-f", "lavfi", "-i", "sine=frequency=500",
            "-t", "1", "-c:v", "libx264", "-c:a", "aac", "red.mp4"]);
        run(["-f", "lavfi", "-i", "color=blue:s=90x160:r=25", "-t", "1.2", "-c:v", "libx264", "blue.mp4"]);
        const red = await readFile(join(dir, "red.mp4"));
        const blue = await readFile(join(dir, "blue.mp4"));
        for (const portrait of [true, false]) {
            const movie = await composeTimeline(request(portrait ? [blue, red] : [red, blue], portrait ? "portrait" : "landscape"));
            await writeFile(join(dir, "out.mp4"), movie);
            const info = JSON.parse(execFileSync(process.env.FFPROBE_BIN || "ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", "out.mp4"], { cwd: dir }));
            const [video, audio] = info.streams;
            assert.deepEqual([video.width, video.height, video.codec_name, video.r_frame_rate, audio.codec_name, audio.channels],
                [...(portrait ? [720, 1280] : [1280, 720]), "h264", "30/1", "aac", 2]);
            assert.ok(Math.abs(Number(info.format.duration) - 2.2) < 0.06);
            for (const [index, time] of ["0.4", "1.6"].entries()) {
                const redExpected = portrait ? index === 1 : index === 0;
                const frame = run(["-ss", time, "-i", "out.mp4", "-frames:v", "1", "-vf", "scale=10:10", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
                const center = (5 * 10 + 5) * 3;
                assert.ok(frame[center + (redExpected ? 0 : 2)] > 200);
                if (index === 1) assert.ok(frame[0] < 25 && frame[2] < 25, "opposite aspect ratio is letterboxed");
                const pcm = run(["-ss", time, "-i", "out.mp4", "-t", "0.1", "-vn", "-ac", "1", "-f", "s16le", "-"]);
                let peak = 0;
                for (let n = 0; n < pcm.length; n += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(n)));
                assert.ok(redExpected ? peak > 200 : peak < 10);
            }
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
