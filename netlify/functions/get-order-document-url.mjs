import { createClient } from '@supabase/supabase-js';

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl) return { statusCode: 500, body: 'Missing SUPABASE_URL' };
    if (!supabaseAnonKey) return { statusCode: 500, body: 'Missing SUPABASE_ANON_KEY' };
    if (!supabaseServiceRoleKey) return { statusCode: 500, body: 'Missing SUPABASE_SERVICE_ROLE_KEY' };

    const body = event.body ? JSON.parse(event.body) : {};
    const accessToken = String(body?.access_token ?? '').trim();
    const orderId = String(body?.order_id ?? '').trim();
    const docId = String(body?.doc_id ?? '').trim();

    if (!accessToken) return { statusCode: 401, body: 'Missing access_token' };
    if (!orderId) return { statusCode: 400, body: 'Missing order_id' };
    if (!docId) return { statusCode: 400, body: 'Missing doc_id' };

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

    const actorId = userData.user.id;

    const { data: actorProfile } = await supabaseAuth
      .from('staff_profiles')
      .select('role, active')
      .eq('user_id', actorId)
      .maybeSingle();

    if (!actorProfile || actorProfile.active !== true || (actorProfile.role !== 'admin' && actorProfile.role !== 'employee')) {
      return { statusCode: 403, body: 'Forbidden' };
    }

    const admin = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    const { data: orderRow, error: orderErr } = await admin.from('orders').select('id, documents').eq('id', orderId).maybeSingle();
    if (orderErr || !orderRow) return { statusCode: 404, body: 'Order not found' };

    const docs = Array.isArray(orderRow.documents) ? orderRow.documents : [];
    const wanted = docs.find((d) => d && typeof d === 'object' && String(d.id ?? '') === docId) || null;
    if (!wanted) return { statusCode: 404, body: 'Document not found' };

    const storage = wanted.storage && typeof wanted.storage === 'object' ? wanted.storage : null;
    const bucket = String(storage?.bucket ?? '').trim();
    const path = String(storage?.path ?? '').trim();

    if (!bucket || !path) return { statusCode: 404, body: 'Missing storage reference' };

    const { data: signed, error: signErr } = await admin.storage.from(bucket).createSignedUrl(path, 60 * 10);
    if (signErr || !signed?.signedUrl) return { statusCode: 500, body: signErr?.message || 'Failed to sign URL' };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: signed.signedUrl }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
    };
  }
};
