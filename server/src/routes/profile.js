import { Router } from 'express'
import { supabase } from '../config/supabase.js'
import { authenticate } from '../middleware/auth.js'

const router = Router()

router.patch('/', authenticate, async (req, res) => {
  try {
    const updates = {};

    if (typeof req.body.full_name !== 'undefined') {
      updates.full_name = String(req.body.full_name).trim();
    }

    if (typeof req.body.credentials !== 'undefined') {
      const credentials = String(req.body.credentials).trim();
      updates.credentials = credentials || null;
    }

    if (typeof req.body.avatar_url !== 'undefined') {
      const avatar_url = req.body.avatar_url ? String(req.body.avatar_url).trim() : null;
      updates.avatar_url = avatar_url;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid profile fields to update' });
    }

    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', req.user.id)
      .select('role, full_name, credentials, avatar_url')
      .single();

    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router
