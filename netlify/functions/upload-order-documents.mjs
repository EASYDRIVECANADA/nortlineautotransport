import { createClient } from '@supabase/supabase-js';

const BUCKET = 'order-documents';

const sanitizeFilename = (name) => {
  const base = String(name ?? '').trim() || 'document';
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160);
};

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
    const orderCode = String(body?.order_code ?? '').trim();
    const filesRaw = Array.isArray(body?.files) ? body.files : [];

    if (!accessToken) return { statusCode: 401, body: 'Missing access_token' };
    if (!orderCode) return { statusCode: 400, body: 'Missing order_code' };
    if (!filesRaw.length) return { statusCode: 400, body: 'Missing files' };

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

    const admin = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    try {
      await admin.storage.createBucket(BUCKET, { public: false });
    } catch {
      // ignore
    }

    const { data: orderRow, error: orderErr } = await admin
      .from('orders')
      .select('id, order_code, user_id, documents')
      .eq('order_code', orderCode)
      .maybeSingle();

    if (orderErr || !orderRow?.id) return { statusCode: 404, body: 'Order not found' };
    if (String(orderRow.user_id ?? '').trim() !== userId) return { statusCode: 403, body: 'Forbidden' };

    const now = new Date().toISOString();

    const existingDocs = Array.isArray(orderRow.documents) ? orderRow.documents : [];

    const uploadedDocs = [];

    for (let i = 0; i < filesRaw.length; i += 1) {
      const f = filesRaw[i] && typeof filesRaw[i] === 'object' ? filesRaw[i] : null;
      if (!f) continue;

      const name = sanitizeFilename(f.name);
      const mime = String(f.type ?? '').trim() || 'application/octet-stream';
      const size = Number(f.size ?? 0);
      const base64 = String(f.base64 ?? '').trim();
      const docType = String(f.docType ?? '').trim();

      if (!base64) continue;

      const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const path = `${sanitizeFilename(orderCode)}/${id}_${name}`;

      const buf = Buffer.from(base64, 'base64');

      const { error: upErr } = await admin.storage.from(BUCKET).upload(path, buf, {
        contentType: mime,
        upsert: true,
      });

      if (upErr) {
        return { statusCode: 500, body: upErr.message || 'Upload failed' };
      }

      uploadedDocs.push({
        id,
        name: String(f.name ?? name),
        mime,
        size: Number.isFinite(size) ? size : buf.length,
        kind: docType === 'release_form' || docType === 'work_order' ? 'required' : docType ? 'optional' : 'unknown',
        storage: {
          bucket: BUCKET,
          path,
        },
      });
    }

    if (!uploadedDocs.length) return { statusCode: 400, body: 'No valid files to upload' };

    const nextDocs = [...uploadedDocs, ...existingDocs];

    const { error: updateErr } = await admin
      .from('orders')
      .update({ documents: nextDocs, updated_at: now })
      .eq('id', orderRow.id);

    if (updateErr) return { statusCode: 500, body: updateErr.message || 'Failed to update order' };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, uploaded: uploadedDocs.length }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
    };
  }
};
