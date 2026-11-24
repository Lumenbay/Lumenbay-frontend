import { orderRoute } from "@/lib/orders/route";
import { getEscrowPaymentEvents, parseChainId } from "@/lib/orders/server";

export const POST = orderRoute((userId, body) =>
  getEscrowPaymentEvents(userId, parseChainId(body.chainEscrowId)),
);
