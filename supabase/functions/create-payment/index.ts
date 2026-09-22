const MP_ACCESS_TOKEN = Deno.env.get("MP_ACCESS_TOKEN") ?? "";
const SITE_URL = Deno.env.get("SITE_URL") ?? "";
const WEBHOOK_URL = Deno.env.get("WEBHOOK_URL") ?? "";
const COMMISSION_RATE = 0.20;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
);
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { contract_id } = await req.json();
    if (!contract_id) throw new Error("contract_id obrigatório");

    // 1. Validar contrato
    const { data: contract, error: cErr } = await supabase
      .from("contracts")
      .select(`
        id, status, final_price,
        demand:demands ( title, client_id ),
        proposal:proposals (
          provider:profiles ( full_name, company_name )
        )
      `)
      .eq("id", contract_id)
      .single();

    if (cErr || !contract) throw new Error("Contrato não encontrado");
    if (contract.status !== "prestador_no_local") {
      throw new Error(`Contrato em estado '${contract.status}' — não pode ser cobrado`);
    }

    const total = Number(contract.final_price) || 0;
    if (total <= 0) throw new Error("Valor inválido");

    const platformFee = Number((total * COMMISSION_RATE).toFixed(2));
    const payerEmail = `cliente_${contract.id.slice(0, 8)}@weneed.app`;

    // 2. Criar pagamento Pix via API
    const idempotencyKey = `weneed_${contract.id}_${Date.now()}`;

    const paymentBody = {
      transaction_amount: total,
      description: `WENEED · ${contract.demand?.title || "Serviço"}`,
      payment_method_id: "pix",
      external_reference: contract.id,
      notification_url: WEBHOOK_URL,
      application_fee: platformFee, // ← split automático: 20% WENEED / 80% prestador
      payer: {
        email: payerEmail,
        first_name: "Cliente",
        last_name: "WENEED",
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
      const err = await mpRes.text();
      console.error("MP error:", err);
      throw new Error(`Mercado Pago: ${err}`);
    }

    const payment = await mpRes.json();
    const txData = payment.point_of_interaction?.transaction_data || {};

    // 3. Salvar no contrato
    await supabase
      .from("contracts")
      .update({
        status: "aguardando_pagamento",
        mp_payment_id: String(payment.id),
        mp_status: payment.status,
        mp_qr_code: txData.qr_code || null,
        mp_qr_code_base64: txData.qr_code_base64 || null,
        mp_ticket_url: txData.ticket_url || null,
        mp_expires_at: payment.date_of_expiration || null,
        mp_marketplace_fee: platformFee,
        platform_fee: platformFee,
        payment_method: "pix",
      })
      .eq("id", contract.id);

    return new Response(
      JSON.stringify({
        payment_id: payment.id,
        status: payment.status,
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
    console.error("create-payment:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});