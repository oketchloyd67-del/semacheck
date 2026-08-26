// supabase/functions/payments/index.ts
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

// Tuma API configuration
const TUMA_API_URL = 'https://api.tuma.co.ke'
const TUMA_EMAIL = Deno.env.get('TUMA_EMAIL') || ''
const TUMA_API_KEY = Deno.env.get('TUMA_API_KEY') || ''
const TUMA_CALLBACK_URL = Deno.env.get('TUMA_CALLBACK_URL') || ''

// Get Tuma JWT token
async function getTumaToken(): Promise<string> {
  const response = await fetch(`${TUMA_API_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: TUMA_EMAIL,
      api_key: TUMA_API_KEY,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Tuma auth failed: ${error}`)
  }

  const data = await response.json()
  return data.data.token
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const url = new URL(req.url)
  const path = url.pathname.replace('/payments', '')
  const contentType = req.headers.get('Content-Type') || ''

  // ---- SEARCH PAYMENT (Initiate STK Push) ----
  if (path === '/search' && req.method === 'POST') {
    try {
      // Parse request body
      const bodyText = await req.text()
      if (!bodyText || bodyText.trim() === '') {
        return new Response(
          JSON.stringify({ error: 'Request body is empty' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      let body
      try {
        body = JSON.parse(bodyText)
      } catch (parseError) {
        return new Response(
          JSON.stringify({ error: 'Invalid JSON format' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const { tier, phone } = body

      if (!tier || !phone) {
        return new Response(
          JSON.stringify({ error: 'Tier and phone are required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Get Tuma JWT token
      const token = await getTumaToken()

      // Format phone number (ensure it starts with 254)
      const formattedPhone = phone.replace(/^0/, '254')

      // Initiate STK Push with Tuma
      const paymentResponse = await fetch(`${TUMA_API_URL}/payment/stk-push`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
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
          merchantRequestId: paymentData.data?.merchant_request_id,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    } catch (err) {
      console.error('Payment initiation error:', err)
      return new Response(
        JSON.stringify({ error: err.message || 'Payment initiation failed' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  // ---- CHECK PAYMENT STATUS ----
  if (path.startsWith('/status/') && req.method === 'GET') {
    try {
      const paymentId = path.split('/status/')[1]

      if (!paymentId) {
        return new Response(
          JSON.stringify({ error: 'Payment ID is required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Check payment status with Tuma
      // Note: Tuma may not have a direct status endpoint; you might need to check your database
      // or wait for the callback. This is a placeholder.
      return new Response(
        JSON.stringify({
          status: 'pending',
          paymentId: paymentId,
          message: 'Payment status pending',
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    } catch (err) {
      console.error('Status check error:', err)
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  // ---- TUMA CALLBACK WEBHOOK ----
  if (path === '/callback' && req.method === 'POST') {
    try {
      const callbackData = await req.json()
      console.log('Tuma callback received:', callbackData)

      // Process callback data
      // Update your database with payment status
      // You can also send confirmation emails or notifications

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

  // ---- HEALTH ----
  if (path === '/health' && req.method === 'GET') {
    return new Response(
      JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // ---- 404 ----
  return new Response(
    JSON.stringify({ error: 'Not found' }),
    { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
})