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

MATERIALE ARGOMENTO:
${content}

COMPORTAMENTO REALISTICO:
- Scoraggia risposte generiche: "Spiega meglio", "Cosa intendi con..."
- Premia risposte precise: "Esatto! Ora dimmi..."
- Insegue la comprensione, non la memorizzazione`;

    const personalityModifier = personality === 'strict' 
      ? '\n\nSTILE DEL PROFESSORE - RIGOROSO (😤):\n- Aspettative ALTE\n- Correggi SUBITO gli errori\n- "Impreciso", "Troppo generico", "Approfondisci"\n- Tono esigente ma giusto\n- Non accetti vaghe risposte'
      : '\n\nSTILE DEL PROFESSORE - INCORAGGIANTE (😊):\n- Aiuta lo studente a trovare la risposta\n- "Bene, continua così", "Esattamente, ora..."\n- Spiega i concetti difficili\n- Tono paziente e supportivo\n- Ambiente positivo e costruttivo';

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
      const evaluationPrompt = `Sei un professore italiano esperto. Valuta questa interrogazione e rispondi SOLO con JSON valido.

MATERIALE: ${content}

CONVERSAZIONE:
${conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n')}

Rispondi con SOLO questo JSON (niente altro):
{"score": X, "strengths": ["...", "..."], "weaknesses": ["...", "..."], "suggestions": ["...", "..."]}

Score 0-10 basato su comprensione, profondità, precisione.`;

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
        return {
          score: Math.min(10, Math.max(0, evaluation.score || 6)),
          strengths: evaluation.strengths || ['Partecipazione all\'esame'],
          weaknesses: evaluation.weaknesses || ['Aree da approfondire'],
          suggestions: evaluation.suggestions || ['Rileggi il materiale'],
        };
      } catch (parseError) {
        console.error('Failed to parse evaluation JSON:', responseText);
        const fallbackScore = this.computeHeuristicScore(conversationHistory);
        return {
          score: fallbackScore,
          strengths: ['Partecipazione all\'esame'],
          weaknesses: ['Aree da approfondire'],
          suggestions: ['Rileggi il materiale'],
        };
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
}

export default new InterrogoAIService();
