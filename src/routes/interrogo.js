import express from 'express';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { verifyToken } from '../middleware/auth.js';
import aiService from '../ai-service.js';
import { getBillingStatus } from '../billing-service.js';

const router = express.Router();
const prisma = new PrismaClient();
const MAX_CONTENT_CONTEXT_CHARS = 15000;

const getTargetQuestionsFromDifficulty = (difficulty, examMode = 'standard') => {
  let base;
  if (difficulty <= 3) base = 5;
  else if (difficulty <= 7) base = 7;
  else base = 9;

  const modeBonus = examMode === 'deep' ? 4 : examMode === 'extended' ? 2 : 0;
  return Math.min(14, Math.max(4, base + modeBonus));
};

const deriveTopicFromContent = (content) => {
  const lines = String(content || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const heading = lines.find((line) => /^(capitolo|unit[aà]|lezione|tema|argomento|chapter)/i.test(line));
  if (heading) return heading.slice(0, 80);

  const firstLong = lines.find((line) => line.length >= 20);
  if (firstLong) return firstLong.slice(0, 80);

  return 'Topic from uploaded material';
};

const isWeakAnswer = (text) => {
  return text.trim().length < 24 || /i\s*don'?t\s*know|i\s*do\s*not\s*know|not\s*sure|non lo so|boh|non ricordo|non saprei/i.test(text);
};

const normalizeTopicKey = (topic) => (topic || '').trim().toLowerCase();

const requireTutor = async (req, res, next) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { role: true },
  });

  if (!user || !['TUTOR', 'ADMIN'].includes(user.role)) {
    return res.status(403).json({ error: 'Tutor access required' });
  }

  next();
};

const moderationPatterns = [
  { key: 'credential', level: 'high', pattern: /\b(password|passwd|pwd)\b\s*[:=]/i },
  { key: 'secret', level: 'high', pattern: /\b(api[_-]?key|secret[_-]?key|token)\b\s*[:=]/i },
  // Stricter card-like pattern to avoid blocking scientific numbers from school PDFs
  { key: 'financial', level: 'medium', pattern: /\b(?:\d{4}[- ]?){3}\d{4}\b/ },
  { key: 'personal-id', level: 'medium', pattern: /\b(codice fiscale|iban|documento)\b/i },
  { key: 'unsafe-prompt', level: 'medium', pattern: /ignora le regole|bypass|disattiva guardrail/i },
];

const sanitizeUserText = (text) => String(text || '')
  .replace(/\r/g, '')
  .split('\n')
  .map((line) => line.replace(/[ \t]+/g, ' ').trim())
  .filter(Boolean)
  .join('\n');

const evaluateModeration = (text, { forMaterial = false } = {}) => {
  const matches = moderationPatterns
    .filter((entry) => entry.pattern.test(text))
    .map((entry) => ({ key: entry.key, level: entry.level }));

  if (!matches.length) {
    return { blocked: false, matches: [], maxLevel: null };
  }

  const maxLevel = matches.some((m) => m.level === 'high') ? 'high' : 'medium';
  const blockKeysForMaterial = new Set(['credential', 'secret', 'unsafe-prompt']);
  const blocked = forMaterial
    ? matches.some((m) => blockKeysForMaterial.has(m.key))
    : matches.some((m) => m.level === 'high' || m.key === 'unsafe-prompt');

  return {
    blocked,
    matches,
    maxLevel,
  };
};

const appendModerationAudit = async (entry) => {
  try {
    await prisma.moderationEvent.create({
      data: {
        userId: entry.userId || null,
        endpoint: entry.endpoint,
        level: entry.level,
        matches: JSON.stringify(entry.matches || []),
        excerpt: entry.excerpt || null,
      },
    });
  } catch (error) {
    console.error('⚠️ Failed to persist moderation event:', error.message);
  }
};

const splitIntoChunks = (text, chunkSize = 900) => {
  const normalized = String(text || '').replace(/\r/g, '');
  const paragraphs = normalized.split('\n\n').map((p) => p.trim()).filter(Boolean);
  const chunks = [];

  let current = '';
  let currentStart = 0;

  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }

    if ((current + '\n\n' + paragraph).length <= chunkSize) {
      current += `\n\n${paragraph}`;
    } else {
      chunks.push({
        text: current,
        start: currentStart,
      });
      currentStart += current.length;
      current = paragraph;
    }
  }

  if (current) {
    chunks.push({ text: current, start: currentStart });
  }

  return chunks;
};

