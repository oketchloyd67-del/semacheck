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

  const url = new URL(req.url)
  const path = url.pathname.replace('/auth', '')
  
  // Create Supabase client
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  // ---- LOGIN MUST BE FIRST - BEFORE ANY AUTH CHECK ----
  if (path === '/login' && req.method === 'POST') {
    try {
      const body = await req.json()
      const { emailOrPhone, password } = body

      console.log('Login attempt for:', emailOrPhone)

      if (!emailOrPhone || !password) {
        return new Response(
          JSON.stringify({ error: 'Email/phone and password are required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Find user by email or phone
      const { data: user, error } = await supabase
        .from('users')
        .select('*')
        .or(`email.eq.${emailOrPhone},phone.eq.${emailOrPhone}`)
        .single()

      if (error || !user) {
        console.log('User not found:', emailOrPhone)
        return new Response(
          JSON.stringify({ error: 'Invalid phone number or password' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      console.log('User found:', user.email)

      // Verify password
      const bcrypt = await import('https://deno.land/x/bcrypt@v0.4.1/mod.ts')
      const valid = await bcrypt.compare(password, user.password_hash)

      if (!valid) {
        console.log('Invalid password for:', emailOrPhone)
        return new Response(
          JSON.stringify({ error: 'Invalid phone number or password' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Check if email is verified
      if (!user.email_verified) {
        // Generate new OTP
        const otp = String(Math.floor(100000 + Math.random() * 900000))
        const otpHash = await bcrypt.hash(otp, 8)
        const otpExpires = new Date(Date.now() + 10 * 60 * 1000)

        await supabase
          .from('users')
          .update({
            otp_code_hash: otpHash,
            otp_expires_at: otpExpires.toISOString(),
            otp_attempts: 0,
          })
          .eq('id', user.id)

        await sendOtpEmail(user.email, user.full_name, otp)

        return new Response(
          JSON.stringify({
            error: 'Please verify your email before logging in.',
            requiresOtp: true,
            email: user.email,
          }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Generate JWT token
      const jwt = await import('https://deno.land/x/jose@v4.14.4/index.js')
      const token = await new jwt.SignJWT({ 
        userId: user.id, 
        phone: user.phone,
        email: user.email 
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime('7d')
        .sign(new TextEncoder().encode(Deno.env.get('JWT_SECRET') || 'your-secret-key'))

      console.log('Login successful for:', user.email)

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
      console.error('Login error:', err)
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  // ---- SIGNUP (Public) ----
  if (path === '/signup' && req.method === 'POST') {
    try {
      const body = await req.json()
      const { accountType, fullName, email, phone, nationalId, password, consentAccepted } = body

      // Validate required fields
      if (!fullName || !email || !phone || !nationalId || !password) {
        return new Response(
          JSON.stringify({ error: 'All fields are required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Hash password
      const bcrypt = await import('https://deno.land/x/bcrypt@v0.4.1/mod.ts')
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
      console.error('Signup error:', err)
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  // ---- VERIFY OTP (Public) ----
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

      if (user.otp_attempts >= 5) {
        return new Response(
          JSON.stringify({ error: 'Too many failed attempts. Request a new OTP.' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      if (new Date(user.otp_expires_at) < new Date()) {
        return new Response(
          JSON.stringify({ error: 'OTP expired. Request a new one.' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const bcrypt = await import('https://deno.land/x/bcrypt@v0.4.1/mod.ts')
      const valid = await bcrypt.compare(code, user.otp_code_hash)

      if (!valid) {
        await supabase
          .from('users')
          .update({ otp_attempts: user.otp_attempts + 1 })
          .eq('id', user.id)
        
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
          otp_expires_at: null,
          otp_attempts: 0,
        })
        .eq('id', user.id)

      // Generate JWT token
      const jwt = await import('https://deno.land/x/jose@v4.14.4/index.js')
      const token = await new jwt.SignJWT({ 
        userId: user.id, 
        phone: user.phone,
        email: user.email 
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime('7d')
        .sign(new TextEncoder().encode(Deno.env.get('JWT_SECRET') || 'your-secret-key'))

      return new Response(
        JSON.stringify({
          message: 'Email verified successfully',
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
      console.error('Verify OTP error:', err)
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  // ---- RESEND OTP (Public) ----
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

      const { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('email', email.toLowerCase().trim())
        .single()

      if (error || !user) {
        return new Response(
          JSON.stringify({ message: 'If that account needs verification, a new code has been sent.' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      if (user.email_verified) {
        return new Response(
          JSON.stringify({ message: 'If that account needs verification, a new code has been sent.' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const bcrypt = await import('https://deno.land/x/bcrypt@v0.4.1/mod.ts')
      const otp = String(Math.floor(100000 + Math.random() * 900000))
      const otpHash = await bcrypt.hash(otp, 8)
      const otpExpires = new Date(Date.now() + 10 * 60 * 1000)

      await supabase
        .from('users')
        .update({
          otp_code_hash: otpHash,
          otp_expires_at: otpExpires.toISOString(),
          otp_attempts: 0,
        })
        .eq('id', user.id)

      await sendOtpEmail(user.email, user.full_name, otp)

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

  // ---- LOGOUT ----
  if (path === '/logout' && req.method === 'POST') {
    return new Response(
      JSON.stringify({ message: 'Logged out successfully' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // ---- CHECK EMAIL (Public) ----
  if (path === '/check-email' && req.method === 'GET') {
    try {
      const email = url.searchParams.get('email') || ''
      if (!email) {
        return new Response(
          JSON.stringify({ valid: false, reason: 'Email is required' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const { data, error } = await supabase
        .from('users')
        .select('id')
        .eq('email', email.toLowerCase().trim())
        .maybeSingle()

      return new Response(
        JSON.stringify({ 
          valid: !data,
          reason: data ? 'An account already uses this email.' : null 
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    } catch (err) {
      return new Response(
        JSON.stringify({ valid: false, reason: 'Error checking email' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  // ---- CHECK PHONE (Public) ----
  if (path === '/check-phone' && req.method === 'GET') {
    try {
      const phone = url.searchParams.get('phone') || ''
      if (!phone) {
        return new Response(
          JSON.stringify({ valid: false, reason: 'Phone is required' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const { data, error } = await supabase
        .from('users')
        .select('id')
        .eq('phone', phone)
        .maybeSingle()

      return new Response(
        JSON.stringify({ 
          valid: !data,
          reason: data ? 'An account already uses this number.' : null,
          normalized: phone,
          note: 'Format looks valid. This is the number M-Pesa prompts will be sent to when you pay.'
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    } catch (err) {
      return new Response(
        JSON.stringify({ valid: false, reason: 'Error checking phone' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  // ---- HEALTH (Public) ----
  if (path === '/health' && req.method === 'GET') {
    return new Response(
      JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // ---- PROTECTED ROUTES ----
  // Only now check for authorization header
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

  // ---- 404 ----
  return new Response(
    JSON.stringify({ error: 'Not found' }),
    { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
})

// Helper function to send email using Brevo
async function sendOtpEmail(email, fullName, code) {
  const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY')
  if (!BREVO_API_KEY) {
    console.error('BREVO_API_KEY not set')
    return
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender: { email: 'semacheck254@gmail.com', name: 'SemaCheck' },
        to: [{ email }],
        subject: `Your SemaCheck verification code: ${code}`,
        htmlContent: `<h2>Your Verification Code</h2><p>Hi ${fullName || ''},</p><p>Your code is: <strong>${code}</strong></p><p>This code expires in 10 minutes.</p><p>If you did not request this, you can ignore this email.</p>`,
      }),
    })

    if (!response.ok) {
      const errorData = await response.text()
      console.error('Brevo API error:', response.status, errorData)
    }
  } catch (error) {
    console.error('Failed to send OTP email:', error)
  }
}