import { createServer } from "node:http";
import { once } from "node:events";
import { FlutterPay, WEBHOOK_SIGNATURE_HEADER } from "../src/index.js";

const baseUrl = process.env.FLUTTERPAY_BASE_URL ?? "http://127.0.0.1:3000";

async function readBody(req: AsyncIterable<Buffer | string>) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks);
}

async function main() {
  let secretKey = process.env.FLUTTERPAY_SECRET_KEY;
  const usingExistingMerchant = Boolean(secretKey);
  const configureLocalWebhook =
    !usingExistingMerchant || process.env.FLUTTERPAY_OVERWRITE_WEBHOOK === "1";

  if (!secretKey) {
    const email = `sdk-example-${Date.now()}@example.com`;
    const signup = await fetch(`${baseUrl}/v1/merchants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        business_name: "SDK Example Store",
        email,
        password: "a-long-example-password",
      }),
    });
    if (!signup.ok) {
      throw new Error(`Could not register example merchant (HTTP ${signup.status}). Is the API running at ${baseUrl}?`);
    }
    const created = (await signup.json()) as { keys: { secret_key: string } };
    secretKey = created.keys.secret_key;
    console.log(`Registered temporary merchant (${email}).`);
  }

  const client = new FlutterPay({ secretKey, baseUrl });

  // Only mutate webhook settings for a newly registered example merchant or when explicitly opted in.
  const seenEvents = new Set<string>();
  let webhookSecret = "";
  let resolveWebhook!: () => void;
  const webhookReceived = new Promise<void>(resolve => {
    resolveWebhook = resolve;
  });

  const receiver = configureLocalWebhook
    ? createServer(async (req, res) => {
        const rawBody = await readBody(req);
        const signature = req.headers[WEBHOOK_SIGNATURE_HEADER];
        if (typeof signature !== "string") {
          res.statusCode = 400;
          res.end("Missing signature");
          return;
        }

        try {
          const event = client.webhooks.verify({
            payload: rawBody,
            signature,
            secret: webhookSecret,
          });

          if (seenEvents.has(event.id)) {
            console.log(`Duplicate webhook ignored: ${event.id}`);
          } else {
            seenEvents.add(event.id);
            console.log(`Verified webhook ${event.event} (${event.id}) for ${event.data.tx_ref}: ${event.data.status}`);
          }

          res.statusCode = 200;
          res.end("ok");
          resolveWebhook();
        } catch (error) {
          console.error("Rejected webhook:", error);
          res.statusCode = 400;
          res.end("Invalid signature");
        }
      })
    : null;

  if (receiver) {
    receiver.listen(0, "127.0.0.1");
    await once(receiver, "listening");
  }

  try {
    if (receiver) {
      const address = receiver.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP port for the webhook receiver.");
      }

      const webhookRes = await fetch(`${baseUrl}/v1/merchants/me/webhook`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          webhook_url: `http://127.0.0.1:${address.port}/webhook`,
          rotate_secret: true,
        }),
      });
      if (!webhookRes.ok) {
        throw new Error(`Could not configure webhook (HTTP ${webhookRes.status}).`);
      }
      const webhookData = (await webhookRes.json()) as { webhook: { secret: string } };
      webhookSecret = webhookData.webhook.secret;
    } else {
      console.log(
        "Skipping local webhook receiver setup to preserve your existing merchant's webhook config (set FLUTTERPAY_OVERWRITE_WEBHOOK=1 to opt in).",
      );
    }

    const txRef = `example-${Date.now()}`;
    const payment = await client.payments.create({
      tx_ref: txRef,
      amount_kobo: 500_000,
      currency: "NGN",
      customer_email: "buyer@example.com",
      redirect_url: "http://127.0.0.1:4000/callback",
    });
    console.log(`Created payment ${payment.transaction.id} -> ${payment.link}`);

    const chargeRes = await fetch(`${payment.link}/charge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        card_number: "4242 4242 4242 4242",
        expiry: "12/30",
        cvv: "123",
      }),
    });
    if (!chargeRes.ok) {
      throw new Error(`Checkout charge failed (HTTP ${chargeRes.status}).`);
    }

    const verified = await client.transactions.verify(payment.transaction.id);
    console.log("Verified transaction:", {
      id: verified.transaction.id,
      tx_ref: verified.transaction.tx_ref,
      status: verified.transaction.status,
      amount_kobo: verified.transaction.amount_kobo,
      currency: verified.transaction.currency,
      card_last4: verified.transaction.card_last4,
    });

    if (receiver) {
      await Promise.race([
        webhookReceived,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for webhook delivery")), 5_000),
        ),
      ]);
    }
  } finally {
    if (receiver) {
      receiver.closeAllConnections();
      await new Promise<void>((resolve, reject) => receiver.close(err => (err ? reject(err) : resolve())));
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
