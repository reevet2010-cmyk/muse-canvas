export async function exportTimeline(clips: Blob[], layout: string, token: string, signal: AbortSignal) {
    const form = new FormData();
    form.set("layout", layout);
    clips.forEach((clip, index) => form.append("clip", clip, "shot-" + index));
    const response = await fetch("/api/muse-studio/compose", {
        method: "POST", body: form, headers: { Authorization: "Bearer " + token }, signal,
    });
    if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.message || `导出失败（HTTP ${response.status}）`);
    }
    return response.blob();
}
