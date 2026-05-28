import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowsClockwise, ClipboardText, Wrench, X } from '@phosphor-icons/react';
import {
    DEFAULT_DEV_DEBUG_FLAGS,
    formatDevDebugLlmLog,
    isDevDebugAvailable,
    readDevDebugFlags,
    readDevDebugLlmLog,
    readDevDebugPosition,
    subscribeDevDebugLlmLog,
    subscribeDevDebugFlags,
    writeDevDebugFlags,
    writeDevDebugPosition,
} from '../utils/devDebug';
import type { DevDebugFlags, DevDebugFloatingPosition } from '../utils/devDebug';

const FLOATING_BUTTON_SIZE = 44;
const FLOATING_SAFE_MARGIN = 16;
const PANEL_WIDTH = 342;
const PANEL_ESTIMATED_HEIGHT = 368;
const DRAG_THRESHOLD_PX = 4;

function getViewportSize() {
    if (typeof window === 'undefined') return { width: 390, height: 844 };
    return {
        width: window.visualViewport?.width ?? window.innerWidth,
        height: window.visualViewport?.height ?? window.innerHeight,
    };
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), Math.max(min, max));
}

function clampFloatingPosition(position: DevDebugFloatingPosition): DevDebugFloatingPosition {
    const viewport = getViewportSize();
    return {
        x: clamp(position.x, FLOATING_SAFE_MARGIN, viewport.width - FLOATING_BUTTON_SIZE - FLOATING_SAFE_MARGIN),
        y: clamp(position.y, FLOATING_SAFE_MARGIN, viewport.height - FLOATING_BUTTON_SIZE - FLOATING_SAFE_MARGIN),
    };
}

function getDefaultFloatingPosition(): DevDebugFloatingPosition {
    const viewport = getViewportSize();
    return clampFloatingPosition({
        x: FLOATING_SAFE_MARGIN,
        y: viewport.height - FLOATING_BUTTON_SIZE - FLOATING_SAFE_MARGIN,
    });
}

function getInitialFloatingPosition(): DevDebugFloatingPosition {
    return clampFloatingPosition(readDevDebugPosition() ?? getDefaultFloatingPosition());
}

function getPanelPosition(position: DevDebugFloatingPosition): DevDebugFloatingPosition {
    const viewport = getViewportSize();
    const panelWidth = Math.min(PANEL_WIDTH, viewport.width - FLOATING_SAFE_MARGIN * 2);
    const panelHeight = Math.min(PANEL_ESTIMATED_HEIGHT, viewport.height - FLOATING_SAFE_MARGIN * 2);
    return {
        x: clamp(position.x, FLOATING_SAFE_MARGIN, viewport.width - panelWidth - FLOATING_SAFE_MARGIN),
        y: clamp(position.y, FLOATING_SAFE_MARGIN, viewport.height - panelHeight - FLOATING_SAFE_MARGIN),
    };
}

