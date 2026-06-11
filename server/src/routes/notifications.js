import { Router } from 'express'
import { supabase } from '../config/supabase.js'
import { authenticate } from '../middleware/auth.js'

const router = Router()

// GET /api/notifications - Get last 50 notifications for logged-in user
router.get('/', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) throw error
    res.json({ success: true, data: data || [] })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// PATCH /api/notifications/:id - Toggle status (read/unread)
router.patch('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params
    const { status } = req.body

    if (!['unread', 'read'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status parameter' })
    }

    const { data, error } = await supabase
      .from('notifications')
      .update({ status })
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select()
      .single()

    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// POST /api/notifications/mark-all-read - Mark all of user's unread notifications as read
router.post('/mark-all-read', authenticate, async (req, res) => {
  try {
    const { error } = await supabase
      .from('notifications')
      .update({ status: 'read' })
      .eq('user_id', req.user.id)
      .eq('status', 'unread')

    if (error) throw error
    res.json({ success: true, message: 'All notifications marked as read' })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

export default router
