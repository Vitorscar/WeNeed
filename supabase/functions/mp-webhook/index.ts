import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MP_ACCESS_TOKEN = Deno.env.get("MP_ACCESS_TOKEN")!;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const body = await req.json().catch(() => ({}));

    const type = url.searchParams.get("type") || body.type || body.topic;
    const paymentId =
      url.searchParams.get("data.id") ||
      body?.data?.id ||
      body?.resource;

    if (type !== "payment" || !paymentId) {
      return new Response("ignored", { status: 200 });
    }

    // Buscar dados completos do pagamento
    const res = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
    );

    if (!res.ok) return new Response("fetch error", { status: 500 });

    const payment = await res.json();
    const contractId = payment.external_reference;
    if (!contractId) return new Response("no ext_ref", { status: 200 });

    const feeDetail = (payment.fee_details || []).find(
      (f: any) => f.type === "mercadopago_fee"
    );
    const mpFee = Number(feeDetail?.amount || 0);
    const netProvider = Number(payment.transaction_details?.net_received_amount || 0);

    // Atualizar contrato
    await supabase
      .from("contracts")
      .update({
        mp_status: payment.status,
        mp_fee_amount: mpFee,
        mp_net_provider: netProvider,
        payment_method: payment.payment_method_id,
      })
      .eq("id", contractId);

    // Se aprovado, o trigger no banco muda o status para em_andamento
    if (payment.status === "approved") {
      await supabase
        .from("contracts")
        .update({ mp_status: "approved" }) // reafirma para o trigger pegar
        .eq("id", contractId)
        .eq("status", "aguardando_pagamento");
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("webhook:", err);
    return new Response("error", { status: 500 });
  }
});
