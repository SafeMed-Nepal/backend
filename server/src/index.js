import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import remediesRouter from './routes/remedies.js'
import profileRouter from './routes/profile.js'
import contactRouter from './routes/contact.js'

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

// Routes
app.use('/api/remedies', remediesRouter)
app.use('/api/profile', profileRouter)
app.use('/api/contact', contactRouter)

app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`)
})
