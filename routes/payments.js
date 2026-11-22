import { Router } from 'express';
import Stripe from 'stripe';
import { ObjectId } from 'mongodb';
import { connectDB, getDB } from '../db.js';
import { verifyToken, requireRole } from '../middleware/auth.js';
import { wrap, isValidId, isPremium } from '../utils.js';

const stripe = () => new Stripe(process.env.STRIPE_SECRET_KEY);
const router = Router();

// Newer Stripe API versions keep the period end on the subscription item
const periodEnd = (sub) => {
  const ts = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  return ts ? new Date(ts * 1000) : null;
};

/* Vendor starts checkout. The vendor id comes from the verified token, never from the request body. */
router.post('/checkout', verifyToken, requireRole('vendor'), wrap(async (req, res) => {
  if (isPremium(req.user)) {
    return res.status(400).json({ message: 'You are already on the Premium plan' });
  }
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    customer_email: req.user.email,
    client_reference_id: req.user.id,
    metadata: { vendorId: req.user.id },
    success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.CLIENT_URL}/payment/cancel`,
  });
  res.json({ url: session.url });
}));

/* Cancel at the end of the paid period; the webhook downgrades the user when it ends */
router.post('/cancel', verifyToken, requireRole('vendor'), wrap(async (req, res) => {
  const user = await getDB().collection('users').findOne({ _id: new ObjectId(req.user.id) });
  if (!user?.stripeSubscriptionId) {
    return res.status(400).json({ message: 'No active subscription found' });
  }
  await stripe().subscriptions.update(user.stripeSubscriptionId, { cancel_at_period_end: true });
  res.json({ message: 'Subscription will end at the close of the current billing period' });
}));

/* Stripe webhook: the ONLY place Premium gets activated. Needs the raw body. */
export async function webhookHandler(req, res) {
  let event;
  try {
    event = stripe().webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook signature failed: ${err.message}`);
  }

  try {
    await connectDB();
    const db = getDB();
    const users = db.collection('users');
    const obj = event.data.object;

    if (event.type === 'checkout.session.completed') {
      const vendorId = obj.client_reference_id;
      if (obj.mode === 'subscription' && obj.payment_status === 'paid' && isValidId(vendorId)) {
        const sub = await stripe().subscriptions.retrieve(obj.subscription);
        await users.updateOne(
          { _id: new ObjectId(vendorId) },
          { $set: { subscriptionPlan: 'premium', subscriptionExpiresAt: periodEnd(sub), stripeSubscriptionId: sub.id } }
        );
        // upsert on the session id means a retried webhook never creates a duplicate
        await db.collection('transactions').updateOne(
          { stripeSessionId: obj.id },
          {
            $setOnInsert: {
              vendorId,
              plan: 'premium',
              amount: obj.amount_total / 100,
              currency: obj.currency,
              stripeSessionId: obj.id,
              stripeSubscriptionId: sub.id,
              status: 'paid',
              createdAt: new Date(),
            },
          },
          { upsert: true }
        );
      }
    }

    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const active = ['active', 'trialing'].includes(obj.status);
      await users.updateOne(
        { stripeSubscriptionId: obj.id },
        { $set: active
            ? { subscriptionPlan: 'premium', subscriptionExpiresAt: periodEnd(obj) }
            : { subscriptionPlan: 'free', subscriptionExpiresAt: null } }
      );
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ message: 'Webhook handler failed' });
  }
}

export default router;