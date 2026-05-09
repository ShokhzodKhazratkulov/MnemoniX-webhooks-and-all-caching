
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from "@supabase/supabase-js";

// Initialize Supabase Admin client
const supabase = createClient(
  process.env.VITE_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || ""
);

interface PaymeError {
  code: number;
  message: {
    ru: string;
    uz: string;
    en: string;
  };
  data?: string;
}

function createError(code: number, ru: string, uz: string, en: string, data?: string): PaymeError {
  return {
    code,
    message: { ru, uz, en },
    data
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Payme Merchant API Handler
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { method, params, id } = req.body;
  const authHeader = req.headers.authorization;

  console.log(`[Vercel Payme] Method: ${method}, ID: ${id}`);

  // Basic Auth Check
  const paymeKey = process.env.PAYME_KEY;
  if (!paymeKey) {
    return res.json({ 
      jsonrpc: "2.0", 
      id, 
      error: createError(-32504, "Ошибка конфигурации сервера", "Server konfiguratsiyasi xatosi", "Server configuration error")
    });
  }

  const expectedAuth = `Basic ${Buffer.from(`Paycom:${paymeKey}`).toString('base64')}`;
  
  if (!authHeader || authHeader !== expectedAuth) {
    return res.json({ 
      jsonrpc: "2.0", 
      id, 
      error: createError(-32504, "Ошибка авторизации", "Avtorizatsiya xatosi", "Error auth")
    });
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
        return res.json({ 
          jsonrpc: "2.0", 
          id, 
          error: createError(-32601, "Метод не найден", "Metod topilmadi", "Method not found")
        });
    }
  } catch (err) {
    console.error("Payme API Error:", err);
    return res.json({ 
      jsonrpc: "2.0", 
      id, 
      error: createError(-31008, "Внутренняя ошибка сервера", "Ichki server xatosi", "Internal Server Error")
    });
  }
}

// --- Handler Functions ---

async function handleCheckPerform(params: any, id: any, res: VercelResponse) {
  const { amount, account } = params;
  const orderId = account.order_id;
  
  if (!orderId) {
    return res.json({ 
      jsonrpc: "2.0", 
      id, 
      error: createError(-31050, "ID заказа отсутствует", "Buyurtma ID si yo'q", "Order ID missing", "order_id")
    });
  }

  const { data: payment } = await supabase.from('payments').select('*').eq('order_id', orderId).maybeSingle();
  
  if (!payment) {
    return res.json({ 
      jsonrpc: "2.0", 
      id, 
      error: createError(-31050, "Заказ не найден", "Buyurtma topilmadi", "Order not found", "order_id")
    });
  }

  if (payment.status === 'paid') {
    return res.json({ 
      jsonrpc: "2.0", 
      id, 
      error: createError(-31050, "Заказ уже оплачен", "Buyurtma allaqachon to'langan", "Order already paid", "order_id")
    });
  }

  if (payment.payme_transaction_id && payment.status === 'pending') {
    return res.json({ 
      jsonrpc: "2.0", 
      id, 
      error: createError(-31050, "Другая транзакция в процессе", "Boshqa tranzaksiya jarayonda", "Another transaction is being processed", "order_id")
    });
  }

  const expectedAmountInTiyin = Number(payment.amount);
  if (expectedAmountInTiyin !== Number(amount)) {
    return res.json({ 
      jsonrpc: "2.0", 
      id, 
      error: createError(-31050, "Неверная сумма", "Noto'g'ri summa", "Incorrect amount", "amount")
    });
  }

  return res.json({
    jsonrpc: "2.0",
    id,
    result: { allow: true }
  });
}

