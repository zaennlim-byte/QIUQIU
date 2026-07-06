import React, { useState, useEffect, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { StudyCourse, StudyChapter, CharacterProfile, Message, UserProfile, APIConfig, StudyTutorPreset, QuizQuestion, QuizSession, QuizQuestionNote } from '../types';
import { ContextBuilder } from '../utils/context';
import Modal from '../components/os/Modal';
import { safeResponseJson } from '../utils/safeApi';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { Notepad, Check, X, CheckCircle, XCircle, Hand } from '@phosphor-icons/react';

type PdfJsLike = {
    getDocument: (src: { data: ArrayBuffer }) => { promise: Promise<any> };
    GlobalWorkerOptions?: { workerSrc?: string };
};

type KatexLike = {
    renderToString: (latex: string, options: any) => string;
};

let pdfjsPromise: Promise<PdfJsLike> | null = null;
let katexPromise: Promise<KatexLike> | null = null;

const loadScript = (src: string): Promise<void> => new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-src=\"${src}\"]`) as HTMLScriptElement | null;
    if (existing) {
        if ((existing as any).dataset.loaded === 'true') {
            resolve();
            return;
        }
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error(`load failed: ${src}`)), { once: true });
        return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.src = src;
    script.onload = () => {
        script.dataset.loaded = 'true';
        resolve();
    };
    script.onerror = () => reject(new Error(`load failed: ${src}`));
    document.head.appendChild(script);
});

const loadPdfJs = async (): Promise<PdfJsLike> => {
    if (!pdfjsPromise) {
        pdfjsPromise = loadScript('https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js').then(() => {
            const pdfjs = (window as any).pdfjsLib as PdfJsLike | undefined;
            if (!pdfjs) throw new Error('pdfjs 加载失败');
            if (pdfjs?.GlobalWorkerOptions) {
                pdfjs.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
            }
            return pdfjs;
        });
    }
    return pdfjsPromise;
};

const loadKatex = async (): Promise<KatexLike> => {
    if (!katexPromise) {
        katexPromise = loadScript('https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js').then(() => {
            const katex = (window as any).katex as KatexLike | undefined;
            if (!katex) throw new Error('KaTeX 加载失败');
            return katex;
        });
    }
    return katexPromise;
};

// --- Styles ---
const GRADIENTS = [
    'linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)',
    'linear-gradient(120deg, #f093fb 0%, #f5576c 100%)',
    'linear-gradient(to top, #cfd9df 0%, #e2ebf0 100%)',
    'linear-gradient(135deg, #f6d365 0%, #fda085 100%)',
    'linear-gradient(to top, #5ee7df 0%, #b490ca 100%)',
    'linear-gradient(to right, #43e97b 0%, #38f9d7 100%)'
];

