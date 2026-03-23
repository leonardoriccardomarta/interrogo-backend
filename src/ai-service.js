import axios from 'axios';

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
    const basePrompt = `Tu sei un vero professore italiano che conduce interrogazioni orali.
RUOLO ESSENZIALE:
- Una domanda per volta
- Se risposta cattiva/superficiale → INSISTI con domande di approfondimento
- Se risposta buona → COMPLIMENTA e APPROFONDISCI con concetti correlati
- Adatta la difficolta REALE in base alle prestazioni
- Max 150 parole per risposta
- Sempre ITALIANO puro
- Suona come prof VERO, non ChatGPT
- BASE OBBLIGATORIA: usa SOLO il materiale fornito, evita domande scollegate o troppo generiche
- Quando possibile cita il riferimento come "[p.X]" se presente nel testo

MATERIALE ARGOMENTO:
${content}

COMPORTAMENTO REALISTICO:
- Scoraggia risposte generiche: "Spiega meglio", "Cosa intendi con..."
- Premia risposte precise: "Esatto! Ora dimmi..."
- Insegue la comprensione, non la memorizzazione
- Se un tema NON è nel materiale, dillo esplicitamente e resta sul perimetro del testo`;

    let personalityModifier;
    if (personality === 'strict') {
      personalityModifier = '\n\nSTILE DEL PROFESSORE - RIGOROSO (😤):\n- Aspettative ALTE\n- Correggi SUBITO gli errori\n- "Impreciso", "Troppo generico", "Approfondisci"\n- Tono esigente ma giusto\n- Non accetti vaghe risposte';
    } else if (personality === 'socratic') {
      personalityModifier = '\n\nSTILE DEL PROFESSORE - SOCRATICO (🧠):\n- Non dare subito la soluzione\n- Guida con domande progressive\n- Fai emergere il ragionamento causa-effetto\n- Se studente è bloccato, spezza in micro-passaggi\n- Mantieni tono calmo ma intellettualmente stimolante';
    } else {
      personalityModifier = '\n\nSTILE DEL PROFESSORE - INCORAGGIANTE (😊):\n- Aiuta lo studente a trovare la risposta\n- "Bene, continua così", "Esattamente, ora..."\n- Spiega i concetti difficili\n- Tono paziente e supportivo\n- Ambiente positivo e costruttivo';
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
      const systemPrompt = `Tu sei un professore italiano che spiega concetti in modo semplice e chiaro.
Argomento: ${topic}
Riferimento materiale: ${content}

Fornisci una spiegazione BREVE (3-4 frasi) e facile da capire.
ITALIANO puro.
${personality === 'strict' ? 'Tono formale e preciso.' : 'Tono amichevole e incoraggiante.'}`;

      const response = await axios.post(
        `${this.groqBaseUrl}/chat/completions`,
        {
          model: 'llama-3.1-8b-instant',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Spiega ${topic}` },
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

      return response.data.choices[0]?.message?.content || 'Concetto spiegato.';
    } catch (error) {
      console.error('❌ Groq Concept Explanation Error:', error.message);
      throw new Error(`Failed to explain concept: ${error.message}`);
    }
  }

  async evaluateSession(content, conversationHistory, personality) {
    if (!this.groqApiKey) {
      throw new Error('Groq API key not configured');
    }

    try {
      const evaluationPrompt = `Sei un professore italiano esperto. Valuta questa interrogazione orale e rispondi SOLO con JSON valido.

MATERIALE: ${content}

CONVERSAZIONE:
${conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n')}

Rispondi con SOLO questo JSON (niente altro):
{
  "score": 0,
  "rubric": {
    "criteria": [
      {"key": "accuratezza", "label": "Accuratezza", "weight": 0.3, "score": 0, "evidence": "", "reason": ""},
      {"key": "completezza", "label": "Completezza", "weight": 0.25, "score": 0, "evidence": "", "reason": ""},
      {"key": "lessico", "label": "Lessico disciplinare", "weight": 0.2, "score": 0, "evidence": "", "reason": ""},
      {"key": "collegamenti", "label": "Collegamenti", "weight": 0.15, "score": 0, "evidence": "", "reason": ""},
      {"key": "esposizione", "label": "Esposizione", "weight": 0.1, "score": 0, "evidence": "", "reason": ""}
    ]
  },
  "strengths": ["...", "..."],
  "weaknesses": ["...", "..."],
  "suggestions": ["...", "..."],
  "studyPlan": ["...", "...", "..."]
}

Regole importanti:
- score 0-10 con una cifra decimale
- "evidence" deve citare esempi testuali reali della conversazione
- "reason" deve spiegare in una frase il perché del punteggio
- I pesi devono sommare a 1.0
- Se mancano dati, sii conservativo ma non inventare.
- Valuta SOLO nel perimetro del materiale fornito: niente nozioni esterne.`;

      const response = await axios.post(
        `${this.groqBaseUrl}/chat/completions`,
        {
          model: 'llama-3.1-8b-instant',
          messages: [
            {
              role: 'system',
              content: 'Sei un esperto insegnante italiano. Rispondi SOLO con JSON valido.',
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
    const dontKnowCount = studentMessages.filter((m) => /non lo so/i.test(m.content)).length;
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
      { key: 'accuratezza', label: 'Accuratezza', weight: 0.3, score: 0, evidence: '', reason: '' },
      { key: 'completezza', label: 'Completezza', weight: 0.25, score: 0, evidence: '', reason: '' },
      { key: 'lessico', label: 'Lessico disciplinare', weight: 0.2, score: 0, evidence: '', reason: '' },
      { key: 'collegamenti', label: 'Collegamenti', weight: 0.15, score: 0, evidence: '', reason: '' },
      { key: 'esposizione', label: 'Esposizione', weight: 0.1, score: 0, evidence: '', reason: '' },
    ];
  }

  computeKpis(conversationHistory) {
    const studentMessages = conversationHistory.filter((m) => m.role === 'user');
    const answerCount = studentMessages.length;
    const dontKnowCount = studentMessages.filter((m) => /non lo so|boh|non ricordo|non saprei/i.test(m.content)).length;
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
    const dontKnowCount = studentMessages.filter((m) => /non lo so|boh|non ricordo|non saprei/i.test(m.content)).length;

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
        const shouldAdjust = ['accuratezza', 'completezza', 'collegamenti'].includes(c.key);
        if (!shouldAdjust) return c;
        const score = Math.max(0, Math.min(10, c.score + delta));
        return { ...c, score: parseFloat(score.toFixed(1)) };
      });
    };

    if (metrics.sourceCoverageRate < 0.2) {
      adjustCriteria(-1.3);
      grounded.weaknesses = Array.from(new Set([
        ...(grounded.weaknesses || []),
        'Le risposte risultano poco ancorate al materiale selezionato.',
      ]));
      grounded.suggestions = Array.from(new Set([
        ...(grounded.suggestions || []),
        'Cita definizioni e passaggi presenti nel PDF/testo durante la risposta.',
      ]));
    } else if (metrics.sourceCoverageRate > 0.38) {
      adjustCriteria(0.5);
      grounded.strengths = Array.from(new Set([
        ...(grounded.strengths || []),
        'Ottimo ancoraggio al materiale fornito.',
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
        evidence: String(fromModel.evidence || 'Evidenze testuali limitate.'),
        reason: String(fromModel.reason || 'Prestazione complessiva in linea con il livello rilevato.'),
      };
    });

    const weightedScore = normalizedCriteria.reduce((acc, c) => acc + c.score * c.weight, 0);
    const boundedScore = Math.min(10, Math.max(0, Number(rawEvaluation?.score ?? weightedScore)));

    const baseEvaluation = {
      score: parseFloat(boundedScore.toFixed(1)),
      rubric: {
        criteria: normalizedCriteria,
      },
      strengths: rawEvaluation?.strengths || ['Partecipazione attiva all\'interrogazione.'],
      weaknesses: rawEvaluation?.weaknesses || ['Alcune risposte richiedono maggiore profondità.'],
      suggestions: rawEvaluation?.suggestions || ['Ripassa i concetti chiave con esempi concreti.'],
      studyPlan: rawEvaluation?.studyPlan || [
        'Ripassa i concetti principali in blocchi da 20 minuti.',
        'Allenati con 5 domande orali su definizioni e collegamenti.',
        'Riformula ad alta voce le risposte in modo più preciso.',
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
      evidence: 'Valutazione fallback basata sulla qualità media delle risposte.',
      reason: 'Il modello non ha restituito un JSON valido, applicata valutazione euristica.',
    }));

    const fallback = {
      score: baseScore,
      rubric: { criteria },
      strengths: ['Partecipazione all\'esame.'],
      weaknesses: ['Aree da approfondire.'],
      suggestions: ['Rileggi il materiale e prova a rispondere con più dettaglio.'],
      studyPlan: [
        'Ripasso mirato dei punti deboli emersi.',
        'Allenamento su domande aperte con esempi.',
        'Verifica finale con mini test orale.',
      ],
      kpis: this.computeKpis(conversationHistory),
    };

    return this.applyGroundingAdjustments(fallback, content, conversationHistory);
  }
}

export default new InterrogoAIService();