async function handleCreateTransaction(params: any, id: any, res: VercelResponse) {
  const { id: paymeId, time, account } = params;
  const orderId = account.order_id;

  const { data: payment } = await supabase.from('payments').select('*').eq('order_id', orderId).maybeSingle();
  
  if (!payment) {
    return res.json({ 
      jsonrpc: "2.0", 
      id, 
      error: createError(-31050, "Заказ не найден", "Buyurtma topilmadi", "Order not found", "order_id")
    });
  }

  // Idempotency: If the SAME Payme transaction is already linked to this order
  if (payment.payme_transaction_id === paymeId) {
    if (payment.status === 'cancelled') {
        return res.json({ 
          jsonrpc: "2.0", 
          id, 
          error: createError(-31008, "Транзакция уже отменена", "Tranzaksiya allaqachon bekor qilingan", "Transaction already cancelled")
        });
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
    return res.json({ 
      jsonrpc: "2.0", 
      id, 
      error: createError(-31099, "Заказ занят другой транзакцией", "Buyurtma boshqa tranzaksiya bilan band", "Order occupied by another transaction")
    });
  }

  const { error: updateError } = await supabase.from('payments').update({
    payme_transaction_id: paymeId,
    status: 'pending',
    payme_time: time
  }).eq('order_id', orderId);

  if (updateError) {
    console.error(`[Payme] CreateTransaction Update Error for order ${orderId}:`, updateError);
    return res.json({ 
      jsonrpc: "2.0", 
      id, 
      error: createError(-31008, "Ошибка базы данных", "Ma'lumotlar bazasi xatosi", "Database error", updateError.message)
    });
  }

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
  
  if (!payment) {
    return res.json({ 
      jsonrpc: "2.0", 
      id, 
      error: createError(-31003, "Транзакция не найдена", "Tranzaksiya topilmadi", "Transaction not found")
    });
  }

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

  if (payment.status === 'cancelled') {
    return res.json({ 
      jsonrpc: "2.0", 
      id, 
      error: createError(-31008, "Невозможно выполнить отмененную транзакцию", "Bekor qilingan tranzaksiyani bajarib bo'lmaydi", "Cannot perform cancelled")
    });
  }

  const months = payment.package_type === '1_month' ? 1 : payment.package_type === '3_months' ? 3 : 6;
  const { data: profile } = await supabase.from('profiles').select('subscription_expires_at').eq('id', payment.user_id).single();
  
  let newExpiryDate = new Date();
  if (profile?.subscription_expires_at && new Date(profile.subscription_expires_at) > new Date()) {
    newExpiryDate = new Date(profile.subscription_expires_at);
  }
  newExpiryDate.setMonth(newExpiryDate.getMonth() + months);

  const { error: profileError } = await supabase.from('profiles').update({
    subscription_tier: 'PREMIUM',
    subscription_expires_at: newExpiryDate.toISOString()
  }).eq('id', payment.user_id);

  if (profileError) {
    console.error("[Payme] PerformTransaction Profile Update Error:", profileError);
    return res.json({ 
      jsonrpc: "2.0", 
      id, 
      error: createError(-31008, "Ошибка обновления профиля", "Profilni yangilashda xato", "Profile update error")
    });
  }

  const now = Date.now();
  const { error: paymentUpdateError } = await supabase.from('payments').update({
    status: 'paid',
    updated_at: new Date(now).toISOString()
  }).eq('id', payment.id);

  if (paymentUpdateError) {
    console.error("[Payme] PerformTransaction Payment Update Error:", paymentUpdateError);
    return res.json({ 
      jsonrpc: "2.0", 
      id, 
      error: createError(-31008, "Ошибка обновления платежа", "To'lovni yangilashda xato", "Payment update error")
    });
  }

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
  
  if (!payment) {
    return res.json({ 
      jsonrpc: "2.0", 
      id, 
      error: createError(-31003, "Транзакция не найдена", "Tranzaksiya topilmadi", "Transaction not found")
    });
  }

  if (payment.status === 'paid') {
    return res.json({ 
      jsonrpc: "2.0", 
      id, 
      error: createError(-31007, "Нельзя отменить оплаченную транзакцию", "To'langan tranzaksiyani bekor qilib bo'lmaydi", "Cannot cancel paid")
    });
  }

  const { error: cancelError } = await supabase.from('payments').update({
    status: 'cancelled',
    updated_at: new Date().toISOString(),
    cancel_reason: reason
  }).eq('id', payment.id);

  if (cancelError) {
    console.error("[Payme] CancelTransaction Error:", cancelError);
    return res.json({ 
      jsonrpc: "2.0", 
      id, 
      error: createError(-31008, "Ошибка отмены транзакции", "Tranzaksiyani bekor qilishda xato", "Cancel transaction error")
    });
  }

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
  
  if (!payment) {
    return res.json({ 
      jsonrpc: "2.0", 
      id, 
      error: createError(-31003, "Транзакция не найдена", "Tranzaksiya topilmadi", "Transaction not found")
    });
  }

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
    amount: Number(p.amount),
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
