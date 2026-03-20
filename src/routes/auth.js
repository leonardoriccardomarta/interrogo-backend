import express from 'express';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { generateToken, verifyToken } from '../middleware/auth.js';

const router = express.Router();
const prisma = new PrismaClient();

const getTutorEmailSet = () => {
  const raw = process.env.TUTOR_EMAILS || '';
  return new Set(
    raw
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
};

const getUserRoleFromEmail = (email) => {
  const tutorEmails = getTutorEmailSet();
  return tutorEmails.has((email || '').toLowerCase()) ? 'tutor' : 'student';
};

// Signup
router.post('/signup', async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if user exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        firstName: firstName || '',
        lastName: lastName || '',
      },
    });

    // Generate token
    const token = generateToken(user.id, user.email);

    res.status(201).json({
      message: 'User created successfully',
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: getUserRoleFromEmail(user.email),
      },
    });
  } catch (error) {
    console.error('❌ Signup error:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // Find user
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check password
    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate token
    const token = generateToken(user.id, user.email);

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: getUserRoleFromEmail(user.email),
      },
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// Get current user (verify token)
router.get('/me', verifyToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      ...user,
      role: getUserRoleFromEmail(user.email),
    });
  } catch (error) {
    console.error('❌ Get user error:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Retention policy info (GDPR transparency)
router.get('/retention-policy', (req, res) => {
  const sessionRetentionDays = Number(process.env.DATA_RETENTION_DAYS || 365);
  res.json({
    policyVersion: '1.0',
    sessionRetentionDays,
    accountDeletion: 'Immediate hard delete on user request via DELETE /api/auth/delete-account',
    exportEndpoint: 'GET /api/auth/export-data',
    updatedAt: new Date().toISOString(),
  });
});

// Export account data (GDPR portability)
router.get('/export-data', verifyToken, async (req, res) => {
  try {
    const userId = req.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const sessions = await prisma.interrogoSession.findMany({
      where: { userId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      exportedAt: new Date().toISOString(),
      user,
      sessions,
    });
  } catch (error) {
    console.error('❌ Export data error:', error);
    res.status(500).json({ error: 'Failed to export account data' });
  }
});

// Delete account and all related data (GDPR erase)
router.delete('/delete-account', verifyToken, async (req, res) => {
  try {
    const userId = req.userId;

    await prisma.user.delete({
      where: { id: userId },
    });

    res.json({
      success: true,
      message: 'Account deleted successfully',
    });
  } catch (error) {
    console.error('❌ Delete account error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

export default router;
