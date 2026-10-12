import { createClient } from "@supabase/supabase-js";

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "";
const MP_MODE = process.env.MP_MODE ?? "test";
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const COMMISSION_RATE = 0.20;

const TEST_PAYER_EMAIL = process.env.TEST_PAYER_EMAIL ?? "";
const TEST_PAYER_CPF = process.env.TEST_PAYER_CPF ?? "12345678909";

const IS_TEST = MP_MODE === "test";

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function supabaseGet(path) {
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

async function supabasePatch(path, body) {
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

function isEmailValido(email) {
  if (!email || typeof email !== "string") return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

async function getEmailFromAuth(userId) {
  if (!userId) return null;
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error) {
      console.warn("⚠️ getUserById erro:", error.message);
      return null;
    }
    return data?.user?.email ?? null;
  } catch (err) {
    console.warn("⚠️ getUserById exception:", err);
    return null;
  }
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).send("ok");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  console.log("▶️ create-payment", req.method, new Date().toISOString());

  try {
    if (!MP_ACCESS_TOKEN) {
      console.error("❌ MP_ACCESS_TOKEN ausente");
      return res.status(500).json({ error: "MP_ACCESS_TOKEN não configurado" });
    }

    const body = req.body || {};
    const contract_id = body?.contract_id;

    if (!contract_id) return res.status(400).json({ error: "contract_id obrigatório" });

    // 1. Contrato
    const contracts = await supabaseGet(
      `contracts?id=eq.${contract_id}&select=id,status,final_price,demand_id,proposal_id`
    );
    if (!contracts?.length) return res.status(404).json({ error: "Contrato não encontrado" });

    const contract = contracts[0];
    if (contract.status !== "prestador_no_local") {
      return res.status(400).json({ error: `Contrato em estado '${contract.status}'` });
    }

    const total = Number(contract.final_price) || 0;
    if (total <= 0) return res.status(400).json({ error: "Valor inválido" });

    // 2. Demanda
    const demands = await supabaseGet(
      `demands?id=eq.${contract.demand_id}&select=id,title,client_id`
    );
    if (!demands?.length) return res.status(404).json({ error: "Demanda do contrato não encontrada" });

    const demand = demands[0];
    const demandTitle = demand.title || "Serviço";
    const clientId = demand.client_id;

    // 3. Payer TEST vs PROD
    let payerEmail, payerFirstName, payerLastName, cpfLimpo;

    if (IS_TEST) {
      if (!isEmailValido(TEST_PAYER_EMAIL)) {
        return res.status(500).json({
          error: "Configuração de teste incompleta",
          detail: "Em modo teste, configure TEST_PAYER_EMAIL com o email do test user comprador.",
        });
      }
      payerEmail = TEST_PAYER_EMAIL;
      cpfLimpo = TEST_PAYER_CPF.replace(/\D/g, "");
      payerFirstName = "APRO";
      payerLastName = "TESTE";
      console.log("🧪 Modo TESTE — usando test payer:", payerEmail);
    } else {
      if (!clientId) return res.status(400).json({ error: "Demanda sem cliente associado" });

      const profiles = await supabaseGet(
        `profiles?id=eq.${clientId}&select=id,user_id,full_name,company_name,cpf`
      );
      if (!profiles?.length) return res.status(404).json({ error: "Perfil do cliente não encontrado" });

      const profile = profiles[0];
      if (!profile.user_id) return res.status(400).json({ error: "Cliente sem vínculo de usuário" });

      const emailFromAuth = await getEmailFromAuth(profile.user_id);
      if (!isEmailValido(emailFromAuth || "")) {
        return res.status(400).json({
          error: "Cliente sem e-mail cadastrado",
          detail: "Não foi possível localizar um e-mail válido para o cliente.",
        });
      }
      payerEmail = emailFromAuth;

      cpfLimpo = (profile.cpf || "").replace(/\D/g, "");
      if (cpfLimpo.length !== 11) {
        return res.status(400).json({
          error: "CPF do cliente obrigatório",
          detail: "O cliente precisa ter um CPF cadastrado no perfil para pagar via Pix.",
        });
      }

      const nomeCompleto = profile.full_name || profile.company_name || "Cliente WENEED";
      const partes = String(nomeCompleto).trim().split(/\s+/);
      payerFirstName = partes[0] || "Cliente";
      payerLastName = partes.slice(1).join(" ") || "WENEED";

      console.log("🏭 Modo PRODUÇÃO — usando cliente real:", payerEmail);
    }

    // 4. Idempotência + fee
    const idempotencyKey = `weneed_${contract.id}`;
    const platformFee = Number((total * COMMISSION_RATE).toFixed(2));

    // 5. Payload MP
    const paymentBody = {
      transaction_amount: total,
      description: `WENEED · ${demandTitle}`,
      payment_method_id: "pix",
      external_reference: contract.id,
      payer: {
        email: payerEmail,
        first_name: payerFirstName,
        last_name: payerLastName,
        identification: { type: "CPF", number: cpfLimpo },
      },
    };

    if (WEBHOOK_URL) paymentBody.notification_url = WEBHOOK_URL;

    console.log("→ MP request:", JSON.stringify({
      total,
      payment_method_id: "pix",
      external_reference: contract.id,
      payer_email: payerEmail,
      cpf_len: cpfLimpo.length,
      mode: IS_TEST ? "test" : "prod",
    }));

    // 6. Chamar MP
    const mpRes = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(paymentBody),
    });

    const mpText = await mpRes.text();
    if (!mpRes.ok) {
      console.error("❌ MP rejeitou:", mpRes.status, mpText);
      return res.status(502).json({
        error: "Erro no Mercado Pago",
        status: mpRes.status,
        detail: mpText,
      });
    }

    const payment = JSON.parse(mpText);
    const txData = payment.point_of_interaction?.transaction_data || {};

    console.log("✅ MP OK:", payment.id, payment.status);

    // 7. Salvar no contrato
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
      payment_method: "pix",
    });

    return res.status(200).json({
      payment_id: payment.id,
      status: payment.status,
      mode: IS_TEST ? "test" : "prod",
      payment_method: "pix",
      qr_code: txData.qr_code,
      qr_code_base64: txData.qr_code_base64,
      ticket_url: txData.ticket_url,
      expires_at: payment.date_of_expiration,
      total,
      platform_fee: platformFee,
    });
  } catch (err) {
    console.error("❌ create-payment crashou:", err);
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}