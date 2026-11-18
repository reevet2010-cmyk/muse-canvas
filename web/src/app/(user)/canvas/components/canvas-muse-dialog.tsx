"use client";

import { Alert, Button, Input, InputNumber, Modal, Progress, Radio, Select, Space, Typography } from "antd";
import { unzipSync } from "fflate";
import { useEffect, useRef, useState } from "react";
import { readFileAsDataUrl } from "@/lib/image-utils";
import { downloadRemoteMedia, resolveMediaUrl } from "@/services/file-storage";
import { resolveImageUrl } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";
import { captureVideoFrame } from "../utils/canvas-video-frame";

export type MuseSource = { id: string; title: string; type: "text" | "image" | "video"; content: string; storageKey?: string };
export type MuseOutput = { type: "text"; text: string } | { type: "image"; file: File } | { type: "video"; files: File[] };
type Action = "text" | "image" | "video" | "extend" | "recreate";
type Batch = {
    clips?: File[];
    next: number;
    count: number;
    taskId?: string;
    lastNodeId: string;
    previousVideo?: File;
};
const POLL_INTERVAL = 4_000;
const WAIT_LIMIT = 16 * 60_000;
const SEGMENT_SECONDS = 10;
const MAX_EXTENSION_SEGMENTS = 12;
const RECREATE_PROMPT = "复刻参考片段的镜头顺序、构图、动作、运镜和节奏，保持画面连贯。";

async function studioRequest(path: string, token: string, signal: AbortSignal, body?: BodyInit, type?: string) {
    const headers = { Authorization: `Bearer ${token}`, ...(type ? { "Content-Type": type } : {}) };
    const response = await fetch("/api/muse-studio/" + path, { method: body ? "POST" : "GET", body, signal, headers });
    if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message || `请求失败（${response.status}）`);
    }
    return response;
}

