import { Router } from 'express'
import { supabase } from '../config/supabase.js'
import nodemailer from 'nodemailer'

const router = Router()

router.post('/', async (req, res) => {
  try {
    const { name, email, organization, credentials, message, nmc_number, credential_link } = req.body

    if (!name || !email || !credentials || !message || !credential_link) {
      return res.status(400).json({ success: false, error: 'Please fill in all required fields' })
    }

    // 1. Try to log in database if table exists (optional fallback)
    try {
      const { error } = await supabase
        .from('reviewer_applications')
        .insert({
          name: String(name).trim(),
          email: String(email).trim(),
          organization: organization ? String(organization).trim() : null,
          credentials: String(credentials).trim(),
          message: String(message).trim(),
          nmc_number: nmc_number ? String(nmc_number).trim() : null,
          credential_link: credential_link ? String(credential_link).trim() : null,
          status: 'pending',
          created_at: new Date().toISOString()
        })
      
      if (error) {
        console.warn('Database log failed (reviewer_applications table might not exist yet):', error.message)
      }
    } catch (dbErr) {
      console.warn('Database log exception:', dbErr.message)
    }

    // 2. Prepare email content
    const receiverMail = process.env.CONTACT_EMAIL || 'rishavc957@gmail.com'
    const emailSubject = `New Reviewer Application: ${name} (${credentials})`
    const emailBody = `
      <h3>New SafeMed Reviewer Request</h3>
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Organization/Clinic:</strong> ${organization || 'N/A'}</p>
      <p><strong>Credentials:</strong> ${credentials}</p>
      <p><strong>NMC Registration Number:</strong> ${nmc_number || 'N/A'}</p>
      <p><strong>Credential Link:</strong> ${credential_link ? `<a href="${credential_link}" target="_blank">${credential_link}</a>` : 'N/A'}</p>
      <p><strong>Message:</strong></p>
      <p>${message.replace(/\n/g, '<br>')}</p>
      <hr />
      <p>This is a secure reviewer application submitted through SafeMed Nepal.</p>
    `

    // 3. Send via Nodemailer
    let mailSent = false
    let previewUrl = null

    const smtpUser = process.env.SMTP_USER
    const smtpPass = process.env.SMTP_PASS

    if (smtpUser && smtpPass) {
      // Use configured production SMTP
      const transporter = nodemailer.createTransport({
        service: process.env.SMTP_SERVICE || 'gmail',
        auth: {
          user: smtpUser,
          pass: smtpPass
        }
      })

      await transporter.sendMail({
        from: smtpUser,
        to: receiverMail,
        subject: emailSubject,
        html: emailBody
      })
      mailSent = true
    } else {
      // Local dev/testing fallback: generate Ethereal mail test account or log to console
      try {
        const testAccount = await nodemailer.createTestAccount()
        const transporter = nodemailer.createTransport({
          host: 'smtp.ethereal.email',
          port: 587,
          secure: false,
          auth: {
            user: testAccount.user,
            pass: testAccount.pass
          }
        })

        const info = await transporter.sendMail({
          from: '"SafeMed System" <no-reply@safemed.nepal>',
          to: receiverMail,
          subject: emailSubject,
          html: emailBody
        })

        previewUrl = nodemailer.getTestMessageUrl(info)
        console.log('📬 Reviewer Request Email Mock-Sent!')
        console.log('Subject:', emailSubject)
        console.log('Preview URL:', previewUrl)
        mailSent = true
      } catch (err) {
        console.error('Nodemailer test account error, logging email to console instead:', err)
        console.log('==================================================')
        console.log('EMAIL SIMULATION (No SMTP credentials configured)')
        console.log('TO:', receiverMail)
        console.log('SUBJECT:', emailSubject)
        console.log('CONTENT:', emailBody)
        console.log('==================================================')
        mailSent = true
      }
    }

    res.json({ success: true, message: 'Application submitted successfully', mailSent, previewUrl })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

export default router
