import { STRIPE_SECRET } from "../util/secrets";
import { Stripe } from "stripe";
import { updateOrganizationByStripeId } from "../models/OrganizationModel";
const stripe = new Stripe(STRIPE_SECRET || "", { apiVersion: "2020-08-27" });

/**
 * @name updateSubscriptionInDb
 * @description This function updates the subscription in the database. (organization.subscription)
 */
export async function updateSubscriptionInDb(
  subscription: string | Stripe.Subscription
) {
  // Make sure we have the full subscription object
  if (typeof subscription === "string") {
    subscription = await stripe.subscriptions.retrieve(subscription, {
      expand: ["plan"],
    });
  }

  const stripeCustomerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;

  await updateOrganizationByStripeId(stripeCustomerId, {
    subscription: {
      id: subscription.id,
      qty: subscription.items.data[0].quantity || 1,
      trialEnd: subscription.trial_end
        ? new Date(subscription.trial_end * 1000)
        : null,
      status: subscription.status,
      current_period_end: subscription.current_period_end,
      cancel_at: subscription.cancel_at,
      canceled_at: subscription.canceled_at,
      cancel_at_period_end: subscription.cancel_at_period_end,
      planNickname: subscription.items.data[0].plan.nickname,
      percent_off: subscription.discount?.coupon.percent_off || 0,
    },
    priceId: subscription.items.data[0].price.id,
  });
}

/**
 * @name updateSubscriptionInStripe
 * @description This function updates the subscription in Stripe's system via Stripe's API.
 */
export async function updateSubscriptionInStripe(
  subscriptionId: string,
  qty: number
) {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  const updatedSubscription = await stripe.subscriptions.update(
    subscriptionId,
    {
      items: [
        {
          id: subscription.items.data[0].id,
          quantity: qty,
        },
      ],
    }
  );

  await updateSubscriptionInDb(updatedSubscription);
}
