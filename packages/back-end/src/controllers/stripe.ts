import { Request, Response } from "express";
import {
  STRIPE_SECRET,
  APP_ORIGIN,
  STRIPE_PRICE,
  STRIPE_WEBHOOK_SECRET,
} from "../util/secrets";
import { Stripe } from "stripe";
import { AuthRequest } from "../types/AuthRequest";
import {
  updateOrganization,
  findOrganizationByStripeCustomerId,
} from "../models/OrganizationModel";
import { getOrgFromReq } from "../services/organizations";
import { updateSubscription } from "../services/stripe";
const stripe = new Stripe(STRIPE_SECRET || "", { apiVersion: "2020-08-27" });

let priceData: Stripe.Price;

export async function postNewSubscription(
  req: AuthRequest<{ qty: number; email: string }>,
  res: Response
) {
  const { qty } = req.body;

  try {
    req.checkPermissions("organizationSettings");

    const { org } = getOrgFromReq(req);

    if (!org) {
      throw new Error("No organization found");
    }

    //TODO: It's possible to have duplicate users in members. Once bug is resolved, we can just get members.length + invites.length
    const currentMembers = org.members?.map((m) => m.id) || [];
    const uniqueMembers = [...new Set(currentMembers)];
    const qtyInDb = uniqueMembers.length + (org.invites?.length || 0);

    if (qty !== qtyInDb + 1) {
      throw new Error("Error with quantity of users");
    }

    let stripeCustomerId: string;

    if (org.stripeCustomerId) {
      stripeCustomerId = org.stripeCustomerId;
    } else {
      const { id } = await stripe.customers.create({
        metadata: {
          growthBookId: org.id,
        },
      });
      stripeCustomerId = id;
    }

    await updateOrganization(org.id, {
      stripeCustomerId: stripeCustomerId,
    });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer: stripeCustomerId,
      line_items: [
        {
          price: org?.priceId || STRIPE_PRICE,
          quantity: qty,
        },
      ],
      allow_promotion_codes: true,
      success_url: `${APP_ORIGIN}/settings/team`,
      cancel_url: `${APP_ORIGIN}/settings/team`,
    });
    res.status(200).json({
      status: 200,
      session,
    });
  } catch (e) {
    res.status(400).json({
      status: 400,
      message: e.message,
    });
  }
}

export async function getSubscriptionData(req: AuthRequest, res: Response) {
  try {
    req.checkPermissions("organizationSettings");

    const { org } = getOrgFromReq(req);

    const subscriptionId = org.subscription?.id;

    if (!subscriptionId) {
      return res.status(200).json({
        status: 200,
        subscription: null,
      });
    }

    const subscriptionData = await stripe.subscriptions.retrieve(
      subscriptionId,
      {
        expand: ["plan"],
      }
    );

    return res.status(200).json({
      status: 200,
      subscriptionData,
    });
  } catch (e) {
    res.status(400).json({
      status: 400,
      message: e.message,
    });
  }
}

export async function getPriceData(req: AuthRequest, res: Response) {
  try {
    req.checkPermissions("organizationSettings");

    const { org } = getOrgFromReq(req);

    const priceId = org.priceId || STRIPE_PRICE;

    if (!priceId) {
      return res.status(400).json({
        status: 400,
        message: "No price found.",
      });
    }

    if (!priceData) {
      priceData = await stripe.prices.retrieve(priceId, {
        expand: ["tiers"],
      });
    }

    return res.status(200).json({
      status: 200,
      priceData,
    });
  } catch (e) {
    res.status(400).json({
      status: 400,
      message: e.message,
    });
  }
}

export async function postCreateBillingSession(
  req: AuthRequest,
  res: Response
) {
  try {
    req.checkPermissions("organizationSettings");

    const { org } = getOrgFromReq(req);

    if (!org.stripeCustomerId) {
      throw new Error("Missing customer id");
    }

    const { url } = await stripe.billingPortal.sessions.create({
      customer: org.stripeCustomerId,
      return_url: `${APP_ORIGIN}/settings`,
    });

    res.status(200).json({
      status: 200,
      url,
    });
  } catch (e) {
    res.status(400).json({
      status: 400,
      message: e.message,
    });
  }
}

export async function postWebhook(req: Request, res: Response) {
  const payload: Buffer = req.body;
  const sig = req.headers["stripe-signature"];
  if (!sig) {
    return res.status(400).send("Missing signature");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(payload, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(payload, sig);
    console.error(err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const { subscription } = event.data
        .object as Stripe.Response<Stripe.Checkout.Session>;

      if (subscription) {
        updateSubscription(subscription);
      } else {
        console.error("Unable to find & updated existing organization"); //TODO: As this is a webhook, these errors should probably alert/bubble up somewhere
        res.status(400).json({
          status: 400,
          message: "Unable to find & updated existing organization",
        });
      }
      break;
    }

    case "invoice.paid":
    case "invoice.payment_failed": {
      const { subscription } = event.data
        .object as Stripe.Response<Stripe.Invoice>;
      if (subscription) {
        updateSubscription(subscription);
      }
      break;
    }

    case "customer.subscription.deleted":
    case "subscription_scheduled.canceled":
    case "customer.subscription.updated": {
      console.log("updated webhook was hit");
      // console.log(event.data.object);
      const subscription = event.data
        .object as Stripe.Response<Stripe.Subscription>;

      // Get the current subscription data instead of relying on a potentially outdated event
      const currentStripeSubscriptionData = await stripe.subscriptions.retrieve(
        subscription.id
      );

      // Get stripeCustomerId
      const stripeCustomerId =
        typeof currentStripeSubscriptionData.customer === "string"
          ? currentStripeSubscriptionData.customer
          : currentStripeSubscriptionData.customer.id;

      // Get the organization connected to stripeCustomerId
      const currentDbSubscription = await findOrganizationByStripeCustomerId(
        stripeCustomerId
      );

      // If Stripe's status, trialEnd, or subscriptionId's don't match our DB, update our DB.
      if (
        currentStripeSubscriptionData.status !==
          currentDbSubscription?.subscription?.status ||
        currentStripeSubscriptionData.trial_end !==
          currentDbSubscription?.subscription?.trialEnd ||
        currentStripeSubscriptionData.id !==
          currentDbSubscription.subscription.id
      ) {
        updateSubscription(currentStripeSubscriptionData);
      }

      // // This is a bit weird, but the organization.members array can have duplicates, so this just returns an array of unique users.
      // const users = await getUsersByIds(
      //   currentDbSubscription?.members?.map((m) => m.id) || []
      // );

      // const activeAndInvitedMembers =
      //   (currentDbSubscription?.invites?.length || 0) + (users.length || 0);

      // // If Stripe's qty doesn't match our DB, update Stripe's subscription.
      // if (
      //   currentStripeSubscriptionData.items.data[0].quantity !==
      //   activeAndInvitedMembers
      // ) {
      //   await stripe.subscriptions.update(subscription.id, {
      //     items: [
      //       {
      //         id: subscription.items.data[0].id,
      //         quantity: activeAndInvitedMembers,
      //       },
      //     ],
      //   });
      // }
      break;
    }
  }

  res.status(200).send("Ok");
}
