import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const origin = event.headers?.origin || event.headers?.Origin || process.env.URL || 'http://localhost:5173';

    const stripeSecret = process.env.STRIPE_SECRET_KEY;
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

    if (!stripeSecret) return { statusCode: 500, body: 'Missing STRIPE_SECRET_KEY' };
    if (String(stripeSecret).trim().startsWith('pk_')) {
      return {
        statusCode: 500,
        body: 'Invalid STRIPE_SECRET_KEY: you set a publishable key (pk_...). Use a secret key (sk_...) from Stripe Developers → API keys.',
      };
    }
    if (!supabaseUrl) return { statusCode: 500, body: 'Missing SUPABASE_URL' };
    if (!supabaseAnonKey) return { statusCode: 500, body: 'Missing SUPABASE_ANON_KEY' };

    const body = event.body ? JSON.parse(event.body) : {};
    const orderCode = String(body?.order_code ?? '').trim();
    const accessToken = String(body?.access_token ?? '').trim();

    if (!orderCode) return { statusCode: 400, body: 'Missing order_code' };
    if (!accessToken) return { statusCode: 401, body: 'Missing access_token' };

    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
      auth: { persistSession: false },
    });

    const { data: userData, error: userErr } = await supabaseAuth.auth.getUser();
    if (userErr || !userData?.user?.id) return { statusCode: 401, body: 'Invalid access_token' };
    const userId = userData.user.id;
    const userEmail = userData.user.email || null;

    const db = supabaseServiceRoleKey
      ? createClient(supabaseUrl, supabaseServiceRoleKey, {
          auth: { persistSession: false },
        })
      : supabaseAuth;

    const selectFields = supabaseServiceRoleKey
      ? 'id, order_code, price_before_tax, currency, user_id, payment_status, route_area, form_data'
      : 'id, order_code, price_before_tax, currency, payment_status, route_area, form_data';

    const { data: order, error: orderErr } = await db.from('orders').select(selectFields).eq('order_code', orderCode).maybeSingle();

    if (orderErr || !order) return { statusCode: 404, body: 'Order not found' };
    if (supabaseServiceRoleKey && order.user_id !== userId) return { statusCode: 403, body: 'Forbidden' };

    const amount = Number(order.price_before_tax);
    if (!Number.isFinite(amount) || amount <= 0) return { statusCode: 400, body: 'Invalid order amount' };

    const orderFormData = order?.form_data && typeof order.form_data === 'object' ? order.form_data : null;
    const rawLoadingFee = Number(orderFormData?.vehicle_loading_fee ?? 0);
    const loadingFee = Number.isFinite(rawLoadingFee) && rawLoadingFee > 0 ? rawLoadingFee : 0;
    const safeLoadingFee = loadingFee > 0 && loadingFee < amount ? loadingFee : 0;
    const transportAmount = safeLoadingFee ? amount - safeLoadingFee : amount;

    const routeArea = String(order.route_area ?? '').trim().toLowerCase();
    const isQc = routeArea.includes('montreal') || routeArea.includes('quebec');
    const taxRate = isQc ? 0.14975 : 0.13;
    const taxLabel = isQc ? 'GST + QST (QC)' : 'HST (ON)';
    const taxAmount = Math.round(amount * taxRate * 100) / 100;

    const checkoutCurrency = 'cad';
    const taxRateLabel = isQc ? (taxRate * 100).toFixed(3) : (taxRate * 100).toFixed(0);

    const stripe = new Stripe(stripeSecret, { apiVersion: '2024-06-20' });

    const now = new Date().toISOString();

    const routeAreaDisplay = String(order.route_area ?? '').trim();
    const orderLabel = String(order.order_code ?? '').trim();
    const serviceLabel = 'EasyDrive Vehicle Transport';
    const productDescription = [routeAreaDisplay ? `Route: ${routeAreaDisplay}` : '', orderLabel ? `Order: ${orderLabel}` : '']
      .filter(Boolean)
      .join(' • ');

    let stripeCustomerId = null;
    try {
      const { data: billingRow } = await db
        .from('billing_profiles')
        .select('stripe_customer_id')
        .eq('user_id', userId)
        .maybeSingle();
      stripeCustomerId = billingRow?.stripe_customer_id || null;
    } catch {
      stripeCustomerId = null;
    }

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: userEmail || undefined,
        metadata: {
          supabase_user_id: userId,
        },
      });
      stripeCustomerId = customer?.id || null;
      if (stripeCustomerId) {
        try {
          await db.from('billing_profiles').upsert(
            {
              user_id: userId,
              stripe_customer_id: stripeCustomerId,
              updated_at: now,
            },
            { onConflict: 'user_id' }
          );
        } catch {
          // ignore
        }
      }
    }

    const lineItems = [
      {
        quantity: 1,
        price_data: {
          currency: checkoutCurrency,
          unit_amount: Math.round(transportAmount * 100),
          product_data: {
            name: routeAreaDisplay ? `${serviceLabel} — ${routeAreaDisplay}` : serviceLabel,
            description: productDescription || undefined,
          },
        },
      },
    ];

    if (safeLoadingFee) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: checkoutCurrency,
          unit_amount: Math.round(safeLoadingFee * 100),
          product_data: {
            name: 'Loading fee',
            description: 'Non-running/non-driving vehicle handling (paid at checkout).',
          },
        },
      });
    }

    lineItems.push({
      quantity: 1,
      price_data: {
        currency: checkoutCurrency,
        unit_amount: Math.round(taxAmount * 100),
        product_data: {
          name: `${taxLabel} (${taxRateLabel}%)`,
        },
      },
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      submit_type: 'pay',
      locale: 'auto',
      client_reference_id: orderCode,
      customer: stripeCustomerId || undefined,
      payment_intent_data: {
        setup_future_usage: 'off_session',
        description: productDescription || undefined,
        metadata: {
          order_id: String(order.id ?? ''),
          order_code: orderLabel,
          route_area: routeAreaDisplay,
          vehicle_loading_fee: String(safeLoadingFee || 0),
        },
      },
      custom_text: {
        submit: {
          message: 'Secure payment powered by Stripe. A receipt will be emailed after payment.',
        },
      },
      line_items: lineItems,
      success_url: `${origin}/?checkout=success&order=${encodeURIComponent(order.order_code)}`,
      cancel_url: `${origin}/?checkout=cancel&order=${encodeURIComponent(order.order_code)}`,
      metadata: {
        order_id: order.id,
        order_code: order.order_code,
        route_area: routeAreaDisplay,
      },
    });

    try {
      await db.from('orders').update({ payment_status: 'pending', stripe_session_id: session.id }).eq('id', order.id);
    } catch {
      // ignore
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url, id: session.id }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
    };
  }
};