const estimateChunkConfidence = (chunk) => {
  const hasDefinition = /definizione|si definisce|teorema|principio/i.test(chunk);
  const hasFormula = /(=|\+|\-|\*|\/|\^|\(|\))/i.test(chunk);
  const hasDate = /\b(1[0-9]{3}|20[0-9]{2})\b/.test(chunk);
  const score = [hasDefinition, hasFormula, hasDate].filter(Boolean).length;
  return parseFloat((0.4 + score * 0.2).toFixed(2));
};

const buildManualIndex = (text) => {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const chapters = [];
  const definitions = [];
  const formulas = [];
  const dates = [];

  const chapterRegex = /^(capitolo|chapter|unit[aà]|lezione)\s*\d*/i;
  const definitionRegex = /^(definizione|si definisce|[a-zàèéìòù\-\s]{3,40}\s*:\s+)/i;
  const formulaRegex = /(=|\+|\-|\*|\/|\^|\(|\)|\bformula\b|\bteorema\b|\blegge\b)/i;
  const dateRegex = /\b(1[0-9]{3}|20[0-9]{2})\b|\b\d{1,2}\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\b/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const page = Math.floor(i / 45) + 1;

    if (chapterRegex.test(line) && chapters.length < 24) {
      chapters.push({ title: line.slice(0, 120), citation: `from page ${page}` });
    }

    if (definitionRegex.test(line) && definitions.length < 60) {
      definitions.push({ text: line.slice(0, 180), citation: `from page ${page}` });
    }

    if (formulaRegex.test(line) && /\d|=/.test(line) && formulas.length < 60) {
      formulas.push({ text: line.slice(0, 180), citation: `from page ${page}` });
    }

    if (dateRegex.test(line) && dates.length < 60) {
      dates.push({ text: line.slice(0, 180), citation: `from page ${page}` });
    }
  }

  return {
    chapters,
    definitions,
    formulas,
    dates,
    chunks: splitIntoChunks(text).slice(0, 80).map((chunk, idx) => ({
      id: idx + 1,
      excerpt: chunk.text.slice(0, 240),
      citation: `from page ${Math.floor((chunk.start || 0) / (45 * 80)) + 1}`,
      confidence: estimateChunkConfidence(chunk.text),
      tags: [
        /definizione|si definisce/i.test(chunk.text) ? 'definition' : null,
        /(=|\+|\-|\*|\/|\^)/.test(chunk.text) ? 'formula' : null,
        /\b(1[0-9]{3}|20[0-9]{2})\b/.test(chunk.text) ? 'date' : null,
      ].filter(Boolean),
    })),
    summary: {
      chapterCount: chapters.length,
      definitionCount: definitions.length,
      formulaCount: formulas.length,
      dateCount: dates.length,
    },
  };
};

const toCsv = (rows) => {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const lines = [headers.map(escape).join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => escape(row[header])).join(','));
  }
  return lines.join('\n');
};

const buildPersonalityDirective = ({ personality, weakAnswer, questionIndex, targetQuestions }) => {
  if (personality === 'socratic') {
    return [
      'Socratic style rule:',
      '- Do not provide the direct solution.',
      '- Ask one guiding question at a time.',
      weakAnswer ? '- Start from fundamentals and surface the student reasoning.' : '- Increase depth with cause-effect connections.',
      `- Session state: question ${questionIndex}/${targetQuestions}.`,
    ].join('\n');
  }

  if (personality === 'strict') {
    if (weakAnswer) {
      return [
        'Strict style rule:',
        '- Open with a brief direct assessment (max 8 words).',
        '- No free hints: require precision.',
        '- Ask one targeted recovery question.',
      ].join('\n');
    }

    return [
      'Strict style rule:',
      '- Acknowledge performance in a sober way, without over-praising.',
      '- Raise the bar slightly in the next question.',
      `- Session state: question ${questionIndex}/${targetQuestions}.`,
    ].join('\n');
  }

  if (weakAnswer) {
    return [
      'Supportive style rule:',
      '- Open with a brief supportive sentence.',
      '- Give one micro-hint (maximum 1 sentence).',
      '- Ask one guided question to check understanding.',
    ].join('\n');
  }

  return [
    'Supportive style rule:',
    '- Validate the correct part of the answer with concrete feedback.',
    '- Extend with a related but accessible question.',
    `- Session state: question ${questionIndex}/${targetQuestions}.`,
  ].join('\n');
};

const enforcePersonalityFrame = (personality, text, weakAnswer) => {
  const content = (text || '').trim();
  if (!content) return content;

  if (personality === 'socratic') {
    const prefix = weakAnswer
      ? 'Guida socratica: partiamo dalle basi. '
      : 'Guida socratica: ragiona passo per passo. ';
    return content.startsWith('Guida socratica:') ? content : `${prefix}${content}`;
  }

  if (personality === 'strict') {
    const prefix = weakAnswer
      ? 'Valutazione rapida: risposta insufficiente. '
      : 'Valutazione rapida: livello accettabile, resta preciso. ';
    return content.startsWith('Valutazione rapida:') ? content : `${prefix}${content}`;
  }

  const prefix = weakAnswer
    ? 'Ci siamo, ripartiamo con calma. '
    : 'Ottimo, continuiamo a consolidare. ';
  return content.startsWith('Ci siamo,') || content.startsWith('Ottimo,') ? content : `${prefix}${content}`;
};

