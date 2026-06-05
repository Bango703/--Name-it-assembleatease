import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

function assertEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseBool(value, fallback = false) {
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'y'].includes(String(value).toLowerCase());
}

async function main() {
  const secretKey = assertEnv('STRIPE_SECRET_KEY');
  const allowLive = parseBool(process.env.ALLOW_LIVE_STRIPE_KEY, false);
  if (!secretKey.startsWith('sk_test_') && !allowLive) {
    throw new Error('Refusing to run with a live Stripe key. Set ALLOW_LIVE_STRIPE_KEY=true to override.');
  }

  const stripe = new Stripe(secretKey);
  const email = process.env.CONNECT_TEST_EMAIL || `connect+${Date.now()}@assembleatease.com`;
  const label = process.env.CONNECT_TEST_LABEL || 'AAE Connect Sandbox';
  const accountMode = String(process.env.CONNECT_ACCOUNT_MODE || 'custom').toLowerCase();

  const connectedAccount = accountMode === 'express'
    ? await stripe.accounts.create({
        type: 'express',
        country: 'US',
        email,
        business_type: 'individual',
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: {
          source: 'seed-stripe-connect-test-data',
          label,
        },
      })
    : await stripe.accounts.create({
        type: 'custom',
        country: 'US',
        email,
        business_type: 'individual',
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        individual: {
          first_name: 'Test',
          last_name: 'Easer',
          email,
          phone: '5125550101',
          ssn_last_4: '0000',
          dob: { day: 1, month: 1, year: 1990 },
          address: {
            line1: '123 Test St',
            city: 'Austin',
            state: 'TX',
            postal_code: '78701',
            country: 'US',
          },
        },
        business_profile: {
          mcc: '7349',
          url: 'https://www.assembleatease.com',
          product_description: 'Assembly services',
        },
        external_account: 'btok_us_verified',
        tos_acceptance: {
          date: Math.floor(Date.now() / 1000),
          ip: '127.0.0.1',
        },
        metadata: {
          source: 'seed-stripe-connect-test-data',
          label,
        },
      });

  const accountLink = accountMode === 'express'
    ? await stripe.accountLinks.create({
        account: connectedAccount.id,
        type: 'account_onboarding',
        refresh_url: process.env.CONNECT_REFRESH_URL || 'https://www.assembleatease.com/owner',
        return_url: process.env.CONNECT_RETURN_URL || 'https://www.assembleatease.com/owner',
      })
    : null;

  const customer = await stripe.customers.create({
    email: process.env.CUSTOMER_TEST_EMAIL || `customer+${Date.now()}@example.com`,
    name: 'Connect Flow Test Customer',
    metadata: {
      source: 'seed-stripe-connect-test-data',
    },
  });

  const paymentMethod = await stripe.paymentMethods.create({
    type: 'card',
    card: { token: 'tok_visa' },
    billing_details: {
      name: 'Connect Flow Test Customer',
      email: customer.email,
    },
  });

  await stripe.paymentMethods.attach(paymentMethod.id, { customer: customer.id });
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: paymentMethod.id },
  });

  const amount = Number(process.env.CONNECT_TEST_AMOUNT_CENTS || 12900);
  const paymentIntent = await stripe.paymentIntents.create({
    amount,
    currency: 'usd',
    customer: customer.id,
    payment_method: paymentMethod.id,
    confirm: true,
    capture_method: 'manual',
    off_session: true,
    metadata: {
      source: 'seed-stripe-connect-test-data',
      type: 'connect_payout_flow_test',
    },
    description: 'AAE Connect flow sandbox payment',
  });

  let capturedIntent = paymentIntent;
  if (parseBool(process.env.CONNECT_CAPTURE_PAYMENT, true)) {
    capturedIntent = await stripe.paymentIntents.capture(paymentIntent.id);
  }

  let transfer = null;
  let transferDestinationAccountId = connectedAccount.id;
  let fallbackConnectedAccountId = null;

  if (capturedIntent.latest_charge) {
    try {
      transfer = await stripe.transfers.create({
        amount: Math.round(amount * 0.75),
        currency: 'usd',
        destination: transferDestinationAccountId,
        source_transaction: String(capturedIntent.latest_charge),
        metadata: {
          source: 'seed-stripe-connect-test-data',
          payment_intent: capturedIntent.id,
        },
      });
    } catch (error) {
      transfer = { error: error.message };

      if ((error.message || '').includes('destination account needs to have at least one of the following capabilities enabled')) {
        const fallbackEmail = `custom+${Date.now()}@assembleatease.com`;
        const customAccount = await stripe.accounts.create({
          type: 'custom',
          country: 'US',
          email: fallbackEmail,
          business_type: 'individual',
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
          individual: {
            first_name: 'Test',
            last_name: 'Easer',
            email: fallbackEmail,
            phone: '5125550101',
            ssn_last_4: '0000',
            dob: { day: 1, month: 1, year: 1990 },
            address: {
              line1: '123 Test St',
              city: 'Austin',
              state: 'TX',
              postal_code: '78701',
              country: 'US',
            },
          },
          business_profile: {
            mcc: '7349',
            url: 'https://www.assembleatease.com',
            product_description: 'Assembly services',
          },
          external_account: 'btok_us_verified',
          tos_acceptance: {
            date: Math.floor(Date.now() / 1000),
            ip: '127.0.0.1',
          },
          metadata: {
            source: 'seed-stripe-connect-test-data',
            fallback: 'custom-capability-ready',
          },
        });

        fallbackConnectedAccountId = customAccount.id;
        transferDestinationAccountId = customAccount.id;

        try {
          transfer = await stripe.transfers.create({
            amount: Math.round(amount * 0.75),
            currency: 'usd',
            destination: customAccount.id,
            source_transaction: String(capturedIntent.latest_charge),
            metadata: {
              source: 'seed-stripe-connect-test-data',
              payment_intent: capturedIntent.id,
              fallback: 'custom-capability-ready',
            },
          });
        } catch (fallbackError) {
          transfer = { error: `Fallback transfer failed: ${fallbackError.message}` };
        }
      }
    }
  }

  const membershipLookupKey = process.env.CONNECT_MEMBERSHIP_LOOKUP_KEY || 'easer_membership_monthly_test';
  const existingPriceList = await stripe.prices.list({
    lookup_keys: [membershipLookupKey],
    active: true,
    limit: 1,
  });

  let membershipProduct;
  let membershipPrice;
  if (existingPriceList.data.length > 0) {
    membershipPrice = existingPriceList.data[0];
    membershipProduct = await stripe.products.retrieve(String(membershipPrice.product));
  } else {
    membershipProduct = await stripe.products.create({
      name: 'Easer Membership (Test)',
      metadata: { source: 'seed-stripe-connect-test-data' },
    });

    membershipPrice = await stripe.prices.create({
      unit_amount: Number(process.env.CONNECT_MEMBERSHIP_AMOUNT_CENTS || 4900),
      currency: 'usd',
      recurring: { interval: 'month' },
      product: membershipProduct.id,
      lookup_key: membershipLookupKey,
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  const profileId = process.env.CONNECT_TEST_PROFILE_ID;
  if (supabaseUrl && supabaseServiceKey && profileId) {
    const sb = createClient(supabaseUrl, supabaseServiceKey);
    const accountState = await stripe.accounts.retrieve(connectedAccount.id);

    const { error: profileErr } = await sb
      .from('profiles')
      .update({
        stripe_connect_account_id: connectedAccount.id,
        stripe_connect_onboarding_complete: !!accountState.details_submitted,
        stripe_connect_charges_enabled: !!accountState.charges_enabled,
        stripe_connect_payouts_enabled: !!accountState.payouts_enabled,
        stripe_connect_details_submitted: !!accountState.details_submitted,
        stripe_connect_updated_at: new Date().toISOString(),
      })
      .eq('id', profileId);

    if (profileErr) {
      throw new Error(`Failed to update profile ${profileId}: ${profileErr.message}`);
    }
  }

  const result = {
    mode: secretKey.startsWith('sk_test_') ? 'test' : 'live',
    accountMode,
    connectedAccountId: connectedAccount.id,
    transferDestinationAccountId,
    fallbackConnectedAccountId,
    onboardingUrl: accountLink?.url || null,
    customerId: customer.id,
    paymentMethodId: paymentMethod.id,
    paymentIntentId: paymentIntent.id,
    capturedPaymentIntentId: capturedIntent.id,
    transferId: transfer?.id || null,
    transferError: transfer?.error || null,
    membershipProductId: membershipProduct.id,
    membershipPriceId: membershipPrice.id,
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
