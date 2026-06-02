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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// GET all remedies (for admin) + symptom filter for users
app.get('/api/remedies', async (req, res) => {
  try {
    const { symptom } = req.query
    let query = supabase.from('remedies').select('*').order('created_at', { ascending: false })

    if (symptom) {
      query = query.contains('symptom_tags', [symptom])
    } else {
      // For admin, show all; for public, only published
      // We'll improve this with auth later
    }

    const { data, error } = await query
    if (error) throw error

    res.json({ success: true, data: data || [] })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// GET single remedy
app.get('/api/remedies/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('remedies')
      .select('*')
      .eq('id', req.params.id)
      .single()

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

    const { data, error } = await supabase
      .from('remedies')
      .update({ 
        status,
        reviewer_name: req.user.email || 'Reviewer',
        updated_at: new Date().toISOString()
      })
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
app.post('/api/remedies', async (req, res) => {
  try {
    const { title_en, title_ne, description_en, description_ne, ingredients_en, ingredients_ne,
            steps_en, steps_ne, precautions_en, warnings_en, symptom_tags, status = 'draft' } = req.body;

    const { data, error } = await supabase
      .from('remedies')
      .insert({
        title_en,
        title_ne,
        description_en,
        description_ne,
        ingredients_en,
        ingredients_ne,
        steps_en,
        steps_ne,
        precautions_en,
        warnings_en,
        symptom_tags: symptom_tags || [],
        status
      })
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