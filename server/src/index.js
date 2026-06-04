import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { supabase } from './config/supabase.js'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || 'http://localhost:5173',
  credentials: true
}))

app.use(express.json())

async function getStaffFromRequest(req) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return null

  const token = authHeader.split(' ')[1]
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return null

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, full_name')
    .eq('id', user.id)
    .single()

  if (!profile || !['admin', 'reviewer'].includes(profile.role)) return null

  return {
    id: user.id,
    email: user.email,
    role: profile.role,
    full_name: profile.full_name,
  }
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// GET all remedies (for admin) + symptom filter for users
app.get('/api/remedies', async (req, res) => {
  try {
    const { symptom } = req.query
    const staff = await getStaffFromRequest(req)
    // pagination
    const page = parseInt(req.query.page || '1', 10);
    const limit = parseInt(req.query.limit || '10', 10);
    const start = (Math.max(page, 1) - 1) * limit;
    const end = start + limit - 1;

    let query = supabase.from('remedies').select('*', { count: 'exact' }).order('created_at', { ascending: false })

    if (!staff) {
      query = query.eq('status', 'published')
    }

    if (symptom) {
      query = query.contains('symptom_tags', [symptom])
    }

    // apply symptom filter before range
    if (symptom) {
      query = query.contains('symptom_tags', [symptom])
    }

    const { data, error, count } = await query.range(start, end)
    if (error) throw error

    // fetch aggregated review counts for the returned remedies
    const remedyIds = (data || []).map((r) => r.id).filter(Boolean);
    let reviewMap = {};
    if (remedyIds.length > 0) {
      // Supabase JS client may not support .group() in all versions; fetch rows and aggregate in JS
      const { data: revRows, error: revErr } = await supabase
        .from('remedy_reviews')
        .select('remedy_id, decision')
        .in('remedy_id', remedyIds);

      if (revErr) throw revErr;

      (revRows || []).forEach((row) => {
        reviewMap[row.remedy_id] = reviewMap[row.remedy_id] || { approve: 0, needs_revision: 0, reject: 0 };
        const d = row.decision;
        reviewMap[row.remedy_id][d] = (reviewMap[row.remedy_id][d] || 0) + 1;
      });
    }

    const enriched = (data || []).map((r) => ({ ...r, review_counts: reviewMap[r.id] || { approve: 0, needs_revision: 0, reject: 0 } }));

    res.json({ success: true, data: enriched, count: count || 0 })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// GET single remedy
app.get('/api/remedies/:id', async (req, res) => {
  try {
    const staff = await getStaffFromRequest(req)
    let query = supabase
      .from('remedies')
      .select('*')
      .eq('id', req.params.id)

    if (!staff) {
      query = query.eq('status', 'published')
    }

    const { data, error } = await query.single()

    if (error) throw error
    if (!data) return res.status(404).json({ success: false, error: 'Not found' })

    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})



// Supabase Auth Middleware (simple version)
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Get role from profiles
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    req.user = {
      id: user.id,
      email: user.email,
      role: profile?.role || 'user',
    };
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(401).json({ error: 'Authentication failed' });
  }
};

// Protected Admin Routes
app.patch('/api/remedies/:id/status', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['published', 'needs_revision', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Fetch current remedy to enforce publish/change rules
    const { data: currentRemedy, error: fetchErr } = await supabase
      .from('remedies')
      .select('status')
      .eq('id', id)
      .single();

    if (fetchErr) throw fetchErr;

    // Prevent non-admin users from publishing
    if (status === 'published' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only admins can publish remedies' });
    }

    // Prevent changes to already-published remedies by non-admins
    if (currentRemedy?.status === 'published' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only admins can modify published remedies' });
    }

    const { data: reviewerProfile } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('id', req.user.id)
      .single()

    const reviewerDisplayName =
      reviewerProfile?.full_name || req.user.email || 'SafeMed Reviewer'

    const updatePayload = {
      status,
      reviewer_id: req.user.id,
      reviewer_name: reviewerDisplayName,
      updated_at: new Date().toISOString(),
    }

    if (status === 'published') {
      updatePayload.verified_at = new Date().toISOString()
      updatePayload.verified_by_admin = req.user.id
    }

    // Only reviewers/admins are allowed to update status via auth middleware.
    const { data, error } = await supabase
      .from('remedies')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST or update a review (reviewer action)
app.post('/api/remedies/:id/reviews', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { decision, comment } = req.body;

    if (!['approve', 'needs_revision', 'reject'].includes(decision)) {
      return res.status(400).json({ success: false, error: 'Invalid decision' });
    }

    // Only allow reviewers or admins to submit reviews
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', req.user.id)
      .single();

    if (!profile || !['reviewer', 'admin'].includes(profile.role)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    // Upsert review
    const { data, error } = await supabase
      .from('remedy_reviews')
      .upsert({ remedy_id: id, reviewer_id: req.user.id, decision, comment, updated_at: new Date().toISOString() }, { onConflict: 'remedy_id, reviewer_id' })
      .select();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET aggregated reviews for a remedy (counts + recent decisions)
app.get('/api/remedies/:id/reviews', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: counts, error: countsErr } = await supabase
      .from('remedy_reviews')
      .select('decision, count:count(*)')
      .eq('remedy_id', id)
      .group('decision');

    if (countsErr) throw countsErr;

    const { data: recent, error: recentErr } = await supabase
      .from('remedy_reviews')
      .select('reviewer_id, decision, comment, updated_at')
      .eq('remedy_id', id)
      .order('updated_at', { ascending: false })
      .limit(10);

    if (recentErr) throw recentErr;

    // Fetch reviewer display names for recent reviewers
    const reviewerIds = (recent || []).map((r) => r.reviewer_id).filter(Boolean);
    let reviewerMap = {};
    if (reviewerIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', reviewerIds);
      reviewerMap = (profiles || []).reduce((acc, p) => {
        acc[p.id] = p.full_name || null;
        return acc;
      }, {});
    }

    const recentWithNames = (recent || []).map((r) => ({
      reviewer_id: r.reviewer_id,
      reviewer_name: reviewerMap[r.reviewer_id] || null,
      decision: r.decision,
      comment: r.comment,
      updated_at: r.updated_at,
    }));

    // normalize counts array into object { approve: n, needs_revision: n, reject: n }
    const countsObj = { approve: 0, needs_revision: 0, reject: 0 };
    (counts || []).forEach((c) => {
      const key = c.decision;
      countsObj[key] = parseInt(c.count, 10) || 0;
    });

    res.json({ success: true, counts: countsObj, recent: recentWithNames });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Soft-delete remedy
app.delete('/api/remedies/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch remedy to check permissions
    const { data: remedy, error: fetchErr } = await supabase
      .from('remedies')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr) throw fetchErr;
    if (!remedy) return res.status(404).json({ success: false, error: 'Not found' });

    // Only allow deletion if owner and draft, or admin
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', req.user.id)
      .single();

    const isOwner = remedy.author_id === req.user.id;
    const isAdmin = profile?.role === 'admin';

    if (!(isAdmin || (isOwner && remedy.status === 'draft'))) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const { data, error } = await supabase
      .from('remedies')
      .update({ is_deleted: true, deleted_by: req.user.id, deleted_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// CREATE new remedy (Admin only)
// CREATE new remedy (authenticated users)
app.post('/api/remedies', authenticate, async (req, res) => {
  try {
    const { title_en, title_ne, description_en, description_ne, ingredients_en, ingredients_ne,
            steps_en, steps_ne, precautions_en, precautions_ne, warnings_en, warnings_ne, symptom_tags, status = 'draft' } = req.body;

    // Build payload only from provided fields to avoid DB errors if optional
    // columns (like *_ne) are not present yet in the database.
    const allowedFields = [
      'title_en','title_ne','description_en','description_ne',
      'ingredients_en','ingredients_ne','steps_en','steps_ne',
      'precautions_en','precautions_ne','warnings_en','warnings_ne',
      'symptom_tags','status'
    ];

    const payload = {};
    for (const key of allowedFields) {
      if (typeof req.body[key] !== 'undefined') payload[key] = req.body[key];
    }

    payload.author_id = req.user.id;
    payload.is_deleted = false;
    payload.created_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('remedies')
      .insert(payload)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`)
})