export function CanvasMuseDialog({ source, onClose, onOutput }: {
    source?: MuseSource;
    onClose: () => void;
    onOutput: (output: MuseOutput, sourceId?: string) => Promise<string>;
}) {
    const [action, setAction] = useState<Action>(source?.type === "video" ? "extend" : source?.type === "image" ? "video" : "text");
    const [prompt, setPrompt] = useState(source?.type === "text" ? source.content.slice(0, 12_000) : "");
    const [size, setSize] = useState("9:16");
    const [duration, setDuration] = useState(10);
    const [segments, setSegments] = useState(2);
    const [phase, setPhase] = useState("");
    const [progress, setProgress] = useState<number | null>(null);
    const [error, setError] = useState("");
    const request = useRef<AbortController | null>(null);
    const batch = useRef<Batch | null>(null);
    const [hasBatch, setHasBatch] = useState(false);
    const token = useUserStore((state) => state.token);
    const role = useUserStore((state) => state.user?.role);
    const authorized = Boolean(token && role === "admin");
    const isBatch = action === "extend" || action === "recreate";
    const isVideo = action === "video" || isBatch;
    const busy = Boolean(phase);
    useEffect(() => () => request.current?.abort(), []);

    async function run() {
        if (!authorized || request.current || (action !== "recreate" && !prompt.trim())) return;
        if (isBatch && source?.type !== "video") return;
        const controller = new AbortController();
        request.current = controller;
        const signal = controller.signal;
        const submit = (path: string, payload: unknown) => studioRequest(path, token, signal, JSON.stringify(payload), "application/json");
        const dataUrl = (blob: Blob) => readFileAsDataUrl(new File([blob], "reference", { type: blob.type }), "无法读取参考素材");
        async function waitForVideo(id: string, label: string, task?: Batch) {
            const query = "?id=" + encodeURIComponent(id);
            const started = Date.now();
            for (;;) {
                signal.throwIfAborted();
                const status = await (await studioRequest("video" + query, token, signal)).json();
                if (status.status === "failed") {
                    if (task) task.taskId = undefined;
                    throw new Error(label + (status.error || "Muse 视频生成失败"));
                }
                if (status.status === "completed") break;
                setPhase(label + (status.status === "queued" ? "正在排队" : "正在生成"));
                setProgress(status.progress ?? null);
                if (Date.now() - started > WAIT_LIMIT) throw new Error(`${label}等待超时。Muse 任务编号：${id}`);
                await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
            }
            setPhase(label + "正在取回视频");
            const blob = await (await studioRequest("media" + query, token, signal)).blob();
            return blob;
        }

        async function initialBatch(node: MuseSource): Promise<Batch> {
            if (action === "extend") return { next: 0, count: segments, lastNodeId: node.id };
            setPhase("正在准备参考片段");
            const blob = await downloadRemoteMedia(await resolveMediaUrl(node.storageKey, node.content));
            const zip = await studioRequest("split", token, signal, blob, "application/octet-stream");
            const clips = Object.entries(unzipSync(new Uint8Array(await zip.arrayBuffer())))
                .filter(([name]) => /^clip-\d{3}\.mp4$/.test(name)).sort(([a], [b]) => a.localeCompare(b))
                .map(([name, bytes]) => new File([bytes as Uint8Array<ArrayBuffer>], name, { type: "video/mp4" }));
            if (!clips.length) throw new Error("没有收到可用的参考片段");
            return { clips, next: 0, count: clips.length, lastNodeId: node.id };
        }

        async function runBatch(node: MuseSource) {
            const state = batch.current ?? await initialBatch(node);
            batch.current = state;
            setHasBatch(true);
            for (; state.next < state.count; ) {
                const label = `第 ${state.next + 1}/${state.count} 段 · `;
                if (!state.taskId) {
                    setPhase(label + "正在准备参考素材");
                    setProgress(null);
                    let payload: { image: string } | { referenceVideo: string };
                    if (state.clips) {
                        payload = { referenceVideo: await dataUrl(state.clips[state.next]) };
                    } else if (state.previousVideo) {
                        const url = URL.createObjectURL(state.previousVideo);
                        try {
                            payload = { image: await dataUrl(await captureVideoFrame(url, "last", 0)) };
                        } finally {
                            URL.revokeObjectURL(url);
                        }
                    } else {
                        const url = await resolveMediaUrl(node.storageKey, node.content);
                        payload = { image: await dataUrl(await captureVideoFrame(url, "last", 0)) };
                    }
                    const batchPrompt = (state.clips
                        ? [RECREATE_PROMPT, prompt.trim()].filter(Boolean).join("\n")
                        : `承接参考首帧，保持角色、场景和动作连续。这是续接的第 ${state.next + 1}/${state.count} 段，请推进情节。\n${prompt.trim()}`).slice(0, 12_000);
                    const data = await (await submit("video", { ...payload, prompt: batchPrompt, size, duration: SEGMENT_SECONDS })).json();
                    state.taskId = data.id;
                }
                const blob = await waitForVideo(state.taskId!, label, state);
                const ext = blob.type === "video/webm" ? "webm" : "mp4";
                const file = new File([blob], `${node.title} · ${state.clips ? "复刻" : "续接"} ${state.next + 1}.${ext}`, { type: blob.type });
                signal.throwIfAborted();
                state.lastNodeId = await onOutput({ type: "video", files: [file] }, state.lastNodeId);
                if (!state.clips) state.previousVideo = file;
                state.taskId = undefined;
                state.next++;
            }
            batch.current = null;
            setHasBatch(false);
        }
        setError("");
        setProgress(null);
        setPhase("正在准备");
        try {
            if (isBatch && source) {
                await runBatch(source);
                onClose();
                return;
            }
            let output: MuseOutput;
            if (action === "text") {
                setPhase("Muse 正在写作");
                const data = await (await submit("text", { prompt })).json();
                output = { type: "text", text: data.text };
            } else if (action === "image") {
                setPhase("Muse 正在生成图片");
                const blob = await (await submit("image", { prompt, size })).blob();
                const ext = blob.type === "image/webp" ? "webp" : blob.type === "image/jpeg" ? "jpg" : "png";
                output = { type: "image", file: new File([blob], `Muse 分镜.${ext}`, { type: blob.type }) };
            } else {
                let reference: Blob | undefined;
                if (source?.type === "image") {
                    reference = await downloadRemoteMedia(await resolveImageUrl(source.storageKey, source.content));
                }
                const image = reference ? await dataUrl(reference) : undefined;
                setPhase("正在提交 Muse 视频任务");
                const { id } = await (await submit("video", { prompt, size, duration, image })).json();
                const blob = await waitForVideo(id, "");
                const name = "Muse 视频";
                const ext = blob.type === "video/webm" ? "webm" : "mp4";
                output = { type: "video", files: [new File([blob], `${name}.${ext}`, { type: blob.type })] };
            }
            signal.throwIfAborted();
            setPhase("正在添加到画布");
            await onOutput(output, source?.id);
            onClose();
        } catch (cause) {
            if (!signal.aborted) setError(cause instanceof Error ? cause.message : "操作失败，请重试");
        } finally {
            request.current = null;
            if (!signal.aborted) setPhase("");
        }
    }

    return (
        <Modal title="Muse 创作" open onCancel={onClose} closable={!busy} keyboard={!busy} mask={{ closable: false }} footer={[
            <Button key="close" onClick={onClose} disabled={busy}>关闭</Button>,
            <Button key="run" type="primary" loading={busy} disabled={!authorized || (action !== "recreate" && !prompt.trim())} onClick={() => void run()}>
                {hasBatch ? "继续当前任务" : action === "recreate" ? "开始拆段复刻" : action === "extend" ? "开始尾帧续接" : "生成并加入画布"}
            </Button>,
        ]}>
            <Space orientation="vertical" size="middle" className="w-full">
                {!authorized && <Alert type="info" showIcon title="请先登录画布管理员账号" />}
                {source && <Typography.Text type="secondary">参考节点：{source.title}</Typography.Text>}
                <Radio.Group value={action} onChange={(event) => { setAction(event.target.value); setError(""); }} disabled={busy || hasBatch}>
                    <Radio.Button value="text">写脚本</Radio.Button>
                    <Radio.Button value="image">生成分镜</Radio.Button>
                    <Radio.Button value="video">生成视频</Radio.Button>
                    {source?.type === "video" && <Radio.Button value="extend">尾帧续接</Radio.Button>}
                    {source?.type === "video" && <Radio.Button value="recreate">拆段复刻</Radio.Button>}
                </Radio.Group>
                {action === "recreate" && <Typography.Text type="secondary">把参考视频切成约 10 秒一段，逐段生成复刻视频。每段分别消耗 Muse 额度。</Typography.Text>}
                {action === "extend" && <Typography.Text type="secondary">上一段尾帧作为下一段首帧。每段请求 10 秒，成片时长以 Muse 为准。</Typography.Text>}
                <Input.TextArea aria-label="提示词" maxLength={12_000} value={prompt} onChange={(event) => setPrompt(event.target.value)}
                    placeholder={action === "extend" ? "描述画面接下来怎么发展" : action === "recreate" ? "附加复刻要求（选填）" : "输入提示词"} rows={4} disabled={busy || hasBatch} />
                {(isVideo || action === "image") && <Space>
                    <Select aria-label="画幅" value={size} onChange={setSize} disabled={busy || hasBatch}
                        options={(isVideo ? ["9:16", "16:9"] : ["9:16", "16:9", "1:1"]).map((value) => ({ value, label: value }))} />
                    {action === "video" && <Select aria-label="视频时长" value={duration} onChange={setDuration} disabled={busy}
                        options={[5, 6, 8, 10].map((value) => ({ value, label: `${value} 秒` }))} />}
                    {action === "extend" && <label>续接段数 <InputNumber aria-label="续接段数" min={1} max={MAX_EXTENSION_SEGMENTS} precision={0}
                        value={segments} onChange={(value) => { if (value && value >= 1 && value <= MAX_EXTENSION_SEGMENTS) setSegments(value); }} disabled={busy || hasBatch} /></label>}
                </Space>}
                {phase && <Typography.Text role="status">{phase}</Typography.Text>}
                {phase && progress !== null && <Progress percent={progress} />}
                {error && <Alert type="error" showIcon title={error} />}
            </Space>
        </Modal>
    );
}
