import { createClient } from "@supabase/supabase-js";

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const body = req.body || {};

    const type = url.searchParams.get("type") || body.type || body.topic;
    const paymentId =
      url.searchParams.get("data.id") ||
      body?.data?.id ||
      body?.resource;

    if (type !== "payment" || !paymentId) {
      return res.status(200).send("ignored");
    }

    const mpRes = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
    );

    if (!mpRes.ok) return res.status(500).send("fetch error");

    const payment = await mpRes.json();
    const contractId = payment.external_reference;
    if (!contractId) return res.status(200).send("no ext_ref");

    const feeDetail = (payment.fee_details || []).find(
      (f) => f.type === "mercadopago_fee"
    );
    const mpFee = Number(feeDetail?.amount || 0);
    const netProvider = Number(payment.transaction_details?.net_received_amount || 0);

    await supabase
      .from("contracts")
      .update({
        mp_status: payment.status,
        mp_fee_amount: mpFee,
        mp_net_provider: netProvider,
        payment_method: payment.payment_method_id,
      })
      .eq("id", contractId);

    if (payment.status === "approved") {
      await supabase
        .from("contracts")
        .update({ mp_status: "approved" })
        .eq("id", contractId)
        .eq("status", "aguardando_pagamento");
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("webhook:", err);
    return res.status(500).send("error");
  }
}