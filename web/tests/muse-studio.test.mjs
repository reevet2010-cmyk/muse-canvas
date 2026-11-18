import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMuseClient } from "../src/services/server/muse-studio.mjs";
import { splitVideo } from "../src/services/server/video-clips.mjs";

test("Muse request forwards a ten-second reference, and downloads the completed clip through the fixed gateway", async () => {
    const seen = [];
    const client = createMuseClient("http://muse.internal/v1", "fixture-key", async (url, request) => {
        seen.push([url.href, request.body ? JSON.parse(request.body) : null]);
        assert.equal(request.headers.Authorization, "Bearer fixture-key");
        if (url.pathname === "/v1/videos") return Response.json({ id: "test-1" });
        if (url.pathname === "/v1/videos/test-1") {
            return Response.json({ status: "succeeded", progress: 100, result: { url: "http://other-host/v1/media/clip.mp4" } });
        }
        assert.equal(url.href, "http://muse.internal/v1/media/clip.mp4");
        return new Response("clip", { headers: { "Content-Type": "video/mp4" } });
    });
    const frame = "data:image/png;base64,eA==";
    const sample = "data:video/mp4;base64,eA==";
    await client.createVideo({ prompt: "继续", size: "9:16", duration: 10, image: frame });
    await client.createVideo({ prompt: "复刻", size: "9:16", duration: 10, referenceVideo: sample });
    assert.deepEqual(seen.map(([, payload]) => [payload.duration, payload.images, payload.videos]), [
        [10, [{ url: frame }], undefined],
        [10, undefined, [{ url: sample }]],
    ]);
    assert.equal((await client.videoStatus("test-1")).status, "completed");
    assert.equal(await (await client.videoContent("test-1")).text(), "clip");
});

test("a source with sparse keyframes splits into 10, 10 and 3 seconds, retaining audio", async () => {
    const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
    const ffprobe = process.env.FFPROBE_BIN || "ffprobe";
    const directory = await mkdtemp(join(tmpdir(), "studio-test-"));
    try {
        const input = join(directory, "source.mp4");
        execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30",
            "-f", "lavfi", "-i", "sine=frequency=500", "-t", "23", "-c:v", "libx264",
            "-g", "600", "-sc_threshold", "0", "-c:a", "aac", input]);
        const clips = await splitVideo(new Blob([await readFile(input)]).stream(), AbortSignal.timeout(60_000));
        assert.deepEqual(Object.keys(clips), ["clip-000.mp4", "clip-001.mp4", "clip-002.mp4"]);
        for (const [index, [name, data]] of Object.entries(clips).entries()) {
            const path = join(directory, name);
            await writeFile(path, data);
            const result = JSON.parse(execFileSync(ffprobe, [
                "-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", path,
            ], { encoding: "utf8" }));
            const videoDuration = Number(result.streams.find((stream) => stream.codec_type === "video").duration);
            const expected = [10, 10, 3][index];
            assert.ok(Math.abs(videoDuration - expected) <= 0.05, `Expected ${expected}, got ${videoDuration}`);
            assert.ok(result.streams.some((stream) => stream.codec_type === "audio"));
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
