import express from 'express';
import { PrismaClient } from '@prisma/client';
import { verifyToken } from '../middleware/auth.js';
import aiService from '../ai-service.js';
import { getBillingStatus } from '../billing-service.js';

const router = express.Router();
const prisma = new PrismaClient();

router.use(verifyToken);

// START QUICK TEST - 3 fast questions
router.post('/start', async (req, res) => {
  try {
    const { topic, personality = 'supportive' } = req.body;
    const userId = req.userId;

    if (!topic || topic.length < 3) {
      return res.status(400).json({ error: 'Topic is required' });
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

    // Create quick test session
    const session = await prisma.interrogoSession.create({
      data: {
        userId,
        topic,
        difficulty: 5,
        personality,
        contentPreview: 'QUICK TEST MODE - 3 questions only',
      },
    });

    // Generate first question for quick test
    const content = `Topic: ${topic}. This is a quick test with 3 questions on this topic.`;
    const conversationHistory = [
      { role: 'user', content: `Quick test: 3 questions on ${topic}. Question 1.` }
    ];

    const firstQuestion = await aiService.generateQuestion(
      content,
      conversationHistory,
      5,
      personality
    );

    await prisma.interrogoMessage.create({
      data: { sessionId: session.id, role: 'teacher', content: firstQuestion },
    });

    res.status(201).json({
      sessionId: session.id,
      topic,
      personality,
      firstQuestion,
      mode: 'QUICK_TEST',
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

// SEND ANSWER in quick test
router.post('/answer', async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    const userId = req.userId;

    if (!sessionId || !message) {
      return res.status(400).json({ error: 'Session and message required' });
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

    // Save student message
    const savedStudentMessage = await prisma.interrogoMessage.create({
      data: { sessionId, role: 'student', content: message },
    });

    const answerCount = session.messages.filter(m => m.role === 'student').length + 1;

    // Check if it's the last question
    if (answerCount >= 3) {
      // End test and provide quick evaluation
      const evaluationConversation = [
        ...session.messages.map(m => ({
          role: m.role === 'teacher' ? 'assistant' : 'user',
          content: m.content,
        })),
        { role: 'user', content: savedStudentMessage.content },
      ];

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
        totalQuestions: 3,
        answeredCount: answerCount,
        currentQuestion: 3,
        questionsRemaining: 0,
        score: evaluation.score,
        strengths: evaluation.strengths,
        weaknesses: evaluation.weaknesses,
        suggestions: evaluation.suggestions,
        message: 'Test completed!',
      });
    }

    // Generate next question
    const recentMessages = session.messages.slice(-8).map(m => ({
      role: m.role === 'teacher' ? 'assistant' : 'user',
      content: m.content,
    }));

    recentMessages.push({ role: 'user', content: savedStudentMessage.content });

    const teacherResponse = await aiService.generateQuestion(
      session.contentPreview || '',
      recentMessages,
      5,
      session.personality
    );

    await prisma.interrogoMessage.create({
      data: { sessionId, role: 'teacher', content: teacherResponse },
    });

    res.json({
      teacherResponse,
      totalQuestions: 3,
      answeredCount: answerCount,
      currentQuestion: answerCount + 1,
      questionsRemaining: Math.max(0, 3 - answerCount),
      isComplete: false,
    });
  } catch (error) {
    console.error('Quick test answer error:', error);
    res.status(500).json({ error: error.message || 'Failed to submit answer' });
  }
});

export default router;
