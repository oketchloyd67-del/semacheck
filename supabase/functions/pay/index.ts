// supabase/functions/pay/index.ts
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const TUMA_API_URL = 'https://api.tuma.co.ke'
const TUMA_EMAIL = Deno.env.get('TUMA_EMAIL') || ''
const TUMA_API_KEY = Deno.env.get('TUMA_API_KEY') || ''
const TUMA_CALLBACK_URL = Deno.env.get('TUMA_CALLBACK_URL') || ''

async function getTumaToken(): Promise<string> {
  const response = await fetch(`${TUMA_API_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TUMA_EMAIL, api_key: TUMA_API_KEY }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Tuma auth failed: ${error}`)
  }

  const data = await response.json()
  return data.data.token
}

serve(async (req) => {
  // CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const url = new URL(req.url)
  const path = url.pathname.replace('/pay', '')

  // Supabase client
  const supabase = createClient(
    Deno.env.get('API_URL') ?? 'https://csswkinuufdspxcsnfrd.supabase.co',
    Deno.env.get('DB_SECRET_KEY') ?? ''
  )

  // --- SEARCH ---
  if (path === '/search' && req.method === 'POST') {
    try {
      // Get the token from the Authorization header
      const authHeader = req.headers.get('Authorization')
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response(
          JSON.stringify({ error: 'Missing authorization header' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const token = authHeader.split(' ')[1]

      // Check if the token is valid in the sessions table
      const { data: session, error: sessionError } = await supabase
        .from('sessions')
        .select('user_id')
        .eq('token', token)
        .eq('is_active', true)
        .gt('expires_at', new Date().toISOString())
        .single()

      if (sessionError || !session) {
        console.error('Session error:', sessionError)
        return new Response(
          JSON.stringify({ error: 'Invalid or expired token' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Get the request body
      const body = await req.json()
      const { tier, phone } = body

      if (!tier || !phone) {
        return new Response(
          JSON.stringify({ error: 'Tier and phone are required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Get Tuma token
      const tumaToken = await getTumaToken()
      const formattedPhone = phone.replace(/^0/, '254')

      // Initiate STK Push
      const paymentResponse = await fetch(`${TUMA_API_URL}/payment/stk-push`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tumaToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: tier,
          phone: formattedPhone,
          description: `SemaCheck verification - KES ${tier}`,
          callback_url: TUMA_CALLBACK_URL,
        }),
      })

      if (!paymentResponse.ok) {
        const error = await paymentResponse.text()
        throw new Error(`Tuma payment failed: ${error}`)
      }

      const paymentData = await paymentResponse.json()

      return new Response(
        JSON.stringify({
          paymentId: paymentData.data?.checkout_request_id || paymentData.checkout_request_id,
          message: `STK push sent to ${phone}. Enter your M-Pesa PIN to complete payment.`,
          status: 'pending',
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    } catch (err) {
      console.error('Payment error:', err)
      return new Response(
        JSON.stringify({ error: err.message || 'Payment initiation failed' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  // --- STATUS ---
  if (path.startsWith('/status/') && req.method === 'GET') {
    const paymentId = path.split('/status/')[1]
    return new Response(
      JSON.stringify({ status: 'pending', paymentId }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // --- CALLBACK ---
  if (path === '/callback' && req.method === 'POST') {
    try {
      const callbackData = await req.json()
      console.log('Tuma callback received:', callbackData)
      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    } catch (err) {
      console.error('Callback error:', err)
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  return new Response(
    JSON.stringify({ error: 'Not found' }),
    { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
})