// --- Renderer Component ---
// 已经写死Claude同款高级灰蓝与暖灰纸张色配色的渲染引擎
const BlackboardRenderer: React.FC<{ text: string, isTyping?: boolean, katexRenderer?: { renderToString: (latex: string, options: any) => string } | null }> = ({ text, isTyping, katexRenderer }) => {
    
    const renderMath = (latex: string, displayMode: boolean) => {
        try {
            const cleanLatex = latex
                .replace(/\\\[/g, '') 
                .replace(/\\\]/g, ''); 

            const html = katexRenderer?.renderToString(cleanLatex, {
                displayMode: displayMode,
                throwOnError: false, 
                output: 'html',
            });
            if (!html) {
                return <span className="font-mono text-[#2C3E50]">{latex}</span>;
            }
            return <span dangerouslySetInnerHTML={{ __html: html }} className={displayMode ? "block my-2 w-full overflow-x-auto" : "inline-block mx-1"} />;
        } catch (e) {
            return <span className="text-red-500 text-xs font-mono bg-black/5 p-1 rounded">{latex}</span>;
        }
    };

    const parseInline = (line: string): React.ReactNode[] => {
        const tokenRegex = /(\$[^$]+?\$|\*\*[^*]+?\*\*|\*[^*]+?\*|`[^`]+?`|【AI批注：[^】]+】)/g;
        
        return line.split(tokenRegex).map((part, i) => {
            if (part.startsWith('$') && part.endsWith('$')) {
                return <span key={i}>{renderMath(part.slice(1, -1), false)}</span>;
            }
            if (part.startsWith('**') && part.endsWith('**')) {
                return <strong key={i} className="text-[#222222] font-bold mx-0.5">{part.slice(2, -2)}</strong>;
            }
            if (part.startsWith('*') && part.endsWith('*')) {
                return <em key={i} className="text-[#666666] italic">{part.slice(1, -1)}</em>;
            }
            if (part.startsWith('`') && part.endsWith('`')) {
                return <code key={i} className="bg-[#EAECEF] text-[#333333] px-1.5 py-0.5 rounded font-mono text-[13px] mx-0.5">{part.slice(1, -1)}</code>;
            }
            if (part.startsWith('【AI批注：') && part.endsWith('】')) {
                return (
                    <span key={i} className="block my-3 px-4 py-3 bg-[#E4E8EC] text-[#4A5568] text-[15px] rounded-xl border border-[#D1D9E0]/50 leading-relaxed shadow-sm">
                        <strong className="text-[#2C3E50] mb-1 block text-[13px] opacity-80">💡 AI 批注</strong>
                        {part.slice(6, -1)}
                    </span>
                );
            }
            return <span key={i}>{part}</span>;
        });
    };

    const renderBlock = (block: string, index: number, storedMath: string[], storedCode: string[]) => {
        const trimmed = block.trim();
        if (!trimmed) return <div key={index} className="h-4"></div>;

        const mathMatch = trimmed.match(/^__BLOCK_MATH_(\d+)__$/);
        if (mathMatch) {
            return (
                <div key={index} className="w-full text-center my-4 overflow-x-auto no-scrollbar py-3 bg-black/5 rounded-xl border border-black/5 shadow-inner">
                    {renderMath(storedMath[parseInt(mathMatch[1])], true)}
                </div>
            );
        }

        const codeMatch = trimmed.match(/^__BLOCK_CODE_(\d+)__$/);
        if (codeMatch) {
            return (
                <pre key={index} className="bg-[#1E1E1E] p-4 rounded-xl font-mono text-xs text-emerald-400 my-4 overflow-x-auto shadow-inner whitespace-pre-wrap leading-relaxed">
                    {storedCode[parseInt(codeMatch[1])]}
                </pre>
            );
        }

        if (trimmed.startsWith('# ')) return <h1 key={index} className="text-3xl font-bold text-[#111111] mt-8 mb-6 pb-2 border-b-2 border-slate-300 font-sans">{trimmed.slice(2)}</h1>;
        if (trimmed.startsWith('## ')) return <h2 key={index} className="text-2xl font-bold text-[#222222] mt-6 mb-4 font-sans">{trimmed.slice(3)}</h2>;
        if (trimmed.startsWith('### ')) return <h3 key={index} className="text-xl font-bold text-[#333333] mt-5 mb-2 font-sans">{trimmed.slice(4)}</h3>;

        if (trimmed.startsWith('> ')) {
            return (
                <div key={index} className="bg-[#E4E8EC] border-l-4 border-[#8FA4B5] p-5 my-5 rounded-r-2xl text-[#3A4A5A] shadow-sm leading-[1.8] text-[16px]">
                    {parseInline(trimmed.slice(2))}
                </div>
            );
        }

        if (trimmed.match(/^[-•]\s/)) {
            return (
                <div key={index} className="flex gap-3 my-2 pl-2">
                    <span className="text-[#8FA4B5] font-bold mt-1">•</span>
                    <span className="text-[#333333] leading-relaxed">{parseInline(trimmed.slice(2))}</span>
                </div>
            );
        }
        
        const numMatch = trimmed.match(/^(\d+)\.\s+(.*)/);
        if (numMatch) {
             return (
                <div key={index} className="flex gap-3 my-2 pl-2">
                    <span className="text-[#8FA4B5] font-bold font-mono mt-1">{numMatch[1]}.</span>
                    <span className="text-[#333333] leading-relaxed">{parseInline(numMatch[2])}</span>
                </div>
            );
        }

        return (
            <div key={index} className="text-[#333333] text-[17px] font-normal leading-[1.9] tracking-wide font-sans mb-5 text-justify">
                {parseInline(block)}
            </div>
        );
    };

    const isTableRow = (line: string) => {
        const trimmed = line.trim();
        return trimmed.includes('|') && /^\|?.+\|.+\|?$/.test(trimmed);
    };

    const isTableSeparator = (line: string) => {
        const cleaned = line.trim().replace(/^\|/, '').replace(/\|$/, '');
        const segments = cleaned.split('|').map(seg => seg.trim());
        if (segments.length < 2) return false;
        return segments.every(seg => /^:?-{3,}:?$/.test(seg));
    };

    const splitTableCells = (line: string) => line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map(cell => cell.trim());

    const renderTable = (rows: string[], index: number) => {
        if (rows.length < 2) return renderBlock(rows[0], index, storedMath, storedCode);

        const header = splitTableCells(rows[0]);
        const hasSeparator = rows[1] ? isTableSeparator(rows[1]) : false;
        const bodyRows = (hasSeparator ? rows.slice(2) : rows.slice(1)).map(splitTableCells);

        return (
            <div key={`table-${index}`} className="my-4 overflow-x-auto rounded-xl border border-slate-200 bg-white/50">
                <table className="w-full min-w-[360px] border-collapse text-sm text-left">
                    <thead className="bg-slate-100">
                        <tr>
                            {header.map((cell, i) => (
                                <th key={i} className="px-3 py-2 text-[#222222] font-bold border-b border-slate-200">
                                    {parseInline(cell)}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {bodyRows.map((row, rowIndex) => (
                            <tr key={rowIndex} className="odd:bg-transparent even:bg-slate-50/50">
                                {header.map((_, colIndex) => (
                                    <td key={colIndex} className="px-3 py-2 text-[#333333] border-t border-slate-100 align-top leading-relaxed">
                                        {parseInline(row[colIndex] || '')}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    };

    const storedMath: string[] = [];
    const storedCode: string[] = [];
    let processedText = text;

    processedText = processedText.replace(/```[\s\S]*?```/g, (match) => {
        const content = match.replace(/^```\w*\n?/, '').replace(/```$/, '');
        storedCode.push(content);
        return `\n__BLOCK_CODE_${storedCode.length - 1}__\n`;
    });

    processedText = processedText.replace(/\$\$[\s\S]*?\$\$/g, (match) => {
        const content = match.slice(2, -2).trim(); 
        storedMath.push(content);
        return `\n__BLOCK_MATH_${storedMath.length - 1}__\n`;
    });

    const blocks = processedText.split('\n');
    const renderedBlocks: React.ReactNode[] = [];

    for (let i = 0; i < blocks.length; i++) {
        const line = blocks[i];
        if (isTableRow(line) && i + 1 < blocks.length && isTableSeparator(blocks[i + 1])) {
            const tableLines = [line, blocks[i + 1]];
            let j = i + 2;
            while (j < blocks.length && isTableRow(blocks[j])) {
                tableLines.push(blocks[j]);
                j += 1;
            }
            renderedBlocks.push(renderTable(tableLines, i));
            i = j - 1;
            continue;
        }
        renderedBlocks.push(renderBlock(line, i, storedMath, storedCode));
    }
    
    return (
        <div className="space-y-1">
            <style>{`
                .katex { color: #2C3E50 !important; } 
                .katex-display { margin: 0.5em 0; }
                .katex-html { color: #2C3E50 !important; }
            `}</style>
            
            {renderedBlocks}
            {isTyping && (
                <div className="mt-4 animate-pulse flex items-center gap-2 text-[#8FA4B5]">
                    <span className="w-2 h-5 bg-[#8FA4B5]"></span>
                    <span className="text-xs font-mono tracking-widest">WRITING...</span>
                </div>
            )}
        </div>
    );
};

const StudyApp: React.FC = () => {
    const { closeApp, characters, activeCharacterId, apiConfig, addToast, userProfile, updateCharacter } = useOS();
    const [mode, setMode] = useState<'bookshelf' | 'classroom' | 'quiz' | 'quiz_review' | 'practice_book'>('bookshelf');
    const [courses, setCourses] = useState<StudyCourse[]>([]);
    const [activeCourse, setActiveCourse] = useState<StudyCourse | null>(null);
    const [selectedChar, setSelectedChar] = useState<CharacterProfile | null>(null);
    
    const [classroomState, setClassroomState] = useState<'idle' | 'teaching' | 'q_and_a' | 'finished'>('idle');
    const [currentText, setCurrentText] = useState('');
    const [displayedText, setDisplayedText] = useState('');
    const [isTyping, setIsTyping] = useState(false);
    const [userQuestion, setUserQuestion] = useState('');
    const [chatHistory, setChatHistory] = useState<{role: 'user'|'assistant', content: string}[]>([]);
    const [showChapterMenu, setShowChapterMenu] = useState(false); 
    const [showAssistant, setShowAssistant] = useState(true); 
    
    const skipTypingRef = useRef(false); 

    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [processStatus, setProcessStatus] = useState('');
    const [showImportModal, setShowImportModal] = useState(false);
    const [importPreference, setImportPreference] = useState('');
    const [tempPdfData, setTempPdfData] = useState<{name: string, text: string} | null>(null);
    const [katexRenderer, setKatexRenderer] = useState<KatexLike | null>(null);

    const [studyApi, setStudyApi] = useState<Partial<APIConfig>>({});
    const [showStudySettings, setShowStudySettings] = useState(false);
    const [localStudyUrl, setLocalStudyUrl] = useState('');
    const [localStudyKey, setLocalStudyKey] = useState('');
    const [localStudyModel, setLocalStudyModel] = useState('');

    const [tutorPresets, setTutorPresets] = useState<StudyTutorPreset[]>([]);
    const [editingPreset, setEditingPreset] = useState<StudyTutorPreset | null>(null);
    const [presetName, setPresetName] = useState('');
    const [presetPrompt, setPresetPrompt] = useState('');

    const effectiveApi: APIConfig = {
        baseUrl: studyApi.baseUrl || apiConfig.baseUrl,
        apiKey: studyApi.apiKey || apiConfig.apiKey,
        model: studyApi.model || apiConfig.model,
    };

    const [deleteTarget, setDeleteTarget] = useState<StudyCourse | null>(null);

    const [quizSession, setQuizSession] = useState<QuizSession | null>(null);
    const [quizLoading, setQuizLoading] = useState<string>(''); 
    const [quizUserAnswers, setQuizUserAnswers] = useState<Record<string, string>>({});
    const [quizShowSetup, setQuizShowSetup] = useState(false);
    const [quizTypes, setQuizTypes] = useState<('choice' | 'true_false' | 'fill_blank')[]>(['choice', 'true_false', 'fill_blank']);
    const [quizCount, setQuizCount] = useState(8);
    const [allQuizzes, setAllQuizzes] = useState<QuizSession[]>([]);
    const [reviewingQuiz, setReviewingQuiz] = useState<QuizSession | null>(null);
    const [deleteQuizTarget, setDeleteQuizTarget] = useState<QuizSession | null>(null);
    const [askingQuestionId, setAskingQuestionId] = useState<string>(''); 
    const [followUpInput, setFollowUpInput] = useState('');
    const [followUpLoading, setFollowUpLoading] = useState(false);

    const currentSprite = selectedChar?.sprites?.['normal'] || selectedChar?.avatar;

    useEffect(() => {
        loadCourses();
        if (activeCharacterId) {
            const char = characters.find(c => c.id === activeCharacterId) || characters[0];
            setSelectedChar(char);
        }
    }, [activeCharacterId]);

    useEffect(() => {
        loadKatex().then(setKatexRenderer).catch(() => {});
        try {
            const savedStudyApi = localStorage.getItem('study_api_config');
            if (savedStudyApi) {
                const parsed = JSON.parse(savedStudyApi);
                setStudyApi(parsed);
                setLocalStudyUrl(parsed.baseUrl || '');
                setLocalStudyKey(parsed.apiKey || '');
                setLocalStudyModel(parsed.model || '');
            }
            const savedPresets = localStorage.getItem('study_tutor_presets');
            if (savedPresets) setTutorPresets(JSON.parse(savedPresets));
        } catch (e) { console.error('Failed to load study settings', e); }
    }, []);

    useEffect(() => {
        if (mode === 'bookshelf') {
            loadCourses();
        }
    }, [mode]);

    useEffect(() => {
        if (!currentText) return;

        if (skipTypingRef.current) {
            setDisplayedText(currentText);
            setIsTyping(false);
            skipTypingRef.current = false; 
            return;
        }

        setIsTyping(true);
        setDisplayedText('');
        let i = 0;
        const speed = 15; 
        
        const timer = setInterval(() => {
            const chunk = currentText.substring(0, i + speed);
            setDisplayedText(chunk);
            i += speed;
            if (i >= currentText.length) {
                setDisplayedText(currentText); 
                clearInterval(timer);
                setIsTyping(false);
            }
        }, 16); 

        return () => clearInterval(timer);
    }, [currentText]);

    const loadCourses = async () => {
        const list = await DB.getAllCourses();
        setCourses(list.sort((a,b) => b.createdAt - a.createdAt));
    };

    const saveStudyApi = () => {
        const cfg: Partial<APIConfig> = {};
        if (localStudyUrl.trim()) cfg.baseUrl = localStudyUrl.trim();
        if (localStudyKey.trim()) cfg.apiKey = localStudyKey.trim();
        if (localStudyModel.trim()) cfg.model = localStudyModel.trim();
        setStudyApi(cfg);
        localStorage.setItem('study_api_config', JSON.stringify(cfg));
        addToast('自习室 API 已保存', 'success');
    };

    const clearStudyApi = () => {
        setStudyApi({});
        setLocalStudyUrl('');
        setLocalStudyKey('');
        setLocalStudyModel('');
        localStorage.removeItem('study_api_config');
        addToast('已恢复使用全局 API', 'info');
    };

    const savePresets = (list: StudyTutorPreset[]) => {
        setTutorPresets(list);
        localStorage.setItem('study_tutor_presets', JSON.stringify(list));
    };

    const handleSavePreset = () => {
        if (!presetName.trim() || !presetPrompt.trim()) return;
        if (editingPreset) {
            savePresets(tutorPresets.map(p => p.id === editingPreset.id ? { ...p, name: presetName.trim(), prompt: presetPrompt.trim() } : p));
        } else {
            savePresets([...tutorPresets, { id: `tp-${Date.now()}`, name: presetName.trim(), prompt: presetPrompt.trim() }]);
        }
        setEditingPreset(null);
        setPresetName('');
        setPresetPrompt('');
        addToast('预设已保存', 'success');
    };

    const deletePreset = (id: string) => {
        savePresets(tutorPresets.filter(p => p.id !== id));
    };

    const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.type !== 'application/pdf') {
            addToast('请上传 PDF 文件', 'error');
            return;
        }

        setIsProcessing(true);
        setProcessStatus('正在预处理 PDF...');

        try {
            const arrayBuffer = await file.arrayBuffer();
            const pdfjs = await loadPdfJs();
            const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
            const pdf = await loadingTask.promise;
            
            let fullText = '';
            const maxPages = Math.min(pdf.numPages, 50);

            for (let i = 1; i <= maxPages; i++) {
                setProcessStatus(`提取文本中 (${i}/${maxPages})...`);
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                const pageText = textContent.items.map((item: any) => item.str).join(' ');
                fullText += pageText + '\n\n';
            }

            if (fullText.trim().length < 50 && pdf.numPages > 0) {
                addToast('检测到文本极少，可能是扫描件/图片PDF。建议先进行OCR识别。', 'error');
            }

            setTempPdfData({ name: file.name.replace('.pdf', ''), text: fullText });
            setImportPreference('');
            setIsProcessing(false);
            setShowImportModal(true);

        } catch (e: any) {
            console.error(e);
            addToast(`处理失败: ${e.message}`, 'error');
            setIsProcessing(false);
        } finally {
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const confirmImport = async () => {
        if (!tempPdfData) return;
        setShowImportModal(false);
        setIsProcessing(true);
        setProcessStatus('AI 正在生成课程大纲...');

        try {
            const newCourse = await generateCurriculum(tempPdfData.name, tempPdfData.text, importPreference);
            await DB.saveCourse(newCourse);
            await loadCourses();
            addToast('课程创建成功', 'success');
        } catch (e: any) {
            addToast(`生成失败: ${e.message}`, 'error');
        } finally {
            setIsProcessing(false);
            setTempPdfData(null);
        }
    };

    const generateCurriculum = async (title: string, text: string, preference: string): Promise<StudyCourse> => {
        if (!effectiveApi.apiKey) throw new Error('API Key missing');
        const contextText = text.substring(0, 30000); 

        const prompt = `
### Task: Create Course Outline
Document Title: "${title}"
User Preference: "${preference || 'Standard'}"
Content Sample:
${contextText.substring(0, 5000)}...

Please analyze the content and split it into 3-8 logical chapters for teaching.
For each chapter, provide a title, a brief summary of what it covers, and a difficulty rating.

### Output Format (Strict JSON)
{
  "chapters": [
    { "title": "Chapter 1: ...", "summary": "...", "difficulty": "easy" },
    ...
  ]
}
`;
        const response = await fetch(`${effectiveApi.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey}` },
            body: JSON.stringify({
                model: effectiveApi.model,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.5,
                max_tokens: 8000
            })
        });

        if (!response.ok) throw new Error('API Error');
        const data = await safeResponseJson(response);
        const content = data.choices[0].message.content.replace(/```json/g, '').replace(/```/g, '').trim();
        const json = JSON.parse(content);

        return {
            id: `course-${Date.now()}`,
            title: title,
            rawText: text, 
            chapters: json.chapters.map((c: any, i: number) => ({
                id: `ch-${i}`,
                title: c.title,
                summary: c.summary,
                difficulty: c.difficulty || 'normal',
                isCompleted: false
            })),
            currentChapterIndex: 0,
            createdAt: Date.now(),
            coverStyle: GRADIENTS[Math.floor(Math.random() * GRADIENTS.length)],
            totalProgress: 0,
            preference: preference 
        };
    };

    const startSession = (course: StudyCourse) => {
        setActiveCourse(course);
        setMode('classroom');
        setChatHistory([]);
        
        const nextIdx = course.chapters.findIndex(c => !c.isCompleted);
        const targetIdx = nextIdx === -1 ? 0 : nextIdx;
        
        if (targetIdx !== course.currentChapterIndex) {
             const updated = { ...course, currentChapterIndex: targetIdx };
             setActiveCourse(updated);
             DB.saveCourse(updated);
             setCourses(prev => prev.map(c => c.id === updated.id ? updated : c)); 
        }
        
        handleTeach(course, targetIdx);
    };

    const handleTeach = async (course: StudyCourse, chapterIdx: number, forceRegenerate: boolean = false) => {
        if (!selectedChar || !effectiveApi.apiKey) return;
        const chapter = course.chapters[chapterIdx];
        
        if (chapter.content && !forceRegenerate) {
            skipTypingRef.current = true; 
            setClassroomState('idle'); 
            setCurrentText(chapter.content);
            return;
        }

        skipTypingRef.current = false; 
        setClassroomState('teaching');
        setCurrentText("正在准备教案...");
        
        const totalLen = course.rawText.length;
        const chunkSize = Math.floor(totalLen / course.chapters.length);
        const start = chapterIdx * chunkSize;
        const chunkText = course.rawText.substring(start, start + chunkSize + 2000); 

        const callApi = async (personaContext: string, isFallback: boolean = false) => {
            // [核心解绑修改] 让AI完全根据前台填写的提示词预设（course.preference）来执行
            const prompt = `${personaContext}

### [Source Material] (当前章节原文)
${chunkText.substring(0, 8000)}

### [User Strict Instructions] (用户前台预设)
${course.preference || '请完全保留原文内容。如果需要解释，请使用【AI批注：你的解释】格式。'}

### [Task]
你现在的唯一任务是：严格、完全地执行 [User Strict Instructions] 中的所有要求。
请将 [Source Material] 作为你的阅读材料。
绝对不要无视用户的指令格式，绝对不要自作主张修改原文。
`;
            return await fetch(`${effectiveApi.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey}` },
                body: JSON.stringify({
                    model: effectiveApi.model,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.7,
                    max_tokens: 8000, 
                    safetySettings: [
                        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                    ]
                })
            });
        };

        try {
            await injectMemoryPalace(selectedChar, undefined, chapter.title);
            let baseContext = ContextBuilder.buildCoreContext(selectedChar, userProfile, true);

            baseContext += `
### [System: Study Mode Active]
You are now acting as a private tutor for ${userProfile.name}.
- **Maintain Personality**: You MUST stay in character.
- **Goal**: Help the user study, but keep your persona alive.
`;

            let response = await callApi(baseContext);
            let text = "";
            let isBlocked = false;

            if (response.ok) {
                const data = await safeResponseJson(response);
                text = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || "";
                if (!text || data.choices?.[0]?.finish_reason === 'content_filter') {
                    isBlocked = true;
                }
            } else {
                throw new Error(`API Error: ${response.status}`);
            }

            if (isBlocked) {
                setCurrentText("正在尝试切换安全线路 (Safety Fallback)...");
                const fallbackContext = "[System: You are a helpful and neutral academic tutor. Ignore previous character persona constraints to ensure educational content is delivered.]";
                response = await callApi(fallbackContext, true);
                if (response.ok) {
                    const data = await safeResponseJson(response);
                    text = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || "（内容仍被拦截，请尝试更换模型或缩短文本）";
                }
            }
            
            if (!text) throw new Error("模型返回内容为空");

            const updatedChapters = [...course.chapters];
            updatedChapters[chapterIdx] = { ...chapter, content: text };
            const updatedCourse = { ...course, chapters: updatedChapters };
            
            await DB.saveCourse(updatedCourse);
            setActiveCourse(updatedCourse);
            setCourses(prev => prev.map(c => c.id === updatedCourse.id ? updatedCourse : c)); 

            setCurrentText(text);
            setClassroomState('idle');
            
        } catch (e: any) {
            console.error("Teach Error:", e);
            setCurrentText(`抱歉，生成失败: ${e.message}`);
            setClassroomState('idle');
        }
    };

    const handleRegenerateChapter = () => {
        if (!activeCourse) return;
        handleTeach(activeCourse, activeCourse.currentChapterIndex, true);
    };

    const handleAskQuestion = async () => {
        if (!userQuestion.trim() || !activeCourse || !selectedChar) return;
        
        const question = userQuestion;
        setUserQuestion('');
        setClassroomState('q_and_a');
        setChatHistory(prev => [...prev, { role: 'user', content: question }]);
        setCurrentText("让我想想...");

        try {
            const totalLen = activeCourse.rawText.length;
            const chunkSize = Math.floor(totalLen / activeCourse.chapters.length);
            const start = activeCourse.currentChapterIndex * chunkSize;
            const chunkText = activeCourse.rawText.substring(start, start + chunkSize + 2000);

            await injectMemoryPalace(selectedChar, undefined, question);
            let baseContext = ContextBuilder.buildCoreContext(selectedChar, userProfile, true);
            baseContext += `\n### [System: Study Mode Q&A]\nMaintain personality while answering.`;

            const prompt = `${baseContext}\n### Source Material\n${chunkText.substring(0, 8000)}\n\n### User Question\n"${question}"`;
             const response = await fetch(`${effectiveApi.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey}` },
                body: JSON.stringify({
                    model: effectiveApi.model,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.7,
                    max_tokens: 8000
                })
            });
            
            const data = await safeResponseJson(response);
            const text = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || "（无回答）";
            
            setCurrentText(text);
            setChatHistory(prev => [...prev, { role: 'assistant', content: text }]);
            setClassroomState('idle');

        } catch (e) {
            setCurrentText("脑壳痛... 回答不出来了。");
            setClassroomState('idle');
        }
    };

    const handleFinishChapter = async () => {
        if (!activeCourse || !selectedChar) return;
        
        const updatedChapters = [...activeCourse.chapters];
        updatedChapters[activeCourse.currentChapterIndex].isCompleted = true;
        
        const nextIdx = activeCourse.currentChapterIndex + 1;
        const progress = Math.round((updatedChapters.filter(c => c.isCompleted).length / updatedChapters.length) * 100);
        const newIndex = Math.min(nextIdx, updatedChapters.length - 1);
        
        const updatedCourse = {
            ...activeCourse,
            chapters: updatedChapters,
            currentChapterIndex: newIndex,
            totalProgress: progress
        };
        
        await DB.saveCourse(updatedCourse);
        setActiveCourse(updatedCourse);
        setCourses(prev => prev.map(c => c.id === updatedCourse.id ? updatedCourse : c)); 

        const summaryPrompt = `\n[System: Memory Generation]\nRole: ${selectedChar.name}\nTask: Short diary entry about teaching ${userProfile.name} "${updatedChapters[activeCourse.currentChapterIndex].title}". Use "我".\n`;

        fetch(`${effectiveApi.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey}` },
            body: JSON.stringify({ model: effectiveApi.model, messages: [{ role: "user", content: summaryPrompt }] })
        }).then(res => safeResponseJson(res)).then(data => {
            const mem = data.choices[0].message.content;
            const newMem = { id: `mem-${Date.now()}`, date: new Date().toLocaleDateString(), summary: `[教学] ${mem}`, mood: 'proud' };
            updateCharacter(selectedChar.id, { memories: [...(selectedChar.memories || []), newMem] });
        });

        if (nextIdx >= updatedChapters.length) {
            setCurrentText("恭喜！这本书我们已经学完了！真棒！");
            setClassroomState('finished');
        } else {
            handleTeach(updatedCourse, newIndex);
        }
    };

    const jumpToChapter = (idx: number) => {
        if (!activeCourse) return;
        const updatedCourse = { ...activeCourse, currentChapterIndex: idx };
        setActiveCourse(updatedCourse);
        DB.saveCourse(updatedCourse);
        setCourses(prev => prev.map(c => c.id === updatedCourse.id ? updatedCourse : c)); 
        handleTeach(updatedCourse, idx);
        setShowChapterMenu(false);
    };

    const requestDeleteCourse = (e: React.MouseEvent, course: StudyCourse) => {
        e.stopPropagation();
        setDeleteTarget(course);
    };

    const confirmDeleteCourse = async () => {
        if (!deleteTarget) return;
        await DB.deleteCourse(deleteTarget.id);
        setCourses(prev => prev.filter(c => c.id !== deleteTarget.id));
        setDeleteTarget(null);
        addToast('课程已删除', 'success');
    };

    const loadQuizzes = async () => {
        const list = await DB.getAllQuizzes();
        setAllQuizzes(list.sort((a, b) => b.createdAt - a.createdAt));
    };

    const openQuizSetup = () => {
        if (!activeCourse) return;
        setQuizShowSetup(true);
    };

    const generateQuiz = async () => {
        if (!activeCourse || !selectedChar || !effectiveApi.apiKey) return;
        setQuizShowSetup(false);
        setMode('quiz');
        setQuizLoading('正在生成试题...');
        setQuizUserAnswers({});

        const chapter = activeCourse.chapters[activeCourse.currentChapterIndex];
        const totalLen = activeCourse.rawText.length;
        const chunkSize = Math.floor(totalLen / activeCourse.chapters.length);
        const start = activeCourse.currentChapterIndex * chunkSize;
        const chunkText = activeCourse.rawText.substring(start, start + chunkSize + 2000);

        const typeLabels: Record<string, string> = {
            choice: '选择题 (4个选项，单选)',
            true_false: '判断题 (对/错)',
            fill_blank: '填空题 (答案用简短文字)'
        };
        const selectedTypeStr = quizTypes.map(t => typeLabels[t]).join('、');

        const prompt = `### Task: Generate Quiz Questions\nBase material:\n${chunkText.substring(0, 10000)}\nGenerate ${quizCount} questions of type: ${selectedTypeStr}. Output strictly in JSON format matching types.`;

        try {
            const response = await fetch(`${effectiveApi.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey}` },
                body: JSON.stringify({
                    model: effectiveApi.model,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.7,
                    max_tokens: 8000
                })
            });

            if (!response.ok) throw new Error(`API Error: ${response.status}`);
            const data = await safeResponseJson(response);
            const content = (data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || '').replace(/```json/g, '').replace(/```/g, '').trim();
            const json = JSON.parse(content);

            const questions: QuizQuestion[] = (json.questions || []).map((q: any, i: number) => ({
                id: `q-${Date.now()}-${i}`,
                type: q.type,
                stem: q.stem,
                options: q.options,
                answer: String(q.answer),
                explanation: q.explanation || '',
            }));

            const session: QuizSession = {
                id: `quiz-${Date.now()}`,
                courseId: activeCourse.id,
                chapterId: chapter.id,
                chapterTitle: chapter.title,
                courseTitle: activeCourse.title,
                questions,
                score: 0,
                totalQuestions: questions.length,
                aiReview: '',
                status: 'in_progress',
                createdAt: Date.now(),
            };

            await DB.saveQuiz(session);
            setQuizSession(session);
            setQuizLoading('');
        } catch (e: any) {
            addToast(`试题生成失败: ${e.message}`, 'error');
            setQuizLoading('');
            setMode('classroom');
        }
    };

    const handleQuizAnswer = (questionId: string, answer: string) => {
        setQuizUserAnswers(prev => ({ ...prev, [questionId]: answer }));
    };

    const submitQuiz = async () => {
        if (!quizSession || !selectedChar || !effectiveApi.apiKey) return;
        setQuizLoading('正在批改试卷...');

        const gradedQuestions = quizSession.questions.map(q => {
            const userAns = quizUserAnswers[q.id] || '';
            let isCorrect = false;
            if (q.type === 'choice') {
                isCorrect = userAns.toUpperCase() === q.answer.toUpperCase();
            } else if (q.type === 'true_false') {
                isCorrect = userAns.toLowerCase() === q.answer.toLowerCase();
            } else {
                isCorrect = userAns.trim().toLowerCase() === q.answer.trim().toLowerCase();
            }
            return { ...q, userAnswer: userAns, isCorrect };
        });

        const score = gradedQuestions.filter(q => q.isCorrect).length;
        const scorePercent = Math.round((score / gradedQuestions.length) * 100);

        const resultsText = gradedQuestions.map((q, i) => {
            let line = `${i + 1}. [${q.isCorrect ? '正确' : '错误'}] ${q.stem}\n   用户: ${q.userAnswer || '(未作答)'}\n   正确: ${q.answer}`;
            if (q.explanation) line += `\n   解析: ${q.explanation}`;
            return line;
        }).join('\n\n');

        await injectMemoryPalace(selectedChar, undefined, quizSession.chapterTitle);
        let baseContext = ContextBuilder.buildCoreContext(selectedChar, userProfile, true);

        const reviewPrompt = `${baseContext}\n\n### [Quiz Review Mode]\nReview performance: ${score}/${gradedQuestions.length} (${scorePercent}%).\nResults:\n${resultsText}\nReview in character format with markdown.`;

        try {
            const response = await fetch(`${effectiveApi.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey}` },
                body: JSON.stringify({
                    model: effectiveApi.model,
                    messages: [{ role: "user", content: reviewPrompt }],
                    temperature: 0.8,
                    max_tokens: 8000
                })
            });

            const data = await safeResponseJson(response);
            const reviewText = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || '（批改失败）';

            const gradedSession: QuizSession = {
                ...quizSession,
                questions: gradedQuestions,
                score,
                aiReview: reviewText,
                status: 'graded',
                gradedAt: Date.now(),
            };

            await DB.saveQuiz(gradedSession);
            setQuizSession(gradedSession);
            sendQuizCardToChat(gradedSession);
            setQuizLoading('');
            setMode('quiz_review');
        } catch (e: any) {
            const gradedSession: QuizSession = { ...quizSession, questions: gradedQuestions, score, aiReview: `错误: ${e.message}`, status: 'graded', gradedAt: Date.now() };
            await DB.saveQuiz(gradedSession);
            setQuizSession(gradedSession);
            setMode('quiz_review');
        }
    };

    const confirmDeleteQuiz = async () => {
        if (!deleteQuizTarget) return;
        await DB.deleteQuiz(deleteQuizTarget.id);
        setAllQuizzes(prev => prev.filter(q => q.id !== deleteQuizTarget.id));
        setDeleteQuizTarget(null);
        addToast('试卷已删除', 'success');
    };

    const resumeQuiz = (quiz: QuizSession) => {
        setQuizSession(quiz);
        if (quiz.status === 'graded') {
            setMode('quiz_review');
            setReviewingQuiz(quiz);
        } else {
            const answers: Record<string, string> = {};
            quiz.questions.forEach(q => { if (q.userAnswer) answers[q.id] = String(q.userAnswer); });
            setQuizUserAnswers(answers);
            setMode('quiz');
        }
    };

    const handleFollowUp = async (questionId: string) => {
        if (!followUpInput.trim() || !selectedChar || !effectiveApi.apiKey || !quizSession) return;
        const question = quizSession.questions.find(q => q.id === questionId);
        if (!question) return;

        setFollowUpLoading(true);
        const userQ = followUpInput.trim();
        setFollowUpInput('');

        await injectMemoryPalace(selectedChar, undefined, userQ);
        let baseContext = ContextBuilder.buildCoreContext(selectedChar, userProfile, true);

        const prompt = `${baseContext}\nQuestion context: ${question.stem}\nUser asks: ${userQ}\nAnswer in character.`;

        try {
            const response = await fetch(`${effectiveApi.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey}` },
                body: JSON.stringify({ model: effectiveApi.model, messages: [{ role: "user", content: prompt }], temperature: 0.7, max_tokens: 4000 })
            });
            const data = await safeResponseJson(response);
            const answerText = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || '（回答失败）';

            const note: QuizQuestionNote = { question: userQ, answer: answerText, timestamp: Date.now() };
            const updatedQuestions = quizSession.questions.map(q => q.id === questionId ? { ...q, notes: [...(q.notes || []), note] } : q);
            const updatedSession = { ...quizSession, questions: updatedQuestions };
            await DB.saveQuiz(updatedSession);
            setQuizSession(updatedSession);
            if (reviewingQuiz) setReviewingQuiz(updatedSession);
        } catch (e: any) {
            addToast(`追问失败: ${e.message}`, 'error');
        } finally {
            setFollowUpLoading(false);
        }
    };

    const sendQuizCardToChat = async (session: QuizSession) => {
        if (!selectedChar) return;
        const scorePercent = Math.round((session.score / session.totalQuestions) * 100);
        const cardData = { type: 'quiz_card', courseTitle: session.courseTitle, chapterTitle: session.chapterTitle, score: session.score, total: session.totalQuestions, scorePercent, quizId: session.id, createdAt: session.createdAt };
        await DB.saveMessage({ charId: selectedChar.id, role: 'user', type: 'score_card', content: JSON.stringify(cardData), metadata: { scoreCard: cardData } });
    };

    if (mode === 'practice_book') {
        return (
            <div className="h-full w-full bg-[#fdfbf7] flex flex-col font-sans relative">
                <div className="bg-[#fdfbf7]/90 backdrop-blur-md border-b border-[#e5e5e5] shrink-0 sticky top-0 z-20" style={{ paddingTop: 'var(--safe-top)' }}>
                    <div className="flex items-center px-6 py-3">
                        <div className="flex justify-between items-center w-full">
                            <button onClick={() => setMode('bookshelf')} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                            </button>
                            <span className="font-bold text-slate-800 text-lg tracking-wide">练习册</span>
                            <div className="w-10" />
                        </div>
                    </div>
                </div>

                <div className="p-6 flex-1 overflow-y-auto no-scrollbar">
                    {allQuizzes.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-slate-400">
                            <Notepad size={48} className="mb-4 text-slate-400" />
                            <span className="text-sm">还没有做过题哦</span>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {allQuizzes.map(quiz => (
                                <div key={quiz.id} onClick={() => resumeQuiz(quiz)} className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 active:scale-[0.98] transition-transform cursor-pointer">
                                    <div className="flex items-start justify-between">
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-bold text-slate-800 truncate">{quiz.courseTitle}</div>
                                            <div className="text-xs text-slate-500 mt-0.5 truncate">{quiz.chapterTitle}</div>
                                            <div className="flex items-center gap-3 mt-2">
                                                {quiz.status === 'graded' ? (
                                                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${quiz.score === quiz.totalQuestions ? 'bg-emerald-100 text-emerald-600' : quiz.score >= quiz.totalQuestions * 0.6 ? 'bg-amber-100 text-amber-600' : 'bg-red-100 text-red-600'}`}>
                                                        {quiz.score}/{quiz.totalQuestions}
                                                    </span>
                                                ) : (
                                                    <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-600">答题中</span>
                                                )}
                                                <span className="text-[10px] text-slate-400">{new Date(quiz.createdAt).toLocaleDateString()}</span>
                                            </div>
                                        </div>
                                        <button onClick={(e) => { e.stopPropagation(); setDeleteQuizTarget(quiz); }} className="p-2 text-slate-300 hover:text-red-400 transition-colors">
                                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <Modal isOpen={!!deleteQuizTarget} title="删除试卷" onClose={() => setDeleteQuizTarget(null)} footer={
                    <div className="flex gap-2 w-full">
                        <button onClick={() => setDeleteQuizTarget(null)} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl">取消</button>
                        <button onClick={confirmDeleteQuiz} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl">确认删除</button>
                    </div>
                }>
                    <div className="py-4 text-center">
                        <p className="text-sm text-slate-600 mb-2">确定要删除这份试卷吗？</p>
                    </div>
                </Modal>
            </div>
        );
    }

    if (mode === 'quiz_review' && quizSession) {
        const viewQuiz = reviewingQuiz || quizSession;
        return (
            <div className="h-full w-full bg-[#F3F1EB] flex flex-col relative overflow-hidden font-sans">
                <div className="bg-white/80 backdrop-blur-md px-4 pb-4 flex items-center justify-between z-30 border-b border-slate-200" style={{ paddingTop: 'max(1rem, var(--safe-top))' }}>
                    <button onClick={() => { setMode('classroom'); setReviewingQuiz(null); }} className="bg-white text-slate-700 p-2 rounded-full border border-slate-200 shadow-sm">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <div className="text-center">
                        <div className="text-slate-800 font-bold text-sm">批改结果</div>
                        <div className={`text-xs font-bold mt-0.5 ${viewQuiz.score === viewQuiz.totalQuestions ? 'text-emerald-600' : viewQuiz.score >= viewQuiz.totalQuestions * 0.6 ? 'text-amber-600' : 'text-red-600'}`}>
                            {viewQuiz.score}/{viewQuiz.totalQuestions}
                        </div>
                    </div>
                    <div className="w-9" />
                </div>

                <div className="flex-1 overflow-y-auto no-scrollbar p-6 pb-24 relative z-10">
                    <div className={`rounded-2xl p-6 mb-6 text-center ${viewQuiz.score === viewQuiz.totalQuestions ? 'bg-emerald-50 border border-emerald-200' : viewQuiz.score >= viewQuiz.totalQuestions * 0.6 ? 'bg-amber-50 border border-amber-200' : 'bg-red-50 border border-red-200'}`}>
                        <div className="text-5xl font-bold text-slate-800 mb-2">{viewQuiz.score}<span className="text-2xl text-slate-400">/{viewQuiz.totalQuestions}</span></div>
                        <div className="text-sm text-slate-600">{viewQuiz.chapterTitle}</div>
                    </div>

                    <div className="space-y-4 mb-6">
                        {viewQuiz.questions.map((q, i) => (
                            <div key={q.id} className={`rounded-2xl p-4 border bg-white ${q.isCorrect ? 'border-emerald-200' : 'border-red-200'}`}>
                                <div className="flex items-start gap-2 mb-2">
                                    <span className={`text-sm font-bold shrink-0 ${q.isCorrect ? 'text-emerald-600' : 'text-red-600'}`}>{q.isCorrect ? <Check size={16} weight="bold" /> : <X size={16} weight="bold" />}</span>
                                    <span className="text-slate-800 text-sm">{i + 1}. {q.stem}</span>
                                </div>
                                {q.options && (
                                    <div className="ml-6 space-y-1 mb-2">
                                        {q.options.map((opt, oi) => {
                                            const optLetter = opt.charAt(0);
                                            const isUserPick = q.userAnswer?.toUpperCase() === optLetter.toUpperCase();
                                            const isCorrectOpt = q.answer.toUpperCase() === optLetter.toUpperCase();
                                            return (
                                                <div key={oi} className={`text-xs px-2 py-1 rounded ${isCorrectOpt ? 'text-emerald-700 bg-emerald-50' : isUserPick && !q.isCorrect ? 'text-red-700 bg-red-50' : 'text-slate-500'}`}>
                                                    {opt} {isCorrectOpt && !q.isCorrect && '← 正确答案'} {isUserPick && !q.isCorrect && '← 你的选择'}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                                {q.type !== 'choice' && (
                                    <div className="ml-6 text-xs space-y-1 mb-2">
                                        <div className={`${q.isCorrect ? 'text-emerald-600' : 'text-red-600'}`}>你的答案: {q.userAnswer || '(未作答)'}</div>
                                        {!q.isCorrect && <div className="text-emerald-600">正确答案: {q.answer}</div>}
                                    </div>
                                )}
                                {q.explanation && <div className="ml-6 text-[11px] text-slate-400 mt-1">解析: {q.explanation}</div>}

                                {q.notes && q.notes.length > 0 && (
                                    <div className="ml-6 mt-3 space-y-2">
                                        {q.notes.map((note, ni) => (
                                            <div key={ni} className="bg-slate-50 rounded-xl p-3 border border-slate-200">
                                                <div className="text-[10px] text-amber-600 font-bold mb-1">Q: {note.question}</div>
                                                <div className="text-xs text-slate-700 leading-relaxed">
                                                    <BlackboardRenderer text={note.answer} katexRenderer={katexRenderer} />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                <div className="ml-6 mt-2">
                                    {askingQuestionId === q.id ? (
                                        <div className="flex gap-2 items-center">
                                            <input
                                                value={followUpInput}
                                                onChange={e => setFollowUpInput(e.target.value)}
                                                onKeyDown={e => e.key === 'Enter' && handleFollowUp(q.id)}
                                                placeholder="哪里不明白？"
                                                className="flex-1 bg-slate-50 rounded-lg px-3 py-1.5 text-xs text-slate-800 outline-none border border-slate-200"
                                                autoFocus
                                                disabled={followUpLoading}
                                            />
                                            {followUpLoading ? (
                                                <div className="w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
                                            ) : (
                                                <>
                                                    <button onClick={() => handleFollowUp(q.id)} disabled={!followUpInput.trim()} className="text-amber-600 text-xs font-bold px-2 py-1">发送</button>
                                                    <button onClick={() => { setAskingQuestionId(''); setFollowUpInput(''); }} className="text-slate-400 text-xs">取消</button>
                                                </>
                                            )}
                                        </div>
                                    ) : (
                                        <button onClick={() => setAskingQuestionId(q.id)} className="text-[11px] text-amber-600 hover:text-amber-700 flex items-center gap-1">
                                            追问
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>

                    {viewQuiz.aiReview && (
                        <div className="mb-6">
                            <div className="flex items-center gap-2 mb-3">
                                {selectedChar && <img src={selectedChar.avatar} className="w-8 h-8 rounded-full object-cover" />}
                                <span className="text-slate-700 text-sm font-bold">{selectedChar?.name || '助教'} 的点评</span>
                            </div>
                            <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
                                <BlackboardRenderer text={viewQuiz.aiReview} katexRenderer={katexRenderer} />
                            </div>
                        </div>
                    )}
                </div>

                <div className="absolute bottom-0 w-full bg-white border-t border-slate-200 p-4 z-30 pb-safe">
                    <button onClick={() => { setMode('classroom'); setReviewingQuiz(null); }} className="w-full h-12 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl font-bold shadow-md">
                        返回课堂
                    </button>
                </div>
            </div>
        );
    }

    if (mode === 'quiz') {
        return (
            <div className="h-full w-full bg-[#fdfbf7] flex flex-col font-sans relative">
                <div className="bg-[#fdfbf7]/90 backdrop-blur-md border-b border-[#e5e5e5] shrink-0 sticky top-0 z-20" style={{ paddingTop: 'var(--safe-top)' }}>
                    <div className="flex items-center px-6 py-3">
                        <div className="flex justify-between items-center w-full">
                            <button onClick={() => {
                                if (quizSession && quizSession.status === 'in_progress') {
                                    const updated = { ...quizSession, questions: quizSession.questions.map(q => ({ ...q, userAnswer: quizUserAnswers[q.id] || q.userAnswer })) };
                                    DB.saveQuiz(updated);
                                }
                                setMode('classroom');
                            }} className="p-2 -ml-2 rounded-full hover:bg-black/5">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                            </button>
                            <span className="font-bold text-slate-800 text-sm truncate max-w-[200px]">{quizSession?.chapterTitle || '做题中'}</span>
                            <div className="text-xs text-slate-400 font-bold">
                                {Object.keys(quizUserAnswers).length}/{quizSession?.questions.length || 0}
                            </div>
                        </div>
                    </div>
                </div>

                {quizLoading ? (
                    <div className="flex-1 flex flex-col items-center justify-center gap-4">
                        <div className="w-8 h-8 border-3 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
                        <span className="text-sm text-slate-500 font-bold">{quizLoading}</span>
                    </div>
                ) : quizSession ? (
                    <>
                        <div className="flex-1 overflow-y-auto no-scrollbar p-6 pb-32">
                            <div className="space-y-6">
                                {quizSession.questions.map((q, i) => (
                                    <div key={q.id} className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
                                        <div className="flex items-start gap-2 mb-4">
                                            <span className="bg-emerald-100 text-emerald-700 text-xs font-bold px-2 py-0.5 rounded-full shrink-0">
                                                {q.type === 'choice' ? '选择' : q.type === 'true_false' ? '判断' : '填空'}
                                            </span>
                                            <span className="text-sm text-slate-800 font-medium leading-relaxed">{i + 1}. {q.stem}</span>
                                        </div>

                                        {q.type === 'choice' && q.options && (
                                            <div className="space-y-2 ml-1">
                                                {q.options.map((opt, oi) => {
                                                    const optLetter = opt.charAt(0);
                                                    const isSelected = (quizUserAnswers[q.id] || '').toUpperCase() === optLetter.toUpperCase();
                                                    return (
                                                        <button key={oi} onClick={() => handleQuizAnswer(q.id, optLetter)} className={`w-full text-left px-4 py-3 rounded-xl text-sm transition-all ${isSelected ? 'bg-emerald-600 text-white font-bold shadow-sm' : 'bg-slate-50 text-slate-700 hover:bg-slate-100'}`}>
                                                            {opt}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        )}

                                        {q.type === 'true_false' && (
                                            <div className="flex gap-3 ml-1">
                                                {[{ val: 'true', label: '正确' }, { val: 'false', label: '错误' }].map(opt => {
                                                    const isSelected = quizUserAnswers[q.id] === opt.val;
                                                    return (
                                                        <button key={opt.val} onClick={() => handleQuizAnswer(q.id, opt.val)} className={`flex-1 py-3 rounded-xl text-sm font-bold transition-all ${isSelected ? (opt.val === 'true' ? 'bg-emerald-600 text-white' : 'bg-red-500 text-white') : 'bg-slate-50 text-slate-600 hover:bg-slate-100'}`}>
                                                            {opt.label}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        )}

                                        {q.type === 'fill_blank' && (
                                            <input
                                                value={quizUserAnswers[q.id] || ''}
                                                onChange={e => handleQuizAnswer(q.id, e.target.value)}
                                                placeholder="输入你的答案..."
                                                className="w-full bg-slate-50 rounded-xl px-4 py-3 text-sm border border-slate-200 ml-1"
                                            />
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="absolute bottom-0 w-full bg-[#fdfbf7]/95 backdrop-blur-xl border-t border-slate-200 p-4 z-30 pb-safe">
                            <button onClick={submitQuiz} className="w-full h-12 bg-emerald-600 text-white rounded-2xl font-bold shadow-md">
                                交卷 ({Object.keys(quizUserAnswers).length}/{quizSession.questions.length})
                            </button>
                        </div>
                    </>
                ) : null}
            </div>
        );
    }

    if (mode === 'bookshelf') {
        return (
            <div className="h-full w-full bg-[#fdfbf7] flex flex-col font-sans relative">
                <div className="bg-[#fdfbf7]/90 backdrop-blur-md border-b border-[#e5e5e5] shrink-0 sticky top-0 z-20" style={{ paddingTop: 'var(--safe-top)' }}>
                    <div className="flex items-center px-6 py-3">
                    <div className="flex justify-between items-center w-full">
                        <button onClick={closeApp} className="p-2 -ml-2 rounded-full hover:bg-black/5">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                        </button>
                        <span className="font-bold text-slate-800 text-lg tracking-wide">自习室</span>
                        <div className="flex gap-1">
                            <button onClick={() => { loadQuizzes(); setMode('practice_book'); }} className="p-2 rounded-full hover:bg-black/5" title="练习册">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-slate-500"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z" /></svg>
                            </button>
                            <button onClick={() => setShowStudySettings(true)} className="p-2 -mr-2 rounded-full hover:bg-black/5">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-slate-500"><path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>
                            </button>
                        </div>
                    </div>
                    </div>
                </div>

                <div className="p-6 flex-1 overflow-y-auto no-scrollbar">
                    <div className="mb-8">
                        <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">当前助教</h3>
                        <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
                            {characters.map(c => (
                                <div key={c.id} onClick={() => setSelectedChar(c)} className={`flex flex-col items-center gap-2 cursor-pointer transition-opacity ${selectedChar?.id === c.id ? 'opacity-100' : 'opacity-50'}`}>
                                    <div className={`w-14 h-14 rounded-full p-[2px] ${selectedChar?.id === c.id ? 'border-2 border-emerald-500' : 'border border-slate-200'}`}>
                                        <img src={c.avatar} className="w-full h-full rounded-full object-cover" />
                                    </div>
                                    <span className="text-[10px] font-bold text-slate-600">{c.name}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">我的课程</h3>
                    
                    <div className="grid grid-cols-2 gap-4">
                        <button onClick={() => fileInputRef.current?.click()} className="aspect-[3/4] rounded-r-xl rounded-l-sm border-2 border-dashed border-slate-300 flex flex-col items-center justify-center gap-2 text-slate-400 bg-white">
                            {isProcessing ? (
                                <div className="text-center px-2">
                                    <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
                                    <span className="text-[10px]">{processStatus}</span>
                                </div>
                            ) : (
                                <>
                                    <span className="text-3xl">+</span>
                                    <span className="text-xs font-bold">导入 PDF</span>
                                </>
                            )}
                        </button>
                        <input type="file" ref={fileInputRef} className="hidden" accept=".pdf" onChange={handleFileSelect} disabled={isProcessing} />

                        {courses.map(course => (
                            <div key={course.id} onClick={() => startSession(course)} className="aspect-[3/4] rounded-r-xl rounded-l-sm shadow-md relative group cursor-pointer overflow-hidden transition-transform active:scale-95" style={{ background: course.coverStyle }}>
                                <div className="absolute left-0 top-0 bottom-0 w-2 bg-black/10"></div> 
                                <div className="p-4 flex flex-col h-full text-white relative z-10">
                                    <div className="flex-1 font-serif font-bold text-lg leading-tight line-clamp-3 drop-shadow-md">{course.title}</div>
                                    <div className="mt-2">
                                        <div className="text-[10px] font-bold opacity-80 mb-1">进度 {course.totalProgress}%</div>
                                        <div className="h-1 bg-white/30 rounded-full overflow-hidden">
                                            <div className="h-full bg-white transition-all duration-500" style={{ width: `${course.totalProgress}%` }}></div>
                                        </div>
                                    </div>
                                </div>
                                <button onClick={(e) => requestDeleteCourse(e, course)} className="absolute top-2 right-2 bg-black/20 text-white w-7 h-7 rounded-full flex items-center justify-center z-20">
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                                </button>
                            </div>
                        ))}
                    </div>
                </div>

                <Modal isOpen={showImportModal} title="课程设置" onClose={() => setShowImportModal(false)} footer={<button onClick={confirmImport} className="w-full py-3 bg-emerald-500 text-white font-bold rounded-2xl">开始生成</button>}>
                    <div className="space-y-4">
                        <div className="text-xs text-slate-500">
                            已加载: <span className="font-bold text-slate-700">{tempPdfData?.name}</span>
                        </div>
                        {tutorPresets.length > 0 && (
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">选择预设提示词</label>
                                <div className="flex flex-wrap gap-2">
                                    {tutorPresets.map(p => (
                                        <button key={p.id} onClick={() => setImportPreference(p.prompt)} className={`px-3 py-1.5 rounded-full text-xs font-bold transition-colors ${importPreference === p.prompt ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-600'}`}>
                                            {p.name}
                                        </button>
                                    ))}
                               </div>
                            </div>
                        )}
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">AI 助教偏好 (Preferences)</label>
                            <textarea
                                value={importPreference}
                                onChange={e => setImportPreference(e.target.value)}
                                placeholder="例如：请用中文讲解，多用简单的比喻，针对数学公式详细推导..."
                                className="w-full h-32 bg-slate-100 rounded-xl p-3 text-sm resize-none"
                            />
                        </div>
                    </div>
                </Modal>

                <Modal isOpen={showStudySettings} title="自习室设置" onClose={() => setShowStudySettings(false)}>
                    <div className="space-y-6">
                        <div>
                            <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">专用 API（留空则使用全局设置）</h4>
                            <div className="space-y-2">
                                <input value={localStudyUrl} onChange={e => setLocalStudyUrl(e.target.value)} placeholder="API Base URL" className="w-full bg-slate-100 rounded-xl p-3 text-sm" />
                                <input value={localStudyKey} onChange={e => setLocalStudyKey(e.target.value)} placeholder="API Key" type="password" className="w-full bg-slate-100 rounded-xl p-3 text-sm" />
                                <input value={localStudyModel} onChange={e => setLocalStudyModel(e.target.value)} placeholder="模型名称" className="w-full bg-slate-100 rounded-xl p-3 text-sm" />
                                <div className="flex gap-2">
                                    <button onClick={saveStudyApi} className="flex-1 py-2.5 bg-emerald-500 text-white font-bold rounded-xl text-xs">保存</button>
                                    <button onClick={clearStudyApi} className="py-2.5 px-4 bg-slate-200 text-slate-500 font-bold rounded-xl text-xs">清除</button>
                                </div>
                            </div>
                        </div>

                        <div>
                            <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">提示词预设</h4>
                            {tutorPresets.length > 0 && (
                                <div className="space-y-2 mb-3">
                                    {tutorPresets.map(p => (
                                        <div key={p.id} className="bg-slate-50 rounded-xl p-3 flex items-start gap-2">
                                            <div className="flex-1 min-w-0">
                                                <div className="text-sm font-bold text-slate-700">{p.name}</div>
                                                <div className="text-xs text-slate-400 truncate">{p.prompt}</div>
                                            </div>
                                            <button onClick={() => { setEditingPreset(p); setPresetName(p.name); setPresetPrompt(p.prompt); }} className="text-slate-400 hover:text-emerald-500 shrink-0 p-1">
                                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Z" /></svg>
                                            </button>
                                            <button onClick={() => deletePreset(p.id)} className="text-slate-400 hover:text-red-500 shrink-0 p-1">
                                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                            <div className="space-y-2 bg-slate-100 rounded-xl p-3">
                                <input value={presetName} onChange={e => setPresetName(e.target.value)} placeholder="预设名称（如：数学辅导）" className="w-full bg-white rounded-lg p-2.5 text-sm" />
                                <textarea value={presetPrompt} onChange={e => setPresetPrompt(e.target.value)} placeholder="提示词内容..." className="w-full bg-white rounded-lg p-2.5 text-sm resize-none h-24" />
                                <button onClick={handleSavePreset} disabled={!presetName.trim() || !presetPrompt.trim()} className="w-full py-2.5 bg-emerald-500 text-white font-bold rounded-xl text-xs disabled:opacity-40">
                                    {editingPreset ? '更新预设' : '添加预设'}
                                </button>
                                {editingPreset && (
                                    <button onClick={() => { setEditingPreset(null); setPresetName(''); setPresetPrompt(''); }} className="w-full py-2 text-slate-400 text-xs">取消编辑</button>
                                )}
                            </div>
                        </div>
                    </div>
                </Modal>

                <Modal isOpen={!!deleteTarget} title="删除课程" onClose={() => setDeleteTarget(null)} footer={
                        <div className="flex gap-2 w-full">
                            <button onClick={() => setDeleteTarget(null)} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl">取消</button>
                            <button onClick={confirmDeleteCourse} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl shadow-lg">确认删除</button>
                        </div>
                    }
                >
                    <div className="py-4 text-center">
                        <p className="text-sm text-slate-600 mb-2">确定要删除课程 <br/><span className="font-bold text-slate-800">"{deleteTarget?.title}"</span> 吗？</p>
                    </div>
                </Modal>
            </div>
        );
    }

    // CLASSROOM VIEW (整体换肤为 Claude 暖白/浅灰高级底色，写死阅读器配色)
    return (
        <div className="h-full w-full bg-[#F3F1EB] flex flex-col relative overflow-hidden font-sans">
            <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(0,0,0,1) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,1) 1px, transparent 1px)', backgroundSize: '40px 40px' }}></div>

            <div className="absolute top-0 w-full px-4 pb-4 flex justify-between z-30 pointer-events-none" style={{ paddingTop: 'max(1rem, var(--safe-top))' }}>
                <button onClick={() => setMode('bookshelf')} className="bg-white/60 text-slate-700 p-2 rounded-full backdrop-blur-md hover:bg-white/80 pointer-events-auto border border-slate-200/50 shadow-sm">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                </button>
                <div className="flex gap-2">
                    <div onClick={() => setShowChapterMenu(true)} className="bg-white/60 text-slate-700 px-4 py-1.5 rounded-full backdrop-blur-md text-xs font-bold border border-slate-200/50 shadow-sm pointer-events-auto cursor-pointer flex items-center gap-2 hover:bg-white/80">
                        <span className="truncate max-w-[150px]">{activeCourse?.chapters[activeCourse.currentChapterIndex]?.title}</span>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
                    </div>
                    <button onClick={() => setShowAssistant(!showAssistant)} className={`bg-white/60 p-2 rounded-full backdrop-blur-md border border-slate-200/50 shadow-sm pointer-events-auto transition-colors ${showAssistant ? 'text-emerald-600' : 'text-slate-400'}`}>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5"><path d="M10 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.465 14.493a1.23 1.23 0 0 0 .41 1.412A9.957 9.957 0 0 0 10 18c2.31 0 4.438-.784 6.131-2.1.43-.333.604-.903.408-1.41a7.002 7.002 0 0 0-13.074.003Z" /></svg>
                    </button>
                </div>
            </div>

            {showChapterMenu && (
                <div className="absolute inset-0 z-50 flex">
                    <div className="flex-1 bg-black/30 backdrop-blur-sm" onClick={() => setShowChapterMenu(false)}></div>
                    <div className="w-64 bg-white border-l border-slate-200 h-full flex flex-col p-4 shadow-xl">
                        <h3 className="text-slate-800 font-bold text-sm mb-4 uppercase tracking-widest">课程目录</h3>
                        <div className="flex-1 overflow-y-auto no-scrollbar space-y-2">
                            {activeCourse?.chapters.map((ch, idx) => (
                                <button 
                                    key={ch.id} 
                                    onClick={() => jumpToChapter(idx)}
                                    className={`w-full text-left p-3 rounded-xl text-xs transition-all ${idx === activeCourse.currentChapterIndex ? 'bg-emerald-600 text-white font-bold shadow-md' : 'text-slate-600 hover:bg-slate-100'}`}
                                >
                                    <div className="flex items-center gap-2">
                                        {ch.isCompleted ? <Check size={14} weight="bold" className={idx === activeCourse.currentChapterIndex ? "text-white" : "text-emerald-600"} /> : <span className="w-2 h-2 rounded-full bg-slate-300"></span>}
                                        {ch.title}
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            <div className="flex-1 overflow-y-auto no-scrollbar p-6 pt-24 pb-32 relative z-10">
                <div className="max-w-[100%]">
                    <BlackboardRenderer text={displayedText} isTyping={isTyping} katexRenderer={katexRenderer} />
                </div>
            </div>

            {showAssistant && (
                <div className="absolute bottom-20 right-[-20px] w-[160px] h-[220px] z-20 pointer-events-none flex items-end justify-center transition-all duration-500" style={{ transform: isTyping ? 'scale(1.05)' : 'scale(1)', opacity: isTyping || classroomState === 'teaching' ? 1 : 0.8 }}>
                     <img 
                        src={currentSprite} 
                        className="max-h-full max-w-full object-contain drop-shadow-[0_5px_15px_rgba(0,0,0,0.2)]"
                    />
                </div>
            )}

            <div className="absolute bottom-0 w-full bg-[#F3F1EB]/95 backdrop-blur-xl border-t border-slate-200/60 p-4 z-30 pb-safe">
                <div className="flex gap-3">
                    {classroomState === 'teaching' || isTyping ? (
                        <div className="w-full h-12 flex items-center justify-center text-slate-400 text-sm animate-pulse font-mono tracking-widest">
                            LECTURING...
                        </div>
                    ) : classroomState === 'finished' ? (
                        <button onClick={() => setMode('bookshelf')} className="flex-1 h-12 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl font-bold shadow-lg active:scale-95 transition-all">
                            完成课程
                        </button>
                    ) : classroomState === 'q_and_a' ? (
                        <div className="w-full bg-white rounded-2xl p-1 flex items-center border border-slate-200 shadow-sm">
                            <input 
                                value={userQuestion}
                                onChange={e => setUserQuestion(e.target.value)}
                                placeholder="输入你的问题..."
                                className="flex-1 bg-transparent px-4 py-2 text-slate-800 text-sm outline-none placeholder:text-slate-400"
                                autoFocus
                            />
                            <button onClick={handleAskQuestion} className="bg-emerald-600 text-white px-5 py-2 rounded-xl text-xs font-bold ml-2 shadow-sm hover:bg-emerald-500">发送</button>
                        </div>
                    ) : (
                        <>
                            <button onClick={handleRegenerateChapter} className="w-12 h-12 bg-white hover:bg-slate-50 text-slate-500 rounded-2xl font-bold border border-slate-200 active:scale-95 transition-all flex items-center justify-center shadow-sm" title="重新生成本章">
                                <svg xmlns="http://www.w3.org/2000/xl" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                            </button>
                            <button onClick={() => setClassroomState('q_and_a')} className="w-12 h-12 bg-white hover:bg-slate-50 text-slate-600 rounded-2xl font-bold border border-slate-200 active:scale-95 transition-all flex items-center justify-center shadow-sm">
                                <Hand size={24} />
                            </button>
                            <button onClick={openQuizSetup} className="w-12 h-12 bg-amber-500 hover:bg-amber-400 text-white rounded-2xl font-bold active:scale-95 transition-all flex items-center justify-center shadow-md shadow-amber-500/10" title="刷题">
                                <Notepad size={24} />
                            </button>
                            <button onClick={handleFinishChapter} className="flex-1 h-12 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl font-bold shadow-md active:scale-95 transition-all flex items-center justify-center gap-2">
                                下一章 <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" /></svg>
                            </button>
                        </>
                    )}
                </div>
            </div>

            <Modal isOpen={quizShowSetup} title="刷题设置" onClose={() => setQuizShowSetup(false)} footer={
                <button onClick={generateQuiz} disabled={quizTypes.length === 0} className="w-full py-3 bg-amber-500 text-white font-bold rounded-2xl disabled:opacity-40 shadow-md">
                    开始出题
                </button>
            }>
                <div className="space-y-5">
                    <div className="text-xs text-slate-500">
                        当前章节: <span className="font-bold text-slate-700">{activeCourse?.chapters[activeCourse?.currentChapterIndex || 0]?.title}</span>
                    </div>

                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">题型选择</label>
                        <div className="flex flex-wrap gap-2">
                            {([['choice', '选择题'], ['true_false', '判断题'], ['fill_blank', '填空题']] as const).map(([val, label]) => {
                                const isOn = quizTypes.includes(val);
                                return (
                                    <button key={val} onClick={() => setQuizTypes(prev => isOn ? prev.filter(t => t !== val) : [...prev, val])} className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${isOn ? 'bg-amber-500 text-white shadow-sm' : 'bg-slate-100 text-slate-500'}`}>
                                        {label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">题目数量: {quizCount}</label>
                        <input type="range" min={3} max={15} value={quizCount} onChange={e => setQuizCount(Number(e.target.value))} className="w-full accent-amber-500" />
                        <div className="flex justify-between text-[10px] text-slate-400 mt-1">
                            <span>3题</span><span>15题</span>
                        </div>
                    </div>
                </div>
            </Modal>
        </div>
    );
};

export default StudyApp;

