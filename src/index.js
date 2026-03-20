import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import authRoutes from './routes/auth.js';
import interrogoRoutes from './routes/interrogo.js';
import quickTestRoutes from './routes/quick-test.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT || 3001;
const startedAt = Date.now();
const monitor = {
  requestsTotal: 0,
  errorsTotal: 0,
  responseTimeTotalMs: 0,
  responseTimeSamples: 0,
  statusCounts: {
    '2xx': 0,
    '3xx': 0,
    '4xx': 0,
    '5xx': 0,
  },
  history: [],
};

const takeSlaSnapshot = () => {
  const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
  const successRate = monitor.requestsTotal > 0
    ? ((monitor.statusCounts['2xx'] + monitor.statusCounts['3xx']) / monitor.requestsTotal)
    : 1;
  const avgResponseTimeMs = monitor.responseTimeSamples > 0
    ? monitor.responseTimeTotalMs / monitor.responseTimeSamples
    : 0;

  return {
    timestamp: new Date().toISOString(),
    uptimeSeconds,
    requestsTotal: monitor.requestsTotal,
    errorsTotal: monitor.errorsTotal,
    statusCounts: monitor.statusCounts,
    successRate: parseFloat(successRate.toFixed(4)),
    avgResponseTimeMs: parseFloat(avgResponseTimeMs.toFixed(1)),
    memory: process.memoryUsage(),
  };
};

const computeAlerts = (snapshot) => {
  const alerts = [];
  if (snapshot.successRate < 0.98) {
    alerts.push({ level: 'warning', code: 'SUCCESS_RATE_LOW', message: 'Success rate sotto 98%.' });
  }
  if (snapshot.avgResponseTimeMs > 2000) {
    alerts.push({ level: 'warning', code: 'LATENCY_HIGH', message: 'Latenza media oltre 2s.' });
  }
  const usedHeapMb = snapshot.memory?.heapUsed ? snapshot.memory.heapUsed / (1024 * 1024) : 0;
  if (usedHeapMb > 512) {
    alerts.push({ level: 'warning', code: 'MEMORY_HIGH', message: 'Heap usage sopra 512MB.' });
  }
  return alerts;
};

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3002',
  credentials: true,
}));

app.use((req, res, next) => {
  monitor.requestsTotal += 1;
  const startedAt = Date.now();
  res.on('finish', () => {
    const elapsed = Date.now() - startedAt;
    monitor.responseTimeTotalMs += elapsed;
    monitor.responseTimeSamples += 1;
    const status = res.statusCode;
    if (status >= 500) monitor.statusCounts['5xx'] += 1;
    else if (status >= 400) monitor.statusCounts['4xx'] += 1;
    else if (status >= 300) monitor.statusCounts['3xx'] += 1;
    else monitor.statusCounts['2xx'] += 1;

    if (monitor.requestsTotal % 20 === 0) {
      monitor.history.push(takeSlaSnapshot());
      if (monitor.history.length > 120) {
        monitor.history.shift();
      }
    }

    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${elapsed}ms)`);
  });
  next();
});

app.use(express.json());
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// API index route
app.get('/', (req, res) => {
  res.json({
    service: 'Interrogo AI Backend',
    status: 'running',
    docs: {
      health: 'GET /health',
      signup: 'POST /api/auth/signup',
      login: 'POST /api/auth/login',
      me: 'GET /api/auth/me',
      interrogoStart: 'POST /api/interrogo/start',
      quickTestStart: 'POST /api/quick-test/start',
    },
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// SLA / monitoring snapshot
app.get('/health/sla', (req, res) => {
  const snapshot = takeSlaSnapshot();
  res.json({
    status: 'ok',
    ...snapshot,
    alerts: computeAlerts(snapshot),
  });
});

app.get('/health/sla/history', (req, res) => {
  res.json({
    status: 'ok',
    points: monitor.history,
    count: monitor.history.length,
  });
});

app.get('/health/sla/alerts', (req, res) => {
  const snapshot = takeSlaSnapshot();
  res.json({
    status: 'ok',
    alerts: computeAlerts(snapshot),
    snapshot,
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/interrogo', interrogoRoutes);
app.use('/api/quick-test', quickTestRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  monitor.errorsTotal += 1;
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`
    🎓 Interrogo AI Backend
    ✅ Server running on port ${PORT}
    📍 URL: http://localhost:${PORT}
    ${process.env.NODE_ENV === 'production' ? '🚀 Production mode' : '🔧 Development mode'}
  `);
});

export default app;
