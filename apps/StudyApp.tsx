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

// --- Claude风格高级暖灰渲染引擎 ---
const BlackboardRenderer: React.FC<{ text: string, isTyping?: boolean, katexRenderer?: { renderToString: (latex: string, options: any) => string } | null }> = ({ text, isTyping, katexRenderer }) => {
    
    const renderMath = (latex: string, displayMode: boolean) => {
        try {
            const cleanLatex = latex.replace(/\\\[/g, '').replace(/\\\]/g, '');
            const html = katexRenderer?.renderToString(cleanLatex, { displayMode: displayMode, throwOnError: false, output: 'html' });
            if (!html) return <span className="font-mono text-[#2C3E50]">{latex}</span>;
            return <span dangerouslySetInnerHTML={{ __html: html }} className={displayMode ? "block my-2 w-full overflow-x-auto" : "inline-block mx-1"} />;
        } catch (e) {
            return <span className="text-red-500 text-xs font-mono bg-black/5 p-1 rounded">{latex}</span>;
        }
    };

    const parseInline = (line: string): React.ReactNode[] => {
        const tokenRegex = /(\$[^$]+?\$|\*\*[^*]+?\*\*|\*[^*]+?\*|`[^`]+?`|【AI批注：[^】]+】)/g;
        
        return line.split(tokenRegex).map((part, i) => {
            if (part.startsWith('$') && part.endsWith('$')) return <span key={i}>{renderMath(part.slice(1, -1), false)}</span>;
            if (part.startsWith('**') && part.endsWith('**')) return <strong key={i} className="text-[#111111] font-bold mx-0.5">{part.slice(2, -2)}</strong>;
            if (part.startsWith('*') && part.endsWith('*')) return <em key={i} className="text-[#666666] italic">{part.slice(1, -1)}</em>;
            if (part.startsWith('`') && part.endsWith('`')) return <code key={i} className="bg-[#EAECEF] text-[#333333] px-1.5 py-0.5 rounded font-mono text-[13px] mx-0.5">{part.slice(1, -1)}</code>;
            
            // 行内快捷批注识别样式
            if (part.startsWith('【AI批注：') && part.endsWith('】')) {
                return (
                    <span key={i} className="block my-3 px-4 py-3 bg-[#E4E8EC] text-[#4A5568] text-[15px] rounded-xl border border-[#D1D9E0]/50 leading-relaxed shadow-sm">
                        <strong className="text-[#2C3E50] mb-1 block text-[13px] opacity-80">💡 随文批注</strong>
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

        if (trimmed.startsWith('# ')) return <h1 key={index} className="text-2xl font-bold text-[#111111] mt-6 mb-4 pb-2 border-b border-slate-300 font-sans">{trimmed.slice(2)}</h1>;
        if (trimmed.startsWith('## ')) return <h2 key={index} className="text-xl font-bold text-[#222222] mt-4 mb-3 font-sans">{trimmed.slice(3)}</h2>;
        if (trimmed.startsWith('### ')) return <h3 key={index} className="text-lg font-bold text-[#333333] mt-3 mb-2 font-sans">{trimmed.slice(4)}</h3>;

        // 如果是大段分析区（以 > 开头的内容），渲染为漂亮的灰蓝色Claude大卡片
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

        // 默认书籍正文：干净清透的大字号深灰色无衬线字体，极度专注
        return (
            <div key={index} className="text-[#222222] text-[17px] font-normal leading-[1.9] tracking-wide font-sans mb-5 text-justify">
                {parseInline(block)}
            </div>
        );
    };

    let processedText = text;
    const storedMath: string[] = [];
    const storedCode: string[] = [];

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
    return (
        <div className="space-y-1">
            <style>{`
                .katex { color: #2C3E50 !important; } 
                .katex-html { color: #2C3E50 !important; }
            `}</style>
            {blocks.map((line, idx) => renderBlock(line, idx, storedMath, storedCode))}
            {isTyping && (
                <div className="mt-4 animate-pulse flex items-center gap-2 text-slate-400">
                    <span className="w-2 h-5 bg-slate-400"></span>
                    <span className="text-xs font-mono tracking-widest">思考中...</span>
                </div>
            )}
        </div>
    );
};

// --- Main App Component ---
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
        const speed = 25; 
        
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

            setTempPdfData({ name: file.name.replace('.pdf', ''), text: fullText });
            setImportPreference('');
            setIsProcessing(false);
            setShowImportModal(true);

        } catch (e: any) {
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
        
        // 【恢复原版缓存逻辑】如果已经生成过教案，直接秒开看书，不重新请求AI[cite: 1]
        if (chapter.content && !forceRegenerate) {
            skipTypingRef.current = true; 
            setClassroomState('idle'); 
            setCurrentText(chapter.content);
            return;
        }

        skipTypingRef.current = false; 
        setClassroomState('teaching');
        setCurrentText("正在为你排版并解读本章精要...");
        
        const totalLen = course.rawText.length;
        const chunkSize = Math.floor(totalLen / course.chapters.length);
        const start = chapterIdx * chunkSize;
        const chunkText = course.rawText.substring(start, start + chunkSize + 2000); 

        const callApi = async (personaContext: string, isFallback: boolean = false) => {
            // 【100%交还控制权系统提示词】彻底解除原作者绑定
            const prompt = `${personaContext}

### [Source Material] (当前章节参考原文)
${chunkText.substring(0, 8000)}

### [User Custom Preset] (用户的核心调教预设指令)
${course.preference || '请对本章内容进行陪伴共读和心法解析。'}

### [Strict Tasks]
你现在作为私人读书伴侣。请彻底、完整、无条件地遵照执行 [User Custom Preset] 中的所有角色任务和格式需求。
注意：不要输出多余的引导词，专注于完成用户的喜好偏好。
`;
            return await fetch(`${effectiveApi.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey}` },
                body: JSON.stringify({
                    model: effectiveApi.model,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.7,
                    max_tokens: 8000
                })
            });
        };

        try {
            await injectMemoryPalace(selectedChar, undefined, chapter.title);
            let baseContext = ContextBuilder.buildCoreContext(selectedChar, userProfile, true);
            baseContext += `\n### [System: Study Active]\nTeach the user based on instructions. Keep character alive.`;

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
                const fallbackContext = "[System: Safety Fallback Active.]";
                response = await callApi(fallbackContext, true);
                if (response.ok) {
                    const data = await safeResponseJson(response);
                    text = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || "";
                }
            }
            
            if (!text) throw new Error("模型内容返回为空");

            // 【强制原文100%完整拼接兜底算法】解决AI截断和漏字通病
            // 在 AI 的深度心法拆解下方，强制拼接一字不差的本地一整章纯原文，并用精美的Markdown标题隔开[cite: 1]
            const finalRenderedText = `${text}\n\n---\n# 📖 完整原文精读\n${chunkText}`;

            const updatedChapters = [...course.chapters];
            updatedChapters[chapterIdx] = { ...chapter, content: finalRenderedText };
            const updatedCourse = { ...course, chapters: updatedChapters };
            
            await DB.saveCourse(updatedCourse);
            setActiveCourse(updatedCourse);
            setCourses(prev => prev.map(c => c.id === updatedCourse.id ? updatedCourse : c)); 

            setCurrentText(finalRenderedText);
            setClassroomState('idle');
            
        } catch (e: any) {
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
            baseContext += `\n### [System: Study Q&A]`;

            const prompt = `${baseContext}\n### Source Material\n${chunkText.substring(0, 8000)}\n\n### Question\n"${question}"`;
             const response = await fetch(`${effectiveApi.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey}` },
                body: JSON.stringify({ model: effectiveApi.model, messages: [{ role: "user", content: prompt }], temperature: 0.7, max_tokens: 8000 })
            });
            
            const data = await safeResponseJson(response);
            const text = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || "（无回答）";
            
            setCurrentText(text);
            setChatHistory(prev => [...prev, { role: 'assistant', content: text }]);
            setClassroomState('idle');
        } catch (e) {
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
        
        const updatedCourse = { ...activeCourse, chapters: updatedChapters, currentChapterIndex: newIndex, totalProgress: progress };
        
        await DB.saveCourse(updatedCourse);
        setActiveCourse(updatedCourse);
        setCourses(prev => prev.map(c => c.id === updatedCourse.id ? updatedCourse : c)); 

        if (nextIdx >= updatedChapters.length) {
            setCurrentText("恭喜！这本书我们已经伴读完啦！真棒！");
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

        const prompt = `### Task: Generate Quiz\nMaterial:\n${chunkText.substring(0, 6000)}\nGenerate ${quizCount} questions. Output JSON format.`;

        try {
            const response = await fetch(`${effectiveApi.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey}` },
                body: JSON.stringify({ model: effectiveApi.model, messages: [{ role: "user", content: prompt }], temperature: 0.7, max_tokens: 6000 })
            });
            const data = await safeResponseJson(response);
            const content = (data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || '').replace(/```json/g, '').replace(/```/g, '').trim();
            const json = JSON.parse(content);

            const questions: QuizQuestion[] = (json.questions || []).map((q: any, i: number) => ({
                id: `q-${Date.now()}-${i}`, type: q.type, stem: q.stem, options: q.options, answer: String(q.answer), explanation: q.explanation || '',
            }));

            const session: QuizSession = {
                id: `quiz-${Date.now()}`, courseId: activeCourse.id, chapterId: chapter.id, chapterTitle: chapter.title, courseTitle: activeCourse.title, questions, score: 0, totalQuestions: questions.length, aiReview: '', status: 'in_progress', createdAt: Date.now(),
            };

            await DB.saveQuiz(session);
            setQuizSession(session);
            setQuizLoading('');
        } catch (e: any) {
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
            let isCorrect = userAns.trim().toLowerCase() === q.answer.trim().toLowerCase();
            return { ...q, userAnswer: userAns, isCorrect };
        });

        const score = gradedQuestions.filter(q => q.isCorrect).length;
        const gradedSession: QuizSession = { ...quizSession, questions: gradedQuestions, score, aiReview: '批改完毕！', status: 'graded', gradedAt: Date.now() };
        
        await DB.saveQuiz(gradedSession);
        setQuizSession(gradedSession);
        setQuizLoading('');
        setMode('quiz_review');
    };

    if (mode === 'practice_book') {
        return (
            <div className="h-full w-full bg-[#fdfbf7] flex flex-col font-sans relative">
                <div className="bg-[#fdfbf7]/90 backdrop-blur-md border-b border-[#e5e5e5] shrink-0 sticky top-0 z-20" style={{ paddingTop: 'var(--safe-top)' }}>
                    <div className="flex items-center px-6 py-3">
                        <div className="flex justify-between items-center w-full">
                            <button onClick={() => setMode('bookshelf')} className="p-2 -ml-2 rounded-full hover:bg-black/5">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                            </button>
                            <span className="font-bold text-slate-800 text-lg tracking-wide">练习册</span>
                            <div className="w-10" />
                        </div>
                    </div>
                </div>
                <div className="p-6 flex-1 overflow-y-auto no-scrollbar">
                    {allQuizzes.map(quiz => (
                        <div key={quiz.id} onClick={() => resumeQuiz(quiz)} className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 mb-3 cursor-pointer">
                            <div className="text-sm font-bold text-slate-800">{quiz.courseTitle}</div>
                            <div className="text-xs text-slate-500">{quiz.chapterTitle}</div>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    if (mode === 'quiz_review' || mode === 'quiz') {
        return (
            <div className="h-full w-full bg-[#F3F1EB] flex flex-col font-sans p-6 overflow-y-auto">
                <button onClick={() => setMode('classroom')} className="mb-4 bg-white px-4 py-2 rounded-xl text-xs font-bold border border-slate-200">返回课堂</button>
                <div className="text-center font-bold text-lg text-slate-800">随堂测试面板</div>
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
                            <button onClick={() => { loadQuizzes(); setMode('practice_book'); }} className="p-2 rounded-full hover:bg-black/5"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-slate-500"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z" /></svg></button>
                            {/* 【完美恢复】全局齿轮设置按钮[cite: 1] */}
                            <button onClick={() => setShowStudySettings(true)} className="p-2 -mr-2 rounded-full hover:bg-black/5"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-slate-500"><path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" /></svg></button>
                        </div>
                    </div>
                    </div>
                </div>

                <div className="p-6 flex-1 overflow-y-auto no-scrollbar">
                    <div className="mb-6">
                        <h3 className="text-xs font-bold text-slate-400 uppercase mb-2">当前助教</h3>
                        <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
                            {characters.map(c => (
                                <div key={c.id} onClick={() => setSelectedChar(c)} className={`flex flex-col items-center gap-1.5 cursor-pointer transition-opacity ${selectedChar?.id === c.id ? 'opacity-100' : 'opacity-40'}`}>
                                    <img src={c.avatar} className={`w-12 h-12 rounded-full object-cover border-2 ${selectedChar?.id === c.id ? 'border-emerald-500' : 'border-transparent'}`} />
                                    <span className="text-[10px] font-bold text-slate-600">{c.name}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    <h3 className="text-xs font-bold text-slate-400 uppercase mb-3">我的书籍</h3>
                    <div className="grid grid-cols-2 gap-4">
                        <button onClick={() => fileInputRef.current?.click()} className="aspect-[3/4] rounded-xl border-2 border-dashed border-slate-300 flex flex-col items-center justify-center gap-1 text-slate-400 bg-white hover:border-emerald-500">
                            {isProcessing ? <span className="text-[10px]">{processStatus}</span> : <span className="text-xs font-bold">+ 导入书籍 PDF</span>}
                        </button>
                        <input type="file" ref={fileInputRef} className="hidden" accept=".pdf" onChange={handleFileSelect} />

                        {courses.map(course => (
                            <div key={course.id} onClick={() => startSession(course)} className="aspect-[3/4] rounded-xl shadow-sm relative overflow-hidden p-4 text-white cursor-pointer" style={{ background: course.coverStyle }}>
                                <div className="font-sans font-bold text-base leading-snug line-clamp-3">{course.title}</div>
                                <div className="absolute bottom-4 left-4 right-4 text-[10px] opacity-80">学习进度: {course.totalProgress}%</div>
                            </div>
                        ))}
                    </div>
                </div>

                <Modal isOpen={showImportModal} title="书籍共读偏好设置" onClose={() => setShowImportModal(false)} footer={<button onClick={confirmImport} className="w-full py-3 bg-emerald-500 text-white font-bold rounded-2xl">开始导入</button>}>
                    <textarea value={importPreference} onChange={e => setImportPreference(e.target.value)} placeholder="在此填写核心提示词（例如：你现在是王阳明本尊。请对本章内容进行陪伴共读和心法解析，请多把你的感悟用Markdown引用块语法包裹...）" className="w-full h-40 bg-slate-100 rounded-xl p-3 text-sm" />
                </Modal>

                <Modal isOpen={showStudySettings} title="自习室管理" onClose={() => setShowStudySettings(false)}>
                    <div className="space-y-6">
                        <div>
                            <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">专用 API</h4>
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
                            <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">提示词预设管理</h4>
                            {tutorPresets.length > 0 && (
                                <div className="space-y-2 mb-3">
                                    {tutorPresets.map(p => (
                                        <div key={p.id} className="bg-slate-50 rounded-xl p-3 flex items-start gap-2">
                                            <div className="flex-1 min-w-0">
                                                <div className="text-sm font-bold text-slate-700">{p.name}</div>
                                                <div className="text-xs text-slate-400 truncate">{p.prompt}</div>
                                            </div>
                                            <button onClick={() => deletePreset(p.id)} className="text-slate-400 hover:text-red-500 p-1"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg></button>
                                        </div>
                                    ))}
                                </div>
                            )}
                            <div className="space-y-2 bg-slate-100 rounded-xl p-3">
                                <input value={presetName} onChange={e => setPresetName(e.target.value)} placeholder="预设名称" className="w-full bg-white rounded-lg p-2.5 text-sm" />
                                <textarea value={presetPrompt} onChange={e => setPresetPrompt(e.target.value)} placeholder="预设提示词内容..." className="w-full bg-white rounded-lg p-2.5 text-sm resize-none h-24" />
                                <button onClick={handleSavePreset} disabled={!presetName.trim() || !presetPrompt.trim()} className="w-full py-2.5 bg-emerald-500 text-white font-bold rounded-xl text-xs">添加预设</button>
                            </div>
                        </div>
                    </div>
                </Modal>
            </div>
        );
    }

    // --- 恢复经典的整章沉浸式自习室视图 ---
    return (
        <div className="h-full w-full bg-[#F3F1EB] flex flex-col relative overflow-hidden font-sans">
            <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(0,0,0,1) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,1) 1px, transparent 1px)', backgroundSize: '40px 40px' }}></div>

            {/* 顶栏栏 */}
            <div className="absolute top-0 w-full px-4 pb-4 flex justify-between z-30 pointer-events-none" style={{ paddingTop: 'max(1rem, var(--safe-top))' }}>
                <button onClick={() => setMode('bookshelf')} className="bg-white/70 text-slate-700 p-2 rounded-full border border-slate-200/60 shadow-sm pointer-events-auto">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                </button>
                <div className="flex gap-2">
                    <div onClick={() => setShowChapterMenu(true)} className="bg-white/70 text-slate-700 px-4 py-1.5 rounded-full border border-slate-200/60 shadow-sm pointer-events-auto cursor-pointer text-xs font-bold flex items-center gap-1.5">
                        <span className="truncate max-w-[150px]">{activeCourse?.chapters[activeCourse.currentChapterIndex]?.title}</span>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
                    </div>
                    <button onClick={() => setShowAssistant(!showAssistant)} className={`bg-white/60 p-2 rounded-full border border-slate-200/60 shadow-sm pointer-events-auto transition-colors ${showAssistant ? 'text-emerald-600' : 'text-slate-400'}`}>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5"><path d="M10 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.465 14.493a1.23 1.23 0 0 0 .41 1.412A9.957 9.957 0 0 0 10 18c2.31 0 4.438-.784 6.131-2.1.43-.333.604-.903.408-1.41a7.002 7.002 0 0 0-13.074.003Z" /></svg>
                    </button>
                </div>
            </div>

            {/* 章节目录 */}
            {showChapterMenu && (
                <div className="absolute inset-0 z-50 flex">
                    <div className="flex-1 bg-black/20" onClick={() => setShowChapterMenu(false)}></div>
                    <div className="w-64 bg-white border-l border-slate-200 h-full p-4 shadow-xl overflow-y-auto">
                        <h3 className="text-slate-800 font-bold text-sm mb-4">目录</h3>
                        {activeCourse?.chapters.map((ch, idx) => (
                            <button key={ch.id} onClick={() => jumpToChapter(idx)} className={`w-full text-left p-3 rounded-xl text-xs mb-1 ${idx === activeCourse.currentChapterIndex ? 'bg-emerald-600 text-white font-bold' : 'text-slate-600 hover:bg-slate-50'}`}>{ch.title}</button>
                        ))}
                    </div>
                </div>
            )}

            {/* 核心沉浸阅读展示区 */}
            <div className="flex-1 overflow-y-auto no-scrollbar p-6 pt-24 pb-32">
                <div className="max-w-[100%]">
                    <BlackboardRenderer text={displayedText} isTyping={isTyping} katexRenderer={katexRenderer} />
                </div>
            </div>

            {/* 助教精灵挂件 */}
            {showAssistant && (
                <div className="absolute bottom-20 right-[-10px] w-[150px] h-[210px] z-20 pointer-events-none flex items-end justify-center transition-all duration-500" style={{ transform: isTyping ? 'scale(1.03)' : 'scale(1)', opacity: isTyping || classroomState === 'teaching' ? 1 : 0.7 }}>
                     <img src={currentSprite} className="max-h-full max-w-full object-contain drop-shadow-md" />
                </div>
            )}

            {/* 底部融合操作底栏 */}
            <div className="absolute bottom-0 w-full bg-[#F3F1EB]/95 backdrop-blur-md border-t border-slate-200/60 p-4 z-30 pb-safe">
                <div className="flex gap-3">
                    {classroomState === 'teaching' || isTyping ? (
                        <div className="w-full h-12 flex items-center justify-center text-slate-400 text-sm animate-pulse font-mono tracking-widest">
                            LECTURING...
                        </div>
                    ) : classroomState === 'finished' ? (
                        <button onClick={() => setMode('bookshelf')} className="flex-1 h-12 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl font-bold shadow-lg">
                            完成课程
                        </button>
                    ) : classroomState === 'q_and_a' ? (
                        <div className="w-full bg-white rounded-2xl p-1 flex items-center border border-slate-200 shadow-sm">
                            <input value={userQuestion} onChange={e => setUserQuestion(e.target.value)} placeholder="向阳明本尊发问心法..." className="flex-1 bg-transparent px-4 py-2 text-slate-800 text-sm outline-none placeholder:text-slate-400" autoFocus />
                            <button onClick={handleAskQuestion} className="bg-emerald-600 text-white px-5 py-2 rounded-xl text-xs font-bold ml-2 shadow-sm hover:bg-emerald-500">发送</button>
                        </div>
                    ) : (
                        <>
                            <button onClick={handleRegenerateChapter} className="w-12 h-12 bg-white hover:bg-slate-50 text-slate-500 rounded-2xl font-bold border border-slate-200 active:scale-95 transition-all flex items-center justify-center shadow-sm" title="重新研读本章">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                            </button>
                            <button onClick={() => setClassroomState('q_and_a')} className="w-12 h-12 bg-white hover:bg-slate-50 text-slate-600 rounded-2xl font-bold border border-slate-200 shadow-sm flex items-center justify-center">
                                <Hand size={24} />
                            </button>
                            <button onClick={openQuizSetup} className="w-12 h-12 bg-amber-500 text-white rounded-2xl font-bold flex items-center justify-center shadow-md shadow-amber-500/10" title="章节刷题">
                                <Notepad size={24} />
                            </button>
                            <button onClick={handleFinishChapter} className="flex-1 h-12 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl font-bold shadow-md flex items-center justify-center gap-2">
                                下一章 <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" /></svg>
                            </button>
                        </>
                    )}
                </div>
            </div>

            <Modal isOpen={quizShowSetup} title="章节测试" onClose={() => setQuizShowSetup(false)} footer={<button onClick={generateQuiz} className="w-full py-3 bg-amber-500 text-white font-bold rounded-2xl shadow-md">开始测验</button>}>
                <div className="text-xs text-slate-500">将基于本章的阅读广度为你自动抽题考核。</div>
            </Modal>
        </div>
    );
};

export default StudyApp;