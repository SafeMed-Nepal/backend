import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import remediesRouter from './routes/remedies.js'
import profileRouter from './routes/profile.js'
import contactRouter from './routes/contact.js'
import notificationsRouter from './routes/notifications.js'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3001

const allowedOrigins = process.env.ALLOWED_ORIGIN
  ? process.env.ALLOWED_ORIGIN.split(',').map(item => item.trim())
  : ['http://localhost:5173', 'http://localhost:3000']

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true)
    
    // Check if the origin matches exactly
    if (allowedOrigins.includes(origin)) {
      return callback(null, true)
    }
    
    // Dynamically match Vercel preview/production URLs
    const isVercelUrl = origin.endsWith('.vercel.app') && (
      origin.includes('frontend-') ||
      origin.includes('safemed')
    )

    if (isVercelUrl) {
      return callback(null, true)
    }

    // Fallback: do not send CORS headers for other domains
    return callback(null, false)
  },
  credentials: true
}))

app.use(express.json())

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Routes
app.use('/api/remedies', remediesRouter)
app.use('/api/profile', profileRouter)
app.use('/api/contact', contactRouter)
app.use('/api/notifications', notificationsRouter)

app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`)
})
