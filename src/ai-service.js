import axios from 'axios';

const DONT_KNOW_REGEX = /\b(i\s*don'?t\s*know|i\s*do\s*not\s*know|not\s*sure|non\s*lo\s*so|boh|non\s*ricordo|non\s*saprei)\b/i;

export class InterrogoAIService {
  constructor() {
    this.groqApiKey = process.env.GROQ_API_KEY;
    this.groqBaseUrl = 'https://api.groq.com/openai/v1';
    
    if (!this.groqApiKey) {
      console.error('❌ GROQ_API_KEY not configured');
    } else {
      console.log('✅ Groq AI Service initialized');
    }
  }

  buildSystemPrompt(personality, content) {
    const basePrompt = `You are a real teacher conducting oral exams.
ESSENTIAL ROLE:
- Ask one question at a time
- If an answer is weak/superficial, insist with follow-up questions
- If an answer is good, acknowledge it and deepen with related concepts
- Adapt REAL difficulty based on performance
- Max 150 words per response
- Always respond in English
- Sound like a real teacher, not a chatbot
- STRICT GROUNDING: use ONLY the provided material; avoid disconnected or generic questions
- When possible, cite source references like "[p.X]" when present

SOURCE MATERIAL:
${content}

REALISTIC BEHAVIOR:
- Challenge vague answers: "Explain better", "What do you mean by..."
- Reward precise answers: "Exactly. Now tell me..."
- Focus on understanding, not memorization
- If a topic is NOT in the material, state it clearly and stay within scope`;

    let personalityModifier;
    if (personality === 'strict') {
      personalityModifier = '\n\nTEACHER STYLE - STRICT (😤):\n- High expectations\n- Correct errors immediately\n- Use language like "Imprecise", "Too generic", "Go deeper"\n- Demanding but fair tone\n- Do not accept vague answers';
    } else if (personality === 'socratic') {
      personalityModifier = '\n\nTEACHER STYLE - SOCRATIC (🧠):\n- Do not give the solution immediately\n- Guide with progressive questions\n- Surface cause-effect reasoning\n- If the student is blocked, break it into micro-steps\n- Keep a calm but intellectually stimulating tone';
    } else {
      personalityModifier = '\n\nTEACHER STYLE - SUPPORTIVE (😊):\n- Help the student find the answer\n- Use language like "Good, keep going", "Exactly, now..."\n- Explain difficult concepts clearly\n- Patient and supportive tone\n- Build a positive, constructive environment';
    }

    return basePrompt + personalityModifier;
  }

  async generateQuestion(content, conversationHistory, difficulty, personality) {
    if (!this.groqApiKey) {
      throw new Error('Groq API key not configured');
    }

    try {
      const systemPrompt = this.buildSystemPrompt(personality, content);
      
      const messages = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
      ];

      const response = await axios.post(
        `${this.groqBaseUrl}/chat/completions`,
        {
          model: 'llama-3.1-8b-instant',
          messages: messages,
          max_tokens: 500,
          temperature: 0.5 + (difficulty - 5) * 0.05,
          top_p: 0.9,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.groqApiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      const aiResponse = response.data.choices[0]?.message?.content;
      
      if (!aiResponse) {
        throw new Error('Empty response from Groq');
      }

      return aiResponse;
    } catch (error) {
      console.error('❌ Groq Question Generation Error:', {
        message: error.message,
        status: error.response?.status,
      });

      if (error.response?.status === 429) {
        throw new Error('Rate limited by Groq API. Please try again in a moment.');
      }

      throw new Error(`Failed to generate question: ${error.message}`);
    }
  }

  async explainConcept(topic, content, personality) {
    if (!this.groqApiKey) {
      throw new Error('Groq API key not configured');
    }

    try {
      const systemPrompt = `You are a teacher who explains concepts in a simple and clear way.
    Topic: ${topic}
    Reference material: ${content}

    Provide a SHORT explanation (3-4 sentences) that is easy to understand.
    English only.
    ${personality === 'strict' ? 'Use a formal and precise tone.' : 'Use a friendly and encouraging tone.'}`;

      const response = await axios.post(
        `${this.groqBaseUrl}/chat/completions`,
        {
          model: 'llama-3.1-8b-instant',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Explain ${topic}` },
          ],
          max_tokens: 300,
          temperature: 0.4,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.groqApiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      return response.data.choices[0]?.message?.content || 'Concept explained.';
    } catch (error) {
      console.error('❌ Groq Concept Explanation Error:', error.message);
      throw new Error(`Failed to explain concept: ${error.message}`);
    }
  }

  async generateLandingAssistantReply({ message, history = [], locale = 'en' }) {
    if (!this.groqApiKey) {
      throw new Error('Groq API key not configured');
    }

    const cleanHistory = Array.isArray(history)
      ? history
          .slice(-10)
          .map((item) => ({
            role: item?.role === 'assistant' ? 'assistant' : 'user',
            content: String(item?.content || '').slice(0, 500),
          }))
          .filter((item) => item.content.trim().length > 0)
      : [];

    const systemPrompt = `You are Interrogo's landing page assistant.
Your goal is conversion and clarity for a pre-revenue SaaS sale demo.
Rules:
- Reply in the same language as the user message. Locale hint: ${locale}.
- Keep answers concise (max 120 words) and practical.
- Mention only true app capabilities: oral exam simulations, standard/extended/deep modes, quick tests, analytics, free vs pro plan, dashboard billing, multilingual interaction.
- If user asks for demo/tutorial, provide a short 3-step flow.
- If user asks about pricing, state: Free plan with monthly cap and Pro at 9.99 EUR/month.
- Never invent unsupported integrations or guarantees.
- Tone: confident, modern, helpful.`;

    try {
      const response = await axios.post(
        `${this.groqBaseUrl}/chat/completions`,
        {
          model: 'llama-3.1-8b-instant',
          messages: [
            { role: 'system', content: systemPrompt },
            ...cleanHistory,
            { role: 'user', content: String(message || '').slice(0, 800) },
          ],
          max_tokens: 280,
          temperature: 0.45,
          top_p: 0.9,
        },
        {
          headers: {
            Authorization: `Bearer ${this.groqApiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      const reply = response.data?.choices?.[0]?.message?.content;
      if (!reply) {
        throw new Error('Empty response from Groq');
      }

      return String(reply).trim();
    } catch (error) {
      console.error('❌ Groq Landing Assistant Error:', {
        message: error.message,
        status: error.response?.status,
      });

      if (error.response?.status === 429) {
        throw new Error('Rate limited by Groq API. Please try again in a moment.');
      }

      throw new Error(`Failed to generate landing assistant reply: ${error.message}`);
    }
  }

  async evaluateSession(content, conversationHistory, personality) {
    if (!this.groqApiKey) {
      throw new Error('Groq API key not configured');
    }

    try {
      const evaluationPrompt = `You are an expert teacher. Evaluate this oral exam and respond ONLY with valid JSON.

MATERIAL: ${content}

CONVERSATION:
${conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n')}

Respond with ONLY this JSON (nothing else):
{
  "score": 0,
  "rubric": {
    "criteria": [
      {"key": "accuracy", "label": "Accuracy", "weight": 0.3, "score": 0, "evidence": "", "reason": ""},
      {"key": "completeness", "label": "Completeness", "weight": 0.25, "score": 0, "evidence": "", "reason": ""},
      {"key": "terminology", "label": "Subject terminology", "weight": 0.2, "score": 0, "evidence": "", "reason": ""},
      {"key": "connections", "label": "Connections", "weight": 0.15, "score": 0, "evidence": "", "reason": ""},
      {"key": "delivery", "label": "Delivery", "weight": 0.1, "score": 0, "evidence": "", "reason": ""}
    ]
  },
  "strengths": ["...", "..."],
  "weaknesses": ["...", "..."],
  "suggestions": ["...", "..."],
  "studyPlan": ["...", "...", "..."]
}

Important rules:
- score from 0 to 10 with one decimal
- "evidence" must cite real textual examples from the conversation
- "reason" must explain the score in one sentence
- weights must sum to 1.0
- if data is missing, be conservative and do not invent.
- evaluate ONLY within the provided material scope: no external knowledge.`;

      const response = await axios.post(
        `${this.groqBaseUrl}/chat/completions`,
        {
          model: 'llama-3.1-8b-instant',
          messages: [
            {
              role: 'system',
              content: 'You are an expert teacher. Respond ONLY with valid JSON.',
            },
            {
              role: 'user',
              content: evaluationPrompt,
            },
          ],
          max_tokens: 500,
          temperature: 0.3,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.groqApiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      const responseText = response.data.choices[0]?.message?.content;

      if (!responseText) {
        throw new Error('Empty response from Groq evaluation');
      }

      try {
        const jsonText = this.extractJsonObject(responseText);
        const evaluation = JSON.parse(jsonText);
        return this.normalizeEvaluation(evaluation, content, conversationHistory);
      } catch (parseError) {
        console.error('Failed to parse evaluation JSON:', responseText);
        return this.buildFallbackEvaluation(content, conversationHistory);
      }
    } catch (error) {
      console.error('❌ Groq Evaluation Error:', error.message);

      if (error.response?.status === 429) {
        throw new Error('Rate limited by Groq API. Please try again in a moment.');
      }

      throw new Error(`Failed to evaluate session: ${error.message}`);
    }
  }

  extractJsonObject(text) {
    const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fencedMatch?.[1]) {
      return fencedMatch[1].trim();
    }

    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      return text.slice(first, last + 1);
    }

    return text;
  }

  computeHeuristicScore(conversationHistory) {
    const studentMessages = conversationHistory.filter((m) => m.role === 'user');
    if (studentMessages.length === 0) {
      return 4;
    }

    const avgLength = studentMessages.reduce((acc, m) => acc + m.content.length, 0) / studentMessages.length;
    const dontKnowCount = studentMessages.filter((m) => DONT_KNOW_REGEX.test(m.content)).length;
    const dontKnowPenalty = Math.min(2, dontKnowCount * 0.5);

    let base = 5.5;
    if (avgLength > 220) base += 2.2;
    else if (avgLength > 120) base += 1.4;
    else if (avgLength > 60) base += 0.8;
    else if (avgLength < 30) base -= 0.8;

    const score = Math.max(3, Math.min(9.5, base - dontKnowPenalty));
    return parseFloat(score.toFixed(1));
  }

  getDefaultCriteria() {
    return [
      { key: 'accuracy', label: 'Accuracy', weight: 0.3, score: 0, evidence: '', reason: '' },
      { key: 'completeness', label: 'Completeness', weight: 0.25, score: 0, evidence: '', reason: '' },
      { key: 'terminology', label: 'Subject terminology', weight: 0.2, score: 0, evidence: '', reason: '' },
      { key: 'connections', label: 'Connections', weight: 0.15, score: 0, evidence: '', reason: '' },
      { key: 'delivery', label: 'Delivery', weight: 0.1, score: 0, evidence: '', reason: '' },
    ];
  }

  computeKpis(conversationHistory) {
    const studentMessages = conversationHistory.filter((m) => m.role === 'user');
    const answerCount = studentMessages.length;
    const dontKnowCount = studentMessages.filter((m) => DONT_KNOW_REGEX.test(m.content)).length;
    const avgAnswerLength = answerCount > 0
      ? Math.round(studentMessages.reduce((acc, m) => acc + m.content.length, 0) / answerCount)
      : 0;

    return {
      answerCount,
      dontKnowRate: answerCount > 0 ? parseFloat((dontKnowCount / answerCount).toFixed(2)) : 0,
      avgAnswerLength,
    };
  }

  tokenize(text) {
    return String(text || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 4);
  }

  getStopwords() {
    return new Set([
      'della', 'delle', 'degli', 'dallo', 'dalla', 'dalle', 'dello',
      'questo', 'questa', 'questi', 'quella', 'quello', 'quindi', 'perche',
      'sono', 'dopo', 'prima', 'come', 'anche', 'molto', 'stato', 'stati',
      'dove', 'quando', 'dentro', 'fuori', 'avere', 'essere', 'fatto', 'fatti',
      'sulla', 'sulle', 'negli', 'nelle', 'dunque', 'oppure', 'allora',
      'materiale', 'argomento', 'domanda', 'risposta',
    ]);
  }

  buildSourceLexicon(content) {
    const stopwords = this.getStopwords();
    const freq = new Map();
    for (const token of this.tokenize(content)) {
      if (stopwords.has(token)) continue;
      freq.set(token, (freq.get(token) || 0) + 1);
    }

    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 250)
      .map(([token]) => token);
  }

  computeGroundingMetrics(content, conversationHistory) {
    const lexicon = new Set(this.buildSourceLexicon(content));
    const studentMessages = conversationHistory.filter((m) => m.role === 'user');

    let tokensTotal = 0;
    let tokensInSource = 0;

    for (const msg of studentMessages) {
      const tokens = this.tokenize(msg.content);
      tokensTotal += tokens.length;
      for (const token of tokens) {
        if (lexicon.has(token)) tokensInSource += 1;
      }
    }

    const sourceCoverageRate = tokensTotal > 0 ? tokensInSource / tokensTotal : 0;
    const dontKnowCount = studentMessages.filter((m) => DONT_KNOW_REGEX.test(m.content)).length;

    return {
      sourceCoverageRate: parseFloat(sourceCoverageRate.toFixed(3)),
      answerCount: studentMessages.length,
      dontKnowCount,
    };
  }

  applyGroundingAdjustments(evaluation, content, conversationHistory) {
    const grounded = { ...evaluation, rubric: { criteria: [...(evaluation?.rubric?.criteria || [])] } };
    const metrics = this.computeGroundingMetrics(content, conversationHistory);

    const adjustCriteria = (delta) => {
      grounded.rubric.criteria = grounded.rubric.criteria.map((c) => {
        const shouldAdjust = ['accuracy', 'completeness', 'connections'].includes(c.key);
        if (!shouldAdjust) return c;
        const score = Math.max(0, Math.min(10, c.score + delta));
        return { ...c, score: parseFloat(score.toFixed(1)) };
      });
    };

    if (metrics.sourceCoverageRate < 0.2) {
      adjustCriteria(-1.3);
      grounded.weaknesses = Array.from(new Set([
        ...(grounded.weaknesses || []),
        'Your answers are weakly grounded in the selected material.',
      ]));
      grounded.suggestions = Array.from(new Set([
        ...(grounded.suggestions || []),
        'Cite definitions and source passages from the PDF/text while answering.',
      ]));
    } else if (metrics.sourceCoverageRate > 0.38) {
      adjustCriteria(0.5);
      grounded.strengths = Array.from(new Set([
        ...(grounded.strengths || []),
        'Great grounding in the provided source material.',
      ]));
    }

    const weightedScore = grounded.rubric.criteria.reduce((acc, c) => acc + c.score * c.weight, 0);
    grounded.score = parseFloat(Math.max(0, Math.min(10, weightedScore)).toFixed(1));

    grounded.kpis = {
      ...(grounded.kpis || {}),
      ...this.computeKpis(conversationHistory),
      sourceCoverageRate: metrics.sourceCoverageRate,
    };

    return grounded;
  }

  normalizeEvaluation(rawEvaluation, content, conversationHistory) {
    const baseCriteria = this.getDefaultCriteria();
    const criteriaFromModel = rawEvaluation?.rubric?.criteria || [];

    const normalizedCriteria = baseCriteria.map((base) => {
      const fromModel = criteriaFromModel.find((c) => c?.key === base.key) || {};
      const score = Math.min(10, Math.max(0, Number(fromModel.score ?? rawEvaluation?.score ?? 6)));

      return {
        ...base,
        score: parseFloat(score.toFixed(1)),
        evidence: String(fromModel.evidence || 'Limited textual evidence available.'),
        reason: String(fromModel.reason || 'Overall performance aligns with the detected level.'),
      };
    });

    const weightedScore = normalizedCriteria.reduce((acc, c) => acc + c.score * c.weight, 0);
    const boundedScore = Math.min(10, Math.max(0, Number(rawEvaluation?.score ?? weightedScore)));

    const baseEvaluation = {
      score: parseFloat(boundedScore.toFixed(1)),
      rubric: {
        criteria: normalizedCriteria,
      },
      strengths: rawEvaluation?.strengths || ['Active participation during the oral exam.'],
      weaknesses: rawEvaluation?.weaknesses || ['Some answers need more depth and precision.'],
      suggestions: rawEvaluation?.suggestions || ['Review key concepts using concrete examples.'],
      studyPlan: rawEvaluation?.studyPlan || [
        'Review core concepts in focused 20-minute blocks.',
        'Practice with 5 oral questions on definitions and connections.',
        'Rephrase answers aloud with more precision.',
      ],
      kpis: this.computeKpis(conversationHistory),
    };

    return this.applyGroundingAdjustments(baseEvaluation, content, conversationHistory);
  }

  buildFallbackEvaluation(content, conversationHistory) {
    const baseScore = this.computeHeuristicScore(conversationHistory);
    const criteria = this.getDefaultCriteria().map((c, idx) => ({
      ...c,
      score: parseFloat(Math.max(3, Math.min(9.5, baseScore + (idx === 0 ? 0.3 : idx === 1 ? 0.1 : -0.1))).toFixed(1)),
      evidence: 'Fallback evaluation based on average answer quality.',
      reason: 'Model did not return valid JSON, so a heuristic fallback was applied.',
    }));

    const fallback = {
      score: baseScore,
      rubric: { criteria },
      strengths: ['Participated consistently in the exam.'],
      weaknesses: ['Some areas still need deeper understanding.'],
      suggestions: ['Re-read the material and answer with more detail.'],
      studyPlan: [
        'Targeted review on the weak points identified.',
        'Practice open questions with concrete examples.',
        'Run a final mini oral test to validate progress.',
      ],
      kpis: this.computeKpis(conversationHistory),
    };

    return this.applyGroundingAdjustments(fallback, content, conversationHistory);
  }
}

export default new InterrogoAIService();
