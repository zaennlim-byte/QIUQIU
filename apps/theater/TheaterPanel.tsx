/**
 * 彼方·剧院 面板 —— 场景内的话剧部门，整体走动森羊皮纸"戏单板"风。
 *
 * 投稿池(浏览/写/LLM代写/传txt) → 选一本【编排】(选角+缺角roll NPC+调用模式+可润色)
 * → 并发收集演员意见(已就绪/吐槽) → 【召唤导演】整合最终本 → chibi 小人蹦跶着演出
 * → 收录【历史舞台剧】+ 回发各参演角色聊天。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { X, CaretLeft, CaretRight, Plus, Trash, Sparkle, Play, FilmSlate, UploadSimple, DownloadSimple } from '@phosphor-icons/react';
import { DB } from '../../utils/db';
import { IslandButton, IslandInput, IslandSelect, IslandModal, ISLAND } from '../../components/island/IslandUI';
import { SCRIPT_TEMPLATE, PLAY_LITERARY_STYLES, PLAY_ART_STYLES } from '../../utils/vrWorld/constants';
import { resolveTheaterApi, generateScript, polishScript, collectActorNotes, charActorCount, runDirector, type TheaterCtx } from '../../utils/vrWorld/theater';
import { rollNpcChibi, randomNpcName } from '../../utils/vrWorld/npcRoll';
import { getChibi } from '../../utils/vrWorld/chibi';
import type { VRScript, VRStagedPlay, VRCastAssign, VRActorNote, VRStageMode, VRPlayRole, Emoji, EmojiCategory, CharacterProfile } from '../../types';

const tid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/** 把上传的 txt 解析成剧本（尽量贴模板，解析不出就整段当正文）。 */
function parseUploadedScript(text: string, fallbackTitle: string): { title: string; logline: string; roles: VRPlayRole[]; body: string } {
    const grab = (label: string) => { const m = text.match(new RegExp(`${label}\\s*[:：]\\s*(.+)`)); return m ? m[1].trim() : ''; };
    const title = grab('标题') || fallbackTitle;
    const logline = grab('简介');
    const roles: VRPlayRole[] = [];
    const rolesBlock = text.match(/登场角色\s*[:：]?\s*\n([\s\S]*?)(?:\n\s*正文|\n\s*$)/);
    if (rolesBlock) for (const raw of rolesBlock[1].split('\n')) {
        const l = raw.replace(/^[-·•\s]+/, '').trim(); if (!l) continue;
        const [name, ...rest] = l.split(/[|｜/／:：]/);
        if (name.trim()) roles.push({ name: name.trim(), persona: rest.join('/').trim() });
    }
    const bodyM = text.match(/正文\s*[:：]?\s*\n([\s\S]*)$/);
    return { title, logline, roles, body: (bodyM ? bodyM[1] : text).trim() };
}

type View = 'list' | 'script' | 'stage' | 'play';