const ToggleRow: React.FC<{
    title: string;
    detail: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
}> = ({ title, detail, checked, onChange }) => (
    <div className="flex items-center justify-between gap-4 py-3">
        <div className="min-w-0">
            <div className="text-[13px] font-bold text-white">{title}</div>
            <div className="mt-1 text-[11px] leading-relaxed text-white/55">{detail}</div>
        </div>
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            onClick={() => onChange(!checked)}
            className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors ${
                checked
                    ? 'border-amber-300/60 bg-amber-300/80'
                    : 'border-white/15 bg-white/10'
            }`}
        >
            <span
                className={`absolute left-1 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform ${
                    checked ? 'translate-x-5' : 'translate-x-0'
                }`}
            />
        </button>
    </div>
);

const DevDebugPanel: React.FC = () => {
    const [open, setOpen] = useState(false);
    const [flags, setFlags] = useState<DevDebugFlags>(() => readDevDebugFlags());
    const [llmLogCount, setLlmLogCount] = useState(() => readDevDebugLlmLog().length);
    const [copied, setCopied] = useState(false);
    const [floatingPosition, setFloatingPosition] = useState<DevDebugFloatingPosition>(getInitialFloatingPosition);
    const dragStateRef = useRef<{
        pointerId: number;
        startX: number;
        startY: number;
        origin: DevDebugFloatingPosition;
        moved: boolean;
    } | null>(null);
    const suppressClickRef = useRef(false);

    useEffect(() => subscribeDevDebugFlags(setFlags), []);
    useEffect(() => subscribeDevDebugLlmLog((entries) => setLlmLogCount(entries.length)), []);
    useEffect(() => {
        const clampAndPersist = () => {
            setFloatingPosition((current) => {
                const next = clampFloatingPosition(current);
                writeDevDebugPosition(next);
                return next;
            });
        };
        window.addEventListener('resize', clampAndPersist);
        window.visualViewport?.addEventListener('resize', clampAndPersist);
        window.visualViewport?.addEventListener('scroll', clampAndPersist);
        return () => {
            window.removeEventListener('resize', clampAndPersist);
            window.visualViewport?.removeEventListener('resize', clampAndPersist);
            window.visualViewport?.removeEventListener('scroll', clampAndPersist);
        };
    }, []);

    const activeCount = useMemo(() => Object.values(flags).filter(Boolean).length, [flags]);
    const updateFlag = <K extends keyof DevDebugFlags,>(key: K, value: DevDebugFlags[K]) => {
        setFlags(writeDevDebugFlags({ ...flags, [key]: value }));
    };
    const resetFlags = () => {
        setFlags(writeDevDebugFlags(DEFAULT_DEV_DEBUG_FLAGS));
    };
    const copyLlmLog = async () => {
        const text = formatDevDebugLlmLog();
        if (!text) return;
        await navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
    };
    const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
        if (open || (event.pointerType === 'mouse' && event.button !== 0)) return;
        dragStateRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            origin: floatingPosition,
            moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = dragStateRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;

        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
            drag.moved = true;
        }

        if (drag.moved) {
            event.preventDefault();
            setFloatingPosition(clampFloatingPosition({
                x: drag.origin.x + dx,
                y: drag.origin.y + dy,
            }));
        }
    };
    const finishDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = dragStateRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;

        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        const next = clampFloatingPosition({
            x: drag.origin.x + dx,
            y: drag.origin.y + dy,
        });
        dragStateRef.current = null;
        suppressClickRef.current = drag.moved;

        if (drag.moved) {
            event.preventDefault();
            setFloatingPosition(next);
            writeDevDebugPosition(next);
            window.setTimeout(() => { suppressClickRef.current = false; }, 0);
        }

        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };
    const handleFloatingClick = (event: React.MouseEvent<HTMLButtonElement>) => {
        if (suppressClickRef.current) {
            event.preventDefault();
            event.stopPropagation();
            suppressClickRef.current = false;
            return;
        }
        setOpen(true);
    };

    if (!isDevDebugAvailable()) return null;

    const panelPosition = getPanelPosition(floatingPosition);

    return (
        <div
            className="fixed select-none"
            style={{
                left: open ? panelPosition.x : floatingPosition.x,
                top: open ? panelPosition.y : floatingPosition.y,
                zIndex: 2147483646,
            }}
        >
            {!open && (
                <button
                    type="button"
                    aria-label="打开调试面板"
                    onClick={handleFloatingClick}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={finishDrag}
                    onPointerCancel={finishDrag}
                    className="relative flex h-11 w-11 cursor-grab touch-none items-center justify-center rounded-full border border-white/15 bg-black/45 text-white shadow-lg backdrop-blur-md active:scale-95 active:cursor-grabbing"
                >
                    <Wrench size={20} weight="bold" />
                    {activeCount > 0 && (
                        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-300 px-1 text-[10px] font-black leading-none text-black">
                            {activeCount}
                        </span>
                    )}
                </button>
            )}

            {open && (
                <section
                    className="max-h-[calc(100vh-32px)] w-[min(342px,calc(100vw-32px))] overflow-y-auto rounded-2xl border border-white/12 bg-zinc-950/90 text-white shadow-2xl backdrop-blur-xl"
                    aria-label="开发调试面板"
                >
                    <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                        <div className="flex min-w-0 items-center gap-2">
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-amber-200">
                                <Wrench size={17} weight="bold" />
                            </div>
                            <div className="min-w-0">
                                <div className="text-sm font-black leading-tight">Dev Debug</div>
                                <div className="truncate font-mono text-[10px] text-white/40">
                                    {__BUILD_BRANCH__}@{__BUILD_COMMIT__}
                                </div>
                            </div>
                        </div>
                        <button
                            type="button"
                            aria-label="关闭调试面板"
                            onClick={() => setOpen(false)}
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/70 active:scale-95"
                        >
                            <X size={15} weight="bold" />
                        </button>
                    </div>

                    <div className="px-4">
                        <ToggleRow
                            title="跳过 Prompt Build"
                            detail="只发送聊天历史。"
                            checked={flags.skipPromptBuild}
                            onChange={(checked) => updateFlag('skipPromptBuild', checked)}
                        />
                        <div className="h-px bg-white/10" />
                        <ToggleRow
                            title="暂停情绪副评估"
                            detail="主回复仍照常发送，但不启动本地或 Instant Push 的 emotion eval。"
                            checked={flags.skipEmotionEval}
                            onChange={(checked) => updateFlag('skipEmotionEval', checked)}
                        />
                        <div className="h-px bg-white/10" />
                        <ToggleRow
                            title="记录 LLM 日志"
                            detail="记录请求和 raw response，关闭后清空。"
                            checked={flags.captureLlmLog}
                            onChange={(checked) => updateFlag('captureLlmLog', checked)}
                        />
                        <button
                            type="button"
                            onClick={copyLlmLog}
                            disabled={llmLogCount === 0}
                            className={`mb-3 flex h-8 w-full items-center justify-center gap-1.5 rounded-full px-3 text-[11px] font-bold transition-colors ${
                                llmLogCount > 0
                                    ? 'bg-white/10 text-white/75 active:scale-95'
                                    : 'bg-white/5 text-white/25'
                            }`}
                        >
                            <ClipboardText size={13} weight="bold" />
                            {copied ? '已复制' : llmLogCount > 0 ? `复制日志 (${llmLogCount})` : '暂无日志'}
                        </button>
                    </div>

                    <div className="flex items-center justify-between gap-3 border-t border-white/10 px-4 py-3">
                        <span className="text-[10px] text-white/35">
                            仅开发分支显示，正式分支会自动收起。
                        </span>
                        <button
                            type="button"
                            onClick={resetFlags}
                            className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-white/10 px-3 text-[11px] font-bold text-white/70 active:scale-95"
                        >
                            <ArrowsClockwise size={13} weight="bold" />
                            重置
                        </button>
                    </div>
                </section>
            )}
        </div>
    );
};

export default DevDebugPanel;
