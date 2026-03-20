import express from 'express';
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

    const isWeakAnswer = message.trim().length < 24 || /non lo so|boh|non ricordo|non saprei/i.test(message);
    const adaptiveMessage = isWeakAnswer
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
