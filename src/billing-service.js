import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PRO_MONTHLY_EUR_CENTS = 999;
const prisma = new PrismaClient();

let stripeClient = null;
if (STRIPE_SECRET_KEY) {
  stripeClient = new Stripe(STRIPE_SECRET_KEY, {
    apiVersion: '2024-06-20',
  });
}

const hasStripeConfig = () => Boolean(stripeClient);

const mapBillingFromStatus = (status) => {
  const normalized = String(status || '').toLowerCase();
  if (['active', 'trialing', 'past_due', 'unpaid'].includes(normalized)) {
    return 'pro';
  }
  return 'free';
};

const persistBillingState = async ({
  email,
  billingPlan,
  billingStatus,
  currentPeriodEnd,
  stripeCustomerId,
  stripeSubscriptionId,
}) => {
  if (!email) return null;

  return prisma.user.updateMany({
    where: { email },
    data: {
      billingPlan,
      billingStatus,
      billingCurrentPeriodEnd: currentPeriodEnd || null,
      stripeCustomerId: stripeCustomerId || null,
      stripeSubscriptionId: stripeSubscriptionId || null,
      billingUpdatedAt: new Date(),
    },
  });
};

const resolveCustomerEmail = async ({ customerId, fallbackEmail, metadataEmail }) => {
  if (metadataEmail) return metadataEmail;
  if (fallbackEmail) return fallbackEmail;
  if (!customerId || !stripeClient) return null;

  const customer = await stripeClient.customers.retrieve(customerId);
  return customer?.deleted ? null : customer?.email || null;
};

const readStoredBilling = async (email) => {
  if (!email) return null;

  return prisma.user.findUnique({
    where: { email },
    select: {
      billingPlan: true,
      billingStatus: true,
      billingCurrentPeriodEnd: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
    },
  });
};

const getActiveSubscription = async (email) => {
  if (!hasStripeConfig() || !email) return null;

  const customers = await stripeClient.customers.search({
    query: `email:'${String(email).replace(/'/g, "\\'")}'`,
    limit: 1,
  });

  const customer = customers.data?.[0];
  if (!customer) return null;

  const subscriptions = await stripeClient.subscriptions.list({
    customer: customer.id,
    status: 'all',
    limit: 20,
    expand: ['data.items.data.price'],
  });

  const active = subscriptions.data.find((sub) => ['active', 'trialing'].includes(sub.status));

  return active || null;
};

export const getBillingStatus = async (email) => {
  const storedBilling = await readStoredBilling(email);
  const storedPlan = String(storedBilling?.billingPlan || 'free').toLowerCase();
  const storedStatus = String(storedBilling?.billingStatus || 'free').toLowerCase();

  if (!hasStripeConfig()) {
    return {
      plan: storedPlan,
      isPro: storedPlan === 'pro' || storedStatus === 'active' || storedStatus === 'trialing',
      stripeReady: false,
      monthlyPriceEur: 9.99,
      subscriptionStatus: storedStatus || null,
      currentPeriodEnd: storedBilling?.billingCurrentPeriodEnd
        ? new Date(storedBilling.billingCurrentPeriodEnd).toISOString()
        : null,
    };
  }

  const subscription = await getActiveSubscription(email);
  if (subscription) {
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
    const subscriptionStatus = subscription.status || 'active';
    const plan = mapBillingFromStatus(subscriptionStatus);
    const currentPeriodEnd = subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null;

    await persistBillingState({
      email,
      billingPlan: plan,
      billingStatus: subscriptionStatus,
      currentPeriodEnd,
      stripeCustomerId: customerId || storedBilling?.stripeCustomerId || null,
      stripeSubscriptionId: subscription.id || storedBilling?.stripeSubscriptionId || null,
    });

    return {
      plan,
      isPro: plan === 'pro',
      stripeReady: true,
      monthlyPriceEur: 9.99,
      subscriptionStatus,
      currentPeriodEnd,
    };
  }

  return {
    plan: storedPlan,
    isPro: storedPlan === 'pro' || storedStatus === 'active' || storedStatus === 'trialing',
    stripeReady: true,
    monthlyPriceEur: 9.99,
    subscriptionStatus: storedStatus || null,
    currentPeriodEnd: storedBilling?.billingCurrentPeriodEnd
      ? new Date(storedBilling.billingCurrentPeriodEnd).toISOString()
      : null,
  };
};

export const createCheckoutSession = async ({ email, successUrl, cancelUrl }) => {
  if (!hasStripeConfig()) {
    throw new Error('Stripe is not configured');
  }

  const session = await stripeClient.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    customer_email: email,
    metadata: {
      appEmail: email,
    },
    line_items: [
      {
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'Interrogo Pro Monthly',
          },
          recurring: {
            interval: 'month',
          },
          metadata: {
            appEmail: email,
          },
          unit_amount: PRO_MONTHLY_EUR_CENTS,
        },
        quantity: 1,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: true,
  });

  return session;
};

