"use client";

import { Alert, Button, Modal, Radio, Space, Typography } from "antd";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { saveAs } from "file-saver";
import { useEffect, useRef, useState } from "react";
import { exportTimeline } from "@/services/api/timeline";
import { downloadRemoteMedia, resolveMediaUrl } from "@/services/file-storage";
import { getProxyUrl } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";

export type TimelineShot = { id: string; title: string; content: string; storageKey?: string };

export function CanvasTimelineDialog({ selection, onClose }: { selection: TimelineShot[]; onClose: () => void }) {
    const [shots, setShots] = useState(selection);
    const [layout, setLayout] = useState("portrait");
    const [active, setActive] = useState(selection[0].id);
    const [preview, setPreview] = useState("");
    const [previewError, setPreviewError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [error, setError] = useState("");
    const [phase, setPhase] = useState("");
    const [result, setResult] = useState<Blob>();
    const token = useUserStore(state => state.token);
    const admin = useUserStore(state => state.user?.role === "admin");
    const shot = shots.find(item => item.id === active)!;
    const drag = useRef<string | null>(null);
    const autoplay = useRef(false);
    const work = useRef<AbortController | null>(null);
    const cache = useRef(new Map<string, Blob>());
    useEffect(() => () => work.current?.abort(), []);
    useEffect(() => {
        let current = true;
        setPreview("");
        setPreviewError(false);
        resolveMediaUrl(shot.storageKey, shot.content).then(url => {
            if (current) {
                setPreview(getProxyUrl(url));
                setPreviewError(!url);
            }
        }).catch(() => { if (current) setPreviewError(true); });
        return () => { current = false; };
    }, [shot, attempt]);

    function move(id: string, to: number) {
        const from = shots.findIndex(item => item.id === id);
        if (work.current || from < 0 || to < 0 || to >= shots.length || from === to) return;
        const ordered = [...shots];
        ordered.splice(to, 0, ...ordered.splice(from, 1));
        setShots(ordered);
        setResult(undefined);
    }

    async function renderMovie() {
        if (!token || !admin || work.current) return;
        const controller = new AbortController();
        work.current = controller;
        setError("");
        try {
            const clips: Blob[] = [];
            let total = 0;
            for (const [index, item] of shots.entries()) {
                setPhase(`读取镜头 ${index + 1}/${shots.length}`);
                let blob = cache.current.get(item.id);
                if (!blob) {
                    try {
                        blob = await downloadRemoteMedia(await resolveMediaUrl(item.storageKey, item.content));
                    } catch {
                        throw new Error(`第 ${index + 1} 个镜头「${item.title}」读取失败，请检查素材后重试`);
                    }
                }
                controller.signal.throwIfAborted();
                total += blob.size;
                if (total > 80 * 1024 * 1024) throw new Error("镜头文件合计不能超过 80 MB");
                cache.current.set(item.id, blob);
                clips.push(blob);
            }
            setPhase("正在合成 MP4");
            const movie = await exportTimeline(clips, layout, token, controller.signal);
            setResult(movie);
            saveAs(movie, "镜头合成.mp4");
        } catch (cause) {
            if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "导出失败");
        } finally {
            work.current = null;
            if (!controller.signal.aborted) setPhase("");
        }
    }
    return <Modal open title="镜头时间线" onCancel={onClose} mask={{ closable: false }} footer={[
        <Button key="close" onClick={onClose}>{phase ? "取消导出并关闭" : "关闭"}</Button>,
        <Button key="export" type="primary" disabled={!admin || !token} loading={!!phase}
            onClick={() => result ? saveAs(result, "镜头合成.mp4") : void renderMovie()}>{phase || (result ? "再次下载 MP4" : "导出 MP4")}</Button>,
    ]}>
        <Space orientation="vertical" className="w-full" size="middle" data-canvas-no-zoom>
            <Radio.Group value={layout} disabled={!!phase} onChange={e => { setLayout(e.target.value); setResult(undefined); }}
                options={[{ value: "portrait", label: "竖屏 9∶16" }, { value: "landscape", label: "横屏 16∶9" }]} optionType="button" />
            {previewError ? <Button onClick={() => setAttempt(value => value + 1)}>重新加载当前镜头</Button> :
                preview && <video key={shot.id + attempt} src={preview} controls playsInline preload="metadata" autoPlay={autoplay.current}
                    aria-label={"预览 " + shot.title} className="mx-auto block max-h-56 max-w-full" style={{ aspectRatio: layout === "portrait" ? "9/16" : "16/9", objectFit: "contain", backgroundColor: "black" }}
                    onError={() => setPreviewError(true)} onEnded={() => {
                        const next = shots[shots.indexOf(shot) + 1];
                        autoplay.current = Boolean(next);
                        if (next) setActive(next.id);
                    }} />}
            <Typography.Text type="secondary">拖动排列镜头，点击名称预览。播放结束后自动接下一段。</Typography.Text>
            <ol className="m-0 max-h-56 list-none overflow-auto p-0">
                {shots.map((item, index) => <li key={item.id} draggable={!phase}
                    className="flex items-center gap-1 py-0.5" onDragStart={() => { drag.current = item.id; }}
                    onDragEnd={() => { drag.current = null; }} onDragOver={e => e.preventDefault()}
                    onDrop={e => { e.preventDefault(); if (drag.current) move(drag.current, index); drag.current = null; }}>
                    <GripVertical size={16} className="shrink-0 cursor-grab" />
                    <Button type={item.id === active ? "link" : "text"} aria-pressed={item.id === active} className="min-w-0 flex-1 !justify-start"
                        onClick={() => { autoplay.current = false; setActive(item.id); }}><span className="truncate">{index + 1}. {item.title || "视频"}</span></Button>
                    <Button type="text" aria-label={"上移 " + item.title} disabled={!!phase || !index} icon={<ArrowUp size={16} />} onClick={() => move(item.id, index - 1)} />
                    <Button type="text" aria-label={"下移 " + item.title} disabled={!!phase || index === shots.length - 1} icon={<ArrowDown size={16} />} onClick={() => move(item.id, index + 1)} />
                </li>)}
            </ol>
            <Typography.Text type="secondary">{shots.length} 个镜头 · 合计上限 5 分钟 / 80 MB</Typography.Text>
            {!admin && <Alert type="info" title="登录画布管理员账号后可导出" />}
            {error && <Alert type="error" showIcon title={error} />}
        </Space>
    </Modal>;
}
