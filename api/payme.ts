
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from "@supabase/supabase-js";

// Initialize Supabase Admin client
const supabase = createClient(
  process.env.VITE_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || ""
);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Payme Merchant API Handler
  // Doc: https://developer.help.paycom.uz/metody-merchant-api
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { method, params, id } = req.body;
  const authHeader = req.headers.authorization;

  console.log(`[Vercel Payme] Method: ${method}, ID: ${id}`);

  // Basic Auth Check
  const paymeKey = process.env.PAYME_KEY;
  if (!paymeKey) {
    return res.json({ jsonrpc: "2.0", id, error: { code: -32504, message: "Server configuration error" } });
  }

  const expectedAuth = `Basic ${Buffer.from(`Paycom:${paymeKey}`).toString('base64')}`;
  
  if (!authHeader || authHeader !== expectedAuth) {
    return res.json({ jsonrpc: "2.0", id, error: { code: -32504, message: "Error auth" } });
  }

  try {
    switch (method) {
      case "CheckPerformTransaction":
        return await handleCheckPerform(params, id, res);
      case "CreateTransaction":
        return await handleCreateTransaction(params, id, res);
      case "PerformTransaction":
        return await handlePerformTransaction(params, id, res);
      case "CancelTransaction":
        return await handleCancelTransaction(params, id, res);
      case "CheckTransaction":
        return await handleCheckTransaction(params, id, res);
      case "GetStatement":
        return await handleGetStatement(params, id, res);
      default:
        return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }
  } catch (err) {
    console.error("Payme API Error:", err);
    return res.json({ jsonrpc: "2.0", id, error: { code: -31008, message: "Internal Server Error" } });
  }
}

// --- Handler Functions (Adapted for VercelResponse) ---

async function handleCheckPerform(params: any, id: any, res: VercelResponse) {
  const { amount, account } = params;
  const orderId = account.order_id;
  if (!orderId) {
    return res.json({ jsonrpc: "2.0", id, error: { code: -31050, message: "Order ID missing" } });
  }

  const { data: payment } = await supabase.from('payments').select('*').eq('order_id', orderId).maybeSingle();
  if (!payment) {
    return res.json({ jsonrpc: "2.0", id, error: { code: -31050, message: "Order not found" } });
  }

  // If already paid, it's "Blocked"
  if (payment.status === 'paid') {
    return res.json({ jsonrpc: "2.0", id, error: { code: -31050, message: "Order already paid" } });
  }

  // If another transaction is in progress, it's "Being processed"
  if (payment.payme_transaction_id && payment.status === 'pending') {
    return res.json({ jsonrpc: "2.0", id, error: { code: -31050, message: "Another transaction is being processed" } });
  }

  // Check amount
  const expectedAmountInTiyin = Number(payment.amount) * 100;
  if (expectedAmountInTiyin !== Number(amount)) {
    console.warn(`[Payme] Amount mismatch for order ${orderId}. Expected ${expectedAmountInTiyin}, received ${amount}`);
    return res.json({ jsonrpc: "2.0", id, error: { code: -31050, message: "Incorrect amount" } });
  }

  // Valid and ready: "Awaiting payment"
  return res.json({
    jsonrpc: "2.0",
    id,
    result: {
      allow: true
    }
  });
}

async function handleCreateTransaction(params: any, id: any, res: VercelResponse) {
  const { id: paymeId, time, account } = params;
  const orderId = account.order_id;

  const { data: payment } = await supabase.from('payments').select('*').eq('order_id', orderId).maybeSingle();
  if (!payment) {
    return res.json({ jsonrpc: "2.0", id, error: { code: -31050, message: "Order not found" } });
  }

  // Idempotency: If the SAME Payme transaction is already linked to this order
  if (payment.payme_transaction_id === paymeId) {
    if (payment.status === 'cancelled') {
        return res.json({ jsonrpc: "2.0", id, error: { code: -31008, message: "Transaction already cancelled" } });
    }
    return res.json({
      jsonrpc: "2.0",
      id,
      result: {
        create_time: Number(payment.payme_time),
        transaction: payment.id.toString(),
        state: payment.status === 'paid' ? 2 : 1
      }
    });
  }

  // If order already has a DIFFERENT transaction linked
  if (payment.payme_transaction_id) {
    return res.json({ jsonrpc: "2.0", id, error: { code: -31099, message: "Order occupied by another transaction" } });
  }

  // Link transaction to order
  await supabase.from('payments').update({
    payme_transaction_id: paymeId,
    status: 'pending',
    payme_time: time
  }).eq('order_id', orderId);

  return res.json({
    jsonrpc: "2.0",
    id,
    result: {
      create_time: Number(time),
      transaction: payment.id.toString(),
      state: 1
    }
  });
}

