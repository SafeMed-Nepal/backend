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
    .select('role, full_name, credentials')
    .eq('id', user.id)
    .single()

  if (!profile || !['admin', 'reviewer'].includes(profile.role)) return null

  return {
    id: user.id,
    email: user.email,
    role: profile.role,
    full_name: profile.full_name,
    credentials: profile.credentials,
  }
}

async function enrichRemedies(remedies) {
  const rows = remedies || []
  const reviewerIds = [...new Set(rows.map((r) => r.reviewer_id).filter(Boolean))]

  if (reviewerIds.length === 0) {
    return rows.map((r) => ({ ...r, reviewer_credentials: null }))
  }

  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('id, credentials')
    .in('id', reviewerIds)

  if (error) throw error

  const credentialsById = (profiles || []).reduce((acc, profile) => {
    acc[profile.id] = profile.credentials || null
    return acc
  }, {})

  return rows.map((r) => ({
    ...r,
    reviewer_credentials: credentialsById[r.reviewer_id] || null,
  }))
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
    const rawLimit = parseInt(req.query.limit || '10', 10);
    const limit = Math.min(Math.max(rawLimit, 1), 50);
    const start = (Math.max(page, 1) - 1) * limit;
    const end = start + limit - 1;

    let query = supabase.from('remedies').select('*', { count: 'exact' }).order('created_at', { ascending: false })
    query = query.eq('is_deleted', false)

    if (!staff) {
      query = query.eq('status', 'published')
    }

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

    const withReviewerDetails = await enrichRemedies(data)
    const enriched = withReviewerDetails.map((r) => ({ ...r, review_counts: reviewMap[r.id] || { approve: 0, needs_revision: 0, reject: 0 } }));

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
      .eq('is_deleted', false)

    if (!staff) {
      query = query.eq('status', 'published')
    }

    const { data, error } = await query.single()

    if (error) throw error
    if (!data) return res.status(404).json({ success: false, error: 'Not found' })

    const [enriched] = await enrichRemedies([data])
    res.json({ success: true, data: enriched })
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

app.patch('/api/profile', authenticate, async (req, res) => {
  try {
    const updates = {};

    if (typeof req.body.full_name !== 'undefined') {
      updates.full_name = String(req.body.full_name).trim();
    }

    if (typeof req.body.credentials !== 'undefined') {
      const credentials = String(req.body.credentials).trim();
      updates.credentials = credentials || null;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid profile fields to update' });
    }

    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', req.user.id)
      .select('role, full_name, credentials')
      .single();

    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Protected Admin Routes
app.patch('/api/remedies/:id/status', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, review_notes } = req.body;

    if (!['published', 'needs_revision', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    if (!['admin', 'reviewer'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Only reviewers or admins can update remedy status' });
    }

    // Fetch current remedy to enforce publish/change rules
    const { data: currentRemedy, error: fetchErr } = await supabase
      .from('remedies')
      .select('status, warnings_en, warnings_ne')
      .eq('id', id)
      .eq('is_deleted', false)
      .single();

    if (fetchErr) throw fetchErr;

    // Prevent non-admin users from publishing
    if (status === 'published' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only admins can publish remedies' });
    }

    if (status === 'published' && !currentRemedy?.warnings_en && !currentRemedy?.warnings_ne) {
      return res.status(400).json({ success: false, error: 'Warnings are required before publishing a remedy' });
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
      updatePayload.review_notes = null
    }

    if (['needs_revision', 'rejected'].includes(status)) {
      updatePayload.review_notes = typeof review_notes === 'string' ? review_notes.trim() || null : null
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

// Update remedy content for authors or admins
app.patch('/api/remedies/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const allowedFields = [
      'title_en', 'title_ne', 'description_en', 'description_ne',
      'ingredients_en', 'ingredients_ne', 'steps_en', 'steps_ne',
      'precautions_en', 'precautions_ne', 'warnings_en', 'warnings_ne',
      'symptom_tags', 'status', 'video_url', 'source_url', 'source_label',
      'review_notes'
    ];

    const updates = {};
    for (const key of Object.keys(req.body)) {
      if (allowedFields.includes(key)) {
        updates[key] = req.body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }

    const { data: currentRemedy, error: fetchErr } = await supabase
      .from('remedies')
      .select('author_id, status')
      .eq('id', id)
      .eq('is_deleted', false)
      .single();

    if (fetchErr) throw fetchErr;
    if (!currentRemedy) {
      return res.status(404).json({ success: false, error: 'Remedy not found' });
    }

    if (currentRemedy.status === 'published' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only admins can edit published remedies' });
    }

    const isAuthor = currentRemedy.author_id === req.user.id;
    const isAdmin = req.user.role === 'admin';
    if (!isAdmin && !isAuthor) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('remedies')
      .update(updates)
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

    const { data: reviewRows, error: reviewErr } = await supabase
      .from('remedy_reviews')
      .select('decision')
      .eq('remedy_id', id);

    if (reviewErr) throw reviewErr;

    const countsObj = { approve: 0, needs_revision: 0, reject: 0 };
    (reviewRows || []).forEach((row) => {
      if (row?.decision && Object.prototype.hasOwnProperty.call(countsObj, row.decision)) {
        countsObj[row.decision] += 1;
      }
    });

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
      const { data: profiles, error: profileErr } = await supabase
      .from('profiles')
      .select('id, full_name, credentials')
      .in('id', reviewerIds);

      if (profileErr) throw profileErr;

      reviewerMap = (profiles || []).reduce((acc, p) => {
        acc[p.id] = {
          name: p.full_name || null,
          credentials: p.credentials || null,
        };
        return acc;
      }, {});
    }

    const recentWithNames = (recent || []).map((r) => ({
      reviewer_id: r.reviewer_id,
      reviewer_name: reviewerMap[r.reviewer_id]?.name || null,
      reviewer_credentials: reviewerMap[r.reviewer_id]?.credentials || null,
      decision: r.decision,
      comment: r.comment,
      updated_at: r.updated_at,
    }));

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
      .eq('is_deleted', false)
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
    if (!['admin', 'reviewer'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Only reviewers or admins can create remedies' });
    }

    // Build payload only from provided fields to avoid DB errors if optional
    // columns (like *_ne) are not present yet in the database.
    const allowedFields = [
      'title_en','title_ne','description_en','description_ne',
      'ingredients_en','ingredients_ne','steps_en','steps_ne',
      'precautions_en','precautions_ne','warnings_en','warnings_ne',
      'symptom_tags','status','video_url','source_url','source_label',
      'review_notes'
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
