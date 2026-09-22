const MP_ACCESS_TOKEN = Deno.env.get("MP_ACCESS_TOKEN") ?? "";
const MP_MODE = Deno.env.get("MP_MODE") ?? "test";
const WEBHOOK_URL = Deno.env.get("WEBHOOK_URL") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const COMMISSION_RATE = 0.20;

const IS_TEST = MP_MODE === "test";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function supabaseGet(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase GET falhou: ${res.status} ${text}`);
  }
  return res.json();
}

async function supabasePatch(path: string, body: object) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase PATCH falhou: ${res.status} ${text}`);
  }
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!MP_ACCESS_TOKEN) {
      return new Response(
        JSON.stringify({ error: "MP_ACCESS_TOKEN não configurado" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json().catch(() => ({}));
    const contract_id = body?.contract_id;

    if (!contract_id) {
      return new Response(
        JSON.stringify({ error: "contract_id obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const contracts = await supabaseGet(
      `contracts?id=eq.${contract_id}&select=id,status,final_price,demand_id,proposal_id`
    );

    if (!contracts || contracts.length === 0) {
      return new Response(
        JSON.stringify({ error: "Contrato não encontrado" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const contract = contracts[0];

    if (contract.status !== "prestador_no_local") {
      return new Response(
        JSON.stringify({ error: `Contrato em estado '${contract.status}'` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const total = Number(contract.final_price) || 0;
    if (total <= 0) {
      return new Response(
        JSON.stringify({ error: "Valor inválido" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let demandTitle = "Serviço";
    try {
      const demands = await supabaseGet(`demands?id=eq.${contract.demand_id}&select=title`);
      if (demands && demands.length > 0) demandTitle = demands[0].title || "Serviço";
    } catch (_) {}

    const platformFee = Number((total * COMMISSION_RATE).toFixed(2));
    const payerEmail = IS_TEST
      ? "test_user_weneed@testuser.com"
      : `cliente_${contract.id.slice(0, 8)}@weneed.app`;

    const idempotencyKey = `weneed_${contract.id}_${Date.now()}`;

    // Teste usa cartão (Pix não processa no sandbox)
    // Produção usa Pix (muito mais barato)
    const paymentMethod = IS_TEST ? "master" : "pix";

    const paymentBody: any = {
      transaction_amount: total,
      description: `WENEED · ${demandTitle}`,
      payment_method_id: paymentMethod,
      external_reference: contract.id,
      notification_url: WEBHOOK_URL,
      application_fee: platformFee,
      payer: {
        email: payerEmail,
        first_name: IS_TEST ? "APRO" : "Cliente",
        last_name: IS_TEST ? "TESTE" : "WENEED",
      },
    };

    const mpRes = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(paymentBody),
    });

    if (!mpRes.ok) {
      const errText = await mpRes.text();
      return new Response(
        JSON.stringify({ error: "Erro no Mercado Pago", detail: errText }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const payment = await mpRes.json();
    const txData = payment.point_of_interaction?.transaction_data || {};

    await supabasePatch(`contracts?id=eq.${contract.id}`, {
      status: "aguardando_pagamento",
      mp_payment_id: String(payment.id),
      mp_status: payment.status,
      mp_qr_code: txData.qr_code || null,
      mp_qr_code_base64: txData.qr_code_base64 || null,
      mp_ticket_url: txData.ticket_url || null,
      mp_expires_at: payment.date_of_expiration || null,
      mp_marketplace_fee: platformFee,
      platform_fee: platformFee,
      payment_method: paymentMethod,
    });

    return new Response(
      JSON.stringify({
        payment_id: payment.id,
        status: payment.status,
        mode: IS_TEST ? "test" : "prod",
        payment_method: paymentMethod,
        qr_code: txData.qr_code,
        qr_code_base64: txData.qr_code_base64,
        ticket_url: txData.ticket_url,
        expires_at: payment.date_of_expiration,
        total,
        platform_fee: platformFee,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});