const TheaterPanel: React.FC<{ addToast?: (m: string, t?: any) => void }> = ({ addToast }) => {
    const { characters, userProfile, groups, apiConfig } = useOS();
    const [tab, setTab] = useState<'scripts' | 'history'>('scripts');
    const [scripts, setScripts] = useState<VRScript[]>([]);
    const [plays, setPlays] = useState<VRStagedPlay[]>([]);
    const [view, setView] = useState<View>('list');
    const [cur, setCur] = useState<VRScript | null>(null);
    const [curPlay, setCurPlay] = useState<VRStagedPlay | null>(null);
    const [page, setPage] = useState(0);
    const [emojis, setEmojis] = useState<Emoji[]>([]);
    const [categories, setCategories] = useState<EmojiCategory[]>([]);
    const [writeOpen, setWriteOpen] = useState(false);
    const [llmOpen, setLlmOpen] = useState(false);

    const reload = useCallback(async () => {
        setScripts(await DB.getVRScripts());
        setPlays(await DB.getVRStagedPlays());
    }, []);
    useEffect(() => {
        void reload();
        void (async () => { setEmojis(await DB.getEmojis()); setCategories(await DB.getEmojiCategories()); })();
        const onDone = () => { void reload(); };
        window.addEventListener('vr-session-done', onDone);
        return () => window.removeEventListener('vr-session-done', onDone);
    }, [reload]);

    const ctx: TheaterCtx = useMemo(() => ({ characters, userProfile: userProfile!, groups, emojis, categories }), [characters, userProfile, groups, emojis, categories]);

    const PER = 6;
    const totalPages = Math.max(1, Math.ceil(scripts.length / PER));
    const shown = scripts.slice(page * PER, page * PER + PER);

    return (
        <>
            <div className="absolute left-3 right-3 z-20 rounded-[18px] overflow-hidden flex flex-col"
                style={{ top: 'calc(var(--chrome-top) + 3.75rem)', bottom: 'calc(var(--safe-bottom) + 0.75rem)', background: ISLAND.contentBg, border: `2px solid ${ISLAND.border}`, color: ISLAND.text, fontFamily: ISLAND.fontStack, boxShadow: '0 12px 34px rgba(0,0,0,.5)' }}>
                {/* 戏院招牌 marquee */}
                <div className="relative shrink-0" style={{ background: `linear-gradient(180deg,${ISLAND.primary},${ISLAND.primaryActive})`, padding: '8px 12px 9px' }}>
                    <div className="flex items-center justify-center gap-1.5">
                        {[0, 1, 2].map(i => <span key={'l' + i} className="rounded-full" style={{ width: 5, height: 5, background: '#fff', opacity: .9, animation: `theaterBulb 1.2s ${i * .2}s infinite` }} />)}
                        <span style={{ fontWeight: 900, fontSize: 16, letterSpacing: '.3em', color: '#fff', textShadow: '0 2px 0 rgba(0,0,0,.18)' }}>🎭 剧 场</span>
                        {[0, 1, 2].map(i => <span key={'r' + i} className="rounded-full" style={{ width: 5, height: 5, background: '#fff', opacity: .9, animation: `theaterBulb 1.2s ${i * .2 + .3}s infinite` }} />)}
                    </div>
                    <div style={{ fontSize: 9, textAlign: 'center', color: 'rgba(255,255,255,.8)', marginTop: 1 }}>NOW SHOWING · 今日上演</div>
                </div>
                <style>{`@keyframes theaterBulb{0%,100%{opacity:.4}50%{opacity:1}}@keyframes theaterHop{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}@keyframes theaterHopActive{0%,100%{transform:translateY(0)}30%{transform:translateY(-13px)}60%{transform:translateY(-2px)}}`}</style>

                {/* tabs（票根样式） */}
                <div className="flex items-center gap-2 px-3 py-2 shrink-0" style={{ borderBottom: `1px dashed ${ISLAND.border}` }}>
                    {(['scripts', 'history'] as const).map(t => {
                        const on = tab === t;
                        return (
                            <button key={t} onClick={() => { setTab(t); setView('list'); }}
                                style={{ fontSize: 12, fontWeight: 800, padding: '4px 14px', borderRadius: 999, border: `2px solid ${on ? ISLAND.primarySolid : ISLAND.border}`, background: on ? ISLAND.primary : ISLAND.subtleBg, color: on ? '#fff' : ISLAND.subText }}>
                                {t === 'scripts' ? '剧本投稿' : '历史舞台剧'}
                            </button>
                        );
                    })}
                    <span className="ml-auto" style={{ fontSize: 9, color: ISLAND.subText }}>{tab === 'scripts' ? `${scripts.length} 份剧本` : `${plays.length} 场演出`}</span>
                </div>

                <div className="flex-1 overflow-y-auto vr-reader-scroll p-3" style={{ color: ISLAND.text }}>
                    {/* ===== 剧本列表 ===== */}
                    {tab === 'scripts' && view === 'list' && (
                        <>
                            <div className="flex gap-2 mb-3 flex-wrap">
                                <IslandButton size="small" type="primary" icon={<Plus size={13} weight="bold" />} onClick={() => setWriteOpen(true)}>我来写</IslandButton>
                                <IslandButton size="small" icon={<Sparkle size={13} weight="bold" />} onClick={() => setLlmOpen(true)}>LLM 代写</IslandButton>
                                <UploadButton onParsed={async (p) => {
                                    const s: VRScript = { id: tid('scr'), ...p, authorId: 'user', authorName: userProfile?.name || '我', source: 'upload', createdAt: Date.now() };
                                    await DB.saveVRScript(s); await reload(); addToast?.(`已收录《${s.title}》`, 'success');
                                }} />
                            </div>
                            {scripts.length === 0 ? (
                                <p style={{ fontSize: 11.5, color: ISLAND.subText, textAlign: 'center', padding: '40px 0', lineHeight: 1.8 }}>戏单板还空着。<br />让角色逛进剧院写一出，或你自己投一稿。</p>
                            ) : (
                                <div className="space-y-2">
                                    {shown.map(s => (
                                        <button key={s.id} onClick={() => { setCur(s); setView('script'); }} className="w-full text-left active:scale-[0.99] transition-transform"
                                            style={{ background: ISLAND.subtleBg, border: `2px solid ${ISLAND.lightBorder}`, borderRadius: 14, padding: 10, boxShadow: `0 3px 0 ${ISLAND.lightBorder}` }}>
                                            <div className="flex items-center gap-1.5">
                                                <FilmSlate size={13} weight="fill" style={{ color: ISLAND.primary }} className="shrink-0" />
                                                <span style={{ fontSize: 12.5, fontWeight: 800, color: ISLAND.text }} className="truncate">《{s.title}》</span>
                                                <span className="ml-auto shrink-0" style={{ fontSize: 8.5, color: ISLAND.subText }}>{s.authorName}</span>
                                            </div>
                                            {s.logline && <p style={{ fontSize: 10.5, color: ISLAND.subText, marginTop: 2, lineHeight: 1.4 }} className="line-clamp-2">{s.logline}</p>}
                                            <p style={{ fontSize: 8.5, color: ISLAND.subText, marginTop: 4 }}>{s.roles.length} 个角色 · {new Date(s.createdAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</p>
                                        </button>
                                    ))}
                                    {totalPages > 1 && (
                                        <div className="flex items-center justify-center gap-3 pt-1">
                                            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={pgBtn(page === 0)}><CaretLeft size={11} weight="bold" /></button>
                                            <span style={{ fontSize: 10, color: ISLAND.subText }} className="tabular-nums">{page + 1}/{totalPages}</span>
                                            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={pgBtn(page >= totalPages - 1)}><CaretRight size={11} weight="bold" /></button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </>
                    )}

                    {/* ===== 历史舞台剧 ===== */}
                    {tab === 'history' && view === 'list' && (
                        plays.length === 0 ? (
                            <p style={{ fontSize: 11.5, color: ISLAND.subText, textAlign: 'center', padding: '40px 0', lineHeight: 1.8 }}>还没有演出。<br />去剧本投稿里挑一本【编排】上演吧。</p>
                        ) : (
                            <div className="space-y-2">
                                {plays.map(p => (
                                    <button key={p.id} onClick={() => { setCurPlay(p); setView('play'); }} className="w-full text-left active:scale-[0.99] transition-transform"
                                        style={{ background: ISLAND.subtleBg, border: `2px solid ${ISLAND.lightBorder}`, borderRadius: 14, padding: 10, boxShadow: `0 3px 0 ${ISLAND.lightBorder}` }}>
                                        <div className="flex items-center gap-1.5">
                                            <span style={{ fontSize: 12.5, fontWeight: 800, color: ISLAND.text }} className="truncate">《{p.title}》</span>
                                            <span className="ml-auto shrink-0" style={{ fontSize: 11, fontWeight: 800, color: ISLAND.warning }}>{p.rating?.split(/\s/)[0]}</span>
                                        </div>
                                        <p style={{ fontSize: 9.5, color: ISLAND.subText, marginTop: 2 }}>{p.cast.map(c => c.actorName).join('、')}</p>
                                    </button>
                                ))}
                            </div>
                        )
                    )}

                    {view === 'script' && cur && (
                        <ScriptView script={cur} onBack={() => setView('list')} onStage={() => setView('stage')}
                            onDelete={async () => { await DB.deleteVRScript(cur.id); await reload(); setView('list'); addToast?.('已删除', 'success'); }} />
                    )}
                    {view === 'stage' && cur && (
                        <StageView script={cur} ctx={ctx} apiConfig={apiConfig} addToast={addToast}
                            onBack={() => setView('list')}
                            onPolished={(body) => setCur({ ...cur, body })}
                            onStaged={async (play) => { await DB.saveVRStagedPlay(play); await reload(); setCurPlay(play); setView('play'); }} />
                    )}
                    {view === 'play' && curPlay && (
                        <PlaybackView play={curPlay} characters={characters} onBack={() => { setView('list'); setTab('history'); }} />
                    )}
                </div>
            </div>

            <WriteScriptModal open={writeOpen} onClose={() => setWriteOpen(false)}
                onSave={async (p) => {
                    const s: VRScript = { id: tid('scr'), ...p, authorId: 'user', authorName: userProfile?.name || '我', source: 'user', createdAt: Date.now() };
                    await DB.saveVRScript(s); await reload(); setWriteOpen(false); addToast?.(`已投稿《${s.title}》`, 'success');
                }} />
            <LLMScriptModal open={llmOpen} onClose={() => setLlmOpen(false)} apiConfig={apiConfig} addToast={addToast}
                onSaved={async () => { await reload(); setLlmOpen(false); }} />
        </>
    );
};

const pgBtn = (disabled: boolean): React.CSSProperties => ({ height: 24, width: 24, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', color: ISLAND.subText, border: `1.5px solid ${ISLAND.border}`, opacity: disabled ? 0.3 : 1, background: ISLAND.subtleBg });

// ============ 看剧本 ============
const ScriptView: React.FC<{ script: VRScript; onBack: () => void; onStage: () => void; onDelete: () => void }> = ({ script, onBack, onStage, onDelete }) => (
    <div>
        <div className="flex items-center gap-2 mb-2">
            <button onClick={onBack} style={{ color: ISLAND.subText, padding: 4, marginLeft: -4 }}><CaretLeft size={18} /></button>
            <span style={{ fontSize: 13, fontWeight: 800, color: ISLAND.text }} className="truncate">《{script.title}》</span>
            <button onClick={onDelete} style={{ marginLeft: 'auto', color: ISLAND.error, padding: 4, opacity: .7 }}><Trash size={15} /></button>
        </div>
        {script.logline && <p style={{ fontSize: 11, color: ISLAND.subText, marginBottom: 8, fontStyle: 'italic' }}>{script.logline}</p>}
        <div style={{ fontSize: 10, color: ISLAND.subText, marginBottom: 8 }}>登场：{script.roles.map(r => `${r.name}（${r.persona}）`).join('、') || '—'}</div>
        <pre style={{ fontSize: 11, color: ISLAND.text, whiteSpace: 'pre-wrap', lineHeight: 1.7, borderRadius: 12, padding: 10, marginBottom: 12, background: ISLAND.elevatedBg, border: `1.5px solid ${ISLAND.lightBorder}`, fontFamily: ISLAND.fontStack }}>{script.body}</pre>
        <IslandButton type="primary" block icon={<FilmSlate size={14} weight="fill" />} onClick={onStage}>编排这出戏</IslandButton>
    </div>
);

// ============ 编排 ============
const StageView: React.FC<{
    script: VRScript; ctx: TheaterCtx; apiConfig: any; addToast?: (m: string, t?: any) => void;
    onBack: () => void; onPolished: (body: string) => void; onStaged: (play: VRStagedPlay) => void;
}> = ({ script, ctx, apiConfig, addToast, onBack, onPolished, onStaged }) => {
    const [step, setStep] = useState<'cast' | 'notes'>('cast');
    const [assign, setAssign] = useState<Record<string, VRCastAssign>>({});
    const [mode, setMode] = useState<VRStageMode>('per-role');
    const [busy, setBusy] = useState('');
    const [notes, setNotes] = useState<VRActorNote[]>([]);
    const [polishOpen, setPolishOpen] = useState(false);
    const [rolling, setRolling] = useState('');

    const charOpts = useMemo(() => [{ key: '', label: '— 选演员 —' }, ...ctx.characters.map(c => ({ key: c.id, label: c.name }))], [ctx.characters]);
    const cast = useMemo(() => script.roles.map(r => assign[r.name]).filter(Boolean) as VRCastAssign[], [assign, script.roles]);
    const allCast = cast.length === script.roles.length && script.roles.length > 0;
    const charCount = charActorCount(cast);

    const setChar = (role: VRPlayRole, charId: string) => {
        if (!charId) { setAssign(a => { const n = { ...a }; delete n[role.name]; return n; }); return; }
        const ch = ctx.characters.find(c => c.id === charId);
        if (ch) setAssign(a => ({ ...a, [role.name]: { roleName: role.name, actorId: ch.id, actorName: ch.name, isNpc: false } }));
    };
    const rollNpc = async (role: VRPlayRole) => {
        setRolling(role.name);
        const name = randomNpcName(Object.values(assign).map(c => c.actorName));
        const npc = await rollNpcChibi();
        setAssign(a => ({ ...a, [role.name]: { roleName: role.name, actorId: tid('npc'), actorName: name, isNpc: true, npcChibi: npc?.img } }));
        setRolling('');
        addToast?.(npc ? `捏了个 NPC：${name}` : `NPC ${name}（立绘没出来，用占位）`, npc ? 'success' : 'error');
    };

    const runStaging = async () => {
        const api = await resolveTheaterApi(apiConfig);
        if (!api) { addToast?.('没配 API，去「API」标签填一下', 'error'); return; }
        setBusy(mode === 'two-call' ? '演员们在读剧本（固定2次调用）…' : `${charCount} 位演员在各自读剧本…`);
        try {
            const result = await collectActorNotes(script, cast, mode, ctx, api);
            setNotes(result); setStep('notes');
            for (const n of result) {
                if (n.actorId.startsWith('npc')) continue;
                const act = !n.cooperative ? `对舞台剧《${script.title}》有点抵触，觉得：${n.note}`
                    : n.changes ? `修改了舞台剧《${script.title}》的内容，觉得：${n.note}`
                    : `读了舞台剧《${script.title}》，觉得：${n.note}`;
                await DB.saveMessage({ charId: n.actorId, role: 'assistant', type: 'vr_card', content: `「彼方 · 剧院」${n.actorName}${act}`, metadata: { vrCard: true, room: 'theater', activity: act, behavior: n.changes } } as any);
            }
        } catch (e: any) { addToast?.('编排失败：' + (e?.message || '检查网络/API'), 'error'); }
        finally { setBusy(''); }
    };

    const summonDirector = async () => {
        const api = await resolveTheaterApi(apiConfig);
        if (!api) { addToast?.('没配 API', 'error'); return; }
        setBusy('导演在整合最终本…');
        try {
            const d = await runDirector(script, cast, notes, api);
            const play: VRStagedPlay = { id: tid('play'), scriptId: script.id, title: script.title, logline: script.logline, cast, notes, stage: d.stage, reviews: d.reviews, rating: d.rating, createdAt: Date.now() };
            const castNames = cast.map(c => c.actorName).join('、');
            for (const c of cast) {
                if (c.isNpc) continue;
                const act = `参演的舞台剧《${script.title}》落幕了（演员：${castNames}）。综评 ${d.rating}`;
                await DB.saveMessage({ charId: c.actorId, role: 'assistant', type: 'vr_card', content: `「彼方 · 剧院」${act}`, metadata: { vrCard: true, room: 'theater', activity: act } } as any);
            }
            onStaged(play);
        } catch (e: any) { addToast?.('导演罢工了：' + (e?.message || '检查网络/API'), 'error'); }
        finally { setBusy(''); }
    };

    if (busy) return (
        <div style={{ padding: '64px 0', textAlign: 'center' }}>
            <div className="inline-block animate-spin rounded-full" style={{ height: 28, width: 28, border: `3px solid ${ISLAND.lightBorder}`, borderTopColor: ISLAND.primary, marginBottom: 12 }} />
            <p style={{ fontSize: 11.5, color: ISLAND.subText }}>{busy}</p>
        </div>
    );

    return (
        <div>
            <div className="flex items-center gap-2 mb-2">
                <button onClick={onBack} style={{ color: ISLAND.subText, padding: 4, marginLeft: -4 }}><CaretLeft size={18} /></button>
                <span style={{ fontSize: 13, fontWeight: 800, color: ISLAND.text }} className="truncate">编排《{script.title}》</span>
            </div>

            {step === 'cast' && (
                <>
                    <div className="flex items-center justify-between mb-2">
                        <span style={{ fontSize: 10, letterSpacing: '.1em', color: ISLAND.subText }}>选角</span>
                        <IslandButton size="small" icon={<Sparkle size={12} />} onClick={() => setPolishOpen(true)}>润色剧本</IslandButton>
                    </div>
                    <div className="space-y-2 mb-3">
                        {script.roles.map(r => {
                            const a = assign[r.name];
                            return (
                                <div key={r.name} style={{ background: ISLAND.subtleBg, border: `2px solid ${ISLAND.lightBorder}`, borderRadius: 14, padding: 9 }}>
                                    <div style={{ fontSize: 11, fontWeight: 800, color: ISLAND.text }}>{r.name} <span style={{ fontSize: 9, fontWeight: 400, color: ISLAND.subText }}>{r.persona}</span></div>
                                    {a?.isNpc ? (
                                        <div className="flex items-center gap-2" style={{ marginTop: 6 }}>
                                            {a.npcChibi ? <img src={a.npcChibi} style={{ height: 28, objectFit: 'contain' }} alt="" /> : <div style={{ height: 28, width: 28, borderRadius: 999, background: ISLAND.primaryBg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: ISLAND.primary }}>{a.actorName.slice(0, 1)}</div>}
                                            <span style={{ fontSize: 11, color: ISLAND.text }}>{a.actorName} <span style={{ fontSize: 8.5, color: ISLAND.primary }}>NPC</span></span>
                                            <button onClick={() => setChar(r, '')} style={{ marginLeft: 'auto', color: ISLAND.subText, padding: 4 }}><X size={13} /></button>
                                        </div>
                                    ) : (
                                        <div className="flex items-center gap-1.5" style={{ marginTop: 6 }}>
                                            <div className="flex-1"><IslandSelect value={a?.actorId || ''} onChange={(v) => setChar(r, v)} options={charOpts} /></div>
                                            <IslandButton size="small" disabled={!!rolling} onClick={() => rollNpc(r)}>{rolling === r.name ? '🎲…' : '🎲NPC'}</IslandButton>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    <div style={{ fontSize: 10, letterSpacing: '.1em', color: ISLAND.subText, marginBottom: 6 }}>演员表演方式</div>
                    <div className="grid grid-cols-2 gap-2 mb-2">
                        {([['per-role', '逐角色', '每位角色各调一次 LLM（精准、贴人设）'], ['two-call', '固定两次', '1 次搞定全部演员（省，但可能 OOC）']] as const).map(([m, t, d]) => {
                            const on = mode === m;
                            return (
                                <button key={m} onClick={() => setMode(m)} style={{ borderRadius: 14, padding: 9, textAlign: 'left', background: on ? ISLAND.primaryBg : ISLAND.subtleBg, border: `2px solid ${on ? ISLAND.primary : ISLAND.lightBorder}` }}>
                                    <div style={{ fontSize: 11, fontWeight: 800, color: ISLAND.text }}>{t}</div>
                                    <div style={{ fontSize: 8.5, color: ISLAND.subText, lineHeight: 1.4, marginTop: 2 }}>{d}</div>
                                </button>
                            );
                        })}
                    </div>
                    <p style={{ fontSize: 9, color: ISLAND.subText, marginBottom: 8, textAlign: 'center' }}>
                        本次约调用 <b style={{ color: ISLAND.primaryActive }}>{mode === 'two-call' ? (charCount > 0 ? 2 : 1) : charCount + 1}</b> 次 LLM
                        {mode === 'per-role' ? `（${charCount} 角色 + 1 导演；NPC 不计）` : '（演员 1 次 + 导演 1 次）'}
                    </p>
                    <IslandButton type="primary" block disabled={!allCast} onClick={runStaging}>{allCast ? '开始编排 →' : '先给每个角色选演员'}</IslandButton>
                </>
            )}

            {step === 'notes' && (
                <>
                    <div style={{ fontSize: 10, letterSpacing: '.1em', color: ISLAND.subText, marginBottom: 8 }}>演员就位 · 各自的意见</div>
                    <div className="space-y-2 mb-3">{notes.map((n, i) => <ActorNoteCard key={i} note={n} cast={cast} characters={ctx.characters} />)}</div>
                    <IslandButton type="primary" block icon={<FilmSlate size={14} weight="fill" />} onClick={summonDirector}>召唤导演 · 整合最终本</IslandButton>
                </>
            )}

            <PolishModal open={polishOpen} onClose={() => setPolishOpen(false)} apiConfig={apiConfig} body={script.body} addToast={addToast}
                onPolished={(body) => { onPolished(body); setPolishOpen(false); addToast?.('润色好啦', 'success'); }} />
        </div>
    );
};

const ActorNoteCard: React.FC<{ note: VRActorNote; cast: VRCastAssign[]; characters: CharacterProfile[] }> = ({ note, cast, characters }) => {
    const [open, setOpen] = useState(false);
    const assign = cast.find(c => c.actorId === note.actorId);
    const ch = characters.find(c => c.id === note.actorId);
    const img = assign?.npcChibi || (ch ? getChibi(ch).img : undefined);
    return (
        <button onClick={() => setOpen(o => !o)} className="w-full text-left" style={{ background: ISLAND.subtleBg, borderRadius: 14, padding: 9, border: `2px solid ${note.cooperative ? ISLAND.lightBorder : 'rgba(224,90,90,.55)'}` }}>
            <div className="flex items-center gap-2">
                {img ? <img src={img} style={{ height: 28, width: 28, objectFit: 'contain' }} alt="" /> : <div style={{ height: 28, width: 28, borderRadius: 999, background: ISLAND.primaryBg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: ISLAND.primary }}>{note.actorName.slice(0, 1)}</div>}
                <span style={{ fontSize: 11, fontWeight: 800, color: ISLAND.text }}>{note.actorName}</span>
                <span style={{ fontSize: 8.5, color: ISLAND.subText }}>饰 {note.roleName}</span>
                <span className="ml-auto" style={{ fontSize: 9, fontWeight: 700, color: note.cooperative ? ISLAND.success : ISLAND.error }}>{note.cooperative ? '已就绪' : '有意见'}</span>
            </div>
            <p style={{ fontSize: 10.5, color: ISLAND.text, marginTop: 4, lineHeight: 1.4 }}>{note.note}</p>
            {open && note.changes && <p style={{ fontSize: 10, color: ISLAND.primaryActive, marginTop: 4, paddingLeft: 8, borderLeft: `2px solid ${ISLAND.primary}`, lineHeight: 1.4 }}>改：{note.changes}</p>}
        </button>
    );
};

// ============ 演出回放（chibi 小人蹦跶） ============
const PlaybackView: React.FC<{ play: VRStagedPlay; characters: CharacterProfile[]; onBack: () => void }> = ({ play, characters, onBack }) => {
    const [i, setI] = useState(0);
    const beats = play.stage;
    const ended = i >= beats.length;

    const onStage = useMemo(() => {
        const s = new Set<string>();
        for (let k = 0; k <= Math.min(i, beats.length - 1); k++) {
            const b = beats[k];
            if (b.kind === 'enter' && b.actorName) s.add(b.actorName);
            if (b.kind === 'exit' && b.actorName) s.delete(b.actorName);
        }
        if (s.size === 0) play.cast.forEach(c => s.add(c.actorName));
        return s;
    }, [i, beats, play.cast]);

    const chibiOf = (actorName: string): { img?: string; scale: number; offsetY: number; flip: boolean } => {
        const a = play.cast.find(c => c.actorName === actorName);
        if (a?.npcChibi) return { img: a.npcChibi, scale: 1, offsetY: 0, flip: false };
        const ch = characters.find(c => c.id === a?.actorId);
        if (ch) { const d = getChibi(ch); return { img: d.img || undefined, scale: d.scale, offsetY: d.offsetY, flip: d.flip }; }
        return { scale: 1, offsetY: 0, flip: false };
    };

    const beat = beats[Math.min(i, beats.length - 1)];
    const speaker = beat?.kind === 'line' ? beat.actorName : undefined;
    const stageArr = [...onStage];

    return (
        <div>
            <div className="flex items-center gap-2 mb-2">
                <button onClick={onBack} style={{ color: ISLAND.subText, padding: 4, marginLeft: -4 }}><CaretLeft size={18} /></button>
                <span style={{ fontSize: 13, fontWeight: 800, color: ISLAND.text }} className="truncate">《{play.title}》</span>
                <span className="ml-auto" style={{ fontSize: 11, fontWeight: 800, color: ISLAND.warning }}>{play.rating?.split(/\s/)[0]}</span>
            </div>

            {/* 舞台（保留暗色戏剧感，chibi 在上面蹦） */}
            <div style={{ height: 248, borderRadius: 14, position: 'relative', overflow: 'hidden', marginBottom: 12, background: 'linear-gradient(180deg,#3a0d14 0%,#1c0608 100%)', border: `2px solid ${ISLAND.border}` }}>
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 18, background: 'repeating-linear-gradient(90deg,#7a1020 0 10px,#a11528 10px 20px)' }} />
                {/* 追光 */}
                <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: 8, width: '60%', height: '78%', background: 'radial-gradient(ellipse at 50% 0%, rgba(255,224,150,.20), transparent 70%)', pointerEvents: 'none' }} />
                {!ended && beat && (
                    <div style={{ position: 'absolute', left: 12, right: 12, top: 28, zIndex: 10 }}>
                        {beat.kind === 'narration' ? (
                            <div style={{ textAlign: 'center', fontSize: 10.5, color: 'rgba(255,235,205,.85)', fontStyle: 'italic', padding: '6px 12px', borderRadius: 10, background: 'rgba(0,0,0,.42)' }}>（{beat.text}）</div>
                        ) : beat.kind === 'line' ? (
                            <div style={{ margin: '0 auto', width: 'fit-content', maxWidth: '100%', padding: '8px 12px', borderRadius: 16, fontSize: 12, color: ISLAND.text, fontWeight: 600, background: ISLAND.elevatedBg, border: `2px solid ${ISLAND.lightBorder}`, boxShadow: '0 3px 0 rgba(0,0,0,.3)' }}>
                                <span style={{ fontSize: 9, color: ISLAND.primary, fontWeight: 800, display: 'block' }}>{beat.actorName}</span>{beat.text}
                            </div>
                        ) : (
                            <div style={{ textAlign: 'center', fontSize: 9.5, color: 'rgba(255,210,210,.6)' }}>（{beat.actorName} {beat.kind === 'enter' ? '上场' : '下场'}）</div>
                        )}
                    </div>
                )}
                {/* chibi 演员，蹦蹦跳跳 */}
                <div style={{ position: 'absolute', bottom: 8, left: 0, right: 0, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 10, padding: '0 12px' }}>
                    {stageArr.map((name, idx) => {
                        const c = chibiOf(name);
                        const active = name === speaker;
                        return (
                            <div key={name} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', animation: active ? 'theaterHopActive .6s ease-in-out infinite' : `theaterHop 1.8s ${idx * .25}s ease-in-out infinite`, opacity: active || !speaker ? 1 : 0.55, transition: 'opacity .2s' }}>
                                {c.img ? (
                                    <img src={c.img} alt="" style={{ height: 92 * (active ? 1.06 : 1), transform: `scaleX(${c.flip ? -1 : 1}) translateY(${c.offsetY}px)`, objectFit: 'contain', filter: active ? 'drop-shadow(0 0 9px rgba(255,210,120,.7))' : 'drop-shadow(0 4px 4px rgba(0,0,0,.4))' }} />
                                ) : (
                                    <div style={{ height: 48, width: 48, borderRadius: 999, background: ISLAND.primary, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>{name.slice(0, 1)}</div>
                                )}
                                <span style={{ fontSize: 8, color: 'rgba(255,245,235,.85)', marginTop: 2, background: 'rgba(0,0,0,.35)', padding: '0 5px', borderRadius: 999 }}>{name}</span>
                            </div>
                        );
                    })}
                </div>
            </div>

            {!ended ? (
                <div className="flex items-center gap-2">
                    <span style={{ fontSize: 9, color: ISLAND.subText }} className="tabular-nums">{Math.min(i + 1, beats.length)}/{beats.length}</span>
                    <div className="ml-auto flex gap-2">
                        {i > 0 && <IslandButton size="small" onClick={() => setI(x => Math.max(0, x - 1))}>上一拍</IslandButton>}
                        <IslandButton size="small" type="primary" icon={<Play size={12} weight="fill" />} onClick={() => setI(x => x + 1)}>下一拍</IslandButton>
                    </div>
                </div>
            ) : (
                <div>
                    <div style={{ fontSize: 10, letterSpacing: '.1em', color: ISLAND.subText, marginBottom: 6 }}>谢幕 · 观众席</div>
                    <div className="space-y-1.5 mb-2">
                        {play.reviews.map((r, k) => (
                            <div key={k} style={{ borderRadius: 12, padding: 8, fontSize: 10.5, background: ISLAND.subtleBg, border: `1.5px solid ${ISLAND.lightBorder}` }}>
                                <b style={{ color: ISLAND.primaryActive }}>{r.critic}</b><span style={{ color: ISLAND.text }}>：{r.text}</span>
                            </div>
                        ))}
                    </div>
                    <div style={{ textAlign: 'center', fontSize: 12, fontWeight: 800, color: ISLAND.warning, marginBottom: 12 }}>综合评级：{play.rating}</div>
                    <div className="flex gap-2">
                        <IslandButton block onClick={() => setI(0)}>重看一遍</IslandButton>
                        <IslandButton block type="primary" onClick={onBack}>收工</IslandButton>
                    </div>
                </div>
            )}
        </div>
    );
};

// ============ 风格选择 chips（润色 & 代写共用） ============
const StyleChips: React.FC<{ label: string; options: string[]; value: string; onChange: (v: string) => void }> = ({ label, options, value, onChange }) => (
    <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, color: ISLAND.text }}>{label}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {options.map(s => {
                const on = value === s;
                return <span key={s} onClick={() => onChange(on ? '' : s)} style={{ padding: '4px 10px', borderRadius: 999, fontSize: 11, cursor: 'pointer', border: `1.5px solid ${on ? ISLAND.primary : ISLAND.border}`, background: on ? ISLAND.primaryBg : ISLAND.subtleBg, color: ISLAND.text }}>{s}</span>;
            })}
        </div>
    </div>
);

// ============ 弹窗：我来写 ============
const WriteScriptModal: React.FC<{ open: boolean; onClose: () => void; onSave: (p: { title: string; logline: string; roles: VRPlayRole[]; body: string }) => void }> = ({ open, onClose, onSave }) => {
    const [title, setTitle] = useState(''); const [logline, setLogline] = useState('');
    const [rolesText, setRolesText] = useState(''); const [body, setBody] = useState('');
    const submit = () => {
        const roles = rolesText.split('\n').map(l => l.replace(/^[-·•\s]+/, '').trim()).filter(Boolean).map(l => { const [n, ...r] = l.split(/[|｜/／:：]/); return { name: (n || '').trim(), persona: r.join('/').trim() }; }).filter(r => r.name);
        if (!title.trim() || !body.trim()) return;
        onSave({ title: title.trim(), logline: logline.trim(), roles, body: body.trim() });
        setTitle(''); setLogline(''); setRolesText(''); setBody('');
    };
    return (
        <IslandModal open={open} title="我来写一出" width={360} onClose={onClose}
            footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><IslandButton onClick={onClose}>取消</IslandButton><IslandButton type="primary" onClick={submit}>投稿</IslandButton></div>}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '52vh', overflowY: 'auto' }}>
                <IslandInput value={title} onChange={e => setTitle(e.target.value)} placeholder="剧名" />
                <IslandInput value={logline} onChange={e => setLogline(e.target.value)} placeholder="一句话简介（可空）" />
                <textarea value={rolesText} onChange={e => setRolesText(e.target.value)} rows={2} placeholder="登场角色，每行一个：角色名|性格" style={taStyle} />
                <textarea value={body} onChange={e => setBody(e.target.value)} rows={7} placeholder="正文（角色名：台词 / 动作写进圆括号）" style={taStyle} />
            </div>
        </IslandModal>
    );
};

// ============ 弹窗：LLM 代写（可选风格） ============
const LLMScriptModal: React.FC<{ open: boolean; onClose: () => void; apiConfig: any; addToast?: (m: string, t?: any) => void; onSaved: () => void }> = ({ open, onClose, apiConfig, addToast, onSaved }) => {
    const [brief, setBrief] = useState(''); const [lit, setLit] = useState(''); const [art, setArt] = useState(''); const [busy, setBusy] = useState(false);
    const gen = async () => {
        const api = await resolveTheaterApi(apiConfig);
        if (!api) { addToast?.('没配 API', 'error'); return; }
        const composed = [lit && `文学风格：${lit}`, art && `参考艺术风格：${art}`, brief.trim()].filter(Boolean).join('；') || '自由发挥，写一出有意思的短剧';
        setBusy(true);
        try {
            const p = await generateScript(composed, api);
            const s: VRScript = { id: tid('scr'), title: p.title, logline: p.logline, roles: p.roles, body: p.body, authorId: 'llm', authorName: 'LLM 编剧', source: 'llm', createdAt: Date.now() };
            await DB.saveVRScript(s); addToast?.(`写好了《${s.title}》`, 'success'); setBrief(''); setLit(''); setArt(''); onSaved();
        } catch (e: any) { addToast?.('代写失败：' + (e?.message || ''), 'error'); }
        finally { setBusy(false); }
    };
    return (
        <IslandModal open={open} title="LLM 代写" width={360} onClose={busy ? undefined : onClose} maskClosable={!busy}
            footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><IslandButton onClick={onClose} disabled={busy}>取消</IslandButton><IslandButton type="primary" disabled={busy} onClick={gen}>{busy ? '写作中…' : '写'}</IslandButton></div>}>
            <div style={{ color: ISLAND.text, maxHeight: '52vh', overflowY: 'auto' }}>
                <StyleChips label="文学风格" options={PLAY_LITERARY_STYLES} value={lit} onChange={setLit} />
                <StyleChips label="参考艺术风格" options={PLAY_ART_STYLES} value={art} onChange={setArt} />
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>主题 / 脑洞（可空）</div>
                <textarea value={brief} onChange={e => setBrief(e.target.value)} rows={3} placeholder="如：两个困在电梯里的陌生人" style={taStyle} />
            </div>
        </IslandModal>
    );
};

// ============ 弹窗：润色 ============
const PolishModal: React.FC<{ open: boolean; onClose: () => void; apiConfig: any; body: string; addToast?: (m: string, t?: any) => void; onPolished: (body: string) => void }> = ({ open, onClose, apiConfig, body, addToast, onPolished }) => {
    const [lit, setLit] = useState(''); const [art, setArt] = useState(''); const [extra, setExtra] = useState(''); const [busy, setBusy] = useState(false);
    const run = async () => {
        const api = await resolveTheaterApi(apiConfig);
        if (!api) { addToast?.('没配 API', 'error'); return; }
        setBusy(true);
        try { const p = await polishScript(body, lit, art, extra, api); onPolished(p.body); }
        catch (e: any) { addToast?.('润色失败：' + (e?.message || ''), 'error'); }
        finally { setBusy(false); }
    };
    return (
        <IslandModal open={open} title="润色剧本" width={360} onClose={busy ? undefined : onClose} maskClosable={!busy}
            footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><IslandButton onClick={onClose} disabled={busy}>取消</IslandButton><IslandButton type="primary" disabled={busy} onClick={run}>{busy ? '润色中…' : '润色'}</IslandButton></div>}>
            <div style={{ color: ISLAND.text, maxHeight: '52vh', overflowY: 'auto' }}>
                <StyleChips label="文学风格" options={PLAY_LITERARY_STYLES} value={lit} onChange={setLit} />
                <StyleChips label="参考艺术风格" options={PLAY_ART_STYLES} value={art} onChange={setArt} />
                <IslandInput value={extra} onChange={e => setExtra(e.target.value)} placeholder="额外要求（可空）" />
            </div>
        </IslandModal>
    );
};

// ============ 上传 txt ============
const UploadButton: React.FC<{ onParsed: (p: { title: string; logline: string; roles: VRPlayRole[]; body: string }) => void }> = ({ onParsed }) => {
    const inputRef = React.useRef<HTMLInputElement>(null);
    const dlTemplate = () => {
        const blob = new Blob([SCRIPT_TEMPLATE], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '剧本模板.txt'; a.click(); URL.revokeObjectURL(a.href);
    };
    return (
        <>
            <IslandButton size="small" icon={<UploadSimple size={13} weight="bold" />} onClick={() => inputRef.current?.click()}>传 txt</IslandButton>
            <IslandButton size="small" icon={<DownloadSimple size={13} weight="bold" />} onClick={dlTemplate}>模板</IslandButton>
            <input ref={inputRef} type="file" accept=".txt,text/plain" className="hidden"
                onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const text = await f.text(); onParsed(parseUploadedScript(text, f.name.replace(/\.txt$/i, ''))); e.target.value = ''; }} />
        </>
    );
};

const taStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px', fontSize: 13, fontFamily: ISLAND.fontStack, color: ISLAND.text,
    background: ISLAND.subtleBg, border: `2px solid ${ISLAND.border}`, borderRadius: ISLAND.radiusSm, outline: 'none', resize: 'vertical',
};

export default TheaterPanel;