async function analyzeWithAzureDocumentIntelligence(base64Pdf) {
  const endpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
  const apiKey = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;

  if (!endpoint || !apiKey) {
    throw new Error('Azure Document Intelligence is not configured');
  }

  const cleanEndpoint = endpoint.replace(/\/$/, '');
  const analyzeUrl = `${cleanEndpoint}/formrecognizer/documentModels/prebuilt-read:analyze?api-version=2023-07-31`;

  const analyzeResponse = await axios.post(
    analyzeUrl,
    { base64Source: base64Pdf },
    {
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': apiKey,
      },
      timeout: 30000,
      validateStatus: (status) => status >= 200 && status < 300,
    }
  );

  const operationLocation = analyzeResponse.headers['operation-location'];
  if (!operationLocation) {
    throw new Error('Azure OCR operation-location not returned');
  }

  const maxAttempts = 20;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const poll = await axios.get(operationLocation, {
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
      },
      timeout: 30000,
    });

    const status = poll.data?.status;
    if (status === 'succeeded') {
      const pages = poll.data?.analyzeResult?.pages || [];
      const lines = [];
      for (const page of pages) {
        for (const line of page.lines || []) {
          lines.push({
            page: page.pageNumber,
            text: line.content,
          });
        }
      }

      const text = lines.map((l) => `[p.${l.page}] ${l.text}`).join('\n');
      return {
        text,
        source: 'azure-document-intelligence',
        pageCount: pages.length,
      };
    }

    if (status === 'failed') {
      throw new Error('Azure OCR analysis failed');
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error('Azure OCR analysis timed out');
}

// Middleware to verify token for all interrogo routes
router.use(verifyToken);

