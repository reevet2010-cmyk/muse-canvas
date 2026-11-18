"use client";

import { Alert, AutoComplete, Button, Input, Modal, Segmented } from "antd";
import { useState } from "react";
import { listAgentLoopbackModels, normalizeAgentLoopbackUrl, type AgentLoopbackSettings } from "@/services/api/agent-loopback";

export function CanvasAgentLoopbackDialog({ current, onSave, onClose }: {
    current?: AgentLoopbackSettings;
    onSave: (settings?: AgentLoopbackSettings) => void;
    onClose: () => void;
}) {
    const [draft, setDraft] = useState<AgentLoopbackSettings>(current ?? { baseUrl: "", apiKey: "", model: "", protocol: "responses" });
    const [models, setModels] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<{ type: "success" | "error"; text: string }>();
    const secure = window.isSecureContext;
    function edit(patch: Partial<AgentLoopbackSettings>) {
        setFeedback(undefined);
        setDraft({ ...draft, ...patch });
    }
    async function loadModels() {
        setBusy(true);
        setFeedback(undefined);
        try {
            const available = await listAgentLoopbackModels(draft.baseUrl, draft.apiKey.trim());
            setModels(available);
            const textModel = available.find(model => !/image|dall-e|flux/i.test(model));
            if (!draft.model && textModel) setDraft({ ...draft, model: textModel });
            setFeedback({ type: "success", text: available.length ? `已连接，读取到 ${available.length} 个模型` : "已连接，可手动填写模型 ID" });
        } catch (error) {
            const key = draft.apiKey.trim();
            const text = error instanceof Error ? error.message : "连接失败";
            setFeedback({ type: "error", text: key ? text.replaceAll(key, "[API Key]") : text });
        } finally {
            setBusy(false);
        }
    }
    function save() {
        try {
            onSave({ ...draft, baseUrl: normalizeAgentLoopbackUrl(draft.baseUrl), apiKey: draft.apiKey.trim(), model: draft.model.trim(), imageModel: draft.imageModel?.trim() });
        } catch (error) {
            setFeedback({ type: "error", text: error instanceof Error ? error.message : "保存失败" });
        }
    }
    return (
        <Modal title="本机 API" open onCancel={onClose} footer={[
            current && <Button key="clear" onClick={() => onSave()} disabled={busy}>改用全局模型</Button>,
            <Button key="cancel" onClick={onClose}>关闭</Button>,
            <Button key="save" type="primary" onClick={save} disabled={!secure || busy || !draft.baseUrl.trim() || !draft.apiKey.trim() || !(draft.model.trim() || draft.imageModel?.trim())}>保存并使用</Button>,
        ]}>
            <div className="grid gap-3">
                <p className="text-sm opacity-70">对话和生图可分别配置。连接信息保存在当前浏览器。</p>
                {!secure && <Alert type="info" title="请打开 HTTPS 画布后配置本机 API。" />}
                <label className="grid gap-1">本机 API 地址<Input aria-label="本机 API 地址" placeholder="http://localhost:62511/v1" value={draft.baseUrl} disabled={!secure || busy} onChange={event => { setModels([]); edit({ baseUrl: event.target.value }); }} /></label>
                <label className="grid gap-1">API Key<Input.Password aria-label="本机 API Key" autoComplete="off" value={draft.apiKey} disabled={!secure || busy} onChange={event => { setModels([]); edit({ apiKey: event.target.value }); }} /></label>
                <div className="flex items-end gap-2">
                    <label className="grid min-w-0 flex-1 gap-1">对话模型 ID<AutoComplete aria-label="对话模型 ID" value={draft.model} options={models.map(value => ({ value }))} disabled={!secure || busy} onChange={model => edit({ model })} /></label>
                    <Button loading={busy} disabled={!secure || !draft.baseUrl.trim() || !draft.apiKey.trim()} onClick={() => void loadModels()}>读取模型</Button>
                </div>
                <Segmented<AgentLoopbackSettings["protocol"]> aria-label="本机 API 协议" value={draft.protocol} options={[{ label: "Responses", value: "responses" }, { label: "Chat Completions", value: "chat" }]} disabled={busy} onChange={protocol => edit({ protocol })} />
                <label className="grid gap-1">生图模型 ID
                    <AutoComplete aria-label="生图模型 ID" placeholder="例如 gpt-image-2，留空则使用原生图模型" value={draft.imageModel || ""}
                        options={models.filter(model => /image|dall-e|flux/i.test(model)).map(value => ({ value }))}
                        disabled={!secure || busy} onChange={imageModel => edit({ imageModel, useImageByDefault: true })} />
                </label>
                {feedback && <Alert type={feedback.type} title={feedback.text} />}
            </div>
        </Modal>
    );
}
