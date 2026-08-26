// supabase/functions/auth/index.ts
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  const url = new URL(req.url)
  const path = url.pathname.replace('/auth', '')

  // ---- Signup ----
  if (path === '/signup' && req.method === 'POST') {
    try {
      const body = await req.json()
      const { accountType, fullName, email, phone, nationalId, password } = body

      // Hash password
      const bcrypt = require('bcryptjs')
      const passwordHash = await bcrypt.hash(password, 12)

      // Generate OTP
      const otp = String(Math.floor(100000 + Math.random() * 900000))
      const otpHash = await bcrypt.hash(otp, 8)
      const otpExpires = new Date(Date.now() + 10 * 60 * 1000)

      // Insert user
      const { data: user, error } = await supabase
        .from('users')
        .insert({
          account_type: accountType,
          full_name: fullName,
          email: email.toLowerCase().trim(),
          phone: phone,
          national_id: nationalId,
          password_hash: passwordHash,
          otp_code_hash: otpHash,
          otp_expires_at: otpExpires.toISOString(),
          email_verified: false,
        })
        .select('id, account_type, full_name, email, phone')
        .single()

      if (error) throw error

      // Send OTP email (using Brevo)
      await sendOtpEmail(email, fullName, otp)

      return new Response(
        JSON.stringify({
          message: 'Account created. Check your email for OTP.',
          user,
          requiresOtp: true,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  // ---- Login ----
  if (path === '/login' && req.method === 'POST') {
    try {
      const body = await req.json()
      const { emailOrPhone, password } = body

      const { data: user, error } = await supabase
        .from('users')
        .select('*')
        .or(`email.eq.${emailOrPhone},phone.eq.${emailOrPhone}`)
        .single()

      if (error || !user) {
        return new Response(
          JSON.stringify({ error: 'Invalid credentials' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const bcrypt = require('bcryptjs')
      const valid = await bcrypt.compare(password, user.password_hash)

      if (!valid) {
        return new Response(
          JSON.stringify({ error: 'Invalid credentials' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      return new Response(
        JSON.stringify({
          user: {
            id: user.id,
            accountType: user.account_type,
            fullName: user.full_name,
            email: user.email,
          },
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  return new Response(
    JSON.stringify({ error: 'Not found' }),
    { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
})

// Helper function to send email using Brevo
async function sendOtpEmail(email, fullName, code) {
  const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY')
  if (!BREVO_API_KEY) return

  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender: { email: 'semacheck254@gmail.com', name: 'SemaCheck' },
      to: [{ email }],
      subject: `Your SemaCheck verification code: ${code}`,
      htmlContent: `<h2>Your Verification Code</h2><p>Hi ${fullName || ''},</p><p>Your code is: <strong>${code}</strong></p>`,
    }),
  })
}