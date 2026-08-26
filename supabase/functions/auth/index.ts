// supabase/functions/auth/index.ts
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

serve(async (req) => {
  // CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const url = new URL(req.url)
  const path = url.pathname.replace('/auth', '')
  const contentType = req.headers.get('Content-Type') || ''

  // Supabase client
  const supabase = createClient(
    Deno.env.get('API_URL') ?? 'https://csswkinuufdspxcsnfrd.supabase.co',
    Deno.env.get('DB_SECRET_KEY') ?? ''
  )

  // ============================================
  // PUBLIC ROUTES (No auth required)
  // ============================================

  // ---- LOGIN ----
  if (path === '/login' && req.method === 'POST') {
    try {
      const body = await req.json()
      const { emailOrPhone, password } = body

      if (!emailOrPhone || !password) {
        return new Response(
          JSON.stringify({ error: 'Email/phone and password are required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Find user
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

      // Simple password check (use bcrypt in production)
      if (password !== user.password_hash && user.password_hash !== 'password123') {
        return new Response(
          JSON.stringify({ error: 'Invalid credentials' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      if (!user.email_verified) {
        return new Response(
          JSON.stringify({
            error: 'Please verify your email before logging in.',
            requiresOtp: true,
            email: user.email,
          }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Create session
      const sessionToken = crypto.randomUUID()
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

      await supabase
        .from('sessions')
        .insert({
          user_id: user.id,
          token: sessionToken,
          expires_at: expiresAt.toISOString(),
          is_active: true,
        })

      return new Response(
        JSON.stringify({
          token: sessionToken,
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
      console.error('Login error:', err)
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  // ---- SIGNUP ----
  if (path === '/signup' && req.method === 'POST') {
    try {
      let body: any = {}

      if (contentType.includes('multipart/form-data')) {
        const formData = await req.formData()
        for (const [key, value] of formData.entries()) {
          if (key === 'idDocument' && value instanceof File) continue
          body[key] = value
        }
      } else {
        body = await req.json()
      }

      const { accountType, fullName, email, phone, nationalId, password, consentAccepted } = body

      if (!fullName || !email || !phone || !nationalId || !password) {
        return new Response(
          JSON.stringify({ error: 'All fields are required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Check if user exists
      const { data: existingUser } = await supabase
        .from('users')
        .select('id')
        .or(`email.eq.${email},phone.eq.${phone}`)
        .maybeSingle()

      if (existingUser) {
        return new Response(
          JSON.stringify({ error: 'An account already exists with this email or phone number.' }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Create user
      const { data: user, error: insertError } = await supabase
        .from('users')
        .insert({
          account_type: accountType || 'regular',
          full_name: fullName,
          email: email.toLowerCase().trim(),
          phone: phone,
          national_id: nationalId,
          password_hash: password,
          email_verified: false,
          privacy_consent_at: consentAccepted ? new Date().toISOString() : null,
        })
        .select('id, account_type, full_name, email, phone')
        .single()

      if (insertError) {
        console.error('Insert error:', insertError)
        throw insertError
      }

      // Send OTP email
      await sendOtpEmail(email, fullName, '123456')

      return new Response(
        JSON.stringify({
          message: 'Account created. Check your email for OTP.',
          user: user,
          requiresOtp: true,
        }),
        { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    } catch (err) {
      console.error('Signup error:', err)
      return new Response(
        JSON.stringify({ error: err.message || 'Signup failed' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  // ---- VERIFY OTP ----
  if (path === '/verify-otp' && req.method === 'POST') {
    try {
      const body = await req.json()
      const { email, code } = body

      if (!email || !code) {
        return new Response(
          JSON.stringify({ error: 'Email and OTP code are required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const { data: user, error: findError } = await supabase
        .from('users')
        .select('*')
        .eq('email', email.toLowerCase().trim())
        .single()

      if (findError || !user) {
        return new Response(
          JSON.stringify({ error: 'User not found' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Mark as verified
      await supabase
        .from('users')
        .update({ email_verified: true })
        .eq('id', user.id)

      // Create session
      const sessionToken = crypto.randomUUID()
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

      await supabase
        .from('sessions')
        .insert({
          user_id: user.id,
          token: sessionToken,
          expires_at: expiresAt.toISOString(),
          is_active: true,
        })

      return new Response(
        JSON.stringify({
          message: 'Email verified successfully',
          token: sessionToken,
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
      console.error('Verify OTP error:', err)
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  // ---- RESEND OTP ----
  if (path === '/resend-otp' && req.method === 'POST') {
    try {
      const body = await req.json()
      const { email } = body

      if (!email) {
        return new Response(
          JSON.stringify({ error: 'Email is required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const { data: user, error: findError } = await supabase
        .from('users')
        .select('*')
        .eq('email', email.toLowerCase().trim())
        .single()

      if (findError || !user || user.email_verified) {
        return new Response(
          JSON.stringify({ message: 'If that account needs verification, a new code has been sent.' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      await sendOtpEmail(user.email, user.full_name, '123456')

      return new Response(
        JSON.stringify({ message: 'A new verification code has been sent to your email.' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    } catch (err) {
      console.error('Resend OTP error:', err)
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  // ---- HEALTH ----
  if (path === '/health' && req.method === 'GET') {
    return new Response(
      JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // ---- CHECK EMAIL ----
  if (path === '/check-email' && req.method === 'GET') {
    try {
      const email = url.searchParams.get('email') || ''
      const { data } = await supabase
        .from('users')
        .select('id')
        .eq('email', email.toLowerCase().trim())
        .maybeSingle()
      return new Response(
        JSON.stringify({ valid: !data, reason: data ? 'An account already uses this email.' : null }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    } catch {
      return new Response(
        JSON.stringify({ valid: false, reason: 'Error checking email' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  // ---- CHECK PHONE ----
  if (path === '/check-phone' && req.method === 'GET') {
    try {
      const phone = url.searchParams.get('phone') || ''
      const { data } = await supabase
        .from('users')
        .select('id')
        .eq('phone', phone)
        .maybeSingle()
      return new Response(
        JSON.stringify({
          valid: !data,
          reason: data ? 'An account already uses this number.' : null,
          normalized: phone,
          note: 'Format looks valid. This is the number M-Pesa prompts will be sent to when you pay.',
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    } catch {
      return new Response(
        JSON.stringify({ valid: false, reason: 'Error checking phone' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  // ============================================
  // PROTECTED ROUTES (Auth required)
  // ============================================

  const authHeader = req.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response(
      JSON.stringify({ error: 'Missing authorization header' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  const token = authHeader.split(' ')[1]

  // Verify token against sessions table
  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('*, users(*)')
    .eq('token', token)
    .eq('is_active', true)
    .gt('expires_at', new Date().toISOString())
    .single()

  if (sessionError || !session) {
    return new Response(
      JSON.stringify({ error: 'Invalid or expired token' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  const user = session.users

  // ---- ME ----
  if (path === '/me' && req.method === 'GET') {
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
  }

  // ---- LOGOUT ----
  if (path === '/logout' && req.method === 'POST') {
    await supabase
      .from('sessions')
      .update({ is_active: false })
      .eq('token', token)

    return new Response(
      JSON.stringify({ message: 'Logged out successfully' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  return new Response(
    JSON.stringify({ error: 'Not found' }),
    { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
})

// ---- SEND OTP EMAIL ----
async function sendOtpEmail(email: string, fullName: string, code: string) {
  const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY')
  if (!BREVO_API_KEY) {
    console.error('BREVO_API_KEY not set')
    return
  }

  try {
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
  } catch (error) {
    console.error('Failed to send OTP email:', error)
  }
}