async function handlePerformTransaction(params: any, id: any, res: VercelResponse) {
  const { id: paymeId } = params;
  const { data: payment } = await supabase.from('payments').select('*').eq('payme_transaction_id', paymeId).maybeSingle();
  if (!payment) return res.json({ jsonrpc: "2.0", id, error: { code: -31003, message: "Transaction not found" } });

  if (payment.status === 'paid') {
    return res.json({
      jsonrpc: "2.0",
      id,
      result: {
        perform_time: new Date(payment.updated_at).getTime(),
        transaction: payment.id.toString(),
        state: 2
      }
    });
  }

  if (payment.status === 'cancelled') return res.json({ jsonrpc: "2.0", id, error: { code: -31008, message: "Cannot perform cancelled" } });

  const months = payment.package_type === '1_month' ? 1 : payment.package_type === '3_months' ? 3 : 6;
  const { data: profile } = await supabase.from('profiles').select('subscription_expires_at').eq('id', payment.user_id).single();
  
  let newExpiryDate = new Date();
  if (profile?.subscription_expires_at && new Date(profile.subscription_expires_at) > new Date()) {
    newExpiryDate = new Date(profile.subscription_expires_at);
  }
  newExpiryDate.setMonth(newExpiryDate.getMonth() + months);

  await supabase.from('profiles').update({
    subscription_tier: 'PREMIUM',
    subscription_expires_at: newExpiryDate.toISOString()
  }).eq('id', payment.user_id);

  const now = Date.now();
  await supabase.from('payments').update({
    status: 'paid',
    updated_at: new Date(now).toISOString()
  }).eq('id', payment.id);

  return res.json({
    jsonrpc: "2.0",
    id,
    result: {
      perform_time: now,
      transaction: payment.id.toString(),
      state: 2
    }
  });
}

async function handleCancelTransaction(params: any, id: any, res: VercelResponse) {
  const { id: paymeId, reason } = params;
  const { data: payment } = await supabase.from('payments').select('*').eq('payme_transaction_id', paymeId).maybeSingle();
  if (!payment) return res.json({ jsonrpc: "2.0", id, error: { code: -31003, message: "Transaction not found" } });

  if (payment.status === 'paid') return res.json({ jsonrpc: "2.0", id, error: { code: -31007, message: "Cannot cancel paid" } });

  await supabase.from('payments').update({
    status: 'cancelled',
    updated_at: new Date().toISOString(),
    cancel_reason: reason
  }).eq('id', payment.id);

  return res.json({
    jsonrpc: "2.0",
    id,
    result: {
      cancel_time: Date.now(),
      transaction: payment.id.toString(),
      state: -1
    }
  });
}

async function handleCheckTransaction(params: any, id: any, res: VercelResponse) {
  const { id: paymeId } = params;
  const { data: payment } = await supabase.from('payments').select('*').eq('payme_transaction_id', paymeId).maybeSingle();
  if (!payment) return res.json({ jsonrpc: "2.0", id, error: { code: -31003, message: "Transaction not found" } });

  return res.json({
    jsonrpc: "2.0",
    id,
    result: {
      create_time: Number(payment.payme_time || 0),
      perform_time: payment.status === 'paid' ? new Date(payment.updated_at).getTime() : 0,
      cancel_time: payment.status === 'cancelled' ? new Date(payment.updated_at).getTime() : 0,
      transaction: payment.id.toString(),
      state: payment.status === 'paid' ? 2 : payment.status === 'cancelled' ? -1 : 1,
      reason: payment.cancel_reason || null
    }
  });
}

async function handleGetStatement(params: any, id: any, res: VercelResponse) {
  const { from, to } = params;
  const { data: payments } = await supabase.from('payments').select('*').gte('payme_time', from).lte('payme_time', to);

  const transactions = (payments || []).map(p => ({
    id: p.payme_transaction_id,
    time: Number(p.payme_time),
    amount: Number(p.amount) * 100,
    account: { order_id: p.order_id },
    create_time: Number(p.payme_time),
    perform_time: p.status === 'paid' ? new Date(p.updated_at).getTime() : 0,
    cancel_time: p.status === 'cancelled' ? new Date(p.updated_at).getTime() : 0,
    transaction: p.id.toString(),
    state: p.status === 'paid' ? 2 : p.status === 'cancelled' ? -1 : 1,
    reason: p.cancel_reason || null
  }));

  return res.json({ jsonrpc: "2.0", id, result: { transactions } });
}
