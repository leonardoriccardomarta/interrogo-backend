import express from 'express';
import aiService from '../ai-service.js';

const router = express.Router();

const sanitizeText = (value, maxLength = 800) => String(value || '')
  .replace(/\r/g, '')
  .replace(/\t/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maxLength);

const sanitizeHistory = (history) => {
  if (!Array.isArray(history)) return [];

  return history
    .slice(-12)
    .map((item) => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: sanitizeText(item?.content || '', 500),
    }))
    .filter((item) => item.content.length > 0);
};

router.post('/chatbot', async (req, res) => {
  try {
    const message = sanitizeText(req.body?.message || '', 800);
    const locale = sanitizeText(req.body?.locale || 'en', 20).toLowerCase();
    const history = sanitizeHistory(req.body?.history);

    if (!message || message.length < 2) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const reply = await aiService.generateLandingAssistantReply({
      message,
      history,
      locale,
    });

    return res.json({
      reply,
      locale,
    });
  } catch (error) {
    console.error('Public chatbot error:', error.message);

    if (error.message?.includes('not configured')) {
      return res.status(503).json({ error: 'Chat assistant is not configured' });
    }

    if (error.message?.includes('Rate limited')) {
      return res.status(429).json({ error: error.message });
    }

    return res.status(500).json({ error: 'Failed to get assistant response' });
  }
});

export default router;
