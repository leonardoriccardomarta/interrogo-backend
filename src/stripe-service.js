import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const prisma = new PrismaClient();

export const createCheckoutSession = async (userId, plan) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');

  const priceIds = {
    monthly: process.env.STRIPE_PRICE_MONTHLY || 'price_monthly_placeholder',
    annual: process.env.STRIPE_PRICE_ANNUAL || 'price_annual_placeholder',
  };

  const session = await stripe.checkout.sessions.create({
    customer_email: user.email,
    line_items: [
      {
        price: priceIds[plan] || priceIds.monthly,
        quantity: 1,
      },
    ],
    mode: 'subscription',
    success_url: `${process.env.FRONTEND_URL}/dashboard?success=true`,
    cancel_url: `${process.env.FRONTEND_URL}/dashboard?canceled=true`,
    metadata: { userId, plan },
  });

  return session;
};

export const handleWebhook = async (rawBody, sig) => {
  try {
    const event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { userId } = session.metadata;
      
      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      const plan = session.metadata.plan;

      await prisma.user.update({
        where: { id: userId },
        data: {
          plan: plan,
          stripeSubscriptionId: subscription.id,
          stripeCustomerId: session.customer,
          planStartDate: new Date(),
          planEndDate: new Date(subscription.current_period_end * 1000),
        },
      });
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      await prisma.user.updateMany({
        where: { stripeSubscriptionId: subscription.id },
        data: { plan: 'free', stripeSubscriptionId: null },
      });
    }

    return { success: true };
  } catch (err) {
    console.error('Webhook error:', err);
    throw err;
  }
};

export const getUserSubscriptionStatus = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      plan: true,
      planStartDate: true,
      planEndDate: true,
      sessions: { where: { createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } },
    },
  });

  if (!user) return null;

  const isActive = user.plan !== 'free' && user.planEndDate > new Date();
  const sessionsThisMonth = user.sessions.length;
  const sessionsLimit = user.plan === 'free' ? 2 : 999;

  return {
    plan: user.plan,
    isActive,
    sessionsUsed: sessionsThisMonth,
    sessionsLimit,
    canCreateSession: sessionsThisMonth < sessionsLimit,
    planEndDate: user.planEndDate,
  };
};
