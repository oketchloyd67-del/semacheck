// supabase/functions/auth/index.ts
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import * as bcrypt from 'https://deno.land/x/bcrypt@v0.4.1/mod.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

// Public routes that don't require authentication
const PUBLIC_ROUTES = ['/login', '/signup', '/health', '/verify-otp', '/resend-otp']

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const url = new URL(req.url)
  const path = url.pathname.replace('/auth', '')
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  // Check if route is public
  const isPublic = PUBLIC_ROUTES.some(route => path.startsWith(route))

  // Only check authorization for protected routes
  if (!isPublic) {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const token = authHeader.split(' ')[1]
    const { data: { user }, error } = await supabase.auth.getUser(token)
    
    if (error || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  // ---- Signup ----
  if (path === '/signup' && req.method === 'POST') {
    try {
      const body = await req.json()
      const { accountType, fullName, email, phone, nationalId, password, consentAccepted } = body

      // Hash password
      const passwordHash = await bcrypt.hash(password, 12)

      // Generate OTP
      const otp = String(Math.floor(100000 + Math.random() * 900000))
      const otpHash = await bcrypt.hash(otp, 8)
      const otpExpires = new Date(Date.now() + 10 * 60 * 1000)

      // Insert user
      const { data: user, error } = await supabase
        .from('users')
        .insert({
          account_type: accountType || 'regular',
          full_name: fullName,
          email: email.toLowerCase().trim(),
          phone: phone,
          national_id: nationalId,
          password_hash: passwordHash,
          otp_code_hash: otpHash,
          otp_expires_at: otpExpires.toISOString(),
          email_verified: false,
          privacy_consent_at: consentAccepted ? new Date().toISOString() : null,
        })
        .select('id, account_type, full_name, email, phone')
        .single()

      if (error) throw error

      // Send OTP email
      await sendOtpEmail(email, fullName, otp)

      return new Response(
        JSON.stringify({
          message: 'Account created. Check your email for OTP.',
          user,
          requiresOtp: true,
        }),
        { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
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
      const { phone, password } = body

      const { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('phone', phone)
        .single()

      if (error || !user) {
        return new Response(
          JSON.stringify({ error: 'Invalid phone number or password' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const valid = await bcrypt.compare(password, user.password_hash)

      if (!valid) {
        return new Response(
          JSON.stringify({ error: 'Invalid phone number or password' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Generate JWT token
      const jwt = await import('https://deno.land/x/jose@v4.14.4/index.js')
      const token = await new jwt.SignJWT({ 
        id: user.id, 
        phone: user.phone,
        email: user.email 
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime('7d')
        .sign(new TextEncoder().encode(Deno.env.get('JWT_SECRET') || 'your-secret-key'))

      return new Response(
        JSON.stringify({
          token,
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

  // ---- Verify OTP ----
  if (path === '/verify-otp' && req.method === 'POST') {
    try {
      const body = await req.json()
      const { email, code } = body

      const { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('email', email.toLowerCase().trim())
        .single()

      if (error || !user) {
        return new Response(
          JSON.stringify({ error: 'User not found' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      if (user.email_verified) {
        return new Response(
          JSON.stringify({ error: 'Email already verified' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      if (new Date(user.otp_expires_at) < new Date()) {
        return new Response(
          JSON.stringify({ error: 'OTP expired. Request a new one.' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const valid = await bcrypt.compare(code, user.otp_code_hash)

      if (!valid) {
        return new Response(
          JSON.stringify({ error: 'Invalid OTP code' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Mark email as verified
      await supabase
        .from('users')
        .update({ 
          email_verified: true, 
          otp_code_hash: null, 
          otp_expires_at: null 
        })
        .eq('id', user.id)

      return new Response(
        JSON.stringify({
          message: 'Email verified successfully',
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

  // ---- Health check ----
  if (path === '/health' && req.method === 'GET') {
    return new Response(
      JSON.stringify({ status: 'ok' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
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
      htmlContent: `<h2>Your Verification Code</h2><p>Hi ${fullName || ''},</p><p>Your code is: <strong>${code}</strong></p><p>This code expires in 10 minutes.</p>`,
    }),
  })
}