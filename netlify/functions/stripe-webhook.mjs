import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const stripeSecret = process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!stripeSecret) return { statusCode: 500, body: 'Missing STRIPE_SECRET_KEY' };
    if (!webhookSecret) return { statusCode: 500, body: 'Missing STRIPE_WEBHOOK_SECRET' };
    if (!supabaseUrl) return { statusCode: 500, body: 'Missing SUPABASE_URL' };
    if (!supabaseServiceRoleKey) return { statusCode: 500, body: 'Missing SUPABASE_SERVICE_ROLE_KEY' };

    const stripe = new Stripe(stripeSecret, { apiVersion: '2024-06-20' });

    const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
    if (!sig) return { statusCode: 400, body: 'Missing stripe-signature' };

    const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';

    let stripeEvent;
    try {
      stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    } catch {
      return { statusCode: 400, body: 'Invalid signature' };
    }

    if (stripeEvent.type !== 'checkout.session.completed') {
      return { statusCode: 200, body: 'Ignored' };
    }

    const session = stripeEvent.data.object;
    const orderId = session?.metadata?.order_id;
    const orderCode = session?.metadata?.order_code;

    if (!orderId || !orderCode) {
      return { statusCode: 200, body: 'Missing metadata' };
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    const now = new Date().toISOString();

    const { data: orderRow } = await supabaseAdmin
      .from('orders')
      .select('id, order_code, user_id, customer_email, route_area, price_before_tax, final_price_before_tax, currency, order_stage')
      .eq('id', orderId)
      .maybeSingle();

    const userId = orderRow?.user_id;
    const routeArea = String(orderRow?.route_area ?? '').trim().toLowerCase();
    const finalSubtotal = Number(orderRow?.final_price_before_tax);
    const fallbackSubtotal = Number(orderRow?.price_before_tax);
    const chosenSubtotal = Number.isFinite(finalSubtotal) && finalSubtotal > 0 ? finalSubtotal : fallbackSubtotal;
    const safeSubtotal = Number.isFinite(chosenSubtotal) && chosenSubtotal >= 0 ? chosenSubtotal : 0;
    const isQc = routeArea.includes('montreal') || routeArea.includes('quebec');
    const taxRate = isQc ? 0.14975 : 0.13;
    const taxNote = isQc ? 'QC (GST+QST)' : 'ON (HST)';
    const tax = Math.round(safeSubtotal * taxRate * 100) / 100;
    const total = Math.round((safeSubtotal + tax) * 100) / 100;

    const currentStage = String(orderRow?.order_stage ?? '').trim();
    const nextStage = currentStage === 'draft' || currentStage === 'in_negotiation' ? 'pending_payment' : currentStage;

    await supabaseAdmin
      .from('orders')
      .update({
        payment_status: 'paid',
        stripe_payment_intent_id: session.payment_intent || null,
        updated_at: now,
        status: 'Scheduled',
        order_stage: nextStage || 'pending_payment',
      })
      .eq('id', orderId);

    await supabaseAdmin.from('order_events').insert({
      order_id: orderId,
      status: 'Scheduled',
      note: 'Payment received',
      at: now,
    });

    if (userId) {
      let stripeCustomerId = null;
      try {
        stripeCustomerId = typeof session?.customer === 'string' ? session.customer : null;
      } catch {
        stripeCustomerId = null;
      }

      let hasSavedPaymentMethod = false;
      let cardBrand = null;
      let cardLast4 = null;
      let cardExpMonth = null;
      let cardExpYear = null;

      try {
        const paymentIntentId = typeof session?.payment_intent === 'string' ? session.payment_intent : null;
        if (paymentIntentId) {
          const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
          const pmId = typeof pi?.payment_method === 'string' ? pi.payment_method : null;
          if (pmId) {
            const pm = await stripe.paymentMethods.retrieve(pmId);
            const card = pm?.card || null;
            const brand = typeof card?.brand === 'string' ? card.brand : null;
            const last4 = typeof card?.last4 === 'string' ? card.last4 : null;
            const expMonth = Number.isFinite(card?.exp_month) ? Number(card.exp_month) : null;
            const expYear = Number.isFinite(card?.exp_year) ? Number(card.exp_year) : null;
            if (brand && last4) {
              hasSavedPaymentMethod = true;
              cardBrand = brand;
              cardLast4 = last4;
              cardExpMonth = expMonth;
              cardExpYear = expYear;
            }
          }
        }
      } catch {
        // ignore
      }

      try {
        await supabaseAdmin.from('billing_profiles').upsert(
          {
            user_id: userId,
            stripe_customer_id: stripeCustomerId,
            has_saved_payment_method: hasSavedPaymentMethod,
            card_brand: cardBrand,
            card_last4: cardLast4,
            card_exp_month: cardExpMonth,
            card_exp_year: cardExpYear,
            updated_at: now,
          },
          { onConflict: 'user_id' }
        );
      } catch {
        // ignore
      }
    }

    if (userId) {
      const receiptText = [
        'Receipt',
        `Created: ${now}`,
        `Order: ${String(orderCode)}`,
        orderRow?.customer_email ? `Customer: ${String(orderRow.customer_email)}` : null,
        '',
        `Subtotal (before tax): $${safeSubtotal.toFixed(2)}`,
        `Tax ${taxNote} (${(taxRate * 100).toFixed(3)}%): $${tax.toFixed(2)}`,
        `Total: $${total.toFixed(2)}`,
      ]
        .filter(Boolean)
        .join('\n');

      const { data: existingReceipts } = await supabaseAdmin
        .from('receipts')
        .select('id')
        .eq('user_id', userId)
        .eq('order_code', String(orderCode))
        .limit(1);

      const exists = Array.isArray(existingReceipts) && existingReceipts.length > 0;

      if (!exists) {
        await supabaseAdmin.from('receipts').insert({
          user_id: userId,
          order_code: String(orderCode),
          text: receiptText,
        });
      }
    }

    return { statusCode: 200, body: 'OK' };
  } catch {
    return { statusCode: 500, body: 'Webhook error' };
  }
};