export const createPortalSession = async ({ email, returnUrl }) => {
  if (!hasStripeConfig()) {
    throw new Error('Stripe is not configured');
  }

  const customers = await stripeClient.customers.search({
    query: `email:'${String(email).replace(/'/g, "\\'")}'`,
    limit: 1,
  });

  const customer = customers.data?.[0];
  if (!customer) {
    throw new Error('No Stripe customer found for this account');
  }

  const portal = await stripeClient.billingPortal.sessions.create({
    customer: customer.id,
    return_url: returnUrl,
  });

  return portal;
};

export const hasWebhookConfig = () => Boolean(stripeClient && STRIPE_WEBHOOK_SECRET);

export const constructWebhookEvent = ({ payload, signature }) => {
  if (!stripeClient) {
    throw new Error('Stripe is not configured');
  }
  if (!STRIPE_WEBHOOK_SECRET) {
    throw new Error('Stripe webhook secret is not configured');
  }
  if (!signature) {
    throw new Error('Missing Stripe signature header');
  }

  return stripeClient.webhooks.constructEvent(payload, signature, STRIPE_WEBHOOK_SECRET);
};

export const processWebhookEvent = async (event) => {
  const type = event?.type || 'unknown';
  const object = event?.data?.object || {};

  const metadataEmail = object?.metadata?.appEmail || null;
  const fallbackEmail = object?.customer_details?.email || object?.customer_email || null;

  switch (type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed':
      await persistBillingState({
        email: metadataEmail || fallbackEmail,
        billingPlan: 'pro',
        billingStatus: object.payment_status || 'active',
        currentPeriodEnd: null,
        stripeCustomerId: typeof object.customer === 'string' ? object.customer : object.customer?.id || null,
        stripeSubscriptionId: object.subscription || null,
      });
      return {
        handled: true,
        type,
        message: 'Checkout session completed',
        customerEmail: metadataEmail || fallbackEmail,
      };
    case 'customer.subscription.trial_will_end':
      return {
        handled: true,
        type,
        message: 'Subscription trial will end soon',
        subscriptionId: object.id || null,
      };
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await persistBillingState({
        email: await resolveCustomerEmail({
          customerId: typeof object.customer === 'string' ? object.customer : object.customer?.id || null,
          fallbackEmail,
          metadataEmail,
        }),
        billingPlan: mapBillingFromStatus(object.status),
        billingStatus: object.status || 'unknown',
        currentPeriodEnd: object.current_period_end
          ? new Date(object.current_period_end * 1000).toISOString()
          : null,
        stripeCustomerId: typeof object.customer === 'string' ? object.customer : object.customer?.id || null,
        stripeSubscriptionId: object.id || null,
      });
      return {
        handled: true,
        type,
        message: 'Subscription lifecycle event received',
        subscriptionId: object.id || null,
        status: object.status || null,
      };
    case 'invoice.paid':
      await persistBillingState({
        email: await resolveCustomerEmail({
          customerId: typeof object.customer === 'string' ? object.customer : object.customer?.id || null,
          fallbackEmail,
          metadataEmail,
        }),
        billingPlan: 'pro',
        billingStatus: 'active',
        currentPeriodEnd: object.lines?.data?.[0]?.period?.end
          ? new Date(object.lines.data[0].period.end * 1000).toISOString()
          : null,
        stripeCustomerId: typeof object.customer === 'string' ? object.customer : object.customer?.id || null,
        stripeSubscriptionId: object.subscription || null,
      });
      return {
        handled: true,
        type,
        message: 'Invoice paid',
        subscriptionId: object.subscription || null,
      };
    case 'invoice.payment_failed':
      await persistBillingState({
        email: await resolveCustomerEmail({
          customerId: typeof object.customer === 'string' ? object.customer : object.customer?.id || null,
          fallbackEmail,
          metadataEmail,
        }),
        billingPlan: 'pro',
        billingStatus: 'past_due',
        currentPeriodEnd: null,
        stripeCustomerId: typeof object.customer === 'string' ? object.customer : object.customer?.id || null,
        stripeSubscriptionId: object.subscription || null,
      });
      return {
        handled: true,
        type,
        message: 'Invoice payment failed',
        subscriptionId: object.subscription || null,
      };
    case 'invoice.upcoming':
      return {
        handled: true,
        type,
        message: 'Upcoming invoice notice',
        subscriptionId: object.subscription || null,
      };
    default:
      return {
        handled: false,
        type,
        message: 'Unhandled Stripe event type',
      };
  }
};
