const corsHeaders = {
  "Access-Control-Allow-Origin": "https://voice-flea-market.pages.dev",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const body = await req.json();
    const record = body?.record ?? body;

    const message =
      record?.message ??
      "お問い合わせ内容を取得できませんでした。";

    const replyEmail =
      record?.reply_email ??
      "未入力";

    const resendKey = Deno.env.get("RESEND_API_KEY");
    const notifyTo = Deno.env.get("SUPPORT_NOTIFY_TO");

    if (!resendKey || !notifyTo) {
      throw new Error("メール設定が未登録です");
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "声のフリマ <onboarding@resend.dev>",
        to: [notifyTo],
        subject: "【声のフリマ】新しいお問い合わせ",
        text:
`声のフリマに新しいお問い合わせが届きました。

返信先:
${replyEmail}

お問い合わせ内容:
${message}

Supabaseのsupport_inquiriesも確認してください。`
      }),
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  } catch (error) {
    return new Response(String(error), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
