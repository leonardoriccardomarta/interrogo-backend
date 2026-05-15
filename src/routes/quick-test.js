import express from 'express';
import { PrismaClient } from '@prisma/client';
import { verifyToken } from '../middleware/auth.js';
import aiService from '../ai-service.js';
import { getBillingStatus } from '../billing-service.js';

const router = express.Router();
const prisma = new PrismaClient();

const sanitizeInput = (text) => String(text || '')
  .replace(/\r/g, '')
  .split('\n')
  .map((line) => line.replace(/[ \t]+/g, ' ').trim())
  .filter(Boolean)
  .join('\n');

const SUPPORTED_LOCALES = ['it', 'en', 'es', 'fr', 'de'];

function serializeMcq(mcq) {
  return JSON.stringify(mcq);
}

function parseMcqMessage(content) {
  try {
    const parsed = JSON.parse(content);
    if (parsed?.type === 'mcq') return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

router.use(verifyToken);

// START QUICK TEST - 3 MCQ questions
router.post('/start', async (req, res) => {
  try {
    const { topic, personality = 'supportive', locale: rawLocale } = req.body;
    const userId = req.userId;
    const cleanedTopic = sanitizeInput(topic).slice(0, 160);
    const locale = SUPPORTED_LOCALES.includes(rawLocale) ? rawLocale : 'it';

    if (!cleanedTopic || cleanedTopic.length < 3) {
      return res.status(400).json({ error: 'Topic is required' });
    }

    if (!['strict', 'supportive', 'socratic'].includes(personality)) {
      return res.status(400).json({ error: 'Personality must be "strict", "supportive", or "socratic"' });
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
          createdAt: { gte: monthStart },
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

    const material = `Quiz topic: ${cleanedTopic}. Focus on key definitions, causes, relationships, and applications.`;

    const session = await prisma.interrogoSession.create({
      data: {
        userId,
        topic: cleanedTopic,
        difficulty: 5,
        personality,
        locale,
        contentPreview: `QUICK_TEST_MCQ - 3 multiple-choice questions. Topic: ${cleanedTopic}`,
      },
    });

    const mcq = await aiService.generateMcqQuestion(
      material,
      cleanedTopic,
      1,
      3,
      locale,
      personality
    );

    const payload = serializeMcq(mcq);

    await prisma.interrogoMessage.create({
      data: { sessionId: session.id, role: 'teacher', content: payload },
    });

    res.status(201).json({
      sessionId: session.id,
      topic: cleanedTopic,
      personality,
      firstQuestion: mcq,
      mcq,
      mode: 'QUICK_TEST',
      format: 'mcq',
      totalQuestions: 3,
      answeredCount: 0,
      currentQuestion: 1,
      questionsRemaining: 3,
    });
  } catch (error) {
    console.error('Quick test error:', error);
    res.status(500).json({ error: error.message || 'Failed to start quick test' });
  }
});

// SEND ANSWER in quick test (MCQ: selectedIndex 0-3)
router.post('/answer', async (req, res) => {
  try {
    const { sessionId, message, selectedIndex } = req.body;
    const userId = req.userId;
    const cleanedMessage = sanitizeInput(message);

    if (!sessionId) {
      return res.status(400).json({ error: 'Session required' });
    }

    const session = await prisma.interrogoSession.findUnique({
      where: { id: sessionId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });

    if (!session || session.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (session.endedAt) {
      return res.status(400).json({ error: 'Session has already ended' });
    }

    const lastTeacher = [...session.messages].reverse().find((m) => m.role === 'teacher');
    const lastMcq = lastTeacher ? parseMcqMessage(lastTeacher.content) : null;

    let studentContent = cleanedMessage;
    if (lastMcq && typeof selectedIndex === 'number') {
      const idx = Math.max(0, Math.min(3, selectedIndex));
      const chosen = lastMcq.options[idx] || '';
      const isCorrect = idx === lastMcq.correctIndex;
      studentContent = `[MCQ] ${chosen} (${isCorrect ? 'correct' : 'wrong'})`;
    } else if (!cleanedMessage) {
      return res.status(400).json({ error: 'Answer required' });
    }

    const savedStudentMessage = await prisma.interrogoMessage.create({
      data: { sessionId, role: 'student', content: studentContent },
    });

    const answerCount = session.messages.filter((m) => m.role === 'student').length + 1;

    if (answerCount >= 3) {
      const evaluationConversation = [
        ...session.messages.map((m) => ({
          role: m.role === 'teacher' ? 'assistant' : 'user',
          content: m.content,
        })),
        { role: 'user', content: savedStudentMessage.content },
      ];

      const evaluation = await aiService.evaluateSession(
        session.contentPreview || `Quick test: ${session.topic}`,
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
        totalQuestions: 3,
        answeredCount: answerCount,
        currentQuestion: 3,
        questionsRemaining: 0,
        score: evaluation.score,
        strengths: evaluation.strengths,
        weaknesses: evaluation.weaknesses,
        suggestions: evaluation.suggestions,
        studyPlan: evaluation.studyPlan,
        rubric: evaluation.rubric,
        message: 'Test completed!',
      });
    }

    const mcq = await aiService.generateMcqQuestion(
      session.contentPreview || session.topic,
      session.topic,
      answerCount + 1,
      3,
      session.locale || 'it',
      session.personality
    );

    const payload = serializeMcq(mcq);

    await prisma.interrogoMessage.create({
      data: { sessionId, role: 'teacher', content: payload },
    });

    res.json({
      teacherResponse: payload,
      mcq,
      totalQuestions: 3,
      answeredCount: answerCount,
      currentQuestion: answerCount + 1,
      questionsRemaining: Math.max(0, 3 - answerCount),
      isComplete: false,
      lastAnswerCorrect:
        lastMcq && typeof selectedIndex === 'number'
          ? selectedIndex === lastMcq.correctIndex
          : undefined,
      explanation: lastMcq?.explanation,
    });
  } catch (error) {
    console.error('Quick test answer error:', error);
    res.status(500).json({ error: error.message || 'Failed to submit answer' });
  }
});

export default router;
