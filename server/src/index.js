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
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    message: 'SafeMed Nepal Backend is running'
  })
})

// GET all published remedies
app.get('/api/remedies', async (req, res) => {
  try {
    const { symptom } = req.query
    
    let query = supabase
      .from('remedies')
      .select('*')
      .eq('status', 'published')
      .order('created_at', { ascending: false })

    // Filter by symptom if provided
    if (symptom) {
      query = query.contains('symptom_tags', [symptom])
    }

    const { data, error } = await query

    if (error) throw error
    
    res.json({
      success: true,
      count: data ? data.length : 0,
      data: data || []
    })
  } catch (err) {
    console.error('Error fetching remedies:', err)
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch remedies',
      message: err.message 
    })
  }
})

// GET single remedy by ID
app.get('/api/remedies/:id', async (req, res) => {
  try {
    const { id } = req.params
    
    const { data, error } = await supabase
      .from('remedies')
      .select('*')
      .eq('id', id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ success: false, error: 'Remedy not found' })

    res.json({
      success: true,
      data: data
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ success: false, error: 'Failed to fetch remedy' })
  }
})

app.listen(PORT, () => {
  console.log(`🚀 SafeMed Backend running on http://localhost:${PORT}`)
  console.log(`✅ Health: http://localhost:${PORT}/api/health`)
  console.log(`✅ Remedies: http://localhost:${PORT}/api/remedies`)
})