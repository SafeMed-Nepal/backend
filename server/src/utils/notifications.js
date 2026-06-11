import { supabase } from '../config/supabase.js'

/**
 * Inserts a notification into the notifications table for a specific user.
 */
export async function createNotification({
  userId,
  remedyId,
  titleEn,
  titleNe,
  messageEn,
  messageNe,
  type
}) {
  try {
    const { error } = await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        remedy_id: remedyId,
        title_en: titleEn,
        title_ne: titleNe,
        message_en: messageEn,
        message_ne: messageNe,
        type,
        status: 'unread',
        created_at: new Date().toISOString()
      })

    if (error) {
      console.error('Failed to create notification in db:', error.message)
    }
  } catch (err) {
    console.error('Failed to create notification exception:', err.message)
  }
}

/**
 * Distributes a notification to all user profiles with 'admin' or 'reviewer' roles.
 */
export async function notifyStaff({
  remedyId,
  titleEn,
  titleNe,
  messageEn,
  messageNe,
  type,
  excludeUserId = null
}) {
  try {
    let query = supabase
      .from('profiles')
      .select('id')
      .in('role', ['admin', 'reviewer'])

    if (excludeUserId) {
      query = query.neq('id', excludeUserId)
    }

    const { data: staff, error } = await query

    if (error) throw error

    if (staff && staff.length > 0) {
      const inserts = staff.map((member) => ({
        user_id: member.id,
        remedy_id: remedyId,
        title_en: titleEn,
        title_ne: titleNe,
        message_en: messageEn,
        message_ne: messageNe,
        type,
        status: 'unread',
        created_at: new Date().toISOString()
      }))

      const { error: insErr } = await supabase
        .from('notifications')
        .insert(inserts)

      if (insErr) {
        console.error('Failed to insert staff notifications:', insErr.message)
      }
    }
  } catch (err) {
    console.error('Failed to notify staff exception:', err.message)
  }
}

/**
 * Distributes a notification to all user profiles with the 'admin' role.
 * Kept for backwards compatibility.
 */
export async function notifyAdmins(params) {
  return notifyStaff(params)
}

