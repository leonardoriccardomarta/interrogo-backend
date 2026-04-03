import Stripe from 'stripe';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_MONTHLY_PRICE_ID = process.env.STRIPE_MONTHLY_PRICE_ID || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

let stripeClient = null;
if (STRIPE_SECRET_KEY) {
  stripeClient = new Stripe(STRIPE_SECRET_KEY, {
    apiVersion: '2024-06-20',
  });
}

const hasStripeConfig = () => Boolean(stripeClient && STRIPE_MONTHLY_PRICE_ID);

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

  const active = subscriptions.data.find((sub) => {
    if (!['active', 'trialing'].includes(sub.status)) return false;
    return sub.items.data.some((item) => item.price?.id === STRIPE_MONTHLY_PRICE_ID);
  });

  return active || null;
};

export const getBillingStatus = async (email) => {
  if (!hasStripeConfig()) {
    return {
      plan: 'free',
      isPro: false,
      stripeReady: false,
      monthlyPriceId: null,
      subscriptionStatus: null,
      currentPeriodEnd: null,
    };
  }

  const subscription = await getActiveSubscription(email);
  return {
    plan: subscription ? 'pro' : 'free',
    isPro: Boolean(subscription),
    stripeReady: true,
    monthlyPriceId: STRIPE_MONTHLY_PRICE_ID,
    subscriptionStatus: subscription?.status || null,
    currentPeriodEnd: subscription?.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
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
    line_items: [
      {
        price: STRIPE_MONTHLY_PRICE_ID,
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

  switch (type) {
    case 'checkout.session.completed':
      return {
        handled: true,
        type,
        message: 'Checkout session completed',
        customerEmail: object.customer_details?.email || object.customer_email || null,
      };
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return {
        handled: true,
        type,
        message: 'Subscription lifecycle event received',
        subscriptionId: object.id || null,
        status: object.status || null,
      };
    case 'invoice.paid':
      return {
        handled: true,
        type,
        message: 'Invoice paid',
        subscriptionId: object.subscription || null,
      };
    case 'invoice.payment_failed':
      return {
        handled: true,
        type,
        message: 'Invoice payment failed',
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
