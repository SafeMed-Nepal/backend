import { Router } from 'express'
import { supabase } from '../config/supabase.js'
import { authenticate, getStaffFromRequest } from '../middleware/auth.js'
import { createNotification, notifyAdmins } from '../utils/notifications.js'

const router = Router()

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

// GET all remedies (for admin) + symptom filter for users
router.get('/', async (req, res) => {
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
router.get('/:id', async (req, res) => {
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

// CREATE new remedy
router.post('/', authenticate, async (req, res) => {
  try {
    if (!['admin', 'reviewer'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Only reviewers or admins can create remedies' });
    }

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

    if (data) {
      notifyAdmins({
        remedyId: data.id,
        titleEn: `New Remedy Draft Created`,
        titleNe: `नयाँ रेमेडीको मस्यौदा सिर्जना भयो`,
        messageEn: `A new remedy draft "${data.title_en}" has been created by ${req.user.email || 'staff'}.`,
        messageNe: `स्टाफ ${req.user.email || ''} द्वारा नयाँ रेमेडी "${data.title_ne}" को मस्यौदा सिर्जना गरिएको छ।`,
        type: 'new_remedy',
        excludeUserId: req.user.id
      }).catch((e) => console.error('notifyAdmins error:', e));
    }

    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
})

// Update remedy content for authors or admins
router.patch('/:id', authenticate, async (req, res) => {
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
})

// Protected Admin Routes: update remedy status
router.patch('/:id/status', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, review_notes } = req.body;

    if (!['published', 'needs_revision', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    if (!['admin', 'reviewer'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Only reviewers or admins can update remedy status' });
    }

    const { data: currentRemedy, error: fetchErr } = await supabase
      .from('remedies')
      .select('status, warnings_en, warnings_ne, author_id, title_en, title_ne')
      .eq('id', id)
      .eq('is_deleted', false)
      .single();

    if (fetchErr) throw fetchErr;

    if (status === 'published' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only admins can publish remedies' });
    }

    if (status === 'published' && !currentRemedy?.warnings_en && !currentRemedy?.warnings_ne) {
      return res.status(400).json({ success: false, error: 'Warnings are required before publishing a remedy' });
    }

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

    let finalReviewerId = req.user.id;
    let finalReviewerName = reviewerDisplayName;

    if (status === 'published') {
      try {
        // Find the latest approval by a reviewer (doctor)
        const { data: approvals, error: appErr } = await supabase
          .from('remedy_reviews')
          .select('reviewer_id, profiles(full_name, role)')
          .eq('remedy_id', id)
          .eq('decision', 'approve');

        if (!appErr && approvals && approvals.length > 0) {
          // Find the latest approval where the user is a 'reviewer'
          const doctorApproval = approvals.find(app => app.profiles?.role === 'reviewer');
          if (doctorApproval) {
            finalReviewerId = doctorApproval.reviewer_id;
            finalReviewerName = doctorApproval.profiles?.full_name || 'SafeMed Reviewer';
          } else {
            // Fall back to the latest approval if no reviewer-role approval exists
            const anyApproval = approvals[0];
            finalReviewerId = anyApproval.reviewer_id;
            finalReviewerName = anyApproval.profiles?.full_name || 'SafeMed Reviewer';
          }
        }
      } catch (e) {
        console.error('Error fetching doctor approval details:', e.message);
      }
    }

    const updatePayload = {
      status,
      reviewer_id: finalReviewerId,
      reviewer_name: finalReviewerName,
      updated_at: new Date().toISOString(),
    }

    if (status === 'published') {
      updatePayload.verified_at = new Date().toISOString()
      updatePayload.review_notes = null
    }

    if (['needs_revision', 'rejected'].includes(status)) {
      updatePayload.review_notes = typeof review_notes === 'string' ? review_notes.trim() || null : null
    }

    const { data, error } = await supabase
      .from('remedies')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // Map status update to a reviewer decision so it is recorded in remedy_reviews history
    let reviewDecision = null;
    if (status === 'published') reviewDecision = 'approve';
    else if (status === 'needs_revision') reviewDecision = 'needs_revision';
    else if (status === 'rejected') reviewDecision = 'reject';

    if (reviewDecision) {
      try {
        const { error: revErr } = await supabase
          .from('remedy_reviews')
          .upsert({
            remedy_id: id,
            reviewer_id: req.user.id,
            decision: reviewDecision,
            comment: review_notes ? String(review_notes).trim() : null,
            updated_at: new Date().toISOString()
          }, { onConflict: 'remedy_id, reviewer_id' });

        if (revErr) {
          console.error('Failed to log admin decision in remedy_reviews:', revErr.message);
        }
      } catch (revEx) {
        console.error('Failed to log admin decision in remedy_reviews exception:', revEx.message);
      }
    }

    if (currentRemedy && currentRemedy.author_id && currentRemedy.status !== status) {
      let titleEn = `Remedy Status Updated`
      let titleNe = `रेमेडीको स्थिति अपडेट भयो`
      let msgEn = `Your remedy "${currentRemedy.title_en}" has been updated to "${status}".`
      let msgNe = `तपाईंको रेमेडी "${currentRemedy.title_ne}" को स्थिति "${status}" मा अपडेट गरिएको छ।`

      if (status === 'published') {
        titleEn = `Remedy Published! 🌿`
        titleNe = `रेमेडी प्रकाशित भयो! 🌿`
        msgEn = `Congratulations! Your remedy "${currentRemedy.title_en}" has been verified and published.`
        msgNe = `बधाई छ! तपाईंको रेमेडी "${currentRemedy.title_ne}" प्रमाणित र प्रकाशित भएको छ।`
      } else if (status === 'needs_revision') {
        titleEn = `Revision Required ⚠️`
        titleNe = `संसोधन आवश्यक छ ⚠️`
        msgEn = `Your remedy "${currentRemedy.title_en}" requires revisions. Notes: ${review_notes || 'No comments left.'}`
        msgNe = `तपाईंको रेमेडी "${currentRemedy.title_ne}" संसोधन गर्न आवश्यक छ। टिप्पणी: ${review_notes || 'कुनै टिप्पणी छैन।'}`
      } else if (status === 'rejected') {
        titleEn = `Remedy Rejected ❌`
        titleNe = `रेमेडी अस्वीकृत भयो ❌`
        msgEn = `Your remedy "${currentRemedy.title_en}" was rejected during medical review.`
        msgNe = `तपाईंको रेमेडी "${currentRemedy.title_ne}" चिकित्सा समीक्षाको क्रममा अस्वीकृत भयो।`
      }

      createNotification({
        userId: currentRemedy.author_id,
        remedyId: id,
        titleEn,
        titleNe,
        messageEn: msgEn,
        messageNe: msgNe,
        type: 'status_change'
      }).catch((e) => console.error('createNotification status change error:', e))
    }

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
})

// POST or update a review (reviewer action)
router.post('/:id/reviews', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { decision, comment } = req.body;

    if (!['approve', 'needs_revision', 'reject'].includes(decision)) {
      return res.status(400).json({ success: false, error: 'Invalid decision' });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', req.user.id)
      .single();

    if (!profile || !['reviewer', 'admin'].includes(profile.role)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const { data: currentRemedy } = await supabase
      .from('remedies')
      .select('title_en, title_ne, author_id')
      .eq('id', id)
      .single();

    const { data, error } = await supabase
      .from('remedy_reviews')
      .upsert({ remedy_id: id, reviewer_id: req.user.id, decision, comment, updated_at: new Date().toISOString() }, { onConflict: 'remedy_id, reviewer_id' })
      .select();

    if (error) throw error;

    if (currentRemedy) {
      const { data: reviewerProfile } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', req.user.id)
        .single();
      const doctorName = reviewerProfile?.full_name || req.user.email || 'A medical professional';

      if (currentRemedy.author_id && currentRemedy.author_id !== req.user.id) {
        createNotification({
          userId: currentRemedy.author_id,
          remedyId: id,
          titleEn: `New Review Submitted`,
          titleNe: `नयाँ समीक्षा पेस गरियो`,
          messageEn: `${doctorName} submitted a review (${decision}) for your remedy "${currentRemedy.title_en}".`,
          messageNe: `${doctorName} ले तपाईंको रेमेडी "${currentRemedy.title_ne}" को लागि समीक्षा (${decision}) पेस गर्नुभयो।`,
          type: 'new_review'
        }).catch((e) => console.error('createNotification review error:', e));
      }

      notifyAdmins({
        remedyId: id,
        titleEn: `New Review on "${currentRemedy.title_en}"`,
        titleNe: `"${currentRemedy.title_ne}" मा नयाँ समीक्षा`,
        messageEn: `${doctorName} voted "${decision}" on remedy "${currentRemedy.title_en}".`,
        messageNe: `${doctorName} ले रेमेडी "${currentRemedy.title_ne}" मा "${decision}" मतदान गर्नुभएको छ।`,
        type: 'new_review',
        excludeUserId: req.user.id
      }).catch((e) => console.error('notifyAdmins review error:', e));
    }

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
})

// GET aggregated reviews for a remedy
router.get('/:id/reviews', authenticate, async (req, res) => {
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
})

// Soft-delete remedy
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: remedy, error: fetchErr } = await supabase
      .from('remedies')
      .select('*')
      .eq('id', id)
      .eq('is_deleted', false)
      .single();

    if (fetchErr) throw fetchErr;
    if (!remedy) return res.status(404).json({ success: false, error: 'Not found' });

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
})

export default router
