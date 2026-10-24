import { createClient } from "npm:@supabase/supabase-js@2.118.0";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function hexToBytes(hex: string) {
  const clean = hex.trim();

  if (!/^[0-9a-f]{64}$/i.test(clean)) {
    throw new Error("Invalid hex");
  }

  const bytes = new Uint8Array(clean.length / 2);

  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }

  return bytes;
}

async function hmacSha256Hex(
  secret: string,
  message: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );

  return [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualHex(
  a: string,
  b: string,
) {
  try {
    const aa = hexToBytes(a);
    const bb = hexToBytes(b);

    if (aa.length !== bb.length) {
      return false;
    }

    let diff = 0;

    for (let i = 0; i < aa.length; i++) {
      diff |= aa[i] ^ bb[i];
    }

    return diff === 0;
  } catch {
    return false;
  }
}

async function verifyStripeSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
) {
  const parts = signatureHeader
    .split(",")
    .map((s) => s.trim());

  const timestamp = parts
    .find((p) => p.startsWith("t="))
    ?.slice(2);

  const signatures = parts
    .filter((p) => p.startsWith("v1="))
    .map((p) => p.slice(3));

  if (!timestamp || signatures.length === 0) {
    return false;
  }
  if (!Number.isFinite(Number(timestamp)) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    return false;
  }

  const signedPayload = `${timestamp}.${payload}`;

  const expected = await hmacSha256Hex(
    secret,
    signedPayload,
  );

  return signatures.some((signature) =>
    timingSafeEqualHex(signature, expected)
  );
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({error:"Method not allowed"},405);
  try {
    const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default;
    if (!secret || !url || !key || !/^(sk|rk)_(live|test)_/.test(stripeKey))
      return json({error:"Missing server configuration"},503);
    const raw = await req.text();
    if (!await verifyStripeSignature(raw,req.headers.get("stripe-signature") || "",secret))
      return json({error:"Invalid webhook signature"},400);
    const event = JSON.parse(raw);
    const live = /^(sk|rk)_live_/.test(stripeKey);
    if (typeof event.livemode !== "boolean" || event.livemode !== live)
      return json({error:"Webhook mode mismatch"},400);
    const db = createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
    const object = event.data.object;
    const completed = ["checkout.session.completed","checkout.session.async_payment_succeeded"].includes(event.type);
    const refundEvent = ["charge.refunded","refund.created","refund.updated","refund.failed"].includes(event.type);

    if ((completed && object.payment_status === "paid") || refundEvent) {
      const piId = typeof object.payment_intent === "string" ? object.payment_intent : object.payment_intent?.id;
      if (!piId || !/^pi_[A-Za-z0-9]+$/.test(piId))
        return json({error:"Payment intent missing"},400);
      // Timestamp the GET, not event creation. Old events also reconcile current Stripe state.
      const observed = new Date().toISOString();
      const response = await fetch(
        `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(piId)}?expand%5B%5D=latest_charge`,
        {headers:{Authorization:`Bearer ${stripeKey}`,"Stripe-Version":"2026-08-26.dahlia"}});
      const pi = await response.json();
      const charge = pi.latest_charge;
      if (!response.ok || pi.id !== piId || pi.livemode !== live || pi.status !== "succeeded" ||
          pi.currency !== "jpy" || !charge || typeof charge !== "object" ||
          charge.livemode !== live || charge.payment_intent !== piId || charge.currency !== "jpy" ||
          charge.paid !== true || charge.captured !== true || charge.amount_captured !== charge.amount ||
          !Number.isSafeInteger(charge.amount) || charge.amount < 50 || pi.amount !== charge.amount ||
          !Number.isSafeInteger(charge.amount_refunded) || charge.amount_refunded < 0 ||
          charge.amount_refunded > charge.amount)
        return json({error:"Captured Stripe payment could not be reconciled"},503);
      const snapshot:Record<string,unknown> = {
        stripe_payment_intent_id:piId,stripe_charge_id:charge.id,stripe_livemode:live,
        amount_jpy:charge.amount,refunded_amount_jpy:charge.amount_refunded,
        stripe_reconciled_at:observed,
      };
      if (completed) {
        if (object.metadata?.kind === "listing_boost" || object.currency !== "jpy" ||
            object.amount_total !== charge.amount || object.livemode !== live ||
            !Number.isSafeInteger(event.created) || event.created <= 0)
          return json({error:"Invalid purchase snapshot"},400);
        Object.assign(snapshot,{
          stripe_checkout_session_id:object.id,
          listing_id:object.metadata?.listing_id,buyer_id:object.metadata?.buyer_id,
          seller_id:object.metadata?.seller_id,paid_at:new Date(event.created*1000).toISOString(),
        });
      }
      const {error} = await db.rpc("record_stripe_payment_snapshot",{snapshot});
      // A refund that arrives first gets retried after the purchase row exists.
      if (error) return json({error:"Payment snapshot could not be saved"},503);
    }
    if ((completed && object.payment_status === "paid") ||
        ["checkout.session.expired","checkout.session.async_payment_failed"].includes(event.type)) {
      const {error} = await db.rpc("finish_checkout_reservation",{
        reservation:object.metadata?.reservation_id || null,session:object.id});
      if (error) return json({error:"Checkout reservation update failed"},503);
    }
    if (event.type === "payment_intent.payment_failed") {
      const {error} = await db.from("payments").update({
        status:"failed",updated_at:new Date().toISOString(),
      }).eq("stripe_payment_intent_id",object.id).in("status",["pending","failed"]);
      if (error) return json({error:"Payment failure update could not be saved"},503);
    }
    return json({received:true});
  } catch (error) {
    console.error("WEBHOOK_RECONCILIATION_FAILED",{name:error instanceof Error?error.name:"Unknown"});
    return json({error:"Webhook processing failed"},503);
  }
});

