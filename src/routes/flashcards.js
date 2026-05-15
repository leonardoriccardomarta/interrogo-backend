import express from 'express';
import { PrismaClient } from '@prisma/client';
import { verifyToken } from '../middleware/auth.js';
import aiService from '../ai-service.js';

const router = express.Router();
const prisma = new PrismaClient();

const sanitizeContent = (text) => String(text || '').trim().slice(0, 12000);

const SUPPORTED_LOCALES = ['it', 'en', 'es', 'fr', 'de'];

router.use(verifyToken);

router.get('/decks', async (req, res) => {
  try {
    const decks = await prisma.flashcardDeck.findMany({
      where: { userId: req.userId },
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: { select: { cards: true } },
      },
    });

    res.json(
      decks.map((d) => ({
        id: d.id,
        title: d.title,
        sourceFile: d.sourceFile,
        locale: d.locale,
        cardCount: d._count.cards,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      }))
    );
  } catch (error) {
    console.error('Flashcard decks list error:', error);
    res.status(500).json({ error: 'Failed to load decks' });
  }
});

router.get('/decks/:deckId', async (req, res) => {
  try {
    const studyMode = req.query.study === 'true';
    const deck = await prisma.flashcardDeck.findFirst({
      where: { id: req.params.deckId, userId: req.userId },
      include: {
        cards: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!deck) {
      return res.status(404).json({ error: 'Deck not found' });
    }

    if (studyMode) {
      const now = new Date();
      const due = deck.cards
        .filter((c) => !c.nextReviewAt || c.nextReviewAt <= now)
        .sort((a, b) => (a.intervalDays ?? 0) - (b.intervalDays ?? 0));
      const later = deck.cards
        .filter((c) => c.nextReviewAt && c.nextReviewAt > now)
        .sort((a, b) => a.nextReviewAt - b.nextReviewAt);
      return res.json({
        ...deck,
        cards: [...due, ...later],
        dueCount: due.length,
      });
    }

    res.json(deck);
  } catch (error) {
    console.error('Flashcard deck fetch error:', error);
    res.status(500).json({ error: 'Failed to load deck' });
  }
});

router.post('/generate', async (req, res) => {
  try {
    const { title, content, sourceFile, locale: rawLocale, cardCount: rawCount } = req.body;
    const cleaned = sanitizeContent(content);

    if (!cleaned || cleaned.length < 80) {
      return res.status(400).json({ error: 'Content must be at least 80 characters' });
    }

    const locale = SUPPORTED_LOCALES.includes(rawLocale) ? rawLocale : 'it';
    const cardCount = Math.min(30, Math.max(8, Number(rawCount) || 15));
    const deckTitle = String(title || '').trim() || 'Study deck';

    const generated = await aiService.generateFlashcards(cleaned, locale, cardCount);

    const deck = await prisma.flashcardDeck.create({
      data: {
        userId: req.userId,
        title: deckTitle,
        sourceFile: sourceFile ? String(sourceFile).slice(0, 200) : null,
        locale,
        cardCount: generated.length,
        cards: {
          create: generated.map((card) => ({
            front: card.front,
            back: card.back,
            chapter: card.chapter || null,
            difficulty: card.difficulty || 5,
          })),
        },
      },
      include: { cards: true },
    });

    res.status(201).json(deck);
  } catch (error) {
    console.error('Flashcard generate error:', error);
    if (error.message?.includes('Rate limited')) {
      return res.status(429).json({ error: error.message });
    }
    res.status(500).json({ error: error.message || 'Failed to generate flashcards' });
  }
});

router.post('/decks/:deckId/review', async (req, res) => {
  try {
    const { cardId, known } = req.body;

    const deck = await prisma.flashcardDeck.findFirst({
      where: { id: req.params.deckId, userId: req.userId },
    });

    if (!deck) {
      return res.status(404).json({ error: 'Deck not found' });
    }

    const card = await prisma.flashcard.findFirst({
      where: { id: cardId, deckId: deck.id },
    });

    if (!card) {
      return res.status(404).json({ error: 'Card not found' });
    }

    let intervalDays = card.intervalDays ?? 0;
    let easeFactor = card.easeFactor ?? 2.5;

    if (known) {
      if (intervalDays === 0) intervalDays = 1;
      else intervalDays = Math.min(60, Math.max(1, Math.round(intervalDays * easeFactor)));
      easeFactor = Math.min(3, easeFactor + 0.1);
    } else {
      intervalDays = 1;
      easeFactor = Math.max(1.3, easeFactor - 0.2);
    }

    const nextReviewAt = new Date();
    nextReviewAt.setUTCDate(nextReviewAt.getUTCDate() + intervalDays);

    const updated = await prisma.flashcard.update({
      where: { id: card.id },
      data: {
        timesSeen: { increment: 1 },
        timesKnown: known ? { increment: 1 } : undefined,
        intervalDays,
        easeFactor,
        nextReviewAt,
        lastReviewed: new Date(),
      },
    });

    res.json(updated);
  } catch (error) {
    console.error('Flashcard review error:', error);
    res.status(500).json({ error: 'Failed to update card' });
  }
});

router.delete('/decks/:deckId', async (req, res) => {
  try {
    const deck = await prisma.flashcardDeck.findFirst({
      where: { id: req.params.deckId, userId: req.userId },
    });

    if (!deck) {
      return res.status(404).json({ error: 'Deck not found' });
    }

    await prisma.flashcardDeck.delete({ where: { id: deck.id } });
    res.json({ ok: true });
  } catch (error) {
    console.error('Flashcard delete error:', error);
    res.status(500).json({ error: 'Failed to delete deck' });
  }
});

export default router;
