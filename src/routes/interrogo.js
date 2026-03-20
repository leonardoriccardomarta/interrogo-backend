import express from 'express';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { verifyToken } from '../middleware/auth.js';
import aiService from '../ai-service.js';

const router = express.Router();
const prisma = new PrismaClient();

const getTargetQuestionsFromDifficulty = (difficulty) => {
  if (difficulty <= 3) return 3;
  if (difficulty <= 7) return 4;
  return 5;
};

const isWeakAnswer = (text) => {
  return text.trim().length < 24 || /non lo so|boh|non ricordo|non saprei/i.test(text);
};

const normalizeTopicKey = (topic) => (topic || '').trim().toLowerCase();

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
    const { topic, difficulty, personality, content } = req.body;
    const userId = req.userId;

    // Validation
    if (!topic || !content) {
      return res.status(400).json({ error: 'Argomento e contenuto sono richiesti' });
    }

    if (!difficulty || difficulty < 1 || difficulty > 10) {
      return res.status(400).json({ error: 'Difficoltà deve essere tra 1 e 10' });
    }

    if (!["strict", "supportive"].includes(personality)) {
      return res.status(400).json({ error: 'Personalità deve essere "strict" o "supportive"' });
    }

    if (content.length < 10) {
      return res.status(400).json({ error: 'Contenuto deve essere almeno 10 caratteri' });
    }

    // Truncate content preview
    const contentPreview = content.substring(0, 500);

    // Create session
    const session = await prisma.interrogoSession.create({
      data: {
        userId,
        topic,
        difficulty,
        personality,
        contentPreview,
      },
    });

    // Generate first question
    const conversationHistory = [
      {
        role: 'user',
        content: `Inizia le interrogazioni su questo argomento: ${topic}. Prima domanda.`,
      },
    ];

    const firstQuestion = await aiService.generateQuestion(
      content,
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
      targetQuestions: getTargetQuestionsFromDifficulty(session.difficulty),
      firstQuestion: firstQuestion,
    });
  } catch (error) {
    console.error('❌ Errore avvio sessione:', error);
    
    if (error.message.includes('Rate limited')) {
      return res.status(429).json({ error: error.message });
    }

    res.status(500).json({ error: error.message || 'Errore nell\'avvio della sessione' });
  }
});

// Send Message (user answer)
router.post('/message', async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    const userId = req.userId;

    // Validation
    if (!sessionId || !message) {
      return res.status(400).json({ error: 'Session ID and message are required' });
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
        content: message,
      },
    });

    const targetQuestions = getTargetQuestionsFromDifficulty(session.difficulty);
    const teacherQuestionCount = session.messages.filter((m) => m.role === 'teacher').length;

    // Convert messages to conversation format and include current answer
    const evaluationConversation = [
      ...session.messages.map((m) => ({
        role: m.role === 'teacher' ? 'assistant' : 'user',
        content: m.content,
      })),
      {
        role: 'user',
        content: message,
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
        message: 'Interrogazione completata.',
      });
    }

    const weakAnswer = isWeakAnswer(message);
    const adaptiveMessage = weakAnswer
      ? `${message}\n\n[Nota didattica: la risposta è incompleta. Fai una domanda di recupero guidata e poi verifica la comprensione.]`
      : message;

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
    const teacherResponse = await aiService.generateQuestion(
      session.contentPreview || '',
      recentMessages,
      session.difficulty,
      session.personality
    );

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
      studentMessage: message,
      teacherResponse: teacherResponse,
      targetQuestions,
      currentQuestion: teacherQuestionCount + 1,
      questionsRemaining: Math.max(0, targetQuestions - teacherQuestionCount),
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

    const teacherMessage = `Capisco. Ti aiuto io: ${explanation}`;

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
    for (const s of recentSessions) {
      const diffDays = Math.floor((Date.now() - new Date(s.createdAt).getTime()) / (1000 * 60 * 60 * 24));
      const bucket = Math.min(3, Math.floor(diffDays / 7));
      weeklyBuckets[bucket].count += 1;
      weeklyBuckets[bucket].total += Number(s.finalScore || 0);
    }

    const weeklyTrend = weeklyBuckets
      .map((b, idx) => ({
        weekIndex: idx + 1,
        avgScore: b.count > 0 ? parseFloat((b.total / b.count).toFixed(1)) : null,
      }))
      .reverse();

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