// Start Interrogation Session
router.post('/start', async (req, res) => {
  try {
    const { topic, difficulty, personality, content, examMode: rawExamMode, targetQuestions: requestedTargetQuestions } = req.body;
    const userId = req.userId;
    const cleanedContent = sanitizeUserText(content);
    const examMode = ['standard', 'extended', 'deep'].includes(rawExamMode) ? rawExamMode : 'standard';
    const derivedTopic = topic?.trim() ? topic.trim() : deriveTopicFromContent(cleanedContent);

    // Validation
    if (!cleanedContent) {
      return res.status(400).json({ error: 'Content is required' });
    }

    if (!difficulty || difficulty < 1 || difficulty > 10) {
      return res.status(400).json({ error: 'Difficulty must be between 1 and 10' });
    }

    if (!["strict", "supportive", "socratic"].includes(personality)) {
      return res.status(400).json({ error: 'Personality must be "strict", "supportive", or "socratic"' });
    }

    if (cleanedContent.length < 10) {
      return res.status(400).json({ error: 'Content must be at least 10 characters' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    const billing = await getBillingStatus(user?.email || '');
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const freeMonthlyLimit = Number(process.env.FREE_MONTHLY_EXAM_LIMIT || 10);

    if (!billing.isPro) {
      const monthlyCount = await prisma.interrogoSession.count({
        where: {
          userId,
          createdAt: {
            gte: monthStart,
          },
        },
      });

      if (monthlyCount >= freeMonthlyLimit) {
        return res.status(402).json({
          error: `Free plan monthly limit reached (${freeMonthlyLimit} exams). Upgrade to Pro to continue.`,
          code: 'FREE_PLAN_LIMIT_REACHED',
          freeMonthlyLimit,
          monthlyCount,
        });
      }
    }

    const moderation = evaluateModeration(cleanedContent, { forMaterial: true });
    if (moderation.blocked) {
      await appendModerationAudit({
        at: new Date().toISOString(),
        userId,
        endpoint: '/start',
        level: moderation.maxLevel,
        matches: moderation.matches,
        excerpt: cleanedContent.slice(0, 220),
      });
      const matchedKeys = moderation.matches.map((m) => m.key).join(', ');
      return res.status(400).json({ error: `Content blocked by security guardrails (${matchedKeys}). Remove sensitive data and try again.` });
    }

    // Keep a larger source context to avoid generic questions detached from the uploaded material
    const contentPreview = cleanedContent.substring(0, MAX_CONTENT_CONTEXT_CHARS);

    const targetQuestions = typeof requestedTargetQuestions === 'number'
      ? Math.min(14, Math.max(4, Math.floor(requestedTargetQuestions)))
      : getTargetQuestionsFromDifficulty(difficulty, examMode);

    // Create session
    const session = await prisma.interrogoSession.create({
      data: {
        userId,
        topic: derivedTopic,
        difficulty,
        personality,
        contentPreview,
      },
    });

    // Generate first question
    const conversationHistory = [
      {
        role: 'user',
        content: `Start an oral exam based ONLY on the uploaded material. Detected topic: ${derivedTopic}. Mode: ${examMode}. Target questions: ${targetQuestions}. First question must be specific, grounded in the material, and non-generic.`,
      },
    ];

    const firstQuestion = await aiService.generateQuestion(
      cleanedContent,
      conversationHistory,
      difficulty,
      personality
    );

    // Save teacher's first question
    await prisma.interrogoMessage.create({
      data: {
        sessionId: session.id,
        role: 'teacher',
        content: firstQuestion,
      },
    });

    res.status(201).json({
      sessionId: session.id,
      topic: session.topic,
      difficulty: session.difficulty,
      personality: session.personality,
      examMode,
      targetQuestions,
      firstQuestion: firstQuestion,
    });
  } catch (error) {
    console.error('❌ Session start error:', error);
    
    if (error.message.includes('Rate limited')) {
      return res.status(429).json({ error: error.message });
    }

    res.status(500).json({ error: error.message || 'Failed to start session' });
  }
});

// Send Message (user answer)
router.post('/message', async (req, res) => {
  try {
    const { sessionId, message, targetQuestions: requestedTargetQuestions, examMode: rawExamMode } = req.body;
    const userId = req.userId;
    const cleanedMessage = sanitizeUserText(message);
    const examMode = ['standard', 'extended', 'deep'].includes(rawExamMode) ? rawExamMode : 'standard';

    // Validation
    if (!sessionId || !cleanedMessage) {
      return res.status(400).json({ error: 'Session ID and message are required' });
    }

    const moderation = evaluateModeration(cleanedMessage);
    if (moderation.blocked) {
      await appendModerationAudit({
        at: new Date().toISOString(),
        userId,
        endpoint: '/message',
        level: moderation.maxLevel,
        matches: moderation.matches,
        excerpt: cleanedMessage.slice(0, 220),
      });
      return res.status(400).json({ error: 'Message blocked by security guardrails. Remove sensitive data and try again.' });
    }

    // Get session
    const session = await prisma.interrogoSession.findUnique({
      where: { id: sessionId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (session.endedAt) {
      return res.status(400).json({ error: 'Session has already ended' });
    }

    // Save student message
    const studentMessage = await prisma.interrogoMessage.create({
      data: {
        sessionId,
        role: 'student',
        content: cleanedMessage,
      },
    });

    const targetQuestions = typeof requestedTargetQuestions === 'number'
      ? Math.min(14, Math.max(4, Math.floor(requestedTargetQuestions)))
      : getTargetQuestionsFromDifficulty(session.difficulty, examMode);
    const teacherQuestionCount = session.messages.filter((m) => m.role === 'teacher').length;
    const answeredCount = session.messages.filter((m) => m.role === 'student').length + 1;

    // Convert messages to conversation format and include current answer
    const evaluationConversation = [
      ...session.messages.map((m) => ({
        role: m.role === 'teacher' ? 'assistant' : 'user',
        content: m.content,
      })),
      {
        role: 'user',
        content: cleanedMessage,
      },
    ];

    // Auto-complete after target number of questions (3-5 based on difficulty)
    if (teacherQuestionCount >= targetQuestions) {
      const evaluation = await aiService.evaluateSession(
        session.contentPreview || '',
        evaluationConversation,
        session.personality
      );

      await prisma.interrogoSession.update({
        where: { id: sessionId },
        data: {
          finalScore: evaluation.score,
          finalFeedback: JSON.stringify(evaluation),
          endedAt: new Date(),
        },
      });

      return res.json({
        isComplete: true,
        score: evaluation.score,
        strengths: evaluation.strengths,
        weaknesses: evaluation.weaknesses,
        suggestions: evaluation.suggestions,
        rubric: evaluation.rubric,
        studyPlan: evaluation.studyPlan,
        kpis: evaluation.kpis,
        message: 'Exam completed.',
      });
    }

    const weakAnswer = isWeakAnswer(cleanedMessage);
    const personalityDirective = buildPersonalityDirective({
      personality: session.personality,
      weakAnswer,
      questionIndex: teacherQuestionCount + 1,
      targetQuestions,
    });
    const adaptiveMessage = `${cleanedMessage}\n\n[${personalityDirective}]\n[Vincolo: fai domande SOLO sul materiale caricato in sessione; se manca una info, dichiaralo esplicitamente.]`;

    // Prepare conversation history for AI (last 10 messages)
    const recentMessages = session.messages.slice(-10).map(m => ({
      role: m.role === 'teacher' ? 'assistant' : 'user',
      content: m.content,
    }));

    recentMessages.push({
      role: 'user',
      content: adaptiveMessage,
    });

    // Generate teacher response
    const rawTeacherResponse = await aiService.generateQuestion(
      session.contentPreview || '',
      recentMessages,
      session.difficulty,
      session.personality
    );
    const teacherResponse = enforcePersonalityFrame(session.personality, rawTeacherResponse, weakAnswer);

    // Save teacher message
    await prisma.interrogoMessage.create({
      data: {
        sessionId,
        role: 'teacher',
        content: teacherResponse,
      },
    });

    res.json({
      isComplete: false,
      studentMessage: cleanedMessage,
      teacherResponse: teacherResponse,
      targetQuestions,
      currentQuestion: Math.min(targetQuestions, answeredCount + 1),
      questionsRemaining: Math.max(0, targetQuestions - answeredCount),
      messageCount: session.messages.length + 2, // +2 for new messages
    });
  } catch (error) {
    console.error('❌ Send message error:', error);

    if (error.message.includes('Rate limited')) {
      return res.status(429).json({ error: error.message });
    }

    res.status(500).json({ error: error.message || 'Failed to send message' });
  }
});

// End Interrogation Session
router.post('/end', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const userId = req.userId;

    // Validation
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    // Get session with all messages
    const session = await prisma.interrogoSession.findUnique({
      where: { id: sessionId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (session.endedAt) {
      return res.status(400).json({ error: 'Session has already ended' });
    }

    // Convert messages to conversation format
    const conversationHistory = session.messages.map(m => ({
      role: m.role === 'teacher' ? 'assistant' : 'user',
      content: m.content,
    }));

    // Generate evaluation
    const evaluation = await aiService.evaluateSession(
      session.contentPreview || '',
      conversationHistory,
      session.personality
    );

    // Update session with results
    const updatedSession = await prisma.interrogoSession.update({
      where: { id: sessionId },
      data: {
        finalScore: evaluation.score,
        finalFeedback: JSON.stringify(evaluation),
        endedAt: new Date(),
      },
    });

    res.json({
      sessionId: updatedSession.id,
      topic: updatedSession.topic,
      score: evaluation.score,
      strengths: evaluation.strengths,
      weaknesses: evaluation.weaknesses,
      suggestions: evaluation.suggestions,
      rubric: evaluation.rubric,
      studyPlan: evaluation.studyPlan,
      kpis: evaluation.kpis,
      duration: Math.round((updatedSession.endedAt - updatedSession.createdAt) / 1000 / 60), // minutes
    });
  } catch (error) {
    console.error('❌ End session error:', error);

    if (error.message.includes('Rate limited')) {
      return res.status(429).json({ error: error.message });
    }

    res.status(500).json({ error: error.message || 'Failed to end session' });
  }
});

// Explain concept when student says "Non lo so"
router.post('/explain', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const userId = req.userId;

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    const session = await prisma.interrogoSession.findUnique({
      where: { id: sessionId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (session.endedAt) {
      return res.status(400).json({ error: 'Session has already ended' });
    }

    const explanation = await aiService.explainConcept(
      session.topic,
      session.contentPreview || session.topic,
      session.personality
    );

    const teacherMessage = `I understand. Let me help: ${explanation}`;

    await prisma.interrogoMessage.create({
      data: {
        sessionId,
        role: 'teacher',
        content: teacherMessage,
      },
    });

    res.json({
      teacherResponse: teacherMessage,
    });
  } catch (error) {
    console.error('❌ Explain concept error:', error);
    res.status(500).json({ error: error.message || 'Failed to explain concept' });
  }
});

// OCR fallback for scanned PDFs (Azure Document Intelligence)
router.post('/ocr', async (req, res) => {
  try {
    const { base64Pdf } = req.body;

    if (!base64Pdf || typeof base64Pdf !== 'string') {
      return res.status(400).json({ error: 'base64Pdf is required' });
    }

    const ocrResult = await analyzeWithAzureDocumentIntelligence(base64Pdf);
    return res.json(ocrResult);
  } catch (error) {
    console.error('❌ OCR error:', error.message);
    if (error.message.includes('not configured')) {
      return res.status(501).json({ error: 'OCR fallback not configured on server' });
    }
    return res.status(500).json({ error: 'Failed to extract text with OCR fallback' });
  }
});

// Manual textbook semantic index (chapters, definitions, formulas, dates)
router.post('/manual-index', async (req, res) => {
  try {
    const { content } = req.body;

    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content is required' });
    }

    const indexed = buildManualIndex(content);
    return res.json(indexed);
  } catch (error) {
    console.error('❌ Manual index error:', error);
    return res.status(500).json({ error: 'Failed to build manual index' });
  }
});

router.get('/moderation/policy', requireTutor, async (req, res) => {
  return res.json({
    mode: 'enforced',
    levels: ['medium', 'high'],
    rules: moderationPatterns.map((r) => ({ key: r.key, level: r.level })),
  });
});

router.get('/moderation/audit', requireTutor, async (req, res) => {
  const recent = await prisma.moderationEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      createdAt: true,
      endpoint: true,
      level: true,
      matches: true,
      excerpt: true,
      user: {
        select: {
          email: true,
        },
      },
    },
  });

  const mapped = recent.map((evt) => ({
    at: evt.createdAt,
    endpoint: evt.endpoint,
    level: evt.level,
    matches: JSON.parse(evt.matches || '[]'),
    excerpt: evt.excerpt,
    userEmail: evt.user?.email || null,
  }));

  return res.json({
    total: mapped.length,
    recent: mapped,
  });
});

// Analytics overview (4-week trend + weak topics + KPI)
router.get('/analytics/overview', async (req, res) => {
  try {
    const userId = req.userId;
    const fourWeeksAgo = new Date();
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

    const sessions = await prisma.interrogoSession.findMany({
      where: { userId },
      include: {
        messages: {
          select: {
            role: true,
            content: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const recentSessions = sessions.filter((s) => new Date(s.createdAt) >= fourWeeksAgo && s.finalScore !== null);

    const weeklyBuckets = [0, 0, 0, 0].map(() => ({ count: 0, total: 0 }));
    const criterionWeeklyAcc = {};
    for (const s of recentSessions) {
      const diffDays = Math.floor((Date.now() - new Date(s.createdAt).getTime()) / (1000 * 60 * 60 * 24));
      const bucket = Math.min(3, Math.floor(diffDays / 7));
      weeklyBuckets[bucket].count += 1;
      weeklyBuckets[bucket].total += Number(s.finalScore || 0);

      if (s.finalFeedback) {
        try {
          const parsed = JSON.parse(s.finalFeedback);
          for (const c of parsed?.rubric?.criteria || []) {
            if (!c?.key || typeof c?.score !== 'number') continue;
            if (!criterionWeeklyAcc[c.key]) {
              criterionWeeklyAcc[c.key] = {
                key: c.key,
                label: c.label || c.key,
                buckets: [0, 0, 0, 0].map(() => ({ total: 0, count: 0 })),
              };
            }
            criterionWeeklyAcc[c.key].buckets[bucket].total += c.score;
            criterionWeeklyAcc[c.key].buckets[bucket].count += 1;
          }
        } catch {
          // ignore malformed feedback
        }
      }
    }

    const weeklyTrend = weeklyBuckets
      .map((b, idx) => ({
        weekIndex: idx + 1,
        avgScore: b.count > 0 ? parseFloat((b.total / b.count).toFixed(1)) : null,
      }))
      .reverse();

    const competencyTimeline = Object.values(criterionWeeklyAcc)
      .map((entry) => ({
        key: entry.key,
        label: entry.label,
        weeklyScores: entry.buckets
          .map((b) => (b.count > 0 ? parseFloat((b.total / b.count).toFixed(1)) : null))
          .reverse(),
      }))
      .sort((a, b) => {
        const aLast = a.weeklyScores[a.weeklyScores.length - 1] ?? 0;
        const bLast = b.weeklyScores[b.weeklyScores.length - 1] ?? 0;
        return aLast - bLast;
      });

    const topicAgg = {};
    let totalDontKnow = 0;
    let totalAnswers = 0;
    let totalResponseTimeMs = 0;
    let responseTimeSamples = 0;

    for (const s of sessions) {
      const topicKey = normalizeTopicKey(s.topic);
      if (!topicAgg[topicKey]) {
        topicAgg[topicKey] = {
          topic: s.topic,
          exams: 0,
          totalScore: 0,
          scoreCount: 0,
          weakestCriterion: null,
          weakestCriterionAvg: null,
          criterionAcc: {},
        };
      }

      topicAgg[topicKey].exams += 1;
      if (s.finalScore !== null) {
        topicAgg[topicKey].totalScore += Number(s.finalScore);
        topicAgg[topicKey].scoreCount += 1;
      }

      for (let i = 0; i < s.messages.length; i++) {
        const msg = s.messages[i];
        if (msg.role !== 'student') continue;
        totalAnswers += 1;
        if (/non lo so|boh|non ricordo|non saprei/i.test(msg.content || '')) totalDontKnow += 1;

        const nextTeacher = s.messages.slice(i + 1).find((m) => m.role === 'teacher');
        if (nextTeacher) {
          const delta = new Date(nextTeacher.createdAt).getTime() - new Date(msg.createdAt).getTime();
          if (delta >= 0) {
            totalResponseTimeMs += delta;
            responseTimeSamples += 1;
          }
        }
      }

      if (s.finalFeedback) {
        try {
          const parsed = JSON.parse(s.finalFeedback);
          for (const c of parsed?.rubric?.criteria || []) {
            if (!c?.key || typeof c?.score !== 'number') continue;
            if (!topicAgg[topicKey].criterionAcc[c.key]) {
              topicAgg[topicKey].criterionAcc[c.key] = { label: c.label || c.key, total: 0, count: 0 };
            }
            topicAgg[topicKey].criterionAcc[c.key].total += c.score;
            topicAgg[topicKey].criterionAcc[c.key].count += 1;
          }
        } catch {
          // ignore malformed feedback
        }
      }
    }

    const weakTopics = Object.values(topicAgg)
      .map((topic) => {
        const criteria = Object.values(topic.criterionAcc).map((acc) => ({
          label: acc.label,
          avg: acc.count > 0 ? acc.total / acc.count : null,
        })).filter((c) => c.avg !== null);

        const weakest = criteria.sort((a, b) => a.avg - b.avg)[0] || null;
        return {
          topic: topic.topic,
          exams: topic.exams,
          avgScore: topic.scoreCount > 0 ? parseFloat((topic.totalScore / topic.scoreCount).toFixed(1)) : null,
          weakestCriterion: weakest?.label || null,
          weakestCriterionAvg: weakest ? parseFloat(weakest.avg.toFixed(1)) : null,
        };
      })
      .sort((a, b) => (a.avgScore ?? 0) - (b.avgScore ?? 0));

    return res.json({
      weeklyTrend,
      competencyTimeline,
      weakTopics,
      kpis: {
        avgResponseTimeSeconds: responseTimeSamples > 0
          ? parseFloat((totalResponseTimeMs / responseTimeSamples / 1000).toFixed(1))
          : null,
        dontKnowRate: totalAnswers > 0 ? parseFloat((totalDontKnow / totalAnswers).toFixed(2)) : 0,
        answerCount: totalAnswers,
      },
    });
  } catch (error) {
    console.error('❌ Analytics overview error:', error);
    return res.status(500).json({ error: 'Failed to compute analytics overview' });
  }
});

// Tutor dashboard overview (B2School)
router.get('/teacher/overview', requireTutor, async (req, res) => {
  try {
    const sessions = await prisma.interrogoSession.findMany({
      include: {
        user: {
          select: {
            email: true,
            firstName: true,
            lastName: true,
            organization: true,
            className: true,
          },
        },
        messages: {
          select: {
            role: true,
            content: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const byClass = {};
    const studentMap = {};
    const topicMap = {};
    let totalAnswers = 0;
    let dontKnow = 0;

    for (const s of sessions) {
      const email = s.user?.email || 'unknown@student.local';
      const classLabel = s.user?.className || 'classe-non-assegnata';
      const organization = s.user?.organization || 'organizzazione-non-assegnata';
      const studentKey = email.toLowerCase();

      if (!byClass[classLabel]) {
        byClass[classLabel] = {
          className: classLabel,
          organization,
          sessions: 0,
          totalScore: 0,
          scoreCount: 0,
          students: new Set(),
        };
      }

      byClass[classLabel].sessions += 1;
      byClass[classLabel].students.add(studentKey);
      if (s.finalScore !== null) {
        byClass[classLabel].totalScore += Number(s.finalScore);
        byClass[classLabel].scoreCount += 1;
      }

      if (!studentMap[studentKey]) {
        studentMap[studentKey] = {
          studentEmail: email,
          studentName: [s.user?.firstName, s.user?.lastName].filter(Boolean).join(' ') || email,
          className: classLabel,
          organization,
          exams: 0,
          totalScore: 0,
          scoreCount: 0,
          dontKnowCount: 0,
          answerCount: 0,
        };
      }

      studentMap[studentKey].exams += 1;
      if (s.finalScore !== null) {
        studentMap[studentKey].totalScore += Number(s.finalScore);
        studentMap[studentKey].scoreCount += 1;
      }

      const topicKey = normalizeTopicKey(s.topic);
      if (!topicMap[topicKey]) {
        topicMap[topicKey] = { topic: s.topic, exams: 0, totalScore: 0, scoreCount: 0 };
      }
      topicMap[topicKey].exams += 1;
      if (s.finalScore !== null) {
        topicMap[topicKey].totalScore += Number(s.finalScore);
        topicMap[topicKey].scoreCount += 1;
      }

      for (const msg of s.messages || []) {
        if (msg.role !== 'student') continue;
        totalAnswers += 1;
        studentMap[studentKey].answerCount += 1;
        if (/non lo so|boh|non ricordo|non saprei/i.test(msg.content || '')) {
          dontKnow += 1;
          studentMap[studentKey].dontKnowCount += 1;
        }
      }
    }

    const classOverview = Object.values(byClass).map((c) => ({
      className: c.className,
      organization: c.organization,
      sessions: c.sessions,
      students: c.students.size,
      avgScore: c.scoreCount > 0 ? parseFloat((c.totalScore / c.scoreCount).toFixed(1)) : null,
    }));

    const students = Object.values(studentMap)
      .map((s) => ({
        ...s,
        avgScore: s.scoreCount > 0 ? parseFloat((s.totalScore / s.scoreCount).toFixed(1)) : null,
        dontKnowRate: s.answerCount > 0 ? parseFloat((s.dontKnowCount / s.answerCount).toFixed(2)) : 0,
      }))
      .sort((a, b) => (a.avgScore ?? 0) - (b.avgScore ?? 0));

    const weakTopics = Object.values(topicMap)
      .map((t) => ({
        topic: t.topic,
        exams: t.exams,
        avgScore: t.scoreCount > 0 ? parseFloat((t.totalScore / t.scoreCount).toFixed(1)) : null,
      }))
      .sort((a, b) => (a.avgScore ?? 0) - (b.avgScore ?? 0))
      .slice(0, 12);

    return res.json({
      classOverview,
      students,
      weakTopics,
      kpis: {
        totalStudents: students.length,
        totalSessions: sessions.length,
        dontKnowRate: totalAnswers > 0 ? parseFloat((dontKnow / totalAnswers).toFixed(2)) : 0,
      },
    });
  } catch (error) {
    console.error('❌ Teacher overview error:', error);
    return res.status(500).json({ error: 'Failed to compute teacher overview' });
  }
});

// Tutor export report CSV
router.get('/teacher/report.csv', requireTutor, async (req, res) => {
  try {
    const sessions = await prisma.interrogoSession.findMany({
      include: {
        user: {
          select: { email: true, firstName: true, lastName: true, organization: true, className: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const rows = sessions.map((s) => ({
      date: new Date(s.createdAt).toISOString(),
      studentEmail: s.user?.email || '',
      studentName: [s.user?.firstName, s.user?.lastName].filter(Boolean).join(' '),
      organization: s.user?.organization || '',
      className: s.user?.className || '',
      topic: s.topic,
      difficulty: s.difficulty,
      personality: s.personality,
      finalScore: s.finalScore ?? '',
      ended: s.endedAt ? 'yes' : 'no',
    }));

    const csv = toCsv(rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="teacher-report.csv"');
    return res.send(csv);
  } catch (error) {
    console.error('❌ Teacher CSV export error:', error);
    return res.status(500).json({ error: 'Failed to export teacher report' });
  }
});

// Get User Sessions
router.get('/list/all', async (req, res) => {
  try {
    const userId = req.userId;

    const sessions = await prisma.interrogoSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        messages: {
          select: {
            role: true,
          },
        },
        _count: {
          select: { messages: true },
        },
      },
    });

    const summarizedSessions = sessions.map((session) => {
      const studentAnswerCount = session.messages.filter((m) => m.role === 'student').length;
      const teacherQuestionCount = session.messages.filter((m) => m.role === 'teacher').length;

      return {
        id: session.id,
        topic: session.topic,
        difficulty: session.difficulty,
        personality: session.personality,
        finalScore: session.finalScore,
        finalFeedback: session.finalFeedback,
        createdAt: session.createdAt,
        endedAt: session.endedAt,
        studentAnswerCount,
        teacherQuestionCount,
        _count: session._count,
      };
    });

    res.json(summarizedSessions);
  } catch (error) {
    console.error('❌ List sessions error:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// Get Session Details
router.get('/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.userId;

    const session = await prisma.interrogoSession.findUnique({
      where: { id: sessionId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const feedback = session.finalFeedback ? JSON.parse(session.finalFeedback) : null;

    res.json({
      id: session.id,
      topic: session.topic,
      difficulty: session.difficulty,
      personality: session.personality,
      score: session.finalScore,
      feedback: feedback,
      messages: session.messages,
      createdAt: session.createdAt,
      endedAt: session.endedAt,
    });
  } catch (error) {
    console.error('❌ Get session error:', error);
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

export default router;
