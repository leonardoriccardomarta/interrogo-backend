import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export const sendWelcomeEmail = async (email, firstName) => {
  try {
    await resend.emails.send({
      from: 'Interrogo <onboarding@interrogo.it>',
      to: email,
      subject: `Benvenuto su Interrogo, ${firstName}! 🎤`,
      html: `
        <h2>Ciao ${firstName},</h2>
        <p>Grazie per esserti iscritto a Interrogo!</p>
        <p>Sei pronto a iniziare? Ecco cosa puoi fare:</p>
        <ul>
          <li><strong>Scegli una materia</strong> (Inglese, Francese, ecc)</li>
          <li><strong>Carica il tuo PDF</strong> o scrivi il testo da studiare</li>
          <li><strong>Inizia una sessione</strong> e ricevi feedback istantaneo</li>
        </ul>
        <p><a href="${process.env.FRONTEND_URL}/dashboard" style="background: #6366f1; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block;">Vai al Dashboard</a></p>
        <p>Hai domande? Rispondi a questa email.</p>
        <p>— Il team di Interrogo</p>
      `,
    });
  } catch (err) {
    console.error('Welcome email error:', err);
  }
};

export const sendSessionFeedbackEmail = async (email, results) => {
  try {
    const { score, duration, feedback } = results;
    const scorePercent = (score * 100).toFixed(0);

    await resend.emails.send({
      from: 'Interrogo <noreply@interrogo.it>',
      to: email,
      subject: `Sessione completata! Hai preso ${scorePercent}% 🎯`,
      html: `
        <h2>Grande lavoro!</h2>
        <p><strong>Punteggio:</strong> ${scorePercent}%</p>
        <p><strong>Durata:</strong> ${duration} minuti</p>
        <p><strong>Feedback:</strong> ${feedback}</p>
        <p><a href="${process.env.FRONTEND_URL}/dashboard" style="background: #6366f1; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block;">Rivedi i tuoi risultati</a></p>
        <p>Prova ancora? Ogni sessione migliora il tuo voto!</p>
      `,
    });
  } catch (err) {
    console.error('Feedback email error:', err);
  }
};

export const sendReengagementEmail = async (email, firstName, lastSessionDaysAgo) => {
  try {
    await resend.emails.send({
      from: 'Interrogo <noreply@interrogo.it>',
      to: email,
      subject: `${firstName}, l'esame si avvicina! 📚`,
      html: `
        <h2>Ciao ${firstName}!</h2>
        <p>Non ti vediamo da ${lastSessionDaysAgo} giorni. Hai lasciato una sessione incompleta?</p>
        <p>Ecco il piano:</p>
        <ul>
          <li>Fai 2-3 sessioni questa settimana</li>
          <li>Traccia i tuoi progressi</li>
          <li>Arriva all'esame confidente</li>
        </ul>
        <p><a href="${process.env.FRONTEND_URL}/dashboard" style="background: #10b981; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block;">Continua l'allenamento</a></p>
        <p>Ti served aiuto? Chat support è aperto 24/7.</p>
      `,
    });
  } catch (err) {
    console.error('Reengagement email error:', err);
  }
};

export const sendUpgradeCTA = async (email, firstName, freeSessUsed) => {
  try {
    await resend.emails.send({
      from: 'Interrogo <noreply@interrogo.it>',
      to: email,
      subject: `${firstName}, sblocca esercizi illimitati 🚀`,
      html: `
        <h2>Stai facendo progressi!</h2>
        <p>Hai già completato ${freeSessUsed} sessioni gratuite. Vuoi praticare senza limiti?</p>
        <p><strong>Premium da €3.99/mese</strong> ti dà:</p>
        <ul>
          <li>✓ Sessioni illimitate</li>
          <li>✓ Valutazione avanzata</li>
          <li>✓ Export risultati</li>
          <li>✓ Priorità support</li>
        </ul>
        <p><a href="${process.env.FRONTEND_URL}/dashboard?upgrade=true" style="background: #6366f1; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block;">Prova 7 giorni gratis</a></p>
        <p>Niente carta di credito richiesto.</p>
      `,
    });
  } catch (err) {
    console.error('Upgrade CTA email error:', err);
  }
};
