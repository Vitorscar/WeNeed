import { createClient } from "npm:@supabase/supabase-js@2";

/* ============================================================
   CONFIG
   ============================================================ */
const MP_ACCESS_TOKEN = Deno.env.get("MP_ACCESS_TOKEN") ?? "";
const MP_MODE = Deno.env.get("MP_MODE") ?? "test";
const WEBHOOK_URL = Deno.env.get("WEBHOOK_URL") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const COMMISSION_RATE = 0.20;

/* Test users do Mercado Pago — usados quando MP_MODE=test */
const TEST_PAYER_EMAIL = Deno.env.get("TEST_PAYER_EMAIL") ?? "";
const TEST_PAYER_CPF = Deno.env.get("TEST_PAYER_CPF") ?? "12345678909";

const IS_TEST = MP_MODE === "test";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* ============================================================
   SUPABASE CLIENTS
   ============================================================ */
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

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

/* ============================================================
   HELPERS
   ============================================================ */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isEmailValido(email: string): boolean {
  if (!email || typeof email !== "string") return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

/**
 * Busca o email do cliente em auth.users a partir do user_id do profile.
 * Usado apenas em modo PRODUÇÃO.
 */
async function getEmailFromAuth(userId: string): Promise<string | null> {
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

/* ============================================================
   HANDLER
   ============================================================ */
Deno.serve(async (req) => {
  console.log("▶️ create-payment", req.method, new Date().toISOString());

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!MP_ACCESS_TOKEN) {
      console.error("❌ MP_ACCESS_TOKEN ausente");
      return json({ error: "MP_ACCESS_TOKEN não configurado" }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const contract_id = body?.contract_id;

    if (!contract_id) {
      return json({ error: "contract_id obrigatório" }, 400);
    }

    /* ---------- 1. Contrato ---------- */
    const contracts = await supabaseGet(
      `contracts?id=eq.${contract_id}&select=id,status,final_price,demand_id,proposal_id`
    );

    if (!contracts?.length) {
      return json({ error: "Contrato não encontrado" }, 404);
    }

    const contract = contracts[0];

    if (contract.status !== "prestador_no_local") {
      return json({ error: `Contrato em estado '${contract.status}'` }, 400);
    }

    const total = Number(contract.final_price) || 0;
    if (total <= 0) {
      return json({ error: "Valor inválido" }, 400);
    }

    /* ---------- 2. Demanda ---------- */
    const demands = await supabaseGet(
      `demands?id=eq.${contract.demand_id}&select=id,title,client_id`
    );

    if (!demands?.length) {
      return json({ error: "Demanda do contrato não encontrada" }, 404);
    }

    const demand = demands[0];
    const demandTitle = demand.title || "Serviço";
    const clientId = demand.client_id;

    /* ============================================================
       DECISÃO DO PAYER: TEST vs PROD
       ============================================================ */
    let payerEmail: string;
    let payerFirstName: string;
    let payerLastName: string;
    let cpfLimpo: string;

    if (IS_TEST) {
      /* 🧪 MODO TESTE: sempre usa o test user comprador do MP */
      if (!isEmailValido(TEST_PAYER_EMAIL)) {
        console.error("❌ TEST_PAYER_EMAIL ausente ou inválido");
        return json(
          {
            error: "Configuração de teste incompleta",
            detail:
              "Em modo teste, configure TEST_PAYER_EMAIL com o email do test user comprador. " +
              "Padrão: test_user_<USER_ID>@testuser.com",
          },
          500
        );
      }

      payerEmail = TEST_PAYER_EMAIL;
      cpfLimpo = TEST_PAYER_CPF.replace(/\D/g, "");
      payerFirstName = "APRO";
      payerLastName = "TESTE";

      console.log("🧪 Modo TESTE — usando test payer:", payerEmail);

    } else {
      /* 🏭 MODO PRODUÇÃO: usa os dados REAIS do cliente */
      if (!clientId) {
        return json({ error: "Demanda sem cliente associado" }, 400);
      }

      const profiles = await supabaseGet(
        `profiles?id=eq.${clientId}&select=id,user_id,full_name,company_name,cpf`
      );

      if (!profiles?.length) {
        return json({ error: "Perfil do cliente não encontrado" }, 404);
      }

      const profile = profiles[0];

      if (!profile.user_id) {
        return json({ error: "Cliente sem vínculo de usuário" }, 400);
      }

      const emailFromAuth = await getEmailFromAuth(profile.user_id);

      if (!isEmailValido(emailFromAuth || "")) {
        console.error("❌ Cliente sem email válido em auth.users", {
          clientId,
          userId: profile.user_id,
        });
        return json(
          {
            error: "Cliente sem e-mail cadastrado",
            detail: "Não foi possível localizar um e-mail válido para o cliente.",
          },
          400
        );
      }

      payerEmail = emailFromAuth!;

      cpfLimpo = (profile.cpf || "").replace(/\D/g, "");
      if (cpfLimpo.length !== 11) {
        console.error("❌ Cliente sem CPF válido", { clientId, cpf: profile.cpf });
        return json(
          {
            error: "CPF do cliente obrigatório",
            detail: "O cliente precisa ter um CPF cadastrado no perfil para pagar via Pix.",
          },
          400
        );
      }

      const nomeCompleto =
        profile.full_name || profile.company_name || "Cliente WENEED";
      const partes = String(nomeCompleto).trim().split(/\s+/);
      payerFirstName = partes[0] || "Cliente";
      payerLastName = partes.slice(1).join(" ") || "WENEED";

      console.log("🏭 Modo PRODUÇÃO — usando cliente real:", payerEmail);
    }

    /* ---------- 3. Idempotência + fee ---------- */
    const idempotencyKey = `weneed_${contract.id}`;
    const platformFee = Number((total * COMMISSION_RATE).toFixed(2));

    /* ---------- 4. Payload MP ---------- */
    const paymentBody: Record<string, unknown> = {
      transaction_amount: total,
      description: `WENEED · ${demandTitle}`,
      payment_method_id: "pix",
      external_reference: contract.id,
      payer: {
        email: payerEmail,
        first_name: payerFirstName,
        last_name: payerLastName,
        identification: {
          type: "CPF",
          number: cpfLimpo,
        },
      },
    };

    if (WEBHOOK_URL) {
      paymentBody.notification_url = WEBHOOK_URL;
    }

    /* ⚠️ application_fee só funciona em marketplace OAuth — não enviar */

    console.log("→ MP request:", JSON.stringify({
      total,
      payment_method_id: "pix",
      external_reference: contract.id,
      payer_email: payerEmail,
      cpf_len: cpfLimpo.length,
      mode: IS_TEST ? "test" : "prod",
      token_prefix: MP_ACCESS_TOKEN.slice(0, 20),
    }));

    /* ---------- 5. Chamar Mercado Pago ---------- */
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
      return json(
        {
          error: "Erro no Mercado Pago",
          status: mpRes.status,
          detail: mpText,
        },
        502
      );
    }

    const payment = JSON.parse(mpText);
    const txData = payment.point_of_interaction?.transaction_data || {};

    console.log("✅ MP OK:", payment.id, payment.status);

    /* ---------- 6. Salvar no contrato ---------- */
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

    return json({
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
    return json(
      { error: err instanceof Error ? err.message : String(err) },
      500
    );
  }
});